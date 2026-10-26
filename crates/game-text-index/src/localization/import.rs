use super::{Diagnostic, Format, Limits, Options, Parsed, failure, parse_bytes};
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
    #[cfg_attr(test, ts(type = "string"))]
    pub project_root: PathBuf,
    #[cfg_attr(test, ts(type = "string"))]
    pub file: PathBuf,
    pub relative_path: String,
    pub options: Options,
    pub limits: Limits,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationImportRequest"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub files: Vec<Input>,
    #[cfg_attr(test, ts(type = "number"))]
    pub maximum_in_flight_bytes: u64,
    pub cold: bool,
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
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationFileResult"))]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub file: Option<PreparedFile>,
    pub error: Option<Diagnostic>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationImportOutcome"))]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub files: Vec<FileResult>,
    pub worker_count: usize,
    pub parse_ms: f64,
    pub parse_cpu_ms: f64,
    pub publish_ms: f64,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        require(
            !self.files.is_empty() && self.files.len() <= 2560 && self.maximum_in_flight_bytes > 0,
            "localization file or byte bound",
        )?;
        for input in &self.files {
            require(
                !input.relative_path.is_empty()
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
    // packages/game-text/src/localization-import.ts:316-320: options order is part of the key.
    let key = digest(
        &serde_json::to_vec(&json!([6, input.options, content_hash]))
            .map_err(|_| failure(file, "invalid_schema", ""))?,
    );
    let existing = cached.get(&key);
    let layer = if existing.is_none() {
        Some(Arc::new(parse_bytes(
            &bytes,
            file,
            &input.options,
            &input.limits,
        )?))
    } else {
        None
    };
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
    let mut files = Vec::new();
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
                files.push(FileResult {
                    file: Some(file),
                    error: None,
                });
            }
            Err(error) => files.push(FileResult {
                file: None,
                error: Some(error),
            }),
        }
    }
    let publish_started = Instant::now();
    if !files.iter().any(|file| file.error.is_some()) {
        if request.cold
            && store.root["active"]
                .as_object()
                .is_some_and(|active| active.is_empty())
        {
            store.publish_cold_sources(&layers)?;
        } else {
            for layer in layers {
                store.prepare_local_reader(&layer.name, &layer.key, layer.source.open()?, true)?;
            }
            for file in &files {
                if let Some(file) = &file.file {
                    store.root["active"][&file.relative_path] = json!(file.key);
                }
            }
        }
        store.publish_root()?;
        for file in &mut files {
            if let Some(file) = &mut file.file {
                file.snapshot_bytes = store.root["layers"][&file.key]["bytes"]
                    .as_u64()
                    .ok_or("layer bytes")?;
            }
        }
    }
    Ok(Outcome {
        files,
        worker_count,
        parse_ms,
        parse_cpu_ms,
        publish_ms: publish_started.elapsed().as_secs_f64() * 1000.0,
    })
}
