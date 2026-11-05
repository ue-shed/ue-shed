use super::{Diagnostic, Format, Limits, Options, Parsed, failure, parse_bytes_with_chunk};
use crate::dictionary::{LayerSource, SourceLayer};
use crate::store::{Store, digest};
use crate::{Result, require};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Instant, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationInput"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub chunk_bytes: Option<usize>,
    #[cfg_attr(test, ts(type = "string"))]
    pub project_root: PathBuf,
    #[cfg_attr(test, ts(type = "string"))]
    pub file: PathBuf,
    pub relative_path: String,
    pub options: Options,
    pub limits: Limits,
}
/// Version of the retained import semantics in every content key. Changing it invalidates every
/// retained parsed layer and every host stat hint that records a key.
pub const VERSION: u32 = 6;
/// The most files one request may name.
pub const MAXIMUM_FILES: usize = 2560;

/// Files to import into the leased store in one publication. Each file whose name is not active
/// takes the cold route (a store with nothing active is built in one external merge); each file
/// whose name is active takes the warm route, which reuses the previous layer's IDs.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationImportRequest"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub files: Vec<Input>,
    /// Bound on the bytes of the files being read and parsed at once.
    #[cfg_attr(test, ts(type = "number"))]
    pub maximum_in_flight_bytes: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationProvenance"))]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub relative_path: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub size: u64,
    pub modified_time: String,
    pub content_hash: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationPreparedFile"))]
#[serde(rename_all = "camelCase")]
pub struct PreparedFile {
    pub key: String,
    pub content_hash: String,
    pub provenance: Provenance,
    pub relative_path: String,
    pub format: Format,
    #[cfg_attr(test, ts(type = "number"))]
    pub input_bytes: u64,
    pub parsed: bool,
    #[cfg_attr(test, ts(type = "number"))]
    pub snapshot_bytes: u64,
}
/// One requested file: published, or not imported for the reason given. A failed file keeps its
/// previously active layer, if it had one.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationFileResult"))]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum FileResult {
    Imported { file: PreparedFile },
    Failed { error: Diagnostic },
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationImportOutcome"))]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// Dictionary lookups made while publishing.
    pub lookup_strings: usize,
    /// Strings of warm-route files kept without a dictionary lookup.
    pub reused_strings: usize,
    pub files: Vec<FileResult>,
    pub worker_count: usize,
    pub parse_ms: f64,
    pub parse_cpu_ms: f64,
    pub publish_ms: f64,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        require(
            !self.files.is_empty()
                && self.files.len() <= MAXIMUM_FILES
                && self.maximum_in_flight_bytes > 0,
            "localization file or byte bound",
        )?;
        let names = self
            .files
            .iter()
            .map(|input| input.relative_path.as_str())
            .collect::<std::collections::HashSet<_>>();
        require(
            names.len() == self.files.len(),
            "localization file named twice",
        )?;
        for input in &self.files {
            require(
                !input.relative_path.is_empty()
                    && input
                        .chunk_bytes
                        .is_none_or(|n| (1..=1024 * 1024).contains(&n))
                    && input.relative_path.len() <= 1024
                    && input.limits.max_file_bytes > 0
                    && input.limits.max_entries > 0
                    && input.limits.max_depth > 0
                    && input.limits.max_files > 0
                    && input.limits.max_record_bytes > 0
                    && input.limits.max_identity_bytes > 0
                    && input
                        .options
                        .po_format
                        .as_deref()
                        .is_none_or(|f| matches!(f, "Unreal" | "Crowdin"))
                    && input.options.collapse_mode.as_deref().is_none_or(|f| {
                        matches!(
                            f,
                            "IdenticalTextIdAndSource"
                                | "IdenticalNamespaceAndSource"
                                | "IdenticalPackageIdTextIdAndSource"
                        )
                    }),
                "localization input options",
            )?;
        }
        Ok(())
    }
}
fn changed(a: &Metadata, b: &Metadata) -> bool {
    if a.len() != b.len()
        || a.modified().ok() != b.modified().ok()
        || a.created().ok() != b.created().ok()
    {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        a.last_write_time() != b.last_write_time() || a.creation_time() != b.creation_time()
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::MetadataExt;
        a.ino() != b.ino()
            || a.dev() != b.dev()
            || a.ctime() != b.ctime()
            || a.ctime_nsec() != b.ctime_nsec()
    }
}
fn timestamp(metadata: &Metadata) -> String {
    let ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    let seconds = ms / 1000;
    let days = (seconds / 86400) as i64 + 719468;
    let era = days / 146097;
    let day = days - era * 146097;
    let year_of_era = (day - day / 1460 + day / 36524 - day / 146096) / 365;
    let day_of_year = day - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month = (5 * day_of_year + 2) / 153;
    let d = day_of_year - (153 * month + 2) / 5 + 1;
    let m = month + if month < 10 { 3 } else { -9 };
    let y = year_of_era + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60,
        ms % 1000
    )
}
/// The retained layer's identity: import semantics, importer options and authored bytes. Hosts
/// keep the key an import returns; they never derive it.
pub(crate) fn content_key(options: &Options, content_hash: &str) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&json!([
        VERSION,
        options,
        content_hash
    ]))?))
}
/// Strings the layers hold, counted per domain, for the warm route's reuse count.
fn layer_strings(layers: &[&SourceLayer]) -> Result<usize> {
    let mut total = 0;
    for layer in layers {
        let reader = layer.source.open()?;
        let domains = reader
            .entries
            .iter()
            .filter(|e| e.kind == 4)
            .map(|e| &e.domain)
            .collect::<std::collections::BTreeSet<_>>();
        for domain in domains {
            total += reader
                .entries
                .iter()
                .find(|e| &e.domain == domain && e.kind == 4)
                .map_or(0, |e| e.strings as usize);
        }
    }
    Ok(total)
}
fn read(
    input: &Input,
    cached: &BTreeMap<String, u64>,
) -> Parsed<(PreparedFile, Option<Arc<super::columns::LocalLayer>>)> {
    let file = &input.relative_path;
    let io_error = |error: std::io::Error| {
        failure(
            file,
            if error.kind() == std::io::ErrorKind::NotFound {
                "file_missing"
            } else {
                "file_unreadable"
            },
            "",
        )
    };
    let root = fs::canonicalize(&input.project_root)
        .map_err(|_| failure(file, "directory_unreadable", ""))?;
    let actual = fs::canonicalize(&input.file).map_err(io_error)?;
    if !actual.starts_with(root) {
        return Err(failure(file, "unsafe_path", ""));
    }
    let mut handle = File::open(&actual).map_err(io_error)?;
    let before = handle.metadata().map_err(io_error)?;
    #[cfg(windows)]
    let before_id = file_id::get_file_id(&actual).map_err(io_error)?;
    if !before.is_file() {
        return Err(failure(file, "file_unreadable", ""));
    }
    if before.len() > input.limits.max_file_bytes {
        return Err(failure(file, "limit_exceeded", ""));
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    handle
        .by_ref()
        .take(input.limits.max_file_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > input.limits.max_file_bytes {
        return Err(failure(
            file,
            "limit_exceeded",
            &format!(" at byte offset {}", bytes.len()),
        ));
    }
    if bytes.len() as u64 != before.len()
        || changed(&before, &handle.metadata().map_err(io_error)?)
        || changed(&before, &fs::metadata(&actual).map_err(io_error)?)
    {
        return Err(failure(file, "file_changed", ""));
    }
    let content_hash = digest(&bytes);
    let key = content_key(&input.options, &content_hash)
        .map_err(|_| failure(file, "invalid_schema", ""))?;
    let existing = cached.get(&key);
    let layer = if existing.is_none() {
        Some(Arc::new(parse_bytes_with_chunk(
            &bytes,
            file,
            &input.options,
            &input.limits,
            input.chunk_bytes.unwrap_or(256 * 1024),
        )?))
    } else {
        None
    };
    if changed(&before, &handle.metadata().map_err(io_error)?)
        || changed(&before, &fs::metadata(&actual).map_err(io_error)?)
    {
        return Err(failure(file, "file_changed", ""));
    }
    #[cfg(windows)]
    if before_id != file_id::get_file_id(&actual).map_err(io_error)? {
        return Err(failure(file, "file_changed", ""));
    }
    let provenance = Provenance {
        relative_path: file.clone(),
        size: before.len(),
        modified_time: timestamp(&before),
        content_hash: content_hash.clone(),
    };
    Ok((
        PreparedFile {
            key,
            content_hash,
            provenance,
            relative_path: file.clone(),
            format: input.options.format,
            input_bytes: before.len(),
            parsed: layer.is_some(),
            snapshot_bytes: existing.copied().unwrap_or(0),
        },
        layer,
    ))
}

struct Queue {
    pending: VecDeque<(usize, u64)>,
    bytes: u64,
    active: usize,
    peak: usize,
}

pub(crate) fn import(
    store: &mut Store,
    request: &Request,
    progress: &mut dyn FnMut(usize, usize) -> Result<()>,
) -> Result<Outcome> {
    let _span = crate::scan_timings::Span::new("localization.import");
    let started = Instant::now();
    let cpu = process_metrics::process_cpu_ns().unwrap_or(0);
    let cached = store.root["layers"]
        .as_object()
        .ok_or("layers")?
        .iter()
        .map(|(key, record)| (key.clone(), record["bytes"].as_u64().unwrap_or(0)))
        .collect::<BTreeMap<_, _>>();
    let mut pending = request
        .files
        .iter()
        .enumerate()
        .map(|(i, input)| (i, fs::metadata(&input.file).map_or(u64::MAX, |m| m.len())))
        .collect::<Vec<_>>();
    pending.sort_by_key(|(_, bytes)| std::cmp::Reverse(*bytes));
    let queue = Mutex::new(Queue {
        pending: pending.into(),
        bytes: 0,
        active: 0,
        peak: 0,
    });
    let ready = Condvar::new();
    let count = request
        .files
        .len()
        .min(8)
        .min(std::thread::available_parallelism().map_or(1, usize::from));
    let (tx, rx) = mpsc::sync_channel(1);
    let mut prepared = (0..request.files.len()).map(|_| None).collect::<Vec<_>>();
    std::thread::scope(|scope| -> Result<()> {
        for _ in 0..count {
            let (tx, queue, ready, cached) = (tx.clone(), &queue, &ready, &cached);
            scope.spawn(move || {
                loop {
                    let (row, bytes) = {
                        let mut state = queue
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        loop {
                            if state.pending.is_empty() {
                                return;
                            }
                            let pos = state.pending.iter().position(|(_, bytes)| {
                                state.bytes <= request.maximum_in_flight_bytes
                                    && *bytes <= request.maximum_in_flight_bytes - state.bytes
                            });
                            if let Some(pos) = pos.or_else(|| (state.active == 0).then_some(0)) {
                                let Some(task) = state.pending.remove(pos) else {
                                    return;
                                };
                                state.bytes = state.bytes.saturating_add(task.1);
                                state.active += 1;
                                state.peak = state.peak.max(state.active);
                                break task;
                            }
                            state = ready
                                .wait(state)
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                        }
                    };
                    let result = {
                        let _span =
                            crate::scan_timings::Span::new("localization.parse_file_parallel");
                        read(&request.files[row], cached)
                    };
                    {
                        let mut state = queue
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.bytes = state.bytes.saturating_sub(bytes);
                        state.active -= 1;
                        ready.notify_all();
                    }
                    if tx.send((row, result)).is_err() {
                        return;
                    }
                }
            });
        }
        drop(tx);
        let mut completed = 0;
        let mut progress_error = None;
        for (row, result) in rx {
            prepared[row] = Some(result);
            completed += 1;
            if progress_error.is_none() {
                progress_error = progress(completed, request.files.len()).err();
            }
        }
        if let Some(error) = progress_error {
            return Err(error);
        }
        Ok(())
    })?;
    let parse_ms = started.elapsed().as_secs_f64() * 1000.0;
    let parse_cpu_ms = process_metrics::process_cpu_ns()
        .unwrap_or(cpu)
        .saturating_sub(cpu) as f64
        / 1e6;
    let worker_count = queue
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .peak;
    let mut files = Vec::with_capacity(prepared.len());
    let mut layers = Vec::new();
    for result in prepared {
        match result.ok_or("missing localization result")? {
            Ok((file, layer)) => {
                if let Some(layer) = layer {
                    layers.push(SourceLayer {
                        name: file.relative_path.clone(),
                        key: file.key.clone(),
                        source: LayerSource::Memory(layer),
                    });
                }
                files.push(FileResult::Imported { file });
            }
            Err(error) => files.push(FileResult::Failed { error }),
        }
    }
    let publish_started = Instant::now();
    let lookup_before = store.localization_lookups;
    let mut reused_strings = 0;
    // Failed files publish nothing; the rest publish together in one root.
    if files
        .iter()
        .any(|entry| matches!(entry, FileResult::Imported { .. }))
    {
        // Content the store already holds only changes which layer is active.
        for entry in &files {
            if let FileResult::Imported { file } = entry
                && !file.parsed
            {
                let record = &store.root["layers"][&file.key];
                let path = store
                    .directory
                    .join(record["file"].as_str().ok_or("cached localization file")?);
                store.prepare_local_reader(
                    &file.relative_path,
                    &file.key,
                    crate::snapshot::Reader::open(&path)?,
                    true,
                )?;
            }
        }
        if store.root["active"]
            .as_object()
            .is_some_and(serde_json::Map::is_empty)
        {
            // Nothing is active, so every file is cold: one merge builds the store and
            // publishes its root.
            store.publish_cold_sources(&layers)?;
        } else {
            let (warm, cold): (Vec<_>, Vec<_>) = layers
                .into_iter()
                .partition(|layer| store.root["active"].get(&layer.name).is_some());
            if !cold.is_empty() {
                store.prepare_batch_cold_sources(&cold)?;
            }
            let strings = layer_strings(&warm.iter().collect::<Vec<_>>())?;
            let lookups = store.localization_lookups;
            for layer in warm {
                store.prepare_local_reader(&layer.name, &layer.key, layer.source.open()?, true)?;
            }
            reused_strings =
                strings.saturating_sub(store.localization_lookups.saturating_sub(lookups) as usize);
            for entry in &files {
                if let FileResult::Imported { file } = entry {
                    store.root["active"][&file.relative_path] = json!(file.key);
                }
            }
            store.publish_root()?;
        }
        for entry in &mut files {
            if let FileResult::Imported { file } = entry {
                file.snapshot_bytes = store.root["layers"][&file.key]["bytes"]
                    .as_u64()
                    .ok_or("layer bytes")?;
            }
        }
    }
    Ok(Outcome {
        lookup_strings: store.localization_lookups.saturating_sub(lookup_before) as usize,
        reused_strings,
        files,
        worker_count,
        parse_ms,
        parse_cpu_ms,
        publish_ms: publish_started.elapsed().as_secs_f64() * 1000.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Configuration, open_root};

    const SOURCE: &str = "msgctxt \"N,K\"\nmsgid \"source\"\nmsgstr \"translation\"\n";

    struct Fixture {
        project: PathBuf,
        configuration: Configuration,
    }
    impl Fixture {
        fn new(kind: &str) -> Result<Self> {
            let root = crate::test_directory(kind);
            let project = root.join("project");
            fs::create_dir_all(&project)?;
            Ok(Self {
                project,
                configuration: Configuration {
                    cache_root: root.join("cache"),
                    project_key: "fixture".into(),
                    target_key: "Game".into(),
                    shared_project: false,
                    view_prefix: None,
                },
            })
        }
        fn write(&self, name: &str, text: &str) -> Result<()> {
            Ok(fs::write(self.project.join(name), text)?)
        }
        fn input(&self, name: &str, po_format: Option<&str>) -> Input {
            Input {
                chunk_bytes: None,
                project_root: self.project.clone(),
                file: self.project.join(name),
                relative_path: name.into(),
                options: Options {
                    format: Format::Po,
                    po_format: po_format.map(Into::into),
                    collapse_mode: None,
                },
                limits: Limits::default(),
            }
        }
        fn import(&self, store: &mut Store, names: &[&str]) -> Result<Outcome> {
            let request = Request {
                files: names.iter().map(|name| self.input(name, None)).collect(),
                maximum_in_flight_bytes: 1,
            };
            request.validate()?;
            import(store, &request, &mut |_, _| Ok(()))
        }
        /// The active names and keys a new reader sees.
        fn published(&self) -> Result<BTreeMap<String, String>> {
            let (_, root) = open_root(&self.configuration)?;
            Ok(root["active"]
                .as_object()
                .ok_or("active")?
                .iter()
                .map(|(name, key)| (name.clone(), key.as_str().unwrap_or_default().to_owned()))
                .collect())
        }
    }
    fn imported(result: &FileResult) -> Result<&PreparedFile> {
        match result {
            FileResult::Imported { file } => Ok(file),
            FileResult::Failed { error } => Err(error.message.clone().into()),
        }
    }
    fn failed(result: &FileResult) -> Option<&Diagnostic> {
        match result {
            FileResult::Failed { error } => Some(error),
            FileResult::Imported { .. } => None,
        }
    }

    #[test]
    fn a_mixed_batch_publishes_the_files_that_imported_and_reports_the_rest() -> Result<()> {
        let fixture = Fixture::new("localization-import-mixed")?;
        fixture.write("good.po", SOURCE)?;
        fixture.write("bad.po", "msgid \"unterminated")?;
        let mut store = Store::writer(fixture.configuration.clone())?;
        let outcome = fixture.import(&mut store, &["good.po", "missing.po", "bad.po"])?;
        let good = imported(&outcome.files[0])?;
        assert!(good.parsed);
        let missing = failed(&outcome.files[1]).ok_or("missing.po imported")?;
        assert_eq!(missing.code, "file_missing");
        assert!(missing.message.starts_with("missing.po"));
        let bad = failed(&outcome.files[2]).ok_or("bad.po imported")?;
        assert_eq!(bad.code, "malformed_po");
        assert_eq!(
            bad.recovery,
            "Repair the PO syntax with the translation tool, then read the file again."
        );
        assert_eq!(
            fixture.published()?,
            BTreeMap::from([("good.po".to_owned(), good.key.clone())])
        );
        // A batch where nothing imports publishes nothing and keeps the active layers.
        let outcome = fixture.import(&mut store, &["missing.po", "bad.po"])?;
        assert!(outcome.files.iter().all(|file| failed(file).is_some()));
        assert_eq!(fixture.published()?.len(), 1);
        Ok(())
    }

    #[test]
    fn a_warm_subset_replaces_only_its_files() -> Result<()> {
        let fixture = Fixture::new("localization-import-warm")?;
        fixture.write("a.po", SOURCE)?;
        fixture.write("b.po", &SOURCE.replace('K', "L"))?;
        let mut store = Store::writer(fixture.configuration.clone())?;
        let first = fixture.import(&mut store, &["a.po", "b.po"])?;
        let before = fixture.published()?;
        assert_eq!(before.len(), 2);
        fixture.write("a.po", &SOURCE.replace("translation", "changed"))?;
        fixture.write("c.po", &SOURCE.replace('K', "M"))?;
        let warm = fixture.import(&mut store, &["a.po", "c.po"])?;
        let changed = imported(&warm.files[0])?;
        assert!(changed.parsed);
        assert_ne!(changed.key, imported(&first.files[0])?.key);
        // The warm file's unchanged identity and source keep the previous layer's IDs.
        assert!(warm.reused_strings > 0);
        let after = fixture.published()?;
        assert_eq!(after["a.po"], changed.key);
        assert_eq!(after["b.po"], before["b.po"]);
        assert_eq!(after["c.po"], imported(&warm.files[1])?.key);
        // Reverting reactivates the retained layer without parsing.
        fixture.write("a.po", SOURCE)?;
        let reverted = fixture.import(&mut store, &["a.po"])?;
        assert!(!imported(&reverted.files[0])?.parsed);
        assert_eq!(fixture.published()?["a.po"], before["a.po"]);
        Ok(())
    }

    #[test]
    fn each_file_returns_its_content_key() -> Result<()> {
        let fixture = Fixture::new("localization-import-key")?;
        fixture.write("a.po", SOURCE)?;
        let mut store = Store::writer(fixture.configuration.clone())?;
        let request = Request {
            files: vec![
                fixture.input("a.po", Some("Unreal")),
                Input {
                    relative_path: "b.po".into(),
                    ..fixture.input("a.po", Some("Crowdin"))
                },
            ],
            maximum_in_flight_bytes: 1 << 20,
        };
        let outcome = import(&mut store, &request, &mut |_, _| Ok(()))?;
        let (unreal, crowdin) = (imported(&outcome.files[0])?, imported(&outcome.files[1])?);
        let hash = digest(SOURCE.as_bytes());
        assert_eq!(unreal.content_hash, hash);
        assert_eq!(crowdin.content_hash, hash);
        assert_eq!(
            unreal.key,
            digest(&serde_json::to_vec(&json!([
                VERSION,
                {"format": "po", "poFormat": "Unreal"},
                hash
            ]))?)
        );
        assert_ne!(unreal.key, crowdin.key);
        Ok(())
    }

    #[test]
    fn a_request_names_each_file_once() -> Result<()> {
        let fixture = Fixture::new("localization-import-names")?;
        let request = Request {
            files: vec![fixture.input("a.po", None), fixture.input("a.po", None)],
            maximum_in_flight_bytes: 1,
        };
        assert!(request.validate().is_err());
        Ok(())
    }
}
