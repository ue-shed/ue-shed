//! Byte-compatible UESHT004 sections. Payload staging is bounded to one section.
use crate::{Result, require};
use std::cell::RefCell;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAX_SECTION: usize = 128 * 1024 * 1024;
pub const BLOCK_BYTES: usize = 256 * 1024;
#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub kind: u32,
    pub domain: String,
    pub strings: u32,
    pub codec: u32,
    pub offset: u64,
    pub stored: u32,
    pub raw: u32,
    pub count: u32,
    pub crc: u32,
}
/// Section codecs. Integer columns compress far better with each value's bytes grouped by
/// significance (`SHUFFLED`), and non-decreasing ones better still as differences (`DELTA`).
pub const CODEC_RAW: u32 = 0;
pub const CODEC_ZSTD: u32 = 1;
pub const CODEC_SHUFFLED: u32 = 2;
pub const CODEC_DELTA: u32 = 3;
/// Integer sections shorter than this are not worth a transform.
const SHUFFLE_MINIMUM: usize = 64;
/// Bytes of an integer column compared with and without its transform.
const SHUFFLE_SAMPLE: usize = 64 * 1024;

/// The bytes of little-endian u32 `values`, grouped by byte significance.
fn shuffle(raw: &[u8]) -> Vec<u8> {
    let n = raw.len() / 4;
    let mut out = vec![0; raw.len()];
    for (i, value) in raw.as_chunks::<4>().0.iter().enumerate() {
        for (byte, part) in value.iter().enumerate() {
            out[byte * n + i] = *part;
        }
    }
    out
}
fn unshuffle(shuffled: &[u8]) -> Vec<u8> {
    let n = shuffled.len() / 4;
    let mut out = vec![0; shuffled.len()];
    for (i, value) in out.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        for (byte, part) in value.iter_mut().enumerate() {
            *part = shuffled[byte * n + i];
        }
    }
    out
}
fn differences(raw: &[u8]) -> Vec<u8> {
    let mut previous = 0u32;
    raw.as_chunks::<4>()
        .0
        .iter()
        .flat_map(|bytes| {
            let value = u32::from_le_bytes(*bytes);
            let delta = value.wrapping_sub(previous);
            previous = value;
            delta.to_le_bytes()
        })
        .collect()
}
fn sums(deltas: &mut [u8]) {
    let mut previous = 0u32;
    for bytes in deltas.as_chunks_mut::<4>().0 {
        previous = previous.wrapping_add(u32::from_le_bytes(*bytes));
        *bytes = previous.to_le_bytes();
    }
}
/// The stored bytes and codec for a section's raw bytes. Integer columns use the transform that
/// compresses a sample of them best: some hold packed text bytes, which grouping would scatter.
pub(crate) fn encode_section(kind: u32, raw: &[u8], level: i32) -> Result<(Vec<u8>, u32)> {
    let _span = crate::scan_timings::Span::new("snapshot.encode");
    let transform = |codec: u32, raw: &[u8]| match codec {
        CODEC_DELTA => shuffle(&differences(raw)),
        CODEC_SHUFFLED => shuffle(raw),
        _ => raw.to_vec(),
    };
    let mut codec = CODEC_ZSTD;
    if matches!(kind, 2 | 3) && raw.len() >= SHUFFLE_MINIMUM {
        let ascending = raw
            .as_chunks::<4>()
            .0
            .windows(2)
            .all(|pair| u32::from_le_bytes(pair[0]) <= u32::from_le_bytes(pair[1]));
        let candidate = if ascending {
            CODEC_DELTA
        } else {
            CODEC_SHUFFLED
        };
        let sample = &raw[..raw.len().min(SHUFFLE_SAMPLE)];
        let candidate_compressed = measured_compress(&transform(candidate, sample), level)?;
        let raw_compressed = measured_compress(sample, level)?;
        if raw.len() <= SHUFFLE_SAMPLE {
            let (best, best_codec) = if candidate_compressed.len() < raw_compressed.len() {
                (candidate_compressed, candidate)
            } else {
                (raw_compressed, CODEC_ZSTD)
            };
            return Ok(if best.len() < raw.len() {
                (best, best_codec)
            } else {
                (raw.to_vec(), CODEC_RAW)
            });
        }
        if candidate_compressed.len() < raw_compressed.len() {
            codec = candidate;
        }
    }
    let encoded = measured_compress(&transform(codec, raw), level)?;
    Ok(if encoded.len() < raw.len() {
        (encoded, codec)
    } else {
        (raw.to_vec(), CODEC_RAW)
    })
}
// Each thread keeps its zstd contexts. A fresh context per section is a large heap block, and
// on Windows those share one heap lock, so parallel publication of thousands of small sections
// stalled on allocation instead of compressing.
thread_local! {
    static COMPRESSOR: RefCell<Option<(i32, zstd::bulk::Compressor<'static>)>> =
        const { RefCell::new(None) };
    static DECOMPRESSOR: RefCell<Option<zstd::bulk::Decompressor<'static>>> =
        const { RefCell::new(None) };
}
fn measured_compress(raw: &[u8], level: i32) -> std::io::Result<Vec<u8>> {
    let _span = crate::scan_timings::Span::new("snapshot.compress");
    COMPRESSOR.with_borrow_mut(|slot| match slot {
        Some((current, compressor)) if *current == level => compressor.compress(raw),
        _ => {
            let mut compressor = zstd::bulk::Compressor::new(level)?;
            let compressed = compressor.compress(raw);
            *slot = Some((level, compressor));
            compressed
        }
    })
}
fn decompress(stored: &[u8], raw: usize) -> std::io::Result<Vec<u8>> {
    DECOMPRESSOR.with_borrow_mut(|slot| match slot {
        Some(decompressor) => decompressor.decompress(stored, raw),
        None => {
            let mut decompressor = zstd::bulk::Decompressor::new()?;
            let decompressed = decompressor.decompress(stored, raw);
            *slot = Some(decompressor);
            decompressed
        }
    })
}
/// A section's raw bytes from its stored bytes.
pub(crate) fn decode_section(codec: u32, stored: Vec<u8>, raw: usize) -> Result<Vec<u8>> {
    Ok(match codec {
        CODEC_RAW => stored,
        CODEC_ZSTD => decompress(&stored, raw)?,
        CODEC_SHUFFLED | CODEC_DELTA => {
            let shuffled = decompress(&stored, raw)?;
            require(
                shuffled.len() == raw && raw.is_multiple_of(4),
                "section length",
            )?;
            let mut bytes = unshuffle(&shuffled);
            if codec == CODEC_DELTA {
                sums(&mut bytes);
            }
            bytes
        }
        _ => return Err("unknown section codec".into()),
    })
}
pub fn u32_bytes(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}
pub fn integers(bytes: &[u8]) -> Result<Vec<u32>> {
    require(bytes.len().is_multiple_of(4), "unaligned integer column")?;
    Ok(bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| u32::from_le_bytes(*b))
        .collect())
}
pub fn string_block(values: &[String]) -> Result<Vec<u8>> {
    string_block_bytes(
        &values
            .iter()
            .map(|s| s.as_bytes().to_vec())
            .collect::<Vec<_>>(),
    )
}
pub fn string_block_bytes(values: &[Vec<u8>]) -> Result<Vec<u8>> {
    require(!values.is_empty(), "empty string block")?;
    let mut out = Vec::new();
    out.extend_from_slice(&(values.len() as u32).to_le_bytes());
    let mut size = 0u32;
    for value in values {
        require(value.len() <= 1024 * 1024, "string exceeds 1 MiB")?;
        out.extend_from_slice(&size.to_le_bytes());
        size += value.len() as u32;
    }
    out.extend_from_slice(&size.to_le_bytes());
    for value in values {
        crate::wtf8::validate(value)?;
        out.extend_from_slice(value);
    }
    require(out.len() <= MAX_SECTION, "string block exceeds cap")?;
    Ok(out)
}
pub fn strings(bytes: &[u8]) -> Result<Vec<String>> {
    strings_bytes(bytes)?
        .into_iter()
        .map(|s| Ok(String::from_utf8(s)?))
        .collect()
}
pub fn strings_bytes(bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    visit_strings(bytes, |value| out.push(value.to_vec()))?;
    Ok(out)
}
/// Validates a string block as [`strings_bytes`] does and passes each value to `visit`.
fn visit_strings(bytes: &[u8], mut visit: impl FnMut(&[u8])) -> Result<()> {
    require(bytes.len() >= 8, "truncated string block")?;
    let n = u32::from_le_bytes(bytes[..4].try_into()?) as usize;
    let start = 8 + n * 4;
    require(n > 0 && start <= bytes.len(), "invalid string block count")?;
    let offsets = integers(&bytes[4..start])?;
    require(
        offsets[0] == 0 && offsets[n] as usize == bytes.len() - start,
        "invalid string endpoints",
    )?;
    for pair in offsets.windows(2) {
        require(
            pair[0] <= pair[1]
                && pair[1] as usize <= bytes.len() - start
                && pair[1] - pair[0] <= 1024 * 1024,
            "invalid string range",
        )?;
        let value = &bytes[start + pair[0] as usize..start + pair[1] as usize];
        crate::wtf8::validate(value)?;
        visit(value);
    }
    Ok(())
}
/// Stored section bytes a writer keeps in memory before it spills them to its payload file.
/// Most snapshots are a few MiB, so they never create, copy back or delete a payload file.
const MEMORY_PAYLOAD: usize = 32 * 1024 * 1024;
enum Payload {
    /// Each entry's stored bytes, by entry ID.
    Memory {
        sections: Vec<Vec<u8>>,
        bytes: usize,
    },
    /// A file created at the writer's path, which the writer deletes when dropped.
    File(File),
}
/// What [`Reader::load`] would check of a section's raw bytes beyond its codec and checksum,
/// recorded when the writer still holds them so publication need not read the file back.
#[derive(Default)]
struct SectionFacts {
    /// The largest string ID of a kind 3 section.
    largest_id: Option<u32>,
    /// Why a kind 4 section is not a valid string block.
    invalid_strings: Option<crate::Error>,
}
impl SectionFacts {
    fn of(kind: u32, raw: &[u8]) -> Self {
        match kind {
            3 => Self {
                largest_id: raw
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|b| u32::from_le_bytes(*b))
                    .max(),
                invalid_strings: None,
            },
            4 => Self {
                largest_id: None,
                invalid_strings: visit_strings(raw, |_| {}).err(),
            },
            _ => Self::default(),
        }
    }
}
pub struct Writer {
    path: PathBuf,
    payload: Payload,
    /// Stored bytes held in memory before the payload spills; [`MEMORY_PAYLOAD`] outside tests.
    spill_above: usize,
    facts: Vec<SectionFacts>,
    pub entries: Vec<Entry>,
}
fn check_section(name: &str, kind: u32, domain: &str, raw: &[u8]) -> Result<()> {
    require(
        raw.len() <= MAX_SECTION && name.len() <= 31 && domain.len() <= 23,
        "section cap/name",
    )?;
    require(
        kind <= 4 && (!matches!(kind, 2 | 3) || raw.len().is_multiple_of(4)),
        "section kind/width",
    )
}
impl Writer {
    /// A writer whose payload, once it outgrows memory, spills to `path`. Like creating that file
    /// exclusively, this fails when `path` already exists.
    pub fn new(path: &Path) -> Result<Self> {
        let _span = crate::scan_timings::Span::new("snapshot.create");
        match fs::symlink_metadata(path) {
            Ok(_) => return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists).into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Self {
            path: path.to_owned(),
            payload: Payload::Memory {
                sections: Vec::new(),
                bytes: 0,
            },
            spill_above: MEMORY_PAYLOAD,
            facts: Vec::new(),
            entries: Vec::new(),
        })
    }
    /// Moves the in-memory sections to the payload file at the writer's path.
    fn spill(&mut self) -> Result<()> {
        let Payload::Memory { sections, .. } = &mut self.payload else {
            return Ok(());
        };
        let _span = crate::scan_timings::Span::new("snapshot.spill");
        let sections = std::mem::take(sections);
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&self.path)?;
        let written = (|| {
            let mut out = std::io::BufWriter::with_capacity(256 * 1024, &file);
            for section in &sections {
                out.write_all(section)?;
            }
            out.flush()
        })();
        // The writer owns the file even when writing failed, so dropping it deletes the file.
        self.payload = Payload::File(file);
        Ok(written?)
    }
    pub fn add(
        &mut self,
        name: &str,
        kind: u32,
        domain: &str,
        raw: &[u8],
        level: i32,
    ) -> Result<usize> {
        check_section(name, kind, domain, raw)?;
        let encoded = encode_section(kind, raw, level)?;
        self.append(
            name,
            kind,
            domain,
            raw,
            encoded,
            SectionFacts::of(kind, raw),
        )
    }
    /// `add` for many sections at once: they are encoded in parallel and stored in order.
    pub fn add_all(&mut self, sections: &[(&str, u32, &str, &[u8], i32)]) -> Result<Vec<usize>> {
        use rayon::prelude::*;
        for (name, kind, domain, raw, _) in sections {
            check_section(name, *kind, domain, raw)?;
        }
        let encoded = sections
            .par_iter()
            .map(|(_, kind, _, raw, level)| encode_section(*kind, raw, *level))
            .collect::<Result<Vec<_>>>()?;
        sections
            .iter()
            .zip(encoded)
            .map(|((name, kind, domain, raw, _), encoded)| {
                self.append(
                    name,
                    *kind,
                    domain,
                    raw,
                    encoded,
                    SectionFacts::of(*kind, raw),
                )
            })
            .collect()
    }
    fn append(
        &mut self,
        name: &str,
        kind: u32,
        domain: &str,
        raw: &[u8],
        (bytes, codec): (Vec<u8>, u32),
        facts: SectionFacts,
    ) -> Result<usize> {
        let _span = crate::scan_timings::Span::new("snapshot.payload_write");
        if let Payload::Memory { bytes: held, .. } = &self.payload
            && *held + bytes.len() > self.spill_above
        {
            self.spill()?;
        }
        let stored = bytes.len() as u32;
        let offset = match &mut self.payload {
            Payload::Memory {
                sections,
                bytes: held,
            } => {
                let offset = *held as u64;
                *held += bytes.len();
                sections.push(bytes);
                offset
            }
            Payload::File(file) => {
                let offset = file.stream_position()?;
                file.write_all(&bytes)?;
                offset
            }
        };
        let id = self.entries.len();
        self.facts.push(facts);
        self.entries.push(Entry {
            name: name.into(),
            kind,
            domain: domain.into(),
            strings: 0,
            codec,
            offset,
            stored,
            raw: raw.len() as u32,
            count: (raw.len() / if matches!(kind, 2 | 3) { 4 } else { 1 }) as u32,
            crc: crc32fast::hash(raw),
        });
        Ok(id)
    }
    pub fn column(&mut self, name: &str, values: &[u32]) -> Result<usize> {
        self.add(name, 2, "", &u32_bytes(values), 1)
    }
    /// Uncompressed, session-local input with the same framing as the host's staged writer.
    pub fn add_staged(
        &mut self,
        name: &str,
        kind: u32,
        domain: &str,
        raw: &[u8],
        strings: u32,
    ) -> Result<usize> {
        check_section(name, kind, domain, raw)?;
        // Staged files are never verified, so their sections need no facts.
        let id = self.append(
            name,
            kind,
            domain,
            raw,
            (raw.to_vec(), CODEC_RAW),
            SectionFacts::default(),
        )?;
        self.entries[id].strings = strings;
        Ok(id)
    }
    pub fn finish(self, output: &Path, order: &[usize]) -> Result<u64> {
        self.finish_file(output, order, true)
    }
    /// Staged files are consumed in this session and discarded, without durable publication.
    pub fn finish_staged(self, output: &Path, order: &[usize]) -> Result<u64> {
        self.finish_file(output, order, false)
    }
    fn finish_file(mut self, output: &Path, order: &[usize], durable: bool) -> Result<u64> {
        let _span = crate::scan_timings::Span::new("snapshot.finish");
        require(
            !order.is_empty() && order.len() <= 1_048_576,
            "directory count",
        )?;
        let mut header = vec![0u8; 48 + order.len() * 96];
        header[..8].copy_from_slice(b"UESHT004");
        put(&mut header, 8, 4);
        put(&mut header, 12, order.len() as u32);
        let dirlen = header.len();
        put(&mut header, 24, dirlen as u32);
        let mut offset = header.len() as u64;
        for (i, &id) in order.iter().enumerate() {
            let e = &self.entries[id];
            let p = 48 + i * 96;
            header[p..p + e.name.len()].copy_from_slice(e.name.as_bytes());
            put(&mut header, p + 32, e.kind);
            put(&mut header, p + 36, e.codec);
            header[p + 40..p + 48].copy_from_slice(&offset.to_le_bytes());
            put(&mut header, p + 48, e.stored);
            put(&mut header, p + 52, e.raw);
            put(&mut header, p + 56, e.count);
            put(&mut header, p + 60, e.crc);
            header[p + 64..p + 64 + e.domain.len()].copy_from_slice(e.domain.as_bytes());
            put(&mut header, p + 88, e.strings);
            offset += (u64::from(e.stored) + 3) & !3;
        }
        require(offset <= 16 * 1024u64.pow(3), "file exceeds 16 GiB")?;
        header[16..24].copy_from_slice(&offset.to_le_bytes());
        let crc = crc32fast::hash(&header[48..]);
        put(&mut header, 28, crc);
        let crc = crc32fast::hash(&header[..32]);
        put(&mut header, 32, crc);
        if durable {
            self.check(&header, offset, order)?;
        }
        let write_span = crate::scan_timings::Span::new("snapshot.final_write");
        // Buffered, so thousands of small sections and their padding cost few write calls.
        let mut out = std::io::BufWriter::with_capacity(
            256 * 1024,
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(output)?,
        );
        out.write_all(&header)?;
        for &id in order {
            let e = &self.entries[id];
            match &mut self.payload {
                Payload::Memory { sections, .. } => out.write_all(&sections[id])?,
                Payload::File(file) => {
                    file.seek(SeekFrom::Start(e.offset))?;
                    std::io::copy(&mut (&mut *file).take(u64::from(e.stored)), &mut out)?;
                }
            }
            out.write_all(&[0; 3][..(4 - e.stored as usize % 4) % 4])?;
        }
        let out = out
            .into_inner()
            .map_err(std::io::IntoInnerError::into_error)?;
        drop(write_span);
        if durable {
            let _span = crate::scan_timings::Span::new("snapshot.fsync");
            out.sync_all()?;
        }
        drop(out);
        WRITTEN_BYTES.fetch_add(offset, std::sync::atomic::Ordering::Relaxed);
        // Release builds trust the codec round trip the tests prove here on every durable write.
        if durable && cfg!(debug_assertions) {
            Reader::open(output)?.verify()?;
        }
        Ok(offset)
    }
    /// What reading a durable file back would reject, checked before it is written: its header
    /// and directory as [`Reader::open`] validates them, and each section's raw bytes as
    /// [`Reader::load`] does. Stored bytes are not decoded again; their codecs are deterministic.
    fn check(&mut self, header: &[u8], length: u64, order: &[usize]) -> Result<()> {
        let _span = crate::scan_timings::Span::new("snapshot.check");
        header_fields(&header[..48])?;
        let entries = directory(&header[..48], &header[48..], length)?;
        for (e, &id) in entries.iter().zip(order) {
            let facts = &mut self.facts[id];
            if e.kind == 3 {
                require(
                    facts.largest_id.is_none_or(|largest| largest < e.strings),
                    "string ID bounds",
                )?;
            }
            if e.kind == 4
                && let Some(error) = facts.invalid_strings.take()
            {
                return Err(crate::Error::with_source(
                    crate::ErrorCode::InvalidCache,
                    format!("Invalid snapshot string section {}.", e.name),
                    error,
                ));
            }
        }
        Ok(())
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        if matches!(self.payload, Payload::File(_)) {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn put(b: &mut [u8], p: usize, n: u32) {
    b[p..p + 4].copy_from_slice(&n.to_le_bytes());
}
#[expect(
    clippy::unwrap_used,
    reason = "only fixed-size 48-byte headers and 96-byte directory entries reach get; every constant offset fits"
)]
fn get(b: &[u8], p: usize) -> u32 {
    u32::from_le_bytes(b[p..p + 4].try_into().unwrap())
}
static OPENS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LOADS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static STORED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RAW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static VERIFIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Sections [`Reader::verify`] decompresses at once: enough to overlap I/O and checksums while
/// keeping peak memory near four sections instead of one per pool thread.
const VERIFY_WORKERS: usize = 4;
static INDEX_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static WRITTEN_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IoMetrics {
    #[cfg_attr(test, ts(type = "number"))]
    pub opens: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub section_loads: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub stored_bytes: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub raw_bytes: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub full_verifies: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub index_bytes: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub written_bytes: u64,
}
pub fn io_metrics() -> IoMetrics {
    use std::sync::atomic::Ordering::Relaxed;
    IoMetrics {
        opens: OPENS.load(Relaxed),
        section_loads: LOADS.load(Relaxed),
        stored_bytes: STORED.load(Relaxed),
        raw_bytes: RAW.load(Relaxed),
        full_verifies: VERIFIES.load(Relaxed),
        index_bytes: INDEX_BYTES.load(Relaxed),
        written_bytes: WRITTEN_BYTES.load(Relaxed),
    }
}

pub struct Reader {
    file: Option<File>,
    /// The file's length, which `open` checked against its header; 0 for an in-memory layer.
    file_len: u64,
    memory: Option<std::sync::Arc<crate::localization::columns::LocalLayer>>,
    pub entries: Vec<Entry>,
}

/// Fills `buffer` from `offset` without the file's shared position, so readers on several
/// threads can load sections of one file at once.
fn read_exact_at(file: &File, mut buffer: &mut [u8], mut offset: u64) -> Result<()> {
    while !buffer.is_empty() {
        #[cfg(windows)]
        let read = std::os::windows::fs::FileExt::seek_read(file, buffer, offset)?;
        #[cfg(unix)]
        let read = std::os::unix::fs::FileExt::read_at(file, buffer, offset)?;
        require(read > 0, "truncated section")?;
        buffer = &mut buffer[read..];
        offset += read as u64;
    }
    Ok(())
}
impl Reader {
    pub(crate) fn memory(layer: std::sync::Arc<crate::localization::columns::LocalLayer>) -> Self {
        Self {
            file: None,
            file_len: 0,
            entries: layer.columns.iter().map(|c| c.entry.clone()).collect(),
            memory: Some(layer),
        }
    }
    pub fn open(path: &Path) -> Result<Self> {
        let _span = crate::scan_timings::Span::new("snapshot.open");
        OPENS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut file = File::open(path)?;
        let mut h = [0; 48];
        file.read_exact(&mut h)?;
        let (n, length) = header_fields(&h)?;
        require(length == file.metadata()?.len(), "file length")?;
        let mut b = vec![0; n * 96];
        file.read_exact(&mut b)?;
        INDEX_BYTES.fetch_add((48 + b.len()) as u64, std::sync::atomic::Ordering::Relaxed);
        let entries = directory(&h, &b, length)?;
        Ok(Self {
            file: Some(file),
            file_len: length,
            entries,
            memory: None,
        })
    }
    /// The file's length in bytes, as `open` validated it; 0 for an in-memory layer.
    pub fn file_len(&self) -> u64 {
        self.file_len
    }
    pub fn load(&self, id: usize) -> Result<Vec<u8>> {
        if let Some(memory) = &self.memory {
            return Ok(memory.columns[id].bytes.as_ref().clone());
        }
        let file = self.file.as_ref().ok_or("snapshot file absent")?;
        let _span = crate::scan_timings::Span::new("snapshot.load");
        let e = &self.entries[id];
        LOADS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        STORED.fetch_add(e.stored as u64, std::sync::atomic::Ordering::Relaxed);
        RAW.fetch_add(e.raw as u64, std::sync::atomic::Ordering::Relaxed);
        let stored = e.stored as usize;
        let padded = (stored + 3) & !3;
        let mut b = vec![0; padded];
        {
            let _span = crate::scan_timings::Span::new("snapshot.read");
            read_exact_at(file, &mut b, e.offset)?;
        }
        require(b[stored..].iter().all(|&x| x == 0), "padding")?;
        b.truncate(stored);
        let raw = decode_section(e.codec, b, e.raw as usize)?;
        require(
            raw.len() == e.raw as usize && crc32fast::hash(&raw) == e.crc,
            "section CRC/length",
        )?;
        if e.kind == 4 {
            strings_bytes(&raw).map_err(|error| {
                crate::Error::with_source(
                    crate::ErrorCode::InvalidCache,
                    format!("Invalid snapshot string section {}.", e.name),
                    error,
                )
            })?;
        }
        if e.kind == 3 {
            require(
                integers(&raw)?.iter().all(|&x| x < e.strings),
                "string ID bounds",
            )?;
        }
        Ok(raw)
    }
    pub fn verify(&mut self) -> Result<()> {
        let _span = crate::scan_timings::Span::new("snapshot.verify");
        VERIFIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.entries.len() <= 1 {
            for id in 0..self.entries.len() {
                self.load(id)?;
            }
            return Ok(());
        }
        // Sections load at explicit offsets, so they verify concurrently. Each load holds its
        // decompressed section until checked, so at most `VERIFY_WORKERS` run at once to bound
        // peak memory; workers take the next section from a shared cursor to stay balanced.
        use rayon::prelude::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let reader = &*self;
        let count = reader.entries.len();
        let next = AtomicUsize::new(0);
        (0..VERIFY_WORKERS.min(count))
            .into_par_iter()
            .try_for_each(|_| {
                loop {
                    let id = next.fetch_add(1, Ordering::Relaxed);
                    if id >= count {
                        return Ok(());
                    }
                    if let Err(error) = reader.load(id) {
                        // Stop the other workers at their next section.
                        next.store(count, Ordering::Relaxed);
                        return Err(error);
                    }
                }
            })
    }
}
/// The section count and file length a 48-byte header declares, once its fields are valid.
fn header_fields(h: &[u8]) -> Result<(usize, u64)> {
    require(
        &h[..8] == b"UESHT004"
            && get(h, 8) == 4
            && get(h, 32) == crc32fast::hash(&h[..32])
            && h[36..].iter().all(|&x| x == 0),
        "invalid header",
    )?;
    let n = get(h, 12) as usize;
    require(
        n > 0 && n <= 1_048_576 && get(h, 24) as usize == 48 + n * 96,
        "invalid directory count",
    )?;
    let length = u64::from_le_bytes(h[16..24].try_into()?);
    require(length <= 16 * 1024u64.pow(3), "file length")?;
    Ok((n, length))
}
/// The entries of directory `b` under header `h` in a file of `length` bytes.
fn directory(h: &[u8], b: &[u8], length: u64) -> Result<Vec<Entry>> {
    let n = b.len() / 96;
    require(get(h, 28) == crc32fast::hash(b), "directory CRC")?;
    let mut entries = Vec::with_capacity(n);
    let mut seen = std::collections::HashSet::new();
    let mut domain_counts = std::collections::HashMap::new();
    let mut offset = 48 + n as u64 * 96;
    for d in b.as_chunks::<96>().0 {
        let domain = name(&d[64..88])?;
        let name = name(&d[..32])?;
        let e = Entry {
            name,
            domain,
            kind: get(d, 32),
            codec: get(d, 36),
            offset: u64::from_le_bytes(d[40..48].try_into()?),
            stored: get(d, 48),
            raw: get(d, 52),
            count: get(d, 56),
            crc: get(d, 60),
            strings: get(d, 88),
        };
        require(
            e.offset == offset
                && e.raw as usize <= MAX_SECTION
                && e.stored as usize <= MAX_SECTION
                && e.kind <= 4
                && (e.codec <= CODEC_ZSTD
                    || (matches!(e.codec, CODEC_SHUFFLED | CODEC_DELTA)
                        && matches!(e.kind, 2 | 3)))
                && get(d, 92) == 0,
            "invalid section",
        )?;
        require(
            valid_name(&e.name, 31) && seen.insert(e.name.clone()),
            "invalid/duplicate section name",
        )?;
        if matches!(e.kind, 3 | 4) {
            require(
                valid_name(&e.domain, 23) && e.strings > 0 && e.strings <= 64_000_000,
                "invalid string domain/count",
            )?;
            require(
                domain_counts
                    .insert(e.domain.clone(), e.strings)
                    .is_none_or(|old| old == e.strings),
                "inconsistent domain count",
            )?;
        } else {
            require(e.domain.is_empty() && e.strings == 0, "unexpected domain")?;
        }
        require(
            if e.codec == 0 {
                e.raw == e.stored
            } else {
                e.stored < e.raw
            },
            "compression lengths",
        )?;
        require(
            u64::from(e.count) * if matches!(e.kind, 2 | 3) { 4 } else { 1 } == u64::from(e.raw),
            "column width",
        )?;
        offset += (u64::from(e.stored) + 3) & !3;
        require(offset <= length, "section bounds")?;
        entries.push(e);
    }
    require(offset == length, "trailing bytes")?;
    let domains: std::collections::BTreeSet<_> = entries
        .iter()
        .filter(|e| e.kind == 3 || e.kind == 4)
        .map(|e| e.domain.as_str())
        .collect();
    for domain in domains {
        let blocks: Vec<_> = entries
            .iter()
            .filter(|e| e.kind == 4 && e.domain == domain)
            .collect();
        let starts = entries
            .iter()
            .find(|e| e.name == format!("{domain}.starts"))
            .ok_or("missing block index")?;
        require(
            !blocks.is_empty() && starts.kind == 2 && starts.count as usize == blocks.len(),
            "invalid block index",
        )?;
        for (i, block) in blocks.iter().enumerate() {
            require(block.name == format!("{domain}.b{i}"), "invalid block name")?;
            if i > 0 {
                let previous = blocks[i - 1];
                require(
                    block.offset == previous.offset + ((u64::from(previous.stored) + 3) & !3),
                    "noncontiguous domain",
                )?;
            }
        }
    }
    Ok(entries)
}
fn name(b: &[u8]) -> Result<String> {
    let n = b.iter().position(|&x| x == 0).ok_or("name padding")?;
    require(b[n..].iter().all(|&x| x == 0), "name padding")?;
    Ok(std::str::from_utf8(&b[..n])?.to_owned())
}
fn valid_name(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_blocks_and_bounds() {
        let values = vec!["".into(), "é𝄞\u{2028}".into()];
        assert_eq!(strings(&string_block(&values).unwrap()).unwrap(), values);
        assert!(strings(&[0; 8]).is_err());
        assert!(integers(&[0; 3]).is_err());
    }
    #[test]
    fn persisted_crc_header_bounds_and_exclusive_output() {
        let root = crate::test_directory("snapshot-unit");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("columns.snapshot");
        let payload = root.join("payload");
        let mut w = Writer::new(&payload).unwrap();
        let id = w.column("values", &(0..1000).collect::<Vec<_>>()).unwrap();
        w.finish(&path, &[id]).unwrap();
        let r = Reader::open(&path).unwrap();
        assert_eq!(integers(&r.load(0).unwrap()).unwrap().len(), 1000);
        drop(r);
        assert!(Writer::new(&path).is_err());
        let original = fs::read(&path).unwrap();
        let mut changed = original.clone();
        changed[32] ^= 1;
        fs::write(&path, &changed).unwrap();
        assert!(Reader::open(&path).is_err());
        let mut changed = original.clone();
        changed[144] ^= 1;
        fs::write(&path, &changed).unwrap();
        assert!(Reader::open(&path).unwrap().verify().is_err());
        let mut changed = original.clone();
        changed.push(0);
        fs::write(&path, &changed).unwrap();
        assert!(Reader::open(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    fn sample_sections(w: &mut Writer) -> Vec<usize> {
        let strings = ["", "alpha", "é𝄞"].map(String::from);
        let block = w
            .add(
                "source.b0",
                4,
                "source",
                &string_block(&strings).unwrap(),
                3,
            )
            .unwrap();
        w.entries[block].strings = 3;
        let starts = w.column("source.starts", &[0]).unwrap();
        let ids = w
            .add("entry.source", 3, "source", &u32_bytes(&[2, 0, 1, 2]), 1)
            .unwrap();
        w.entries[ids].strings = 3;
        let values = w.column("values", &(0..5000).collect::<Vec<_>>()).unwrap();
        let text = w.add("meta", 0, "", b"{\"odd\":1}", 0).unwrap();
        vec![text, block, starts, ids, values]
    }
    #[test]
    fn spilled_and_in_memory_payloads_write_identical_files() {
        let root = crate::test_directory("snapshot-spill");
        fs::create_dir_all(&root).unwrap();
        let mut files = Vec::new();
        for spill_above in [MEMORY_PAYLOAD, 0, 12] {
            let payload = root.join(format!("{spill_above}.payload"));
            let mut w = Writer::new(&payload).unwrap();
            w.spill_above = spill_above;
            let order = sample_sections(&mut w);
            assert_eq!(payload.exists(), spill_above != MEMORY_PAYLOAD);
            let file = root.join(format!("{spill_above}.snapshot"));
            w.finish(&file, &order).unwrap();
            assert!(!payload.exists());
            files.push(fs::read(file).unwrap());
        }
        assert_eq!(files[0], files[1]);
        assert_eq!(files[0], files[2]);
        let mut w = Writer::new(&root.join("staged.payload")).unwrap();
        w.spill_above = 0;
        let id = w
            .add_staged("values", 2, "", &u32_bytes(&[1, 2]), 0)
            .unwrap();
        w.finish_staged(&root.join("staged.snapshot"), &[id])
            .unwrap();
        assert!(!root.join("staged.payload").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn durable_writes_reject_what_reading_back_would_without_leaving_a_file() {
        let root = crate::test_directory("snapshot-check");
        fs::create_dir_all(&root).unwrap();
        let output = root.join("rejected.snapshot");
        let mut w = Writer::new(&root.join("ids.payload")).unwrap();
        let mut order = sample_sections(&mut w);
        let ids = order[3];
        w.entries[ids].strings = 2;
        w.entries[order[1]].strings = 2;
        let error = w.finish(&output, &order).unwrap_err();
        assert_eq!(error.to_string(), "string ID bounds");
        assert!(!output.exists());

        let mut w = Writer::new(&root.join("block.payload")).unwrap();
        let block = w.add("source.b0", 4, "source", &[0; 12], 3).unwrap();
        w.entries[block].strings = 1;
        let starts = w.column("source.starts", &[0]).unwrap();
        let error = w.finish(&output, &[block, starts]).unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("Invalid snapshot string section source.b0.: "),
            "{error}"
        );
        assert!(!output.exists());

        let mut w = Writer::new(&root.join("names.payload")).unwrap();
        order = vec![w.column("values", &[1]).unwrap()];
        order.push(order[0]);
        let error = w.finish(&output, &order).unwrap_err();
        assert_eq!(error.to_string(), "invalid/duplicate section name");
        assert!(!output.exists());

        let mut w = Writer::new(&root.join("staged.payload")).unwrap();
        let id = w
            .add_staged("ids", 3, "source", &u32_bytes(&[9]), 1)
            .unwrap();
        w.finish_staged(&output, &[id]).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn integer_columns_round_trip_through_their_codecs() {
        let root = crate::test_directory("snapshot-codecs");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("columns.snapshot");
        let mut seed = 7u32;
        let mut random = || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            seed >> 7
        };
        let wrapping = vec![u32::MAX - 2, u32::MAX, 0, 5, 5, 4, u32::MAX];
        let scattered = (0..5000).map(|_| random()).collect::<Vec<u32>>();
        let mut total = 0u32;
        let ascending = scattered
            .iter()
            .map(|v| {
                total += v % 7;
                total
            })
            .collect::<Vec<u32>>();
        let small = scattered.iter().map(|v| v % 9).collect::<Vec<u32>>();
        let repeated = vec![u32::MAX; 4000];
        let short = vec![3, 2, 1];
        let columns = [&ascending, &wrapping, &scattered, &repeated, &short, &small];
        let mut w = Writer::new(&root.join("payload")).unwrap();
        let ids = columns
            .iter()
            .enumerate()
            .map(|(i, values)| w.column(&format!("c{i}"), values).unwrap())
            .collect::<Vec<_>>();
        w.finish(&path, &ids).unwrap();
        let mut r = Reader::open(&path).unwrap();
        let codecs = r.entries.iter().map(|e| e.codec).collect::<Vec<_>>();
        assert_eq!(&codecs[..3], [CODEC_DELTA, CODEC_RAW, CODEC_SHUFFLED]);
        assert_eq!(&codecs[3..], [CODEC_ZSTD, CODEC_RAW, CODEC_SHUFFLED]);
        for (i, values) in columns.iter().enumerate() {
            assert_eq!(&integers(&r.load(i).unwrap()).unwrap(), *values);
        }
        r.verify().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
