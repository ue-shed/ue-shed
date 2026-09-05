//! Binary Catalog prototype, assembled only by prepare_custom_catalog.py.
//! Five checksummed sections: inventory, shared strings, posting directory, postings, records.
//! All integers are little-endian. This is a research format, not a compatibility promise.
use super::catalog::*;
use super::project_index::CatalogSnapshot;
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CATALOG_DIRECTORY: &str = "catalogs-custom-research-v1";
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const MAX_QUARANTINE_SLOTS: u32 = 64;
const MAGIC: &[u8; 8] = b"UESHC001";
const HEADER_BYTES: u64 = 88;
const MAX_SECTION_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CatalogWriteCounts {
    pub(crate) staged_evidence_rows: u64,
    pub(crate) committed_evidence_rows: u64,
    pub(crate) removed_evidence_rows: u64,
    pub(crate) evidence_write_duration: Duration,
}

// @MANIFEST_TYPES@

fn corrupt(message: impl Into<String>) -> CatalogError {
    CatalogError::Corrupt {
        message: message.into(),
    }
}

fn checksum(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn put32(out: &mut Vec<u8>, value: usize) -> Result<(), CatalogError> {
    let value = u32::try_from(value).map_err(|_| corrupt("prototype count exceeds u32"))?;
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
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, CatalogError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn count(&mut self, minimum_width: usize) -> Result<usize, CatalogError> {
        let count = self.u32()? as usize;
        if count > (self.bytes.len() - self.position) / minimum_width {
            return Err(corrupt("impossible binary count"));
        }
        Ok(count)
    }
    fn string(&mut self) -> Result<String, CatalogError> {
        let len = self.count(1)?;
        String::from_utf8(self.take(len)?.to_vec()).map_err(|_| corrupt("invalid UTF-8"))
    }
    fn finish(self) -> Result<(), CatalogError> {
        if self.position == self.bytes.len() {
            Ok(())
        } else {
            Err(corrupt("trailing binary bytes"))
        }
    }
}

#[derive(Default)]
struct Dictionary {
    strings: Vec<String>,
    ids: HashMap<String, u32>,
}
impl Dictionary {
    fn from_strings(strings: Vec<String>) -> Self {
        let ids = strings
            .iter()
            .enumerate()
            .map(|(i, s)| (s.clone(), i as u32))
            .collect();
        Self { strings, ids }
    }
    fn intern(&mut self, value: &str) -> Result<u32, CatalogError> {
        if let Some(id) = self.ids.get(value) {
            return Ok(*id);
        }
        let id =
            u32::try_from(self.strings.len()).map_err(|_| corrupt("too many shared strings"))?;
        self.strings.push(value.to_owned());
        self.ids.insert(value.to_owned(), id);
        Ok(id)
    }
}

struct PackedHeader {
    package_name: String,
    classes: Vec<u32>,
    names: Vec<u32>,
    failure_code: Option<String>,
}
struct PackedRecord {
    signature: PackageSignature,
    profile: Option<u32>,
    header: Option<PackedHeader>,
}
impl PackedRecord {
    fn pack(entry: StagedPackage, dictionary: &mut Dictionary) -> Result<Self, CatalogError> {
        let profile = entry.header.as_ref().map(|h| h.profile_version);
        let header = entry
            .header
            .map(|h| -> Result<_, CatalogError> {
                Ok(PackedHeader {
                    package_name: h.package_name,
                    classes: h
                        .classes
                        .iter()
                        .map(|s| dictionary.intern(s))
                        .collect::<Result<_, _>>()?,
                    names: h
                        .serialized_names
                        .iter()
                        .map(|s| dictionary.intern(s))
                        .collect::<Result<_, _>>()?,
                    failure_code: h.failure_code,
                })
            })
            .transpose()?;
        Ok(Self {
            signature: entry.signature,
            profile,
            header,
        })
    }
    fn encode(&self, out: &mut Vec<u8>) -> Result<(), CatalogError> {
        out.push(u8::from(self.header.is_some()));
        if let Some(header) = &self.header {
            put_string(out, &header.package_name)?;
            out.push(u8::from(header.failure_code.is_some()));
            if let Some(code) = &header.failure_code {
                put_string(out, code)?;
            }
            for ids in [&header.classes, &header.names] {
                put32(out, ids.len())?;
                for id in ids {
                    out.extend_from_slice(&id.to_le_bytes());
                }
            }
        }
        Ok(())
    }
}

struct Inventory {
    signature: PackageSignature,
    profile: Option<u32>,
    failure: bool,
    is_map: bool,
    offset: u64,
    len: u32,
    checksum: u64,
}
struct Posting {
    kind: u8,
    value: u32,
    offset: u64,
    len: u32,
    checksum: u64,
}
struct Snapshot {
    file: RefCell<File>,
    inventory: Vec<Inventory>,
    strings: Vec<String>,
    lexicon: Vec<u32>,
    postings: Vec<Posting>,
    starts: [u64; 5],
}

fn read_range(file: &mut File, offset: u64, length: u64) -> Result<Vec<u8>, CatalogError> {
    if length > MAX_SECTION_BYTES {
        return Err(corrupt("prototype section exceeds 512 MiB"));
    }
    let length =
        usize::try_from(length).map_err(|_| corrupt("section too large for address space"))?;
    let mut bytes = vec![0; length];
    file.seek(SeekFrom::Start(offset))
        .map_err(io_unavailable("seek binary snapshot"))?;
    file.read_exact(&mut bytes)
        .map_err(|error| corrupt(format!("cannot read binary snapshot: {error}")))?;
    Ok(bytes)
}
fn checked_range(offset: u64, len: u64, total: u64) -> Result<(), CatalogError> {
    if offset.checked_add(len).is_none_or(|end| end > total) {
        return Err(corrupt("binary range leaves its section"));
    }
    Ok(())
}

impl Snapshot {
    fn open(path: &Path, verify_all: bool) -> Result<Self, CatalogError> {
        let mut file = File::open(path).map_err(io_unavailable("open binary snapshot"))?;
        let length = file
            .metadata()
            .map_err(io_unavailable("stat binary snapshot"))?
            .len();
        let header = read_range(&mut file, 0, HEADER_BYTES)?;
        let mut decoder = Decoder::new(&header);
        if decoder.take(8)? != MAGIC {
            return Err(corrupt("unknown binary Catalog format"));
        }
        let mut lengths = [0; 5];
        let mut hashes = [0; 5];
        let mut starts = [0; 5];
        let mut position = HEADER_BYTES;
        for i in 0..5 {
            lengths[i] = decoder.u64()?;
            hashes[i] = decoder.u64()?;
            starts[i] = position;
            if lengths[i] > MAX_SECTION_BYTES {
                return Err(corrupt("oversized binary section"));
            }
            position = position
                .checked_add(lengths[i])
                .ok_or_else(|| corrupt("section overflow"))?;
        }
        if position != length {
            return Err(corrupt("snapshot length does not match its directory"));
        }
        let mut sections = Vec::new();
        for i in 0..if verify_all { 5 } else { 3 } {
            let bytes = read_range(&mut file, starts[i], lengths[i])?;
            if checksum(&bytes) != hashes[i] {
                return Err(corrupt("binary section checksum mismatch"));
            }
            if i < 3 {
                sections.push(bytes);
            }
        }
        let mut d = Decoder::new(&sections[0]);
        let count = d.count(43)?;
        let mut inventory: Vec<Inventory> = Vec::with_capacity(count);
        for _ in 0..count {
            let relative_path = d.string()?;
            if inventory
                .last()
                .is_some_and(|e| e.signature.relative_path >= relative_path)
            {
                return Err(corrupt("inventory paths must be strictly ordered"));
            }
            let kind = d.byte()?;
            if kind > 1 {
                return Err(corrupt("invalid entry kind"));
            }
            let kind = decode_kind(kind);
            let signature = PackageSignature {
                relative_path,
                kind,
                size: d.u64()?,
                modified_nanos: d.u64()?,
            };
            let profile = if d.boolean()? { Some(d.u32()?) } else { None };
            let failure = d.boolean()?;
            let offset = d.u64()?;
            let len = d.u32()?;
            let hash = d.u64()?;
            checked_range(offset, u64::from(len), lengths[4])?;
            inventory.push(Inventory {
                is_map: is_map(&signature),
                signature,
                profile,
                failure,
                offset,
                len,
                checksum: hash,
            });
        }
        d.finish()?;
        let mut d = Decoder::new(&sections[1]);
        let count = d.count(8)?;
        let mut strings = Vec::with_capacity(count);
        for _ in 0..count {
            strings.push(d.string()?);
        }
        let mut lexicon: Vec<u32> = Vec::with_capacity(count);
        for _ in 0..count {
            let id = d.u32()?;
            let text = strings
                .get(id as usize)
                .ok_or_else(|| corrupt("invalid dictionary id"))?;
            if lexicon
                .last()
                .is_some_and(|prior| strings[*prior as usize] >= *text)
            {
                return Err(corrupt("dictionary must be unique and ordered"));
            }
            lexicon.push(id);
        }
        d.finish()?;
        let mut d = Decoder::new(&sections[2]);
        let count = d.count(25)?;
        let mut postings: Vec<Posting> = Vec::with_capacity(count);
        for _ in 0..count {
            let kind = d.byte()?;
            let value = d.u32()?;
            let offset = d.u64()?;
            let len = d.u32()?;
            let hash = d.u64()?;
            if kind > 1 || value as usize >= strings.len() || len as usize > inventory.len() {
                return Err(corrupt("invalid posting metadata"));
            }
            if postings
                .last()
                .is_some_and(|p| (p.kind, p.value) >= (kind, value))
            {
                return Err(corrupt("posting keys must be strictly ordered"));
            }
            checked_range(offset, u64::from(len) * 4, lengths[3])?;
            postings.push(Posting {
                kind,
                value,
                offset,
                len,
                checksum: hash,
            });
        }
        d.finish()?;
        Ok(Self {
            file: RefCell::new(file),
            inventory,
            strings,
            lexicon,
            postings,
            starts,
        })
    }
    fn packed(&self, id: usize) -> Result<PackedRecord, CatalogError> {
        let entry = self
            .inventory
            .get(id)
            .ok_or_else(|| corrupt("invalid inventory id"))?;
        let bytes = read_range(
            &mut self.file.borrow_mut(),
            self.starts[4] + entry.offset,
            u64::from(entry.len),
        )?;
        if checksum(&bytes) != entry.checksum {
            return Err(corrupt("record checksum mismatch"));
        }
        let mut d = Decoder::new(&bytes);
        let header = if d.boolean()? {
            let package_name = d.string()?;
            let failure_code = if d.boolean()? {
                Some(d.string()?)
            } else {
                None
            };
            let mut lists = Vec::with_capacity(2);
            for _ in 0..2 {
                let count = d.count(4)?;
                let mut ids = Vec::with_capacity(count);
                for _ in 0..count {
                    let id = d.u32()?;
                    if id as usize >= self.strings.len() {
                        return Err(corrupt("invalid evidence string id"));
                    }
                    ids.push(id);
                }
                lists.push(ids);
            }
            let names = lists.pop().unwrap();
            let classes = lists.pop().unwrap();
            Some(PackedHeader {
                package_name,
                classes,
                names,
                failure_code,
            })
        } else {
            None
        };
        d.finish()?;
        if header.is_some() != entry.profile.is_some()
            || header.as_ref().is_some_and(|h| h.failure_code.is_some()) != entry.failure
        {
            return Err(corrupt("inventory/header mismatch"));
        }
        Ok(PackedRecord {
            signature: entry.signature.clone(),
            profile: entry.profile,
            header,
        })
    }
    fn header(&self, id: usize) -> Result<Option<HeaderEvidence>, CatalogError> {
        let packed = self.packed(id)?;
        Ok(packed.header.map(|h| HeaderEvidence {
            profile_version: packed.profile.unwrap(),
            package_name: h.package_name,
            failure_code: h.failure_code,
            classes: h
                .classes
                .into_iter()
                .map(|id| self.strings[id as usize].clone())
                .collect(),
            serialized_names: h
                .names
                .into_iter()
                .map(|id| self.strings[id as usize].clone())
                .collect(),
        }))
    }
    fn string_id(&self, value: &str) -> Option<u32> {
        self.lexicon
            .binary_search_by(|id| self.strings[*id as usize].as_str().cmp(value))
            .ok()
            .map(|index| self.lexicon[index])
    }
    fn matches(
        &self,
        kind: &QueryKind,
        after: usize,
        limit: usize,
    ) -> Result<Vec<usize>, CatalogError> {
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
        let mut selected = BTreeSet::new();
        match kind {
            QueryKind::ExactClasses { values } | QueryKind::SerializedNames { values } => {
                let tag = u8::from(matches!(kind, QueryKind::SerializedNames { .. }));
                for value in values {
                    if let Some(id) = self.string_id(value)
                        && let Ok(index) = self
                            .postings
                            .binary_search_by_key(&(tag, id), |p| (p.kind, p.value))
                    {
                        selected.insert(index);
                    }
                }
            }
            QueryKind::ClassPrefixes { values } | QueryKind::ClassNameSuffixes { values } => {
                for (index, posting) in self
                    .postings
                    .iter()
                    .enumerate()
                    .take_while(|(_, p)| p.kind == 0)
                {
                    let text = &self.strings[posting.value as usize];
                    if values.iter().any(|value| {
                        if matches!(kind, QueryKind::ClassPrefixes { .. }) {
                            text.starts_with(value)
                        } else {
                            class_name(text).ends_with(value)
                        }
                    }) {
                        selected.insert(index);
                    }
                }
            }
            QueryKind::Maps => unreachable!(),
        }
        let mut ids = BTreeSet::new();
        for index in selected {
            let posting = &self.postings[index];
            let bytes = read_range(
                &mut self.file.borrow_mut(),
                self.starts[3] + posting.offset,
                u64::from(posting.len) * 4,
            )?;
            if checksum(&bytes) != posting.checksum {
                return Err(corrupt("posting checksum mismatch"));
            }
            let mut previous = None;
            for raw in bytes.chunks_exact(4) {
                let id = u32::from_le_bytes(raw.try_into().unwrap()) as usize;
                if id >= self.inventory.len() || previous.is_some_and(|old| old >= id) {
                    return Err(corrupt("invalid posting row order"));
                }
                previous = Some(id);
                if id >= after {
                    ids.insert(id);
                    if ids.len() > limit {
                        ids.pop_last();
                    }
                }
            }
        }
        Ok(ids.into_iter().collect())
    }
}

struct Staging {
    generation: Generation,
    observed: BTreeSet<String>,
    changed: BTreeMap<String, PackedRecord>,
    dictionary: Option<Dictionary>,
}
struct Unpublished {
    path: PathBuf,
    published: bool,
}
impl Drop for Unpublished {
    fn drop(&mut self) {
        if !self.published {
            let _ = remove_if_exists(&self.path);
        }
    }
}

pub(crate) struct CustomCatalog {
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
impl std::fmt::Debug for CustomCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CustomCatalog")
            .field("project_id", &self.project_id)
            .finish()
    }
}
impl CustomCatalog {
    pub(crate) fn open(root: &Path, project_id: &ProjectId) -> Result<Self, CatalogError> {
        Self::open_checked(root, project_id, true)
    }
    pub(crate) fn open_for_query(
        root: &Path,
        project_id: &ProjectId,
    ) -> Result<Self, CatalogError> {
        Self::open_checked(root, project_id, false)
    }
    fn open_checked(
        root: &Path,
        project_id: &ProjectId,
        verify: bool,
    ) -> Result<Self, CatalogError> {
        let directory = root
            .join(CATALOG_DIRECTORY)
            .join(catalog_directory_name(project_id));
        fs::create_dir_all(&directory)
            .map_err(io_unavailable("create binary Catalog directory"))?;
        let opened = (|| {
            let manifest = read_and_verify_manifest(&directory, project_id, false)?;
            if manifest.as_ref().is_some_and(|m| {
                m.summary.generation == 0
                    || m.summary.map_count > m.summary.package_count
                    || !matches!(m.summary.completeness.as_str(), "complete" | "partial")
            }) {
                return Err(corrupt("invalid Catalog summary"));
            }
            let snapshot = if verify {
                manifest
                    .as_ref()
                    .map(|m| Snapshot::open(&directory.join(&m.physical_snapshot), true))
                    .transpose()?
            } else {
                None
            };
            Ok((manifest, snapshot))
        })();
        let (manifest, snapshot, quarantined_from) = match opened {
            Ok((manifest, snapshot)) => (manifest, snapshot, None),
            Err(CatalogError::Corrupt { .. }) => {
                let quarantine = quarantine_directory(&directory)?;
                fs::create_dir_all(&directory)
                    .map_err(io_unavailable("recreate binary Catalog"))?;
                (None, None, quarantine)
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
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
                false,
            )?);
        }
        Ok(())
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

impl Catalog for CustomCatalog {
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
        let id = snapshot
            .inventory
            .binary_search_by(|e| e.signature.relative_path.as_str().cmp(path))
            .ok()?;
        Some((
            snapshot.inventory[id].signature.clone(),
            snapshot.header(id).ok()?,
        ))
    }
    fn begin_refresh(&mut self) -> Result<StagingToken, CatalogError> {
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
            observed: BTreeSet::new(),
            changed: BTreeMap::new(),
            dictionary: None,
        });
        self.writes = CatalogWriteCounts::default();
        Ok(StagingToken { generation })
    }
    fn observe_unchanged(&mut self, token: &StagingToken, path: &str) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        self.staging.as_mut().unwrap().observed.insert(path.into());
        Ok(())
    }
    fn stage_observed(
        &mut self,
        token: &StagingToken,
        entry: StagedPackage,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        let started = Instant::now();
        self.load()?;
        let staging = self.staging.as_mut().unwrap();
        if staging.dictionary.is_none() {
            staging.dictionary = Some(Dictionary::from_strings(
                self.snapshot
                    .borrow()
                    .as_ref()
                    .map_or_else(Vec::new, |s| s.strings.clone()),
            ));
        }
        let record = PackedRecord::pack(entry, staging.dictionary.as_mut().unwrap())?;
        staging
            .observed
            .insert(record.signature.relative_path.clone());
        staging
            .changed
            .insert(record.signature.relative_path.clone(), record);
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
        let staging = self.staging.take().unwrap();
        let mut cleanup = None;
        let (physical_snapshot, previous_snapshot) = if let Some(current) = &self.manifest
            && staging.changed.is_empty()
            && summary.removed_packages == 0
        {
            (
                current.physical_snapshot.clone(),
                current.previous_snapshot.clone(),
            )
        } else {
            let started = Instant::now();
            let physical = snapshot_file_name(token.generation);
            let path = self.directory.join(&physical);
            cleanup = Some(Unpublished {
                path: path.clone(),
                published: false,
            });
            let count = write_snapshot(&path, staging, self.snapshot.borrow().as_ref())?;
            // Reopen and verify the persisted bytes before publication; included in commit timing.
            verify_snapshot(&path)?;
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
        publish_manifest(&self.directory, &manifest)?;
        if let Some(mut guard) = cleanup {
            guard.published = true;
        }
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
        self.staging.take();
        self.snapshot.take();
        quarantine_directory(&self.directory)?;
        fs::create_dir_all(&self.directory).map_err(io_unavailable("recreate binary Catalog"))?;
        self.manifest = None;
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
        let snapshot = cached.as_ref().unwrap();
        let after = snapshot
            .inventory
            .partition_point(|e| e.signature.relative_path <= cursor);
        let ids = snapshot.matches(&request.kind, after, request.limit + 1)?;
        let more = ids.len() > request.limit;
        let mut items = Vec::with_capacity(ids.len().min(request.limit));
        for id in ids.into_iter().take(request.limit) {
            let path = snapshot.inventory[id].signature.relative_path.clone();
            let header = snapshot.header(id)?;
            items.push(if matches!(request.kind, QueryKind::Maps) {
                QueryItem::Map {
                    package_name: header
                        .map(|h| h.package_name)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| path.clone()),
                    map_path: path,
                }
            } else {
                let header = header.ok_or_else(|| corrupt("posting refers to missing header"))?;
                QueryItem::Header {
                    package_path: path,
                    package_name: header.package_name,
                    classes: header.classes,
                    serialized_names: header.serialized_names,
                }
            });
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
}
impl CatalogSnapshot for CustomCatalog {
    fn committed_entries(&self) -> Result<Vec<CatalogSnapshotEntry>, CatalogError> {
        self.load()?;
        Ok(self.snapshot.borrow().as_ref().map_or_else(Vec::new, |s| {
            s.inventory
                .iter()
                .map(|e| CatalogSnapshotEntry {
                    signature: e.signature.clone(),
                    header_profile_version: e.profile,
                    header_failure: e.failure,
                })
                .collect()
        }))
    }
}

fn write_snapshot(
    path: &Path,
    mut staging: Staging,
    prior: Option<&Snapshot>,
) -> Result<usize, CatalogError> {
    let dictionary = staging.dictionary.take().unwrap_or_else(|| {
        Dictionary::from_strings(prior.map_or_else(Vec::new, |p| p.strings.clone()))
    });
    let mut inventory = Vec::new();
    let mut payload = Vec::new();
    let mut postings: HashMap<(u8, u32), Vec<u32>> = HashMap::new();
    put32(&mut inventory, staging.observed.len())?;
    for (id, name) in staging.observed.iter().enumerate() {
        let record = if let Some(record) = staging.changed.remove(name) {
            record
        } else {
            let prior = prior.ok_or_else(|| corrupt("unchanged record without prior snapshot"))?;
            let index = prior
                .inventory
                .binary_search_by(|e| e.signature.relative_path.cmp(name))
                .map_err(|_| corrupt("unchanged record missing from prior snapshot"))?;
            prior.packed(index)?
        };
        let offset = payload.len();
        record.encode(&mut payload)?;
        put_string(&mut inventory, &record.signature.relative_path)?;
        inventory.push(encode_kind(record.signature.kind));
        put64(&mut inventory, record.signature.size);
        put64(&mut inventory, record.signature.modified_nanos);
        inventory.push(u8::from(record.profile.is_some()));
        if let Some(profile) = record.profile {
            inventory.extend_from_slice(&profile.to_le_bytes());
        }
        inventory.push(u8::from(
            record
                .header
                .as_ref()
                .is_some_and(|h| h.failure_code.is_some()),
        ));
        put64(&mut inventory, offset as u64);
        put32(&mut inventory, payload.len() - offset)?;
        put64(&mut inventory, checksum(&payload[offset..]));
        if record.signature.kind == EntryKind::Package
            && let Some(header) = record.header
        {
            for (kind, values) in [(0, header.classes), (1, header.names)] {
                for value in values {
                    let list = postings.entry((kind, value)).or_default();
                    if list.last() != Some(&(id as u32)) {
                        list.push(id as u32);
                    }
                }
            }
        }
    }
    let mut strings = Vec::new();
    put32(&mut strings, dictionary.strings.len())?;
    for string in &dictionary.strings {
        put_string(&mut strings, string)?;
    }
    let mut lexicon = (0..dictionary.strings.len() as u32).collect::<Vec<_>>();
    lexicon.sort_unstable_by(|a, b| {
        dictionary.strings[*a as usize].cmp(&dictionary.strings[*b as usize])
    });
    for id in lexicon {
        strings.extend_from_slice(&id.to_le_bytes());
    }
    let mut directory = Vec::new();
    let mut lists = Vec::new();
    put32(&mut directory, postings.len())?;
    let mut ordered_postings = postings.into_iter().collect::<Vec<_>>();
    ordered_postings.sort_unstable_by_key(|(key, _)| *key);
    for ((kind, value), ids) in ordered_postings {
        directory.push(kind);
        directory.extend_from_slice(&value.to_le_bytes());
        put64(&mut directory, lists.len() as u64);
        put32(&mut directory, ids.len())?;
        let start = lists.len();
        for id in ids {
            lists.extend_from_slice(&id.to_le_bytes());
        }
        put64(&mut directory, checksum(&lists[start..]));
    }
    let sections = [inventory, strings, directory, lists, payload];
    let mut header = MAGIC.to_vec();
    for section in &sections {
        if section.len() as u64 > MAX_SECTION_BYTES {
            return Err(corrupt("prototype section exceeds 512 MiB"));
        }
        put64(&mut header, section.len() as u64);
        put64(&mut header, checksum(section));
    }
    let mut file = File::create_new(path).map_err(io_unavailable("create binary snapshot"))?;
    file.write_all(&header)
        .map_err(io_unavailable("write binary directory"))?;
    for section in sections {
        file.write_all(&section)
            .map_err(io_unavailable("write binary section"))?;
    }
    file.sync_all()
        .map_err(io_unavailable("sync binary snapshot"))?;
    Ok(staging.observed.len())
}

fn verify_snapshot(path: &Path) -> Result<(), CatalogError> {
    Snapshot::open(path, true).map(|_| ())
}

// @MANIFEST_HELPERS@

#[cfg(test)]
impl Drop for CustomCatalog {
    fn drop(&mut self) {
        self.staging.take();
        self.snapshot.take();
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
    fn custom_catalog() -> CustomCatalog {
        let root = std::env::temp_dir().join(format!(
            "ue-shed-binary-catalog-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut catalog = CustomCatalog::open(&root, &fixture_project_id()).unwrap();
        catalog.cleanup_root = Some(root);
        catalog
    }
    catalog_conformance_tests!(binary, custom_catalog);

    #[test]
    fn deterministic_mutation_sequences_match_sqlite_on_every_page() {
        use crate::direct_executor::catalog_conformance::{
            FakeScanner, collect_pages, header, package, sidecar,
        };
        use crate::direct_executor::catalog_sqlite::SqliteCatalog;
        let mut binary = custom_catalog();
        let root = binary.cleanup_root.as_ref().unwrap().clone();
        let mut sqlite = SqliteCatalog::open(&root, &fixture_project_id()).unwrap();
        let mut state = BTreeMap::new();
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
            for kind in kinds {
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
        let reader = CustomCatalog::open_for_query(&root, &fixture_project_id()).unwrap();
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
        let mut offset = HEADER_BYTES as usize;
        for section in 0..3 {
            let mut damaged = bytes.clone();
            let length = u64::from_le_bytes(
                bytes[8 + section * 16..16 + section * 16]
                    .try_into()
                    .unwrap(),
            ) as usize;
            damaged[offset..offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            let hash = checksum(&damaged[offset..offset + length]);
            damaged[16 + section * 16..24 + section * 16].copy_from_slice(&hash.to_le_bytes());
            fs::write(&scratch, damaged).unwrap();
            assert!(Snapshot::open(&scratch, true).is_err());
            offset += length;
        }
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
            assert!(Snapshot::open(&scratch, true).is_err());
        }
        for offset in (0..bytes.len()).step_by(17) {
            let mut damaged = bytes.clone();
            damaged[offset] ^= 0x40;
            fs::write(&scratch, damaged).unwrap();
            assert!(Snapshot::open(&scratch, true).is_err(), "offset {offset}");
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
