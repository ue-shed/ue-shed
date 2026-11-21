//! Immutable binary Catalog. SQLite remains an opt-in test oracle.
//! Five checksummed sections: inventory, shared strings, posting directory, postings, records.
//! All integers are little-endian. Incompatible derived caches are rebuilt, never migrated.
use super::catalog::*;
use super::catalog_dependencies::{DependencyGraph, dependency_page};
use super::project_index::CatalogSnapshot;
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::cell::{OnceCell, RefCell};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uasset_inspection::package_header::PackageHeaderData;

const CATALOG_DIRECTORY: &str = "catalogs-v8";
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_SCHEMA_VERSION: u32 = 4;
const MAX_QUARANTINE_ATTEMPTS: u32 = 8;
const MAGIC: &[u8; 8] = b"UESHC006";
/// Posting kinds: exact export classes, serialized names, and dependency targets.
const POSTING_KINDS: usize = 3;
const CLASS_POSTINGS: u8 = 0;
const DEPENDENCY_POSTINGS: u8 = 2;
const SECTIONS: usize = 5;
const INVENTORY: usize = 0;
const STRINGS: usize = 1;
const DIRECTORY: usize = 2;
const LISTS: usize = 3;
const RECORDS: usize = 4;
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

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CatalogWriteCounts {
    pub(crate) staged_evidence_rows: u64,
    pub(crate) committed_evidence_rows: u64,
    pub(crate) removed_evidence_rows: u64,
    pub(crate) evidence_write_duration: Duration,
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Manifest {
    manifest_schema_version: u32,
    snapshot_schema_version: u32,
    project_id: String,
    physical_snapshot: String,
    previous_snapshot: Option<String>,
    summary: ManifestSummary,
}

impl ManifestSummary {
    fn from_refresh(summary: &RefreshSummary) -> Self {
        Self {
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
        }
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
    left.bytes()
        .map(|byte| byte.to_ascii_lowercase())
        .cmp(right.bytes().map(|byte| byte.to_ascii_lowercase()))
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
    fn decode(bytes: &[u8]) -> Result<Self, CatalogError> {
        let mut d = Decoder::new(bytes);
        let count = d.count(8)?;
        let mut table = StringTable::with_capacity(bytes.len(), count);
        for _ in 0..count {
            table.push(d.str()?)?;
        }
        let mut lexicon: Vec<u32> = Vec::with_capacity(count);
        for _ in 0..count {
            let id = d.u32()?;
            if id as usize >= count {
                return Err(corrupt("invalid dictionary id"));
            }
            if lexicon.last().is_some_and(|prior| {
                lexicon_order(table.get(*prior as usize), table.get(id as usize))
                    != std::cmp::Ordering::Less
            }) {
                return Err(corrupt("dictionary must be unique and ordered"));
            }
            lexicon.push(id);
        }
        d.finish()?;
        Ok(Self { table, lexicon })
    }
}

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
        let hash = string_hash(value.as_bytes()) as u32;
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
        let mut added = (self.prior as u32..self.table.len() as u32).collect::<Vec<_>>();
        added.sort_unstable_by(|a, b| {
            lexicon_order(self.table.get(*a as usize), self.table.get(*b as usize))
        });
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

/// One header record (section 4): package name, header data, failure, then classes, names and
/// dependencies as shared-string ids.
fn encode_record(
    header: Option<&HeaderEvidence>,
    dictionary: &mut Option<Dictionary>,
    out: &mut Vec<u8>,
) -> Result<(), CatalogError> {
    out.push(u8::from(header.is_some()));
    let Some(header) = header else {
        return Ok(());
    };
    let dictionary = dictionary
        .as_mut()
        .ok_or_else(|| corrupt("header staged without a dictionary"))?;
    put_string(out, &header.package_name)?;
    out.push(u8::from(header.header_data.is_some()));
    if let Some(data) = &header.header_data {
        put_header_data(out, data);
    }
    out.push(u8::from(header.failure_code.is_some()));
    if let Some(code) = &header.failure_code {
        put_string(out, code)?;
    }
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
    Ok(())
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
    let failure = Mutex::new(None);
    std::thread::scope(|scope| {
        for part in work.chunks_mut(per_thread) {
            let failure = &failure;
            scope.spawn(move || {
                let mut decompressor = None;
                for (source, chunk) in part {
                    if let Err(error) = decode_block_into(source, chunk, &mut decompressor) {
                        *failure
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
                        return;
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
    Ok(out)
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
    hash: crc32fast::Hasher,
}
impl SectionWriter {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
            blocks: Vec::new(),
            ends: Vec::new(),
            length: 0,
            hash: crc32fast::Hasher::new(),
        }
    }
    fn len(&self) -> u64 {
        self.length
    }
    fn push(&mut self, bytes: &[u8]) -> Result<(), CatalogError> {
        self.hash.update(bytes);
        self.length += bytes.len() as u64;
        if self.length > MAX_SECTION_BYTES {
            return Err(corrupt("Catalog section exceeds 512 MiB"));
        }
        self.pending.extend_from_slice(bytes);
        if self.pending.len() >= COMPRESSION_BATCH_BYTES {
            self.flush(false)?;
        }
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

fn checked_range(offset: u64, len: u64, total: u64) -> Result<(), CatalogError> {
    if offset.checked_add(len).is_none_or(|end| end > total) {
        return Err(corrupt("binary range leaves its section"));
    }
    Ok(())
}

/// Reads every stored byte of the snapshot once and checks it against the header's stored
/// checksums: whatever changed on disk since the snapshot was written is found without
/// decoding a single block.
fn verify_stored(file: &mut File, header: &SnapshotHeader) -> Result<(), CatalogError> {
    let starts = header.starts()?;
    let mut buffer = Vec::new();
    for (section, start) in header.sections.iter().zip(starts) {
        let mut hash = crc32fast::Hasher::new();
        let mut done = 0;
        while done < section.stored {
            let chunk = (section.stored - done).min(VERIFY_CHUNK_BYTES as u64);
            read_range_into(file, start + done, chunk, &mut buffer)?;
            hash.update(&buffer);
            done += chunk;
        }
        if u64::from(hash.finalize()) != section.stored_hash {
            return Err(corrupt("binary section checksum mismatch"));
        }
    }
    Ok(())
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

struct Snapshot {
    file: RefCell<File>,
    header: SnapshotHeader,
    paths: StringTable,
    inventory: Vec<InventoryEntry>,
    /// File ranges of each section's blocks. Blocks are read and decoded for each query, so a
    /// later query still detects changed or truncated bytes.
    blocks: [Vec<(u64, u64)>; SECTIONS],
    /// The shared strings and posting directory, decoded on first use.
    strings: OnceCell<Strings>,
    postings: OnceCell<Vec<Posting>>,
    /// Package ids by the hash of their ASCII-folded path, then id (path order), built on the first
    /// lookup that ignores case. Lookups confirm the path, so a hash collision only costs a compare.
    folded_paths: RefCell<Option<Vec<(u64, u32)>>>,
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
        verify_stored(&mut file, &header)?;
    }
    let starts = header.starts()?;
    let mut blocks: BlockRanges = Default::default();
    for (index, ranges) in blocks.iter_mut().enumerate() {
        let section = header.sections[index];
        *ranges = block_ranges(&mut file, starts[index], section.stored, section.length)?;
    }
    Ok((file, header, blocks))
}

impl Snapshot {
    fn open(path: &Path, check: SnapshotCheck) -> Result<Self, CatalogError> {
        let (file, header, blocks) = open_snapshot_file(path, check)?;
        let mut snapshot = Self {
            file: RefCell::new(file),
            header,
            paths: StringTable::default(),
            inventory: Vec::new(),
            blocks,
            strings: OnceCell::new(),
            postings: OnceCell::new(),
            folded_paths: RefCell::new(None),
        };
        let bytes = snapshot.section(INVENTORY)?;
        let mut d = Decoder::new(&bytes);
        let count = d.count(44)?;
        snapshot.paths = StringTable::with_capacity(bytes.len() / 2, count);
        snapshot.inventory = Vec::with_capacity(count);
        let (mut packages, mut maps) = (0, 0);
        for id in 0..count {
            let relative_path = d.str()?;
            if id > 0 && snapshot.paths.get(id - 1) >= relative_path {
                return Err(corrupt("inventory paths must be strictly ordered"));
            }
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
            checked_range(
                offset,
                u64::from(len),
                snapshot.header.sections[RECORDS].length,
            )?;
            let is_map = kind == EntryKind::Package && is_map_path(relative_path);
            packages += u64::from(kind == EntryKind::Package);
            maps += u64::from(is_map);
            snapshot.paths.push(relative_path)?;
            snapshot.inventory.push(InventoryEntry {
                kind,
                size,
                modified_nanos,
                profile,
                failure,
                is_map,
                offset,
                len,
                checksum: hash,
                header_data,
            });
        }
        d.finish()?;
        if packages != snapshot.header.packages || maps != snapshot.header.maps {
            return Err(corrupt("inventory counts do not match the snapshot header"));
        }
        Ok(snapshot)
    }
    fn path(&self, id: usize) -> &str {
        self.paths.get(id)
    }
    fn signature(&self, id: usize) -> PackageSignature {
        let entry = &self.inventory[id];
        PackageSignature {
            relative_path: self.path(id).to_owned(),
            kind: entry.kind,
            size: entry.size,
            modified_nanos: entry.modified_nanos,
        }
    }
    /// The inventory id at exactly `path`.
    fn id_at(&self, path: &str) -> Option<usize> {
        let mut low = 0;
        let mut high = self.inventory.len();
        while low < high {
            let middle = low + (high - low) / 2;
            match self.path(middle).cmp(path) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return Some(middle),
            }
        }
        None
    }
    /// The first inventory id whose path is after `cursor`.
    fn after(&self, cursor: &str) -> usize {
        let mut low = 0;
        let mut high = self.inventory.len();
        while low < high {
            let middle = low + (high - low) / 2;
            if self.path(middle) <= cursor {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        low
    }
    /// A whole section, decoded and checked.
    fn section(&self, index: usize) -> Result<Vec<u8>, CatalogError> {
        let section = self.header.sections[index];
        let ranges = &self.blocks[index];
        let start = ranges.first().map_or(0, |range| range.0);
        let stored = ranges.iter().map(|range| range.1).sum();
        let blocks = read_range(&mut self.file.borrow_mut(), start, stored)?;
        let bytes = decode_blocks(&blocks, start, ranges, section.length)?;
        if checksum(&bytes) != section.hash {
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
        let count = d.count(25)?;
        let mut postings: Vec<Posting> = Vec::with_capacity(count);
        for _ in 0..count {
            let kind = d.byte()?;
            let value = d.u32()?;
            let offset = d.u64()?;
            let len = d.u32()?;
            let hash = d.u64()?;
            if kind as usize >= POSTING_KINDS
                || u64::from(value) >= self.header.strings
                || len as usize > self.inventory.len()
            {
                return Err(corrupt("invalid posting metadata"));
            }
            if postings
                .last()
                .is_some_and(|p| (p.kind, p.value) >= (kind, value))
            {
                return Err(corrupt("posting keys must be strictly ordered"));
            }
            checked_range(
                offset,
                u64::from(len) * 4,
                self.header.sections[LISTS].length,
            )?;
            postings.push(Posting {
                kind,
                value,
                offset,
                len,
                checksum: hash,
            });
        }
        d.finish()?;
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
        let entry = &self.inventory[id];
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
        let mut last_block = LastBlock::default();
        let mut bytes = Vec::new();
        let mut first = 0;
        while first < ids.len() {
            let entry = &self.inventory[ids[first]];
            let start = entry.offset;
            let mut end = start + u64::from(entry.len);
            let mut last = first + 1;
            while last < ids.len() {
                let next = &self.inventory[ids[last]];
                let next_end = next.offset + u64::from(next.len);
                if next.offset < end || next.offset - end > 4096 || next_end - start > 256 * 1024 {
                    break;
                }
                end = next_end;
                last += 1;
            }
            // A page-local window avoids one seek/read/allocation per nearby record. Nothing
            // survives the query: later queries must still detect changed or truncated bytes.
            self.range_reusing(&mut last_block, RECORDS, start, end - start, &mut bytes)?;
            for &id in &ids[first..last] {
                let entry = &self.inventory[id];
                let offset = (entry.offset - start) as usize;
                let record = &bytes[offset..offset + entry.len as usize];
                visit(id, self.check_record(id, record)?)?;
            }
            first = last;
        }
        Ok(())
    }
    fn expand_header(
        &self,
        id: usize,
        header: Option<HeaderView<'_>>,
    ) -> Result<Option<HeaderEvidence>, CatalogError> {
        let (Some(header), Some(profile_version)) = (header, self.inventory[id].profile) else {
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
        let entry = self
            .inventory
            .get(id)
            .ok_or_else(|| corrupt("invalid inventory id"))?;
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
            if id >= self.inventory.len() || ids.last().is_some_and(|old| *old >= id) {
                return Err(corrupt("invalid posting row order"));
            }
            ids.push(id);
        }
        Ok(ids)
    }
    /// The package at exactly a relative path, else, when `ignore_case`, the first package in path
    /// order whose path matches without regard to ASCII case.
    fn package_id_at(&self, path: &str, ignore_case: bool) -> Option<usize> {
        if let Some(id) = self.id_at(path)
            && self.inventory[id].kind == EntryKind::Package
        {
            return Some(id);
        }
        if !ignore_case {
            return None;
        }
        let mut folded = self.folded_paths.borrow_mut();
        let paths = folded.get_or_insert_with(|| {
            let mut paths = self
                .inventory
                .iter()
                .enumerate()
                .filter(|(_, entry)| entry.kind == EntryKind::Package)
                .filter_map(|(id, _)| Some((folded_hash(self.path(id)), u32::try_from(id).ok()?)))
                .collect::<Vec<_>>();
            paths.sort_unstable();
            paths
        });
        let hash = folded_hash(path);
        let start = paths.partition_point(|(other, _)| *other < hash);
        paths[start..]
            .iter()
            .take_while(|(other, _)| *other == hash)
            .map(|(_, id)| *id as usize)
            .find(|id| self.path(*id).eq_ignore_ascii_case(path))
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
    fn matches(
        &self,
        kind: &QueryKind,
        after: usize,
        limit: usize,
    ) -> Result<Vec<usize>, CatalogError> {
        if matches!(kind, QueryKind::Inventory) {
            return Ok((after..self.inventory.len())
                .filter(|&id| self.inventory[id].kind == EntryKind::Package)
                .take(limit)
                .collect());
        }
        if matches!(kind, QueryKind::Maps) {
            return Ok(self
                .inventory
                .iter()
                .enumerate()
                .skip(after)
                .filter(|(_, e)| e.is_map)
                .take(limit)
                .map(|(id, _)| id)
                .collect());
        }
        let postings = self.postings()?;
        let mut selected = BTreeSet::new();
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
            QueryKind::Maps | QueryKind::Inventory => unreachable!(),
            QueryKind::Dependencies { .. } | QueryKind::Dependents { .. } => {
                return Err(CatalogError::InvalidRequest {
                    message: "dependency queries walk the graph; they do not match postings".into(),
                });
            }
        }
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
                if id >= self.inventory.len() || previous.is_some_and(|old| old >= id) {
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
    /// The bundle signature of the package at `id`: its own stamp, then each sidecar's. Sidecars
    /// share the package's stem, so they sit beside it in path order.
    fn bundle_signature(&self, id: usize) -> String {
        let path = self.path(id);
        let stem = path.rsplit_once('.').map_or(path, |(stem, _)| stem);
        let entry = &self.inventory[id];
        let mut parts = [Some((entry.size, entry.modified_nanos)), None, None, None];
        let shares_stem = |other: &str| {
            other.len() > stem.len()
                && other.starts_with(stem)
                && other.as_bytes()[stem.len()] == b'.'
        };
        let mut look = |other_id: usize| {
            let other = self.path(other_id);
            let extension = &other[stem.len() + 1..];
            if let Some(slot) = ["uexp", "ubulk", "uptnl"]
                .iter()
                .position(|sidecar| *sidecar == extension)
            {
                let entry = &self.inventory[other_id];
                parts[slot + 1] = Some((entry.size, entry.modified_nanos));
            }
        };
        let mut before = id;
        while before > 0 && shares_stem(self.path(before - 1)) {
            before -= 1;
            look(before);
        }
        let mut after = id + 1;
        while after < self.inventory.len() && shares_stem(self.path(after)) {
            look(after);
            after += 1;
        }
        bundle_signature(parts)
    }
}

/// A changed entry staged for the next generation; its record is in `Staging::records`.
struct StagedRecord {
    signature: PackageSignature,
    profile: Option<u32>,
    failure: bool,
    header_data: Option<PackageHeaderData>,
    offset: usize,
    len: u32,
}
struct Staging {
    generation: Generation,
    /// Committed inventory ids observed unchanged.
    kept: Vec<u32>,
    /// Set when a path observed unchanged is not in the committed inventory.
    missing_unchanged: bool,
    changed: Vec<StagedRecord>,
    /// Encoded records of `changed`, back to back.
    records: Vec<u8>,
    /// Committed strings and those staging added; loaded when the first header is staged.
    dictionary: Option<Dictionary>,
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

pub(crate) struct BinaryCatalog {
    // A sibling lock survives quarantine/clear; the OS releases it even on process termination.
    writer_lock: Option<File>,
    publication_uncertain: bool,
    directory: PathBuf,
    project_id: ProjectId,
    manifest: Option<Manifest>,
    snapshot: RefCell<Option<Snapshot>>,
    staging: Option<Staging>,
    quarantined_from: Option<PathBuf>,
    writes: CatalogWriteCounts,
    #[cfg(test)]
    cleanup_root: Option<PathBuf>,
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
        Self::open_checked(root, project_id, OpenMode::Writer)
    }
    pub(crate) fn open_for_query(
        root: &Path,
        project_id: &ProjectId,
    ) -> Result<Self, CatalogError> {
        Self::open_checked(root, project_id, OpenMode::Query)
    }
    /// Reads the committed catalog for status: no writer lock, so a refresh in progress doesn't
    /// hide the last committed generation, and nothing on disk is created, cleaned or quarantined.
    /// A damaged catalog reads as absent; the next refresh quarantines it.
    pub(crate) fn open_for_status(
        root: &Path,
        project_id: &ProjectId,
    ) -> Result<Self, CatalogError> {
        match Self::open_checked(root, project_id, OpenMode::Status) {
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
            snapshot: RefCell::new(None),
            staging: None,
            quarantined_from: None,
            writes: CatalogWriteCounts::default(),
            #[cfg(test)]
            cleanup_root: None,
        }
    }
    fn open_checked(
        root: &Path,
        project_id: &ProjectId,
        mode: OpenMode,
    ) -> Result<Self, CatalogError> {
        let directory = root
            .join(CATALOG_DIRECTORY)
            .join(catalog_directory_name(project_id));
        if mode == OpenMode::Status && !directory.is_dir() {
            return Ok(Self::unopened(directory, project_id));
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
            }) {
                return Err(corrupt("invalid Catalog summary"));
            }
            let Some(manifest_ref) = &manifest else {
                return Ok((manifest, None));
            };
            let path = directory.join(&manifest_ref.physical_snapshot);
            // Writers and status verify every stored byte; neither decodes more than a writer
            // needs to compare (the inventory) or status needs at all (the header).
            let (header, snapshot) = match mode {
                OpenMode::Status => (open_snapshot_file(&path, SnapshotCheck::Stored)?.1, None),
                // Pin the physical file when opening a reader, including readers that have not
                // issued their first query yet. Later publication may unlink retired names.
                OpenMode::Query => {
                    let snapshot = Snapshot::open(&path, SnapshotCheck::Header)?;
                    (snapshot.header.clone(), Some(snapshot))
                }
                OpenMode::Writer => {
                    let snapshot = Snapshot::open(&path, SnapshotCheck::Stored)?;
                    (snapshot.header.clone(), Some(snapshot))
                }
            };
            if mode != OpenMode::Query
                && (header.packages != manifest_ref.summary.package_count
                    || header.maps != manifest_ref.summary.map_count)
            {
                return Err(corrupt("manifest summary does not match its snapshot"));
            }
            Ok((manifest, snapshot))
        })();
        let (manifest, snapshot, quarantined_from) = match opened {
            Ok((manifest, snapshot)) => (manifest, snapshot, None),
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
            snapshot: RefCell::new(snapshot),
            staging: None,
            quarantined_from,
            writes: CatalogWriteCounts::default(),
            #[cfg(test)]
            cleanup_root: None,
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
        if self.snapshot.borrow().is_none()
            && let Some(manifest) = &self.manifest
        {
            *self.snapshot.borrow_mut() = Some(Snapshot::open(
                &self.directory.join(&manifest.physical_snapshot),
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
}

impl Catalog for BinaryCatalog {
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
        let cached = self.snapshot.borrow();
        let snapshot = cached.as_ref()?;
        let id = snapshot.id_at(path)?;
        Some((snapshot.signature(id), snapshot.headers(&[id]).ok()?.pop()?))
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
            missing_unchanged: false,
            changed: Vec::new(),
            records: Vec::new(),
            dictionary: None,
        });
        self.writes = CatalogWriteCounts::default();
        Ok(StagingToken { generation })
    }
    fn observe_unchanged(&mut self, token: &StagingToken, path: &str) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        self.load()?;
        let id = self
            .snapshot
            .borrow()
            .as_ref()
            .and_then(|snapshot| snapshot.id_at(path));
        let staging = self.staging_mut()?;
        match id.and_then(|id| u32::try_from(id).ok()) {
            Some(id) => staging.kept.push(id),
            None => staging.missing_unchanged = true,
        }
        Ok(())
    }
    fn observe_unchanged_committed(
        &mut self,
        token: &StagingToken,
        path: &str,
        committed_index: usize,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        let matches = self.snapshot.borrow().as_ref().is_some_and(|snapshot| {
            committed_index < snapshot.inventory.len() && snapshot.path(committed_index) == path
        });
        match u32::try_from(committed_index) {
            Ok(id) if matches => {
                self.staging_mut()?.kept.push(id);
                Ok(())
            }
            _ => self.observe_unchanged(token, path),
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
        let snapshot = self.snapshot.borrow();
        let staging = self.staging.as_mut().ok_or_else(no_staging)?;
        if entry.header.is_some() && staging.dictionary.is_none() {
            let prior = snapshot.as_ref().map(Snapshot::strings).transpose()?;
            staging.dictionary = Some(Dictionary::new(prior)?);
        }
        let offset = staging.records.len();
        encode_record(
            entry.header.as_ref(),
            &mut staging.dictionary,
            &mut staging.records,
        )?;
        let len = u32::try_from(staging.records.len() - offset)
            .map_err(|_| corrupt("Catalog record exceeds u32"))?;
        let header = entry.header;
        staging.changed.push(StagedRecord {
            signature: entry.signature,
            profile: header.as_ref().map(|h| h.profile_version),
            failure: header.as_ref().is_some_and(|h| h.failure_code.is_some()),
            header_data: header.and_then(|h| h.header_data),
            offset,
            len,
        });
        drop(snapshot);
        self.writes.staged_evidence_rows += 1;
        self.writes.evidence_write_duration += started.elapsed();
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
        let mut staging = self.staging.take().ok_or_else(no_staging)?;
        // Observations arrive in ordered runs. Sort once; dedup retains set semantics for
        // repeated observations.
        staging.kept.sort_unstable();
        staging.kept.dedup();
        let mut cleanup = None;
        let reuse = self.manifest.is_some()
            && staging.changed.is_empty()
            && !staging.missing_unchanged
            && summary.removed_packages == 0
            && self
                .snapshot
                .borrow()
                .as_ref()
                .is_some_and(|snapshot| snapshot.inventory.len() == staging.kept.len());
        let (physical_snapshot, previous_snapshot) = if let Some(current) = &self.manifest
            && reuse
        {
            (
                current.physical_snapshot.clone(),
                current.previous_snapshot.clone(),
            )
        } else {
            let started = Instant::now();
            let physical = snapshot_file_name(token.generation);
            let path = self.directory.join(&physical);
            let (file, guard) = create_unpublished(&path)?;
            cleanup = Some(guard);
            let (count, header) = write_snapshot(file, staging, self.snapshot.borrow().as_ref())?;
            // Reread the persisted bytes against their checksums before publication; included
            // in commit timing.
            verify_written(&path, &header)?;
            self.writes.committed_evidence_rows = count as u64;
            self.writes.removed_evidence_rows = summary.removed_packages;
            self.writes.evidence_write_duration += started.elapsed();
            (
                physical,
                self.manifest.as_ref().map(|m| m.physical_snapshot.clone()),
            )
        };
        let manifest = Manifest {
            manifest_schema_version: MANIFEST_SCHEMA_VERSION,
            snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
            project_id: self.project_id.to_string(),
            physical_snapshot,
            previous_snapshot,
            summary: ManifestSummary::from_refresh(&summary),
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
        self.snapshot.take();
        cleanup_retired_snapshots(&self.directory, &manifest);
        self.manifest = Some(manifest);
        Ok(token.generation)
    }
    fn discard_refresh(&mut self, token: StagingToken) -> Result<(), CatalogError> {
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
        self.snapshot.take();
        quarantine_directory(&self.directory)?;
        fs::create_dir_all(&self.directory).map_err(io_unavailable("recreate binary Catalog"))?;
        self.manifest = None;
        self.publication_uncertain = false;
        self.writes = CatalogWriteCounts::default();
        Ok(())
    }
    fn query(&self, request: &QueryRequest) -> Result<QueryPage, CatalogError> {
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
        let cached = self.snapshot.borrow();
        let snapshot = cached
            .as_ref()
            .ok_or_else(|| corrupt("binary Catalog snapshot is not loaded"))?;
        if matches!(
            request.kind,
            QueryKind::Dependencies { .. } | QueryKind::Dependents { .. }
        ) {
            let graph = BinaryGraph {
                snapshot,
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
        let after = snapshot.after(&cursor);
        let ids = snapshot.matches(&request.kind, after, request.limit + 1)?;
        let more = ids.len() > request.limit;
        let selected = &ids[..ids.len().min(request.limit)];
        let mut items = Vec::with_capacity(selected.len());
        match &request.kind {
            // Inventory rows carry their header data: an inventory page reads no records.
            QueryKind::Inventory => {
                for &id in selected {
                    items.push(QueryItem::Inventory {
                        package_path: snapshot.path(id).to_owned(),
                        signature: snapshot.bundle_signature(id),
                        header_data: snapshot.inventory[id].header_data.clone(),
                    });
                }
            }
            // A map page needs only each record's package name.
            QueryKind::Maps => snapshot.records(selected, |id, header| {
                let path = snapshot.path(id);
                items.push(QueryItem::Map {
                    package_name: header
                        .map(|h| h.package_name)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(path)
                        .to_owned(),
                    map_path: path.to_owned(),
                });
                Ok(())
            })?,
            _ => {
                let strings = &snapshot.strings()?.table;
                snapshot.records(selected, |id, header| {
                    let header =
                        header.ok_or_else(|| corrupt("posting refers to missing header"))?;
                    items.push(QueryItem::Header {
                        header_data: header.header_data.clone(),
                        package_path: snapshot.path(id).to_owned(),
                        package_name: header.package_name.to_owned(),
                        classes: header
                            .class_ids()
                            .map(|id| strings.get(id as usize).to_owned())
                            .collect(),
                        serialized_names: header
                            .name_ids()
                            .map(|id| strings.get(id as usize).to_owned())
                            .collect(),
                    });
                    Ok(())
                })?;
            }
        }
        let next_cursor = if more {
            items.last().map(|i| item_path(i).to_owned())
        } else {
            None
        };
        Ok(QueryPage {
            project_id: request.project_id.clone(),
            generation,
            items,
            next_cursor,
        })
    }

    fn count(
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
        let cached = self.snapshot.borrow();
        let snapshot = cached
            .as_ref()
            .ok_or_else(|| corrupt("binary Catalog snapshot is not loaded"))?;
        // One byte per inventory entry bounds union memory independently of match count.
        let mut matched = vec![false; snapshot.inventory.len()];
        let mut count = 0;
        for filter in &request.filters {
            for id in snapshot.matches(filter, 0, snapshot.inventory.len())? {
                if !matched[id] {
                    matched[id] = true;
                    count += 1;
                }
            }
        }
        Ok(super::catalog::CountResult {
            project_id: request.project_id.clone(),
            generation,
            count,
        })
    }
}
/// One loaded snapshot read as a dependency graph: inventory ids are nodes, in path order.
struct BinaryGraph<'a> {
    snapshot: &'a Snapshot,
    mounts: Vec<MountPoint>,
}

impl DependencyGraph for BinaryGraph<'_> {
    type Node = usize;

    fn mount_points(&self) -> &[MountPoint] {
        &self.mounts
    }

    fn package_at(
        &self,
        relative_path: &str,
        ignore_case: bool,
    ) -> Result<Option<usize>, CatalogError> {
        Ok(self.snapshot.package_id_at(relative_path, ignore_case))
    }

    fn package_path(&self, node: &usize) -> String {
        self.snapshot.path(*node).to_owned()
    }

    fn evidence(&self, nodes: &[usize]) -> Result<Vec<Option<HeaderEvidence>>, CatalogError> {
        self.snapshot.headers(nodes)
    }

    fn referrers(&self, package_names: &[String]) -> Result<Vec<usize>, CatalogError> {
        self.snapshot.referrers(package_names)
    }

    fn class_members(
        &self,
        classes: &[String],
    ) -> Result<std::collections::HashSet<usize>, CatalogError> {
        let mut members = std::collections::HashSet::new();
        let mut last = LastBlock::default();
        for class in classes {
            if let Some(id) = self.snapshot.string_id(class)?
                && let Some(index) = self.snapshot.posting_index(CLASS_POSTINGS, id)?
            {
                members.extend(self.snapshot.posting_ids_reusing(&mut last, index)?);
            }
        }
        Ok(members)
    }
}

impl CatalogSnapshot for BinaryCatalog {
    fn committed_entries(&self) -> Result<Vec<CatalogSnapshotEntry>, CatalogError> {
        self.load()?;
        Ok(self.snapshot.borrow().as_ref().map_or_else(Vec::new, |s| {
            s.inventory
                .iter()
                .enumerate()
                .map(|(id, e)| CatalogSnapshotEntry {
                    signature: s.signature(id),
                    header_profile_version: e.profile,
                    header_failure: e.failure,
                })
                .collect()
        }))
    }

    fn with_committed_entries<R>(
        &self,
        visit: impl FnOnce(&[CommittedEntry<'_>]) -> R,
    ) -> Result<R, CatalogError> {
        self.load()?;
        let cached = self.snapshot.borrow();
        let entries = cached.as_ref().map_or_else(Vec::new, |s| {
            s.inventory
                .iter()
                .enumerate()
                .map(|(id, e)| CommittedEntry {
                    relative_path: s.path(id),
                    kind: e.kind,
                    size: e.size,
                    modified_nanos: e.modified_nanos,
                    header_profile_version: e.profile,
                    header_failure: e.failure,
                })
                .collect()
        });
        Ok(visit(&entries))
    }
}

/// Where a merged inventory row's record comes from.
enum RecordSource {
    Kept(usize),
    Changed(usize),
}

/// Writes the next generation: kept rows (their records copied from the committed snapshot)
/// merged in path order with the changed ones. Postings are derived from the records written,
/// so the committed postings are never read. Records and postings are compressed batch by batch
/// as they are produced. Returns the row count and the header written.
fn write_snapshot(
    mut file: File,
    staging: Staging,
    prior: Option<&Snapshot>,
) -> Result<(usize, SnapshotHeader), CatalogError> {
    let Staging {
        kept,
        missing_unchanged,
        changed,
        records,
        dictionary,
        ..
    } = staging;
    if missing_unchanged {
        return Err(corrupt("unchanged record missing from prior snapshot"));
    }
    if !kept.is_empty() && prior.is_none() {
        return Err(corrupt("unchanged record missing from prior snapshot"));
    }
    let string_count = match &dictionary {
        Some(dictionary) => dictionary.len() as u64,
        None => prior.map_or(0, |p| p.header.strings),
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

    let mut inventory = Vec::new();
    put32(&mut inventory, 0)?;
    let mut payload = SectionWriter::new();
    let strings_len = usize::try_from(string_count).map_err(|_| corrupt("too many strings"))?;
    // String IDs are dense and already validated. Index directly while building postings,
    // avoiding a hash lookup for every class/name occurrence in the project.
    let mut postings: [Vec<Vec<u32>>; POSTING_KINDS] =
        std::array::from_fn(|_| vec![Vec::new(); strings_len]);
    let mut last_block = LastBlock::default();
    let mut kept_bytes = Vec::new();
    let (mut packages, mut maps) = (0_u64, 0_u64);
    let mut rows = 0_usize;
    let (mut kept_cursor, mut changed_cursor) = (kept.iter().peekable(), order.iter().peekable());
    loop {
        let kept_path = kept_cursor
            .peek()
            .and_then(|id| Some(prior?.path(**id as usize)));
        let changed_path = changed_cursor
            .peek()
            .map(|index| changed[**index].signature.relative_path.as_str());
        let source = match (kept_path, changed_path) {
            (None, None) => break,
            (Some(_), None) => RecordSource::Kept(*kept_cursor.next().unwrap_or(&0) as usize),
            (None, Some(_)) => RecordSource::Changed(*changed_cursor.next().unwrap_or(&0)),
            (Some(kept_path), Some(changed_path)) => match kept_path.cmp(changed_path) {
                std::cmp::Ordering::Less => {
                    RecordSource::Kept(*kept_cursor.next().unwrap_or(&0) as usize)
                }
                std::cmp::Ordering::Greater => {
                    RecordSource::Changed(*changed_cursor.next().unwrap_or(&0))
                }
                // A path staged again replaces its unchanged observation.
                std::cmp::Ordering::Equal => {
                    kept_cursor.next();
                    RecordSource::Changed(*changed_cursor.next().unwrap_or(&0))
                }
            },
        };
        let id = u32::try_from(rows).map_err(|_| corrupt("Catalog count exceeds u32"))?;
        let offset = payload.len();
        let (path, mut entry, record): (&str, InventoryEntry, &[u8]) = match source {
            RecordSource::Kept(old) => {
                let prior = prior.ok_or_else(|| corrupt("unchanged record missing"))?;
                let entry = prior
                    .inventory
                    .get(old)
                    .ok_or_else(|| corrupt("unchanged record missing from prior snapshot"))?
                    .clone();
                prior.range_reusing(
                    &mut last_block,
                    RECORDS,
                    entry.offset,
                    u64::from(entry.len),
                    &mut kept_bytes,
                )?;
                if checksum(&kept_bytes) != entry.checksum {
                    return Err(corrupt("record checksum mismatch"));
                }
                (prior.path(old), entry, &kept_bytes)
            }
            RecordSource::Changed(index) => {
                let staged = &changed[index];
                let record = &records[staged.offset..staged.offset + staged.len as usize];
                let path = staged.signature.relative_path.as_str();
                let entry = InventoryEntry {
                    kind: staged.signature.kind,
                    size: staged.signature.size,
                    modified_nanos: staged.signature.modified_nanos,
                    profile: staged.profile,
                    failure: staged.failure,
                    is_map: staged.signature.kind == EntryKind::Package && is_map_path(path),
                    offset: 0,
                    len: staged.len,
                    checksum: checksum(record),
                    header_data: staged.header_data.clone(),
                };
                (path, entry, record)
            }
        };
        if entry.kind == EntryKind::Package
            && let Some(header) = decode_record(record, string_count)?
        {
            let mut post = |kind: usize, value: u32| {
                let list = &mut postings[kind][value as usize];
                if list.last() != Some(&id) {
                    list.push(id);
                }
            };
            header.class_ids().for_each(|value| post(0, value));
            header.name_ids().for_each(|value| post(1, value));
            header
                .dependency_ids()
                .for_each(|(value, _)| post(DEPENDENCY_POSTINGS as usize, value));
        }
        payload.push(record)?;
        entry.offset = offset;
        packages += u64::from(entry.kind == EntryKind::Package);
        maps += u64::from(entry.is_map);
        encode_inventory_entry(&mut inventory, path, &entry)?;
        rows += 1;
    }
    drop(kept_bytes);
    drop(last_block);
    drop(records);
    drop(changed);
    let row_count = u32::try_from(rows).map_err(|_| corrupt("Catalog count exceeds u32"))?;
    inventory[..4].copy_from_slice(&row_count.to_le_bytes());
    let payload = payload.finish()?;

    let mut directory = Vec::new();
    let mut lists = SectionWriter::new();
    let posting_count = postings
        .iter()
        .flatten()
        .filter(|ids| !ids.is_empty())
        .count();
    put32(&mut directory, posting_count)?;
    let mut list_bytes = Vec::new();
    for (kind, values) in postings.into_iter().enumerate() {
        for (value, ids) in values.into_iter().enumerate() {
            if ids.is_empty() {
                continue;
            }
            list_bytes.clear();
            for id in &ids {
                list_bytes.extend_from_slice(&id.to_le_bytes());
            }
            directory.push(kind as u8);
            directory.extend_from_slice(&(value as u32).to_le_bytes());
            put64(&mut directory, lists.len());
            put32(&mut directory, ids.len())?;
            put64(&mut directory, checksum(&list_bytes));
            lists.push(&list_bytes)?;
        }
    }
    let lists = lists.finish()?;
    let inventory = encode_section(&inventory)?;
    let strings = match (&dictionary, prior) {
        (Some(dictionary), _) => encode_section(&dictionary.encode()?)?,
        // No string was added: the committed section is copied as stored.
        (None, Some(prior)) => prior.stored_section(STRINGS)?,
        (None, None) => encode_section(&0_u32.to_le_bytes())?,
    };
    drop(dictionary);
    let directory = encode_section(&directory)?;
    let sections = [inventory, strings, directory, lists, payload];
    let header = SnapshotHeader {
        sections: std::array::from_fn(|index| sections[index].header),
        packages,
        maps,
        strings: string_count,
    };
    publication_checkpoint("snapshot_created")?;
    file.write_all(&header.encode())
        .map_err(io_unavailable("write binary directory"))?;
    publication_checkpoint("snapshot_partial")?;
    for section in &sections {
        section.write(&mut file)?;
    }
    publication_checkpoint("before_sync")?;
    file.sync_all()
        .map_err(io_unavailable("sync binary snapshot"))?;
    publication_checkpoint("after_sync")?;
    Ok((rows, header))
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
        || !valid_snapshot_name(&manifest.physical_snapshot)
        || manifest
            .previous_snapshot
            .as_deref()
            .is_some_and(|name| !valid_snapshot_name(name))
    {
        return Err(CatalogError::Corrupt {
            message: "the binary Catalog manifest is incompatible or belongs to another project"
                .to_owned(),
        });
    }
    let snapshot = directory.join(&manifest.physical_snapshot);
    if !snapshot.is_file() {
        return Err(CatalogError::Corrupt {
            message: "the binary Catalog manifest names a missing snapshot".to_owned(),
        });
    }
    Ok(Some(manifest))
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
    let retained = [
        Some(manifest.physical_snapshot.as_str()),
        manifest.previous_snapshot.as_deref(),
    ];
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

fn snapshot_file_name(generation: Generation) -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "snapshot-{}-{}-{nonce}.catalog",
        generation.get(),
        std::process::id()
    )
}

fn valid_snapshot_name(name: &str) -> bool {
    name.starts_with("snapshot-")
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
        self.snapshot.take();
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

    impl Snapshot {
        /// Every check a snapshot has: every stored byte, every section decoded and validated,
        /// and every block's decoded checksum.
        fn open_fully(path: &Path) -> Result<Self, CatalogError> {
            let snapshot = Self::open(path, SnapshotCheck::Stored)?;
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
        let snapshot = catalog.snapshot.borrow();
        let snapshot = snapshot.as_ref().unwrap();
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
            owner.snapshot.take();
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
        let status = BinaryCatalog::open_for_status(&root, &fixture_project_id()).unwrap();
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
        let status = BinaryCatalog::open_for_status(&root, &fixture_project_id()).unwrap();
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
        *bytes.last_mut().unwrap() ^= 0x40;
        fs::write(&path, bytes).unwrap();
        writer.snapshot.take();
        release_test_writer(&mut writer);
        let reader = BinaryCatalog::open_for_query(&root, &fixture_project_id()).unwrap();
        reader.load().unwrap();
        let snapshot = reader.snapshot.borrow();
        let snapshot = snapshot.as_ref().unwrap();
        assert!(snapshot.packed(snapshot.inventory.len() - 1).is_err());
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
                owner.snapshot.take();
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
    #[cfg(feature = "catalog-oracle")]
    fn deterministic_mutation_sequences_match_sqlite_on_every_page() {
        use crate::direct_executor::catalog_conformance::{
            FakeScanner, collect_pages, header, package, sidecar,
        };
        use crate::direct_executor::catalog_sqlite::SqliteCatalog;
        let mut binary = custom_catalog();
        let root = binary.cleanup_root.as_ref().unwrap().clone();
        let mut sqlite = SqliteCatalog::open(&root, &fixture_project_id()).unwrap();
        let mut state = std::collections::BTreeMap::new();
        let mut random = 0x123456789abcdef_u64;
        for generation in 0..12 {
            for _ in 0..40 {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                let id = (random >> 32) % 96;
                if random.is_multiple_of(7) {
                    state.remove(&id);
                } else {
                    state.insert(id, generation);
                }
            }
            let mut scanner = FakeScanner::default();
            for (&id, &version) in &state {
                let path = format!(
                    "Content/{id:04}.{}",
                    if id % 9 == 0 { "umap" } else { "uasset" }
                );
                scanner.entries.push(package(&path, id + 1, version + 1));
                if id % 13 != 0 || version % 2 == 1 {
                    let class = if version % 2 == 0 {
                        "/Script/Test.Widget"
                    } else {
                        "/Script/Test.OtherWidget"
                    };
                    scanner.headers.insert(
                        path.clone(),
                        header(
                            &format!("/Game/{id}"),
                            &[class, "NoDot", "Ã©.ðŸ”§"],
                            &[
                                "None",
                                "Ã©",
                                if id % 3 == 0 { "Rare" } else { "Common" },
                                "None",
                            ],
                        ),
                    );
                }
                if id % 11 == 0 {
                    scanner
                        .entries
                        .push(sidecar(&format!("Content/{id:04}.uexp"), 5, version + 1));
                }
            }
            scanner.entries.reverse();
            refresh(
                &mut binary,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .unwrap();
            refresh(
                &mut sqlite,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .unwrap();
            assert_eq!(binary.status(), sqlite.status());
            assert_eq!(
                binary.committed_entries().unwrap(),
                sqlite.committed_entries().unwrap()
            );
            let current = binary.committed_generation().unwrap();
            let kinds = [
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
                    values: vec!["Ã©".into()],
                },
                QueryKind::SerializedNames { values: vec![] },
            ];
            let union = super::super::catalog::CountRequest {
                project_id: fixture_project_id(),
                expected_generation: current,
                filters: kinds.to_vec(),
            };
            assert_eq!(binary.count(&union).unwrap(), sqlite.count(&union).unwrap());
            for kind in kinds {
                let request = super::super::catalog::CountRequest {
                    filters: vec![kind.clone(), kind.clone()],
                    ..union.clone()
                };
                assert_eq!(
                    binary.count(&request).unwrap(),
                    sqlite.count(&request).unwrap()
                );
                for limit in [1, 7, 1024] {
                    assert_eq!(
                        collect_pages(&binary, current, kind.clone(), limit),
                        collect_pages(&sqlite, current, kind.clone(), limit),
                        "generation {generation}, query {kind:?}, limit {limit}"
                    );
                }
            }
        }
        // Close both before their shared disposable root is removed on Windows.
        drop(sqlite);
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
}
