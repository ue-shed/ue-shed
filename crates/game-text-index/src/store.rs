//! Shared Game Text store. The directory, lock and atomic manifest are the Node store's format.
use crate::snapshot::{Reader, Writer, integers, u32_bytes};
use crate::{Result, dictionary, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub fn token() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "IndexConfiguration"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    #[cfg_attr(test, ts(type = "string"))]
    pub cache_root: PathBuf,
    pub project_key: String,
    pub target_key: String,
    pub shared_project: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub view_prefix: Option<String>,
}
impl Configuration {
    pub fn identity(&self) -> Result<String> {
        require(
            !self.project_key.is_empty()
                && !self.target_key.is_empty()
                && !self.cache_root.as_os_str().is_empty()
                && self.project_key.encode_utf16().count() <= 32767
                && self.target_key.encode_utf16().count() <= 32767,
            crate::Error::new(crate::ErrorCode::InvalidInput, "empty store identity"),
        )?;
        if let Some(prefix) = &self.view_prefix {
            require(
                self.shared_project
                    && prefix.len() == 77
                    && prefix.starts_with("target-join.")
                    && prefix.ends_with('.')
                    && prefix.as_bytes()[12..76]
                        .iter()
                        .copied()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
                crate::Error::new(crate::ErrorCode::InvalidInput, "invalid joined view prefix"),
            )?;
        }
        Ok(serde_json::to_string(&[
            &self.project_key,
            &if self.shared_project {
                "shared-project-text-v1".to_owned()
            } else {
                format!("shared-index-v2:{}", self.target_key)
            },
        ])?)
    }
    pub fn directory(&self) -> Result<PathBuf> {
        Ok(self
            .cache_root
            .join("game-text-v2")
            .join(digest(self.identity()?.as_bytes())))
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    pid: u32,
    host: String,
    token: String,
}
fn host() -> Result<String> {
    if let Ok(name) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
        return Ok(name);
    }
    let output = std::process::Command::new("hostname").output()?;
    require(
        output.status.success(),
        crate::Error::new(crate::ErrorCode::Unavailable, "hostname"),
    )?;
    Ok(String::from_utf8(output.stdout)?.trim().into())
}
fn alive(pid: u32) -> Result<bool> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()?;
        require(
            output.status.success(),
            crate::Error::new(crate::ErrorCode::Busy, "cannot inspect lock owner"),
        )?;
        Ok(String::from_utf8(output.stdout)?.contains(&format!("\"{pid}\"")))
    }
    #[cfg(not(windows))]
    {
        Ok(std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?
            .success())
    }
}
pub struct WriterLock {
    directory: PathBuf,
    owner: String,
}
impl WriterLock {
    pub fn acquire(directory: &Path) -> Result<Self> {
        let lock = PathBuf::from(format!("{}.lock", directory.display()));
        let id = token();
        let candidate = PathBuf::from(format!("{}.{}.candidate", lock.display(), id));
        fs::create_dir_all(directory)?;
        fs::create_dir(&candidate)?;
        let name = format!("owner-{id}.json");
        let result = (|| {
            atomic_json(
                &candidate.join(&name),
                &serde_json::to_value(Owner {
                    pid: std::process::id(),
                    host: host()?,
                    token: id,
                })?,
            )?;
            if fs::rename(&candidate, &lock).is_err() {
                let entries = fs::read_dir(&lock)?.collect::<std::io::Result<Vec<_>>>()?;
                require(
                    entries.len() == 1,
                    crate::Error::new(
                        crate::ErrorCode::Busy,
                        "another Game Text writer owns this target",
                    ),
                )?;
                let path = entries[0].path();
                let owner: Owner = serde_json::from_slice(&bounded(&path, 4096)?)?;
                require(
                    owner.host == host()?
                        && path.file_name().and_then(|s| s.to_str())
                            == Some(&format!("owner-{}.json", owner.token)),
                    crate::Error::new(crate::ErrorCode::Busy, "foreign or unreadable writer lock"),
                )?;
                require(
                    !alive(owner.pid)?,
                    crate::Error::new(
                        crate::ErrorCode::Busy,
                        "another Game Text writer owns this target",
                    ),
                )?;
                fs::remove_file(path)?;
                fs::remove_dir(&lock)?;
                fs::rename(&candidate, &lock).map_err(|_| {
                    crate::Error::new(
                        crate::ErrorCode::Busy,
                        "another Game Text writer acquired this target",
                    )
                })?;
            }
            Ok(Self {
                directory: lock,
                owner: name.clone(),
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(candidate.join(&name));
            let _ = fs::remove_dir(candidate);
        }
        result
    }
}
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.directory.join(&self.owner));
        let _ = fs::remove_dir(&self.directory);
    }
}
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(not(windows))]
    File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}
pub fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    let _span = crate::scan_timings::Span::new("store.atomic_json");
    let temporary = path.with_extension(format!("{}.tmp", token()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(value)?)?;
        {
            let _span = crate::scan_timings::Span::new("store.manifest_fsync");
            file.sync_all()?;
        }
        drop(file);
        fs::rename(&temporary, path)?;
        sync_directory(path.parent().ok_or("no parent")?)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut file = File::open(path)?;
    require(
        file.metadata()?.len() <= limit,
        "bounded file exceeds limit",
    )?;
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    require(bytes.len() as u64 <= limit, "bounded file grew")?;
    Ok(bytes)
}
pub fn section(reader: &Reader, name: &str) -> Result<Vec<u8>> {
    let id = reader
        .entries
        .iter()
        .position(|e| e.name == name)
        .ok_or_else(|| format!("missing section {name}"))?;
    reader.load(id)
}
fn filename(name: &str, prefix: &str) -> Result<()> {
    require(
        name.starts_with(prefix)
            && name.ends_with(".snapshot")
            && name[prefix.len()..name.len() - 9]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-'),
        "invalid snapshot filename",
    )
}
pub fn open_root(configuration: &Configuration) -> Result<(Value, Value)> {
    let directory = configuration.directory()?;
    let manifest: Value =
        serde_json::from_slice(&bounded(&directory.join("manifest.json"), 1024 * 1024)?)?;
    require(
        manifest["identity"].as_str() == Some(configuration.identity()?.as_str())
            && manifest["manifestVersion"] == 1
            && manifest["formatVersion"] == 4,
        "invalid shared manifest",
    )?;
    let physical = manifest["physicalSnapshot"]
        .as_str()
        .ok_or("invalid snapshot reference")?;
    filename(physical, "snapshot-")?;
    let mut reader = Reader::open(&directory.join(physical))?;
    reader.verify()?;
    let root: Value = serde_json::from_slice(&section(&reader, "index.meta")?)?;
    require(
        root["version"] == 2
            && root["active"].is_object()
            && root["layers"].is_object()
            && root["generation"].is_string(),
        "invalid shared root",
    )?;
    let segments = root["segments"].as_array().ok_or("invalid segments")?;
    require(segments.len() <= 256, "segment count exceeds limit")?;
    let mut end = 0u64;
    for segment in segments {
        require(
            segment["start"].as_u64() == Some(end),
            "noncontiguous dictionary",
        )?;
        let count = segment["count"]
            .as_u64()
            .ok_or("invalid dictionary count")?;
        end = end.checked_add(count).ok_or("dictionary range overflow")?;
        require(end <= u64::from(u32::MAX), "dictionary exceeds ID range")?;
        let file = segment["file"].as_str().ok_or("invalid segment name")?;
        filename(file, "strings-")?;
        Reader::open(&directory.join(file))?;
    }
    for record in root["layers"].as_object().ok_or("invalid layers")?.values() {
        let file = record["file"].as_str().ok_or("invalid layer name")?;
        filename(file, "layer-")?;
        let layer = Reader::open(&directory.join(file))?;
        require(
            layer
                .entries
                .iter()
                .find(|entry| entry.name == "shared.meta")
                .is_some_and(|entry| entry.raw <= 1024 * 1024),
            "shared metadata bound",
        )?;
        let mut metadata: Value = serde_json::from_slice(&section(&layer, "shared.meta")?)?;
        metadata["bytes"] = record["bytes"].clone();
        require(
            metadata == *record,
            "shared layer metadata differs from root",
        )?;
        require(
            record["storeGeneration"] == root["generation"]
                && record["segmentCount"]
                    .as_u64()
                    .is_some_and(|n| n <= segments.len() as u64)
                && record["bytes"].as_u64() == Some(fs::metadata(directory.join(file))?.len()),
            "invalid layer dependency",
        )?;
    }
    for key in root["active"].as_object().ok_or("invalid active")?.values() {
        require(
            root["layers"]
                .get(key.as_str().ok_or("invalid active key")?)
                .is_some(),
            "missing active layer",
        )?;
    }
    Ok((manifest, root))
}
fn varint(bytes: &[u8], position: &mut usize) -> Result<u32> {
    let mut value = 0;
    for shift in (0..35).step_by(7) {
        let byte = *bytes.get(*position).ok_or("truncated varint")?;
        *position += 1;
        require(shift != 28 || byte < 16, "varint overflow")?;
        value |= u32::from(byte & 127) << shift;
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err("invalid varint".into())
}
pub fn decode_a64(bytes: &[u8]) -> Result<Vec<String>> {
    decode_a64_bytes(bytes)?
        .into_iter()
        .map(|s| Ok(String::from_utf8(s)?))
        .collect()
}
pub fn decode_a64_bytes(bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut position = 0;
    let count = varint(bytes, &mut position)?;
    require(count > 0 && count <= 64, "A64 count")?;
    let mut values = Vec::new();
    let mut previous = Vec::<u8>::new();
    for _ in 0..count {
        let tag = *bytes.get(position).ok_or("missing A64 tag")?;
        position += 1;
        require(tag <= 2, "invalid A64 tag")?;
        if tag != 0 {
            let guid = bytes.get(position..position + 16).ok_or("truncated GUID")?;
            let mask = if tag == 2 {
                u32::from_le_bytes(
                    bytes
                        .get(position + 16..position + 20)
                        .ok_or("truncated mask")?
                        .try_into()?,
                )
            } else {
                0
            };
            previous = (0..32)
                .map(|i| {
                    let n = (guid[i / 2] >> if i % 2 == 0 { 4 } else { 0 }) & 15;
                    if n < 10 {
                        b'0' + n
                    } else if mask & (1 << i) != 0 {
                        b'A' + n - 10
                    } else {
                        b'a' + n - 10
                    }
                })
                .collect();
            position += if tag == 2 { 20 } else { 16 };
        } else {
            let prefix = varint(bytes, &mut position)? as usize;
            let suffix = varint(bytes, &mut position)? as usize;
            require(
                prefix <= previous.len() && prefix + suffix <= 1024 * 1024,
                "A64 prefix bounds",
            )?;
            previous.truncate(prefix);
            previous.extend_from_slice(
                bytes
                    .get(position..position + suffix)
                    .ok_or("truncated A64 suffix")?,
            );
            position += suffix;
        }
        crate::wtf8::validate(&previous)?;
        values.push(previous.clone());
    }
    require(position == bytes.len(), "trailing A64 bytes")?;
    Ok(values)
}
pub fn dictionary_strings(directory: &Path, root: &Value) -> Result<Vec<String>> {
    dictionary_bytes(directory, root)?
        .into_iter()
        .map(|s| Ok(String::from_utf8(s)?))
        .collect()
}
static FULL_DICTIONARY_READS: AtomicU64 = AtomicU64::new(0);
pub fn full_dictionary_reads() -> u64 {
    FULL_DICTIONARY_READS.load(Ordering::Relaxed)
}
pub fn dictionary_bytes(directory: &Path, root: &Value) -> Result<Vec<Vec<u8>>> {
    FULL_DICTIONARY_READS.fetch_add(1, Ordering::Relaxed);
    let mut values = Vec::new();
    for segment in root["segments"].as_array().ok_or("invalid dictionary")? {
        require(
            segment["start"].as_u64() == Some(values.len() as u64),
            "dictionary range",
        )?;
        let reader =
            Reader::open(&directory.join(segment["file"].as_str().ok_or("segment name")?))?;
        let offsets = integers(&section(&reader, "front.offsets")?)?;
        let frames = integers(&section(&reader, "front.frames")?)?;
        require(offsets.len() == frames.len(), "front directory lengths")?;
        let begin = values.len();
        let mut current = u32::MAX;
        let mut data = Vec::new();
        for (block, &frame) in frames.iter().enumerate() {
            if current != frame {
                data = section(&reader, &format!("front.b{frame}"))?;
                current = frame;
            }
            let end = if frames.get(block + 1) == Some(&frame) {
                offsets[block + 1] as usize
            } else {
                data.len()
            };
            values.extend(
                decode_a64_bytes(
                    data.get(offsets[block] as usize..end)
                        .ok_or("front block bounds")?,
                )
                .map_err(|error| {
                    crate::Error::with_source(
                        crate::ErrorCode::InvalidCache,
                        format!("Invalid dictionary section front.b{frame}."),
                        error,
                    )
                })?,
            );
        }
        require(
            values.len() - begin == segment["count"].as_u64().ok_or("dictionary count")? as usize,
            "dictionary count mismatch",
        )?;
    }
    Ok(values)
}
pub fn decode_ids(bytes: &[u8], delta: bool) -> Result<Vec<u32>> {
    let mut ids = integers(bytes)?;
    let mut previous = 0u32;
    if delta {
        for id in &mut ids {
            previous = previous.wrapping_add((*id >> 1) ^ 0u32.wrapping_sub(*id & 1));
            *id = previous;
        }
    }
    Ok(ids)
}
/// A shard refresh reads only its referenced A64 groups.
pub fn dictionary_selected_strings(
    directory: &Path,
    root: &Value,
    ids: &BTreeSet<u32>,
) -> Result<BTreeMap<u32, String>> {
    let mut result = BTreeMap::new();
    for segment in root["segments"].as_array().ok_or("invalid dictionary")? {
        let start = u32::try_from(segment["start"].as_u64().ok_or("segment start")?)?;
        let count = u32::try_from(segment["count"].as_u64().ok_or("segment count")?)?;
        let end = start.checked_add(count).ok_or("dictionary range")?;
        let selected = ids.range(start..end).copied().collect::<Vec<_>>();
        if selected.is_empty() {
            continue;
        }
        let reader =
            Reader::open(&directory.join(segment["file"].as_str().ok_or("segment file")?))?;
        let offsets = integers(&section(&reader, "front.offsets")?)?;
        let frames = integers(&section(&reader, "front.frames")?)?;
        require(
            offsets.len() == frames.len() && offsets.len() == (count as usize).div_ceil(64),
            "front directory lengths",
        )?;
        let mut current_frame = u32::MAX;
        let mut current_block = usize::MAX;
        let mut data = Vec::new();
        let mut values = Vec::new();
        for id in selected {
            let local = (id - start) as usize;
            let block = local / 64;
            let frame = frames[block];
            if frame != current_frame {
                data = section(&reader, &format!("front.b{frame}"))?;
                current_frame = frame;
            }
            if block != current_block {
                let end = if frames.get(block + 1) == Some(&frame) {
                    offsets[block + 1] as usize
                } else {
                    data.len()
                };
                values = decode_a64_bytes(
                    data.get(offsets[block] as usize..end)
                        .ok_or("front block bounds")?,
                )
                .map_err(|error| {
                    crate::Error::with_source(
                        crate::ErrorCode::InvalidCache,
                        format!("Invalid dictionary section front.b{frame}."),
                        error,
                    )
                })?;
                current_block = block;
            }
            let bytes = values
                .get(local % 64)
                .ok_or("front ID outside group")?
                .clone();
            result.insert(id, crate::wtf8::Wtf8Buf::from_bytes(bytes)?.into_view());
        }
    }
    require(result.len() == ids.len(), "shared ID outside dictionary")?;
    Ok(result)
}
pub fn encode_ids(ids: &[u32]) -> Vec<u8> {
    let mut previous = 0;
    u32_bytes(
        &ids.iter()
            .map(|&id| {
                let delta = id.wrapping_sub(previous) as i32;
                previous = id;
                ((delta << 1) ^ (delta >> 31)) as u32
            })
            .collect::<Vec<_>>(),
    )
}
/// A staged local layer's string blocks, concatenated per local domain in section order.
struct LocalStrings {
    domains: Vec<(String, Vec<Vec<u8>>)>,
    /// The layer carries `file.meta` and may reuse a previous layer's dictionary blocks.
    reusable: bool,
}
fn local_strings(file: &Path) -> Result<LocalStrings> {
    let _span = crate::scan_timings::Span::new("store.local_strings");
    let reader = Reader::open(file)?;
    let mut domains: Vec<(String, Vec<Vec<u8>>)> = Vec::new();
    for index in 0..reader.entries.len() {
        let entry = reader.entries[index].clone();
        if entry.kind != 4 {
            continue;
        }
        let values = crate::snapshot::strings_bytes(&reader.load(index)?)?;
        match domains
            .iter_mut()
            .find(|(domain, _)| *domain == entry.domain)
        {
            Some((_, existing)) => existing.extend(values),
            None => domains.push((entry.domain, values)),
        }
    }
    Ok(LocalStrings {
        domains,
        reusable: reader.entries.iter().any(|entry| entry.name == "file.meta"),
    })
}
/// Writes one staged local layer with its string IDs remapped to global IDs: the encoding
/// `prepare_local` uses for a new layer that reuses no previous blocks.
fn encode_local_layer(
    directory: &Path,
    key: &str,
    input: &Path,
    mapping: &BTreeMap<String, Vec<u32>>,
    generation: &Value,
    segment_count: usize,
) -> Result<Value> {
    let reader = Reader::open(input)?;
    let mut writer = Writer::new(&directory.join(format!("{}.tmp", token())))?;
    let mut order = Vec::new();
    let mut string_columns = BTreeMap::new();
    for i in 0..reader.entries.len() {
        let e = reader.entries[i].clone();
        if e.kind == 4 || e.name.ends_with(".starts") || e.name == "input.hash" {
            continue;
        }
        let mut data = reader.load(i)?;
        if e.kind == 3 {
            let _span = crate::scan_timings::Span::new("store.remap_columns");
            let map = mapping.get(&e.domain).ok_or("local domain absent")?;
            let mut previous = 0;
            let mut remapped = Vec::new();
            for id in integers(&data)? {
                let global = *map.get(id as usize).ok_or("local id outside domain")?;
                let delta = global.wrapping_sub(previous) as i32;
                remapped.push(((delta << 1) ^ (delta >> 31)) as u32);
                previous = global;
            }
            data = u32_bytes(&remapped);
            string_columns.insert(e.name.clone(), e.domain);
        }
        order.push(writer.add(&e.name, if e.kind == 3 { 2 } else { e.kind }, "", &data, 1)?);
    }
    let file = format!("layer-{}.snapshot", token());
    let mut record = json!({"file":file,"key":key,"storeGeneration":generation,"segmentCount":segment_count,"bytes":0,"stringColumns":string_columns,"idEncoding":"delta32"});
    order.push(writer.add("shared.meta", 0, "", &serde_json::to_vec(&record)?, 1)?);
    record["bytes"] = json!(writer.finish(&directory.join(file), &order)?);
    Ok(record)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    pub compacted: bool,
    pub dead_bytes: u64,
    pub total_bytes: u64,
}
pub struct Store {
    pub directory: PathBuf,
    pub root: Value,
    configuration: Configuration,
    current: Option<Value>,
    dictionary: Option<HashMap<Vec<u8>, u32>>,
    dictionary_lengths: Option<Vec<u32>>,
    _lock: WriterLock,
    uncertain: bool,
}
impl Store {
    pub(crate) fn configuration_view_prefix(&self) -> Option<&str> {
        self.configuration.view_prefix.as_deref()
    }

    pub fn writer(configuration: Configuration) -> Result<Self> {
        let directory = configuration.directory()?;
        let lock = WriterLock::acquire(&directory)?;
        let opened = open_root(&configuration);
        let (current, mut root) = match opened {
            Ok((manifest, root)) => (Some(manifest), root),
            Err(error) => {
                let missing = !directory.join("manifest.json").exists();
                if !missing {
                    if error.code == crate::ErrorCode::Io {
                        return Err(error);
                    }
                    let quarantine =
                        PathBuf::from(format!("{}.quarantine-{}", directory.display(), token()));
                    fs::create_dir(&quarantine)?;
                    for entry in fs::read_dir(&directory)? {
                        let entry = entry?;
                        fs::rename(entry.path(), quarantine.join(entry.file_name()))?;
                    }
                }
                (
                    None,
                    json!({"version":2,"generation":token(),"garbageUpperBytes":0,"active":{},"segments":[],"layers":{}}),
                )
            }
        };
        if let Some(prefix) = &configuration.view_prefix {
            let active = root["active"].as_object_mut().ok_or("active")?;
            for name in ["joined", "joined-base", "joined.invalidated", "imported"] {
                active.remove(name);
                if let Some(value) = active.remove(&format!("{prefix}{name}")) {
                    active.insert(name.into(), value);
                }
            }
        }
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let selected = current.as_ref().is_some_and(|m| {
                m["physicalSnapshot"].as_str() == Some(&name)
                    || m["previousSnapshot"].as_str() == Some(&name)
            });
            if entry.file_type()?.is_file()
                && (name.ends_with(".tmp") || name.starts_with("snapshot-") && !selected)
            {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(Self {
            directory,
            configuration,
            current,
            root,
            dictionary: None,
            dictionary_lengths: None,
            _lock: lock,
            uncertain: false,
        })
    }
    /// The numeric join owns its reader strings; release the writer's duplicate lookup before
    /// building query columns or comparing a large overlay.
    pub(crate) fn release_dictionary(&mut self) {
        self.dictionary = None;
        self.dictionary_lengths = None;
    }
    /// Reserve the worst-case append count before callers retain any global IDs.
    /// False selects ordinary per-domain interning instead of per-block bounded interning.
    pub(crate) fn reserve_local_segments(
        &mut self,
        files: &[&Path],
        reuse: Option<&Value>,
    ) -> Result<bool> {
        let mut chunks = 0usize;
        let mut domains = 0usize;
        let metadata = if let Some(old) = reuse {
            require(
                files.len() == 1 && old["storeGeneration"] == self.root["generation"],
                "reuse preflight generation",
            )?;
            let previous = Reader::open(
                &self
                    .directory
                    .join(old["file"].as_str().ok_or("previous layer file")?),
            )?;
            if previous
                .entries
                .iter()
                .any(|entry| entry.name == "reuse.meta")
            {
                serde_json::from_slice::<Value>(&section(&previous, "reuse.meta")?)?
            } else {
                Value::Null
            }
        } else {
            Value::Null
        };
        for file in files {
            let reader = Reader::open(file)?;
            let mut file_domains = BTreeSet::new();
            for index in 0..reader.entries.len() {
                if reader.entries[index].kind != 4 {
                    continue;
                }
                let bytes = reader.load(index)?;
                let count =
                    u32::from_le_bytes(bytes.get(..4).ok_or("local string count")?.try_into()?)
                        as usize;
                require(
                    count > 0 && count <= bytes.len().saturating_sub(8) / 4,
                    "local string count bounds",
                )?;
                file_domains.insert(reader.entries[index].domain.clone());
                let hash = digest(&bytes);
                if metadata[&reader.entries[index].domain]
                    .as_array()
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| {
                            block["hash"].as_str() == Some(&hash)
                                && block["count"].as_u64() == Some(count as u64)
                        })
                    })
                {
                    continue;
                }
                chunks = chunks
                    .checked_add(count.div_ceil(8192))
                    .ok_or("local segment count overflow")?;
            }
            domains = domains
                .checked_add(file_domains.len())
                .ok_or("local domain count overflow")?;
        }
        let count = self.root["segments"].as_array().ok_or("segments")?.len();
        if count + chunks <= 256 {
            return Ok(true);
        }
        if count + domains <= 256 {
            return Ok(false);
        }
        self.compact(true)?;
        let count = self.root["segments"].as_array().ok_or("segments")?.len();
        if count + chunks <= 256 {
            return Ok(true);
        }
        require(
            count + domains <= 256,
            "local publication exceeds dictionary segment capacity",
        )?;
        Ok(false)
    }
    pub fn intern(&mut self, domain: &str, values: &[String]) -> Result<Vec<u32>> {
        self.intern_bytes(
            domain,
            &values
                .iter()
                .map(|s| s.as_bytes().to_vec())
                .collect::<Vec<_>>(),
        )
    }
    pub fn intern_bytes(&mut self, domain: &str, values: &[Vec<u8>]) -> Result<Vec<u32>> {
        let _span = crate::scan_timings::Span::new("store.intern");
        require(
            !self.uncertain && domain.len() <= 23,
            "writer closed or invalid domain",
        )?;
        if self.dictionary.is_none() && values.len() <= 8192 {
            return crate::bounded_intern::intern(self, domain, values);
        }
        if self.dictionary.is_none() {
            let values = dictionary_bytes(&self.directory, &self.root)?;
            self.dictionary_lengths = Some(values.iter().map(|s| s.len() as u32).collect());
            self.dictionary = Some(
                values
                    .into_iter()
                    .enumerate()
                    .map(|(i, s)| (s, i as u32))
                    .collect(),
            );
        }
        let lookup = self.dictionary.as_mut().ok_or("dictionary absent")?;
        let mut missing: Vec<_> = values
            .iter()
            .filter(|s| !lookup.contains_key(*s))
            .cloned()
            .collect();
        missing.sort();
        missing.dedup();
        if !missing.is_empty() {
            require(
                self.root["segments"].as_array().ok_or("segments")?.len() < 256,
                "dictionary requires compaction",
            )?;
            let base = u32::try_from(lookup.len())?;
            let file = format!("strings-{}.snapshot", token());
            let raw = self.directory.join(format!("{}.tmp", token()));
            let mut stream = BufWriter::with_capacity(
                crate::snapshot::BLOCK_BYTES,
                OpenOptions::new().create_new(true).write(true).open(&raw)?,
            );
            for value in &missing {
                require(value.len() <= 1024 * 1024, "string cap")?;
                stream.write_all(&(value.len() as u32).to_le_bytes())?;
                crate::wtf8::validate(value)?;
                stream.write_all(value)?;
            }
            stream.flush()?;
            drop(stream);
            let segment = dictionary::segment(
                &raw,
                &self.directory,
                domain,
                base,
                missing.len() as u32,
                file,
            );
            fs::remove_file(raw)?;
            self.root["segments"]
                .as_array_mut()
                .ok_or("segments")?
                .push(serde_json::to_value(segment?)?);
            for (row, value) in missing.into_iter().enumerate() {
                self.dictionary_lengths
                    .as_mut()
                    .ok_or("dictionary lengths absent")?
                    .push(value.len() as u32);
                lookup.insert(value, base + row as u32);
            }
        }
        values
            .iter()
            .map(|s| {
                lookup
                    .get(s)
                    .copied()
                    .ok_or_else(|| "missing interned key".into())
            })
            .collect()
    }
    pub fn publish_local(&mut self, name: &str, key: &str, input: &Path) -> Result<Value> {
        if self.root["active"][name].as_str() == Some(key) {
            let record = self.root["layers"][key].clone();
            let cached = Reader::open(
                &self
                    .directory
                    .join(record["file"].as_str().ok_or("layer file")?),
            )?;
            section(&cached, "shared.meta")?;
            return Ok(record);
        }
        let record = self.prepare_local(name, key, input)?;
        self.publish_root()?;
        self.compact(false)?;
        Ok(self.root["layers"][key]
            .as_object()
            .map(|_| self.root["layers"][key].clone())
            .unwrap_or(record))
    }
    pub(crate) fn obsolete_bytes(&mut self, old: &Value, next: &Value) -> Result<u64> {
        fn ids(directory: &Path, record: &Value) -> Result<BTreeSet<u32>> {
            let reader =
                Reader::open(&directory.join(record["file"].as_str().ok_or("layer file")?))?;
            let mut result = BTreeSet::new();
            for name in record["stringColumns"]
                .as_object()
                .ok_or("string columns")?
                .keys()
            {
                result.extend(decode_ids(
                    &section(&reader, name)?,
                    record["idEncoding"] == "delta32",
                )?);
            }
            Ok(result)
        }
        let previous = ids(&self.directory, old)?;
        let newer = ids(&self.directory, next)?;
        if self.dictionary_lengths.is_none() {
            let missing = previous
                .difference(&newer)
                .copied()
                .collect::<BTreeSet<_>>();
            return Ok(
                dictionary_selected_strings(&self.directory, &self.root, &missing)?
                    .values()
                    .map(|value| crate::wtf8::Wtf8Buf::from_view(value).as_bytes().len() as u64)
                    .sum(),
            );
        }
        let lengths = self
            .dictionary_lengths
            .as_ref()
            .ok_or("dictionary lengths absent")?;
        previous
            .difference(&newer)
            .map(|id| {
                lengths
                    .get(*id as usize)
                    .copied()
                    .map(u64::from)
                    .ok_or_else(|| "obsolete ID outside dictionary".into())
            })
            .sum()
    }
    /// Stage all layer and dictionary files before one root publication.
    pub fn prepare_batch(&mut self, inputs: &[crate::builder::InputLayer]) -> Result<()> {
        for input in inputs {
            self.prepare_local(&input.name, &input.key, &input.file)?;
        }
        Ok(())
    }
    pub fn prepare_batch_cold(&mut self, inputs: &[crate::builder::InputLayer]) -> Result<()> {
        let _span = crate::scan_timings::Span::new("store.prepare_batch_cold");
        use rayon::prelude::*;
        let mut measure = crate::scan_timings::Cursor::new();
        for input in inputs {
            if crate::scan_timings::enabled() {
                crate::scan_timings::count(
                    "publication.staged_bytes",
                    fs::metadata(&input.file)?.len(),
                );
            }
        }
        crate::scan_timings::count("publication.inputs", inputs.len() as u64);
        let pending = inputs
            .iter()
            .filter(|input| self.root["layers"].get(&input.key).is_none())
            .collect::<Vec<_>>();
        // Inputs are independent and freshly staged; reading them concurrently overlaps the
        // first-open latency some platforms add to new files.
        let locals = pending
            .par_iter()
            .map(|input| local_strings(&input.file))
            .collect::<Result<Vec<_>>>()?;
        measure.mark("publication.read_strings");
        let mut domains = BTreeMap::<String, HashSet<Vec<u8>>>::new();
        let mut domain_order = Vec::new();
        for (input, local) in pending.iter().zip(&locals) {
            for (domain, values) in &local.domains {
                let domain = dictionary::storage_domain(&input.name, domain);
                if !domains.contains_key(&domain) {
                    domain_order.push(domain.clone());
                }
                domains
                    .entry(domain)
                    .or_default()
                    .extend(values.iter().cloned());
            }
        }
        if self.root["segments"].as_array().ok_or("segments")?.len() + domains.len() > 256 {
            self.compact(true)?;
        }
        for domain in domain_order {
            let values = domains.remove(&domain).ok_or("cold domain absent")?;
            self.intern_bytes(&domain, &values.into_iter().collect::<Vec<_>>())?;
        }
        measure.mark("publication.intern_strings");
        let segments = self.root["segments"].as_array().ok_or("segments")?.len();
        // New layers that replace nothing and reuse nothing are independent files: encode them
        // concurrently and record them in input order. Anything else keeps the serial path.
        let independent = pending.len() == inputs.len()
            && inputs
                .iter()
                .map(|input| input.name.as_str())
                .collect::<HashSet<_>>()
                .len()
                == inputs.len()
            && pending.iter().zip(&locals).all(|(input, local)| {
                self.root["active"].get(&input.name).is_none()
                    && !local.reusable
                    && segments + local.domains.len() <= 256
            });
        if !independent {
            for input in inputs {
                self.prepare_local_with_mode(&input.name, &input.key, &input.file, false)?;
            }
            measure.mark("publication.encode_serial");
            return Ok(());
        }
        let mut jobs = Vec::with_capacity(pending.len());
        for (input, local) in pending.iter().zip(locals) {
            let mut mapping = BTreeMap::new();
            for (domain, values) in local.domains {
                let ids =
                    self.intern_bytes(&dictionary::storage_domain(&input.name, &domain), &values)?;
                mapping.insert(domain, ids);
            }
            jobs.push((*input, mapping));
        }
        measure.mark("publication.map_strings");
        let generation = self.root["generation"].clone();
        let segment_count = self.root["segments"].as_array().ok_or("segments")?.len();
        let directory = self.directory.clone();
        let records = jobs
            .par_iter()
            .map(|(input, mapping)| {
                encode_local_layer(
                    &directory,
                    &input.key,
                    &input.file,
                    mapping,
                    &generation,
                    segment_count,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        measure.mark("publication.encode_parallel");
        for ((input, _), record) in jobs.iter().zip(records) {
            self.root["layers"][&input.key] = record;
            self.root["active"][&input.name] = json!(input.key);
        }
        Ok(())
    }
    pub fn prepare_local(&mut self, name: &str, key: &str, input: &Path) -> Result<Value> {
        self.prepare_local_with_mode(name, key, input, true)
    }
    fn prepare_local_with_mode(
        &mut self,
        name: &str,
        key: &str,
        input: &Path,
        track_garbage: bool,
    ) -> Result<Value> {
        require(!self.uncertain, "publication uncertain: reopen writer")?;
        let old = self.root["active"][name]
            .as_str()
            .and_then(|key| self.root["layers"].get(key))
            .cloned();
        if let Some(record) = self.root["layers"].get(key).cloned() {
            let cached = Reader::open(
                &self
                    .directory
                    .join(record["file"].as_str().ok_or("layer file")?),
            )?;
            section(&cached, "shared.meta")?;
            if let Some(old) = old
                && track_garbage
                && old["key"] != record["key"]
            {
                let bytes = self.obsolete_bytes(&old, &record)?;
                self.root["garbageUpperBytes"] =
                    json!(self.root["garbageUpperBytes"].as_u64().unwrap_or(0) + bytes);
            }
            self.root["active"][name] = json!(key);
            return Ok(record);
        }
        let _span = crate::scan_timings::Span::new("store.prepare_local");
        let mut reader = Reader::open(input)?;
        let allow_reuse =
            if old.is_some() && reader.entries.iter().any(|entry| entry.name == "file.meta") {
                self.reserve_local_segments(&[input], old.as_ref())?
            } else {
                true
            };
        // The capacity check may have compacted and replaced all layer files and IDs.
        let old = self.root["active"][name]
            .as_str()
            .and_then(|key| self.root["layers"].get(key))
            .cloned();
        let reused = if let Some(old) = &old
            && allow_reuse
        {
            crate::layer_reuse::mappings(self, &mut reader, name, old)?
        } else {
            None
        };
        let mut local = BTreeMap::<String, Vec<Vec<u8>>>::new();
        let mut local_order = Vec::new();
        for i in 0..reader.entries.len() {
            let e = reader.entries[i].clone();
            if e.kind == 4 && reused.is_none() {
                if !local.contains_key(&e.domain) {
                    local_order.push(e.domain.clone());
                }
                local
                    .entry(e.domain)
                    .or_default()
                    .extend(crate::snapshot::strings_bytes(&reader.load(i)?)?);
            }
        }
        if self.root["segments"].as_array().ok_or("segments")?.len() + local.len() > 256 {
            self.compact(true)?;
        }
        let old = self.root["active"][name]
            .as_str()
            .and_then(|key| self.root["layers"].get(key))
            .cloned();
        let mut mapping = reused.unwrap_or_default();
        for domain in local_order {
            let values = local.remove(&domain).ok_or("local domain absent")?;
            mapping.insert(
                domain.clone(),
                self.intern_bytes(&dictionary::storage_domain(name, &domain), &values)?,
            );
        }
        let mut writer = Writer::new(&self.directory.join(format!("{}.tmp", token())))?;
        let mut order = Vec::new();
        let mut string_columns = BTreeMap::new();
        for i in 0..reader.entries.len() {
            let e = reader.entries[i].clone();
            if e.kind == 4 || e.name.ends_with(".starts") || e.name == "input.hash" {
                continue;
            }
            let mut data = reader.load(i)?;
            if e.kind == 3 {
                let _span = crate::scan_timings::Span::new("store.remap_columns");
                let map = mapping.get(&e.domain).ok_or("local domain absent")?;
                let mut previous = 0;
                let mut remapped = Vec::new();
                for id in integers(&data)? {
                    let global = *map.get(id as usize).ok_or("local id outside domain")?;
                    let delta = global.wrapping_sub(previous) as i32;
                    remapped.push(((delta << 1) ^ (delta >> 31)) as u32);
                    previous = global;
                }
                data = u32_bytes(&remapped);
                string_columns.insert(e.name.clone(), e.domain);
            }
            order.push(writer.add(&e.name, if e.kind == 3 { 2 } else { e.kind }, "", &data, 1)?);
        }
        if reader.entries.iter().any(|entry| entry.name == "file.meta") {
            for (domain, ids) in &mapping {
                let field = format!("reuse.{domain}");
                string_columns.insert(field.clone(), domain.clone());
                order.push(writer.add(&field, 2, "", &encode_ids(ids), 1)?);
            }
            let blocks = dictionary::reuse_blocks(&mut reader)?;
            order.push(writer.add("reuse.meta", 0, "", &serde_json::to_vec(&blocks)?, 1)?);
        }
        let file = format!("layer-{}.snapshot", token());
        let mut record = json!({"file":file,"key":key,"storeGeneration":self.root["generation"],"segmentCount":self.root["segments"].as_array().ok_or("segments")?.len(),"bytes":0,"stringColumns":string_columns,"idEncoding":"delta32"});
        order.push(writer.add("shared.meta", 0, "", &serde_json::to_vec(&record)?, 1)?);
        record["bytes"] = json!(writer.finish(&self.directory.join(file), &order)?);
        if let Some(old) = old
            && track_garbage
        {
            let bytes = self.obsolete_bytes(&old, &record)?;
            self.root["garbageUpperBytes"] =
                json!(self.root["garbageUpperBytes"].as_u64().unwrap_or(0) + bytes);
        }
        self.root["layers"][key] = record.clone();
        self.root["active"][name] = json!(key);
        Ok(record)
    }
    /// Publish rule-derived columns using this generation's global dictionary IDs.
    pub fn publish_global(
        &mut self,
        name: &str,
        key: &str,
        columns: &[(String, String, Vec<u32>)],
        metadata: &[u8],
        retained: &BTreeMap<String, String>,
        removed: &[String],
    ) -> Result<Value> {
        let record = self.prepare_global(name, key, columns, metadata, retained, removed)?;
        self.publish_root()?;
        Ok(record)
    }
    /// Stage global-ID columns while a coordinated batch retains the writer lease.
    pub(crate) fn prepare_global(
        &mut self,
        name: &str,
        key: &str,
        columns: &[(String, String, Vec<u32>)],
        metadata: &[u8],
        retained: &BTreeMap<String, String>,
        removed: &[String],
    ) -> Result<Value> {
        let maximum = self.root["segments"]
            .as_array()
            .ok_or("segments")?
            .last()
            .map_or(0, |s| {
                s["start"].as_u64().unwrap_or(0) + s["count"].as_u64().unwrap_or(0)
            });
        let mut writer = Writer::new(&self.directory.join(format!("{}.tmp", token())))?;
        let mut string_columns = serde_json::Map::new();
        let mut encoded = Vec::with_capacity(columns.len());
        for (field, domain, values) in columns {
            encoded.push(if domain.is_empty() {
                u32_bytes(values)
            } else {
                require(
                    values.iter().all(|id| u64::from(*id) < maximum),
                    "joined string ID outside dictionary",
                )?;
                string_columns.insert(field.clone(), json!(domain));
                encode_ids(values)
            });
        }
        let mut order = writer.add_all(
            &columns
                .iter()
                .zip(&encoded)
                .map(|((field, _, _), bytes)| (field.as_str(), 2, "", bytes.as_slice(), 1))
                .collect::<Vec<_>>(),
        )?;
        drop(encoded);
        if !metadata.is_empty() {
            order.push(writer.add("join.meta", 0, "", metadata, 1)?);
        }
        let file = format!("layer-{}.snapshot", token());
        let mut record = json!({"file":file,"key":key,"storeGeneration":self.root["generation"],"segmentCount":self.root["segments"].as_array().ok_or("segments")?.len(),"bytes":0,"stringColumns":string_columns,"idEncoding":"delta32"});
        order.push(writer.add("shared.meta", 0, "", &serde_json::to_vec(&record)?, 1)?);
        record["bytes"] = json!(writer.finish(&self.directory.join(file), &order)?);
        for retired in removed {
            self.root["active"]
                .as_object_mut()
                .ok_or("active")?
                .remove(retired);
        }
        for (retained_name, retained_key) in retained {
            require(
                self.root["layers"].get(retained_key).is_some(),
                "retained layer absent",
            )?;
            self.root["active"][retained_name] = json!(retained_key);
        }
        self.root["layers"][key] = record.clone();
        self.root["active"][name] = json!(key);
        Ok(record)
    }
    /// The external merge builds a cold batch without per-file dictionary probes or segment growth.
    pub fn publish_cold(&mut self, inputs: &[crate::builder::InputLayer]) -> Result<Value> {
        require(
            self.root["active"]
                .as_object()
                .is_some_and(|a| a.is_empty()),
            "cold publication requires an empty store",
        )?;
        let stage = self.directory.join(format!("{}.tmp", token()));
        let generation = self.root["generation"]
            .as_str()
            .ok_or("generation")?
            .to_owned();
        let layers: Vec<_> = inputs
            .iter()
            .map(|i| dictionary::LayerInput {
                name: i.name.clone(),
                file: i.file.clone(),
            })
            .collect();
        let keys: BTreeMap<_, _> = inputs
            .iter()
            .map(|i| (i.name.clone(), i.key.clone()))
            .collect();
        let result = (|| {
            let measured = dictionary::build_configured(
                &layers,
                &stage,
                64 * 1024 * 1024,
                Some((&generation, &keys)),
            )?;
            let root: Value =
                serde_json::from_slice(&bounded(&stage.join("index.json"), 16 * 1024 * 1024)?)?;
            for file in root["segments"]
                .as_array()
                .ok_or("segments")?
                .iter()
                .map(|s| s["file"].as_str().ok_or("segment file"))
                .chain(
                    root["layers"]
                        .as_object()
                        .ok_or("layers")?
                        .values()
                        .map(|l| l["file"].as_str().ok_or("layer file")),
                )
            {
                let file = file?;
                fs::rename(stage.join(file), self.directory.join(file))?;
            }
            self.root = root;
            self.dictionary = None;
            self.dictionary_lengths = None;
            self.publish_root()?;
            Ok(measured)
        })();
        if stage.exists() {
            fs::remove_dir_all(stage)?;
        }
        result
    }
    pub fn compact(&mut self, force: bool) -> Result<Compaction> {
        require(!self.uncertain, "publication uncertain: reopen writer")?;
        let segments = self.root["segments"].as_array().ok_or("segments")?;
        let total: u64 = segments
            .iter()
            .map(|s| s["utf8Bytes"].as_u64().unwrap_or(0))
            .sum();
        let upper = self.root["garbageUpperBytes"].as_u64().unwrap_or(0);
        let limit = segments.len() >= 256;
        if !force && !limit && (upper < 8 * 1024 * 1024 || upper < total / 4) {
            return Ok(Compaction {
                compacted: false,
                dead_bytes: 0,
                total_bytes: total,
            });
        }
        let values = dictionary_bytes(&self.directory, &self.root)?;
        let active: BTreeSet<String> = self.root["active"]
            .as_object()
            .ok_or("active")?
            .values()
            .map(|k| k.as_str().ok_or("active key").map(str::to_owned))
            .collect::<std::result::Result<_, _>>()?;
        let mut live = vec![false; values.len()];
        for key in &active {
            let record = &self.root["layers"][key];
            let reader =
                Reader::open(&self.directory.join(record["file"].as_str().ok_or("file")?))?;
            for name in record["stringColumns"]
                .as_object()
                .ok_or("string columns")?
                .keys()
            {
                for id in decode_ids(&section(&reader, name)?, record["idEncoding"] == "delta32")? {
                    *live
                        .get_mut(id as usize)
                        .ok_or("shared ID outside dictionary")? = true;
                }
            }
        }
        let total_bytes = values.iter().map(|v| v.len() as u64).sum();
        let dead_bytes = values
            .iter()
            .zip(&live)
            .filter(|(_, used)| !**used)
            .map(|(v, _)| v.len() as u64)
            .sum();
        if !force && !limit && (dead_bytes < 8 * 1024 * 1024 || dead_bytes < total_bytes / 4) {
            self.root["garbageUpperBytes"] = json!(dead_bytes);
            self.publish_root()?;
            return Ok(Compaction {
                compacted: false,
                dead_bytes,
                total_bytes,
            });
        }
        // Preserve the original owner of cross-domain strings, including mixed TypeScript segments.
        let mut groups = BTreeMap::<String, Vec<u32>>::new();
        let mut domain_order = Vec::new();
        for segment in segments {
            let start = segment["start"].as_u64().ok_or("segment start")? as usize;
            let count = segment["count"].as_u64().ok_or("segment count")? as usize;
            let domains = segment["domains"].as_array().ok_or("segment domains")?;
            for domain in domains {
                let domain = domain.as_str().ok_or("ownership domain")?;
                if !domain_order.iter().any(|prior| prior == domain) {
                    domain_order.push(domain.to_owned());
                }
            }
            let reader =
                Reader::open(&self.directory.join(segment["file"].as_str().ok_or("file")?))?;
            let mut ownership = Vec::new();
            if domains.len() > 1 {
                for block in 0..count.div_ceil(8 * 1024 * 1024) {
                    ownership.extend(integers(&section(&reader, &format!("front.o{block}"))?)?);
                }
                require(ownership.len() == count, "ownership length")?;
            }
            for row in 0..count {
                let id = start + row;
                if live[id] {
                    let domain = domains
                        .get(ownership.get(row).copied().unwrap_or(0) as usize)
                        .and_then(Value::as_str)
                        .ok_or("ownership domain")?;
                    groups.entry(domain.into()).or_default().push(id as u32);
                }
            }
        }
        let old = self.root.clone();
        let generation = token();
        let mut fresh_segments = Vec::new();
        let mut mapping = vec![0; values.len()];
        let mut base = 0;
        for domain in domain_order {
            let Some(mut ids) = groups.remove(&domain) else {
                continue;
            };
            ids.sort_unstable_by(|&a, &b| values[a as usize].cmp(&values[b as usize]));
            let raw = self.directory.join(format!("{}.tmp", token()));
            let mut stream = BufWriter::with_capacity(
                crate::snapshot::BLOCK_BYTES,
                OpenOptions::new().create_new(true).write(true).open(&raw)?,
            );
            for (row, &id) in ids.iter().enumerate() {
                mapping[id as usize] = base + row as u32;
                let value = &values[id as usize];
                stream.write_all(&(value.len() as u32).to_le_bytes())?;
                stream.write_all(value)?;
            }
            drop(stream);
            let result = dictionary::segment(
                &raw,
                &self.directory,
                &domain,
                base,
                ids.len() as u32,
                format!("strings-{}.snapshot", token()),
            );
            fs::remove_file(raw)?;
            fresh_segments.push(serde_json::to_value(result?)?);
            base += ids.len() as u32;
        }
        let mut layers = serde_json::Map::new();
        for key in &active {
            let previous = &old["layers"][key];
            let reader = Reader::open(
                &self
                    .directory
                    .join(previous["file"].as_str().ok_or("file")?),
            )?;
            let mut writer = Writer::new(&self.directory.join(format!("{}.tmp", token())))?;
            let mut order = Vec::new();
            for i in 0..reader.entries.len() {
                let e = reader.entries[i].clone();
                if e.name == "shared.meta" {
                    continue;
                }
                let mut bytes = reader.load(i)?;
                if previous["stringColumns"].get(&e.name).is_some() {
                    let ids = decode_ids(&bytes, previous["idEncoding"] == "delta32")?;
                    bytes = encode_ids(
                        &ids.into_iter()
                            .map(|id| mapping[id as usize])
                            .collect::<Vec<_>>(),
                    );
                }
                order.push(writer.add(&e.name, e.kind, "", &bytes, 1)?);
            }
            let file = format!("layer-{}.snapshot", token());
            let mut record = json!({"file":file,"key":key,"storeGeneration":generation,"segmentCount":fresh_segments.len(),"bytes":0,"stringColumns":previous["stringColumns"],"idEncoding":"delta32"});
            order.push(writer.add("shared.meta", 0, "", &serde_json::to_vec(&record)?, 1)?);
            record["bytes"] = json!(writer.finish(&self.directory.join(file), &order)?);
            layers.insert(key.clone(), record);
        }
        self.root = json!({"version":2,"generation":generation,"garbageUpperBytes":0,"active":old["active"],"segments":fresh_segments,"layers":layers});
        self.dictionary = None;
        self.dictionary_lengths = None;
        self.publish_root()?;
        let keep: BTreeSet<_> = self.root["segments"]
            .as_array()
            .ok_or("segments")?
            .iter()
            .map(|s| s["file"].as_str().ok_or("file"))
            .chain(
                self.root["layers"]
                    .as_object()
                    .ok_or("layers")?
                    .values()
                    .map(|l| l["file"].as_str().ok_or("file")),
            )
            .collect::<std::result::Result<_, _>>()?;
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if (name.starts_with("layer-") || name.starts_with("strings-"))
                && name.ends_with(".snapshot")
                && !keep.contains(name.as_str())
            {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(Compaction {
            compacted: true,
            dead_bytes,
            total_bytes,
        })
    }
    pub fn publish_root(&mut self) -> Result<()> {
        let _span = crate::scan_timings::Span::new("store.publish_root");
        require(!self.uncertain, "publication uncertain: reopen writer")?;
        let mut disk = self.root.clone();
        if let Some(prefix) = &self.configuration.view_prefix {
            let active = disk["active"].as_object_mut().ok_or("active")?;
            for name in ["joined", "joined-base", "joined.invalidated", "imported"] {
                if let Some(value) = active.remove(name) {
                    active.insert(format!("{prefix}{name}"), value);
                }
            }
        }
        let bytes = serde_json::to_vec(&disk)?;
        require(bytes.len() <= 16 * 1024 * 1024, "root exceeds cap")?;
        let name = format!("snapshot-{}.snapshot", token());
        let mut writer = Writer::new(&self.directory.join(format!("{}.tmp", token())))?;
        let id = writer.add("index.meta", 0, "", &bytes, 1)?;
        writer.finish(&self.directory.join(&name), &[id])?;
        let manifest = json!({"manifestVersion":1,"formatVersion":4,"identity":self.configuration.identity()?,"physicalSnapshot":name,"previousSnapshot":self.current.as_ref().and_then(|m| m["physicalSnapshot"].as_str()),"inputKeys":{"generation":self.root["generation"]}});
        self.uncertain = true;
        atomic_json(&self.directory.join("manifest.json"), &manifest)?;
        self.current = Some(manifest);
        self.uncertain = false;
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let current = self.current.as_ref().ok_or("missing current manifest")?;
            if name.starts_with("snapshot-")
                && name.ends_with(".snapshot")
                && current["physicalSnapshot"].as_str() != Some(&name)
                && current["previousSnapshot"].as_str() != Some(&name)
            {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn localization_capacity_counts_changed_blocks_before_reusing_ids() -> Result<()> {
        let config = configuration();
        let mut store = Store::writer(config.clone())?;
        let generation = store.root["generation"].clone();
        for version in 0..2 {
            let file = config.cache_root.join(format!("po-{version}.snapshot"));
            let mut writer = Writer::new(&config.cache_root.join(format!("po-{version}.payload")))?;
            let mut order = Vec::new();
            for block in 0..300 {
                let value = if block == 299 {
                    format!("edited-{version}")
                } else {
                    format!("retained-{block}")
                };
                order.push(writer.add(
                    &format!("source.b{block}"),
                    4,
                    "source",
                    &crate::snapshot::string_block(&[value])?,
                    1,
                )?);
                let index = *order.last().ok_or("string block")?;
                writer.entries[index].strings = 300;
            }
            order.push(writer.column("source.starts", &(0..300).collect::<Vec<_>>())?);
            order.push(writer.add(
                "entry.source",
                3,
                "source",
                &u32_bytes(&(0..300).collect::<Vec<_>>()),
                1,
            )?);
            let index = *order.last().ok_or("string IDs")?;
            writer.entries[index].strings = 300;
            order.push(writer.add("file.meta", 0, "", b"{}", 1)?);
            writer.finish(&file, &order)?;
            let record = store.publish_local("probe.po", &format!("po-{version}"), &file)?;
            let reader =
                Reader::open(&store.directory.join(record["file"].as_str().ok_or("file")?))?;
            let ids = decode_ids(&section(&reader, "entry.source")?, true)?;
            let values = dictionary_bytes(&store.directory, &store.root)?;
            assert_eq!(
                values[ids[299] as usize],
                format!("edited-{version}").as_bytes()
            );
            assert_eq!(store.root["generation"], generation);
            assert_eq!(
                store.root["segments"].as_array().ok_or("segments")?.len(),
                version + 1
            );
        }
        drop(store);
        fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }
    #[test]
    fn batched_refresh_matches_bulk_accounting_and_forced_compaction() {
        let config = configuration();
        let mut store = Store::writer(config.clone()).unwrap();
        for source in ["old", "new"] {
            let file = config.cache_root.join(format!("{source}.snapshot"));
            let mut writer =
                Writer::new(&config.cache_root.join(format!("{source}.payload"))).unwrap();
            let strings = writer
                .add(
                    "source.b0",
                    4,
                    "source",
                    &crate::snapshot::string_block(&[source.into()]).unwrap(),
                    3,
                )
                .unwrap();
            writer.entries[strings].strings = 1;
            let starts = writer.column("source.starts", &[0]).unwrap();
            let ids = writer
                .add("entry.source", 3, "source", &u32_bytes(&[0]), 1)
                .unwrap();
            writer.entries[ids].strings = 1;
            writer.finish(&file, &[strings, starts, ids]).unwrap();
            store
                .prepare_batch_cold(&[crate::builder::InputLayer {
                    name: "Input.po".into(),
                    key: source.into(),
                    file,
                }])
                .unwrap();
            store.publish_root().unwrap();
        }
        // TypeScript publishCold leaves this hint unchanged; forced compaction counts exact liveness.
        assert_eq!(store.root["garbageUpperBytes"], 0);
        assert_eq!(store.compact(true).unwrap().dead_bytes, 3);
        drop(store);
        fs::remove_dir_all(config.cache_root).unwrap();
    }
    #[test]
    fn compaction_preserves_first_seen_domains_and_reads_u32_mixed_ownership() {
        let config = configuration();
        let mut store = Store::writer(config.clone()).unwrap();
        let file = "mixed.snapshot";
        let mut writer = Writer::new(&store.directory.join("mixed.payload")).unwrap();
        let keys = vec![b"".to_vec(), b"K".to_vec(), b"N".to_vec()];
        let data = writer
            .add("front.b0", 0, "", &dictionary::a64(&keys).unwrap(), 1)
            .unwrap();
        let offsets = writer.column("front.offsets", &[0]).unwrap();
        let frames = writer.column("front.frames", &[0]).unwrap();
        let owners = writer.column("front.o0", &[0, 1, 1]).unwrap();
        let bytes = writer
            .finish(
                &store.directory.join(file),
                &[data, offsets, frames, owners],
            )
            .unwrap();
        store.root["segments"] = json!([{"file":file,"start":0,"count":3,"domain":"source","domains":["source","identity"],"utf8Bytes":2,"bytes":bytes}]);
        store
            .publish_global(
                "probe",
                "probe-key",
                &[("entry.source".into(), "source".into(), vec![0, 1, 2])],
                b"{}",
                &BTreeMap::new(),
                &[],
            )
            .unwrap();
        assert!(store.compact(true).unwrap().compacted);
        assert_eq!(store.root["segments"][0]["domain"], "source");
        assert_eq!(store.root["segments"][1]["domain"], "identity");
        assert_eq!(
            dictionary_strings(&store.directory, &store.root).unwrap(),
            ["", "K", "N"]
        );
        open_root(&config).unwrap();
        drop(store);
        fs::remove_dir_all(config.cache_root).unwrap();
    }
    fn configuration() -> Configuration {
        Configuration {
            cache_root: crate::test_directory("store-test"),
            project_key: "generic-project".into(),
            target_key: "Probe".into(),
            shared_project: false,
            view_prefix: None,
        }
    }
    #[test]
    fn malformed_dictionary_counts_are_typed_errors_without_overflow() {
        let config = configuration();
        let mut store = Store::writer(config.clone()).unwrap();
        store.intern("identity", &["".into()]).unwrap();
        store.root["segments"][0]["count"] = json!(u64::MAX);
        store.publish_root().unwrap();
        drop(store);
        let error = open_root(&config).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::InvalidCache);
        assert!(error.to_string().contains("ID range"));
        fs::remove_dir_all(config.cache_root).unwrap();
    }
    #[test]
    fn writer_exclusion_atomic_roots_and_reader_generations() {
        let config = configuration();
        let directory = config.directory().unwrap();
        let mut store = Store::writer(config.clone()).unwrap();
        assert!(Store::writer(config.clone()).is_err());
        let ids = store
            .intern("identity", &["".into(), "Probe".into()])
            .unwrap();
        assert_eq!(ids, vec![0, 1]);
        store.publish_root().unwrap();
        let (manifest, root) = open_root(&config).unwrap();
        assert_eq!(
            dictionary_strings(&directory, &root).unwrap(),
            vec!["", "Probe"]
        );
        let old = directory.join(manifest["physicalSnapshot"].as_str().unwrap());
        let reader = Reader::open(&old).unwrap();
        assert_eq!(
            store
                .intern("source", &["Probe".into(), "new source".into()])
                .unwrap(),
            vec![1, 2]
        );
        store.publish_root().unwrap();
        drop(store);
        let mut reopened = Store::writer(config.clone()).unwrap();
        reopened.publish_root().unwrap();
        assert!(!old.exists());
        let kept: Value = serde_json::from_slice(&section(&reader, "index.meta").unwrap()).unwrap();
        assert_eq!(kept, root);
        drop(reader);
        drop(reopened);
        fs::remove_dir_all(config.cache_root).unwrap();
    }
    #[test]
    fn writer_quarantines_corruption_while_readers_do_not_mutate() {
        let config = configuration();
        let directory = config.directory().unwrap();
        let mut store = Store::writer(config.clone()).unwrap();
        store.publish_root().unwrap();
        drop(store);
        fs::write(directory.join("manifest.json"), b"{bad").unwrap();
        assert!(open_root(&config).is_err());
        assert_eq!(fs::read(directory.join("manifest.json")).unwrap(), b"{bad");
        let store = Store::writer(config.clone()).unwrap();
        assert!(store.root["active"].as_object().unwrap().is_empty());
        assert!(fs::read_dir(directory.parent().unwrap()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".quarantine-")
        }));
        drop(store);
        fs::remove_dir_all(config.cache_root).unwrap();
    }
    #[test]
    fn cold_publication_and_compaction_preserve_active_values_and_open_readers() {
        let config = configuration();
        fs::create_dir_all(&config.cache_root).unwrap();
        let raw = config.cache_root.join("input.snapshot");
        let mut writer = Writer::new(&config.cache_root.join("payload")).unwrap();
        let strings = vec!["dead candidate".to_owned(), "retained value".to_owned()];
        let dict = writer
            .add(
                "source.b0",
                4,
                "source",
                &crate::snapshot::string_block(&strings).unwrap(),
                3,
            )
            .unwrap();
        writer.entries[dict].strings = 2;
        let starts = writer.column("source.starts", &[0]).unwrap();
        let col = writer
            .add("entry.source", 3, "source", &u32_bytes(&[1]), 1)
            .unwrap();
        writer.entries[col].strings = 2;
        writer.finish(&raw, &[dict, starts, col]).unwrap();
        let mut store = Store::writer(config.clone()).unwrap();
        store
            .publish_cold(&[crate::builder::InputLayer {
                name: "probe".into(),
                key: "content-key".into(),
                file: raw,
            }])
            .unwrap();
        let initial = store.root.clone();
        let old_file = store
            .directory
            .join(initial["layers"]["content-key"]["file"].as_str().unwrap());
        let old_reader = Reader::open(&old_file).unwrap();
        let before = section(&old_reader, "entry.source").unwrap();
        let compacted = store.compact(true).unwrap();
        assert!(compacted.compacted);
        assert_eq!(compacted.dead_bytes, 14);
        assert_ne!(initial["generation"], store.root["generation"]);
        assert_eq!(
            dictionary_strings(&store.directory, &store.root).unwrap(),
            ["retained value"]
        );
        let record = &store.root["layers"]["content-key"];
        let current =
            Reader::open(&store.directory.join(record["file"].as_str().unwrap())).unwrap();
        assert_eq!(
            decode_ids(&section(&current, "entry.source").unwrap(), true).unwrap(),
            [0]
        );
        assert!(!old_file.exists());
        assert_eq!(section(&old_reader, "entry.source").unwrap(), before);
        open_root(&config).unwrap();
        drop(current);
        drop(old_reader);
        drop(store);
        fs::remove_dir_all(config.cache_root).unwrap();
    }
}
