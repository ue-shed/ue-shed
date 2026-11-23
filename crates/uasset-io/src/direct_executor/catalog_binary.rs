//! Immutable binary Catalog. `MemoryCatalog` is its differential test oracle.
//! Seven checksummed sections: inventory, shared strings, posting directory, postings, records,
//! a sparse row index, and tombstones. All integers are little-endian. Incompatible derived caches
//! are rebuilt, never migrated.
//!
//! A committed generation is a base snapshot, optionally with one delta snapshot. A delta is a
//! complete snapshot of its own (its rows, strings, postings and records) holding the entries a
//! refresh added or replaced since the base, and tombstones naming the base rows it hides. Readers
//! merge the base's live rows with the delta's in path order. A small refresh rewrites only the
//! delta; one that would make the delta too large writes a new base instead (compaction).
use super::catalog::*;
use super::catalog_dependencies::{DependencyGraph, dependency_page};
use super::change_journal::ChangeJournal;
use super::inventory_digest::{BundleWalker, InventorySum, bundle_stem, stem_sum};
use super::project_index::{CatalogSnapshot, CoordinatorError};
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::cell::{OnceCell, RefCell};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uasset_inspection::package_header::PackageHeaderData;

mod committed;
use committed::{Committed, MergedGraph, Segment};

const CATALOG_DIRECTORY: &str = "catalogs-v10";
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_SCHEMA_VERSION: u32 = 2;
const SNAPSHOT_SCHEMA_VERSION: u32 = 6;
const MAX_QUARANTINE_ATTEMPTS: u32 = 8;
const MAGIC: &[u8; 8] = b"UESHC008";
/// Posting kinds: exact export classes, serialized names, and dependency targets.
const POSTING_KINDS: usize = 3;
const CLASS_POSTINGS: u8 = 0;
const NAME_POSTINGS: u8 = 1;
const DEPENDENCY_POSTINGS: u8 = 2;
const SECTIONS: usize = 7;
const INVENTORY: usize = 0;
const STRINGS: usize = 1;
const DIRECTORY: usize = 2;
const LISTS: usize = 3;
const RECORDS: usize = 4;
/// Every `ROW_INDEX_INTERVAL`th row's path, inventory offset and chunk checksum, and the map rows,
/// so readers and writers find the rows at a path or id without decoding the whole inventory.
const ROW_INDEX: usize = 5;
/// A delta's hidden base rows; a base holds none.
const TOMBSTONES: usize = 6;
const ROW_INDEX_INTERVAL: usize = 128;
/// Decoded inventory chunks a reader keeps between queries. Paging reads new chunks each page, so
/// past this many (about 260,000 rows) a query's end releases them: a pass over a whole inventory
/// never holds it all decoded, and a page asked again stays decoded.
const RETAINED_CHUNKS: usize = 2048;
/// A posting directory entry: kind, string id, list offset, list length and list checksum.
const POSTING_ENTRY_BYTES: usize = 25;
/// The most adjacent inventory blocks one thread decodes as one run when chunks are loaded
/// together.
const LOAD_RUN_BLOCKS: usize = 8;
/// Most distinct record blocks a query page decodes at once: 4 MiB of decoded records.
const RECORD_BATCH_BLOCKS: usize = 64;
/// Fewest record blocks one decoding thread takes, so a thread does more than it costs to start.
const RECORD_BLOCKS_PER_THREAD: usize = 8;
/// A refresh writes a delta while the delta's entries and the base rows it hides stay at most
/// this many, and at most `DELTA_LIMIT_PERMILLE` thousandths of the base; past either it compacts
/// into a new base.
const DELTA_LIMIT_ENTRIES: usize = 16_384;
const DELTA_LIMIT_PERMILLE: usize = 50;
/// Strings a delta may carry before it compacts: a delta keeps the strings of entries it no
/// longer holds until then.
const DELTA_LIMIT_STRINGS: u64 = 262_144;
/// The magic; each section's stored length, decoded length, decoded checksum and stored
/// checksum; the package, map and shared-string counts; then a checksum of all of it.
const HEADER_BYTES: u64 = 8 + SECTIONS as u64 * 32 + 3 * 8 + 8;
const MAX_SECTION_BYTES: u64 = 512 * 1024 * 1024;
/// Every section is stored as independently compressed blocks behind an index of block end
/// offsets: queries decode only the blocks they touch, and whole sections encode and decode
/// their blocks in parallel.
const BLOCK_BYTES: u64 = 64 * 1024;
const COMPRESSION_LEVEL: i32 = 3;
/// Raw bytes a section writer collects before compressing them, in parallel, and dropping them.
const COMPRESSION_BATCH_BYTES: usize = 256 * BLOCK_BYTES as usize;
const MAX_CODEC_THREADS: usize = 16;
/// Stored bytes one integrity pass reads at a time.
const VERIFY_CHUNK_BYTES: usize = 1024 * 1024;
/// Stored bytes one thread of an integrity pass checks as one piece.
const VERIFY_PIECE_BYTES: u64 = 8 * 1024 * 1024;
/// Blocks a pass over a whole section decodes at once.
const DECODE_BATCH_BLOCKS: usize = 256;
/// Blocks a sequential section reader decodes at once.
const SECTION_READ_BLOCKS: usize = 64;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CatalogWriteCounts {
    pub(crate) staged_evidence_rows: u64,
    pub(crate) committed_evidence_rows: u64,
    pub(crate) removed_evidence_rows: u64,
    pub(crate) evidence_write_duration: Duration,
    /// Bytes of the snapshot file the commit wrote (none for a reused generation).
    pub(crate) written_bytes: u64,
    /// Whether the commit wrote a delta rather than a base.
    pub(crate) delta: bool,
}

/// When a refresh writes a delta instead of a new base.
#[derive(Clone, Copy, Debug)]
struct DeltaLimits {
    entries: usize,
    permille: usize,
    strings: u64,
}

impl Default for DeltaLimits {
    fn default() -> Self {
        Self {
            entries: DELTA_LIMIT_ENTRIES,
            permille: DELTA_LIMIT_PERMILLE,
            strings: DELTA_LIMIT_STRINGS,
        }
    }
}

// Historical manifest scaffolding for the 2026-09-05 adapter experiments.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ManifestDiagnostic {
    code: String,
    message: String,
    retry_safe: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ManifestMount {
    name: String,
    path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ManifestSummary {
    changed_packages: u64,
    completeness: String,
    diagnostics: Vec<ManifestDiagnostic>,
    /// Diagnostics past the kept ones; absent from manifests written before it was counted.
    #[serde(default)]
    omitted_diagnostics: u64,
    generation: u64,
    map_count: u64,
    package_count: u64,
    removed_packages: u64,
    mounts: Vec<ManifestMount>,
    /// The index profile every committed package's evidence was read with.
    index_profile: u32,
    /// The sum of the generation's inventory leaves (see `inventory_digest`), as hex.
    inventory_sum: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Manifest {
    manifest_schema_version: u32,
    snapshot_schema_version: u32,
    project_id: String,
    /// The base snapshot.
    physical_snapshot: String,
    /// The delta over the base, when there is one.
    delta_snapshot: Option<String>,
    /// The base and delta the previous generation named, kept for readers that opened it.
    previous_snapshot: Option<String>,
    previous_delta: Option<String>,
    summary: ManifestSummary,
    /// The change journal position the generation's content was listed at, when its volumes
    /// keep one; absent from manifests written before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    change_journal: Option<ChangeJournal>,
}

impl Manifest {
    /// Every snapshot file the manifest names.
    fn files(&self) -> [Option<&str>; 4] {
        [
            Some(self.physical_snapshot.as_str()),
            self.delta_snapshot.as_deref(),
            self.previous_snapshot.as_deref(),
            self.previous_delta.as_deref(),
        ]
    }
}

impl ManifestSummary {
    fn from_refresh(summary: &RefreshSummary, inventory: InventorySum) -> Self {
        Self {
            index_profile: INDEX_PROFILE_VERSION,
            inventory_sum: inventory.to_hex(),
            changed_packages: summary.changed_packages,
            completeness: match summary.completeness {
                Completeness::Complete => "complete".to_owned(),
                Completeness::Partial => "partial".to_owned(),
            },
            diagnostics: summary
                .diagnostics
                .iter()
                .map(|diagnostic| ManifestDiagnostic {
                    code: diagnostic.code.clone(),
                    message: diagnostic.message.clone(),
                    retry_safe: diagnostic.retry_safe,
                })
                .collect(),
            omitted_diagnostics: summary.omitted_diagnostics,
            generation: summary.generation.get(),
            map_count: summary.map_count,
            package_count: summary.package_count,
            removed_packages: summary.removed_packages,
            mounts: summary
                .mounts
                .iter()
                .map(|mount| ManifestMount {
                    name: mount.name.clone(),
                    path: mount.path.clone(),
                })
                .collect(),
        }
    }

    fn mount_points(&self) -> Vec<MountPoint> {
        self.mounts
            .iter()
            .map(|mount| MountPoint {
                name: mount.name.clone(),
                path: mount.path.clone(),
            })
            .collect()
    }

    fn to_refresh(&self, project_id: &ProjectId) -> RefreshSummary {
        RefreshSummary {
            project_id: project_id.clone(),
            generation: Generation::new(self.generation),
            package_count: self.package_count,
            map_count: self.map_count,
            changed_packages: self.changed_packages,
            removed_packages: self.removed_packages,
            completeness: if self.completeness == "complete" {
                Completeness::Complete
            } else {
                Completeness::Partial
            },
            diagnostics: self
                .diagnostics
                .iter()
                .map(|diagnostic| CatalogDiagnostic {
                    code: diagnostic.code.clone(),
                    message: diagnostic.message.clone(),
                    retry_safe: diagnostic.retry_safe,
                })
                .collect(),
            omitted_diagnostics: self.omitted_diagnostics,
            mounts: self.mount_points(),
            inventory_digest: (self.completeness == "complete")
                .then(|| self.inventory().map(|sum| sum.digest(self.package_count)))
                .flatten(),
        }
    }

    fn inventory(&self) -> Option<InventorySum> {
        InventorySum::from_hex(&self.inventory_sum)
    }
}

/// Lexicon order: ASCII case folded first, so every spelling of a name is one adjacent range, then
/// exact bytes, so the order is total.
fn lexicon_order(left: &str, right: &str) -> std::cmp::Ordering {
    folded_order(left, right).then_with(|| left.cmp(right))
}

/// FNV-1a over the ASCII-folded bytes.
fn folded_hash(value: &str) -> u64 {
    value.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte.to_ascii_lowercase())).wrapping_mul(0x0100_0000_01b3)
    })
}

fn folded_order(left: &str, right: &str) -> std::cmp::Ordering {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    // Bytes equal as written are equal folded, so folding starts where they first differ:
    // neighbouring strings mostly share a long prefix (a package path), compared a word at a time.
    let common = common_prefix_len(left, right);
    left[common..]
        .iter()
        .map(u8::to_ascii_lowercase)
        .cmp(right[common..].iter().map(u8::to_ascii_lowercase))
}

/// How many leading bytes `left` and `right` share.
fn common_prefix_len(left: &[u8], right: &[u8]) -> usize {
    let (left_words, _) = left.as_chunks::<8>();
    let (right_words, _) = right.as_chunks::<8>();
    let words = left_words
        .iter()
        .zip(right_words)
        .take_while(|(left, right)| left == right)
        .count();
    let start = words * 8;
    start
        + left[start..]
            .iter()
            .zip(&right[start..])
            .take_while(|(left, right)| left == right)
            .count()
}

fn no_staging() -> CatalogError {
    CatalogError::InvalidRequest {
        message: "no binary Catalog refresh is active".into(),
    }
}

fn corrupt(message: impl Into<String>) -> CatalogError {
    CatalogError::Corrupt {
        message: message.into(),
    }
}

fn checksum(bytes: &[u8]) -> u64 {
    u64::from(crc32fast::hash(bytes))
}

fn put32(out: &mut Vec<u8>, value: usize) -> Result<(), CatalogError> {
    let value = u32::try_from(value).map_err(|_| corrupt("Catalog count exceeds u32"))?;
    out.extend_from_slice(&value.to_le_bytes());
    Ok(())
}
fn put64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn put_string(out: &mut Vec<u8>, value: &str) -> Result<(), CatalogError> {
    put32(out, value.len())?;
    out.extend_from_slice(value.as_bytes());
    Ok(())
}
fn put_header_data(out: &mut Vec<u8>, data: &PackageHeaderData) {
    out.extend_from_slice(&data.package_flags.to_le_bytes());
    out.extend_from_slice(&data.gatherable_text_data_count.to_le_bytes());
    out.extend_from_slice(&data.gatherable_text_data_offset.to_le_bytes());
    out.push(u8::from(data.has_text_property));
}
struct Decoder<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl<'a> Decoder<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], CatalogError> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| corrupt("offset overflow"))?;
        let bytes = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| corrupt("truncated binary record"))?;
        self.position = end;
        Ok(bytes)
    }
    fn byte(&mut self) -> Result<u8, CatalogError> {
        Ok(self.take(1)?[0])
    }
    fn boolean(&mut self) -> Result<bool, CatalogError> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(corrupt("invalid boolean")),
        }
    }
    fn u32(&mut self) -> Result<u32, CatalogError> {
        let bytes = self.take(4)?.try_into().map_err(|_| corrupt("short u32"))?;
        Ok(u32::from_le_bytes(bytes))
    }
    fn u64(&mut self) -> Result<u64, CatalogError> {
        let bytes = self.take(8)?.try_into().map_err(|_| corrupt("short u64"))?;
        Ok(u64::from_le_bytes(bytes))
    }
    fn count(&mut self, minimum_width: usize) -> Result<usize, CatalogError> {
        let count = self.u32()? as usize;
        if count > (self.bytes.len() - self.position) / minimum_width {
            return Err(corrupt("impossible binary count"));
        }
        Ok(count)
    }
    fn str(&mut self) -> Result<&'a str, CatalogError> {
        let len = self.count(1)?;
        std::str::from_utf8(self.take(len)?).map_err(|_| corrupt("invalid UTF-8"))
    }
    fn header_data(&mut self) -> Result<PackageHeaderData, CatalogError> {
        Ok(PackageHeaderData {
            package_flags: self.u32()?,
            gatherable_text_data_count: self.u32()?,
            gatherable_text_data_offset: self.u64()?,
            has_text_property: self.boolean()?,
        })
    }
    fn finish(self) -> Result<(), CatalogError> {
        if self.position == self.bytes.len() {
            Ok(())
        } else {
            Err(corrupt("trailing binary bytes"))
        }
    }
}

/// Whether `path` sorts before `stem` followed by `joint`, without building that string.
fn path_before_joined(path: &str, stem: &str, joint: u8) -> bool {
    let (path, stem) = (path.as_bytes(), stem.as_bytes());
    let common = path.len().min(stem.len());
    match path[..common].cmp(&stem[..common]) {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Greater => false,
        // `path` continues past `stem`: compare its next byte with the joint; a tie leaves
        // `path` longer, so after. A `path` no longer than `stem` comes before it and its joint.
        std::cmp::Ordering::Equal => path.get(stem.len()).is_none_or(|next| *next < joint),
    }
}

/// Strings in one arena: string `i` is `text[ends[i - 1]..ends[i]]`. One allocation for any
/// number of strings, and no per-string header.
#[derive(Clone, Debug, Default)]
struct StringTable {
    text: String,
    ends: Vec<u32>,
}
impl StringTable {
    fn with_capacity(bytes: usize, strings: usize) -> Self {
        Self {
            text: String::with_capacity(bytes),
            ends: Vec::with_capacity(strings),
        }
    }
    fn len(&self) -> usize {
        self.ends.len()
    }
    /// String `id`; ids are checked when they are decoded, so an unknown one reads as empty.
    fn get(&self, id: usize) -> &str {
        let Some(end) = self.ends.get(id) else {
            return "";
        };
        let start = if id == 0 { 0 } else { self.ends[id - 1] };
        self.text.get(start as usize..*end as usize).unwrap_or("")
    }
    fn push(&mut self, value: &str) -> Result<u32, CatalogError> {
        let id = u32::try_from(self.ends.len()).map_err(|_| corrupt("too many shared strings"))?;
        self.text.push_str(value);
        let end = u32::try_from(self.text.len()).map_err(|_| corrupt("string table too large"))?;
        self.ends.push(end);
        Ok(id)
    }
}

/// The decoded shared strings (section 1): the strings by id, and their ids in lexicon order.
struct Strings {
    table: StringTable,
    lexicon: Vec<u32>,
}
impl Strings {
    /// Decodes and checks the shared strings: each string valid UTF-8, each lexicon id known, and
    /// the lexicon strictly ordered. The text is copied into the table and checked in one pass,
    /// and the lexicon's order is checked a part at a time on several threads.
    fn decode(bytes: &[u8]) -> Result<Self, CatalogError> {
        let mut d = Decoder::new(bytes);
        let count = d.count(8)?;
        let mut ends = Vec::with_capacity(count);
        // Besides the text, the section holds the count and each string's length and lexicon id.
        let mut text = Vec::with_capacity(bytes.len().saturating_sub(4 + 8 * count));
        for _ in 0..count {
            let len = d.count(1)?;
            text.extend_from_slice(d.take(len)?);
            ends.push(u32::try_from(text.len()).map_err(|_| corrupt("string table too large"))?);
        }
        let lexicon_bytes = d.take(count * 4)?;
        d.finish()?;
        let text = String::from_utf8(text).map_err(|_| corrupt("invalid UTF-8"))?;
        // The text is valid UTF-8, so each string is when each starts a character.
        if !ends.iter().all(|end| text.is_char_boundary(*end as usize)) {
            return Err(corrupt("invalid UTF-8"));
        }
        let per_part = count.div_ceil(codec_threads(count.div_ceil(4096))).max(1);
        let table = StringTable { text, ends };
        let mut lexicon: Vec<u32> = Vec::with_capacity(count);
        for raw in lexicon_bytes.as_chunks::<4>().0 {
            let id = u32::from_le_bytes(*raw);
            if id as usize >= count {
                return Err(corrupt("invalid dictionary id"));
            }
            lexicon.push(id);
        }
        let ordered = std::thread::scope(|scope| {
            let (table, lexicon) = (&table, &lexicon);
            let workers = (1..count.max(1))
                .step_by(per_part)
                .map(|first| {
                    let last = (first + per_part).min(count);
                    scope.spawn(move || {
                        (first..last).all(|index| {
                            lexicon_order(
                                table.get(lexicon[index - 1] as usize),
                                table.get(lexicon[index] as usize),
                            ) == std::cmp::Ordering::Less
                        })
                    })
                })
                .collect::<Vec<_>>();
            workers.into_iter().all(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
        });
        if !ordered {
            return Err(corrupt("dictionary must be unique and ordered"));
        }
        Ok(Self { table, lexicon })
    }
}

/// Hashes a u32 string id with one multiplication: ids are dense, so this spreads them well.
#[derive(Default)]
struct IdHasher(u64);
impl std::hash::Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = (self.0.rotate_left(8) ^ u64::from(*byte)).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        }
    }
    fn write_u32(&mut self, value: u32) {
        self.0 = u64::from(value).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
    /// A string id with its segment above it, as dictionary pages key strings.
    fn write_u64(&mut self, value: u64) {
        self.0 = (value ^ value >> 32).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
}
type BuildIdHasher = std::hash::BuildHasherDefault<IdHasher>;

/// Fast string hash for the writer's dictionary (not persisted).
fn string_hash(bytes: &[u8]) -> u64 {
    const K: u64 = 0xf135_7aea_2e62_a9c5;
    let mut hash = (bytes.len() as u64).wrapping_mul(K);
    let (chunks, rest) = bytes.as_chunks::<8>();
    for chunk in chunks {
        hash = (hash ^ u64::from_le_bytes(*chunk))
            .wrapping_mul(K)
            .rotate_left(26);
    }
    if !rest.is_empty() {
        let mut tail = [0; 8];
        tail[..rest.len()].copy_from_slice(rest);
        hash = (hash ^ u64::from_le_bytes(tail))
            .wrapping_mul(K)
            .rotate_left(26);
    }
    hash ^ (hash >> 29)
}

/// The writer's shared strings: the committed strings, with their ids, then those this refresh
/// adds. Strings live once in an arena; the index holds only ids.
struct Dictionary {
    table: StringTable,
    /// Open-addressed slots, each 0 (empty) or the string's 32-bit hash above `id + 1`, so a
    /// probe compares text only on a likely match and growing rehashes no text. At most half
    /// full.
    slots: Vec<u64>,
    /// Committed strings: ids below this keep their committed lexicon order.
    prior: usize,
    prior_lexicon: Vec<u32>,
}
impl Dictionary {
    /// A dictionary with no strings, as each header worker starts with.
    fn empty() -> Self {
        Self {
            table: StringTable::default(),
            slots: vec![0; 1024],
            prior: 0,
            prior_lexicon: Vec::new(),
        }
    }
    fn new(prior: Option<&Strings>) -> Result<Self, CatalogError> {
        let (table, prior_lexicon) =
            prior.map_or_else(Default::default, |p| (p.table.clone(), p.lexicon.clone()));
        let slots = (table.len() * 2).next_power_of_two().max(1024);
        let mut dictionary = Self {
            prior: table.len(),
            slots: vec![0; slots],
            table,
            prior_lexicon,
        };
        let mask = slots - 1;
        for id in 0..dictionary.table.len() {
            let hash = string_hash(dictionary.table.get(id).as_bytes()) as u32;
            let mut slot = hash as usize & mask;
            while dictionary.slots[slot] != 0 {
                slot = (slot + 1) & mask;
            }
            dictionary.slots[slot] = u64::from(hash) << 32 | (id as u64 + 1);
        }
        Ok(dictionary)
    }
    fn len(&self) -> usize {
        self.table.len()
    }
    fn grow(&mut self) {
        let old = std::mem::take(&mut self.slots);
        self.slots = vec![0; old.len() * 2];
        let mask = self.slots.len() - 1;
        for stored in old.into_iter().filter(|stored| *stored != 0) {
            let mut slot = (stored >> 32) as usize & mask;
            while self.slots[slot] != 0 {
                slot = (slot + 1) & mask;
            }
            self.slots[slot] = stored;
        }
    }
    fn intern(&mut self, value: &str) -> Result<u32, CatalogError> {
        self.intern_hashed(string_hash(value.as_bytes()) as u32, value)
    }
    /// [`Dictionary::intern`] for a value whose `string_hash` is already known.
    fn intern_hashed(&mut self, hash: u32, value: &str) -> Result<u32, CatalogError> {
        let mask = self.slots.len() - 1;
        let mut slot = hash as usize & mask;
        loop {
            let stored = self.slots[slot];
            if stored == 0 {
                break;
            }
            if (stored >> 32) as u32 == hash {
                let id = (stored & u64::from(u32::MAX)) as usize - 1;
                if self.table.get(id) == value {
                    return Ok(id as u32);
                }
            }
            slot = (slot + 1) & mask;
        }
        let id = self.table.push(value)?;
        if id == u32::MAX {
            return Err(corrupt("too many shared strings"));
        }
        self.slots[slot] = u64::from(hash) << 32 | (u64::from(id) + 1);
        if self.table.len() * 2 > self.slots.len() {
            self.grow();
        }
        Ok(id)
    }
    /// Every id in lexicon order: the committed order merged with the new strings, sorted.
    fn lexicon(&self) -> Vec<u32> {
        let added = sort_lexicon(&self.table, self.prior as u32..self.table.len() as u32);
        let mut lexicon = Vec::with_capacity(self.table.len());
        let (mut old, mut new) = (
            self.prior_lexicon.iter().peekable(),
            added.iter().peekable(),
        );
        loop {
            let next = match (old.peek(), new.peek()) {
                (Some(a), Some(b)) => {
                    if lexicon_order(self.table.get(**a as usize), self.table.get(**b as usize))
                        == std::cmp::Ordering::Less
                    {
                        old.next()
                    } else {
                        new.next()
                    }
                }
                (Some(_), None) => old.next(),
                (None, Some(_)) => new.next(),
                (None, None) => break,
            };
            lexicon.extend(next);
        }
        lexicon
    }
    fn encode(&self) -> Result<Vec<u8>, CatalogError> {
        let mut out = Vec::with_capacity(self.table.text.len() + self.table.len() * 8 + 4);
        put32(&mut out, self.table.len())?;
        for id in 0..self.table.len() {
            put_string(&mut out, self.table.get(id))?;
        }
        for id in self.lexicon() {
            out.extend_from_slice(&id.to_le_bytes());
        }
        Ok(out)
    }
}

/// The first eight bytes of a string, ASCII folded, as a big-endian number: ordering these orders
/// the strings' folded bytes, except among strings that share them.
fn folded_prefix(value: &str) -> u64 {
    let mut prefix = [0; 8];
    for (slot, byte) in prefix.iter_mut().zip(value.bytes()) {
        *slot = byte.to_ascii_lowercase();
    }
    u64::from_be_bytes(prefix)
}

/// Strings below which [`sort_lexicon`] sorts on one thread.
const PARALLEL_SORT_STRINGS: usize = 64 * 1024;

/// The string ids `ids` in lexicon order. Large sets sort in runs on several threads, then the
/// runs merge pairwise; a folded-prefix key decides most comparisons without reading the text.
fn sort_lexicon(table: &StringTable, ids: std::ops::Range<u32>) -> Vec<u32> {
    let mut keyed = ids
        .map(|id| (folded_prefix(table.get(id as usize)), id))
        .collect::<Vec<_>>();
    let order = |a: &(u64, u32), b: &(u64, u32)| {
        a.0.cmp(&b.0)
            .then_with(|| lexicon_order(table.get(a.1 as usize), table.get(b.1 as usize)))
    };
    let threads = codec_threads(keyed.len() / (PARALLEL_SORT_STRINGS / 4));
    if keyed.len() < PARALLEL_SORT_STRINGS || threads < 2 {
        keyed.sort_unstable_by(order);
        return keyed.into_iter().map(|(_, id)| id).collect();
    }
    let per_run = keyed.len().div_ceil(threads);
    let mut runs = keyed
        .chunks(per_run)
        .map(<[(u64, u32)]>::to_vec)
        .collect::<Vec<_>>();
    drop(keyed);
    std::thread::scope(|scope| {
        for run in &mut runs {
            scope.spawn(move || run.sort_unstable_by(order));
        }
    });
    while runs.len() > 1 {
        let pairs = std::mem::take(&mut runs);
        let mut pairs = pairs.into_iter();
        let mut merging = Vec::new();
        while let Some(left) = pairs.next() {
            match pairs.next() {
                Some(right) => merging.push((left, right)),
                None => runs.push(left),
            }
        }
        let merged = std::thread::scope(|scope| {
            merging
                .into_iter()
                .map(|(left, right)| {
                    scope.spawn(move || {
                        let mut out = Vec::with_capacity(left.len() + right.len());
                        let (mut left, mut right) =
                            (left.into_iter().peekable(), right.into_iter().peekable());
                        while let (Some(a), Some(b)) = (left.peek(), right.peek()) {
                            out.extend(if order(a, b) == std::cmp::Ordering::Less {
                                left.next()
                            } else {
                                right.next()
                            });
                        }
                        out.extend(left);
                        out.extend(right);
                        out
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join())
                .collect::<Vec<_>>()
        });
        for run in merged {
            match run {
                Ok(run) => runs.push(run),
                Err(panic) => std::panic::resume_unwind(panic),
            }
        }
    }
    runs.pop()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, id)| id)
        .collect()
}

/// One header record (section 4): package name, header data, failure, then classes, names and
/// dependencies as `dictionary` string ids. Returns where the class count starts in `out`.
fn encode_header_record(
    header: &HeaderEvidence,
    dictionary: &mut Dictionary,
    out: &mut Vec<u8>,
) -> Result<usize, CatalogError> {
    out.push(1);
    put_string(out, &header.package_name)?;
    out.push(u8::from(header.header_data.is_some()));
    if let Some(data) = &header.header_data {
        put_header_data(out, data);
    }
    out.push(u8::from(header.failure_code.is_some()));
    if let Some(code) = &header.failure_code {
        put_string(out, code)?;
    }
    let ids_at = out.len();
    for values in [&header.classes, &header.serialized_names] {
        put32(out, values.len())?;
        for value in values {
            out.extend_from_slice(&dictionary.intern(value)?.to_le_bytes());
        }
    }
    put32(out, header.dependencies.len())?;
    for dependency in &header.dependencies {
        out.extend_from_slice(&dictionary.intern(&dependency.package)?.to_le_bytes());
        out.push(dependency.properties());
    }
    Ok(ids_at)
}

/// The little-endian u32 at `at`.
fn u32_at(bytes: &[u8], at: usize) -> Result<u32, CatalogError> {
    bytes
        .get(at..at + 4)
        .and_then(|raw| raw.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| corrupt("truncated prepared record"))
}

/// Rewrites a record's string ids (its classes, names and dependency targets, from `ids_at`)
/// through `remap`.
fn remap_record_ids(record: &mut [u8], ids_at: usize, remap: &[u32]) -> Result<(), CatalogError> {
    let rewrite = |record: &mut [u8], at: usize| -> Result<(), CatalogError> {
        let id = *remap
            .get(u32_at(record, at)? as usize)
            .ok_or_else(|| corrupt("prepared record names an unknown string"))?;
        record[at..at + 4].copy_from_slice(&id.to_le_bytes());
        Ok(())
    };
    let mut at = ids_at;
    for _ in 0..2 {
        let count = u32_at(record, at)? as usize;
        at += 4;
        for _ in 0..count {
            rewrite(record, at)?;
            at += 4;
        }
    }
    let count = u32_at(record, at)? as usize;
    at += 4;
    for _ in 0..count {
        rewrite(record, at)?;
        at += 5;
    }
    if at != record.len() {
        return Err(corrupt(
            "prepared record does not end with its dependencies",
        ));
    }
    Ok(())
}

/// Encodes header evidence on the header workers. Each worker keeps its own string dictionary
/// and writes records with its own string ids, sending with each record the strings it first met
/// there. Staging gives those strings their shared ids in staging order, so shared ids are the
/// same whichever worker read which package.
pub(crate) struct BinaryPreparer {
    workers: AtomicUsize,
}

/// One header worker's encoder: its strings, by its own ids.
pub(crate) struct EncodingWorker {
    slot: usize,
    strings: Dictionary,
}

/// A record a header worker encoded, with its worker's string ids.
pub(crate) struct EncodedHeader {
    slot: usize,
    /// The record, then each string the worker first met in it: hash, length and bytes.
    bytes: Vec<u8>,
    record_len: usize,
    ids_at: usize,
    /// The worker's id for the first of those strings, and how many there are.
    first_string: usize,
    new_strings: usize,
    profile: u32,
    failure: bool,
    header_data: Option<PackageHeaderData>,
}

impl EvidencePreparer for BinaryPreparer {
    type Worker = EncodingWorker;
    type Prepared = Result<EncodedHeader, CatalogError>;

    fn worker(&self) -> EncodingWorker {
        EncodingWorker {
            slot: self.workers.fetch_add(1, Ordering::Relaxed),
            strings: Dictionary::empty(),
        }
    }

    fn prepare(
        &self,
        worker: &mut EncodingWorker,
        evidence: HeaderEvidence,
    ) -> Result<EncodedHeader, CatalogError> {
        let first_string = worker.strings.len();
        let mut bytes = Vec::with_capacity(
            evidence.package_name.len()
                + 64
                + 4 * (evidence.classes.len() + evidence.serialized_names.len())
                + 5 * evidence.dependencies.len(),
        );
        let ids_at = encode_header_record(&evidence, &mut worker.strings, &mut bytes)?;
        let record_len = bytes.len();
        for id in first_string..worker.strings.len() {
            let value = worker.strings.table.get(id);
            bytes.extend_from_slice(&(string_hash(value.as_bytes()) as u32).to_le_bytes());
            put_string(&mut bytes, value)?;
        }
        Ok(EncodedHeader {
            slot: worker.slot,
            bytes,
            record_len,
            ids_at,
            first_string,
            new_strings: worker.strings.len() - first_string,
            profile: evidence.profile_version,
            failure: evidence.failure_code.is_some(),
            header_data: evidence.header_data,
        })
    }
}

/// Gives the strings `header`'s worker first met in it their shared ids, in order, extending the
/// worker's map from its ids to shared ones.
fn absorb_strings(
    dictionary: &mut Dictionary,
    remaps: &mut Vec<Vec<u32>>,
    header: &EncodedHeader,
) -> Result<(), CatalogError> {
    if remaps.len() <= header.slot {
        remaps.resize_with(header.slot + 1, Vec::new);
    }
    let remap = &mut remaps[header.slot];
    if remap.len() != header.first_string {
        return Err(corrupt(
            "prepared evidence reached staging out of its worker's order",
        ));
    }
    let mut d = Decoder::new(
        header
            .bytes
            .get(header.record_len..)
            .ok_or_else(|| corrupt("truncated prepared record"))?,
    );
    remap.reserve(header.new_strings);
    for _ in 0..header.new_strings {
        let hash = d.u32()?;
        remap.push(dictionary.intern_hashed(hash, d.str()?)?);
    }
    d.finish()
}

/// A record's header, borrowed from its decoded bytes and checked: ids name shared strings.
struct HeaderView<'b> {
    package_name: &'b str,
    header_data: Option<PackageHeaderData>,
    failure_code: Option<&'b str>,
    classes: &'b [u8],
    names: &'b [u8],
    dependencies: &'b [u8],
}
impl HeaderView<'_> {
    fn ids(bytes: &[u8]) -> impl Iterator<Item = u32> + '_ {
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|raw| u32::from_le_bytes(*raw))
    }
    fn class_ids(&self) -> impl Iterator<Item = u32> + '_ {
        Self::ids(self.classes)
    }
    fn name_ids(&self) -> impl Iterator<Item = u32> + '_ {
        Self::ids(self.names)
    }
    fn dependency_ids(&self) -> impl Iterator<Item = (u32, u8)> + '_ {
        self.dependencies
            .as_chunks::<5>()
            .0
            .iter()
            .map(|raw| (u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]), raw[4]))
    }
}

fn decode_record(bytes: &[u8], strings: u64) -> Result<Option<HeaderView<'_>>, CatalogError> {
    let mut d = Decoder::new(bytes);
    if !d.boolean()? {
        d.finish()?;
        return Ok(None);
    }
    let package_name = d.str()?;
    let header_data = if d.boolean()? {
        Some(d.header_data()?)
    } else {
        None
    };
    let failure_code = if d.boolean()? { Some(d.str()?) } else { None };
    let mut string_ids = || -> Result<&[u8], CatalogError> {
        let count = d.count(4)?;
        let ids = d.take(count * 4)?;
        if HeaderView::ids(ids).any(|id| u64::from(id) >= strings) {
            return Err(corrupt("invalid evidence string id"));
        }
        Ok(ids)
    };
    let classes = string_ids()?;
    let names = string_ids()?;
    let count = d.count(5)?;
    let dependencies = d.take(count * 5)?;
    let view = HeaderView {
        package_name,
        header_data,
        failure_code,
        classes,
        names,
        dependencies,
    };
    if view
        .dependency_ids()
        .any(|(id, properties)| u64::from(id) >= strings || properties > 7)
    {
        return Err(corrupt("invalid dependency evidence"));
    }
    d.finish()?;
    Ok(Some(view))
}

/// One inventory row (section 0). Paths live in the snapshot's path table, by the same id.
#[derive(Clone, Debug)]
struct InventoryEntry {
    kind: EntryKind,
    size: u64,
    modified_nanos: u64,
    profile: Option<u32>,
    failure: bool,
    is_map: bool,
    offset: u64,
    len: u32,
    checksum: u64,
    /// A copy of the record's header data, so inventory pages read no records.
    header_data: Option<PackageHeaderData>,
}
fn encode_inventory_entry(
    out: &mut Vec<u8>,
    path: &str,
    entry: &InventoryEntry,
) -> Result<(), CatalogError> {
    put_string(out, path)?;
    out.push(encode_kind(entry.kind));
    put64(out, entry.size);
    put64(out, entry.modified_nanos);
    out.push(u8::from(entry.profile.is_some()));
    if let Some(profile) = entry.profile {
        out.extend_from_slice(&profile.to_le_bytes());
    }
    out.push(u8::from(entry.failure));
    put64(out, entry.offset);
    out.extend_from_slice(&entry.len.to_le_bytes());
    put64(out, entry.checksum);
    out.push(u8::from(entry.header_data.is_some()));
    if let Some(data) = &entry.header_data {
        put_header_data(out, data);
    }
    Ok(())
}

#[derive(Clone, Copy, Default)]
struct Posting {
    kind: u8,
    value: u32,
    offset: u64,
    len: u32,
    checksum: u64,
}
/// The block one call decoded last (section, block, bytes). It lives only for that call:
/// nothing survives a query, so later queries still detect changed or truncated bytes.
#[derive(Default)]
struct LastBlock(Option<(usize, u64, Vec<u8>)>);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SectionHeader {
    stored: u64,
    length: u64,
    hash: u64,
    stored_hash: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct SnapshotHeader {
    sections: [SectionHeader; SECTIONS],
    packages: u64,
    maps: u64,
    strings: u64,
}
impl SnapshotHeader {
    fn encode(&self) -> Vec<u8> {
        let mut out = MAGIC.to_vec();
        for section in &self.sections {
            put64(&mut out, section.stored);
            put64(&mut out, section.length);
            put64(&mut out, section.hash);
            put64(&mut out, section.stored_hash);
        }
        put64(&mut out, self.packages);
        put64(&mut out, self.maps);
        put64(&mut out, self.strings);
        let hash = checksum(&out);
        put64(&mut out, hash);
        out
    }
    fn decode(bytes: &[u8]) -> Result<Self, CatalogError> {
        let mut d = Decoder::new(bytes);
        if d.take(8)? != MAGIC {
            return Err(corrupt("unknown binary Catalog format"));
        }
        let mut header = Self::default();
        for section in &mut header.sections {
            *section = SectionHeader {
                stored: d.u64()?,
                length: d.u64()?,
                hash: d.u64()?,
                stored_hash: d.u64()?,
            };
            if section.length > MAX_SECTION_BYTES || section.stored > MAX_SECTION_BYTES {
                return Err(corrupt("oversized binary section"));
            }
        }
        header.packages = d.u64()?;
        header.maps = d.u64()?;
        header.strings = d.u64()?;
        let end = d.position;
        if d.u64()? != checksum(&bytes[..end]) {
            return Err(corrupt("binary Catalog header checksum mismatch"));
        }
        d.finish()?;
        if header.maps > header.packages || header.strings > u64::from(u32::MAX) {
            return Err(corrupt("invalid binary Catalog counts"));
        }
        Ok(header)
    }
    /// Each section's file offset; sections follow the header in order.
    fn starts(&self) -> Result<[u64; SECTIONS], CatalogError> {
        let mut starts = [0; SECTIONS];
        let mut position = HEADER_BYTES;
        for (start, section) in starts.iter_mut().zip(&self.sections) {
            *start = position;
            position = position
                .checked_add(section.stored)
                .ok_or_else(|| corrupt("section overflow"))?;
        }
        Ok(starts)
    }
    fn file_len(&self) -> Result<u64, CatalogError> {
        let starts = self.starts()?;
        Ok(starts[SECTIONS - 1] + self.sections[SECTIONS - 1].stored)
    }
}

fn read_range(file: &mut File, offset: u64, length: u64) -> Result<Vec<u8>, CatalogError> {
    let mut bytes = Vec::new();
    read_range_into(file, offset, length, &mut bytes)?;
    Ok(bytes)
}
fn read_range_into(
    file: &mut File,
    offset: u64,
    length: u64,
    bytes: &mut Vec<u8>,
) -> Result<(), CatalogError> {
    if length > MAX_SECTION_BYTES {
        return Err(corrupt("Catalog section exceeds 512 MiB"));
    }
    let length =
        usize::try_from(length).map_err(|_| corrupt("section too large for address space"))?;
    bytes.clear();
    bytes.resize(length, 0);
    file.seek(SeekFrom::Start(offset))
        .map_err(io_unavailable("seek binary snapshot"))?;
    file.read_exact(bytes).map_err(|error| {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            corrupt(format!("truncated binary snapshot: {error}"))
        } else {
            io_unavailable("read binary snapshot")(error)
        }
    })
}
/// A block: zstd when stored shorter than its decoded length, else the bytes as stored.
fn decode_block(stored: &[u8], length: u64) -> Result<Vec<u8>, CatalogError> {
    let mut bytes = vec![0; usize::try_from(length).map_err(|_| corrupt("block too large"))?];
    decode_block_into(stored, &mut bytes, &mut None)?;
    Ok(bytes)
}
fn decode_block_into(
    stored: &[u8],
    out: &mut [u8],
    decompressor: &mut Option<zstd::bulk::Decompressor<'static>>,
) -> Result<(), CatalogError> {
    if stored.len() == out.len() {
        out.copy_from_slice(stored);
        return Ok(());
    }
    let decompressor = match decompressor {
        Some(decompressor) => decompressor,
        None => decompressor.insert(
            zstd::bulk::Decompressor::new()
                .map_err(|error| corrupt(format!("binary section does not decode: {error}")))?,
        ),
    };
    let written = decompressor
        .decompress_to_buffer(stored, out)
        .map_err(|error| corrupt(format!("binary section does not decode: {error}")))?;
    if written != out.len() {
        return Err(corrupt("binary section length mismatch"));
    }
    Ok(())
}
fn block_length(section_length: u64, block: usize) -> u64 {
    (section_length - block as u64 * BLOCK_BYTES).min(BLOCK_BYTES)
}
/// Reads a section's index: its block count, then each block's end offset relative to the
/// first block. Returns each block's absolute file range.
fn block_ranges(
    file: &mut File,
    start: u64,
    stored: u64,
    length: u64,
) -> Result<Vec<(u64, u64)>, CatalogError> {
    let count = length.div_ceil(BLOCK_BYTES);
    let index_bytes = 4 + count * 8;
    if stored < index_bytes {
        return Err(corrupt("truncated block index"));
    }
    let index = read_range(file, start, index_bytes)?;
    let mut d = Decoder::new(&index);
    if u64::from(d.u32()?) != count {
        return Err(corrupt("block count does not match the section length"));
    }
    let mut ranges = Vec::with_capacity(count as usize);
    let mut previous = 0;
    for block in 0..count as usize {
        let end = d.u64()?;
        if end <= previous || end - previous > block_length(length, block) {
            return Err(corrupt("invalid block index"));
        }
        ranges.push((start + index_bytes + previous, end - previous));
        previous = end;
    }
    d.finish()?;
    if index_bytes + previous != stored {
        return Err(corrupt("blocks do not fill their section"));
    }
    Ok(ranges)
}
fn read_block(
    file: &mut File,
    (start, stored): (u64, u64),
    length: u64,
) -> Result<Vec<u8>, CatalogError> {
    decode_block(&read_range(file, start, stored)?, length)
}

/// Threads for one parallel codec pass over `blocks` blocks.
fn codec_threads(blocks: usize) -> usize {
    std::thread::available_parallelism()
        .map_or(4, std::num::NonZeroUsize::get)
        .min(MAX_CODEC_THREADS)
        .min(blocks.div_ceil(4))
        .max(1)
}

/// A whole section from its blocks' stored bytes (`blocks` holds them back to back, from the
/// file offset `base`), decoded in parallel into one buffer.
fn decode_blocks(
    blocks: &[u8],
    base: u64,
    ranges: &[(u64, u64)],
    length: u64,
) -> Result<Vec<u8>, CatalogError> {
    decode_blocks_with(blocks, base, ranges, length, false).map(|(bytes, _)| bytes)
}

/// [`decode_blocks`], with the checksum of the decoded bytes: each thread hashes the blocks it
/// decoded, and the parts' checksums are combined in order.
fn decode_blocks_hashed(
    blocks: &[u8],
    base: u64,
    ranges: &[(u64, u64)],
    length: u64,
) -> Result<(Vec<u8>, crc32fast::Hasher), CatalogError> {
    decode_blocks_with(blocks, base, ranges, length, true)
}

fn decode_blocks_with(
    blocks: &[u8],
    base: u64,
    ranges: &[(u64, u64)],
    length: u64,
    hash: bool,
) -> Result<(Vec<u8>, crc32fast::Hasher), CatalogError> {
    let mut out = vec![0; usize::try_from(length).map_err(|_| corrupt("section too large"))?];
    let mut work = Vec::with_capacity(ranges.len());
    for (chunk, &(start, stored)) in out.chunks_mut(BLOCK_BYTES as usize).zip(ranges) {
        let from = usize::try_from(start - base).map_err(|_| corrupt("invalid block"))?;
        let to = from + usize::try_from(stored).map_err(|_| corrupt("invalid block"))?;
        let source = blocks
            .get(from..to)
            .ok_or_else(|| corrupt("binary range leaves its section"))?;
        work.push((source, chunk));
    }
    let threads = codec_threads(work.len());
    let per_thread = work.len().div_ceil(threads).max(1);
    let parts = std::thread::scope(|scope| {
        let workers = work
            .chunks_mut(per_thread)
            .map(|part| {
                scope.spawn(move || {
                    let mut decompressor = None;
                    let mut hasher = crc32fast::Hasher::new();
                    for (source, chunk) in part {
                        decode_block_into(source, chunk, &mut decompressor)?;
                        if hash {
                            hasher.update(chunk);
                        }
                    }
                    Ok(hasher)
                })
            })
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
            .collect::<Result<Vec<_>, CatalogError>>()
    })?;
    let mut hasher = crc32fast::Hasher::new();
    for part in &parts {
        hasher.combine(part);
    }
    Ok((out, hasher))
}

/// Compresses `raw` as 64 KiB blocks on several threads, in block order. A block that does not
/// compress smaller is kept raw.
fn compress_blocks(raw: &[u8], level: i32) -> Result<Vec<Vec<u8>>, CatalogError> {
    let chunks = raw.chunks(BLOCK_BYTES as usize).collect::<Vec<_>>();
    let mut frames = vec![Vec::new(); chunks.len()];
    let threads = codec_threads(chunks.len());
    let next = AtomicUsize::new(0);
    let failure = Mutex::new(None);
    let results = Mutex::new(Vec::with_capacity(chunks.len()));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            let (chunks, next, failure, results) = (&chunks, &next, &failure, &results);
            scope.spawn(move || {
                let mut compressor = match zstd::bulk::Compressor::new(level) {
                    Ok(compressor) => compressor,
                    Err(error) => {
                        *failure
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
                        return;
                    }
                };
                let mut local = Vec::new();
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(chunk) = chunks.get(index) else {
                        break;
                    };
                    match compressor.compress(chunk) {
                        Ok(compressed) if compressed.len() < chunk.len() => {
                            local.push((index, compressed));
                        }
                        Ok(_) => local.push((index, chunk.to_vec())),
                        Err(error) => {
                            *failure
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
                            return;
                        }
                    }
                }
                results
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .extend(local);
            });
        }
    });
    if let Some(error) = failure
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    {
        return Err(corrupt(format!(
            "could not encode a Catalog section: {error}"
        )));
    }
    for (index, frame) in results
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    {
        frames[index] = frame;
    }
    Ok(frames)
}

/// A section as stored: its block index, then its blocks.
struct StoredSection {
    index: Vec<u8>,
    blocks: Vec<u8>,
    header: SectionHeader,
}
impl StoredSection {
    fn write(&self, file: &mut File) -> Result<(), CatalogError> {
        file.write_all(&self.index)
            .map_err(io_unavailable("write binary section"))?;
        file.write_all(&self.blocks)
            .map_err(io_unavailable("write binary section"))
    }
}

/// Builds one section as it is appended: full batches of blocks are compressed in parallel and
/// their raw bytes dropped, so a section is never held raw and compressed at once.
struct SectionWriter {
    pending: Vec<u8>,
    blocks: Vec<u8>,
    ends: Vec<u64>,
    length: u64,
    /// Checksum of the decoded bytes after `head`.
    hash: crc32fast::Hasher,
    /// The first block, held raw until `finish` so its bytes can still be patched.
    head: Option<Vec<u8>>,
}
impl SectionWriter {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
            blocks: Vec::new(),
            ends: Vec::new(),
            length: 0,
            hash: crc32fast::Hasher::new(),
            head: None,
        }
    }
    /// A writer whose first block can be patched until it finishes.
    fn with_patchable_head() -> Self {
        Self {
            head: Some(Vec::new()),
            ..Self::new()
        }
    }
    fn len(&self) -> u64 {
        self.length
    }
    fn push(&mut self, mut bytes: &[u8]) -> Result<(), CatalogError> {
        self.length += bytes.len() as u64;
        if self.length > MAX_SECTION_BYTES {
            return Err(corrupt("Catalog section exceeds 512 MiB"));
        }
        if let Some(head) = &mut self.head {
            let room = (BLOCK_BYTES as usize - head.len()).min(bytes.len());
            head.extend_from_slice(&bytes[..room]);
            bytes = &bytes[room..];
        }
        self.hash.update(bytes);
        self.pending.extend_from_slice(bytes);
        if self.pending.len() >= COMPRESSION_BATCH_BYTES {
            self.flush(false)?;
        }
        Ok(())
    }
    /// Overwrites bytes of the held first block.
    fn patch_head(&mut self, offset: usize, bytes: &[u8]) -> Result<(), CatalogError> {
        self.head
            .as_mut()
            .and_then(|head| head.get_mut(offset..offset + bytes.len()))
            .ok_or_else(|| corrupt("patch outside a section's held first block"))?
            .copy_from_slice(bytes);
        Ok(())
    }
    fn flush(&mut self, last: bool) -> Result<(), CatalogError> {
        let full = if last {
            self.pending.len()
        } else {
            self.pending.len() / BLOCK_BYTES as usize * BLOCK_BYTES as usize
        };
        for frame in compress_blocks(&self.pending[..full], COMPRESSION_LEVEL)? {
            self.blocks.extend_from_slice(&frame);
            self.ends.push(self.blocks.len() as u64);
        }
        self.pending.drain(..full);
        Ok(())
    }
    fn finish(mut self) -> Result<StoredSection, CatalogError> {
        self.flush(true)?;
        if let Some(head) = self.head.take() {
            let mut hash = crc32fast::Hasher::new();
            hash.update(&head);
            hash.combine(&self.hash);
            self.hash = hash;
            if !head.is_empty() {
                let frame = compress_blocks(&head, COMPRESSION_LEVEL)?.concat();
                let shift = frame.len() as u64;
                self.blocks.splice(0..0, frame);
                for end in &mut self.ends {
                    *end += shift;
                }
                self.ends.insert(0, shift);
            }
        }
        let mut index = Vec::with_capacity(4 + self.ends.len() * 8);
        put32(&mut index, self.ends.len())?;
        for end in &self.ends {
            put64(&mut index, *end);
        }
        let mut stored_hash = crc32fast::Hasher::new();
        stored_hash.update(&index);
        stored_hash.update(&self.blocks);
        Ok(StoredSection {
            header: SectionHeader {
                stored: (index.len() + self.blocks.len()) as u64,
                length: self.length,
                hash: u64::from(self.hash.finalize()),
                stored_hash: u64::from(stored_hash.finalize()),
            },
            index,
            blocks: self.blocks,
        })
    }
}
fn encode_section(raw: &[u8]) -> Result<StoredSection, CatalogError> {
    let mut writer = SectionWriter::new();
    writer.push(raw)?;
    writer.finish()
}

impl StoredSection {
    /// Each block's range in `blocks`, from the block index.
    fn block_spans(&self) -> Result<Vec<(u64, u64)>, CatalogError> {
        let mut d = Decoder::new(&self.index);
        let count = d.count(8)?;
        let mut spans = Vec::with_capacity(count);
        let mut previous = 0;
        for _ in 0..count {
            let end = d.u64()?;
            if end < previous || end > self.blocks.len() as u64 {
                return Err(corrupt("invalid block index"));
            }
            spans.push((previous, end - previous));
            previous = end;
        }
        d.finish()?;
        Ok(spans)
    }

    /// Calls `visit` with each row's record, in row order, decoding the blocks a batch at a time.
    /// `rows` holds each record's length.
    fn for_each_record(
        &self,
        rows: &[RowShape],
        mut visit: impl FnMut(u32, &RowShape, &[u8]) -> Result<(), CatalogError>,
    ) -> Result<(), CatalogError> {
        let spans = self.block_spans()?;
        let length = self.header.length;
        let (mut raw, mut raw_start, mut next_block, mut offset) = (Vec::new(), 0_u64, 0, 0_u64);
        for (row, shape) in rows.iter().enumerate() {
            let end = offset + u64::from(shape.len);
            if raw_start + (raw.len() as u64) < end {
                raw.drain(..(offset - raw_start) as usize);
                raw_start = offset;
                while raw_start + (raw.len() as u64) < end {
                    let last = (next_block + DECODE_BATCH_BLOCKS).min(spans.len());
                    if next_block == last {
                        return Err(corrupt("records leave their section"));
                    }
                    let decoded = (next_block..last)
                        .map(|block| block_length(length, block))
                        .sum();
                    raw.extend_from_slice(&decode_blocks(
                        &self.blocks,
                        0,
                        &spans[next_block..last],
                        decoded,
                    )?);
                    next_block = last;
                }
            }
            let from = (offset - raw_start) as usize;
            let row = u32::try_from(row).map_err(|_| corrupt("Catalog count exceeds u32"))?;
            visit(row, shape, &raw[from..from + shape.len as usize])?;
            offset = end;
        }
        if offset != length {
            return Err(corrupt("records do not fill their section"));
        }
        Ok(())
    }

    /// Calls `visit` with consecutive batches of rows, in row order: each batch's first row, its
    /// rows, and their records back to back. A batch ends once it holds `target` record bytes,
    /// so at most about `target` bytes plus one decode pass are held. A failure to decode is
    /// reported after the rows before it are visited, as [`Self::for_each_record`] reports it.
    fn for_each_batch(
        &self,
        rows: &[RowShape],
        target: usize,
        mut visit: impl FnMut(usize, &[RowShape], &[u8]) -> Result<(), CatalogError>,
    ) -> Result<(), CatalogError> {
        let spans = self.block_spans()?;
        let length = self.header.length;
        let (mut raw, mut raw_start, mut next_block, mut offset) = (Vec::new(), 0_u64, 0, 0_u64);
        // The batch's first row and where its records start.
        let (mut first, mut first_offset) = (0, 0_u64);
        for (row, shape) in rows.iter().enumerate() {
            if row > first && offset - first_offset >= target as u64 {
                let to = (offset - raw_start) as usize;
                visit(
                    first,
                    &rows[first..row],
                    &raw[(first_offset - raw_start) as usize..to],
                )?;
                raw.drain(..to);
                (raw_start, first, first_offset) = (offset, row, offset);
            }
            let end = offset + u64::from(shape.len);
            while raw_start + (raw.len() as u64) < end {
                let last = (next_block + DECODE_BATCH_BLOCKS).min(spans.len());
                let decoded = if next_block == last {
                    Err(corrupt("records leave their section"))
                } else {
                    let decoded = (next_block..last)
                        .map(|block| block_length(length, block))
                        .sum();
                    decode_blocks(&self.blocks, 0, &spans[next_block..last], decoded)
                };
                match decoded {
                    Ok(decoded) => raw.extend_from_slice(&decoded),
                    Err(error) => {
                        if row > first {
                            let (from, to) = (first_offset - raw_start, offset - raw_start);
                            visit(first, &rows[first..row], &raw[from as usize..to as usize])?;
                        }
                        return Err(error);
                    }
                }
                next_block = last;
            }
            offset = end;
        }
        if rows.len() > first {
            let (from, to) = (first_offset - raw_start, offset - raw_start);
            visit(first, &rows[first..], &raw[from as usize..to as usize])?;
        }
        if offset != length {
            return Err(corrupt("records do not fill their section"));
        }
        Ok(())
    }
}

/// Writes `values` as one little-endian section at the file's position, compressing and writing
/// a batch of blocks at a time: the block index is written last, over a placeholder, so the
/// section is never held whole. Leaves the file positioned after the section.
fn write_u32_section(file: &mut File, values: &[u32]) -> Result<SectionHeader, CatalogError> {
    let length = values.len() as u64 * 4;
    if length > MAX_SECTION_BYTES {
        return Err(corrupt("Catalog section exceeds 512 MiB"));
    }
    let count = length.div_ceil(BLOCK_BYTES);
    let index_len = 4 + count * 8;
    let start = file
        .stream_position()
        .map_err(io_unavailable("seek binary snapshot"))?;
    file.write_all(&vec![0; index_len as usize])
        .map_err(io_unavailable("write binary section"))?;
    let (mut hash, mut blocks_hash) = (crc32fast::Hasher::new(), crc32fast::Hasher::new());
    let mut ends = Vec::with_capacity(count as usize);
    let mut stored = 0_u64;
    let mut raw = Vec::with_capacity(COMPRESSION_BATCH_BYTES.min(values.len() * 4));
    for batch in values.chunks(COMPRESSION_BATCH_BYTES / 4) {
        raw.clear();
        for value in batch {
            raw.extend_from_slice(&value.to_le_bytes());
        }
        hash.update(&raw);
        for frame in compress_blocks(&raw, COMPRESSION_LEVEL)? {
            file.write_all(&frame)
                .map_err(io_unavailable("write binary section"))?;
            blocks_hash.update(&frame);
            stored += frame.len() as u64;
            ends.push(stored);
        }
    }
    let mut index = Vec::with_capacity(index_len as usize);
    put32(&mut index, ends.len())?;
    for end in &ends {
        put64(&mut index, *end);
    }
    file.seek(SeekFrom::Start(start))
        .map_err(io_unavailable("seek binary snapshot"))?;
    file.write_all(&index)
        .map_err(io_unavailable("write binary section"))?;
    file.seek(SeekFrom::Start(start + index_len + stored))
        .map_err(io_unavailable("seek binary snapshot"))?;
    let mut stored_hash = crc32fast::Hasher::new();
    stored_hash.update(&index);
    stored_hash.combine(&blocks_hash);
    Ok(SectionHeader {
        stored: index_len + stored,
        length,
        hash: u64::from(hash.finalize()),
        stored_hash: u64::from(stored_hash.finalize()),
    })
}

fn checked_range(offset: u64, len: u64, total: u64) -> Result<(), CatalogError> {
    if offset.checked_add(len).is_none_or(|end| end > total) {
        return Err(corrupt("binary range leaves its section"));
    }
    Ok(())
}

/// Reads every stored byte of the snapshot once and checks it against the header's stored
/// checksums: whatever changed on disk since the snapshot was written is found without
/// decoding a single block. Sections are split into pieces that several threads read through
/// handles of their own and checksum; the pieces' checksums combine in order.
fn verify_stored(
    path: &Path,
    file: &mut File,
    header: &SnapshotHeader,
) -> Result<(), CatalogError> {
    let starts = header.starts()?;
    let mut pieces = Vec::new();
    for (index, (section, start)) in header.sections.iter().zip(starts).enumerate() {
        let mut done = 0;
        while done < section.stored {
            let length = (section.stored - done).min(VERIFY_PIECE_BYTES);
            pieces.push((index, start + done, length));
            done += length;
        }
    }
    let threads = std::thread::available_parallelism()
        .map_or(4, std::num::NonZeroUsize::get)
        .min(MAX_CODEC_THREADS)
        .min(pieces.len())
        .max(1);
    // Each thread reads through its own handle, so reads do not queue on one file position.
    // A snapshot that cannot be opened again (it was just retired) is read through `file`.
    let handles = (1..threads)
        .map(|_| File::open(path))
        .collect::<Result<Vec<_>, _>>();
    let hashes = match handles {
        Ok(handles) if threads > 1 => {
            let next = AtomicUsize::new(0);
            let results = Mutex::new(vec![None; pieces.len()]);
            let failure = Mutex::new(None);
            std::thread::scope(|scope| {
                for mut handle in
                    std::iter::once(file.try_clone()).chain(handles.into_iter().map(Ok))
                {
                    let (pieces, next, results, failure) = (&pieces, &next, &results, &failure);
                    scope.spawn(move || {
                        let mut buffer = Vec::new();
                        let handle = match handle.as_mut() {
                            Ok(handle) => handle,
                            Err(_) => return,
                        };
                        loop {
                            let index = next.fetch_add(1, Ordering::Relaxed);
                            let Some(&(_, offset, length)) = pieces.get(index) else {
                                return;
                            };
                            let hash = checksum_range(handle, offset, length, &mut buffer);
                            match hash {
                                Ok(hash) => {
                                    results
                                        .lock()
                                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                                        [index] = Some(hash);
                                }
                                Err(error) => {
                                    *failure
                                        .lock()
                                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                                        Some(error);
                                    return;
                                }
                            }
                        }
                    });
                }
            });
            if let Some(error) = failure
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
            {
                return Err(error);
            }
            results
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        }
        _ => {
            let mut buffer = Vec::new();
            pieces
                .iter()
                .map(|&(_, offset, length)| {
                    checksum_range(file, offset, length, &mut buffer).map(Some)
                })
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    let mut combined = vec![crc32fast::Hasher::new(); SECTIONS];
    for (&(section, ..), hash) in pieces.iter().zip(hashes) {
        let hash = hash.ok_or_else(|| corrupt("a section piece was not checked"))?;
        combined[section].combine(&hash);
    }
    for (hash, section) in combined.into_iter().zip(&header.sections) {
        if u64::from(hash.finalize()) != section.stored_hash {
            return Err(corrupt("binary section checksum mismatch"));
        }
    }
    Ok(())
}

/// The checksum of `length` stored bytes at `offset`, read a chunk at a time into `buffer`.
fn checksum_range(
    file: &mut File,
    offset: u64,
    length: u64,
    buffer: &mut Vec<u8>,
) -> Result<crc32fast::Hasher, CatalogError> {
    let mut hash = crc32fast::Hasher::new();
    let mut done = 0;
    while done < length {
        let chunk = (length - done).min(VERIFY_CHUNK_BYTES as u64);
        read_range_into(file, offset + done, chunk, buffer)?;
        hash.update(buffer);
        done += chunk;
    }
    Ok(hash)
}

/// How much a snapshot open checks before it is used.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SnapshotCheck {
    /// The header, the block indexes and the decoded inventory; every other byte is checked as
    /// it is read.
    Header,
    /// Also every stored byte, against the stored checksums.
    Stored,
}

/// The base rows a delta hides (section 6), or none for a base.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Tombstones {
    /// For a delta, the fingerprint of the base it belongs to.
    base: Option<u64>,
    /// Hidden packages and maps.
    packages: u64,
    maps: u64,
    /// Hidden base row ids, ascending.
    ids: Vec<u32>,
}

impl Tombstones {
    fn encode(&self) -> Result<Vec<u8>, CatalogError> {
        let mut out = Vec::with_capacity(29 + self.ids.len() * 4);
        match self.base {
            None => out.push(0),
            Some(base) => {
                out.push(1);
                put64(&mut out, base);
                put64(&mut out, self.packages);
                put64(&mut out, self.maps);
                put32(&mut out, self.ids.len())?;
                for id in &self.ids {
                    out.extend_from_slice(&id.to_le_bytes());
                }
            }
        }
        Ok(out)
    }

    fn decode(bytes: &[u8]) -> Result<Self, CatalogError> {
        let mut d = Decoder::new(bytes);
        let tombstones = if d.boolean()? {
            let base = Some(d.u64()?);
            let packages = d.u64()?;
            let maps = d.u64()?;
            let count = d.count(4)?;
            let mut ids: Vec<u32> = Vec::with_capacity(count);
            for _ in 0..count {
                let id = d.u32()?;
                if ids.last().is_some_and(|last| *last >= id) {
                    return Err(corrupt("tombstones must be strictly ordered"));
                }
                ids.push(id);
            }
            if maps > packages || packages > ids.len() as u64 {
                return Err(corrupt("invalid tombstone counts"));
            }
            Self {
                base,
                packages,
                maps,
                ids,
            }
        } else {
            Self::default()
        };
        d.finish()?;
        Ok(tombstones)
    }

    fn hides(&self, id: usize) -> bool {
        u32::try_from(id).is_ok_and(|id| self.ids.binary_search(&id).is_ok())
    }

    /// Hidden rows before row `id`.
    fn before(&self, id: usize) -> usize {
        self.ids.partition_point(|hidden| (*hidden as usize) < id)
    }
}

struct Snapshot {
    file: RefCell<File>,
    header: SnapshotHeader,
    /// The rows this snapshot hides in its base, when it is a delta.
    tombstones: Tombstones,
    /// Rows in the inventory, as its leading count says.
    row_count: usize,
    /// The row index, and the inventory decoded a chunk at a time as rows are asked for. A writer
    /// compares with the committed inventory and copies its kept rows as streams instead, so it
    /// never holds the inventory decoded.
    rows: OnceCell<Rows>,
    /// File ranges of each section's blocks. Blocks are read and decoded for each query, so a
    /// later query still detects changed or truncated bytes.
    blocks: [Vec<(u64, u64)>; SECTIONS],
    /// The shared strings and posting directory, decoded on first use.
    strings: OnceCell<Strings>,
    postings: OnceCell<Vec<Posting>>,
}

/// The decoded row index (section 5): for every `ROW_INDEX_INTERVAL`th row from row 0, its path
/// and inventory offset and the checksum of its chunk (the decoded inventory bytes from it to the
/// next checkpoint); then the ids of the map rows, ascending.
struct RowIndex {
    offsets: Vec<u64>,
    paths: StringTable,
    checksums: Vec<u32>,
    maps: Vec<u32>,
}

impl RowIndex {
    fn decode(
        bytes: &[u8],
        rows: usize,
        maps: u64,
        inventory_length: u64,
    ) -> Result<Self, CatalogError> {
        let mut d = Decoder::new(bytes);
        let count = d.count(20)?;
        if count != rows.div_ceil(ROW_INDEX_INTERVAL) {
            return Err(corrupt("row index does not match the inventory"));
        }
        let mut offsets: Vec<u64> = Vec::with_capacity(count);
        let mut paths = StringTable::with_capacity(bytes.len(), count);
        for checkpoint in 0..count {
            let row = d.u32()? as usize;
            let offset = d.u64()?;
            let path = d.str()?;
            if row != checkpoint * ROW_INDEX_INTERVAL
                || offset >= inventory_length
                || offsets.last().is_some_and(|last| *last >= offset)
                || (checkpoint > 0 && paths.get(checkpoint - 1) >= path)
            {
                return Err(corrupt("invalid row index"));
            }
            offsets.push(offset);
            paths.push(path)?;
        }
        let mut checksums = Vec::with_capacity(count);
        for _ in 0..count {
            checksums.push(d.u32()?);
        }
        let map_count = d.count(4)?;
        if map_count as u64 != maps {
            return Err(corrupt("row index maps do not match the snapshot header"));
        }
        let mut map_ids: Vec<u32> = Vec::with_capacity(map_count);
        for _ in 0..map_count {
            let id = d.u32()?;
            if id as usize >= rows || map_ids.last().is_some_and(|last| *last >= id) {
                return Err(corrupt("invalid row index maps"));
            }
            map_ids.push(id);
        }
        d.finish()?;
        Ok(Self {
            offsets,
            paths,
            checksums,
            maps: map_ids,
        })
    }

    /// The decoded inventory bytes of chunk `chunk`.
    fn span(&self, chunk: usize, inventory_length: u64) -> std::ops::Range<u64> {
        let end = self
            .offsets
            .get(chunk + 1)
            .copied()
            .unwrap_or(inventory_length);
        self.offsets[chunk]..end
    }
}

/// The rows of one chunk: each row's path and entry, by row id from the chunk's first.
struct Chunk {
    paths: StringTable,
    entries: Vec<InventoryEntry>,
}

/// A snapshot's inventory, decoded a chunk at a time as rows are asked for: its row index, each
/// chunk once decoded, and the package lookup that ignores case once built. A query reads only
/// the chunks its cursor, matches and their sidecars fall in.
struct Rows {
    index: RowIndex,
    chunks: Vec<OnceCell<Chunk>>,
    /// The inventory block the last single chunk was decoded from, which the next chunk usually
    /// shares.
    last_block: RefCell<LastBlock>,
    /// The encoded bytes of the chunk being decoded, reused from chunk to chunk.
    scratch: RefCell<Vec<u8>>,
    /// Chunks decoded now.
    decoded: std::cell::Cell<usize>,
    /// Package ids by the hash of their ASCII-folded path, then id (path order), built on the first
    /// lookup that ignores case. Lookups confirm the path, so a hash collision only costs a compare.
    folded_paths: OnceCell<Vec<(u64, u32)>>,
}

/// The first of `0..count` for which `before` fails, when it holds for a prefix of them.
fn first_failing(count: usize, before: impl Fn(usize) -> bool) -> usize {
    let (mut low, mut high) = (0, count);
    while low < high {
        let middle = low + (high - low) / 2;
        if before(middle) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

/// Whether `path` is in the run of paths that start with `stem.`.
fn shares_stem(path: &str, stem: &str) -> bool {
    path.len() > stem.len() && path.starts_with(stem) && path.as_bytes()[stem.len()] == b'.'
}

/// Chunk `chunk` of an inventory of `row_count` rows parsed from its decoded bytes, checked
/// against the row index: its checksum, its paths strictly ordered from its checkpoint's to before
/// the next checkpoint's, its map rows, and each record range inside `records_length`.
fn parse_chunk(
    index: &RowIndex,
    row_count: usize,
    records_length: u64,
    chunk: usize,
    bytes: &[u8],
) -> Result<Chunk, CatalogError> {
    if u64::from(crc32fast::hash(bytes)) != u64::from(index.checksums[chunk]) {
        return Err(corrupt("inventory chunk checksum mismatch"));
    }
    let first = chunk * ROW_INDEX_INTERVAL;
    let count = (row_count - first).min(ROW_INDEX_INTERVAL);
    // A decoded chunk may be kept, so its text is allocated at its exact length, found by a first
    // pass over the rows.
    let mut d = Decoder::new(bytes);
    let mut text_length = 0;
    for _ in 0..count {
        text_length += inventory_row(&mut d, records_length)?.0.len();
    }
    let mut paths = StringTable::with_capacity(text_length, count);
    let mut entries = Vec::with_capacity(count);
    let maps_from = index.maps.partition_point(|id| (*id as usize) < first);
    let mut maps = index.maps[maps_from..]
        .iter()
        .take_while(|id| (**id as usize) < first + count)
        .peekable();
    let mut d = Decoder::new(bytes);
    for row in 0..count {
        let (path, entry) = inventory_row(&mut d, records_length)?;
        let ordered = if row == 0 {
            path == index.paths.get(chunk)
        } else {
            paths.get(row - 1) < path
        };
        let is_listed_map = maps.next_if(|id| **id as usize == first + row).is_some();
        if !ordered || is_listed_map != entry.is_map {
            return Err(corrupt("the row index does not match the inventory"));
        }
        paths.push(path)?;
        entries.push(entry);
    }
    d.finish()?;
    if chunk + 1 < index.offsets.len() && paths.get(count - 1) >= index.paths.get(chunk + 1) {
        return Err(corrupt("the row index does not match the inventory"));
    }
    Ok(Chunk { paths, entries })
}

impl Snapshot {
    /// The row index and the chunk table, decoded on first use.
    fn rows(&self) -> Result<&Rows, CatalogError> {
        if let Some(rows) = self.rows.get() {
            return Ok(rows);
        }
        let index = RowIndex::decode(
            &self.section(ROW_INDEX)?,
            self.row_count,
            self.header.maps,
            self.header.sections[INVENTORY].length,
        )?;
        let chunks = (0..index.offsets.len()).map(|_| OnceCell::new()).collect();
        Ok(self.rows.get_or_init(|| Rows {
            index,
            chunks,
            last_block: RefCell::new(LastBlock::default()),
            scratch: RefCell::new(Vec::new()),
            decoded: std::cell::Cell::new(0),
            folded_paths: OnceCell::new(),
        }))
    }

    /// Chunk `chunk` parsed from its decoded bytes (see [`parse_chunk`]).
    fn parse_chunk(&self, rows: &Rows, chunk: usize, bytes: &[u8]) -> Result<Chunk, CatalogError> {
        parse_chunk(
            &rows.index,
            self.row_count,
            self.header.sections[RECORDS].length,
            chunk,
            bytes,
        )
    }

    /// Chunk `chunk`, decoded on first use.
    fn chunk(&self, chunk: usize) -> Result<&Chunk, CatalogError> {
        let rows = self.rows()?;
        let cell = rows
            .chunks
            .get(chunk)
            .ok_or_else(|| corrupt("invalid inventory id"))?;
        if let Some(decoded) = cell.get() {
            return Ok(decoded);
        }
        let span = rows
            .index
            .span(chunk, self.header.sections[INVENTORY].length);
        let mut bytes = rows.scratch.borrow_mut();
        self.range_reusing(
            &mut rows.last_block.borrow_mut(),
            INVENTORY,
            span.start,
            span.end - span.start,
            &mut bytes,
        )?;
        let decoded = self.parse_chunk(rows, chunk, &bytes)?;
        drop(bytes);
        rows.decoded.set(rows.decoded.get() + 1);
        Ok(cell.get_or_init(|| decoded))
    }

    /// Decodes the chunks of rows `ids` not decoded yet. Their blocks are read in runs of
    /// adjacent blocks; several threads then decode the runs and parse their chunks, so a page
    /// whose rows are spread over the inventory does not decode and parse them one at a time.
    fn load_chunks(&self, ids: impl IntoIterator<Item = usize>) -> Result<(), CatalogError> {
        let rows = self.rows()?;
        let mut wanted = ids
            .into_iter()
            .map(|id| id / ROW_INDEX_INTERVAL)
            .filter(|chunk| {
                rows.chunks
                    .get(*chunk)
                    .is_some_and(|cell| cell.get().is_none())
            })
            .collect::<Vec<_>>();
        wanted.sort_unstable();
        wanted.dedup();
        if wanted.len() < 4 {
            for chunk in wanted {
                self.chunk(chunk)?;
            }
            return Ok(());
        }
        let length = self.header.sections[INVENTORY].length;
        let ranges = &self.blocks[INVENTORY];
        // Runs of adjacent blocks, each with the chunks that lie in it. A run stops growing at
        // `LOAD_RUN_BLOCKS`, so the runs share out among threads; a block two runs need is
        // decoded by both.
        let mut runs: Vec<(std::ops::Range<usize>, Vec<usize>)> = Vec::new();
        for chunk in wanted {
            let span = rows.index.span(chunk, length);
            let blocks =
                (span.start / BLOCK_BYTES) as usize..span.end.div_ceil(BLOCK_BYTES) as usize;
            match runs.last_mut() {
                Some((run, chunks))
                    if blocks.start < run.end
                        || (blocks.start == run.end && run.len() < LOAD_RUN_BLOCKS) =>
                {
                    run.end = run.end.max(blocks.end);
                    chunks.push(chunk);
                }
                _ => runs.push((blocks, vec![chunk])),
            }
        }
        // The file is read on this thread; the threads share only the bytes read.
        let mut stored = Vec::with_capacity(runs.len());
        for (run, _) in &runs {
            let batch = ranges
                .get(run.clone())
                .ok_or_else(|| corrupt("binary range leaves its section"))?;
            let total = batch.iter().map(|range| range.1).sum();
            stored.push(read_range(&mut self.file.borrow_mut(), batch[0].0, total)?);
        }
        let (index, row_count) = (&rows.index, self.row_count);
        let records_length = self.header.sections[RECORDS].length;
        let threads = codec_threads(runs.len());
        let per_thread = runs.len().div_ceil(threads).max(1);
        let parsed = std::thread::scope(|scope| {
            let workers = runs
                .chunks(per_thread)
                .zip(stored.chunks(per_thread))
                .map(|(runs, stored)| {
                    scope.spawn(move || {
                        let mut decompressor = None;
                        let mut decoded = Vec::new();
                        let mut parsed = Vec::new();
                        for ((run, chunks), stored) in runs.iter().zip(stored) {
                            let base = run.start as u64 * BLOCK_BYTES;
                            let first = ranges[run.start].0;
                            decoded.clear();
                            decoded.resize(
                                run.clone()
                                    .map(|block| block_length(length, block))
                                    .sum::<u64>() as usize,
                                0,
                            );
                            for (block, out) in
                                run.clone().zip(decoded.chunks_mut(BLOCK_BYTES as usize))
                            {
                                let (start, size) = ranges[block];
                                let from = (start - first) as usize;
                                let source = stored
                                    .get(from..from + size as usize)
                                    .ok_or_else(|| corrupt("binary range leaves its section"))?;
                                decode_block_into(source, out, &mut decompressor)?;
                            }
                            for &chunk in chunks {
                                let span = index.span(chunk, length);
                                let bytes = decoded
                                    .get((span.start - base) as usize..(span.end - base) as usize)
                                    .ok_or_else(|| corrupt("binary range leaves its section"))?;
                                parsed.push((
                                    chunk,
                                    parse_chunk(index, row_count, records_length, chunk, bytes)?,
                                ));
                            }
                        }
                        Ok(parsed)
                    })
                })
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
                })
                .collect::<Result<Vec<Vec<(usize, Chunk)>>, CatalogError>>()
        })?;
        for (chunk, decoded) in parsed.into_iter().flatten() {
            if rows.chunks[chunk].set(decoded).is_ok() {
                rows.decoded.set(rows.decoded.get() + 1);
            }
        }
        Ok(())
    }

    /// Decodes every chunk not decoded yet, streaming the whole inventory as a refresh does and
    /// checking it whole: its checksum and its package and map counts.
    fn load_all_chunks(&self) -> Result<(), CatalogError> {
        let rows = self.rows()?;
        if rows.chunks.iter().all(|cell| cell.get().is_some()) {
            return Ok(());
        }
        with_section_prefetch(self, INVENTORY, |stream| {
            let mut stream = InventoryStream::over(stream);
            let mut id = 0;
            let mut paths = StringTable::default();
            let mut entries = Vec::new();
            while let Some((path, entry)) = stream.next(self)? {
                let chunk = id / ROW_INDEX_INTERVAL;
                let wanted = rows.chunks[chunk].get().is_none();
                if wanted {
                    let listed = rows.index.maps.binary_search(&(id as u32)).is_ok();
                    let ordered =
                        id % ROW_INDEX_INTERVAL != 0 || path == rows.index.paths.get(chunk);
                    if listed != entry.is_map || !ordered {
                        return Err(corrupt("the row index does not match the inventory"));
                    }
                    paths.push(path)?;
                    entries.push(entry);
                }
                id += 1;
                if wanted && (id % ROW_INDEX_INTERVAL == 0 || id == self.row_count) {
                    let mut chunk_paths = std::mem::take(&mut paths);
                    chunk_paths.text.shrink_to_fit();
                    let decoded = Chunk {
                        paths: chunk_paths,
                        entries: std::mem::take(&mut entries),
                    };
                    if rows.chunks[chunk].set(decoded).is_ok() {
                        rows.decoded.set(rows.decoded.get() + 1);
                    }
                }
            }
            stream.finish(self)
        })
    }

    /// Releases the decoded chunks once more than `retained` are decoded.
    fn release_chunks_over(&mut self, retained: usize) {
        if let Some(rows) = self.rows.get_mut()
            && rows.decoded.get() > retained
        {
            for chunk in &mut rows.chunks {
                chunk.take();
            }
            rows.decoded.set(0);
        }
    }

    /// Row `id`'s path and entry.
    fn row(&self, id: usize) -> Result<(&str, &InventoryEntry), CatalogError> {
        let chunk = self.chunk(id / ROW_INDEX_INTERVAL)?;
        let at = id % ROW_INDEX_INTERVAL;
        let entry = chunk
            .entries
            .get(at)
            .ok_or_else(|| corrupt("invalid inventory id"))?;
        Ok((chunk.paths.get(at), entry))
    }
    fn path(&self, id: usize) -> Result<&str, CatalogError> {
        Ok(self.row(id)?.0)
    }
    fn entry(&self, id: usize) -> Result<&InventoryEntry, CatalogError> {
        Ok(self.row(id)?.1)
    }
    /// Row `id`'s path when its chunk is decoded already.
    fn decoded_path(&self, id: usize) -> Option<&str> {
        let chunk = self
            .rows
            .get()?
            .chunks
            .get(id / ROW_INDEX_INTERVAL)?
            .get()?;
        let at = id % ROW_INDEX_INTERVAL;
        (at < chunk.entries.len()).then(|| chunk.paths.get(at))
    }
    fn signature(&self, id: usize) -> Result<PackageSignature, CatalogError> {
        let (path, entry) = self.row(id)?;
        Ok(PackageSignature {
            relative_path: path.to_owned(),
            kind: entry.kind,
            size: entry.size,
            modified_nanos: entry.modified_nanos,
        })
    }
    /// The first row in `range` whose path fails `before` (which holds for a prefix of the rows
    /// in path order): the checkpoints narrow it to one chunk, and only that chunk is decoded.
    fn partition_point(
        &self,
        range: std::ops::Range<usize>,
        before: impl Fn(&str) -> bool,
    ) -> Result<usize, CatalogError> {
        if range.is_empty() {
            return Ok(range.start);
        }
        let index = &self.rows()?.index;
        // The first chunk whose checkpoint fails `before`; the point is in the chunk before it.
        let next = first_failing(index.offsets.len(), |checkpoint| {
            before(index.paths.get(checkpoint))
        });
        let point = match next.checked_sub(1) {
            None => 0,
            Some(chunk) => {
                let rows = self.chunk(chunk)?;
                let within = first_failing(rows.entries.len(), |at| before(rows.paths.get(at)));
                chunk * ROW_INDEX_INTERVAL + within
            }
        };
        Ok(point.clamp(range.start, range.end))
    }
    /// The inventory id at exactly `path`.
    fn id_at(&self, path: &str) -> Result<Option<usize>, CatalogError> {
        let id = self.before(path)?;
        Ok((id < self.row_count && self.path(id)? == path).then_some(id))
    }
    /// The first inventory id whose path is at or after `path`.
    fn before(&self, path: &str) -> Result<usize, CatalogError> {
        self.partition_point(0..self.row_count, |other| other < path)
    }
    /// The first inventory id whose path is after `cursor`.
    fn after(&self, cursor: &str) -> Result<usize, CatalogError> {
        self.partition_point(0..self.row_count, |other| other <= cursor)
    }
    /// The first row in `range` whose path is at or after `stem` followed by `joint`.
    fn before_joined(
        &self,
        range: std::ops::Range<usize>,
        stem: &str,
        joint: u8,
    ) -> Result<usize, CatalogError> {
        self.partition_point(range, |path| path_before_joined(path, stem, joint))
    }
    /// The packages whose paths match `path` without regard to ASCII case, in path order.
    fn package_ids_ignoring_case(&self, path: &str) -> Result<Vec<usize>, CatalogError> {
        let rows = self.rows()?;
        let paths = match rows.folded_paths.get() {
            Some(paths) => paths,
            None => {
                self.load_all_chunks()?;
                let mut paths = Vec::new();
                for id in 0..self.row_count {
                    let (path, entry) = self.row(id)?;
                    if entry.kind == EntryKind::Package {
                        paths.push((
                            folded_hash(path),
                            u32::try_from(id).map_err(|_| corrupt("Catalog count exceeds u32"))?,
                        ));
                    }
                }
                paths.sort_unstable();
                rows.folded_paths.get_or_init(|| paths)
            }
        };
        let hash = folded_hash(path);
        let start = paths.partition_point(|(other, _)| *other < hash);
        let mut found = Vec::new();
        for (_, id) in paths[start..]
            .iter()
            .take_while(|(other, _)| *other == hash)
        {
            if self.path(*id as usize)?.eq_ignore_ascii_case(path) {
                found.push(*id as usize);
            }
        }
        Ok(found)
    }
    /// The bundle signature of the package at `id`: its own stamp, then each sidecar's. Sidecars
    /// share the package's stem, so they sit beside it in path order.
    fn bundle_signature(&self, id: usize) -> Result<String, CatalogError> {
        let (path, entry) = self.row(id)?;
        let stem = path.rsplit_once('.').map_or(path, |(stem, _)| stem);
        let mut parts = [Some((entry.size, entry.modified_nanos)), None, None, None];
        self.neighbour_parts(id, stem, None, &mut parts)?;
        Ok(bundle_signature(parts))
    }
    /// Records row `other`'s stamp in `parts` when it is one of `stem`'s sidecars.
    fn sidecar_part(
        &self,
        other: usize,
        stem: &str,
        parts: &mut [Option<(u64, u64)>; 4],
    ) -> Result<(), CatalogError> {
        let (path, entry) = self.row(other)?;
        let extension = &path[stem.len() + 1..];
        if let Some(slot) = super::inventory_digest::BUNDLE_SIDECARS
            .iter()
            .position(|sidecar| *sidecar == extension)
        {
            parts[slot + 1] = Some((entry.size, entry.modified_nanos));
        }
        Ok(())
    }
    /// Fills `parts` from the sidecars of `stem` beside row `id`, skipping `hidden` rows. They may
    /// sit in the chunks before and after `id`'s.
    fn neighbour_parts(
        &self,
        id: usize,
        stem: &str,
        hidden: Option<&Tombstones>,
        parts: &mut [Option<(u64, u64)>; 4],
    ) -> Result<(), CatalogError> {
        let live = |other: usize| hidden.is_none_or(|hidden| !hidden.hides(other));
        let mut before = id;
        while before > 0 && shares_stem(self.path(before - 1)?, stem) {
            before -= 1;
            if live(before) {
                self.sidecar_part(before, stem, parts)?;
            }
        }
        self.run_parts(id + 1, stem, hidden, parts)
    }
    /// Fills `parts` from the sidecars of `stem` in the run of rows from `start`, skipping
    /// `hidden` rows.
    fn run_parts(
        &self,
        start: usize,
        stem: &str,
        hidden: Option<&Tombstones>,
        parts: &mut [Option<(u64, u64)>; 4],
    ) -> Result<(), CatalogError> {
        let mut other = start;
        while other < self.row_count && shares_stem(self.path(other)?, stem) {
            if hidden.is_none_or(|hidden| !hidden.hides(other)) {
                self.sidecar_part(other, stem, parts)?;
            }
            other += 1;
        }
        Ok(())
    }
}

/// Each section's block file ranges.
type BlockRanges = [Vec<(u64, u64)>; SECTIONS];

/// Opens a snapshot's header and block indexes, checking every stored byte for `Stored`.
fn open_snapshot_file(
    path: &Path,
    check: SnapshotCheck,
) -> Result<(File, SnapshotHeader, BlockRanges), CatalogError> {
    let mut file = File::open(path).map_err(io_unavailable("open binary snapshot"))?;
    let length = file
        .metadata()
        .map_err(io_unavailable("stat binary snapshot"))?
        .len();
    let header = SnapshotHeader::decode(&read_range(&mut file, 0, HEADER_BYTES)?)?;
    if header.file_len()? != length {
        return Err(corrupt("snapshot length does not match its directory"));
    }
    if check == SnapshotCheck::Stored {
        verify_stored(path, &mut file, &header)?;
    }
    let starts = header.starts()?;
    let mut blocks: BlockRanges = Default::default();
    for (index, ranges) in blocks.iter_mut().enumerate() {
        let section = header.sections[index];
        *ranges = block_ranges(&mut file, starts[index], section.stored, section.length)?;
    }
    Ok((file, header, blocks))
}

/// A section's decoded bytes read front to back, a batch of blocks at a time, so a whole section
/// is never held decoded. It keeps no reference to its snapshot, so a writer can keep one between
/// calls. Values are parsed from each batch with a [`Decoder`].
#[derive(Default)]
struct SectionStream {
    next_block: usize,
    raw: Vec<u8>,
    at: usize,
    hash: crc32fast::Hasher,
    /// Batches a helper thread decodes ahead (see [`with_section_prefetch`]): each batch's end
    /// block and decoded bytes. Without it, batches are read and decoded on demand.
    prefetched: Option<Receiver<SectionBatch>>,
}

/// One decoded batch of a section's blocks: the block after it, its bytes, and their checksum.
type SectionBatch = Result<(usize, Vec<u8>, crc32fast::Hasher), CatalogError>;

/// Reads and decodes `section`'s blocks a batch at a time from `file`, sending each batch to
/// `batches`; stops at the first failure or once nothing receives the batches.
fn send_section_batches(
    mut file: File,
    ranges: &[(u64, u64)],
    length: u64,
    batches: &SyncSender<SectionBatch>,
) {
    let mut next = 0;
    while next < ranges.len() {
        let last = (next + SECTION_READ_BLOCKS).min(ranges.len());
        let batch = &ranges[next..last];
        let start = batch[0].0;
        let stored = batch.iter().map(|range| range.1).sum();
        let decoded = (next..last).map(|block| block_length(length, block)).sum();
        let result = read_range(&mut file, start, stored)
            .and_then(|blocks| decode_blocks_hashed(&blocks, start, batch, decoded))
            .map(|(bytes, hash)| (last, bytes, hash));
        let failed = result.is_err();
        if batches.send(result).is_err() || failed {
            return;
        }
        next = last;
    }
}

/// Runs `read` with a [`SectionStream`] over `section` whose batches a helper thread reads and
/// decodes a batch or two ahead, so a pass over a whole section parses one batch while the next
/// decodes. The helper reads through its own handle to the snapshot file, which `read` does not
/// use meanwhile.
fn with_section_prefetch<R>(
    snapshot: &Snapshot,
    section: usize,
    read: impl FnOnce(SectionStream) -> Result<R, CatalogError>,
) -> Result<R, CatalogError> {
    let file = snapshot
        .file
        .borrow()
        .try_clone()
        .map_err(io_unavailable("open binary snapshot"))?;
    let ranges = &snapshot.blocks[section];
    let length = snapshot.header.sections[section].length;
    std::thread::scope(|scope| {
        let (sender, receiver) = sync_channel(2);
        scope.spawn(move || send_section_batches(file, ranges, length, &sender));
        // `read` drops the stream, and with it the receiver, before the helper is joined.
        read(SectionStream {
            prefetched: Some(receiver),
            ..SectionStream::default()
        })
    })
}
impl SectionStream {
    /// A decoder over at least `wanted` decoded bytes of `section` (fewer only at its end); report
    /// what it read with [`SectionStream::consume`].
    fn decoder(
        &mut self,
        snapshot: &Snapshot,
        section: usize,
        wanted: usize,
    ) -> Result<Decoder<'_>, CatalogError> {
        let ranges = &snapshot.blocks[section];
        let length = snapshot.header.sections[section].length;
        while self.raw.len() < self.at.saturating_add(wanted) && self.next_block < ranges.len() {
            // Bytes consumed before they were decoded are skipped as they arrive.
            let drained = self.at.min(self.raw.len());
            self.raw.drain(..drained);
            self.at -= drained;
            let (last, decoded, hash) = match &self.prefetched {
                Some(batches) => batches
                    .recv()
                    .map_err(|_| corrupt("a section's blocks stopped decoding"))??,
                None => {
                    let last = (self.next_block + SECTION_READ_BLOCKS).min(ranges.len());
                    let batch = &ranges[self.next_block..last];
                    let start = batch[0].0;
                    let stored = batch.iter().map(|range| range.1).sum();
                    let blocks = read_range(&mut snapshot.file.borrow_mut(), start, stored)?;
                    let decoded = (self.next_block..last)
                        .map(|block| block_length(length, block))
                        .sum();
                    let (bytes, hash) = decode_blocks_hashed(&blocks, start, batch, decoded)?;
                    (last, bytes, hash)
                }
            };
            self.hash.combine(&hash);
            self.raw.extend_from_slice(&decoded);
            self.next_block = last;
        }
        let rest = self
            .raw
            .get(self.at..)
            .ok_or_else(|| corrupt("truncated binary section"))?;
        Ok(Decoder::new(rest))
    }
    /// Marks `count` more bytes read; they may be past what is decoded yet.
    fn consume(&mut self, count: usize) {
        self.at += count;
    }
    /// Checks that every decoded byte of `section` was read, and its checksum.
    fn finish(self, snapshot: &Snapshot, section: usize) -> Result<(), CatalogError> {
        if self.next_block != snapshot.blocks[section].len() || self.at != self.raw.len() {
            return Err(corrupt("trailing binary bytes"));
        }
        if u64::from(self.hash.finalize()) != snapshot.header.sections[section].hash {
            return Err(corrupt("binary section checksum mismatch"));
        }
        Ok(())
    }
}

/// The most bytes one inventory row can take besides its path.
const INVENTORY_ROW_FIXED_BYTES: usize = 65;
/// The fewest bytes one inventory row takes besides its path.
const INVENTORY_ROW_MIN_BYTES: usize = 44;

/// The committed inventory read one row at a time, checked as it is read: paths strictly
/// ordered, ranges inside the records, and at the end the section's checksum and counts.
struct InventoryStream {
    stream: SectionStream,
    /// Rows read so far, and the bytes of the last one, consumed when the next is read.
    read: usize,
    pending: usize,
    last_path: String,
    packages: u64,
    maps: u64,
}
impl InventoryStream {
    fn new() -> Self {
        Self::over(SectionStream::default())
    }
    fn over(stream: SectionStream) -> Self {
        Self {
            stream,
            read: 0,
            // The row count, which `Snapshot::open` read.
            pending: 4,
            last_path: String::new(),
            packages: 0,
            maps: 0,
        }
    }
    /// The next row's path and entry, or `None` after the last.
    fn next<'s>(
        &'s mut self,
        snapshot: &Snapshot,
    ) -> Result<Option<(&'s str, InventoryEntry)>, CatalogError> {
        if self.read == snapshot.row_count {
            self.stream.consume(std::mem::take(&mut self.pending));
            return Ok(None);
        }
        let pending = std::mem::take(&mut self.pending);
        self.stream.consume(pending);
        let path_len = self.stream.decoder(snapshot, INVENTORY, 4)?.u32()? as usize;
        let mut d = self.stream.decoder(
            snapshot,
            INVENTORY,
            4 + path_len + INVENTORY_ROW_FIXED_BYTES,
        )?;
        let (path, entry) = inventory_row(&mut d, snapshot.header.sections[RECORDS].length)?;
        if self.read > 0 && path <= self.last_path.as_str() {
            return Err(corrupt("inventory paths must be strictly ordered"));
        }
        self.pending = d.position;
        self.read += 1;
        self.packages += u64::from(entry.kind == EntryKind::Package);
        self.maps += u64::from(entry.is_map);
        self.last_path.clear();
        self.last_path.push_str(path);
        Ok(Some((path, entry)))
    }
    /// Checks the whole inventory was read: its checksum and its package and map counts.
    fn finish(mut self, snapshot: &Snapshot) -> Result<(), CatalogError> {
        if self.read != snapshot.row_count {
            return Err(corrupt("inventory ended before its rows"));
        }
        self.stream.consume(std::mem::take(&mut self.pending));
        // Reading past the last row decodes any blocks left, so trailing bytes are found.
        self.stream.decoder(snapshot, INVENTORY, usize::MAX)?;
        let (packages, maps) = (self.packages, self.maps);
        self.stream.finish(snapshot, INVENTORY)?;
        if packages != snapshot.header.packages || maps != snapshot.header.maps {
            return Err(corrupt("inventory counts do not match the snapshot header"));
        }
        Ok(())
    }
}

/// One inventory row: its path and entry; its record range must lie in `records_length`. Inlined
/// into the loops that decode a whole inventory, which run it for every row.
#[inline(always)]
fn inventory_row<'d>(
    d: &mut Decoder<'d>,
    records_length: u64,
) -> Result<(&'d str, InventoryEntry), CatalogError> {
    let relative_path = d.str()?;
    let kind = d.byte()?;
    if kind > 1 {
        return Err(corrupt("invalid entry kind"));
    }
    let kind = decode_kind(kind);
    let size = d.u64()?;
    let modified_nanos = d.u64()?;
    let profile = if d.boolean()? { Some(d.u32()?) } else { None };
    let failure = d.boolean()?;
    let offset = d.u64()?;
    let len = d.u32()?;
    let hash = d.u64()?;
    let header_data = if d.boolean()? {
        Some(d.header_data()?)
    } else {
        None
    };
    checked_range(offset, u64::from(len), records_length)?;
    Ok((
        relative_path,
        InventoryEntry {
            kind,
            size,
            modified_nanos,
            profile,
            failure,
            is_map: kind == EntryKind::Package && is_map_path(relative_path),
            offset,
            len,
            checksum: hash,
            header_data,
        },
    ))
}

/// Kept rows read from the committed inventory as they are copied, by ascending row id.
#[derive(Default)]
struct KeptRows {
    rows: Option<InventoryStream>,
    /// The row read last: its id, path and entry.
    current: Option<(usize, String, InventoryEntry)>,
}
impl KeptRows {
    /// Row `id`'s path and entry. Ids are asked in ascending order.
    fn row<'a>(
        &'a mut self,
        snapshot: &'a Snapshot,
        id: usize,
    ) -> Result<(&'a str, &'a InventoryEntry), CatalogError> {
        if self
            .current
            .as_ref()
            .is_none_or(|(current, ..)| *current != id)
        {
            let rows = self.rows.get_or_insert_with(InventoryStream::new);
            if rows.read > id {
                return Err(corrupt("kept rows were not copied in order"));
            }
            while rows.read < id {
                rows.next(snapshot)?;
            }
            let (path, entry) = rows
                .next(snapshot)?
                .ok_or_else(|| corrupt("unchanged record missing from prior snapshot"))?;
            let mut current_path = self
                .current
                .take()
                .map(|(_, path, _)| path)
                .unwrap_or_default();
            current_path.clear();
            current_path.push_str(path);
            self.current = Some((id, current_path, entry));
        }
        self.current
            .as_ref()
            .map(|(_, path, entry)| (path.as_str(), entry))
            .ok_or_else(|| corrupt("unchanged record missing from prior snapshot"))
    }
}

impl Snapshot {
    /// Opens a snapshot's header, block indexes and row count; the inventory is decoded on first
    /// use.
    fn open(path: &Path, check: SnapshotCheck) -> Result<Self, CatalogError> {
        let (file, header, blocks) = open_snapshot_file(path, check)?;
        let mut snapshot = Self {
            file: RefCell::new(file),
            header,
            tombstones: Tombstones::default(),
            row_count: 0,
            rows: OnceCell::new(),
            blocks,
            strings: OnceCell::new(),
            postings: OnceCell::new(),
        };
        let length = snapshot.header.sections[INVENTORY].length as usize;
        let count = SectionStream::default()
            .decoder(&snapshot, INVENTORY, 4)?
            .u32()? as usize;
        if count > length.saturating_sub(4) / INVENTORY_ROW_MIN_BYTES {
            return Err(corrupt("impossible binary count"));
        }
        snapshot.row_count = count;
        snapshot.tombstones = Tombstones::decode(&snapshot.section(TOMBSTONES)?)?;
        Ok(snapshot)
    }
    /// A fingerprint of this snapshot: the checksum of its header, which checksums every section.
    fn fingerprint(&self) -> u64 {
        checksum(&self.header.encode())
    }
    fn is_delta(&self) -> bool {
        self.tombstones.base.is_some()
    }
    /// A whole section, decoded and checked.
    fn section(&self, index: usize) -> Result<Vec<u8>, CatalogError> {
        let section = self.header.sections[index];
        let ranges = &self.blocks[index];
        let start = ranges.first().map_or(0, |range| range.0);
        let stored = ranges.iter().map(|range| range.1).sum();
        let blocks = read_range(&mut self.file.borrow_mut(), start, stored)?;
        let (bytes, hash) = decode_blocks_hashed(&blocks, start, ranges, section.length)?;
        if u64::from(hash.finalize()) != section.hash {
            return Err(corrupt("binary section checksum mismatch"));
        }
        Ok(bytes)
    }
    fn strings(&self) -> Result<&Strings, CatalogError> {
        if let Some(strings) = self.strings.get() {
            return Ok(strings);
        }
        let strings = Strings::decode(&self.section(STRINGS)?)?;
        if strings.table.len() as u64 != self.header.strings {
            return Err(corrupt("string count does not match the snapshot header"));
        }
        Ok(self.strings.get_or_init(|| strings))
    }
    fn postings(&self) -> Result<&[Posting], CatalogError> {
        if let Some(postings) = self.postings.get() {
            return Ok(postings);
        }
        let bytes = self.section(DIRECTORY)?;
        let mut d = Decoder::new(&bytes);
        let count = d.count(POSTING_ENTRY_BYTES)?;
        let entries = d.take(count * POSTING_ENTRY_BYTES)?;
        d.finish()?;
        // Entries have a fixed width, so threads decode and check parts of them in place; each
        // part's first key is checked against the previous part's last below.
        let mut postings = vec![Posting::default(); count];
        let per_part = count.div_ceil(codec_threads(count.div_ceil(16_384))).max(1);
        let (strings, rows, lists) = (
            self.header.strings,
            self.row_count,
            self.header.sections[LISTS].length,
        );
        std::thread::scope(|scope| {
            let workers = postings
                .chunks_mut(per_part)
                .zip(entries.chunks(per_part * POSTING_ENTRY_BYTES))
                .map(|(part, bytes)| {
                    scope.spawn(move || {
                        let mut d = Decoder::new(bytes);
                        for index in 0..part.len() {
                            let posting = Posting {
                                kind: d.byte()?,
                                value: d.u32()?,
                                offset: d.u64()?,
                                len: d.u32()?,
                                checksum: d.u64()?,
                            };
                            if posting.kind as usize >= POSTING_KINDS
                                || u64::from(posting.value) >= strings
                                || posting.len as usize > rows
                            {
                                return Err(corrupt("invalid posting metadata"));
                            }
                            if index > 0
                                && (part[index - 1].kind, part[index - 1].value)
                                    >= (posting.kind, posting.value)
                            {
                                return Err(corrupt("posting keys must be strictly ordered"));
                            }
                            checked_range(posting.offset, u64::from(posting.len) * 4, lists)?;
                            part[index] = posting;
                        }
                        Ok(())
                    })
                })
                .collect::<Vec<_>>();
            workers.into_iter().try_for_each(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
        })?;
        if postings
            .windows(2)
            .skip(per_part.saturating_sub(1))
            .step_by(per_part)
            .any(|pair| (pair[0].kind, pair[0].value) >= (pair[1].kind, pair[1].value))
        {
            return Err(corrupt("posting keys must be strictly ordered"));
        }
        Ok(self.postings.get_or_init(|| postings))
    }
    /// Decoded bytes `offset..offset + length` of a section. Callers check the record or posting
    /// checksums the range holds.
    #[cfg(test)]
    fn range(&self, index: usize, offset: u64, length: u64) -> Result<Vec<u8>, CatalogError> {
        let mut bytes = Vec::new();
        self.range_reusing(&mut LastBlock::default(), index, offset, length, &mut bytes)?;
        Ok(bytes)
    }
    /// A range read into `bytes` that reuses `last` when it holds the first block, then keeps the
    /// last block it decoded, so a call reading ascending ranges decodes each block once.
    fn range_reusing(
        &self,
        last: &mut LastBlock,
        index: usize,
        offset: u64,
        length: u64,
        bytes: &mut Vec<u8>,
    ) -> Result<(), CatalogError> {
        checked_range(offset, length, self.header.sections[index].length)?;
        bytes.clear();
        bytes.reserve(
            usize::try_from(length).map_err(|_| corrupt("range too large for address space"))?,
        );
        if length == 0 {
            return Ok(());
        }
        for block in offset / BLOCK_BYTES..=(offset + length - 1) / BLOCK_BYTES {
            if !matches!(&last.0, Some((i, b, _)) if *i == index && *b == block) {
                last.0 = Some((index, block, self.block(index, block)?));
            }
            let data = last
                .0
                .as_ref()
                .map_or(&[][..], |(_, _, data)| data.as_slice());
            let base = block * BLOCK_BYTES;
            let from = offset.max(base) - base;
            let to = (offset + length).min(base + data.len() as u64) - base;
            bytes.extend_from_slice(&data[from as usize..to as usize]);
        }
        Ok(())
    }
    fn block(&self, index: usize, block: u64) -> Result<Vec<u8>, CatalogError> {
        let position = usize::try_from(block).map_err(|_| corrupt("invalid block"))?;
        let range = *self.blocks[index]
            .get(position)
            .ok_or_else(|| corrupt("binary range leaves its section"))?;
        read_block(
            &mut self.file.borrow_mut(),
            range,
            block_length(self.header.sections[index].length, position),
        )
    }
    /// A record's bytes checked against its inventory row.
    fn check_record<'b>(
        &self,
        id: usize,
        bytes: &'b [u8],
    ) -> Result<Option<HeaderView<'b>>, CatalogError> {
        let entry = self.entry(id)?;
        if checksum(bytes) != entry.checksum {
            return Err(corrupt("record checksum mismatch"));
        }
        let header = decode_record(bytes, self.header.strings)?;
        if header.is_some() != entry.profile.is_some()
            || header.as_ref().is_some_and(|h| h.failure_code.is_some()) != entry.failure
            || header.as_ref().and_then(|h| h.header_data.as_ref()) != entry.header_data.as_ref()
        {
            return Err(corrupt("inventory/header mismatch"));
        }
        Ok(header)
    }
    /// Reads the records of `ids` (ascending) and hands each, checked, to `visit`.
    fn records(
        &self,
        ids: &[usize],
        mut visit: impl FnMut(usize, Option<HeaderView<'_>>) -> Result<(), CatalogError>,
    ) -> Result<(), CatalogError> {
        self.load_chunks(ids.iter().copied())?;
        // Page-local windows of nearby records: (first id, past the last id, byte range).
        let mut windows = Vec::new();
        let mut first = 0;
        while first < ids.len() {
            let entry = self.entry(ids[first])?;
            let start = entry.offset;
            let mut end = start + u64::from(entry.len);
            let mut last = first + 1;
            while last < ids.len() {
                let next = self.entry(ids[last])?;
                let next_end = next.offset + u64::from(next.len);
                if next.offset < end || next.offset - end > 4096 || next_end - start > 256 * 1024 {
                    break;
                }
                end = next_end;
                last += 1;
            }
            checked_range(start, end - start, self.header.sections[RECORDS].length)?;
            windows.push((first, last, start, end));
            first = last;
        }
        // A page's records are spread over many compressed blocks. Each batch of windows reads
        // its distinct blocks on this thread and decodes them on several, then visits the
        // windows in order. Nothing survives the query: later queries must still detect changed
        // or truncated bytes, and a batch bounds the decoded bytes held at once.
        let mut bytes = Vec::new();
        let mut next_window = 0;
        while next_window < windows.len() {
            let mut blocks = BTreeSet::new();
            let mut batch_end = next_window;
            while batch_end < windows.len() && blocks.len() < RECORD_BATCH_BLOCKS {
                let (_, _, start, end) = windows[batch_end];
                if end > start {
                    blocks.extend(start / BLOCK_BYTES..=(end - 1) / BLOCK_BYTES);
                }
                batch_end += 1;
            }
            let blocks = blocks.into_iter().collect::<Vec<_>>();
            let decoded = self.decode_section_blocks(RECORDS, &blocks)?;
            for &(first, last, start, end) in &windows[next_window..batch_end] {
                bytes.clear();
                if end > start {
                    for block in start / BLOCK_BYTES..=(end - 1) / BLOCK_BYTES {
                        let data = blocks
                            .binary_search(&block)
                            .ok()
                            .and_then(|position| decoded.get(position))
                            .ok_or_else(|| corrupt("binary range leaves its section"))?;
                        let base = block * BLOCK_BYTES;
                        let from = start.max(base) - base;
                        let to = end.min(base + data.len() as u64) - base;
                        bytes.extend_from_slice(
                            data.get(from as usize..to as usize)
                                .ok_or_else(|| corrupt("binary range leaves its section"))?,
                        );
                    }
                }
                if bytes.len() as u64 != end - start {
                    return Err(corrupt("binary range leaves its section"));
                }
                for &id in &ids[first..last] {
                    let entry = self.entry(id)?;
                    let offset = (entry.offset - start) as usize;
                    let record = &bytes[offset..offset + entry.len as usize];
                    visit(id, self.check_record(id, record)?)?;
                }
            }
            next_window = batch_end;
        }
        Ok(())
    }
    /// The decoded bytes of `blocks` (ascending) of section `index`. The stored bytes are read
    /// on this thread, adjacent blocks in one read; several threads decode them when there are
    /// enough.
    fn decode_section_blocks(
        &self,
        index: usize,
        blocks: &[u64],
    ) -> Result<Vec<Vec<u8>>, CatalogError> {
        let length = self.header.sections[index].length;
        let ranges = blocks
            .iter()
            .map(|&block| {
                let position = usize::try_from(block).map_err(|_| corrupt("invalid block"))?;
                let range = *self.blocks[index]
                    .get(position)
                    .ok_or_else(|| corrupt("binary range leaves its section"))?;
                let decoded = usize::try_from(block_length(length, position))
                    .map_err(|_| corrupt("block too large"))?;
                Ok((range, decoded))
            })
            .collect::<Result<Vec<_>, CatalogError>>()?;
        let mut runs = Vec::new();
        let mut first = 0;
        while first < ranges.len() {
            // Blocks stored back to back in the file are read together.
            let start = ranges[first].0.0;
            let mut end = start + ranges[first].0.1;
            let mut last = first + 1;
            while last < ranges.len() && ranges[last].0.0 == end {
                end += ranges[last].0.1;
                last += 1;
            }
            runs.push((
                start,
                last,
                read_range(&mut self.file.borrow_mut(), start, end - start)?,
            ));
            first = last;
        }
        let mut stored = Vec::with_capacity(ranges.len());
        let mut run = 0;
        for (position, &((offset, size), decoded)) in ranges.iter().enumerate() {
            while runs[run].1 <= position {
                run += 1;
            }
            let (start, _, bytes) = &runs[run];
            let from = (offset - start) as usize;
            let block = bytes
                .get(from..from + size as usize)
                .ok_or_else(|| corrupt("binary range leaves its section"))?;
            stored.push((block, decoded));
        }
        let decode = |part: &[(&[u8], usize)]| {
            let mut decompressor = None;
            part.iter()
                .map(|&(stored, decoded)| {
                    let mut out = vec![0; decoded];
                    decode_block_into(stored, &mut out, &mut decompressor)?;
                    Ok(out)
                })
                .collect::<Result<Vec<_>, CatalogError>>()
        };
        let threads = codec_threads(stored.len() * 4 / RECORD_BLOCKS_PER_THREAD);
        if threads == 1 {
            return decode(&stored);
        }
        let per_thread = stored.len().div_ceil(threads);
        std::thread::scope(|scope| {
            let workers = stored
                .chunks(per_thread)
                .map(|part| scope.spawn(move || decode(part)))
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
                })
                .collect::<Result<Vec<_>, CatalogError>>()
        })
        .map(|parts| parts.into_iter().flatten().collect())
    }
    fn expand_header(
        &self,
        id: usize,
        header: Option<HeaderView<'_>>,
    ) -> Result<Option<HeaderEvidence>, CatalogError> {
        let (Some(header), Some(profile_version)) = (header, self.entry(id)?.profile) else {
            return Ok(None);
        };
        let strings = &self.strings()?.table;
        Ok(Some(HeaderEvidence {
            header_data: header.header_data.clone(),
            profile_version,
            package_name: header.package_name.to_owned(),
            failure_code: header.failure_code.map(str::to_owned),
            classes: header
                .class_ids()
                .map(|id| strings.get(id as usize).to_owned())
                .collect(),
            serialized_names: header
                .name_ids()
                .map(|id| strings.get(id as usize).to_owned())
                .collect(),
            dependencies: header
                .dependency_ids()
                .map(|(id, properties)| {
                    PackageDependency::from_properties(
                        strings.get(id as usize).to_owned(),
                        properties,
                    )
                })
                .collect(),
        }))
    }
    fn headers(&self, ids: &[usize]) -> Result<Vec<Option<HeaderEvidence>>, CatalogError> {
        let mut headers = Vec::with_capacity(ids.len());
        self.records(ids, |id, header| {
            headers.push(self.expand_header(id, header)?);
            Ok(())
        })?;
        Ok(headers)
    }
    #[cfg(test)]
    fn packed(&self, id: usize) -> Result<Option<HeaderEvidence>, CatalogError> {
        let entry = self.entry(id)?;
        let bytes = self.range(RECORDS, entry.offset, u64::from(entry.len))?;
        let header = self.check_record(id, &bytes)?;
        self.expand_header(id, header)
    }
    fn string_id(&self, value: &str) -> Result<Option<u32>, CatalogError> {
        let strings = self.strings()?;
        Ok(strings
            .lexicon
            .binary_search_by(|id| lexicon_order(strings.table.get(*id as usize), value))
            .ok()
            .map(|index| strings.lexicon[index]))
    }
    /// Every stored spelling of `value` without regard to ASCII case: one lexicon range.
    fn string_ids_ignoring_case(&self, value: &str) -> Result<&[u32], CatalogError> {
        let strings = self.strings()?;
        let start = strings.lexicon.partition_point(|id| {
            folded_order(strings.table.get(*id as usize), value) == std::cmp::Ordering::Less
        });
        let spellings = strings.lexicon[start..]
            .iter()
            .take_while(|id| strings.table.get(**id as usize).eq_ignore_ascii_case(value))
            .count();
        Ok(&strings.lexicon[start..start + spellings])
    }
    fn posting_index(&self, kind: u8, value: u32) -> Result<Option<usize>, CatalogError> {
        Ok(self
            .postings()?
            .binary_search_by_key(&(kind, value), |p| (p.kind, p.value))
            .ok())
    }
    /// One checked posting list, as inventory ids in ascending order.
    fn posting_ids_reusing(
        &self,
        last: &mut LastBlock,
        index: usize,
    ) -> Result<Vec<usize>, CatalogError> {
        let posting = &self.postings()?[index];
        let mut bytes = Vec::new();
        self.range_reusing(
            last,
            LISTS,
            posting.offset,
            u64::from(posting.len) * 4,
            &mut bytes,
        )?;
        if checksum(&bytes) != posting.checksum {
            return Err(corrupt("posting checksum mismatch"));
        }
        let mut ids = Vec::with_capacity(posting.len as usize);
        for raw in bytes.as_chunks::<4>().0 {
            let id = u32::from_le_bytes(*raw) as usize;
            if id >= self.row_count || ids.last().is_some_and(|old| *old >= id) {
                return Err(corrupt("invalid posting row order"));
            }
            ids.push(id);
        }
        Ok(ids)
    }
    /// Packages whose dependency evidence names any of `package_names` in any ASCII case. Lists
    /// are read in stored order, so each posting block is decoded once.
    fn referrers(&self, package_names: &[String]) -> Result<Vec<usize>, CatalogError> {
        let postings = self.postings()?;
        let mut lists = Vec::new();
        for name in package_names {
            for value in self.string_ids_ignoring_case(name)? {
                if let Some(index) = self.posting_index(DEPENDENCY_POSTINGS, *value)? {
                    lists.push(index);
                }
            }
        }
        lists.sort_unstable_by_key(|index| (postings[*index].offset, *index));
        lists.dedup();
        let mut last = LastBlock::default();
        let mut ids = Vec::new();
        for index in lists {
            ids.extend(self.posting_ids_reusing(&mut last, index)?);
        }
        ids.sort_unstable();
        ids.dedup();
        Ok(ids)
    }
    /// Adds the indices of the postings a header filter (or every filter of a union) reads.
    fn select_postings(
        &self,
        kind: &QueryKind,
        selected: &mut BTreeSet<usize>,
    ) -> Result<(), CatalogError> {
        match kind {
            QueryKind::ExactClasses { values } | QueryKind::SerializedNames { values } => {
                let tag = u8::from(matches!(kind, QueryKind::SerializedNames { .. }));
                for value in values {
                    if let Some(id) = self.string_id(value)?
                        && let Some(index) = self.posting_index(tag, id)?
                    {
                        selected.insert(index);
                    }
                }
            }
            QueryKind::ClassPrefixes { values } | QueryKind::ClassNameSuffixes { values } => {
                let strings = &self.strings()?.table;
                let postings = self.postings()?;
                for (index, posting) in postings.iter().enumerate().take_while(|(_, p)| p.kind == 0)
                {
                    let text = strings.get(posting.value as usize);
                    if values.iter().any(|value| {
                        if matches!(kind, QueryKind::ClassPrefixes { .. }) {
                            text.starts_with(value.as_str())
                        } else {
                            class_name(text).ends_with(value.as_str())
                        }
                    }) {
                        selected.insert(index);
                    }
                }
            }
            QueryKind::Union { filters } => {
                for filter in filters {
                    self.select_postings(filter, selected)?;
                }
            }
            QueryKind::Maps | QueryKind::Inventory => {
                return Err(CatalogError::InvalidRequest {
                    message: "inventory and map queries do not match postings".into(),
                });
            }
            QueryKind::Dependencies { .. } | QueryKind::Dependents { .. } => {
                return Err(CatalogError::InvalidRequest {
                    message: "dependency queries walk the graph; they do not match postings".into(),
                });
            }
        }
        Ok(())
    }
    fn matches(
        &self,
        kind: &QueryKind,
        after: usize,
        limit: usize,
    ) -> Result<Vec<usize>, CatalogError> {
        if matches!(kind, QueryKind::Inventory) {
            // Rows are read from `after` until the page is full, a chunk at a time.
            let mut ids = Vec::new();
            let mut id = after;
            while id < self.row_count && ids.len() < limit {
                if self.entry(id)?.kind == EntryKind::Package {
                    ids.push(id);
                }
                id += 1;
            }
            return Ok(ids);
        }
        if matches!(kind, QueryKind::Maps) {
            // The row index lists the map rows: no inventory row is read to find them.
            let maps = &self.rows()?.index.maps;
            let from = maps.partition_point(|id| (*id as usize) < after);
            return Ok(maps[from..]
                .iter()
                .take(limit)
                .map(|id| *id as usize)
                .collect());
        }
        let postings = self.postings()?;
        let mut selected = BTreeSet::new();
        self.select_postings(kind, &mut selected)?;
        let mut ids = Vec::new();
        let mut bytes = Vec::new();
        let mut last = LastBlock::default();
        for index in selected {
            let posting = &postings[index];
            self.range_reusing(
                &mut last,
                LISTS,
                posting.offset,
                u64::from(posting.len) * 4,
                &mut bytes,
            )?;
            if checksum(&bytes) != posting.checksum {
                return Err(corrupt("posting checksum mismatch"));
            }
            let mut previous = None;
            let mut selected_count = 0;
            for raw in bytes.as_chunks::<4>().0 {
                let id = u32::from_le_bytes(*raw) as usize;
                if id >= self.row_count || previous.is_some_and(|old| old >= id) {
                    return Err(corrupt("invalid posting row order"));
                }
                previous = Some(id);
                if id >= after && selected_count < limit {
                    ids.push(id);
                    selected_count += 1;
                }
            }
            // Postings are ordered. Only their first `limit` eligible IDs can contribute to
            // this page, but validate every row above even after that prefix is collected.
            // A bounded flat union avoids allocating a tree node for every matching row.
            ids.sort_unstable();
            ids.dedup();
            ids.truncate(limit);
        }
        Ok(ids)
    }
}

/// What an inventory row keeps of a staged record besides its signature.
#[derive(Default)]
struct RecordMeta {
    profile: Option<u32>,
    failure: bool,
    header_data: Option<PackageHeaderData>,
}
impl RecordMeta {
    #[allow(dead_code)]
    fn of(header: &HeaderEvidence) -> Self {
        Self {
            profile: Some(header.profile_version),
            failure: header.failure_code.is_some(),
            header_data: header.header_data.clone(),
        }
    }
}

/// A changed entry staged for the next generation; its record is in `Staging::records`.
struct StagedRecord {
    signature: PackageSignature,
    meta: RecordMeta,
    offset: usize,
    len: usize,
}
/// Whether a commit writes a new base or a delta over the committed base.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriteMode {
    Full,
    Delta,
}

struct Staging {
    generation: Generation,
    /// Committed handles observed unchanged.
    kept: Vec<u32>,
    /// Set when the refresh carries every committed entry except these handles.
    except: Option<Vec<u32>>,
    /// Set when a path observed unchanged is not in the committed inventory.
    missing_unchanged: bool,
    changed: Vec<StagedRecord>,
    /// Encoded records of `changed`, back to back.
    records: Vec<u8>,
    /// Strings of the snapshot being written, with the strings of its prior first (the base's for
    /// a base, the delta's for a delta); loaded when the first header is staged.
    dictionary: Option<Dictionary>,
    /// Each preparer worker's strings' shared ids, by the worker's own ids.
    remaps: Vec<Vec<u32>>,
    /// The record being staged, with shared string ids.
    record: Vec<u8>,
    /// Entries staged so far.
    staged: u64,
    /// What the next generation carries; settled when staging starts in path order, or at commit.
    carry: Option<Carry>,
    mode: WriteMode,
    /// For a base absorbing a delta: the base's id for each of the delta's strings.
    delta_remap: Option<Vec<u32>>,
    /// Set once entries arrive in path order: the next generation, written as they arrive.
    ordered: Option<OrderedRows>,
}

/// The next generation written in path order as entries are staged, with the carried rows copied
/// in between; started at the first staged entry.
struct OrderedRows {
    cursor: KeptCursor,
    builder: Option<SnapshotBuilder>,
}

/// The snapshot whose strings and records a write in `mode` extends: the base for a base, the
/// delta (if any) for a delta.
fn mode_prior(mode: WriteMode, committed: Option<&Committed>) -> Option<&Snapshot> {
    match mode {
        WriteMode::Full => committed.map(|committed| &committed.base),
        WriteMode::Delta => committed.and_then(|committed| committed.delta.as_ref()),
    }
}

/// The strings of the snapshot being written, loaded when first needed: its prior's, and for a
/// base absorbing a delta, the delta's too (giving `delta_remap`).
fn shared_dictionary<'d>(
    dictionary: &'d mut Option<Dictionary>,
    delta_remap: &mut Option<Vec<u32>>,
    mode: WriteMode,
    committed: Option<&Committed>,
) -> Result<&'d mut Dictionary, CatalogError> {
    if dictionary.is_none() {
        let prior = mode_prior(mode, committed);
        let strings = prior.map(Snapshot::strings).transpose()?;
        let mut shared = Dictionary::new(strings)?;
        if mode == WriteMode::Full
            && let Some(delta) = committed.and_then(|committed| committed.delta.as_ref())
        {
            let table = &delta.strings()?.table;
            let mut remap = Vec::with_capacity(table.len());
            for id in 0..table.len() {
                remap.push(shared.intern(table.get(id))?);
            }
            *delta_remap = Some(remap);
        }
        *dictionary = Some(shared);
    }
    dictionary
        .as_mut()
        .ok_or_else(|| corrupt("header staged without a dictionary"))
}

impl Staging {
    /// Settles what the next generation carries, from the observations so far.
    fn settle_carry(&mut self) -> &Carry {
        if self.carry.is_none() {
            let carry = match self.except.take() {
                Some(except) => Carry::AllExcept(except),
                None => {
                    let mut kept = std::mem::take(&mut self.kept);
                    // Observations arrive in ordered runs. Sort once; dedup keeps set semantics
                    // for repeated observations.
                    kept.sort_unstable();
                    kept.dedup();
                    Carry::Kept(kept)
                }
            };
            self.carry = Some(carry);
        }
        self.carry.get_or_insert(Carry::Kept(Vec::new()))
    }

    /// The source a writer copies carried rows from.
    fn kept_source<'a>(
        carry: &'a Carry,
        mode: WriteMode,
        delta_remap: Option<&'a [u32]>,
        dictionary: Option<&Dictionary>,
        committed: Option<&'a Committed>,
    ) -> KeptSource<'a> {
        KeptSource {
            committed,
            carry,
            mode,
            delta_remap,
            strings: string_count(dictionary, mode_prior(mode, committed)),
        }
    }

    /// Stages `self.record` for `signature`: written at once in path order, else kept for the
    /// commit to sort.
    fn stage_record(
        &mut self,
        committed: Option<&Committed>,
        signature: &PackageSignature,
        meta: RecordMeta,
    ) -> Result<(), CatalogError> {
        self.staged += 1;
        let strings = string_count(self.dictionary.as_ref(), mode_prior(self.mode, committed));
        match &mut self.ordered {
            Some(ordered) => {
                if self.mode == WriteMode::Full
                    && self.delta_remap.is_none()
                    && committed.is_some_and(|committed| committed.delta.is_some())
                {
                    shared_dictionary(
                        &mut self.dictionary,
                        &mut self.delta_remap,
                        self.mode,
                        committed,
                    )?;
                }
                let carry = self
                    .carry
                    .as_ref()
                    .ok_or_else(|| corrupt("staging in path order without a settled carry"))?;
                let source = Self::kept_source(
                    carry,
                    self.mode,
                    self.delta_remap.as_deref(),
                    self.dictionary.as_ref(),
                    committed,
                );
                let builder = ordered
                    .builder
                    .get_or_insert_with(|| SnapshotBuilder::new(self.mode));
                builder.copy_kept(&source, &mut ordered.cursor, Some(&signature.relative_path))?;
                builder.push_staged(signature, &meta, &self.record, strings)
            }
            None => {
                let offset = self.records.len();
                self.records.extend_from_slice(&self.record);
                self.changed.push(StagedRecord {
                    signature: signature.clone(),
                    meta,
                    offset,
                    len: self.record.len(),
                });
                Ok(())
            }
        }
    }
}

/// Strings the next generation holds so far: the committed ones and those staging added.
fn string_count(dictionary: Option<&Dictionary>, prior: Option<&Snapshot>) -> u64 {
    dictionary.map_or_else(|| prior.map_or(0, |p| p.header.strings), |d| d.len() as u64)
}

/// One written row's record length, and whether the row is a package (only packages post).
struct RowShape {
    len: u32,
    package: bool,
}

/// Writes the next generation's rows in path order: inventory rows and records are compressed a
/// batch at a time as they arrive, and postings, strings and the directory are derived when it
/// finishes, so neither the inventory nor the records are ever held whole.
struct SnapshotBuilder {
    /// The row count, then the rows; the count is patched in when the builder finishes.
    inventory: SectionWriter,
    payload: SectionWriter,
    rows: Vec<RowShape>,
    packages: u64,
    maps: u64,
    last_path: String,
    /// One inventory row being encoded.
    row: Vec<u8>,
    /// The block last read from the base's records, and from the delta's.
    last_block: LastBlock,
    delta_last_block: LastBlock,
    kept_record: Vec<u8>,
    /// Rows posted under each (kind, string) key so far, and the last row each key counted.
    counts: [Vec<u32>; POSTING_KINDS],
    last_rows: [Vec<u32>; POSTING_KINDS],
    /// The row index's checkpoints so far (section 5, without its count).
    row_index: Vec<u8>,
    /// The checksum of each finished chunk, and of the chunk being written.
    chunk_checksums: Vec<u32>,
    chunk_hash: crc32fast::Hasher,
    /// The map rows so far.
    map_rows: Vec<u32>,
    /// Sums inventory leaves as rows arrive, for a base.
    walker: Option<BundleWalker>,
    /// Every row written, for a delta, so its commit can update the inventory sum.
    recorded: Option<Vec<RecordedRow>>,
}

/// A row a delta writer wrote, kept for the inventory sum: whether the refresh staged it (rather
/// than copying it from the previous delta).
struct RecordedRow {
    path: String,
    kind: EntryKind,
    size: u64,
    modified_nanos: u64,
    header_data: Option<PackageHeaderData>,
    staged: bool,
}

impl SnapshotBuilder {
    /// A writer for a base (which sums its inventory leaves) or a delta (which records its rows).
    fn new(mode: WriteMode) -> Self {
        let mut inventory = SectionWriter::with_patchable_head();
        // A Vec push cannot fail for four bytes, and the count is patched at the end.
        let _ = inventory.push(&0_u32.to_le_bytes());
        Self {
            inventory,
            payload: SectionWriter::new(),
            rows: Vec::new(),
            packages: 0,
            maps: 0,
            last_path: String::new(),
            row: Vec::new(),
            last_block: LastBlock::default(),
            delta_last_block: LastBlock::default(),
            kept_record: Vec::new(),
            counts: Default::default(),
            last_rows: Default::default(),
            row_index: Vec::new(),
            chunk_checksums: Vec::new(),
            chunk_hash: crc32fast::Hasher::new(),
            map_rows: Vec::new(),
            walker: (mode == WriteMode::Full).then(BundleWalker::default),
            recorded: (mode == WriteMode::Delta).then(Vec::new),
        }
    }

    /// Counts the posting keys a package record names, checking its string ids against the
    /// `strings` the next generation holds so far. A key counts a row once.
    fn count_postings(&mut self, record: &[u8], strings: u64) -> Result<(), CatalogError> {
        let Some(header) = decode_record(record, strings)? else {
            return Ok(());
        };
        let row =
            u32::try_from(self.rows.len()).map_err(|_| corrupt("Catalog count exceeds u32"))?;
        let strings = usize::try_from(strings).map_err(|_| corrupt("too many strings"))?;
        for (counts, last_rows) in self.counts.iter_mut().zip(&mut self.last_rows) {
            if counts.len() < strings {
                counts.resize(strings, 0);
                last_rows.resize(strings, u32::MAX);
            }
        }
        let (counts, last_rows) = (&mut self.counts, &mut self.last_rows);
        let mut post = |kind: u8, value: u32| {
            let (kind, value) = (kind as usize, value as usize);
            if last_rows[kind][value] != row {
                last_rows[kind][value] = row;
                counts[kind][value] += 1;
            }
        };
        header
            .class_ids()
            .for_each(|value| post(CLASS_POSTINGS, value));
        header
            .name_ids()
            .for_each(|value| post(NAME_POSTINGS, value));
        header
            .dependency_ids()
            .for_each(|(value, _)| post(DEPENDENCY_POSTINGS, value));
        Ok(())
    }

    /// Appends one row, whose record names at most `strings` strings. Rows arrive in strictly
    /// increasing path order.
    fn push_row(
        &mut self,
        path: &str,
        mut entry: InventoryEntry,
        record: &[u8],
        strings: u64,
        staged: bool,
    ) -> Result<(), CatalogError> {
        if !self.rows.is_empty() && path <= self.last_path.as_str() {
            return Err(CatalogError::InvalidRequest {
                message: format!("Catalog entries were staged out of path order at {path}"),
            });
        }
        if entry.kind == EntryKind::Package {
            self.count_postings(record, strings)?;
        }
        if self.rows.len().is_multiple_of(ROW_INDEX_INTERVAL) {
            if !self.rows.is_empty() {
                let hash = std::mem::take(&mut self.chunk_hash);
                self.chunk_checksums.push(hash.finalize());
            }
            put32(&mut self.row_index, self.rows.len())?;
            put64(&mut self.row_index, self.inventory.len());
            put_string(&mut self.row_index, path)?;
        }
        if entry.is_map {
            self.map_rows.push(
                u32::try_from(self.rows.len()).map_err(|_| corrupt("Catalog count exceeds u32"))?,
            );
        }
        let package = entry.kind == EntryKind::Package;
        let stamp = (entry.size, entry.modified_nanos);
        if let Some(walker) = &mut self.walker {
            walker.push(path, package, stamp, entry.header_data.as_ref());
        }
        if let Some(recorded) = &mut self.recorded {
            recorded.push(RecordedRow {
                path: path.to_owned(),
                kind: entry.kind,
                size: entry.size,
                modified_nanos: entry.modified_nanos,
                header_data: entry.header_data.clone(),
                staged,
            });
        }
        entry.offset = self.payload.len();
        entry.len =
            u32::try_from(record.len()).map_err(|_| corrupt("Catalog record exceeds u32"))?;
        self.payload.push(record)?;
        self.row.clear();
        encode_inventory_entry(&mut self.row, path, &entry)?;
        self.chunk_hash.update(&self.row);
        self.inventory.push(&self.row)?;
        self.rows.push(RowShape {
            len: entry.len,
            package: entry.kind == EntryKind::Package,
        });
        self.packages += u64::from(entry.kind == EntryKind::Package);
        self.maps += u64::from(entry.is_map);
        self.last_path.clear();
        self.last_path.push_str(path);
        Ok(())
    }

    fn push_staged(
        &mut self,
        signature: &PackageSignature,
        meta: &RecordMeta,
        record: &[u8],
        strings: u64,
    ) -> Result<(), CatalogError> {
        let path = signature.relative_path.as_str();
        let entry = InventoryEntry {
            kind: signature.kind,
            size: signature.size,
            modified_nanos: signature.modified_nanos,
            profile: meta.profile,
            failure: meta.failure,
            is_map: signature.kind == EntryKind::Package && is_map_path(path),
            offset: 0,
            len: 0,
            checksum: checksum(record),
            header_data: meta.header_data.clone(),
        };
        self.push_row(path, entry, record, strings, true)
    }

    /// Copies the carried committed rows whose paths come before `until` (every one for `None`),
    /// in path order: live base rows (for a base) and delta rows. A carried row at `until` itself
    /// is replaced by the entry staged there, and skipped.
    fn copy_kept(
        &mut self,
        source: &KeptSource<'_>,
        cursor: &mut KeptCursor,
        until: Option<&str>,
    ) -> Result<(), CatalogError> {
        let Some(committed) = source.committed else {
            return if source.carry.carries_nothing() {
                Ok(())
            } else {
                Err(corrupt("unchanged record missing from prior snapshot"))
            };
        };
        loop {
            if source.mode == WriteMode::Full {
                cursor.fill_base(committed, source.carry)?;
            }
            let delta = cursor.peek_delta(committed, source.carry)?;
            let delta_rows = match (&committed.delta, delta) {
                (Some(snapshot), Some(_)) => Some(snapshot),
                _ => None,
            };
            let from_delta = match (&cursor.base_peek, delta, delta_rows) {
                (None, None, _) => return Ok(()),
                (Some(_), None, _) => false,
                (None, Some(_), _) => true,
                (Some((_, base_path, _)), Some(id), Some(rows)) => {
                    rows.path(id)? < base_path.as_str()
                }
                (Some(_), Some(_), None) => false,
            };
            let mut record = std::mem::take(&mut self.kept_record);
            let copied = if from_delta {
                let (Some(snapshot), Some(id)) = (delta_rows, delta) else {
                    return Err(corrupt("unchanged record missing from prior snapshot"));
                };
                let (path, entry) = snapshot.row(id)?;
                if let Some(until) = until
                    && path >= until
                {
                    if path == until {
                        cursor.next_delta += 1;
                    }
                    self.kept_record = record;
                    return Ok(());
                }
                cursor.next_delta += 1;
                snapshot.range_reusing(
                    &mut self.delta_last_block,
                    RECORDS,
                    entry.offset,
                    u64::from(entry.len),
                    &mut record,
                )?;
                if checksum(&record) != entry.checksum {
                    return Err(corrupt("record checksum mismatch"));
                }
                if let Some(remap) = source.delta_remap
                    && let Some(ids_at) = record_ids_at(&record)?
                {
                    remap_record_ids(&mut record, ids_at, remap)?;
                }
                let mut entry = entry.clone();
                entry.checksum = checksum(&record);
                self.push_row(path, entry, &record, source.strings, false)
            } else {
                let Some((id, path, entry)) = cursor.base_peek.take() else {
                    return Err(corrupt("unchanged record missing from prior snapshot"));
                };
                if let Some(until) = until
                    && path.as_str() >= until
                {
                    if path != until {
                        cursor.base_peek = Some((id, path, entry));
                    }
                    self.kept_record = record;
                    return Ok(());
                }
                committed.base.range_reusing(
                    &mut self.last_block,
                    RECORDS,
                    entry.offset,
                    u64::from(entry.len),
                    &mut record,
                )?;
                if checksum(&record) != entry.checksum {
                    return Err(corrupt("record checksum mismatch"));
                }
                self.push_row(&path, entry, &record, source.strings, false)
            };
            self.kept_record = record;
            copied?;
        }
    }

    /// The inventory leaves summed so far (a base writer only).
    fn take_inventory_sum(&mut self) -> Option<InventorySum> {
        self.walker.take().map(BundleWalker::finish)
    }

    /// The rows written so far (a delta writer only).
    fn take_recorded(&mut self) -> Vec<RecordedRow> {
        self.recorded.take().unwrap_or_default()
    }

    /// Writes the snapshot to `file`: a placeholder header, then the sections in order, the
    /// posting lists streamed as they are compressed; then the header over its placeholder.
    /// Returns the row count and the header written.
    fn finish(
        self,
        mut file: File,
        dictionary: Option<Dictionary>,
        prior: Option<&Snapshot>,
        tombstones: &Tombstones,
    ) -> Result<(usize, SnapshotHeader), CatalogError> {
        let Self {
            mut inventory,
            payload,
            rows,
            packages,
            maps,
            counts,
            row_index,
            mut chunk_checksums,
            chunk_hash,
            map_rows,
            ..
        } = self;
        if !rows.is_empty() {
            chunk_checksums.push(chunk_hash.finalize());
        }
        let string_count = string_count(dictionary.as_ref(), prior);
        let row_count =
            u32::try_from(rows.len()).map_err(|_| corrupt("Catalog count exceeds u32"))?;
        inventory.patch_head(0, &row_count.to_le_bytes())?;
        let inventory = inventory.finish()?;
        let payload = payload.finish()?;
        // The posting lists are placed on one thread while the strings section is encoded.
        let (postings, strings) = std::thread::scope(|scope| {
            let postings = scope.spawn(|| Postings::build(&payload, &rows, string_count, counts));
            let strings = match (&dictionary, prior) {
                (Some(dictionary), _) => dictionary.encode().and_then(|raw| encode_section(&raw)),
                // No string was added: the committed section is copied as stored.
                (None, Some(prior)) => prior.stored_section(STRINGS),
                (None, None) => encode_section(&0_u32.to_le_bytes()),
            };
            let postings = postings
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
            (postings, strings)
        });
        let (postings, strings) = (postings?, strings?);
        drop(rows);
        drop(dictionary);
        let directory = encode_section(&postings.directory()?)?;
        let mut index =
            Vec::with_capacity(8 + row_index.len() + 4 * (chunk_checksums.len() + map_rows.len()));
        put32(
            &mut index,
            (row_count as usize).div_ceil(ROW_INDEX_INTERVAL),
        )?;
        index.extend_from_slice(&row_index);
        drop(row_index);
        for hash in chunk_checksums {
            index.extend_from_slice(&hash.to_le_bytes());
        }
        put32(&mut index, map_rows.len())?;
        for id in map_rows {
            index.extend_from_slice(&id.to_le_bytes());
        }
        let index = encode_section(&index)?;
        let hidden = encode_section(&tombstones.encode()?)?;
        publication_checkpoint("snapshot_created")?;
        file.write_all(&[0; HEADER_BYTES as usize])
            .map_err(io_unavailable("write binary directory"))?;
        publication_checkpoint("snapshot_partial")?;
        for section in [&inventory, &strings, &directory] {
            section.write(&mut file)?;
        }
        let lists = write_u32_section(&mut file, &postings.rows)?;
        drop(postings);
        for section in [&payload, &index, &hidden] {
            section.write(&mut file)?;
        }
        let header = SnapshotHeader {
            sections: [
                inventory.header,
                strings.header,
                directory.header,
                lists,
                payload.header,
                index.header,
                hidden.header,
            ],
            packages,
            maps,
            strings: string_count,
        };
        file.seek(SeekFrom::Start(0))
            .map_err(io_unavailable("seek binary snapshot"))?;
        file.write_all(&header.encode())
            .map_err(io_unavailable("write binary directory"))?;
        publication_checkpoint("before_sync")?;
        file.sync_all()
            .map_err(io_unavailable("sync binary snapshot"))?;
        publication_checkpoint("after_sync")?;
        Ok((row_count as usize, header))
    }
}

/// Where a record's string ids start (its class count), or `None` for a record without a header.
fn record_ids_at(record: &[u8]) -> Result<Option<usize>, CatalogError> {
    let mut d = Decoder::new(record);
    if !d.boolean()? {
        return Ok(None);
    }
    d.str()?;
    if d.boolean()? {
        d.header_data()?;
    }
    if d.boolean()? {
        d.str()?;
    }
    Ok(Some(d.position))
}

/// Which committed entries the next generation carries, by handle: a base row's id, or the
/// base's row count plus a delta row's id.
#[derive(Debug)]
enum Carry {
    /// The entries observed unchanged.
    Kept(Vec<u32>),
    /// Every committed entry except these.
    AllExcept(Vec<u32>),
}

impl Carry {
    fn keeps(&self, handle: u32) -> bool {
        match self {
            Self::Kept(handles) => handles.binary_search(&handle).is_ok(),
            Self::AllExcept(handles) => handles.binary_search(&handle).is_err(),
        }
    }

    fn carries_nothing(&self) -> bool {
        matches!(self, Self::Kept(handles) if handles.is_empty())
    }

    /// How many carried handles fall in `range`, of `live` live entries there.
    fn count_in(&self, range: std::ops::Range<u32>, live: usize) -> usize {
        let within = |handles: &[u32]| {
            handles.partition_point(|handle| *handle < range.end)
                - handles.partition_point(|handle| *handle < range.start)
        };
        match self {
            Self::Kept(handles) => within(handles),
            Self::AllExcept(handles) => live.saturating_sub(within(handles)),
        }
    }
}

/// What a writer copies carried rows from.
struct KeptSource<'a> {
    committed: Option<&'a Committed>,
    carry: &'a Carry,
    mode: WriteMode,
    /// The next base's string id for each delta string id, when a base absorbs the delta.
    delta_remap: Option<&'a [u32]>,
    /// Strings the copied records may name.
    strings: u64,
}

/// How far a writer has copied carried rows: the base rows read so far and the next one carried,
/// and the next delta row.
#[derive(Default)]
struct KeptCursor {
    base_rows: KeptRows,
    next_base: usize,
    base_peek: Option<(usize, String, InventoryEntry)>,
    next_delta: usize,
}

impl KeptCursor {
    /// Reads the next carried live base row into `base_peek`, unless it holds one.
    fn fill_base(&mut self, committed: &Committed, carry: &Carry) -> Result<(), CatalogError> {
        if self.base_peek.is_some() {
            return Ok(());
        }
        let hidden = committed.hidden();
        while self.next_base < committed.base.row_count {
            let id = self.next_base;
            self.next_base += 1;
            if hidden.hides(id) || !carry.keeps(id as u32) {
                continue;
            }
            let (path, entry) = self.base_rows.row(&committed.base, id)?;
            self.base_peek = Some((id, path.to_owned(), entry.clone()));
            return Ok(());
        }
        Ok(())
    }

    /// The next carried delta row's id, if any.
    fn peek_delta(
        &mut self,
        committed: &Committed,
        carry: &Carry,
    ) -> Result<Option<usize>, CatalogError> {
        let Some(delta) = &committed.delta else {
            return Ok(None);
        };
        let offset = committed.base.row_count;
        while self.next_delta < delta.row_count {
            let handle = u32::try_from(offset + self.next_delta)
                .map_err(|_| corrupt("Catalog count exceeds u32"))?;
            if carry.keeps(handle) {
                return Ok(Some(self.next_delta));
            }
            self.next_delta += 1;
        }
        Ok(None)
    }
}

/// The posting lists of the records written: under each (kind, string) key, in key order, the
/// ascending rows whose package record names it. `rows[starts[key]..starts[key + 1]]` is a key's
/// list, so the lists are one flat array, as the lists section stores them.
struct Postings {
    starts: Vec<u32>,
    rows: Vec<u32>,
    strings: usize,
}

/// Rows below which postings are placed on one thread: spawning costs more than it saves.
const PARALLEL_POSTING_ROWS: usize = 4096;
/// Posting entries below which postings are placed on one thread.
const PARALLEL_POSTING_ENTRIES: u32 = 16_384;
/// Decoded record bytes one parallel placement pass holds. A record names at most one key per
/// four bytes, so a pass holds at most twice this in (key, row) pairs.
const POSTING_BATCH_BYTES: usize = 16 * 1024 * 1024;
/// Keys below which the posting directory is encoded on one thread.
const PARALLEL_DIRECTORY_KEYS: usize = 65_536;

/// How posting lists are placed: on one thread in one pass over the records, or a batch of
/// records at a time across `threads` threads; `Auto` places large catalogs in parallel.
#[derive(Clone, Copy, Debug)]
enum Placement {
    Auto,
    Serial,
    Parallel { threads: usize, batch_bytes: usize },
}

/// Threads for a parallel posting pass.
fn posting_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(4, std::num::NonZeroUsize::get)
        .clamp(1, MAX_CODEC_THREADS)
}

/// Splits keys `0..keys` into `parts` contiguous ranges of about equal `weight`, a nondecreasing
/// cumulative weight with `weight(keys)` the whole. Returns the `parts + 1` range bounds.
fn balanced_bounds(keys: usize, parts: usize, weight: impl Fn(usize) -> u64) -> Vec<usize> {
    let parts = parts.max(1);
    let whole = weight(keys);
    let mut bounds = Vec::with_capacity(parts + 1);
    let mut previous = 0;
    bounds.push(previous);
    for part in 1..parts {
        let target = whole * part as u64 / parts as u64;
        // The first key at or past the target.
        let (mut low, mut high) = (previous, keys);
        while low < high {
            let middle = low + (high - low) / 2;
            if weight(middle) < target {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        previous = low;
        bounds.push(previous);
    }
    bounds.push(keys);
    bounds
}

/// Splits `values` into the consecutive pieces `bounds` marks.
fn split_by_bounds<'v, T>(mut values: &'v mut [T], bounds: &[usize]) -> Vec<&'v mut [T]> {
    let mut pieces = Vec::with_capacity(bounds.len().saturating_sub(1));
    for range in bounds.windows(2) {
        let (piece, rest) = std::mem::take(&mut values).split_at_mut(range[1] - range[0]);
        pieces.push(piece);
        values = rest;
    }
    pieces
}

/// The CRC-32 of `rows` as little-endian bytes, as the lists section stores them, converted
/// through a stack buffer.
fn list_checksum(rows: &[u32]) -> u64 {
    const ROWS: usize = 1024;
    let mut hasher = crc32fast::Hasher::new();
    let mut buffer = [0_u8; ROWS * 4];
    for chunk in rows.chunks(ROWS) {
        for (bytes, row) in buffer.as_chunks_mut::<4>().0.iter_mut().zip(chunk) {
            bytes.copy_from_slice(&row.to_le_bytes());
        }
        hasher.update(&buffer[..chunk.len() * 4]);
    }
    u64::from(hasher.finalize())
}

impl Postings {
    /// Places each key's rows, counted as the rows arrived: no list grows on its own. Large
    /// catalogs are placed in parallel, with the same result as one pass.
    fn build(
        payload: &StoredSection,
        rows: &[RowShape],
        strings: u64,
        counts: [Vec<u32>; POSTING_KINDS],
    ) -> Result<Self, CatalogError> {
        Self::build_with(payload, rows, strings, counts, Placement::Auto)
    }

    fn build_with(
        payload: &StoredSection,
        rows: &[RowShape],
        strings: u64,
        counts: [Vec<u32>; POSTING_KINDS],
        placement: Placement,
    ) -> Result<Self, CatalogError> {
        let strings_len = usize::try_from(strings).map_err(|_| corrupt("too many strings"))?;
        let keys = POSTING_KINDS * strings_len;
        let mut starts = Vec::with_capacity(keys + 1);
        let mut total = 0_u32;
        for mut counts in counts {
            counts.resize(strings_len, 0);
            for count in counts {
                starts.push(total);
                total = total
                    .checked_add(count)
                    .ok_or_else(|| corrupt("Catalog count exceeds u32"))?;
            }
        }
        starts.push(total);
        let mut placed = vec![0_u32; total as usize];
        let placement = match placement {
            Placement::Auto
                if rows.len() >= PARALLEL_POSTING_ROWS && total >= PARALLEL_POSTING_ENTRIES =>
            {
                Placement::Parallel {
                    threads: posting_threads(),
                    batch_bytes: POSTING_BATCH_BYTES,
                }
            }
            Placement::Auto => Placement::Serial,
            placement => placement,
        };
        let next = match placement {
            // Pairs hold keys as u32.
            Placement::Parallel {
                threads,
                batch_bytes,
            } if threads > 1 && u32::try_from(keys).is_ok() => place_parallel(
                payload,
                rows,
                strings,
                &starts,
                &mut placed,
                threads,
                batch_bytes,
            )?,
            _ => place_serial(payload, rows, strings, &starts, &mut placed)?,
        };
        if next.iter().zip(&starts[1..]).any(|(next, end)| next != end) {
            return Err(corrupt("records do not match their posting counts"));
        }
        Ok(Self {
            starts,
            rows: placed,
            strings: strings_len,
        })
    }

    /// The posting directory (section 2): each non-empty list's key, offset, length and checksum.
    fn directory(&self) -> Result<Vec<u8>, CatalogError> {
        self.directory_with(posting_threads(), PARALLEL_DIRECTORY_KEYS)
    }

    /// [`Self::directory`], encoded as `threads` key ranges in parallel once there are
    /// `parallel_keys` keys; the ranges' entries are joined in key order.
    fn directory_with(
        &self,
        threads: usize,
        parallel_keys: usize,
    ) -> Result<Vec<u8>, CatalogError> {
        let keys = self.starts.len().saturating_sub(1);
        let threads = if keys < parallel_keys {
            1
        } else {
            threads.max(1)
        };
        // A range's work is its keys and its entries.
        let bounds = balanced_bounds(keys, threads, |key| {
            u64::from(self.starts[key]) + key as u64
        });
        let parts = if threads == 1 {
            vec![self.directory_entries(0, keys)]
        } else {
            std::thread::scope(|scope| {
                let workers = bounds
                    .windows(2)
                    .map(|range| {
                        let (first, end) = (range[0], range[1]);
                        scope.spawn(move || self.directory_entries(first, end))
                    })
                    .collect::<Vec<_>>();
                workers
                    .into_iter()
                    .map(|worker| {
                        worker
                            .join()
                            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
                    })
                    .collect::<Vec<_>>()
            })
        };
        let parts = parts
            .into_iter()
            .collect::<Result<Vec<_>, CatalogError>>()?;
        let count = parts.iter().map(|(count, _)| count).sum::<usize>();
        let count = u32::try_from(count).map_err(|_| corrupt("Catalog count exceeds u32"))?;
        let mut directory =
            Vec::with_capacity(4 + parts.iter().map(|(_, bytes)| bytes.len()).sum::<usize>());
        directory.extend_from_slice(&count.to_le_bytes());
        for (_, bytes) in &parts {
            directory.extend_from_slice(bytes);
        }
        Ok(directory)
    }

    /// The directory entries of the non-empty lists among keys `first..end`, and their count.
    fn directory_entries(
        &self,
        first: usize,
        end: usize,
    ) -> Result<(usize, Vec<u8>), CatalogError> {
        let mut count = 0_usize;
        let mut entries = Vec::new();
        for key in first..end {
            let (start, end) = (self.starts[key] as usize, self.starts[key + 1] as usize);
            if start == end {
                continue;
            }
            count += 1;
            entries.push((key / self.strings) as u8);
            entries.extend_from_slice(&((key % self.strings) as u32).to_le_bytes());
            put64(&mut entries, start as u64 * 4);
            put32(&mut entries, end - start)?;
            put64(&mut entries, list_checksum(&self.rows[start..end]));
        }
        Ok((count, entries))
    }
}

/// Places every package record's rows in one pass, in row order. Returns each key's next
/// position, which ends at the next key's start when the counts were right.
fn place_serial(
    payload: &StoredSection,
    rows: &[RowShape],
    strings: u64,
    starts: &[u32],
    placed: &mut [u32],
) -> Result<Vec<u32>, CatalogError> {
    let keys = starts.len() - 1;
    let strings_len = keys / POSTING_KINDS;
    let mut next = starts[..keys].to_vec();
    let mut last = vec![u32::MAX; keys];
    payload.for_each_record(rows, |row, shape, record| {
        if shape.package {
            record_keys(record, strings, strings_len, |key| {
                if last[key] != row {
                    last[key] = row;
                    if let Some(slot) = placed.get_mut(next[key] as usize) {
                        *slot = row;
                    }
                    next[key] += 1;
                }
            })?;
        }
        Ok(())
    })?;
    Ok(next)
}

/// [`place_serial`], a bounded batch of records at a time. The keys are split into `threads`
/// ranges of about equal entries, each owning its piece of `placed`. Per batch, threads collect
/// each record's distinct keys as (key, row) pairs from contiguous runs of rows, sorted into the
/// key ranges; then each range's thread places its pairs, run by run in row order, so every
/// list is ascending exactly as one pass places it.
fn place_parallel(
    payload: &StoredSection,
    rows: &[RowShape],
    strings: u64,
    starts: &[u32],
    placed: &mut [u32],
    threads: usize,
    batch_bytes: usize,
) -> Result<Vec<u32>, CatalogError> {
    let keys = starts.len() - 1;
    let strings_len = keys / POSTING_KINDS;
    let ranges = balanced_bounds(keys, threads, |key| u64::from(starts[key]));
    let entries = ranges
        .iter()
        .map(|&key| starts[key] as usize)
        .collect::<Vec<_>>();
    let mut next = starts[..keys].to_vec();
    payload.for_each_batch(rows, batch_bytes, |first, shapes, bytes| {
        let runs = split_runs(first, shapes, bytes, threads);
        // Allocated per batch and dropped at batch end so skewed batches concentrated in different
        // key ranges cannot accumulate the sum of every range's peak buffer capacity.
        let mut pairs = vec![vec![Vec::<(u32, u32)>::new(); threads]; runs.len()];
        let collected = std::thread::scope(|scope| {
            let workers = runs
                .into_iter()
                .zip(pairs.iter_mut())
                .map(|((first, shapes, bytes), out)| {
                    let ranges = &ranges;
                    scope.spawn(move || {
                        collect_pairs(first, shapes, bytes, strings, strings_len, ranges, out)
                    })
                })
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
                })
                .collect::<Vec<_>>()
        });
        // The earliest run's failure is the earliest row's, as one pass reports it.
        for result in collected {
            result?;
        }
        let pairs = &pairs;
        std::thread::scope(|scope| {
            let pieces = split_by_bounds(&mut *placed, &entries)
                .into_iter()
                .zip(split_by_bounds(&mut next, &ranges));
            for (range, (placed, next)) in pieces.enumerate() {
                let (first_key, base) = (ranges[range], entries[range]);
                scope.spawn(move || {
                    for run in pairs {
                        for &(key, row) in &run[range] {
                            let key = key as usize;
                            let at = &mut next[key - first_key];
                            // A key with more rows than counted is reported once all are read.
                            if *at < starts[key + 1] {
                                placed[*at as usize - base] = row;
                            }
                            *at += 1;
                        }
                    }
                });
            }
        });
        Ok(())
    })?;
    Ok(next)
}

/// Splits a batch's rows into at most `parts` contiguous runs of about equal record bytes:
/// each run's first row, its rows, and their records.
fn split_runs<'r>(
    first: usize,
    shapes: &'r [RowShape],
    bytes: &'r [u8],
    parts: usize,
) -> Vec<(usize, &'r [RowShape], &'r [u8])> {
    let share = bytes.len().div_ceil(parts.max(1)).max(1);
    let mut runs = Vec::with_capacity(parts);
    let (mut run_row, mut run_byte, mut offset) = (0, 0, 0);
    for (row, shape) in shapes.iter().enumerate() {
        offset += shape.len as usize;
        if offset >= share * (runs.len() + 1) && runs.len() + 1 < parts {
            runs.push((
                first + run_row,
                &shapes[run_row..=row],
                &bytes[run_byte..offset],
            ));
            (run_row, run_byte) = (row + 1, offset);
        }
    }
    if run_row < shapes.len() {
        runs.push((first + run_row, &shapes[run_row..], &bytes[run_byte..]));
    }
    runs
}

/// Collects each package record's distinct posting keys among `shapes` as (key, row) pairs, in
/// row order, into `out` by the key range `ranges` puts each in.
fn collect_pairs(
    first: usize,
    shapes: &[RowShape],
    bytes: &[u8],
    strings: u64,
    strings_len: usize,
    ranges: &[usize],
    out: &mut [Vec<(u32, u32)>],
) -> Result<(), CatalogError> {
    let mut distinct = Vec::new();
    let mut offset = 0;
    for (index, shape) in shapes.iter().enumerate() {
        let record = &bytes[offset..offset + shape.len as usize];
        offset += shape.len as usize;
        let row = u32::try_from(first + index).map_err(|_| corrupt("Catalog count exceeds u32"))?;
        if !shape.package {
            continue;
        }
        // A record can name a key more than once; its row is posted once.
        distinct.clear();
        record_keys(record, strings, strings_len, |key| distinct.push(key))?;
        distinct.sort_unstable();
        distinct.dedup();
        let mut range = 0;
        for &key in &distinct {
            while key >= ranges[range + 1] {
                range += 1;
            }
            // Keys fit u32: the parallel placement is only chosen when they do.
            out[range].push((key as u32, row));
        }
    }
    Ok(())
}

/// Calls `post` with each posting key a record names: its classes, names and dependency targets,
/// keyed by kind and string id.
fn record_keys(
    record: &[u8],
    strings: u64,
    strings_len: usize,
    mut post: impl FnMut(usize),
) -> Result<(), CatalogError> {
    if let Some(header) = decode_record(record, strings)? {
        header
            .class_ids()
            .for_each(|value| post(CLASS_POSTINGS as usize * strings_len + value as usize));
        header
            .name_ids()
            .for_each(|value| post(NAME_POSTINGS as usize * strings_len + value as usize));
        header.dependency_ids().for_each(|(value, _)| {
            post(DEPENDENCY_POSTINGS as usize * strings_len + value as usize)
        });
    }
    Ok(())
}
struct Unpublished {
    path: PathBuf,
    published: bool,
}
fn create_unpublished(path: &Path) -> Result<(File, Unpublished), CatalogError> {
    // Only acquire cleanup ownership after create_new succeeds.
    let file = File::create_new(path).map_err(io_unavailable("create binary snapshot"))?;
    Ok((
        file,
        Unpublished {
            path: path.to_owned(),
            published: false,
        },
    ))
}
impl Drop for Unpublished {
    fn drop(&mut self) {
        if !self.published {
            let _ = remove_if_exists(&self.path);
        }
    }
}

/// What identifies a physical snapshot file as it was checked: its path, length and times, and
/// the fingerprint of its header, which holds every section's stored checksum.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SnapshotStamp {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    header: u64,
}

impl SnapshotStamp {
    fn of(path: &Path) -> Result<Self, CatalogError> {
        let mut file = File::open(path).map_err(io_unavailable("open binary snapshot"))?;
        let metadata = file
            .metadata()
            .map_err(io_unavailable("stat binary snapshot"))?;
        let header = SnapshotHeader::decode(&read_range(&mut file, 0, HEADER_BYTES)?)?;
        Ok(Self {
            path: path.to_owned(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            header: checksum(&header.encode()),
        })
    }
}

/// Snapshots this process has checked byte for byte against their stored checksums: on a
/// writer or status open, or right after writing them. A snapshot file is never written again
/// once published (a refresh writes a new file), so a long-lived process opening one whose stamp
/// is unchanged checks its header, block indexes and inventory count, and each block it reads
/// against that block's checksum, without reading every stored byte again. A new process starts
/// with none, so it checks every byte as before.
#[derive(Debug, Default)]
pub(crate) struct VerifiedSnapshots {
    stamps: std::collections::VecDeque<SnapshotStamp>,
}

/// A process keeps the stamps of its last few verified snapshots: a base and delta of each
/// Catalog it refreshes.
const MAX_VERIFIED_SNAPSHOTS: usize = 8;

impl VerifiedSnapshots {
    fn contains(&self, stamp: &SnapshotStamp) -> bool {
        self.stamps.contains(stamp)
    }

    /// Records `stamp` as the most recently used, forgetting the least recently used past the
    /// limit; a base stays recorded while each refresh writes a new delta over it.
    fn record(&mut self, stamp: SnapshotStamp) {
        self.stamps.retain(|known| known.path != stamp.path);
        self.stamps.push_back(stamp);
        while self.stamps.len() > MAX_VERIFIED_SNAPSHOTS {
            self.stamps.pop_front();
        }
    }
}

/// A generation's snapshots opened with `check`; for `Stored` with a record of verified
/// snapshots, snapshots whose stamps it holds are opened with `Header`, and the others are
/// verified and recorded.
fn open_committed(
    directory: &Path,
    manifest: &Manifest,
    check: SnapshotCheck,
    verified: Option<&mut VerifiedSnapshots>,
) -> Result<Committed, CatalogError> {
    let Some(verified) = verified.filter(|_| check == SnapshotCheck::Stored) else {
        return Committed::open(directory, manifest, check);
    };
    let stamps = std::iter::once(&manifest.physical_snapshot)
        .chain(manifest.delta_snapshot.as_ref())
        .map(|name| SnapshotStamp::of(&directory.join(name)))
        .collect::<Result<Vec<_>, _>>()?;
    if stamps.iter().all(|stamp| verified.contains(stamp)) {
        let committed = Committed::open(directory, manifest, SnapshotCheck::Header)?;
        // The files opened are the ones stamped: their headers have not changed since.
        let opened = std::iter::once(committed.base.fingerprint())
            .chain(committed.delta.as_ref().map(Snapshot::fingerprint));
        if opened.eq(stamps.iter().map(|stamp| stamp.header)) {
            for stamp in stamps {
                verified.record(stamp);
            }
            return Ok(committed);
        }
    }
    let committed = Committed::open(directory, manifest, SnapshotCheck::Stored)?;
    let opened = std::iter::once(committed.base.fingerprint())
        .chain(committed.delta.as_ref().map(Snapshot::fingerprint))
        .collect::<Vec<_>>();
    // Record only what was stamped before the check and checked as stamped.
    for (stamp, opened) in stamps.into_iter().zip(opened) {
        if stamp.header == opened {
            verified.record(stamp);
        }
    }
    Ok(committed)
}

pub(crate) struct BinaryCatalog {
    // A sibling lock survives quarantine/clear; the OS releases it even on process termination.
    writer_lock: Option<File>,
    publication_uncertain: bool,
    directory: PathBuf,
    project_id: ProjectId,
    manifest: Option<Manifest>,
    committed: RefCell<Option<Committed>>,
    staging: Option<Staging>,
    quarantined_from: Option<PathBuf>,
    writes: CatalogWriteCounts,
    delta_limits: DeltaLimits,
    /// Snapshots a long-lived process has verified, when it keeps a record of them.
    verified: Option<VerifiedSnapshots>,
    /// The change journal positions the active refresh may keep; see [`JournalPlan`].
    journal_plan: Option<JournalPlan>,
    /// Whether the refresh about to commit walked every content root.
    committing_walked: bool,
    /// The generation and inventory digest the last commit replaced, for its change record.
    committed_from: Option<(u64, String)>,
    #[cfg(test)]
    cleanup_root: Option<PathBuf>,
}
/// The change journal position a refresh's generation keeps. A walk keeps the position taken
/// before it listed the roots; a refresh that looked only at what it was told changed keeps
/// `targeted`, or, without one, the committed generation's: everything that changed since that
/// position is still read next time. Without a plan no position is kept, and the next refresh
/// walks.
pub(crate) struct JournalPlan {
    pub(crate) walked: Option<ChangeJournal>,
    pub(crate) targeted: Option<ChangeJournal>,
}
/// How a catalog is opened: the writer verifies, locks and recovers; a query reader trusts the
/// manifest; a status reader verifies but never locks or writes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum OpenMode {
    Writer,
    Query,
    Status,
}
impl std::fmt::Debug for BinaryCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BinaryCatalog")
            .field("project_id", &self.project_id)
            .finish()
    }
}
impl BinaryCatalog {
    pub(crate) fn open(root: &Path, project_id: &ProjectId) -> Result<Self, CatalogError> {
        Self::open_checked(root, project_id, OpenMode::Writer, None)
    }
    /// [`BinaryCatalog::open`] in a long-lived process that keeps `verified`; take it back
    /// with [`BinaryCatalog::take_verified`].
    pub(crate) fn open_with_verified(
        root: &Path,
        project_id: &ProjectId,
        verified: VerifiedSnapshots,
    ) -> Result<Self, CatalogError> {
        Self::open_checked(root, project_id, OpenMode::Writer, Some(verified))
    }
    pub(crate) fn open_for_query(
        root: &Path,
        project_id: &ProjectId,
    ) -> Result<Self, CatalogError> {
        Self::open_checked(root, project_id, OpenMode::Query, None)
    }
    /// The record of verified snapshots this catalog was opened with, with what it verified.
    pub(crate) fn take_verified(&mut self) -> Option<VerifiedSnapshots> {
        self.verified.take()
    }
    /// Reads the committed catalog for status: no writer lock, so a refresh in progress doesn't
    /// hide the last committed generation, and nothing on disk is created, cleaned or quarantined.
    /// A damaged catalog reads as absent; the next refresh quarantines it.
    pub(crate) fn open_for_status(
        root: &Path,
        project_id: &ProjectId,
        verified: Option<&mut VerifiedSnapshots>,
    ) -> Result<Self, CatalogError> {
        // A failed open drops the record; the next open verifies again.
        let mut verified = verified;
        let record = verified.as_deref_mut().map(std::mem::take);
        let opened =
            Self::open_checked(root, project_id, OpenMode::Status, record).map(|mut catalog| {
                if let (Some(verified), Some(record)) = (verified, catalog.take_verified()) {
                    *verified = record;
                }
                catalog
            });
        match opened {
            Err(CatalogError::Corrupt { .. }) => Ok(Self::unopened(
                root.join(CATALOG_DIRECTORY)
                    .join(catalog_directory_name(project_id)),
                project_id,
            )),
            opened => opened,
        }
    }
    fn unopened(directory: PathBuf, project_id: &ProjectId) -> Self {
        Self {
            writer_lock: None,
            publication_uncertain: false,
            directory,
            project_id: project_id.clone(),
            manifest: None,
            committed: RefCell::new(None),
            staging: None,
            quarantined_from: None,
            writes: CatalogWriteCounts::default(),
            delta_limits: DeltaLimits::default(),
            verified: None,
            journal_plan: None,
            committing_walked: false,
            committed_from: None,
            #[cfg(test)]
            cleanup_root: None,
        }
    }
    /// The change journal position the committed generation was listed at.
    pub(crate) fn committed_change_journal(&self) -> Option<&ChangeJournal> {
        self.manifest.as_ref()?.change_journal.as_ref()
    }
    /// Which change journal position the next commit keeps.
    pub(crate) fn plan_change_journal(&mut self, plan: JournalPlan) {
        self.journal_plan = Some(plan);
    }
    fn open_checked(
        root: &Path,
        project_id: &ProjectId,
        mode: OpenMode,
        mut verified: Option<VerifiedSnapshots>,
    ) -> Result<Self, CatalogError> {
        let directory = root
            .join(CATALOG_DIRECTORY)
            .join(catalog_directory_name(project_id));
        if mode == OpenMode::Status && !directory.is_dir() {
            let mut unopened = Self::unopened(directory, project_id);
            unopened.verified = verified;
            return Ok(unopened);
        }
        if mode != OpenMode::Status
            && let Some(namespace) = directory.parent()
        {
            fs::create_dir_all(namespace)
                .map_err(io_unavailable("create binary Catalog namespace"))?;
        }
        let writer_lock = if mode == OpenMode::Writer {
            let lock = File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(directory.with_extension("lock"))
                .map_err(io_unavailable("open Catalog writer lock"))?;
            lock.try_lock().map_err(|error| CatalogError::Unavailable {
                message: format!("cannot acquire Catalog writer lock: {error}"),
            })?;
            Some(lock)
        } else {
            None
        };
        if mode != OpenMode::Status {
            fs::create_dir_all(&directory)
                .map_err(io_unavailable("create binary Catalog directory"))?;
        }
        let opened = (|| {
            let manifest = read_and_verify_manifest(&directory, project_id)?;
            if manifest.as_ref().is_some_and(|m| {
                m.summary.generation == 0
                    || m.summary.map_count > m.summary.package_count
                    || !matches!(m.summary.completeness.as_str(), "complete" | "partial")
                    || m.summary.inventory().is_none()
            }) {
                return Err(corrupt("invalid Catalog summary"));
            }
            let Some(manifest_ref) = &manifest else {
                return Ok((manifest, None));
            };
            // Writers and status verify every stored byte; neither decodes more than a writer
            // needs to compare (the inventory) or status needs at all (headers and tombstones).
            // A query reader pins the physical files when it opens, before its first query, so
            // later publication may unlink retired names.
            let check = match mode {
                OpenMode::Query => SnapshotCheck::Header,
                OpenMode::Writer | OpenMode::Status => SnapshotCheck::Stored,
            };
            let committed = open_committed(&directory, manifest_ref, check, verified.as_mut())?;
            if mode != OpenMode::Query
                && committed.counts()
                    != Some((
                        manifest_ref.summary.package_count,
                        manifest_ref.summary.map_count,
                    ))
            {
                return Err(corrupt("manifest summary does not match its snapshot"));
            }
            Ok((manifest, (mode != OpenMode::Status).then_some(committed)))
        })();
        let (manifest, committed, quarantined_from) = match opened {
            Ok((manifest, committed)) => (manifest, committed, None),
            Err(CatalogError::Corrupt { .. }) if mode == OpenMode::Writer => {
                let quarantine = quarantine_directory(&directory)?;
                fs::create_dir_all(&directory)
                    .map_err(io_unavailable("recreate binary Catalog"))?;
                (None, None, quarantine)
            }
            Err(error) => return Err(error),
        };
        if mode == OpenMode::Writer
            && let Some(manifest) = &manifest
        {
            cleanup_retired_snapshots(&directory, manifest);
        }
        Ok(Self {
            writer_lock,
            publication_uncertain: false,
            directory,
            project_id: project_id.clone(),
            manifest,
            committed: RefCell::new(committed),
            staging: None,
            quarantined_from,
            writes: CatalogWriteCounts::default(),
            delta_limits: DeltaLimits::default(),
            verified,
            journal_plan: None,
            committing_walked: false,
            committed_from: None,
            #[cfg(test)]
            cleanup_root: None,
        })
    }
    /// One page of an inventory, map or posting query, its items built by `plain` (inventory and
    /// map items) and `header` (each header item, from its path, record, the shared strings of
    /// its segment, and the segment). Callers have checked the request's identity, limit and
    /// generation.
    fn page<I>(
        &self,
        request: &QueryRequest,
        mut plain: impl FnMut(QueryItem) -> I,
        mut header: impl FnMut(&str, &HeaderView<'_>, &StringTable, Segment) -> I,
    ) -> Result<(Vec<I>, Option<String>), CatalogError> {
        let cursor = parse_page_cursor(request.cursor.as_deref())?;
        self.load()?;
        let cached = self.committed.borrow();
        let committed = cached
            .as_ref()
            .ok_or_else(|| corrupt("binary Catalog snapshot is not loaded"))?;
        let ids = committed.page_ids(&request.kind, &cursor, request.limit + 1)?;
        let more = ids.len() > request.limit;
        let selected = &ids[..ids.len().min(request.limit)];
        let mut items = (0..selected.len()).map(|_| None).collect::<Vec<_>>();
        match &request.kind {
            // Inventory rows carry their header data: an inventory page reads no records.
            QueryKind::Inventory => {
                let signatures = committed.bundle_signatures(selected)?;
                for ((position, &(segment, id)), signature) in
                    selected.iter().enumerate().zip(signatures)
                {
                    let (path, entry) = committed.rows(segment)?.row(id)?;
                    items[position] = Some(plain(QueryItem::Inventory {
                        package_path: path.to_owned(),
                        signature,
                        header_data: entry.header_data.clone(),
                    }));
                }
            }
            // A map page needs only each record's package name.
            QueryKind::Maps => {
                committed.records(selected, |position, _, id, record, snapshot| {
                    let path = snapshot.path(id)?;
                    items[position] = Some(plain(QueryItem::Map {
                        package_name: record
                            .map(|h| h.package_name)
                            .filter(|s| !s.is_empty())
                            .unwrap_or(path)
                            .to_owned(),
                        map_path: path.to_owned(),
                    }));
                    Ok(())
                })?
            }
            _ => committed.records(selected, |position, segment, id, record, snapshot| {
                let record = record.ok_or_else(|| corrupt("posting refers to missing header"))?;
                let strings = &snapshot.strings()?.table;
                items[position] = Some(header(snapshot.path(id)?, &record, strings, segment));
                Ok(())
            })?,
        }
        let items = items
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| corrupt("a page row has no record"))?;
        let next_cursor = if more {
            selected
                .last()
                .map(|(segment, id)| committed.path(*segment, *id).map(str::to_owned))
                .transpose()?
        } else {
            None
        };
        Ok((items, next_cursor))
    }

    /// [`Catalog::query`] for an inventory, map or posting query, with each header item's classes
    /// and names as ids into the page's own strings, in first-use order: each distinct string is
    /// copied once from the shared strings, and never hashed as text unless the generation has a
    /// delta, whose strings may repeat the base's.
    pub(crate) fn query_shared_strings(
        &self,
        request: &QueryRequest,
    ) -> Result<SharedStringPage, CatalogError> {
        let page = self.query_shared_strings_retaining(request);
        self.release_rows();
        page
    }

    /// Releases the committed snapshots' decoded inventory chunks past `RETAINED_CHUNKS`, once a
    /// query no longer borrows them.
    fn release_rows(&self) {
        if let Ok(mut committed) = self.committed.try_borrow_mut()
            && let Some(committed) = committed.as_mut()
        {
            committed.release_rows_over(RETAINED_CHUNKS);
        }
    }

    fn query_shared_strings_retaining(
        &self,
        request: &QueryRequest,
    ) -> Result<SharedStringPage, CatalogError> {
        let manifest = require_manifest(&self.manifest, &self.project_id, &request.project_id)?;
        validate_page_limit(request.limit)?;
        let generation = Generation::new(manifest.summary.generation);
        if generation != request.expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: request.expected_generation,
                actual: generation,
            });
        }
        if matches!(
            request.kind,
            QueryKind::Dependencies { .. } | QueryKind::Dependents { .. }
        ) {
            return Err(CatalogError::InvalidRequest {
                message: "dependency pages name packages, not shared strings".into(),
            });
        }
        validate_union_filters(&request.kind)?;
        let fields = request.fields;
        let matched = request.kind.serialized_name_values();
        let two_segments = manifest.delta_snapshot.is_some();
        let mut page_ids: std::collections::HashMap<u64, u32, BuildIdHasher> =
            std::collections::HashMap::default();
        let mut page_texts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        let mut page_strings = Vec::new();
        let (items, next_cursor) = self.page(
            request,
            |item| match item {
                QueryItem::Inventory {
                    package_path,
                    signature,
                    header_data,
                } => SharedStringItem::Inventory {
                    package_path,
                    signature,
                    header_data,
                },
                QueryItem::Map {
                    map_path,
                    package_name,
                } => SharedStringItem::Map {
                    map_path,
                    package_name,
                },
                // `page` builds header items itself, and dependency items are refused above.
                QueryItem::Header { .. } | QueryItem::Package { .. } => unreachable!(),
            },
            |path, header, strings, segment| {
                let mut page_id = |id: u32| {
                    let key = u64::from(segment == Segment::Delta) << 32 | u64::from(id);
                    *page_ids.entry(key).or_insert_with(|| {
                        let text = strings.get(id as usize);
                        if two_segments && let Some(existing) = page_texts.get(text) {
                            return *existing;
                        }
                        page_strings.push(text.to_owned());
                        // A page carries at most PROJECT_INDEX_MAX_PAGE_STRINGS strings.
                        let page_id = (page_strings.len() - 1) as u32;
                        if two_segments {
                            page_texts.insert(text.to_owned(), page_id);
                        }
                        page_id
                    })
                };
                // A field the request leaves out is never copied or given a page string.
                SharedStringItem::Header {
                    header_data: if fields.header_data {
                        header.header_data.clone()
                    } else {
                        None
                    },
                    package_path: path.to_owned(),
                    package_name: header.package_name.to_owned(),
                    classes: if fields.classes {
                        header.class_ids().map(&mut page_id).collect()
                    } else {
                        Vec::new()
                    },
                    serialized_names: match fields.serialized_names {
                        NameField::All => header.name_ids().map(&mut page_id).collect(),
                        NameField::Matched => header
                            .name_ids()
                            .filter(|id| matched.contains(&strings.get(*id as usize)))
                            .map(&mut page_id)
                            .collect(),
                        NameField::Omitted => Vec::new(),
                    },
                }
            },
        )?;
        Ok(SharedStringPage {
            project_id: request.project_id.clone(),
            generation,
            items,
            next_cursor,
            strings: page_strings,
        })
    }

    pub(crate) fn quarantined_from(&self) -> Option<&Path> {
        self.quarantined_from.as_deref()
    }
    pub(crate) fn write_counts(&self) -> CatalogWriteCounts {
        self.writes
    }
    pub(crate) fn storage_bytes(&self) -> u64 {
        fs::read_dir(&self.directory)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    }
    fn load(&self) -> Result<(), CatalogError> {
        if self.committed.borrow().is_none()
            && let Some(manifest) = &self.manifest
        {
            *self.committed.borrow_mut() = Some(Committed::open(
                &self.directory,
                manifest,
                SnapshotCheck::Header,
            )?);
        }
        Ok(())
    }
    /// The active refresh, which `require_staging` has checked exists.
    fn staging_mut(&mut self) -> Result<&mut Staging, CatalogError> {
        self.staging.as_mut().ok_or_else(no_staging)
    }
    fn require_staging(&self, token: &StagingToken) -> Result<(), CatalogError> {
        if self
            .staging
            .as_ref()
            .is_some_and(|s| s.generation == token.generation)
        {
            Ok(())
        } else {
            Err(CatalogError::InvalidRequest {
                message: "invalid binary Catalog staging token".into(),
            })
        }
    }
    /// Records one handle observed unchanged.
    fn observe_handle(&mut self, handle: Option<u32>) -> Result<(), CatalogError> {
        let staging = self.staging_mut()?;
        if staging.ordered.is_some() || staging.except.is_some() {
            return Err(observed_after_ordered_staging());
        }
        match handle {
            Some(handle) => staging.kept.push(handle),
            None => staging.missing_unchanged = true,
        }
        Ok(())
    }
}

fn observed_after_ordered_staging() -> CatalogError {
    CatalogError::InvalidRequest {
        message: "entries cannot be observed unchanged once staged in path order".into(),
    }
}

/// Whether the next generation is written as a delta over the committed base: when one is
/// committed with the same mount points, and the delta's entries plus the base rows it hides stay
/// within `limits`.
fn choose_mode(
    committed: Option<&Committed>,
    manifest: Option<&Manifest>,
    carry: &Carry,
    plan: &StagingPlan<'_>,
    limits: DeltaLimits,
) -> WriteMode {
    let (Some(committed), Some(manifest)) = (committed, manifest) else {
        return WriteMode::Full;
    };
    if manifest.summary.mount_points() != plan.mounts {
        return WriteMode::Full;
    }
    let base_rows = committed.base.row_count;
    let Ok(base_end) = u32::try_from(base_rows) else {
        return WriteMode::Full;
    };
    let live_base = base_rows - committed.hidden().ids.len();
    let delta_rows = committed.delta.as_ref().map_or(0, |delta| delta.row_count);
    let carried_base = carry.count_in(0..base_end, live_base);
    let carried_delta = carry.count_in(base_end..u32::MAX, delta_rows);
    let hidden = base_rows.saturating_sub(carried_base);
    let total = hidden + carried_delta + plan.entries;
    let strings = committed
        .delta
        .as_ref()
        .map_or(0, |delta| delta.header.strings);
    if total <= limits.entries
        && total.saturating_mul(1000) <= base_rows.saturating_mul(limits.permille)
        && strings <= limits.strings
    {
        WriteMode::Delta
    } else {
        WriteMode::Full
    }
}

impl Catalog for BinaryCatalog {
    type Preparer = BinaryPreparer;

    fn status(&self) -> CatalogStatus {
        self.manifest
            .as_ref()
            .map_or(CatalogStatus::Absent, |m| CatalogStatus::Ready {
                summary: m.summary.to_refresh(&self.project_id),
            })
    }
    fn committed_generation(&self) -> Option<Generation> {
        self.manifest
            .as_ref()
            .map(|m| Generation::new(m.summary.generation))
    }
    fn lookup_committed(&self, path: &str) -> Option<(PackageSignature, Option<HeaderEvidence>)> {
        self.load().ok()?;
        let cached = self.committed.borrow();
        let committed = cached.as_ref()?;
        let (segment, id) = committed.row_at(path).ok()??;
        let rows = committed.rows(segment).ok()?;
        Some((rows.signature(id).ok()?, rows.headers(&[id]).ok()?.pop()?))
    }
    fn begin_refresh(&mut self) -> Result<StagingToken, CatalogError> {
        if self.publication_uncertain {
            return Err(CatalogError::Unavailable {
                message: "reopen the Catalog after a failed manifest publication".into(),
            });
        }
        if self.writer_lock.is_none() {
            return Err(CatalogError::Unavailable {
                message: "query Catalog cannot write".into(),
            });
        }
        if self.staging.is_some() {
            return Err(CatalogError::Unavailable {
                message: "refresh already active".into(),
            });
        }
        let generation = self
            .committed_generation()
            .map_or(Generation::new(1), Generation::next);
        self.staging = Some(Staging {
            generation,
            kept: Vec::new(),
            except: None,
            missing_unchanged: false,
            changed: Vec::new(),
            records: Vec::new(),
            dictionary: None,
            remaps: Vec::new(),
            record: Vec::new(),
            staged: 0,
            carry: None,
            mode: WriteMode::Full,
            delta_remap: None,
            ordered: None,
        });
        self.writes = CatalogWriteCounts::default();
        Ok(StagingToken { generation })
    }
    fn observe_unchanged(&mut self, token: &StagingToken, path: &str) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        self.load()?;
        let handle = match self.committed.borrow().as_ref() {
            Some(committed) => committed
                .row_at(path)?
                .map(|(segment, id)| committed.handle(segment, id))
                .transpose()?,
            None => None,
        };
        self.observe_handle(handle)
    }
    fn observe_unchanged_committed(
        &mut self,
        token: &StagingToken,
        path: SplitPath<'_>,
        committed_index: usize,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        // The index is the entry's handle from `visit_committed_entries` over this generation;
        // its path is checked when the inventory is decoded, its range always.
        let matches = self.committed.borrow().as_ref().is_some_and(|committed| {
            committed_index < committed.handle_count()
                && match committed.row_of(committed_index as u32) {
                    (Segment::Base, id) => {
                        !committed.hidden().hides(id)
                            && committed
                                .base
                                .decoded_path(id)
                                .is_none_or(|decoded| path.eq_str(decoded))
                    }
                    (Segment::Delta, id) => committed.delta.as_ref().is_some_and(|delta| {
                        delta
                            .decoded_path(id)
                            .is_none_or(|decoded| path.eq_str(decoded))
                    }),
                }
        });
        match u32::try_from(committed_index) {
            Ok(handle) if matches => self.observe_handle(Some(handle)),
            _ => self.observe_unchanged(token, &path.to_string()),
        }
    }
    fn stage_observed(
        &mut self,
        token: &StagingToken,
        entry: StagedPackage,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        let started = Instant::now();
        self.load()?;
        let cached = self.committed.borrow();
        let committed = cached.as_ref();
        let staging = self.staging.as_mut().ok_or_else(no_staging)?;
        staging.record.clear();
        let meta = match &entry.header {
            None => {
                staging.record.push(0);
                RecordMeta::default()
            }
            Some(header) => {
                let dictionary = shared_dictionary(
                    &mut staging.dictionary,
                    &mut staging.delta_remap,
                    staging.mode,
                    committed,
                )?;
                encode_header_record(header, dictionary, &mut staging.record)?;
                RecordMeta::of(header)
            }
        };
        staging.stage_record(committed, &entry.signature, meta)?;
        drop(cached);
        self.writes.staged_evidence_rows += 1;
        self.writes.evidence_write_duration += started.elapsed();
        Ok(())
    }
    fn evidence_preparer(&mut self, token: &StagingToken) -> Result<BinaryPreparer, CatalogError> {
        self.require_staging(token)?;
        Ok(BinaryPreparer {
            workers: AtomicUsize::new(0),
        })
    }
    fn stage_prepared(
        &mut self,
        token: &StagingToken,
        signature: &PackageSignature,
        header: Option<Result<EncodedHeader, CatalogError>>,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        let started = Instant::now();
        self.load()?;
        let cached = self.committed.borrow();
        let committed = cached.as_ref();
        let staging = self.staging.as_mut().ok_or_else(no_staging)?;
        staging.record.clear();
        let meta = match header {
            None => {
                staging.record.push(0);
                RecordMeta::default()
            }
            Some(prepared) => {
                let prepared = prepared?;
                let dictionary = shared_dictionary(
                    &mut staging.dictionary,
                    &mut staging.delta_remap,
                    staging.mode,
                    committed,
                )?;
                absorb_strings(dictionary, &mut staging.remaps, &prepared)?;
                let record = prepared
                    .bytes
                    .get(..prepared.record_len)
                    .ok_or_else(|| corrupt("truncated prepared record"))?;
                staging.record.extend_from_slice(record);
                remap_record_ids(
                    &mut staging.record,
                    prepared.ids_at,
                    &staging.remaps[prepared.slot],
                )?;
                RecordMeta {
                    profile: Some(prepared.profile),
                    failure: prepared.failure,
                    header_data: prepared.header_data,
                }
            }
        };
        staging.stage_record(committed, signature, meta)?;
        drop(cached);
        self.writes.staged_evidence_rows += 1;
        self.writes.evidence_write_duration += started.elapsed();
        Ok(())
    }
    fn release_prepared(
        &mut self,
        token: &StagingToken,
        prepared: Result<EncodedHeader, CatalogError>,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        let prepared = prepared?;
        self.load()?;
        let cached = self.committed.borrow();
        let staging = self.staging.as_mut().ok_or_else(no_staging)?;
        let dictionary = shared_dictionary(
            &mut staging.dictionary,
            &mut staging.delta_remap,
            staging.mode,
            cached.as_ref(),
        )?;
        absorb_strings(dictionary, &mut staging.remaps, &prepared)
    }
    fn stage_in_path_order(
        &mut self,
        token: &StagingToken,
        plan: &StagingPlan<'_>,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        self.load()?;
        let cached = self.committed.borrow();
        let limits = self.delta_limits;
        let manifest = self.manifest.as_ref();
        let staging = self.staging.as_mut().ok_or_else(no_staging)?;
        if staging.ordered.is_none() {
            if staging.staged > 0 {
                return Err(CatalogError::InvalidRequest {
                    message: "entries were staged before staging in path order".into(),
                });
            }
            let carry = staging.settle_carry();
            let mode = choose_mode(cached.as_ref(), manifest, carry, plan, limits);
            staging.mode = mode;
            staging.ordered = Some(OrderedRows {
                cursor: KeptCursor::default(),
                builder: None,
            });
        }
        Ok(())
    }
    fn commit_refresh(
        &mut self,
        token: StagingToken,
        summary: RefreshSummary,
    ) -> Result<Generation, CatalogError> {
        self.require_staging(&token)?;
        if summary.generation != token.generation || summary.project_id != self.project_id {
            return Err(CatalogError::InvalidRequest {
                message: "summary does not match staging".into(),
            });
        }
        self.load()?;
        self.committed_from = None;
        let committed_from = self.manifest.as_ref().and_then(|manifest| {
            manifest_digest(manifest).map(|digest| (manifest.summary.generation, digest))
        });
        let mut staging = self.staging.take().ok_or_else(no_staging)?;
        let cached = self.committed.borrow();
        let committed = cached.as_ref();
        let carry = staging.settle_carry();
        let carries_everything = committed.is_some_and(|committed| match carry {
            Carry::Kept(handles) => handles.len() == committed.live_count(),
            Carry::AllExcept(handles) => handles.is_empty(),
        });
        let reuse = self.manifest.is_some()
            && staging.staged == 0
            && !staging.missing_unchanged
            && summary.removed_packages == 0
            && carries_everything;
        let mut cleanup = None;
        let (physical_snapshot, delta_snapshot, previous_snapshot, previous_delta, inventory) =
            if let Some(current) = &self.manifest
                && reuse
            {
                (
                    current.physical_snapshot.clone(),
                    current.delta_snapshot.clone(),
                    current.previous_snapshot.clone(),
                    current.previous_delta.clone(),
                    current
                        .summary
                        .inventory()
                        .ok_or_else(|| corrupt("invalid Catalog summary"))?,
                )
            } else {
                let started = Instant::now();
                let mode = staging.mode;
                let name = snapshot_file_name(token.generation, mode);
                let path = self.directory.join(&name);
                let (file, guard) = create_unpublished(&path)?;
                cleanup = Some(guard);
                let written = write_snapshot(file, staging, committed, self.manifest.as_ref())?;
                // Reread the persisted bytes against their checksums before publication;
                // included in commit timing.
                verify_written(&path, &written.header)?;
                // Every stored byte was just checked; a process that keeps a record need not
                // check them again while the file is unchanged.
                if let Some(verified) = &mut self.verified
                    && let Ok(stamp) = SnapshotStamp::of(&path)
                    && stamp.header == checksum(&written.header.encode())
                {
                    verified.record(stamp);
                }
                if written.counts != (summary.package_count, summary.map_count) {
                    return Err(CatalogError::InvalidRequest {
                        message: "the written generation's counts do not match its summary".into(),
                    });
                }
                self.writes.committed_evidence_rows = written.rows as u64;
                self.writes.removed_evidence_rows = summary.removed_packages;
                self.writes.written_bytes = written.header.file_len()?;
                self.writes.delta = mode == WriteMode::Delta;
                self.writes.evidence_write_duration += started.elapsed();
                let previous = self.manifest.as_ref();
                let (physical, delta) = match (mode, previous) {
                    (WriteMode::Delta, Some(current)) => {
                        (current.physical_snapshot.clone(), Some(name))
                    }
                    _ => (name, None),
                };
                (
                    physical,
                    delta,
                    previous.map(|m| m.physical_snapshot.clone()),
                    previous.and_then(|m| m.delta_snapshot.clone()),
                    written.inventory,
                )
            };
        drop(cached);
        let change_journal = self.journal_plan.take().and_then(|plan| {
            if self.committing_walked {
                plan.walked
            } else {
                plan.targeted.or_else(|| {
                    self.manifest
                        .as_ref()
                        .and_then(|manifest| manifest.change_journal.clone())
                })
            }
        });
        let manifest = Manifest {
            manifest_schema_version: MANIFEST_SCHEMA_VERSION,
            snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
            project_id: self.project_id.to_string(),
            physical_snapshot,
            delta_snapshot,
            previous_snapshot,
            previous_delta,
            summary: ManifestSummary::from_refresh(&summary, inventory),
            change_journal,
        };
        if self.directory.join(MANIFEST_FILE).is_dir() {
            return Err(CatalogError::Unavailable {
                message: "manifest path is a directory".into(),
            });
        }
        publication_checkpoint("before_manifest")?;
        // Atomic rename may have happened before a later directory-sync error is returned.
        // Preserve the candidate on any publication error; reopening resolves its outcome.
        if let Some(guard) = &mut cleanup {
            guard.published = true;
        }
        if let Err(error) = publish_manifest(&self.directory, &manifest) {
            self.publication_uncertain = true;
            return Err(error);
        }
        publication_checkpoint("after_manifest")?;
        self.committed.take();
        cleanup_retired_snapshots(&self.directory, &manifest);
        self.manifest = Some(manifest);
        self.committed_from = committed_from;
        Ok(token.generation)
    }
    fn committed_changes(&mut self, changes: &super::catalog::RefreshChanges) {
        let from = self.committed_from.take();
        let record = from.and_then(|(base_generation, base_digest)| {
            let manifest = self.manifest.as_ref()?;
            let generation = manifest.summary.generation;
            (changes.complete
                && changes.base_generation.map(Generation::get) == Some(base_generation)
                && base_generation.checked_add(1) == Some(generation))
            .then_some(())?;
            Some(super::catalog_changes::ChangeRecord {
                generation,
                base_digest,
                digest: manifest_digest(manifest)?,
                changed: changes.changed.clone(),
                removed: changes.removed.clone(),
            })
        });
        // Without this generation's record no reader may chain across it.
        let kept = record
            .is_some_and(|record| super::catalog_changes::append(&self.directory, record).is_ok());
        if !kept {
            super::catalog_changes::clear(&self.directory);
        }
    }
    fn committing(&mut self, _token: &StagingToken, walked: bool) {
        self.committing_walked = walked;
    }
    fn discard_refresh(&mut self, token: StagingToken) -> Result<(), CatalogError> {
        self.journal_plan = None;
        if self.staging.is_some() {
            self.require_staging(&token)?;
            self.staging.take();
        }
        Ok(())
    }
    fn clear_for_rebuild(&mut self) -> Result<(), CatalogError> {
        if self.writer_lock.is_none() {
            return Err(CatalogError::Unavailable {
                message: "query Catalog cannot clear".into(),
            });
        }
        self.staging.take();
        self.committed.take();
        quarantine_directory(&self.directory)?;
        fs::create_dir_all(&self.directory).map_err(io_unavailable("recreate binary Catalog"))?;
        self.manifest = None;
        self.publication_uncertain = false;
        self.writes = CatalogWriteCounts::default();
        Ok(())
    }
    fn query(&self, request: &QueryRequest) -> Result<QueryPage, CatalogError> {
        let page = self.query_retaining(request);
        self.release_rows();
        page
    }

    fn count(
        &self,
        request: &super::catalog::CountRequest,
    ) -> Result<super::catalog::CountResult, CatalogError> {
        let count = self.count_retaining(request);
        self.release_rows();
        count
    }
}

impl BinaryCatalog {
    /// The committed generation's complete inventory digest, read from its manifest without
    /// decoding any snapshot chunks.
    pub(crate) fn inventory_digest(
        &self,
        project_id: &ProjectId,
        expected_generation: Generation,
    ) -> Result<Option<String>, CatalogError> {
        let manifest = require_manifest(&self.manifest, &self.project_id, project_id)?;
        let generation = Generation::new(manifest.summary.generation);
        if generation != expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: expected_generation,
                actual: generation,
            });
        }
        Ok(manifest_digest(manifest))
    }

    /// The package paths added, changed, removed, or affected by a sidecar change after the
    /// generation whose inventory digest was `since`, up to the committed generation; `None` when
    /// the Catalog's change log cannot say exactly or when `max_shards` is exceeded.
    ///
    /// Changed or removed sidecars are resolved against the committed generation to every live
    /// package sharing their exact stem (regardless of package extension casing), rather than
    /// guessing lowercase `.uasset`/`.umap` paths. When `max_shards` is set, resolution stops as
    /// soon as the known package paths exceed that shard budget, skipping sidecar chunk reads on
    /// broad refreshes that would fall back to a full inventory scan anyway.
    pub(crate) fn changes_since(
        &self,
        project_id: &ProjectId,
        expected_generation: Generation,
        since: &str,
        max_shards: Option<usize>,
    ) -> Result<Option<std::collections::BTreeSet<String>>, CatalogError> {
        let manifest = require_manifest(&self.manifest, &self.project_id, project_id)?;
        let generation = Generation::new(manifest.summary.generation);
        if generation != expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: expected_generation,
                actual: generation,
            });
        }
        let Some(raw_changes) = manifest_digest(manifest).and_then(|digest| {
            super::catalog_changes::since(&self.directory, since, generation.get(), &digest)
        }) else {
            return Ok(None);
        };
        let mut shard_mask = [0u64; 4];
        let mut shard_count = 0usize;
        let mut within_budget = |path: &str| -> bool {
            let Some(limit) = max_shards else {
                return true;
            };
            let group = game_text_index::package_text_plan::shard(path);
            let word = &mut shard_mask[group >> 6];
            let bit = 1u64 << (group & 63);
            if *word & bit == 0 {
                *word |= bit;
                shard_count += 1;
            }
            shard_count <= limit
        };
        let mut resolved = std::collections::BTreeSet::new();
        let mut sidecar_stems = std::collections::BTreeSet::new();
        for raw_path in raw_changes {
            let path = raw_path.replace('\\', "/");
            if let Some((stem, ext)) = path.rsplit_once('.')
                && super::inventory_digest::BUNDLE_SIDECARS
                    .iter()
                    .any(|sidecar| ext.eq_ignore_ascii_case(sidecar))
            {
                sidecar_stems.insert(stem.to_owned());
            } else {
                if !within_budget(&path) {
                    return Ok(None);
                }
                resolved.insert(path);
            }
        }
        if !sidecar_stems.is_empty() {
            let mut exceeded = false;
            let lookup = (|| {
                self.load()?;
                let cached = self.committed.borrow();
                let committed = cached
                    .as_ref()
                    .ok_or_else(|| corrupt("binary Catalog snapshot is not loaded"))?;
                for stem in &sidecar_stems {
                    for path in committed.live_packages_with_stem(stem)? {
                        if !within_budget(&path) {
                            exceeded = true;
                            return Ok(());
                        }
                        resolved.insert(path);
                    }
                }
                Ok::<(), CatalogError>(())
            })();
            self.release_rows();
            lookup?;
            if exceeded {
                return Ok(None);
            }
        }
        Ok(Some(resolved))
    }

    /// The packages at `paths` the committed generation holds, in path order, as
    /// [`BinaryCatalog::all_package_text_inventory`] lists them; paths that hold no package are
    /// left out.
    pub(crate) fn package_text_entries(
        &self,
        project_id: &ProjectId,
        expected_generation: Generation,
        paths: &std::collections::BTreeSet<String>,
        selected: impl Fn(Option<&uasset_inspection::package_header::PackageHeaderData>) -> bool,
    ) -> Result<Vec<game_text_index::package_text_contract::PackageTextExpected>, CatalogError>
    {
        let manifest = require_manifest(&self.manifest, &self.project_id, project_id)?;
        let generation = Generation::new(manifest.summary.generation);
        if generation != expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: expected_generation,
                actual: generation,
            });
        }
        let result = (|| {
            self.load()?;
            let cached = self.committed.borrow();
            let committed = cached
                .as_ref()
                .ok_or_else(|| corrupt("binary Catalog snapshot is not loaded"))?;
            let mut rows = Vec::new();
            for path in paths {
                if let Some(row) = committed.row_at(path)? {
                    rows.push(row);
                }
            }
            committed.load_rows(&rows)?;
            let mut packages = Vec::with_capacity(rows.len());
            for &(segment, id) in &rows {
                if committed.rows(segment)?.row(id)?.1.kind == EntryKind::Package {
                    packages.push((segment, id));
                }
            }
            let signatures = committed.bundle_signatures(&packages)?;
            let mut inventory = Vec::with_capacity(packages.len());
            for ((segment, id), signature) in packages.into_iter().zip(signatures) {
                let (path, entry) = committed.rows(segment)?.row(id)?;
                inventory.push(
                    game_text_index::package_text_contract::PackageTextExpected {
                        path: path.to_owned(),
                        signature,
                        selected: selected(entry.header_data.as_ref()),
                    },
                );
            }
            Ok(inventory)
        })();
        self.release_rows();
        result
    }

    /// Reads the entire committed generation's package-text inventory in path order directly from
    /// the binary snapshot chunks, without paged query round-trips.
    pub(crate) fn all_package_text_inventory(
        &self,
        project_id: &ProjectId,
        expected_generation: Generation,
        selected: impl Fn(Option<&uasset_inspection::package_header::PackageHeaderData>) -> bool + Sync,
    ) -> Result<Vec<game_text_index::package_text_contract::PackageTextExpected>, CatalogError>
    {
        let manifest = require_manifest(&self.manifest, &self.project_id, project_id)?;
        let generation = Generation::new(manifest.summary.generation);
        if generation != expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: expected_generation,
                actual: generation,
            });
        }
        let result = (|| {
            self.load()?;
            let cached = self.committed.borrow();
            let committed = cached
                .as_ref()
                .ok_or_else(|| corrupt("binary Catalog snapshot is not loaded"))?;
            let base = committed.base()?;
            base.load_all_chunks()?;
            if let Some(delta) = &committed.delta {
                delta.load_all_chunks()?;
                let hidden = committed.hidden();
                let mut rows = Vec::with_capacity(manifest.summary.package_count as usize);
                let (mut b, mut d) = (0usize, 0usize);
                while b < base.row_count || d < delta.row_count {
                    while b < base.row_count
                        && (hidden.hides(b) || base.entry(b)?.kind != EntryKind::Package)
                    {
                        b += 1;
                    }
                    while d < delta.row_count && delta.entry(d)?.kind != EntryKind::Package {
                        d += 1;
                    }
                    let next = match (b < base.row_count, d < delta.row_count) {
                        (true, true) => {
                            if delta.path(d)? < base.path(b)? {
                                let id = d;
                                d += 1;
                                (Segment::Delta, id)
                            } else {
                                let id = b;
                                b += 1;
                                (Segment::Base, id)
                            }
                        }
                        (true, false) => {
                            let id = b;
                            b += 1;
                            (Segment::Base, id)
                        }
                        (false, true) => {
                            let id = d;
                            d += 1;
                            (Segment::Delta, id)
                        }
                        (false, false) => break,
                    };
                    rows.push(next);
                }
                let signatures = committed.bundle_signatures(&rows)?;
                let mut inventory = Vec::with_capacity(rows.len());
                for ((segment, id), signature) in rows.into_iter().zip(signatures) {
                    let (path, entry) = committed.rows(segment)?.row(id)?;
                    inventory.push(
                        game_text_index::package_text_contract::PackageTextExpected {
                            path: path.to_owned(),
                            signature,
                            selected: selected(entry.header_data.as_ref()),
                        },
                    );
                }
                return Ok(inventory);
            }

            // Common base-only path: every chunk is already decoded in memory, so build
            // bundle signatures across chunk ranges in parallel without locking or RefCell.
            let row_count = base.row_count;
            let rows = base.rows()?;
            let chunks = rows
                .chunks
                .iter()
                .map(|cell| {
                    cell.get()
                        .ok_or_else(|| corrupt("decoded inventory chunk missing"))
                })
                .collect::<Result<Vec<&Chunk>, CatalogError>>()?;
            if chunks.is_empty() {
                return Ok(Vec::new());
            }
            let row_at = |id: usize| -> (&str, &InventoryEntry) {
                let chunk = chunks[id / ROW_INDEX_INTERVAL];
                let within = id % ROW_INDEX_INTERVAL;
                (chunk.paths.get(within), &chunk.entries[within])
            };
            let threads = codec_threads(chunks.len());
            let per_thread = chunks.len().div_ceil(threads).max(1);
            let mut parts: Vec<Vec<game_text_index::package_text_contract::PackageTextExpected>> =
                std::thread::scope(|scope| {
                    let mut handles = Vec::new();
                    for start_chunk in (0..chunks.len()).step_by(per_thread) {
                        let end_chunk = (start_chunk + per_thread).min(chunks.len());
                        let start_id = start_chunk * ROW_INDEX_INTERVAL;
                        let end_id = (end_chunk * ROW_INDEX_INTERVAL).min(row_count);
                        let selected_ref = &selected;
                        handles.push(scope.spawn(move || {
                            let mut out = Vec::with_capacity(end_id - start_id);
                            for id in start_id..end_id {
                                let (path, entry) = row_at(id);
                                if entry.kind != EntryKind::Package {
                                    continue;
                                }
                                let stem = path.rsplit_once('.').map_or(path, |(stem, _)| stem);
                                let mut parts =
                                    [Some((entry.size, entry.modified_nanos)), None, None, None];
                                let mut record_sidecar = |other: usize| {
                                    let (other_path, other_entry) = row_at(other);
                                    let ext = &other_path[stem.len() + 1..];
                                    if let Some(slot) = super::inventory_digest::BUNDLE_SIDECARS
                                        .iter()
                                        .position(|sidecar| *sidecar == ext)
                                    {
                                        parts[slot + 1] =
                                            Some((other_entry.size, other_entry.modified_nanos));
                                    }
                                };
                                let mut before = id;
                                while before > 0 && shares_stem(row_at(before - 1).0, stem) {
                                    before -= 1;
                                    record_sidecar(before);
                                }
                                let mut after = id + 1;
                                while after < row_count && shares_stem(row_at(after).0, stem) {
                                    record_sidecar(after);
                                    after += 1;
                                }
                                out.push(
                                    game_text_index::package_text_contract::PackageTextExpected {
                                        path: path.to_owned(),
                                        signature: bundle_signature(parts),
                                        selected: selected_ref(entry.header_data.as_ref()),
                                    },
                                );
                            }
                            out
                        }));
                    }
                    handles
                        .into_iter()
                        .map(|h| h.join().unwrap_or_else(|_| Vec::new()))
                        .collect()
                });
            let total: usize = parts.iter().map(Vec::len).sum();
            let mut inventory = Vec::with_capacity(total);
            for mut part in parts.drain(..) {
                inventory.append(&mut part);
            }
            Ok(inventory)
        })();
        self.release_rows();
        result
    }

    fn query_retaining(&self, request: &QueryRequest) -> Result<QueryPage, CatalogError> {
        let manifest = require_manifest(&self.manifest, &self.project_id, &request.project_id)?;
        validate_page_limit(request.limit)?;
        let generation = Generation::new(manifest.summary.generation);
        if generation != request.expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: request.expected_generation,
                actual: generation,
            });
        }
        let cursor = parse_page_cursor(request.cursor.as_deref())?;
        self.load()?;
        if matches!(
            request.kind,
            QueryKind::Dependencies { .. } | QueryKind::Dependents { .. }
        ) {
            let cached = self.committed.borrow();
            let committed = cached
                .as_ref()
                .ok_or_else(|| corrupt("binary Catalog snapshot is not loaded"))?;
            let graph = MergedGraph {
                committed,
                mounts: manifest.summary.mount_points(),
            };
            let (items, next_cursor) =
                dependency_page(&graph, &request.kind, &cursor, request.limit)?;
            return Ok(QueryPage {
                project_id: request.project_id.clone(),
                generation,
                items,
                next_cursor,
            });
        }
        validate_union_filters(&request.kind)?;
        let fields = request.fields;
        let matched = request.kind.serialized_name_values();
        let (items, next_cursor) = self.page(
            request,
            |item| item,
            |path, header, strings, _| {
                let text = |id: u32| strings.get(id as usize);
                QueryItem::Header {
                    header_data: if fields.header_data {
                        header.header_data.clone()
                    } else {
                        None
                    },
                    package_path: path.to_owned(),
                    package_name: header.package_name.to_owned(),
                    classes: if fields.classes {
                        header.class_ids().map(|id| text(id).to_owned()).collect()
                    } else {
                        Vec::new()
                    },
                    serialized_names: match fields.serialized_names {
                        NameField::All => header.name_ids().map(|id| text(id).to_owned()).collect(),
                        NameField::Matched => header
                            .name_ids()
                            .map(text)
                            .filter(|name| matched.contains(name))
                            .map(str::to_owned)
                            .collect(),
                        NameField::Omitted => Vec::new(),
                    },
                }
            },
        )?;
        Ok(QueryPage {
            project_id: request.project_id.clone(),
            generation,
            items,
            next_cursor,
        })
    }

    fn count_retaining(
        &self,
        request: &super::catalog::CountRequest,
    ) -> Result<super::catalog::CountResult, CatalogError> {
        super::catalog::validate_count_filters(&request.filters)?;
        let manifest = require_manifest(&self.manifest, &self.project_id, &request.project_id)?;
        let generation = Generation::new(manifest.summary.generation);
        if generation != request.expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: request.expected_generation,
                actual: generation,
            });
        }
        self.load()?;
        let cached = self.committed.borrow();
        let committed = cached
            .as_ref()
            .ok_or_else(|| corrupt("binary Catalog snapshot is not loaded"))?;
        Ok(super::catalog::CountResult {
            project_id: request.project_id.clone(),
            generation,
            count: committed.count(&request.filters)?,
        })
    }
}

fn committed_entry<'a>(handle: u32, path: &'a str, entry: &InventoryEntry) -> CommittedEntry<'a> {
    CommittedEntry {
        handle,
        relative_path: path,
        kind: entry.kind,
        size: entry.size,
        modified_nanos: entry.modified_nanos,
        header_profile_version: entry.profile,
        header_failure: entry.failure,
    }
}

/// Delta rows visited between base rows, as a merge in path order visits them.
struct DeltaVisits<'a> {
    rows: Option<&'a Snapshot>,
    next: usize,
    offset: usize,
}

impl DeltaVisits<'_> {
    /// Visits the delta rows before `until` (all of the rest for `None`).
    fn before(
        &mut self,
        until: Option<&str>,
        visit: &mut dyn FnMut(CommittedEntry<'_>) -> Result<(), CoordinatorError>,
    ) -> Result<(), CoordinatorError> {
        let Some(rows) = self.rows else {
            return Ok(());
        };
        while self.next < rows.row_count {
            let (path, entry) = rows.row(self.next)?;
            if until.is_some_and(|until| path >= until) {
                break;
            }
            let handle = u32::try_from(self.offset + self.next)
                .map_err(|_| corrupt("Catalog count exceeds u32"))?;
            visit(committed_entry(handle, path, entry))?;
            self.next += 1;
        }
        Ok(())
    }
}

impl CatalogSnapshot for BinaryCatalog {
    fn committed_entries(&self) -> Result<Vec<CatalogSnapshotEntry>, CatalogError> {
        let mut entries = Vec::new();
        self.visit_committed_entries(&mut |entry| {
            entries.push(CatalogSnapshotEntry {
                signature: PackageSignature {
                    relative_path: entry.relative_path.to_owned(),
                    kind: entry.kind,
                    size: entry.size,
                    modified_nanos: entry.modified_nanos,
                },
                header_profile_version: entry.header_profile_version,
                header_failure: entry.header_failure,
            });
            Ok(())
        })
        .map_err(|error| match error {
            CoordinatorError::Catalog(error) => error,
            other => CatalogError::Unavailable {
                message: other.to_string(),
            },
        })?;
        Ok(entries)
    }

    /// Decodes the committed base inventory as it visits it, unless it is decoded already: a
    /// refresh never holds it decoded. Delta rows are merged in between, and hidden base rows
    /// skipped.
    fn visit_committed_entries(
        &self,
        visit: &mut dyn FnMut(CommittedEntry<'_>) -> Result<(), CoordinatorError>,
    ) -> Result<(), CoordinatorError> {
        self.load()?;
        let cached = self.committed.borrow();
        let Some(committed) = cached.as_ref() else {
            return Ok(());
        };
        let base = &committed.base;
        let hidden = &committed.hidden().ids;
        let mut delta = DeltaVisits {
            rows: committed.delta.as_ref(),
            next: 0,
            offset: base.row_count,
        };
        let mut next_hidden = 0;
        let mut on_base =
            |id: usize,
             path: &str,
             entry: &InventoryEntry,
             visit: &mut dyn FnMut(CommittedEntry<'_>) -> Result<(), CoordinatorError>|
             -> Result<(), CoordinatorError> {
                delta.before(Some(path), visit)?;
                if hidden
                    .get(next_hidden)
                    .is_some_and(|hidden| *hidden as usize == id)
                {
                    next_hidden += 1;
                    return Ok(());
                }
                let handle = u32::try_from(id).map_err(|_| corrupt("Catalog count exceeds u32"))?;
                visit(committed_entry(handle, path, entry))
            };
        let mut visited = Ok(());
        with_section_prefetch(base, INVENTORY, |stream| {
            let mut stream = InventoryStream::over(stream);
            let mut id = 0;
            while let Some((path, entry)) = stream.next(base)? {
                if let Err(error) = on_base(id, path, &entry, visit) {
                    visited = Err(error);
                    return Ok(());
                }
                id += 1;
            }
            stream.finish(base)
        })?;
        visited?;
        delta.before(None, visit)
    }

    /// Finds the run through the base's row index and the delta's decoded rows, without decoding
    /// the base inventory.
    fn visit_committed_prefix(
        &self,
        prefix: &str,
        visit: &mut dyn FnMut(CommittedEntry<'_>) -> Result<(), CoordinatorError>,
    ) -> Result<(), CoordinatorError> {
        self.load()?;
        let cached = self.committed.borrow();
        let Some(committed) = cached.as_ref() else {
            return Ok(());
        };
        let hidden = committed.hidden();
        let base = committed
            .base
            .rows_with_prefix(prefix)?
            .into_iter()
            .filter(|(id, ..)| !hidden.hides(*id))
            .collect::<Vec<_>>();
        let delta_rows = committed.delta.as_ref();
        let mut delta = DeltaVisits {
            rows: delta_rows,
            next: delta_rows.map_or(Ok(0), |rows| rows.before(prefix))?,
            offset: committed.base.row_count,
        };
        let mut through_prefix =
            |visit: &mut dyn FnMut(CommittedEntry<'_>) -> Result<(), CoordinatorError>,
             until: Option<&str>|
             -> Result<(), CoordinatorError> {
                delta.before(until, &mut |entry| {
                    if entry.relative_path.starts_with(prefix) {
                        visit(entry)
                    } else {
                        Ok(())
                    }
                })
            };
        for (id, path, entry) in &base {
            through_prefix(visit, Some(path))?;
            let handle = u32::try_from(*id).map_err(|_| corrupt("Catalog count exceeds u32"))?;
            visit(committed_entry(handle, path, entry))?;
        }
        // The delta rows after the base's, up to the first past the run.
        if let Some(rows) = delta_rows {
            while delta.next < rows.row_count {
                let id = delta.next;
                let (path, entry) = rows.row(id)?;
                if !path.starts_with(prefix) {
                    break;
                }
                let handle = u32::try_from(delta.offset + id)
                    .map_err(|_| corrupt("Catalog count exceeds u32"))?;
                visit(committed_entry(handle, path, entry))?;
                delta.next += 1;
            }
        }
        Ok(())
    }

    fn observe_unchanged_except(
        &mut self,
        token: &StagingToken,
        handles: &[u32],
    ) -> Result<(), CoordinatorError> {
        self.require_staging(token)?;
        let staging = self.staging_mut()?;
        if staging.ordered.is_some() || staging.except.is_some() || !staging.kept.is_empty() {
            return Err(observed_after_ordered_staging().into());
        }
        let mut handles = handles.to_vec();
        handles.sort_unstable();
        handles.dedup();
        staging.except = Some(handles);
        Ok(())
    }

    /// A complete generation holds no header failure, and every commit records the profile all
    /// its evidence was read with.
    fn committed_evidence_is_current(&self) -> Result<bool, CoordinatorError> {
        Ok(self.manifest.as_ref().is_some_and(|manifest| {
            manifest.summary.completeness == "complete"
                && manifest.summary.index_profile == INDEX_PROFILE_VERSION
        }))
    }
}

/// A snapshot written for a commit.
struct Written {
    rows: usize,
    header: SnapshotHeader,
    /// The generation's package and map counts with this snapshot.
    counts: (u64, u64),
    /// The generation's inventory sum.
    inventory: InventorySum,
}

/// Writes the next generation's snapshot: for a base, the carried rows (base and delta records
/// copied) merged in path order with the changed ones; for a delta, the carried delta rows and the
/// changed ones, with tombstones for every base row the generation no longer carries. Entries
/// staged in path order were written as they arrived; others are sorted here, the last one staged
/// for a path winning.
fn write_snapshot(
    file: File,
    staging: Staging,
    committed: Option<&Committed>,
    manifest: Option<&Manifest>,
) -> Result<Written, CatalogError> {
    let Staging {
        missing_unchanged,
        changed,
        records,
        mut dictionary,
        ordered,
        carry,
        mode,
        mut delta_remap,
        ..
    } = staging;
    if missing_unchanged {
        return Err(corrupt("unchanged record missing from prior snapshot"));
    }
    let carry = carry.ok_or_else(|| corrupt("a commit without a settled carry"))?;
    if committed.is_none() && !carry.carries_nothing() {
        return Err(corrupt("unchanged record missing from prior snapshot"));
    }
    // A base that absorbs a delta copies the delta's records into its own strings.
    if mode == WriteMode::Full && committed.is_some_and(|committed| committed.delta.is_some()) {
        shared_dictionary(&mut dictionary, &mut delta_remap, mode, committed)?;
    }
    let (mut builder, mut cursor) = match ordered {
        Some(OrderedRows { cursor, builder }) => (
            builder.unwrap_or_else(|| SnapshotBuilder::new(mode)),
            cursor,
        ),
        None => (SnapshotBuilder::new(mode), KeptCursor::default()),
    };
    // Changed rows in path order; the last staged record for a path wins.
    let mut order = (0..changed.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| {
        changed[*a]
            .signature
            .relative_path
            .cmp(&changed[*b].signature.relative_path)
            .then(a.cmp(b))
    });
    order.dedup_by(|later, earlier| {
        if changed[*later].signature.relative_path == changed[*earlier].signature.relative_path {
            *earlier = *later;
            true
        } else {
            false
        }
    });
    for index in order {
        let staged = &changed[index];
        let source = Staging::kept_source(
            &carry,
            mode,
            delta_remap.as_deref(),
            dictionary.as_ref(),
            committed,
        );
        builder.copy_kept(&source, &mut cursor, Some(&staged.signature.relative_path))?;
        builder.push_staged(
            &staged.signature,
            &staged.meta,
            &records[staged.offset..staged.offset + staged.len],
            source.strings,
        )?;
    }
    drop(records);
    drop(changed);
    let source = Staging::kept_source(
        &carry,
        mode,
        delta_remap.as_deref(),
        dictionary.as_ref(),
        committed,
    );
    builder.copy_kept(&source, &mut cursor, None)?;
    drop(cursor);
    let prior = mode_prior(mode, committed);
    match mode {
        WriteMode::Full => {
            let inventory = builder.take_inventory_sum().unwrap_or_default();
            let (rows, header) = builder.finish(file, dictionary, prior, &Tombstones::default())?;
            Ok(Written {
                rows,
                counts: (header.packages, header.maps),
                header,
                inventory,
            })
        }
        WriteMode::Delta => {
            let committed = committed.ok_or_else(|| corrupt("a delta needs a committed base"))?;
            let manifest = manifest.ok_or_else(|| corrupt("a delta needs a committed base"))?;
            let recorded = builder.take_recorded();
            let (tombstones, inventory) = delta_tombstones(committed, &carry, &recorded, manifest)?;
            drop(recorded);
            let (rows, header) = builder.finish(file, dictionary, prior, &tombstones)?;
            let base = &committed.base.header;
            let counts = (
                (base.packages - tombstones.packages) + header.packages,
                (base.maps - tombstones.maps) + header.maps,
            );
            Ok(Written {
                rows,
                header,
                counts,
                inventory,
            })
        }
    }
}

/// A found row as the inventory sum reads it.
type DigestEntry<'a> = (&'a str, bool, (u64, u64), Option<&'a PackageHeaderData>);

fn digest_entry((_, path, entry): &committed::FoundRow) -> DigestEntry<'_> {
    (
        path.as_str(),
        entry.kind == EntryKind::Package,
        (entry.size, entry.modified_nanos),
        entry.header_data.as_ref(),
    )
}

/// A delta's tombstones (every base row the next generation does not carry) and the next
/// generation's inventory sum, updated from the committed one: each bundle whose entries the
/// refresh changed has its old leaves subtracted and its new ones added.
fn delta_tombstones(
    committed: &Committed,
    carry: &Carry,
    recorded: &[RecordedRow],
    manifest: &Manifest,
) -> Result<(Tombstones, InventorySum), CatalogError> {
    let base = &committed.base;
    let old = committed.hidden();
    let base_rows =
        u32::try_from(base.row_count).map_err(|_| corrupt("Catalog count exceeds u32"))?;
    let mut ids = Vec::new();
    let mut newly = Vec::new();
    match carry {
        Carry::Kept(handles) => {
            let mut kept = handles
                .iter()
                .copied()
                .take_while(|handle| *handle < base_rows)
                .peekable();
            let mut hidden = old.ids.iter().copied().peekable();
            for id in 0..base_rows {
                let carried = kept.next_if_eq(&id).is_some();
                if hidden.next_if_eq(&id).is_some() {
                    ids.push(id);
                } else if !carried {
                    ids.push(id);
                    newly.push(id);
                }
            }
        }
        Carry::AllExcept(handles) => {
            newly.extend(
                handles
                    .iter()
                    .copied()
                    .take_while(|handle| *handle < base_rows)
                    .filter(|handle| !old.hides(*handle as usize)),
            );
            ids = old.ids.clone();
            ids.extend(&newly);
            ids.sort_unstable();
        }
    }
    let mut stems = BTreeSet::new();
    let (mut packages, mut maps) = (old.packages, old.maps);
    base.load_chunks(newly.iter().map(|id| *id as usize))?;
    for id in &newly {
        let (path, entry) = base.row(*id as usize)?;
        packages += u64::from(entry.kind == EntryKind::Package);
        maps += u64::from(entry.is_map);
        if let Some(stem) = bundle_stem(path) {
            stems.insert(stem.to_owned());
        }
    }
    let old_rows = committed.delta.as_ref();
    if let Some(rows) = old_rows {
        for id in 0..rows.row_count {
            let handle = u32::try_from(base.row_count + id)
                .map_err(|_| corrupt("Catalog count exceeds u32"))?;
            if !carry.keeps(handle)
                && let Some(stem) = bundle_stem(rows.path(id)?)
            {
                stems.insert(stem.to_owned());
            }
        }
    }
    for row in recorded.iter().filter(|row| row.staged) {
        if let Some(stem) = bundle_stem(&row.path) {
            stems.insert(stem.to_owned());
        }
    }
    let mut inventory = manifest
        .summary
        .inventory()
        .ok_or_else(|| corrupt("invalid Catalog summary"))?;
    for stem in &stems {
        let prefix = format!("{stem}.");
        let found = base.rows_with_prefix(&prefix)?;
        let old_found = old_rows
            .map(|rows| rows.rows_with_prefix(&prefix))
            .transpose()?
            .unwrap_or_default();
        let old_delta = old_found.iter().map(digest_entry);
        let before = stem_sum(
            stem,
            found
                .iter()
                .filter(|(id, ..)| !old.hides(*id))
                .map(digest_entry)
                .chain(old_delta),
        );
        let start = recorded.partition_point(|row| row.path.as_str() < prefix.as_str());
        let new_delta = recorded[start..]
            .iter()
            .take_while(|row| row.path.starts_with(prefix.as_str()))
            .map(|row| {
                (
                    row.path.as_str(),
                    row.kind == EntryKind::Package,
                    (row.size, row.modified_nanos),
                    row.header_data.as_ref(),
                )
            });
        let after = stem_sum(
            stem,
            found
                .iter()
                .filter(|(id, ..)| {
                    u32::try_from(*id).is_ok_and(|id| ids.binary_search(&id).is_err())
                })
                .map(digest_entry)
                .chain(new_delta),
        );
        inventory.remove(&before);
        inventory.absorb(&after);
    }
    Ok((
        Tombstones {
            base: Some(base.fingerprint()),
            packages,
            maps,
            ids,
        },
        inventory,
    ))
}

impl Snapshot {
    /// A section's stored bytes as they are, with its header.
    fn stored_section(&self, index: usize) -> Result<StoredSection, CatalogError> {
        let section = self.header.sections[index];
        let start = self.header.starts()?[index];
        let mut stored = read_range(&mut self.file.borrow_mut(), start, section.stored)?;
        if checksum(&stored) != section.stored_hash {
            return Err(corrupt("binary section checksum mismatch"));
        }
        let index_bytes = (4 + section.length.div_ceil(BLOCK_BYTES) * 8) as usize;
        let blocks = stored.split_off(index_bytes.min(stored.len()));
        Ok(StoredSection {
            index: stored,
            blocks,
            header: section,
        })
    }
}

fn publication_checkpoint(_point: &str) -> Result<(), CatalogError> {
    #[cfg(test)]
    {
        if FAILURE_POINT.with(|point| point.get() == Some(_point)) {
            return Err(CatalogError::Unavailable {
                message: format!("injected IO failure at {_point}"),
            });
        }
        if std::env::var("UE_SHED_TEST_CRASH_POINT").ok().as_deref() == Some(_point) {
            let marker = std::env::var_os("UE_SHED_TEST_CRASH_MARKER").unwrap();
            fs::write(marker, _point).unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FAILURE_POINT: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}

/// Rereads a written snapshot: the header as written, the file length it implies, and every
/// stored byte against the stored checksums computed before writing.
fn verify_written(path: &Path, expected: &SnapshotHeader) -> Result<(), CatalogError> {
    let (_, header, _) = open_snapshot_file(path, SnapshotCheck::Stored)?;
    if header != *expected {
        return Err(corrupt("written snapshot header does not match"));
    }
    Ok(())
}

fn quarantine_directory(directory: &Path) -> Result<Option<PathBuf>, CatalogError> {
    if !directory.exists() {
        return Ok(None);
    }
    // Each quarantine gets a name of its own, so earlier quarantines never block a rebuild.
    for _ in 0..MAX_QUARANTINE_ATTEMPTS {
        let candidate =
            directory.with_extension(format!("quarantine-{}", game_text_index::store::token()));
        if candidate.exists() {
            continue;
        }
        match fs::rename(directory, &candidate) {
            Ok(()) => return Ok(Some(candidate)),
            Err(error) if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied => {
                // Windows can deny renaming a directory containing open reader handles even
                // though those files allow deletion/rename. Preserve each file in quarantine.
                // The caller holds the sibling writer lock; interrupted partial moves are
                // recoverable as a missing/corrupt manifest on the next writer open.
                fs::create_dir(&candidate).map_err(io_unavailable("create Catalog quarantine"))?;
                for entry in fs::read_dir(directory)
                    .map_err(io_unavailable("read Catalog quarantine source"))?
                {
                    let entry = entry.map_err(io_unavailable("read Catalog quarantine entry"))?;
                    fs::rename(entry.path(), candidate.join(entry.file_name()))
                        .map_err(io_unavailable("quarantine Catalog file"))?;
                }
                return Ok(Some(candidate));
            }
            Err(error) => return Err(io_unavailable("quarantine binary Catalog")(error)),
        }
    }
    Err(CatalogError::Unavailable {
        message: "could not find a free Catalog quarantine name".into(),
    })
}

fn publish_manifest(directory: &Path, manifest: &Manifest) -> Result<(), CatalogError> {
    let path = directory.join(MANIFEST_FILE);
    let mut file = AtomicWriteFile::open(&path)
        .map_err(io_unavailable("create the atomic Catalog manifest"))?;
    serde_json::to_writer(&mut file, manifest).map_err(|error| CatalogError::Unavailable {
        message: format!("could not encode the Catalog manifest: {error}"),
    })?;
    file.write_all(b"\n")
        .map_err(io_unavailable("finish the Catalog manifest"))?;
    file.commit()
        .map_err(io_unavailable("atomically publish the Catalog manifest"))?;
    publication_checkpoint("manifest_committed")
}

fn read_and_verify_manifest(
    directory: &Path,
    project_id: &ProjectId,
) -> Result<Option<Manifest>, CatalogError> {
    let path = directory.join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(None);
    }
    const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(io_unavailable("open the Catalog manifest"))?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_unavailable("read the Catalog manifest"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(corrupt("Catalog manifest exceeds 1 MiB"));
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|error| CatalogError::Corrupt {
            message: format!("the binary Catalog manifest is invalid: {error}"),
        })?;
    if manifest.manifest_schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.snapshot_schema_version != SNAPSHOT_SCHEMA_VERSION
        || manifest.project_id != project_id.as_str()
        || manifest
            .files()
            .into_iter()
            .flatten()
            .any(|name| !valid_snapshot_name(name))
    {
        return Err(CatalogError::Corrupt {
            message: "the binary Catalog manifest is incompatible or belongs to another project"
                .to_owned(),
        });
    }
    let current = [
        Some(&manifest.physical_snapshot),
        manifest.delta_snapshot.as_ref(),
    ];
    if current
        .into_iter()
        .flatten()
        .any(|name| !directory.join(name).is_file())
    {
        return Err(CatalogError::Corrupt {
            message: "the binary Catalog manifest names a missing snapshot".to_owned(),
        });
    }
    Ok(Some(manifest))
}

/// A complete generation's inventory digest, from its manifest.
fn manifest_digest(manifest: &Manifest) -> Option<String> {
    (manifest.summary.completeness == "complete")
        .then(|| {
            manifest
                .summary
                .inventory()
                .map(|sum| sum.digest(manifest.summary.package_count))
        })
        .flatten()
}

fn require_manifest<'a>(
    manifest: &'a Option<Manifest>,
    current_project: &ProjectId,
    requested_project: &ProjectId,
) -> Result<&'a Manifest, CatalogError> {
    if current_project != requested_project {
        return Err(CatalogError::InvalidRequest {
            message: "query project identity does not match the open Catalog".to_owned(),
        });
    }
    manifest
        .as_ref()
        .ok_or_else(|| CatalogError::InvalidRequest {
            message: "No committed Project Index generation matches that project identity."
                .to_owned(),
        })
}

fn cleanup_retired_snapshots(directory: &Path, manifest: &Manifest) {
    let retained = manifest.files();
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten().take(128) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if valid_snapshot_name(&name)
            && !retained.iter().flatten().any(|retained| *retained == name)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn snapshot_file_name(generation: Generation, mode: WriteMode) -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let kind = match mode {
        WriteMode::Full => "snapshot",
        WriteMode::Delta => "delta",
    };
    format!(
        "{kind}-{}-{}-{nonce}.catalog",
        generation.get(),
        std::process::id()
    )
}

fn valid_snapshot_name(name: &str) -> bool {
    (name.starts_with("snapshot-") || name.starts_with("delta-"))
        && name.ends_with(".catalog")
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.'))
}

fn catalog_directory_name(project_id: &ProjectId) -> String {
    format!("{:016x}", stable_hash(project_id.as_str()))
}

fn stable_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

fn encode_kind(kind: EntryKind) -> u8 {
    match kind {
        EntryKind::Package => 0,
        EntryKind::Sidecar => 1,
    }
}

fn decode_kind(kind: u8) -> EntryKind {
    if kind == 1 {
        EntryKind::Sidecar
    } else {
        EntryKind::Package
    }
}

fn remove_if_exists(path: &Path) -> Result<(), CatalogError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CatalogError::Unavailable {
            message: format!("could not remove an unpublished binary snapshot: {error}"),
        }),
    }
}

fn io_unavailable(operation: &'static str) -> impl FnOnce(std::io::Error) -> CatalogError {
    move |error| CatalogError::Unavailable {
        message: format!("could not {operation}: {error}"),
    }
}

#[cfg(test)]
impl Drop for BinaryCatalog {
    fn drop(&mut self) {
        self.staging.take();
        self.committed.take();
        self.writer_lock.take();
        if let Some(root) = self.cleanup_root.take() {
            let _ = fs::remove_dir_all(root);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cancellation::CancellationToken;
    use crate::direct_executor::catalog_conformance::{
        FIXTURE_PROJECT_ROOT, catalog_conformance_tests, fixture_project_id, refresh_fixture,
    };
    use crate::direct_executor::project_index::refresh;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    fn release_test_writer(catalog: &mut BinaryCatalog) {
        // Concurrent process tests can briefly inherit descriptors across fork/exec. Closing our
        // descriptor alone does not release flock while an inherited alias remains open.
        // These tests intentionally hand ownership to another writer, so unlock explicitly.
        catalog.writer_lock.take().unwrap().unlock().unwrap();
    }
    fn custom_catalog() -> BinaryCatalog {
        let root = std::env::temp_dir().join(format!(
            "ue-shed-binary-catalog-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut catalog = BinaryCatalog::open(&root, &fixture_project_id()).unwrap();
        catalog.cleanup_root = Some(root);
        catalog
    }
    catalog_conformance_tests!(binary, custom_catalog);

    /// A Catalog that writes a delta whenever a base is committed, so every conformance scenario
    /// also runs against merged base and delta segments.
    fn delta_catalog() -> BinaryCatalog {
        let mut catalog = custom_catalog();
        catalog.delta_limits = DeltaLimits {
            entries: usize::MAX,
            permille: usize::MAX / 1000,
            strings: u64::MAX,
        };
        catalog
    }
    catalog_conformance_tests!(binary_delta, delta_catalog);

    impl Snapshot {
        /// Every check a snapshot has: every stored byte, every section decoded and validated,
        /// and every block's decoded checksum.
        fn open_fully(path: &Path) -> Result<Self, CatalogError> {
            let snapshot = Self::open(path, SnapshotCheck::Stored)?;
            snapshot.load_all_chunks()?;
            // Every chunk read on its own, as a query reads it.
            let lazy = Self::open(path, SnapshotCheck::Header)?;
            for id in (0..lazy.row_count).step_by(ROW_INDEX_INTERVAL) {
                lazy.row(id)?;
            }
            snapshot.strings()?;
            snapshot.postings()?;
            for index in [LISTS, RECORDS] {
                snapshot.section(index)?;
            }
            Ok(snapshot)
        }
    }

    /// `bytes` (a whole snapshot) with section `index` replaced by `raw`, encoded and checksummed
    /// as the writer would, so every checksum in the result is valid.
    fn with_section(bytes: &[u8], index: usize, raw: &[u8]) -> Vec<u8> {
        let mut header = SnapshotHeader::decode(&bytes[..HEADER_BYTES as usize]).unwrap();
        let starts = header.starts().unwrap();
        let encoded = encode_section(raw).unwrap();
        let mut out: Vec<u8> = Vec::new();
        for section in 0..SECTIONS {
            if section == index {
                out.extend(&encoded.index);
                out.extend(&encoded.blocks);
            } else {
                let start = starts[section] as usize;
                out.extend(&bytes[start..start + header.sections[section].stored as usize]);
            }
        }
        header.sections[index] = encoded.header;
        let mut file = header.encode();
        file.extend(out);
        file
    }

    #[test]
    fn shared_string_pages_expand_to_the_plain_pages_in_first_use_order() {
        let mut catalog = custom_catalog();
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let generation = catalog.committed_generation().unwrap();
        let request = |kind: QueryKind, limit, cursor| QueryRequest {
            project_id: fixture_project_id(),
            expected_generation: generation,
            kind,
            limit,
            cursor,
            fields: HeaderFields::ALL,
        };
        let names = catalog
            .query(&request(
                QueryKind::ClassPrefixes {
                    values: vec![String::new()],
                },
                PROJECT_INDEX_MAX_PAGE_SIZE,
                None,
            ))
            .unwrap()
            .items
            .into_iter()
            .flat_map(|item| match item {
                QueryItem::Header {
                    serialized_names, ..
                } => serialized_names,
                _ => Vec::new(),
            })
            .collect::<Vec<_>>();
        assert!(!names.is_empty());
        let kinds = [
            QueryKind::Inventory,
            QueryKind::Maps,
            QueryKind::ClassPrefixes {
                values: vec![String::new()],
            },
            QueryKind::ClassNameSuffixes {
                values: vec![String::new()],
            },
            QueryKind::SerializedNames { values: names },
        ];
        for kind in kinds {
            for limit in [1, 2, PROJECT_INDEX_MAX_PAGE_SIZE] {
                let mut cursor = None;
                loop {
                    let plain = catalog
                        .query(&request(kind.clone(), limit, cursor.clone()))
                        .unwrap();
                    let shared = catalog
                        .query_shared_strings(&request(kind.clone(), limit, cursor))
                        .unwrap();
                    // Page strings are distinct and numbered in the order the page first uses
                    // them, as a page interned from owned strings numbers them.
                    let mut first_use = Vec::new();
                    let expanded = shared
                        .items
                        .iter()
                        .map(|item| match item.clone() {
                            SharedStringItem::Inventory {
                                package_path,
                                signature,
                                header_data,
                            } => QueryItem::Inventory {
                                package_path,
                                signature,
                                header_data,
                            },
                            SharedStringItem::Map {
                                map_path,
                                package_name,
                            } => QueryItem::Map {
                                map_path,
                                package_name,
                            },
                            SharedStringItem::Header {
                                header_data,
                                package_path,
                                package_name,
                                classes,
                                serialized_names,
                            } => {
                                for id in classes.iter().chain(&serialized_names) {
                                    if !first_use.contains(id) {
                                        first_use.push(*id);
                                    }
                                }
                                let text = |ids: Vec<u32>| {
                                    ids.into_iter()
                                        .map(|id| shared.strings[id as usize].clone())
                                        .collect()
                                };
                                QueryItem::Header {
                                    header_data,
                                    package_path,
                                    package_name,
                                    classes: text(classes),
                                    serialized_names: text(serialized_names),
                                }
                            }
                        })
                        .collect::<Vec<_>>();
                    assert_eq!(expanded, plain.items, "{kind:?} limit {limit}");
                    assert_eq!(shared.next_cursor, plain.next_cursor);
                    assert_eq!(
                        first_use,
                        (0..shared.strings.len() as u32).collect::<Vec<_>>()
                    );
                    cursor = plain.next_cursor;
                    if cursor.is_none() {
                        break;
                    }
                }
            }
        }
        assert!(matches!(
            catalog.query_shared_strings(&request(
                QueryKind::Dependencies {
                    paths: vec![],
                    transitive: false,
                    edges: EdgeFilter::default(),
                },
                1,
                None,
            )),
            Err(CatalogError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn repeated_unordered_staging_keeps_the_last_record_and_its_postings() {
        use crate::direct_executor::catalog_conformance::{header, package};
        let mut catalog = custom_catalog();
        let token = catalog.begin_refresh().unwrap();
        for (path, name) in [
            ("Content/Z.uasset", "Old"),
            ("Content/A.uasset", "Other"),
            ("Content/Z.uasset", "New"),
        ] {
            catalog
                .stage_observed(
                    &token,
                    StagedPackage {
                        signature: package(path, 1, 1),
                        header: Some(header("/Game/Fixture", &[], &[name])),
                    },
                )
                .unwrap();
        }
        let generation = token.generation;
        catalog
            .commit_refresh(
                token,
                RefreshSummary {
                    project_id: fixture_project_id(),
                    generation,
                    package_count: 2,
                    map_count: 0,
                    changed_packages: 2,
                    removed_packages: 0,
                    completeness: Completeness::Complete,
                    diagnostics: vec![],
                    omitted_diagnostics: 0,
                    mounts: vec![MountPoint::game()],
                    inventory_digest: None,
                },
            )
            .unwrap();
        assert_eq!(catalog.committed_entries().unwrap().len(), 2);
        for (name, expected) in [("Old", 0), ("New", 1), ("Other", 1)] {
            let page = catalog
                .query(&QueryRequest {
                    project_id: fixture_project_id(),
                    expected_generation: generation,
                    kind: QueryKind::SerializedNames {
                        values: vec![name.into()],
                    },
                    limit: 10,
                    cursor: None,
                    fields: HeaderFields::ALL,
                })
                .unwrap();
            assert_eq!(page.items.len(), expected, "{name}");
        }
    }

    #[test]
    fn deleting_only_a_sidecar_publishes_the_reduced_inventory() {
        use crate::direct_executor::catalog_conformance::sidecar;
        let mut catalog = custom_catalog();
        let mut scanner = refresh_fixture();
        scanner
            .entries
            .push(sidecar("Content/OnlySidecar.uexp", 12, 1));
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let previous = catalog.manifest.as_ref().unwrap().physical_snapshot.clone();
        let before = catalog.committed_entries().unwrap().len();
        scanner
            .entries
            .retain(|entry| entry.relative_path != "Content/OnlySidecar.uexp");
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        assert_eq!(catalog.committed_entries().unwrap().len(), before - 1);
        assert_ne!(
            catalog.manifest.as_ref().unwrap().physical_snapshot,
            previous
        );
        assert_eq!(
            catalog.manifest.as_ref().unwrap().summary.changed_packages,
            0
        );
        assert_eq!(
            catalog.manifest.as_ref().unwrap().summary.removed_packages,
            0
        );
    }

    #[test]
    fn counts_reject_stale_identity_bounds_and_late_posting_corruption() {
        use super::super::catalog::CountRequest;
        let mut catalog = custom_catalog();
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let request = CountRequest {
            project_id: fixture_project_id(),
            expected_generation: catalog.committed_generation().unwrap(),
            filters: vec![QueryKind::ClassPrefixes {
                values: vec!["".into()],
            }],
        };
        assert!(catalog.count(&request).unwrap().count > 0);
        assert!(matches!(
            catalog.count(&CountRequest {
                filters: vec![],
                ..request.clone()
            }),
            Err(CatalogError::InvalidRequest { .. })
        ));
        assert!(matches!(
            catalog.count(&CountRequest {
                project_id: ProjectId::new("other"),
                ..request.clone()
            }),
            Err(CatalogError::InvalidRequest { .. })
        ));
        assert!(matches!(
            catalog.count(&CountRequest {
                expected_generation: request.expected_generation.next(),
                ..request.clone()
            }),
            Err(CatalogError::StaleGeneration { .. })
        ));
        let committed = catalog.committed.borrow();
        let snapshot = &committed.as_ref().unwrap().base;
        // A byte of the first class posting: in place when its block is stored raw, else the
        // block's frame magic.
        let posting = snapshot
            .postings()
            .unwrap()
            .iter()
            .find(|p| p.kind == 0)
            .unwrap()
            .offset;
        let block = (posting / BLOCK_BYTES) as usize;
        let (start, stored) = snapshot.blocks[LISTS][block];
        let offset = if stored == block_length(snapshot.header.sections[LISTS].length, block) {
            start + posting % BLOCK_BYTES
        } else {
            start
        };
        let path = catalog
            .directory
            .join(&catalog.manifest.as_ref().unwrap().physical_snapshot);
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        let mut byte = [0];
        file.read_exact(&mut byte).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(&[byte[0] ^ 0x80]).unwrap();
        assert!(matches!(
            catalog.count(&request),
            Err(CatalogError::Corrupt { .. })
        ));
    }

    #[test]
    fn snapshot_name_collision_never_acquires_cleanup_ownership() {
        let owner = custom_catalog();
        let path = owner.directory.join("existing.catalog");
        fs::write(&path, b"existing snapshot").unwrap();
        assert!(create_unpublished(&path).is_err());
        assert_eq!(fs::read(path).unwrap(), b"existing snapshot");
    }

    #[test]
    fn uncertain_publication_keeps_the_visible_snapshot_and_requires_reopen() {
        let mut owner = custom_catalog();
        let root = owner.cleanup_root.as_ref().unwrap().clone();
        FAILURE_POINT.with(|p| p.set(Some("manifest_committed")));
        let result = refresh(
            &mut owner,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        );
        FAILURE_POINT.with(|p| p.set(None));
        assert!(result.is_err());
        assert!(owner.begin_refresh().is_err());
        release_test_writer(&mut owner);
        let mut recovered = BinaryCatalog::open(&root, &fixture_project_id()).unwrap();
        assert_eq!(recovered.committed_generation(), Some(Generation::new(1)));
        assert!(recovered.quarantined_from().is_none());
        refresh(
            &mut recovered,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        assert_eq!(recovered.committed_generation(), Some(Generation::new(2)));
    }

    #[test]
    fn reader_pins_its_file_before_its_first_query() {
        use crate::direct_executor::catalog_conformance::collect_pages;
        let mut writer = custom_catalog();
        let mut scanner = refresh_fixture();
        refresh(
            &mut writer,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let generation = writer.committed_generation().unwrap();
        let maps = collect_pages(&writer, generation, QueryKind::Maps, 1);
        let reader = BinaryCatalog::open_for_query(
            writer.cleanup_root.as_ref().unwrap(),
            &fixture_project_id(),
        )
        .unwrap();
        for _ in 0..3 {
            scanner.entries[0].modified_nanos += 1;
            refresh(
                &mut writer,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .unwrap();
        }
        assert_eq!(collect_pages(&reader, generation, QueryKind::Maps, 1), maps);
    }

    #[test]
    fn invalid_summary_and_oversized_manifest_recover_without_unbounded_reads() {
        for oversized in [false, true] {
            let mut owner = custom_catalog();
            refresh(
                &mut owner,
                &refresh_fixture(),
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .unwrap();
            let path = owner.directory.join(MANIFEST_FILE);
            if oversized {
                fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
            } else {
                let mut manifest: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                manifest["summary"]["package_count"] = 999999.into();
                fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            }
            owner.committed.take();
            // Model a descriptor alias still alive during an unrelated process spawn.
            let _inherited = owner.writer_lock.as_ref().unwrap().try_clone().unwrap();
            release_test_writer(&mut owner);
            let recovered =
                BinaryCatalog::open(owner.cleanup_root.as_ref().unwrap(), &fixture_project_id())
                    .unwrap();
            assert_eq!(recovered.status(), CatalogStatus::Absent);
            assert!(recovered.quarantined_from().is_some());
        }
    }

    #[test]
    fn writer_exclusion_survives_clear_and_readers_cannot_mutate() {
        let mut writer = custom_catalog();
        let root = writer.cleanup_root.as_ref().unwrap().clone();
        assert!(BinaryCatalog::open(&root, &fixture_project_id()).is_err());
        let mut reader = BinaryCatalog::open_for_query(&root, &fixture_project_id()).unwrap();
        assert!(reader.begin_refresh().is_err());
        assert!(reader.clear_for_rebuild().is_err());
        writer.clear_for_rebuild().unwrap();
        assert!(BinaryCatalog::open(&root, &fixture_project_id()).is_err());
        release_test_writer(&mut writer);
        assert!(BinaryCatalog::open(&root, &fixture_project_id()).is_ok());
    }

    #[test]
    fn status_reads_the_committed_catalog_while_a_writer_holds_it() {
        // A2.1: status during a refresh shows the last committed catalog instead of failing.
        let mut catalog = custom_catalog();
        let root = catalog.cleanup_root.as_ref().unwrap().clone();
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let generation = catalog.committed_generation().unwrap();
        let status = BinaryCatalog::open_for_status(&root, &fixture_project_id(), None).unwrap();
        assert_eq!(status.committed_generation(), Some(generation));
        assert!(BinaryCatalog::open(&root, &fixture_project_id()).is_err());
        release_test_writer(&mut catalog);
    }

    #[test]
    fn status_of_a_missing_catalog_creates_nothing() {
        // A2.1: asking whether a project has an index must not create one.
        let root = std::env::temp_dir().join(format!(
            "ue-shed-binary-catalog-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let status = BinaryCatalog::open_for_status(&root, &fixture_project_id(), None).unwrap();
        assert_eq!(status.committed_generation(), None);
        assert!(!root.exists());
    }

    #[test]
    fn rebuild_succeeds_with_every_old_quarantine_slot_occupied() {
        // A2.3: earlier rebuilds leave quarantined catalogs behind; they must never block the next.
        let mut writer = custom_catalog();
        let directory = writer.directory.clone();
        for slot in 0..64 {
            fs::create_dir_all(directory.with_extension(format!("quarantine-{slot}"))).unwrap();
        }
        writer.clear_for_rebuild().unwrap();
        writer.clear_for_rebuild().unwrap();
        assert!(directory.is_dir());
        release_test_writer(&mut writer);
    }

    #[test]
    fn failed_writes_and_sync_preserve_the_previous_generation() {
        use crate::direct_executor::catalog_conformance::collect_pages;
        for point in [
            "snapshot_created",
            "snapshot_partial",
            "before_sync",
            "after_sync",
            "before_manifest",
        ] {
            let mut writer = custom_catalog();
            let mut scanner = refresh_fixture();
            refresh(
                &mut writer,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .unwrap();
            let before = fs::read(writer.directory.join(MANIFEST_FILE)).unwrap();
            let reader = BinaryCatalog::open_for_query(
                writer.cleanup_root.as_ref().unwrap(),
                &fixture_project_id(),
            )
            .unwrap();
            let generation = reader.committed_generation().unwrap();
            let maps = collect_pages(&reader, generation, QueryKind::Maps, 1);
            scanner.entries[0].modified_nanos += 1;
            FAILURE_POINT.with(|p| p.set(Some(point)));
            let outcome = refresh(
                &mut writer,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            );
            FAILURE_POINT.with(|p| p.set(None));
            assert!(outcome.is_err(), "{point}");
            assert_eq!(
                fs::read(writer.directory.join(MANIFEST_FILE)).unwrap(),
                before
            );
            assert_eq!(collect_pages(&reader, generation, QueryKind::Maps, 1), maps);
            assert_eq!(
                fs::read_dir(&writer.directory).unwrap().count(),
                2,
                "unpublished file leaked at {point}"
            );
            refresh(
                &mut writer,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .unwrap();
            assert_eq!(writer.committed_generation(), Some(generation.next()));
        }
    }

    /// Flips the last stored byte of the records of the catalog's base snapshot, keeping or
    /// moving its modification time.
    fn damage_records(directory: &Path, manifest: &Manifest, keep_modified: bool) {
        let path = directory.join(&manifest.physical_snapshot);
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let header = SnapshotHeader::decode(&bytes[..HEADER_BYTES as usize]).unwrap();
        let end = header.starts().unwrap()[RECORDS] + header.sections[RECORDS].stored;
        bytes[end as usize - 1] ^= 0x40;
        fs::write(&path, bytes).unwrap();
        let file = File::options().write(true).open(&path).unwrap();
        file.set_modified(if keep_modified {
            modified
        } else {
            modified + Duration::from_secs(2)
        })
        .unwrap();
    }

    #[test]
    fn folded_order_matches_folding_every_byte() {
        let reference = |left: &str, right: &str| {
            left.bytes()
                .map(|byte| byte.to_ascii_lowercase())
                .cmp(right.bytes().map(|byte| byte.to_ascii_lowercase()))
        };
        let stems = [
            "",
            "/Game/Characters/Hero/SK_Hero",
            "/game/characters/hero/sk_hero",
            "/Game/Characters/Hero/SK_Hero_Physics",
            "/Game/Characters/Hero/SK_HERO",
            "/Game/Characters/Hero/",
            "/Game/Characters/Hero/Ä_Hero",
            "/Script/Engine.DataTable",
            "/Script/Engine.Datatable",
            "a",
            "A",
            "_",
            "Z_",
        ];
        let mut values = stems
            .iter()
            .map(|stem| stem.to_string())
            .collect::<Vec<_>>();
        for stem in stems {
            for suffix in ["", "x", "X", "_1", "[", "a_b_c_d_e_f_g_h_i"] {
                values.push(format!("{stem}{suffix}"));
            }
        }
        for left in &values {
            for right in &values {
                assert_eq!(
                    folded_order(left, right),
                    reference(left, right),
                    "{left} {right}"
                );
                assert_eq!(
                    common_prefix_len(left.as_bytes(), right.as_bytes()),
                    left.bytes()
                        .zip(right.bytes())
                        .take_while(|(a, b)| a == b)
                        .count()
                );
            }
        }
    }

    #[test]
    fn a_recorded_snapshot_is_reverified_once_it_changes() {
        // A process that recorded a snapshot as verified (here, as its writer wrote it) checks
        // it in full again once its file changes: a refresh still quarantines the damage.
        let mut writer = custom_catalog();
        let root = writer.cleanup_root.as_ref().unwrap().clone();
        writer.verified = Some(VerifiedSnapshots::default());
        refresh(
            &mut writer,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let record = writer.take_verified().unwrap();
        let manifest = writer.manifest.clone().unwrap();
        let base = SnapshotStamp::of(&writer.directory.join(&manifest.physical_snapshot)).unwrap();
        assert!(record.contains(&base));
        release_test_writer(&mut writer);
        let mut reopened =
            BinaryCatalog::open_with_verified(&root, &fixture_project_id(), record).unwrap();
        assert!(reopened.quarantined_from().is_none());
        let record = reopened.take_verified().unwrap();
        release_test_writer(&mut reopened);
        drop(reopened);
        damage_records(&writer.directory, &manifest, false);
        let mut status_record = VerifiedSnapshots::default();
        status_record.record(base.clone());
        let status =
            BinaryCatalog::open_for_status(&root, &fixture_project_id(), Some(&mut status_record))
                .unwrap();
        assert_eq!(status.status(), CatalogStatus::Absent);
        let recovered =
            BinaryCatalog::open_with_verified(&root, &fixture_project_id(), record).unwrap();
        assert!(recovered.quarantined_from().is_some());
        assert_eq!(recovered.status(), CatalogStatus::Absent);
    }

    #[test]
    fn a_recorded_unchanged_snapshot_is_not_reread() {
        // The record is what lets a long-lived process skip the full check: damage that leaves
        // the file's stamp as it was is found by a process without the record, and by the
        // block checks of whatever reads the damaged block.
        let mut writer = custom_catalog();
        let root = writer.cleanup_root.as_ref().unwrap().clone();
        writer.verified = Some(VerifiedSnapshots::default());
        refresh(
            &mut writer,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let record = writer.take_verified().unwrap();
        let manifest = writer.manifest.clone().unwrap();
        release_test_writer(&mut writer);
        damage_records(&writer.directory, &manifest, true);
        let mut reopened =
            BinaryCatalog::open_with_verified(&root, &fixture_project_id(), record).unwrap();
        assert!(reopened.quarantined_from().is_none());
        assert!(reopened.committed_generation().is_some());
        reopened.load().unwrap();
        {
            let committed = reopened.committed.borrow();
            let snapshot = &committed.as_ref().unwrap().base;
            assert!(snapshot.packed(snapshot.row_count - 1).is_err());
        }
        release_test_writer(&mut reopened);
        drop(reopened);
        let recovered = BinaryCatalog::open(&root, &fixture_project_id()).unwrap();
        assert!(recovered.quarantined_from().is_some());
    }

    #[test]
    fn damaged_payload_is_reported_to_queries_and_quarantined_by_refresh() {
        let mut writer = custom_catalog();
        let root = writer.cleanup_root.as_ref().unwrap().clone();
        refresh(
            &mut writer,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let path = writer
            .directory
            .join(&writer.manifest.as_ref().unwrap().physical_snapshot);
        let mut bytes = fs::read(&path).unwrap();
        // The last stored byte of the records.
        let header = SnapshotHeader::decode(&bytes[..HEADER_BYTES as usize]).unwrap();
        let end = header.starts().unwrap()[RECORDS] + header.sections[RECORDS].stored;
        bytes[end as usize - 1] ^= 0x40;
        fs::write(&path, bytes).unwrap();
        writer.committed.take();
        release_test_writer(&mut writer);
        let reader = BinaryCatalog::open_for_query(&root, &fixture_project_id()).unwrap();
        reader.load().unwrap();
        let committed = reader.committed.borrow();
        let snapshot = &committed.as_ref().unwrap().base;
        assert!(snapshot.packed(snapshot.row_count - 1).is_err());
        let mut recovered = BinaryCatalog::open(&root, &fixture_project_id()).unwrap();
        assert!(recovered.quarantined_from().is_some());
        assert_eq!(recovered.status(), CatalogStatus::Absent);
        refresh(
            &mut recovered,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        assert_eq!(recovered.committed_generation(), Some(Generation::new(1)));
    }

    #[test]
    fn corrupt_manifest_queries_never_quarantine_under_a_writer() {
        let writer = custom_catalog();
        fs::write(writer.directory.join(MANIFEST_FILE), b"{").unwrap();
        assert!(
            BinaryCatalog::open_for_query(
                writer.cleanup_root.as_ref().unwrap(),
                &fixture_project_id()
            )
            .is_err()
        );
        assert!(writer.directory.join(MANIFEST_FILE).is_file());
    }

    // Executed only by the parent crash test in an isolated child process.
    #[test]
    #[ignore]
    fn crash_writer_child() {
        let root = PathBuf::from(std::env::var_os("UE_SHED_TEST_CRASH_ROOT").unwrap());
        let mut writer = BinaryCatalog::open(&root, &fixture_project_id()).unwrap();
        let mut scanner = refresh_fixture();
        scanner.entries[0].modified_nanos += 1;
        refresh(
            &mut writer,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        panic!("crash checkpoint was not reached");
    }

    #[test]
    fn process_termination_preserves_atomic_publication_and_releases_writer() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        for existing in [false, true] {
            for point in [
                "snapshot_created",
                "snapshot_partial",
                "before_sync",
                "after_sync",
                "before_manifest",
                "after_manifest",
            ] {
                let mut owner = custom_catalog();
                let root = owner.cleanup_root.as_ref().unwrap().clone();
                if existing {
                    refresh(
                        &mut owner,
                        &refresh_fixture(),
                        FIXTURE_PROJECT_ROOT,
                        &CancellationToken::new(),
                        |_| {},
                    )
                    .unwrap();
                }
                owner.committed.take();
                release_test_writer(&mut owner);
                let marker = root.join("checkpoint");
                let mut child = Child(
                    std::process::Command::new(std::env::current_exe().unwrap())
                        .args([
                            "--exact",
                            "direct_executor::catalog_binary::tests::crash_writer_child",
                            "--ignored",
                        ])
                        .env("UE_SHED_TEST_CRASH_ROOT", &root)
                        .env("UE_SHED_TEST_CRASH_POINT", point)
                        .env("UE_SHED_TEST_CRASH_MARKER", &marker)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .unwrap(),
                );
                let deadline = Instant::now() + Duration::from_secs(15);
                while !marker.is_file() && Instant::now() < deadline {
                    assert!(
                        child.0.try_wait().unwrap().is_none(),
                        "child exited before {point}"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(marker.is_file(), "child never reached {point}");
                child.0.kill().unwrap();
                child.0.wait().unwrap();
                let mut recovered = BinaryCatalog::open(&root, &fixture_project_id()).unwrap();
                let expected = if point == "after_manifest" {
                    Some(Generation::new(if existing { 2 } else { 1 }))
                } else if existing {
                    Some(Generation::new(1))
                } else {
                    None
                };
                assert_eq!(
                    recovered.committed_generation(),
                    expected,
                    "existing={existing}, {point}"
                );
                assert!(
                    recovered.quarantined_from().is_none(),
                    "valid committed state was quarantined"
                );
                refresh(
                    &mut recovered,
                    &refresh_fixture(),
                    FIXTURE_PROJECT_ROOT,
                    &CancellationToken::new(),
                    |_| {},
                )
                .unwrap();
            }
        }
    }

    #[test]
    fn query_readers_decode_only_the_chunks_they_read_and_check_each() {
        use crate::direct_executor::catalog_conformance::{FakeScanner, header, package};
        let mut writer = custom_catalog();
        let root = writer.cleanup_root.clone().unwrap();
        let mut scanner = FakeScanner::default();
        for id in 0..600_u64 {
            let extension = if id % 50 == 7 { "umap" } else { "uasset" };
            let path = format!("Content/{id:04}.{extension}");
            scanner.entries.push(package(&path, id + 1, 1));
            scanner.headers.insert(
                path,
                header(
                    &format!("/Game/{id:04}"),
                    &["/Script/Test.Widget"],
                    &["None"],
                ),
            );
        }
        refresh(
            &mut writer,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let generation = writer.committed_generation().unwrap();
        let path = writer
            .directory
            .join(&writer.manifest.as_ref().unwrap().physical_snapshot);
        release_test_writer(&mut writer);
        let query = |catalog: &BinaryCatalog, kind: QueryKind, cursor: &str, limit: usize| {
            catalog.query(&QueryRequest {
                project_id: fixture_project_id(),
                expected_generation: generation,
                kind,
                limit,
                cursor: (!cursor.is_empty()).then(|| cursor.to_owned()),
                fields: HeaderFields::ALL,
            })
        };
        let decoded = |catalog: &BinaryCatalog| {
            let committed = catalog.committed.borrow();
            let rows = committed.as_ref().unwrap().base.rows.get().unwrap();
            rows.chunks
                .iter()
                .enumerate()
                .filter(|(_, chunk)| chunk.get().is_some())
                .map(|(index, _)| index)
                .collect::<Vec<_>>()
        };
        // A page after a cursor deep in the inventory decodes the chunk its rows are in.
        let reader = BinaryCatalog::open_for_query(&root, &fixture_project_id()).unwrap();
        let page = query(&reader, QueryKind::Inventory, "Content/0300.uasset", 3).unwrap();
        let paths = page
            .items
            .iter()
            .map(|item| match item {
                QueryItem::Inventory { package_path, .. } => package_path.as_str(),
                _ => unreachable!(),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            [
                "Content/0301.uasset",
                "Content/0302.uasset",
                "Content/0303.uasset"
            ]
        );
        assert_eq!(decoded(&reader), [300 / ROW_INDEX_INTERVAL]);
        // Maps come from the row index's list; only their own chunks are read.
        let maps = query(
            &BinaryCatalog::open_for_query(&root, &fixture_project_id()).unwrap(),
            QueryKind::Maps,
            "",
            1024,
        )
        .unwrap();
        assert_eq!(maps.items.len(), 12);
        // Released chunks are decoded again when next read.
        reader
            .committed
            .borrow_mut()
            .as_mut()
            .unwrap()
            .release_rows_over(0);
        assert!(decoded(&reader).is_empty());
        assert_eq!(
            query(&reader, QueryKind::Inventory, "Content/0300.uasset", 3)
                .unwrap()
                .items,
            page.items
        );
        // A changed row in one chunk, in an inventory whose section checksums are valid: only a
        // query reading that chunk fails.
        let bytes = fs::read(&path).unwrap();
        let mut raw = Snapshot::open(&path, SnapshotCheck::Stored)
            .unwrap()
            .section(INVENTORY)
            .unwrap();
        let target = b"Content/0450.uasset";
        let at = raw
            .windows(target.len())
            .position(|window| window == target)
            .unwrap();
        // The row's size follows its path and kind.
        raw[at + target.len() + 1] ^= 1;
        fs::write(&path, with_section(&bytes, INVENTORY, &raw)).unwrap();
        let damaged = BinaryCatalog::open_for_query(&root, &fixture_project_id()).unwrap();
        assert!(query(&damaged, QueryKind::Inventory, "", 3).is_ok());
        assert!(matches!(
            query(&damaged, QueryKind::Inventory, "Content/0440.uasset", 3),
            Err(CatalogError::Corrupt { .. })
        ));
    }

    #[test]
    fn deterministic_mutation_sequences_match_memory_catalog_on_every_page() {
        mutation_sequence(0, 30, &[1, 7, 1024]);
    }

    /// The same sequence with unchanging packages (some with sidecars, some maps) between the
    /// changing ones, so the inventory spans several chunks: cursors, bundle sidecars, hidden
    /// rows and delta merges cross chunk boundaries.
    #[test]
    fn mutation_sequences_across_inventory_chunks_match_memory_catalog() {
        mutation_sequence(6, 12, &[7, 300]);
    }

    /// Every header filter of the mutation sequence's queries, as one union's filters.
    fn kinds_for_union(generation: u64) -> Vec<QueryKind> {
        vec![
            QueryKind::ExactClasses {
                values: vec!["/Script/Test.Widget".into(), "NoDot".into()],
            },
            QueryKind::ClassPrefixes {
                values: vec!["/Script/Test.".into(), "\u{e9}".into()],
            },
            QueryKind::ClassNameSuffixes {
                values: vec!["Widget".into(), "\u{1f527}".into()],
            },
            QueryKind::SerializedNames {
                values: vec!["None".into(), "None".into()],
            },
            QueryKind::SerializedNames {
                values: vec!["Rare".into(), "absent".into()],
            },
            QueryKind::SerializedNames {
                values: vec!["\u{e9}".into(), format!("V{}", generation / 2)],
            },
            QueryKind::SerializedNames { values: vec![] },
        ]
    }

    /// Every dictionary page of a query, expanded to plain items. Each page names exactly the
    /// strings its items use.
    fn collect_shared_pages(
        catalog: &BinaryCatalog,
        generation: Generation,
        kind: QueryKind,
        limit: usize,
        fields: HeaderFields,
    ) -> Vec<QueryItem> {
        let mut items = Vec::new();
        let mut cursor = None;
        loop {
            let page = catalog
                .query_shared_strings(&QueryRequest {
                    project_id: fixture_project_id(),
                    expected_generation: generation,
                    kind: kind.clone(),
                    limit,
                    cursor,
                    fields,
                })
                .unwrap();
            let text = |ids: Vec<u32>| -> Vec<String> {
                ids.into_iter()
                    .map(|id| page.strings[id as usize].clone())
                    .collect()
            };
            let mut used = BTreeSet::new();
            for item in page.items.iter().cloned() {
                items.push(match item {
                    SharedStringItem::Inventory {
                        package_path,
                        signature,
                        header_data,
                    } => QueryItem::Inventory {
                        package_path,
                        signature,
                        header_data,
                    },
                    SharedStringItem::Map {
                        map_path,
                        package_name,
                    } => QueryItem::Map {
                        map_path,
                        package_name,
                    },
                    SharedStringItem::Header {
                        header_data,
                        package_path,
                        package_name,
                        classes,
                        serialized_names,
                    } => {
                        used.extend(classes.iter().chain(&serialized_names).copied());
                        QueryItem::Header {
                            header_data,
                            package_path,
                            package_name,
                            classes: text(classes),
                            serialized_names: text(serialized_names),
                        }
                    }
                });
            }
            assert_eq!(used.len(), page.strings.len());
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        items
    }

    /// The change log against whole inventories: from each of the last few complete generations,
    /// every package whose package-text entry differs now is among the resolved changes, and the
    /// targeted entries of those changes are the inventory's. The generation right after a
    /// complete one always has its changes.
    fn check_package_text_changes(
        catalogs: &[&BinaryCatalog],
        history: &mut Vec<(
            Option<String>,
            Vec<game_text_index::package_text_contract::PackageTextExpected>,
        )>,
        generation: u64,
    ) {
        use crate::direct_executor::project_index_io::gathered;
        let project = fixture_project_id();
        let current = catalogs[0].committed_generation().unwrap();
        let inventory = catalogs[0]
            .all_package_text_inventory(&project, current, gathered)
            .unwrap();
        let digest = catalogs[0].inventory_digest(&project, current).unwrap();
        let now = inventory
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect::<std::collections::BTreeMap<_, _>>();
        for (back, (since, before)) in history.iter().rev().enumerate().take(4) {
            let Some(since) = since else {
                continue;
            };
            let then = before
                .iter()
                .map(|entry| (entry.path.as_str(), entry))
                .collect::<std::collections::BTreeMap<_, _>>();
            for catalog in catalogs {
                let changes = catalog
                    .changes_since(&project, current, since, None)
                    .unwrap();
                if back == 0 && digest.is_some() {
                    assert!(changes.is_some(), "generation {generation}");
                }
                let Some(changes) = changes else {
                    continue;
                };
                for path in then.keys().chain(now.keys()) {
                    if then.get(path) != now.get(path) {
                        assert!(
                            changes.contains(*path),
                            "generation {generation}, {back} back: {path}"
                        );
                    }
                }
                assert_eq!(
                    catalog
                        .package_text_entries(&project, current, &changes, gathered)
                        .unwrap(),
                    inventory
                        .iter()
                        .filter(|entry| changes.contains(&entry.path))
                        .cloned()
                        .collect::<Vec<_>>(),
                    "generation {generation}, {back} back"
                );
            }
        }
        history.push((digest, inventory));
    }

    /// Runs `generations` refreshes of random mutations, with `fillers` unchanging packages after
    /// each changing one, and compares every page of `page_limits` with the memory Catalog.
    fn mutation_sequence(fillers: u64, generations: u64, page_limits: &[usize]) {
        use crate::direct_executor::catalog_conformance::{
            FakeScanner, collect_pages, collect_projected_pages, completed_changes, header,
            package, sidecar,
        };
        use crate::direct_executor::catalog_memory::MemoryCatalog;
        use crate::direct_executor::project_index::{RefreshReach, refresh_changed_paths};
        // Limits small enough that the sequence writes deltas over several generations, compacts
        // when they grow, and writes deltas over the new base again.
        let limits = DeltaLimits {
            entries: 40,
            permille: 1000,
            strings: u64::MAX,
        };
        // `binary` walks the project; `targeted` is told the changed paths.
        let mut binary = custom_catalog();
        binary.delta_limits = limits;
        let mut targeted = custom_catalog();
        targeted.delta_limits = limits;
        let mut memory = MemoryCatalog::new();
        // Package id -> its version, sidecar id -> its own version, and orphan sidecars.
        let mut state = std::collections::BTreeMap::new();
        let mut sidecars = std::collections::BTreeMap::new();
        let mut orphans = std::collections::BTreeSet::new();
        let mut random = 0x123456789abcdef_u64;
        let package_path = |id: u64| {
            format!(
                "Content/{id:04}.{}",
                if id.is_multiple_of(9) {
                    "umap"
                } else {
                    "uasset"
                }
            )
        };
        let mut writes = Vec::new();
        let mut previous_complete = false;
        let mut package_text_history = Vec::new();
        for generation in 0..generations {
            let mutations = match generation {
                0 => 80,
                generation if generation % 10 == 9 => 30,
                _ => 1 + random % 5,
            };
            let mut changed_paths = Vec::new();
            for _ in 0..mutations {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                let id = (random >> 32) % 96;
                changed_paths.push(package_path(id));
                changed_paths.push(format!("Content/{id:04}.uexp"));
                match random % 11 {
                    // A delete, of the package and its sidecar.
                    0 | 1 => {
                        state.remove(&id);
                        sidecars.remove(&id);
                    }
                    // A sidecar-only edit (or a sidecar added to a package without one).
                    2 | 3 if state.contains_key(&id) => {
                        sidecars.insert(id, generation);
                    }
                    // An orphan sidecar toggled, with no package beside it.
                    4 => {
                        changed_paths.push(format!("Content/Orphan{id:04}.ubulk"));
                        if !orphans.remove(&id) {
                            orphans.insert(id);
                        }
                    }
                    // An add, re-add or edit.
                    _ => {
                        state.insert(id, generation);
                    }
                }
            }
            let mut scanner = FakeScanner::default();
            for (&id, &version) in &state {
                let path = package_path(id);
                scanner.entries.push(package(&path, id + 1, version + 1));
                // Early generations hold header failures, which only a walk rereads.
                if id % 13 != 0 || version % 2 == 1 || generation >= 5 {
                    let class = if version % 2 == 0 {
                        "/Script/Test.Widget"
                    } else {
                        "/Script/Test.OtherWidget"
                    };
                    let mut evidence = header(
                        &format!("/Game/{id:04}"),
                        &[class, "NoDot", "Ã©.ðŸ”§"],
                        &[
                            "None",
                            "Ã©",
                            if id % 3 == 0 { "Rare" } else { "Common" },
                            "None",
                            &format!("V{version}"),
                        ],
                    );
                    evidence.header_data = Some(PackageHeaderData {
                        package_flags: (id * 31 + version) as u32,
                        gatherable_text_data_count: version as u32,
                        gatherable_text_data_offset: id,
                        has_text_property: id.is_multiple_of(2),
                    });
                    // Edges to present, deleted and differently cased packages, across Unreal's
                    // hard/game/build property bits.
                    evidence.dependencies = vec![
                        PackageDependency::from_properties(
                            format!("/Game/{:04}", (id * 7 + version) % 96),
                            ((id + version) % 8) as u8,
                        ),
                        PackageDependency::from_properties(
                            format!("/game/{:04}", (id + 1) % 96),
                            3,
                        ),
                        PackageDependency::from_properties("/Script/Engine".into(), 3),
                    ];
                    scanner.headers.insert(path.clone(), evidence);
                }
                if id % 11 == 0 || sidecars.contains_key(&id) {
                    let stamp = sidecars.get(&id).copied().unwrap_or(version);
                    scanner
                        .entries
                        .push(sidecar(&format!("Content/{id:04}.uexp"), 5, stamp + 1));
                }
            }
            for id in &orphans {
                scanner
                    .entries
                    .push(sidecar(&format!("Content/Orphan{id:04}.ubulk"), 7, *id + 1));
            }
            for id in 0..96_u64 {
                for filler in 0..fillers {
                    let extension = if filler == 0 && id % 4 == 0 {
                        "umap"
                    } else {
                        "uasset"
                    };
                    let path = format!("Content/{id:04}f{filler}.{extension}");
                    scanner.entries.push(package(&path, 3, 3));
                    scanner.headers.insert(
                        path,
                        header(
                            &format!("/Game/{id:04}f{filler}"),
                            &["/Script/Test.Filler"],
                            &["None", "Fill"],
                        ),
                    );
                    if filler % 2 == 0 {
                        scanner.entries.push(sidecar(
                            &format!("Content/{id:04}f{filler}.uexp"),
                            4,
                            4,
                        ));
                    }
                }
            }
            scanner.entries.reverse();
            let cancellation = CancellationToken::new();
            let walked = refresh(
                &mut binary,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &cancellation,
                |_| {},
            )
            .unwrap();
            // Hints repeat paths, name unchanged and missing ones, and some absolutely.
            if generation % 3 == 1
                && let Some(first) = changed_paths.first().cloned()
            {
                changed_paths.push(format!("{FIXTURE_PROJECT_ROOT}/{first}"));
                changed_paths.push("Content/0050.uasset".into());
            }
            let (hinted, reach) = refresh_changed_paths(
                &mut targeted,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &changed_paths,
                PROJECT_INDEX_MAX_REPORTED_CHANGES,
                &cancellation,
                |_| {},
            )
            .unwrap();
            assert_eq!(
                reach,
                if generation == 0 {
                    RefreshReach::Walked(Some("no_committed_generation"))
                } else if !previous_complete {
                    RefreshReach::Walked(Some("committed_generation_is_partial"))
                } else {
                    RefreshReach::Targeted
                },
                "generation {generation}"
            );
            assert_eq!(
                completed_changes(&hinted),
                completed_changes(&walked),
                "generation {generation}"
            );
            refresh(
                &mut memory,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &cancellation,
                |_| {},
            )
            .unwrap();
            for catalog in [&binary, &targeted] {
                let counts = catalog.write_counts();
                writes.push((
                    generation,
                    std::ptr::eq(catalog, &targeted),
                    counts.delta,
                    counts.written_bytes,
                ));
            }
            // The digest (in each status) depends only on the inventory, however it was written.
            let status = memory.status();
            let CatalogStatus::Ready { summary } = &status else {
                panic!("generation {generation} committed");
            };
            previous_complete = summary.completeness == Completeness::Complete;
            assert_eq!(summary.inventory_digest.is_some(), previous_complete);
            assert!(
                generation < 5 || previous_complete,
                "generation {generation}"
            );
            let reader = BinaryCatalog::open_for_query(
                binary.cleanup_root.as_ref().unwrap(),
                &fixture_project_id(),
            )
            .unwrap();
            for catalog in [&binary, &targeted, &reader] {
                assert_eq!(catalog.status(), status, "generation {generation}");
                assert_eq!(
                    catalog.committed_entries().unwrap(),
                    memory.committed_entries().unwrap(),
                    "generation {generation}"
                );
            }
            check_package_text_changes(
                &[&binary, &targeted, &reader],
                &mut package_text_history,
                generation,
            );
            let current = binary.committed_generation().unwrap();
            assert_eq!(memory.committed_generation(), Some(current));
            let kinds = [
                QueryKind::Inventory,
                QueryKind::Maps,
                QueryKind::ExactClasses {
                    values: vec!["/Script/Test.Widget".into(), "NoDot".into()],
                },
                QueryKind::ExactClasses { values: vec![] },
                QueryKind::ClassPrefixes {
                    values: vec!["/Script/Test.".into(), "Ã©".into()],
                },
                QueryKind::ClassPrefixes {
                    values: vec!["".into()],
                },
                QueryKind::ClassNameSuffixes {
                    values: vec!["Widget".into(), "ðŸ”§".into()],
                },
                QueryKind::ClassNameSuffixes {
                    values: vec!["".into()],
                },
                QueryKind::SerializedNames {
                    values: vec!["None".into(), "None".into()],
                },
                QueryKind::SerializedNames {
                    values: vec!["Rare".into(), "absent".into()],
                },
                QueryKind::SerializedNames {
                    values: vec!["Ã©".into(), format!("V{}", generation / 2)],
                },
                QueryKind::SerializedNames { values: vec![] },
            ];
            let union = super::super::catalog::CountRequest {
                project_id: fixture_project_id(),
                expected_generation: current,
                filters: kinds.to_vec(),
            };
            for catalog in [&binary, &targeted, &reader] {
                assert_eq!(
                    catalog.count(&union).unwrap(),
                    memory.count(&union).unwrap()
                );
                for kind in &kinds {
                    let request = super::super::catalog::CountRequest {
                        filters: vec![kind.clone(), kind.clone()],
                        ..union.clone()
                    };
                    assert_eq!(
                        catalog.count(&request).unwrap(),
                        memory.count(&request).unwrap()
                    );
                }
            }
            // Seeds: a present package, another in a different ASCII case, and a path that may be
            // deleted or never indexed.
            let present = state.keys().copied().collect::<Vec<_>>();
            let seeds = vec![
                package_path(present[0]),
                package_path(present[present.len() / 2]).to_ascii_lowercase(),
                package_path((generation * 31 + 5) % 96),
            ];
            let hard = EdgeFilter {
                hard: Some(true),
                ..EdgeFilter::default()
            };
            let soft_game = EdgeFilter {
                hard: Some(false),
                game: Some(true),
                ..EdgeFilter::default()
            };
            let mut graph_kinds = Vec::new();
            for edges in [EdgeFilter::default(), hard, soft_game] {
                for transitive in [false, true] {
                    graph_kinds.push(QueryKind::Dependencies {
                        paths: seeds.clone(),
                        transitive,
                        edges,
                    });
                    for classes in [vec![], vec!["/Script/Test.Widget".to_owned()]] {
                        graph_kinds.push(QueryKind::Dependents {
                            paths: seeds.clone(),
                            transitive,
                            edges,
                            classes,
                        });
                    }
                }
            }
            for kind in kinds.into_iter().chain(graph_kinds) {
                for &limit in page_limits {
                    let expected = collect_pages(&memory, current, kind.clone(), limit);
                    for catalog in [&binary, &targeted, &reader] {
                        assert_eq!(
                            collect_pages(catalog, current, kind.clone(), limit),
                            expected,
                            "generation {generation}, query {kind:?}, limit {limit}"
                        );
                    }
                }
            }
            // Unions page each matching package once, and projections leave out exactly the
            // fields they omit, in plain and dictionary pages, across base and delta.
            let unions = [
                QueryKind::Union {
                    filters: vec![
                        QueryKind::ExactClasses {
                            values: vec!["/Script/Test.Widget".into(), "NoDot".into()],
                        },
                        QueryKind::SerializedNames {
                            values: vec!["Rare".into(), "absent".into()],
                        },
                    ],
                },
                QueryKind::Union {
                    filters: vec![
                        QueryKind::ClassPrefixes {
                            values: vec!["/Script/Test.".into()],
                        },
                        QueryKind::ClassNameSuffixes {
                            values: vec!["Widget".into()],
                        },
                        QueryKind::SerializedNames {
                            values: vec![format!("V{}", generation / 2), "None".into()],
                        },
                    ],
                },
                QueryKind::Union {
                    filters: vec![QueryKind::ExactClasses { values: vec![] }],
                },
                QueryKind::Union {
                    filters: kinds_for_union(generation),
                },
            ];
            let projections = [
                HeaderFields::ALL,
                HeaderFields {
                    classes: true,
                    serialized_names: NameField::Omitted,
                    header_data: false,
                },
                HeaderFields {
                    classes: false,
                    serialized_names: NameField::Matched,
                    header_data: true,
                },
                HeaderFields {
                    classes: true,
                    serialized_names: NameField::Matched,
                    header_data: false,
                },
                HeaderFields {
                    classes: false,
                    serialized_names: NameField::Omitted,
                    header_data: false,
                },
            ];
            let projected_kinds = unions.iter().cloned().chain([
                QueryKind::ExactClasses {
                    values: vec!["/Script/Test.Widget".into()],
                },
                QueryKind::SerializedNames {
                    values: vec!["None".into(), "Rare".into(), "Common".into()],
                },
            ]);
            for kind in projected_kinds {
                for fields in projections {
                    for &limit in page_limits {
                        let expected =
                            collect_projected_pages(&memory, current, kind.clone(), limit, fields);
                        for catalog in [&binary, &targeted, &reader] {
                            assert_eq!(
                                collect_projected_pages(
                                    catalog,
                                    current,
                                    kind.clone(),
                                    limit,
                                    fields
                                ),
                                expected,
                                "generation {generation}, query {kind:?}, {fields:?}, limit {limit}"
                            );
                            assert_eq!(
                                collect_shared_pages(catalog, current, kind.clone(), limit, fields),
                                expected,
                                "generation {generation}, dictionary {kind:?}, {fields:?}, limit {limit}"
                            );
                        }
                    }
                }
            }
            // A union is the path-ordered, deduplicated union of its filters' pages.
            for kind in &unions {
                let QueryKind::Union { filters } = kind else {
                    unreachable!()
                };
                let mut separate = filters
                    .iter()
                    .flat_map(|filter| collect_pages(&binary, current, filter.clone(), 1024))
                    .collect::<Vec<_>>();
                separate.sort_by(|left, right| item_path(left).cmp(item_path(right)));
                separate.dedup();
                assert_eq!(
                    collect_pages(&targeted, current, kind.clone(), 7),
                    separate,
                    "generation {generation}, {kind:?}"
                );
            }
            // Dictionary pages carry each distinct string once, across base and delta.
            for kind in [
                QueryKind::ClassPrefixes {
                    values: vec!["".into()],
                },
                QueryKind::SerializedNames {
                    values: vec!["None".into(), "Rare".into(), "Common".into()],
                },
            ] {
                let mut cursor = None;
                loop {
                    let page = targeted
                        .query_shared_strings(&QueryRequest {
                            project_id: fixture_project_id(),
                            expected_generation: current,
                            kind: kind.clone(),
                            limit: 7,
                            cursor,
                            fields: HeaderFields::ALL,
                        })
                        .unwrap();
                    let distinct = page.strings.iter().collect::<BTreeSet<_>>();
                    assert_eq!(
                        distinct.len(),
                        page.strings.len(),
                        "generation {generation}"
                    );
                    cursor = page.next_cursor;
                    if cursor.is_none() {
                        break;
                    }
                }
            }
        }
        // Both catalogs wrote deltas over several generations, compacted into a new base once the
        // delta grew past its limit, and wrote deltas over the new base again.
        for targeted_catalog in [false, true] {
            let sequence = writes
                .iter()
                .filter(|(_, which, _, bytes)| *which == targeted_catalog && *bytes > 0)
                .map(|(generation, _, delta, _)| (*generation, *delta))
                .collect::<Vec<_>>();
            let consecutive_deltas = sequence.windows(2).any(|pair| pair[0].1 && pair[1].1);
            let compaction = sequence
                .windows(2)
                .position(|pair| pair[0].1 && !pair[1].1 && pair[1].0 > 0);
            assert!(consecutive_deltas, "{sequence:?}");
            let compaction = compaction.expect("a delta compacted into a base");
            assert!(
                sequence[compaction + 1..].iter().any(|(_, delta)| *delta),
                "a delta after compaction: {sequence:?}"
            );
        }
    }

    #[test]
    fn readers_survive_publication_and_noop_reuses_bytes() {
        use crate::direct_executor::catalog_conformance::{FakeScanner, collect_pages};
        let mut catalog = custom_catalog();
        let root = catalog.cleanup_root.as_ref().unwrap().clone();
        let scanner = refresh_fixture();
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let physical = catalog.manifest.as_ref().unwrap().physical_snapshot.clone();
        let bytes = fs::read(catalog.directory.join(&physical)).unwrap();
        let reader = BinaryCatalog::open_for_query(&root, &fixture_project_id()).unwrap();
        let generation = reader.committed_generation().unwrap();
        let before = collect_pages(&reader, generation, QueryKind::Maps, 1);
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        assert_eq!(catalog.write_counts().committed_evidence_rows, 0);
        assert_eq!(
            catalog.manifest.as_ref().unwrap().physical_snapshot,
            physical
        );
        refresh(
            &mut catalog,
            &FakeScanner::default(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        assert_eq!(
            collect_pages(&reader, generation, QueryKind::Maps, 1),
            before
        );
        assert_eq!(fs::read(catalog.directory.join(physical)).unwrap(), bytes);
        assert!(catalog.committed_entries().unwrap().is_empty());
    }

    #[test]
    fn impossible_counts_are_rejected_even_with_valid_checksums() {
        let mut catalog = custom_catalog();
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let path = catalog
            .directory
            .join(&catalog.manifest.as_ref().unwrap().physical_snapshot);
        let bytes = fs::read(&path).unwrap();
        let scratch = catalog.directory.join("count-probe");
        let snapshot = Snapshot::open(&path, SnapshotCheck::Stored).unwrap();
        // Sections that lead with a count: inventory, shared strings, posting directory.
        for section in [INVENTORY, STRINGS, DIRECTORY] {
            let mut raw = snapshot.section(section).unwrap();
            raw[..4].copy_from_slice(&u32::MAX.to_le_bytes());
            // A valid encoding and checksum of an impossible count.
            fs::write(&scratch, with_section(&bytes, section, &raw)).unwrap();
            assert!(Snapshot::open_fully(&scratch).is_err(), "section {section}");
        }
        // The unchanged file passes every check.
        fs::write(
            &scratch,
            with_section(&bytes, STRINGS, &snapshot.section(STRINGS).unwrap()),
        )
        .unwrap();
        assert!(Snapshot::open_fully(&scratch).is_ok());
    }

    #[test]
    fn signatures_and_records_round_trip_unsigned_extremes() {
        let mut catalog = custom_catalog();
        let mut scanner = refresh_fixture();
        scanner.entries[0].size = u64::MAX;
        scanner.entries[0].modified_nanos = u64::MAX;
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        for signature in &scanner.entries {
            let (found, header) = catalog.lookup_committed(&signature.relative_path).unwrap();
            assert_eq!(&found, signature);
            assert_eq!(
                header.as_ref(),
                scanner.headers.get(&signature.relative_path)
            );
        }
    }

    #[test]
    fn truncation_and_byte_corruption_fail_without_panics() {
        let mut catalog = custom_catalog();
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let path = catalog
            .directory
            .join(&catalog.manifest.as_ref().unwrap().physical_snapshot);
        let bytes = fs::read(&path).unwrap();
        let scratch = catalog.directory.join("corruption-probe");
        for length in [0, 7, 8, 87, bytes.len() / 2, bytes.len() - 1] {
            fs::write(&scratch, &bytes[..length]).unwrap();
            assert!(Snapshot::open_fully(&scratch).is_err());
        }
        for offset in (0..bytes.len()).step_by(17) {
            let mut damaged = bytes.clone();
            damaged[offset] ^= 0x40;
            fs::write(&scratch, damaged).unwrap();
            assert!(Snapshot::open_fully(&scratch).is_err(), "offset {offset}");
            // Writers and status check every stored byte without decoding them.
            assert!(
                open_snapshot_file(&scratch, SnapshotCheck::Stored).is_err(),
                "offset {offset}"
            );
        }
    }

    #[test]
    fn failed_publication_retains_no_unpublished_database() {
        let mut catalog = custom_catalog();
        fs::create_dir(catalog.directory.join(MANIFEST_FILE)).unwrap();
        assert!(
            refresh(
                &mut catalog,
                &refresh_fixture(),
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {}
            )
            .is_err()
        );
        assert!(matches!(catalog.status(), CatalogStatus::Absent));
        assert_eq!(fs::read_dir(&catalog.directory).unwrap().count(), 1);
    }

    #[test]
    fn sidecar_only_edit_resolves_uppercase_and_mixed_case_packages_for_delta_plan() {
        use crate::direct_executor::catalog_conformance::{FakeScanner, header, package, sidecar};
        use crate::direct_executor::project_index::refresh_changed_paths;
        use crate::direct_executor::project_index_io::gathered;

        struct DirectPlanCatalog<'a> {
            catalog: &'a BinaryCatalog,
            project: ProjectId,
            generation: Generation,
        }

        impl game_text_index::package_text_plan::PlanCatalog for DirectPlanCatalog<'_> {
            fn changes_since(&mut self, since: &str) -> Option<BTreeSet<String>> {
                self.catalog
                    .changes_since(
                        &self.project,
                        self.generation,
                        since,
                        Some(game_text_index::package_text_plan::MAXIMUM_DELTA_SHARDS),
                    )
                    .ok()
                    .flatten()
            }
            fn entries(
                &mut self,
                paths: &BTreeSet<String>,
            ) -> Option<Vec<game_text_index::package_text_contract::PackageTextExpected>>
            {
                self.catalog
                    .package_text_entries(&self.project, self.generation, paths, gathered)
                    .ok()
            }
        }

        let project = fixture_project_id();
        let mut catalog = custom_catalog();
        let make_header = |pkg_name: &str, gatherable: bool| {
            let mut evidence = header(pkg_name, &["/Script/Test.Widget"], &["None"]);
            evidence.header_data = Some(PackageHeaderData {
                package_flags: if gatherable { 0x40000 } else { 0 },
                gatherable_text_data_count: u32::from(gatherable),
                gatherable_text_data_offset: u64::from(gatherable),
                has_text_property: gatherable,
            });
            evidence
        };
        let make_scanner = |a_sidecar: (u64, u64), b_sidecar: (u64, u64)| {
            let mut scanner = FakeScanner::default();
            scanner.entries.push(package("Content/A.UASSET", 100, 10));
            scanner
                .headers
                .insert("Content/A.UASSET".into(), make_header("/Game/A", true));
            scanner
                .entries
                .push(sidecar("Content/A.uexp", a_sidecar.0, a_sidecar.1));
            scanner.entries.push(package("Content/B.UMap", 200, 10));
            scanner
                .headers
                .insert("Content/B.UMap".into(), make_header("/Game/B", true));
            scanner
                .entries
                .push(sidecar("Content/B.ubulk", b_sidecar.0, b_sidecar.1));
            scanner.entries.push(package("Content/C.uasset", 300, 10));
            scanner
                .headers
                .insert("Content/C.uasset".into(), make_header("/Game/C", false));
            scanner
        };

        let scanner1 = make_scanner((50, 10), (60, 10));
        refresh(
            &mut catalog,
            &scanner1,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let gen1 = catalog.committed_generation().unwrap();
        let digest1 = catalog.inventory_digest(&project, gen1).unwrap().unwrap();
        let inv1 = catalog
            .all_package_text_inventory(&project, gen1, gathered)
            .unwrap();

        let store_root = catalog.directory.join("game-text-cache");
        fs::create_dir_all(&store_root).unwrap();
        let config = game_text_index::store::Configuration {
            cache_root: store_root.clone(),
            project_key: "test-project".into(),
            target_key: "game".into(),
            shared_project: true,
            view_prefix: None,
        };
        let catalog_cache_root = catalog.directory.to_string_lossy().into_owned();
        let make_request = |plan_file: PathBuf, generation: u64| {
            game_text_index::package_text_contract::PackageTextPlanRequest {
                cache_root: catalog_cache_root.clone(),
                project_id: project.to_string(),
                generation,
                format: "package-text-v2".into(),
                policy_json: "[1,[\"en\"]]".into(),
                plan_file: plan_file.to_string_lossy().into_owned(),
                changed_files: None,
            }
        };

        let mut build = game_text_index::builder::BuildSession::default();
        build
            .execute(&game_text_index::builder::BuildRequest::Begin {
                configuration: config.clone(),
            })
            .unwrap();
        let req1 = make_request(store_root.join("plan-1.bin"), gen1.get());
        let plan1 = build
            .plan_packages_with_digest(&config, &req1, inv1.clone(), Some(&digest1))
            .unwrap()
            .plan
            .unwrap();
        build
            .execute(&game_text_index::builder::BuildRequest::End {
                configuration: config.clone(),
            })
            .unwrap();
        // Publish each planned shard into the store with matching key and stored packages so
        // `try_plan_packages_delta` validates the active shard keys against the witness.
        let mut store = game_text_index::store::Store::writer(config.clone()).unwrap();
        for shard in &plan1.changed {
            let entries = inv1
                .iter()
                .filter(|entry| {
                    game_text_index::package_text_plan::shard(&entry.path) as u32 == shard.group
                })
                .collect::<Vec<_>>();
            let shard_path = store_root.join(format!("staged-{}.snapshot", shard.group));
            let payload_path = store_root.join(format!("staged-{}.payload", shard.group));
            let mut writer = game_text_index::snapshot::Writer::new(&payload_path).unwrap();
            let paths_bytes = game_text_index::snapshot::string_block(
                &entries.iter().map(|e| e.path.clone()).collect::<Vec<_>>(),
            )
            .unwrap();
            let sigs_bytes = game_text_index::snapshot::string_block(
                &entries
                    .iter()
                    .map(|e| e.signature.clone())
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            let path_block = writer.add("paths.b0", 4, "paths", &paths_bytes, 1).unwrap();
            writer.entries[path_block].strings = entries.len() as u32;
            let path_starts = writer.column("paths.starts", &[0]).unwrap();
            let sig_block = writer
                .add("signatures.b0", 4, "signatures", &sigs_bytes, 1)
                .unwrap();
            writer.entries[sig_block].strings = entries.len() as u32;
            let sig_starts = writer.column("signatures.starts", &[0]).unwrap();
            let ids = (0..entries.len() as u32).collect::<Vec<_>>();
            let p_col = writer
                .add(
                    "package.path",
                    3,
                    "paths",
                    &game_text_index::snapshot::u32_bytes(&ids),
                    1,
                )
                .unwrap();
            writer.entries[p_col].strings = entries.len() as u32;
            let s_col = writer
                .add(
                    "package.signature",
                    3,
                    "signatures",
                    &game_text_index::snapshot::u32_bytes(&ids),
                    1,
                )
                .unwrap();
            writer.entries[s_col].strings = entries.len() as u32;
            let statuses = entries
                .iter()
                .map(|e| if e.selected { 0u32 } else { 2u32 })
                .collect::<Vec<_>>();
            let st_col = writer.column("package.status", &statuses).unwrap();
            let order = vec![
                path_block,
                path_starts,
                sig_block,
                sig_starts,
                p_col,
                s_col,
                st_col,
            ];
            writer.finish_staged(&shard_path, &order).unwrap();
            store
                .publish_local(
                    &format!("package-text.{}", shard.group),
                    &shard.key,
                    &shard_path,
                )
                .unwrap();
        }
        drop(store);
        // Re-plan gen1 once after publishing so the witness records the active shard hash.
        build
            .execute(&game_text_index::builder::BuildRequest::Begin {
                configuration: config.clone(),
            })
            .unwrap();
        let req1_witness = make_request(store_root.join("plan-1b.bin"), gen1.get());
        build
            .plan_packages_with_digest(&config, &req1_witness, inv1, Some(&digest1))
            .unwrap();

        // Generation 2: edit ONLY `Content/A.uexp` and `Content/B.ubulk`; neither package file
        // itself changed.
        let scanner2 = make_scanner((77, 20), (88, 20));
        refresh_changed_paths(
            &mut catalog,
            &scanner2,
            FIXTURE_PROJECT_ROOT,
            &["Content/A.uexp".into(), "Content/B.ubulk".into()],
            PROJECT_INDEX_MAX_REPORTED_CHANGES,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let gen2 = catalog.committed_generation().unwrap();
        let digest2 = catalog.inventory_digest(&project, gen2).unwrap().unwrap();
        assert_ne!(digest1, digest2);

        let resolved = catalog
            .changes_since(
                &project,
                gen2,
                &digest1,
                Some(game_text_index::package_text_plan::MAXIMUM_DELTA_SHARDS),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            resolved,
            BTreeSet::from(["Content/A.UASSET".to_owned(), "Content/B.UMap".to_owned()])
        );
        // Exceeding `max_shards` during sidecar resolution returns `None` early.
        assert_eq!(
            catalog
                .changes_since(&project, gen2, &digest1, Some(1))
                .unwrap(),
            None
        );

        let delta_plan_file = store_root.join("plan-2-delta.bin");
        let full_plan_file = store_root.join("plan-2-full.bin");
        let req_delta = make_request(delta_plan_file.clone(), gen2.get());
        let mut plan_catalog = DirectPlanCatalog {
            catalog: &catalog,
            project: project.clone(),
            generation: gen2,
        };
        let delta_plan = build
            .try_plan_packages_delta(&config, &req_delta, &digest2, &mut plan_catalog)
            .unwrap()
            .expect("delta plan should succeed for resolved uppercase/mixed-case sidecar edits")
            .plan
            .unwrap();

        let inv2 = catalog
            .all_package_text_inventory(&project, gen2, gathered)
            .unwrap();
        let req_full = make_request(full_plan_file.clone(), gen2.get());
        let full_plan = build
            .plan_packages_with_digest(&config, &req_full, inv2, Some(&digest2))
            .unwrap()
            .plan
            .unwrap();

        assert_eq!(delta_plan, full_plan);
        assert_eq!(
            fs::read(&delta_plan_file).unwrap(),
            fs::read(&full_plan_file).unwrap()
        );
        let expected_groups: BTreeSet<u32> = ["Content/A.UASSET", "Content/B.UMap"]
            .into_iter()
            .map(|p| game_text_index::package_text_plan::shard(p) as u32)
            .collect();
        let changed_groups: BTreeSet<u32> = delta_plan.changed.iter().map(|s| s.group).collect();
        assert_eq!(changed_groups, expected_groups);
    }

    /// Synthetic rows for posting placement: each row a package record (its class, name and
    /// dependency ids) or `None` for a non-package row with filler bytes.
    struct SyntheticRows {
        payload: StoredSection,
        rows: Vec<RowShape>,
        strings: u64,
        counts: [Vec<u32>; POSTING_KINDS],
    }

    type SyntheticRecord = (Vec<u32>, Vec<u32>, Vec<(u32, u8)>);

    fn package_record(classes: &[u32], names: &[u32], dependencies: &[(u32, u8)]) -> Vec<u8> {
        let mut out = vec![1];
        put_string(&mut out, "/Game/Synthetic").unwrap();
        out.extend([0, 0]);
        for ids in [classes, names] {
            put32(&mut out, ids.len()).unwrap();
            for id in ids {
                out.extend_from_slice(&id.to_le_bytes());
            }
        }
        put32(&mut out, dependencies.len()).unwrap();
        for (id, properties) in dependencies {
            out.extend_from_slice(&id.to_le_bytes());
            out.push(*properties);
        }
        out
    }

    /// Stores `records` as a payload section, with the posting counts the builder would have
    /// counted for them (records that do not decode count nothing).
    fn synthetic_rows(records: &[Option<Vec<u8>>], strings: u64) -> SyntheticRows {
        let mut writer = SectionWriter::new();
        let mut rows = Vec::new();
        let strings_len = strings as usize;
        let mut counts: [Vec<u32>; POSTING_KINDS] = Default::default();
        for counts in &mut counts {
            counts.resize(strings_len, 0);
        }
        for (index, record) in records.iter().enumerate() {
            let (bytes, package) = match record {
                Some(bytes) => (bytes.clone(), true),
                None => (vec![0xAB; index % 37], false),
            };
            if package {
                let mut keys = Vec::new();
                if record_keys(&bytes, strings, strings_len, |key| keys.push(key)).is_ok() {
                    keys.sort_unstable();
                    keys.dedup();
                    for key in keys {
                        counts[key / strings_len][key % strings_len] += 1;
                    }
                }
            }
            writer.push(&bytes).unwrap();
            rows.push(RowShape {
                len: bytes.len() as u32,
                package,
            });
        }
        SyntheticRows {
            payload: writer.finish().unwrap(),
            rows,
            strings,
            counts,
        }
    }

    /// Deterministic records with repeated ids inside a record, one hot name every package
    /// names, and many cold keys.
    fn generated_records(count: usize, strings: u32, seed: u64) -> Vec<Option<Vec<u8>>> {
        let mut state = seed;
        let mut next = move |bound: u32| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((state >> 33) % u64::from(bound)) as u32
        };
        (0..count)
            .map(|_| {
                if next(7) == 0 {
                    return None;
                }
                let classes = (0..1 + next(4)).map(|_| next(8)).collect::<Vec<_>>();
                let mut names = (0..next(60)).map(|_| next(strings)).collect::<Vec<_>>();
                names.push(0);
                names.push(0);
                if let Some(&repeat) = names.first() {
                    names.push(repeat);
                }
                let dependencies = (0..next(20))
                    .map(|_| (next(strings), next(8) as u8))
                    .collect::<Vec<_>>();
                Some(package_record(&classes, &names, &dependencies))
            })
            .collect()
    }

    fn records_of(records: &[SyntheticRecord]) -> Vec<Option<Vec<u8>>> {
        records
            .iter()
            .map(|(classes, names, dependencies)| {
                Some(package_record(classes, names, dependencies))
            })
            .collect()
    }

    /// The directory as one pass encoded it before it was split by key range: the reference
    /// every directory must equal byte for byte.
    fn reference_directory(postings: &Postings) -> Vec<u8> {
        let mut directory = Vec::new();
        put32(&mut directory, 0).unwrap();
        let mut count = 0_u32;
        let mut list = Vec::new();
        for (key, bounds) in postings.starts.windows(2).enumerate() {
            let (start, end) = (bounds[0] as usize, bounds[1] as usize);
            if start == end {
                continue;
            }
            count += 1;
            list.clear();
            for row in &postings.rows[start..end] {
                list.extend_from_slice(&row.to_le_bytes());
            }
            directory.push((key / postings.strings) as u8);
            directory.extend_from_slice(&((key % postings.strings) as u32).to_le_bytes());
            put64(&mut directory, start as u64 * 4);
            put32(&mut directory, end - start).unwrap();
            put64(&mut directory, checksum(&list));
        }
        directory[..4].copy_from_slice(&count.to_le_bytes());
        directory
    }

    type PlacementOutcome = Result<(Vec<u32>, Vec<u32>), String>;

    fn place(synthetic: &SyntheticRows, placement: Placement) -> PlacementOutcome {
        Postings::build_with(
            &synthetic.payload,
            &synthetic.rows,
            synthetic.strings,
            synthetic.counts.clone(),
            placement,
        )
        .map(|postings| {
            let directory = reference_directory(&postings);
            assert_eq!(postings.directory().unwrap(), directory);
            for threads in [2, 3, 16] {
                assert_eq!(postings.directory_with(threads, 0).unwrap(), directory);
            }
            (postings.starts, postings.rows)
        })
        .map_err(|error| format!("{error:?}"))
    }

    /// Every placement of `synthetic` (one pass, the automatic choice, and parallel passes over
    /// several thread counts and batch sizes) has the same outcome. Returns it.
    fn assert_placements_agree(synthetic: &SyntheticRows, batches: &[usize]) -> PlacementOutcome {
        let serial = place(synthetic, Placement::Serial);
        assert_eq!(place(synthetic, Placement::Auto), serial);
        for threads in [2, 3, 5, 16] {
            for &batch_bytes in batches {
                let parallel = Placement::Parallel {
                    threads,
                    batch_bytes,
                };
                assert_eq!(
                    place(synthetic, parallel),
                    serial,
                    "{threads} threads, {batch_bytes}-byte batches"
                );
            }
        }
        serial
    }

    #[test]
    fn parallel_postings_match_one_pass_on_small_catalogs() {
        for strings in [0, 1, 10] {
            assert_placements_agree(&synthetic_rows(&[], strings), &[1, 4096]).unwrap();
        }
        let one = records_of(&[(vec![2, 2], vec![1, 3, 1], vec![(3, 1), (3, 2), (4, 0)])]);
        let outcome = assert_placements_agree(&synthetic_rows(&one, 5), &[1, 4096]).unwrap();
        assert_eq!(outcome.1, vec![0, 0, 0, 0, 0]);
        let few = generated_records(40, 50, 7);
        assert_placements_agree(&synthetic_rows(&few, 50), &[1, 64, 4096]).unwrap();
        // Non-package rows only.
        assert_placements_agree(&synthetic_rows(&[None, None, None], 3), &[1, 4096]).unwrap();
    }

    #[test]
    fn parallel_postings_match_one_pass_across_batches() {
        let records = generated_records(12_000, 3_000, 11);
        let synthetic = synthetic_rows(&records, 3_000);
        let (starts, placed) =
            assert_placements_agree(&synthetic, &[4096, 64 * 1024, usize::MAX]).unwrap();
        assert!(
            placed.len() > usize::from(u16::MAX),
            "enough entries to place in parallel"
        );
        // The hot name lists every package row, ascending.
        let hot = NAME_POSTINGS as usize * 3_000;
        let list = &placed[starts[hot] as usize..starts[hot + 1] as usize];
        assert_eq!(
            list.len(),
            records.iter().filter(|record| record.is_some()).count()
        );
        assert!(list.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn parallel_postings_match_one_pass_across_skewed_batches() {
        // Consecutive groups of rows concentrate in disjoint key ranges, exercising per-batch
        // scratch release when different shards are hot in different batches.
        let shards = 8_u32;
        let keys_per_shard = 64_u32;
        let strings = shards * keys_per_shard;
        let mut records = Vec::with_capacity(4_800);
        for shard in 0..shards {
            let base = shard * keys_per_shard;
            let names = (base..base + 32).collect::<Vec<_>>();
            for row in 0..600_u32 {
                let class = base + (row % keys_per_shard);
                let dep = (base + ((row + 7) % keys_per_shard), 1);
                records.push(Some(package_record(&[class], &names, &[dep])));
            }
        }
        let synthetic = synthetic_rows(&records, u64::from(strings));
        assert_placements_agree(&synthetic, &[4096, 32 * 1024]).unwrap();
    }

    #[test]
    fn parallel_postings_match_one_pass_across_decode_passes() {
        // More records than one decode pass holds.
        let mut records = generated_records(60_000, 20_000, 23);
        let filler = (0..300).collect::<Vec<_>>();
        for record in records.iter_mut().step_by(3) {
            *record = Some(package_record(&[1], &filler, &[]));
        }
        let synthetic = synthetic_rows(&records, 20_000);
        assert!(synthetic.payload.header.length > BLOCK_BYTES * DECODE_BATCH_BLOCKS as u64);
        assert_placements_agree(&synthetic, &[1024 * 1024, POSTING_BATCH_BYTES]).unwrap();
    }

    #[test]
    fn parallel_postings_report_the_failure_one_pass_reports() {
        let records = generated_records(9_000, 500, 31);
        let mut corrupt_records = records.clone();
        // An id past the strings, then a dependency with invalid properties further on.
        corrupt_records[3_001] = Some(package_record(&[1], &[600], &[]));
        corrupt_records[8_000] = Some(package_record(&[1], &[2], &[(3, 9)]));
        let synthetic = synthetic_rows(&corrupt_records, 500);
        let error = assert_placements_agree(&synthetic, &[4096, usize::MAX]).unwrap_err();
        assert!(error.contains("invalid evidence string id"), "{error}");

        // A row counted once too often or once too few.
        for delta in [1_i64, -1] {
            let mut synthetic = synthetic_rows(&records, 500);
            let count = &mut synthetic.counts[NAME_POSTINGS as usize][0];
            *count = (i64::from(*count) + delta) as u32;
            let error = assert_placements_agree(&synthetic, &[4096]).unwrap_err();
            assert!(
                error.contains("do not match their posting counts"),
                "{error}"
            );
        }

        // Rows that run past the section, after a corrupt record and on their own.
        let mut synthetic = synthetic_rows(&corrupt_records, 500);
        synthetic.rows.push(RowShape {
            len: 64,
            package: true,
        });
        let error = assert_placements_agree(&synthetic, &[4096]).unwrap_err();
        assert!(error.contains("invalid evidence string id"), "{error}");
        let mut synthetic = synthetic_rows(&records, 500);
        synthetic.rows.push(RowShape {
            len: 64,
            package: true,
        });
        let error = assert_placements_agree(&synthetic, &[4096]).unwrap_err();
        assert!(error.contains("records leave their section"), "{error}");

        // Rows that stop short of the section: a non-package record past the last row.
        let mut extended = records.clone();
        extended.push(None);
        let mut synthetic = synthetic_rows(&extended, 500);
        assert!(synthetic.rows.pop().is_some_and(|row| row.len > 0));
        let error = assert_placements_agree(&synthetic, &[4096]).unwrap_err();
        assert!(
            error.contains("records do not fill their section"),
            "{error}"
        );
    }

    #[test]
    fn list_checksums_match_the_stored_bytes() {
        for len in [1, 1023, 1024, 1025, 5000] {
            let rows = (0..len)
                .map(|row: u32| row.wrapping_mul(2_654_435_761))
                .collect::<Vec<_>>();
            let bytes = rows
                .iter()
                .flat_map(|row| row.to_le_bytes())
                .collect::<Vec<_>>();
            assert_eq!(list_checksum(&rows), checksum(&bytes));
        }
    }

    #[test]
    fn balanced_bounds_cover_every_key_in_order() {
        let starts = [0_u64, 0, 0, 90, 90, 95, 100];
        for parts in [1, 2, 3, 7, 16] {
            let bounds = balanced_bounds(6, parts, |key| starts[key]);
            assert_eq!(bounds.len(), parts + 1);
            assert_eq!((bounds[0], bounds[parts]), (0, 6));
            assert!(bounds.windows(2).all(|pair| pair[0] <= pair[1]));
        }
        assert_eq!(balanced_bounds(0, 4, |_| 0), vec![0; 5]);
    }
}
