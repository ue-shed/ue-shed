//! Process adapter for the versioned UAsset IO protocol.
//!
//! The adapter keeps the process boundary small and typed. Human command presentation remains in
//! `legacy`; every protocol operation is executed by the native direct executors and serialized
//! only at this process-output boundary.

use std::io::{self, BufRead, Read, Write};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::cancellation::CancellationToken;
use crate::direct_executor;
use crate::protocol::{
    Contract, Operation, Request, ResultFrame, decode_event, decode_request_frame,
};
use crate::protocol_result::{
    InspectionStatus, SavedAsset, SavedAssetDecodeError, SavedAssetDecodeErrorKind,
    SavedAssetInspection, SavedBone, SavedCurveKey, SavedCurveRow, SavedEnumEntry,
    SavedPackageSummary, SavedPackageVersion, SavedProperty, SavedPropertyMapEntry,
    SavedPropertyValue, SavedStringTableEntry, SavedStructField, SavedTableRow, TextHistory,
};

const EXIT_SUCCESS: u8 = 0;
const EXIT_MALFORMED: u8 = 2;
const EXIT_INTERNAL: u8 = 5;
const DEFAULT_MAX_OUTPUT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

pub fn run() -> u8 {
    let mut request_bytes = Vec::new();
    let mut input = io::stdin().lock().take((MAX_REQUEST_BYTES + 1) as u64);
    if let Err(error) = input.read_to_end(&mut request_bytes) {
        eprintln!("uasset protocol: could not read request: {error}");
        return EXIT_MALFORMED;
    }
    if request_bytes.len() > MAX_REQUEST_BYTES {
        eprintln!("uasset protocol: request exceeds 4 MiB");
        return EXIT_MALFORMED;
    }
    let request = match decode_request_frame(&request_bytes, MAX_REQUEST_BYTES) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("uasset protocol: {error}");
            return EXIT_MALFORMED;
        }
    };
    execute_request(&request, None)
}

pub fn run_session() -> u8 {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut query_session = direct_executor::ProjectIndexQuerySession::default();

    loop {
        let mut request_bytes = Vec::new();
        let read = {
            let mut bounded = (&mut input).take((MAX_REQUEST_BYTES + 2) as u64);
            bounded.read_until(b'\n', &mut request_bytes)
        };
        let read = match read {
            Ok(read) => read,
            Err(error) => {
                eprintln!("uasset protocol-session: could not read request: {error}");
                return EXIT_MALFORMED;
            }
        };
        if read == 0 {
            return EXIT_SUCCESS;
        }
        while matches!(request_bytes.last(), Some(b'\n' | b'\r')) {
            request_bytes.pop();
        }
        if request_bytes.len() > MAX_REQUEST_BYTES {
            eprintln!("uasset protocol-session: request exceeds 4 MiB");
            return EXIT_MALFORMED;
        }
        let request = match decode_request_frame(&request_bytes, MAX_REQUEST_BYTES) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("uasset protocol-session: {error}");
                return EXIT_MALFORMED;
            }
        };
        let exit = execute_request(&request, Some(&mut query_session));
        if exit != EXIT_SUCCESS {
            return exit;
        }
    }
}

fn execute_request(
    request: &Request,
    query_session: Option<&mut direct_executor::ProjectIndexQuerySession>,
) -> u8 {
    let cancellation = CancellationToken::new();
    let mut emitter = Emitter::new(request, cancellation.clone());
    if let Err(error) = emitter.emit(
        "accepted",
        json!({ "operation": operation_kind(&request.operation) }),
    ) {
        eprintln!("uasset protocol: {error}");
        return EXIT_INTERNAL;
    }
    let result = execute_direct(request, &mut emitter, &cancellation, query_session);
    let terminal = match result {
        Ok(partial) => emitter.emit(
            "completed",
            json!({ "outcome": if partial { "partial" } else { "complete" } }),
        ),
        Err(error) => {
            let mut fields = json!({
                "code": error.code,
                "message": error.message,
                "retrySafe": error.retry_safe,
            });
            if let Some(expected) = error.expected_generation {
                fields["expectedGeneration"] = Value::from(expected);
            }
            if let Some(actual) = error.actual_generation {
                fields["actualGeneration"] = Value::from(actual);
            }
            emitter.emit("failed", fields)
        }
    };
    if let Err(error) = terminal {
        eprintln!("uasset protocol: {error}");
        return EXIT_INTERNAL;
    }
    EXIT_SUCCESS
}

type Failure = direct_executor::Failure;

struct Emitter {
    contract: Contract,
    request_id: String,
    sequence: u64,
    maximum_output_bytes: usize,
    emitted_output_bytes: usize,
    cancellation: CancellationToken,
}

#[derive(Serialize)]
struct ResultEvent<'a> {
    contract: &'a Contract,
    kind: &'static str,
    #[serde(rename = "requestId")]
    request_id: &'a str,
    sequence: u64,
    result: &'a ResultFrame,
}

impl Emitter {
    fn new(request: &Request, cancellation: CancellationToken) -> Self {
        Self {
            contract: request.contract.clone(),
            request_id: request.request_id.clone(),
            sequence: 0,
            maximum_output_bytes: request
                .limits
                .maximum_output_bytes
                .unwrap_or(DEFAULT_MAX_OUTPUT_BYTES) as usize,
            emitted_output_bytes: 0,
            cancellation,
        }
    }

    fn emit(&mut self, kind: &str, fields: Value) -> Result<(), String> {
        self.emit_internal(kind, fields, true)
    }

    fn emit_internal(&mut self, kind: &str, fields: Value, validate: bool) -> Result<(), String> {
        self.cancellation
            .checkpoint("event emission")
            .map_err(|stage| format!("operation cancelled during {stage}"))?;
        let mut object = fields
            .as_object()
            .cloned()
            .ok_or_else(|| "protocol event fields must be an object".to_owned())?;
        object.insert("contract".to_owned(), contract_value(&self.contract));
        object.insert("kind".to_owned(), Value::String(kind.to_owned()));
        object.insert(
            "requestId".to_owned(),
            Value::String(self.request_id.clone()),
        );
        object.insert("sequence".to_owned(), Value::from(self.sequence));
        let value = Value::Object(object);
        let bytes = serde_json::to_vec(&value)
            .map_err(|error| format!("could not serialize protocol event: {error}"))?;
        if validate {
            decode_event(&bytes)
                .map_err(|error| format!("internal protocol event failed validation: {error}"))?;
        }
        self.write_frame(&bytes)
    }

    fn write_frame(&mut self, bytes: &[u8]) -> Result<(), String> {
        let frame_bytes = bytes
            .len()
            .checked_add(1)
            .ok_or_else(|| "protocol output size overflowed".to_owned())?;
        let output_bytes = self
            .emitted_output_bytes
            .checked_add(frame_bytes)
            .ok_or_else(|| "protocol output size overflowed".to_owned())?;
        if output_bytes > self.maximum_output_bytes {
            return Err(format!(
                "protocol output exceeded configured limit of {} bytes",
                self.maximum_output_bytes
            ));
        }
        let mut stdout = io::stdout().lock();
        let result = stdout
            .write_all(bytes)
            .and_then(|()| stdout.write_all(b"\n"))
            .and_then(|()| stdout.flush())
            .map_err(|error| format!("could not write protocol event: {error}"));
        if let Err(error) = result {
            self.cancellation.cancel();
            return Err(error);
        }
        self.emitted_output_bytes = output_bytes;
        self.cancellation
            .checkpoint("event emission")
            .map_err(|stage| format!("operation cancelled during {stage}"))?;
        self.sequence += 1;
        Ok(())
    }

    fn emit_result_frame(&mut self, result: &ResultFrame) -> Result<(), Failure> {
        self.cancellation
            .checkpoint("event emission")
            .map_err(cancellation_failure)?;
        let event = ResultEvent {
            contract: &self.contract,
            kind: "result",
            request_id: &self.request_id,
            sequence: self.sequence,
            result,
        };
        let bytes = serde_json::to_vec(&event).map_err(|error| Failure {
            code: "contract".to_owned(),
            message: format!("could not serialize typed result: {error}"),
            retry_safe: false,
            ..Default::default()
        })?;
        self.write_frame(&bytes).map_err(emission_failure)
    }
}

fn contract_value(contract: &Contract) -> Value {
    json!({
        "name": contract.name,
        "version": { "major": contract.version.major, "minor": contract.version.minor },
    })
}

fn operation_kind(operation: &Operation) -> &'static str {
    match operation {
        Operation::Inspect { .. } => "inspect",
        Operation::Authoring { .. } => "authoring",
        Operation::Scan { .. } => "scan",
        Operation::ExtractText { .. } => "extract_text",
        Operation::ExtractTexture { .. } => "extract_texture",
        Operation::SavedWorld { .. } => "saved_world",
        Operation::ProjectIndexStatus { .. } => "project_index_status",
        Operation::ProjectIndexRefresh { .. } => "project_index_refresh",
        Operation::ProjectIndexRebuild { .. } => "project_index_rebuild",
        Operation::ProjectIndexQuery { .. } => "project_index_query",
    }
}

fn execute_direct(
    request: &Request,
    emitter: &mut Emitter,
    cancellation: &CancellationToken,
    query_session: Option<&mut direct_executor::ProjectIndexQuerySession>,
) -> Result<bool, Failure> {
    if query_session.is_some()
        && !matches!(
            &request.operation,
            Operation::Inspect { .. }
                | Operation::Authoring { .. }
                | Operation::ProjectIndexQuery { .. }
        )
    {
        return Err(Failure::new(
            "unsupported_session_operation",
            "protocol-session accepts inspect, authoring, and project index query operations",
            false,
        ));
    }
    match &request.operation {
        Operation::Inspect { asset_path } => {
            let (inspection, partial) =
                direct_executor::inspect_with_cancellation(asset_path, cancellation)?;
            emit_typed_result(emitter, &ResultFrame::Inspect { inspection })?;
            Ok(partial)
        }
        Operation::Authoring { asset_path } => {
            let (snapshot, partial) =
                direct_executor::authoring_with_cancellation(asset_path, cancellation)?;
            emit_typed_result(emitter, &ResultFrame::Authoring { snapshot })?;
            Ok(partial)
        }
        Operation::Scan { selection, .. } => {
            let empty_paths = selection.paths.as_deref() == Some(&[]);
            if !empty_paths {
                emit_progress(emitter, 0, "discovering", None)?;
            }
            let output = direct_executor::scan_with_cancellation(request, cancellation)?;
            if !empty_paths {
                emit_progress(
                    emitter,
                    0,
                    "inspecting",
                    Some(output.summary.scanned_assets),
                )?;
            }
            for diagnostic in &output.diagnostics {
                emit_diagnostic(emitter, diagnostic)?;
            }
            for entry in output.inventory {
                emit_typed_result(emitter, &ResultFrame::ScanInventory { entry })?;
            }
            for entry in output.entries {
                emit_typed_result(emitter, &ResultFrame::ScanAsset { entry })?;
            }
            let scanned_assets = output.summary.scanned_assets;
            emit_typed_result(
                emitter,
                &ResultFrame::ScanSummary {
                    summary: output.summary,
                },
            )?;
            if !empty_paths {
                emit_progress(emitter, scanned_assets, "emitting", Some(scanned_assets))?;
            }
            Ok(output.partial)
        }
        Operation::ExtractText { selection } => {
            let empty_paths = selection.paths.as_deref() == Some(&[]);
            if !empty_paths {
                emit_progress(emitter, 0, "discovering", None)?;
            }
            let output = direct_executor::extract_text_with_cancellation(request, cancellation)?;
            if !empty_paths {
                emit_progress(
                    emitter,
                    0,
                    "inspecting",
                    Some(output.summary.scanned_assets),
                )?;
            }
            for diagnostic in &output.diagnostics {
                emit_diagnostic(emitter, diagnostic)?;
            }
            for result in output.results {
                emit_typed_result(emitter, &result)?;
            }
            let scanned_assets = output.summary.scanned_assets;
            if !empty_paths {
                emit_progress(emitter, scanned_assets, "emitting", Some(scanned_assets))?;
            }
            Ok(output.partial)
        }
        Operation::ExtractTexture { selection } => {
            let empty_paths = selection.paths.as_deref() == Some(&[]);
            if !empty_paths {
                emit_progress(emitter, 0, "discovering", None)?;
            }
            let output = direct_executor::extract_texture_with_cancellation(request, cancellation)?;
            if !empty_paths {
                emit_progress(
                    emitter,
                    0,
                    "inspecting",
                    Some(output.summary.scanned_assets),
                )?;
            }
            for diagnostic in &output.diagnostics {
                emit_diagnostic(emitter, diagnostic)?;
            }
            for result in output.results {
                emit_typed_result(emitter, &result)?;
            }
            let scanned_assets = output.summary.scanned_assets;
            if !empty_paths {
                emit_progress(emitter, scanned_assets, "emitting", Some(scanned_assets))?;
            }
            Ok(output.partial)
        }
        Operation::SavedWorld { .. } => {
            let output = execute_saved_world(request, emitter, cancellation)?;
            let scanned_packages = output.world.summary.scanned_packages;
            let partial = output.partial;
            emit_typed_result(
                emitter,
                &ResultFrame::SavedWorld {
                    world: output.world,
                },
            )?;
            emit_progress(
                emitter,
                scanned_packages,
                "emitting",
                Some(scanned_packages),
            )?;
            Ok(partial)
        }
        Operation::ProjectIndexStatus {
            cache_root,
            project_root,
        } => {
            let catalog = direct_executor::open_catalog(cache_root, project_root)?;
            let status = direct_executor::project_index_status_protocol(&catalog);
            emit_typed_result(emitter, &ResultFrame::ProjectIndexStatus { status })?;
            Ok(false)
        }
        Operation::ProjectIndexRefresh {
            cache_root,
            project_root,
        } => execute_project_index_refresh(emitter, cancellation, cache_root, project_root, false),
        Operation::ProjectIndexRebuild {
            cache_root,
            project_root,
        } => execute_project_index_refresh(emitter, cancellation, cache_root, project_root, true),
        Operation::ProjectIndexQuery { cache_root, query } => {
            let page = if let Some(session) = query_session {
                session.query(cache_root, query)?
            } else {
                let catalog = direct_executor::open_catalog_for_project_id(
                    cache_root,
                    direct_executor::query_project_id(query),
                )?;
                direct_executor::project_index_query_protocol(&catalog, query)?
            };
            emit_typed_result(emitter, &ResultFrame::ProjectIndexPage { page })?;
            Ok(false)
        }
    }
}

fn execute_saved_world(
    request: &Request,
    emitter: &mut Emitter,
    cancellation: &CancellationToken,
) -> Result<direct_executor::SavedWorldOutput, Failure> {
    let (progress_sender, progress_receiver) = mpsc::channel();
    let worker_request = request.clone();
    let worker_cancellation = cancellation.clone();
    let worker = thread::spawn(move || {
        direct_executor::saved_world_with_cancellation_and_progress(
            &worker_request,
            &worker_cancellation,
            &|completed, total| {
                let _ = progress_sender.send((completed, total));
            },
        )
    });
    let mut emission_error = None;
    loop {
        match progress_receiver.recv_timeout(Duration::from_millis(25)) {
            Ok((completed, total)) => {
                if emission_error.is_none()
                    && let Err(error) = emit_progress(emitter, completed, "reading", Some(total))
                {
                    cancellation.cancel();
                    emission_error = Some(error);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) if !worker.is_finished() => {}
            Err(mpsc::RecvTimeoutError::Timeout) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                if worker.is_finished() {
                    break;
                }
            }
        }
    }
    while let Ok((completed, total)) = progress_receiver.try_recv() {
        if emission_error.is_none()
            && let Err(error) = emit_progress(emitter, completed, "reading", Some(total))
        {
            cancellation.cancel();
            emission_error = Some(error);
        }
    }
    let result = worker.join().map_err(|_| Failure {
        code: "process".to_owned(),
        message: "saved-world worker thread panicked".to_owned(),
        retry_safe: false,
        ..Default::default()
    })?;
    if let Some(error) = emission_error {
        return Err(error);
    }
    result
}

fn execute_project_index_refresh(
    emitter: &mut Emitter,
    cancellation: &CancellationToken,
    cache_root: &str,
    project_root: &str,
    rebuild: bool,
) -> Result<bool, Failure> {
    let mut catalog = direct_executor::open_catalog(cache_root, project_root)?;
    if direct_executor::catalog_was_quarantined(&catalog) {
        emitter
            .emit(
                "diagnostic",
                json!({
                    "code": "catalog_quarantined",
                    "message": "A corrupt or incompatible Catalog was quarantined and replaced before refresh.",
                    "severity": "warning"
                }),
            )
            .map_err(emission_failure)?;
    }
    let (progress_sender, progress_receiver) = mpsc::channel::<direct_executor::RefreshProgress>();
    let worker_project_root = project_root.to_owned();
    let worker_cancellation = cancellation.clone();
    let worker = thread::spawn(move || {
        direct_executor::project_index_refresh_protocol(
            &mut catalog,
            &worker_project_root,
            rebuild,
            &worker_cancellation,
            |progress| {
                let _ = progress_sender.send(progress);
            },
        )
    });
    let mut emission_error = None;
    loop {
        match progress_receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(progress) => {
                if emission_error.is_none()
                    && let Err(error) = emit_progress(
                        emitter,
                        progress.completed_packages,
                        direct_executor::progress_phase(progress.phase),
                        progress.total_packages,
                    )
                {
                    cancellation.cancel();
                    emission_error = Some(error);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) if !worker.is_finished() => {}
            Err(mpsc::RecvTimeoutError::Timeout) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                if worker.is_finished() {
                    break;
                }
            }
        }
    }
    while let Ok(progress) = progress_receiver.try_recv() {
        if emission_error.is_none()
            && let Err(error) = emit_progress(
                emitter,
                progress.completed_packages,
                direct_executor::progress_phase(progress.phase),
                progress.total_packages,
            )
        {
            cancellation.cancel();
            emission_error = Some(error);
        }
    }
    let result = worker.join().map_err(|_| Failure {
        code: "process".to_owned(),
        message: "Project Index refresh worker thread panicked".to_owned(),
        retry_safe: false,
        ..Default::default()
    })?;
    if let Some(error) = emission_error {
        return Err(error);
    }
    let output = result?;
    emit_project_index_telemetry(emitter, &output)?;
    for diagnostic in &output.diagnostics {
        emitter
            .emit(
                "diagnostic",
                json!({
                    "code": diagnostic.code,
                    "message": diagnostic.message,
                    "severity": "warning"
                }),
            )
            .map_err(emission_failure)?;
    }
    let partial =
        output.summary.completeness == crate::protocol_result::ProjectIndexCompleteness::Partial;
    emit_typed_result(
        emitter,
        &ResultFrame::ProjectIndexSummary {
            summary: output.summary,
        },
    )?;
    Ok(partial)
}

fn emit_project_index_telemetry(
    emitter: &mut Emitter,
    output: &direct_executor::ProjectIndexRefreshOutput,
) -> Result<(), Failure> {
    // Aggregate Catalog evidence only: no paths, package names, or asset identities.
    emitter
        .emit(
            "diagnostic",
            json!({
                "code": "project_index_metrics",
                "message": format!(
					"rebuild={} generation={} packages={} maps={} changed={} removed={} staged_rows={} committed_rows={} removed_rows={} evidence_write_ms={} storage_bytes={} duration_ms={} enumerating_ms={} comparing_ms={} reading_headers_ms={} committing_ms={}",
                    output.rebuild,
                    output.summary.generation,
                    output.summary.package_count,
                    output.summary.map_count,
                    output.summary.changed_packages,
                    output.summary.removed_packages,
                    output.write_counts.staged_evidence_rows,
                    output.write_counts.committed_evidence_rows,
					output.write_counts.removed_evidence_rows,
					output.write_counts.evidence_write_ms,
                    output.storage_bytes,
                    output.duration_ms,
                    output.phase_timings.enumerating_ms,
                    output.phase_timings.comparing_ms,
                    output.phase_timings.reading_headers_ms,
                    output.phase_timings.committing_ms
                ),
                "severity": "info"
            }),
        )
        .map_err(emission_failure)
}

fn emit_progress(
    emitter: &mut Emitter,
    completed_items: u64,
    phase: &str,
    total_items: Option<u64>,
) -> Result<(), Failure> {
    let mut fields = json!({ "completedItems": completed_items, "phase": phase });
    if let Some(total_items) = total_items {
        fields["totalItems"] = Value::from(total_items);
    }
    emitter.emit("progress", fields).map_err(emission_failure)
}

fn emit_diagnostic(
    emitter: &mut Emitter,
    diagnostic: &direct_executor::Diagnostic,
) -> Result<(), Failure> {
    emitter
        .emit(
            "diagnostic",
            json!({
                "code": diagnostic.code,
                "message": diagnostic.message,
                "severity": "warning"
            }),
        )
        .map_err(emission_failure)
}

fn emission_failure(message: String) -> Failure {
    Failure {
        code: if message.starts_with("protocol output exceeded") {
            "output_limit"
        } else {
            "protocol"
        }
        .to_owned(),
        message,
        retry_safe: false,
        ..Default::default()
    }
}

fn cancellation_failure(stage: &'static str) -> Failure {
    Failure {
        code: "cancelled".to_owned(),
        message: format!("operation cancelled during {stage}"),
        retry_safe: true,
        ..Default::default()
    }
}

fn emit_typed_result(emitter: &mut Emitter, result: &ResultFrame) -> Result<(), Failure> {
    emitter.emit_result_frame(result)
}

/// Adapts the inspection crate's typed generic projection to the versioned process contract.
///
/// The generic projection contains parser-facing package tables and a flattened asset shape. The
/// protocol intentionally exposes only the stable saved-asset variants, so this conversion is
/// explicit and drops fields that are not part of that contract. No JSON round-trip is involved.
pub(crate) fn adapt_inspection(
    output: uasset_inspection::generic::InspectOutput,
) -> Result<SavedAssetInspection, String> {
    let status = match output.status {
        "ok" => InspectionStatus::Ok,
        "partial" => InspectionStatus::Partial,
        status => return Err(format!("unknown inspection status {status}")),
    };
    let version = output.package.version;
    let legacy_ue3 = version
        .legacy_ue3
        .map(f64::from)
        .ok_or_else(|| "inspection package version is missing legacy_ue3".to_owned())?;
    let assets = output
        .assets
        .into_iter()
        .map(adapt_asset)
        .collect::<Result<Vec<_>, _>>()?;
    let decode_errors = output
        .decode_errors
        .into_iter()
        .map(adapt_decode_error)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SavedAssetInspection {
        schema_version: output.schema_version,
        status,
        path: output.path,
        package: SavedPackageSummary {
            name: output.package.name,
            version: SavedPackageVersion {
                legacy_file: f64::from(version.legacy_file),
                legacy_ue3,
                ue4: f64::from(version.ue4),
                ue5: f64::from(version.ue5),
                licensee: f64::from(version.licensee),
            },
            package_flags: u64::from(output.package.package_flags),
            summary_size: output.package.summary_size,
            total_header_size: u64::from(output.package.total_header_size),
        },
        assets,
        decode_errors,
    })
}

fn adapt_decode_error(
    error: uasset_inspection::generic::DecodeErrorOutput,
) -> Result<SavedAssetDecodeError, String> {
    let kind = match error.kind {
        "malformed_data" => SavedAssetDecodeErrorKind::MalformedData,
        "resource_limit" => SavedAssetDecodeErrorKind::ResourceLimit,
        "unsupported_format" => SavedAssetDecodeErrorKind::UnsupportedFormat,
        "unsupported_version" => SavedAssetDecodeErrorKind::UnsupportedVersion,
        "unsupported_capability" => SavedAssetDecodeErrorKind::UnsupportedCapability,
        kind => return Err(format!("unknown inspection decode error kind {kind}")),
    };
    Ok(SavedAssetDecodeError {
        object_path: error.object_path,
        class_path: error.class_path,
        kind,
        message: error.message,
    })
}

fn adapt_asset(asset: uasset_inspection::generic::AssetOutput) -> Result<SavedAsset, String> {
    match asset.kind {
        "StringTable" => Ok(SavedAsset::StringTable {
            object_path: asset.object_path,
            string_table_namespace: required_string(
                asset.string_table_namespace,
                "StringTable namespace",
            )?,
            string_table_entries: asset
                .string_table_entries
                .into_iter()
                .map(|entry| SavedStringTableEntry {
                    key: entry.key,
                    source: entry.source,
                })
                .collect(),
        }),
        "UObject" => Ok(SavedAsset::UObject {
            object_path: asset.object_path,
            class_path: required_string(asset.class_path, "UObject class path")?,
            properties: asset
                .properties
                .into_iter()
                .map(adapt_property)
                .collect::<Result<Vec<_>, _>>()?,
            tail_bytes: (asset.tail_bytes > 0).then_some(asset.tail_bytes),
        }),
        "DataAsset" | "PrimaryDataAsset" => {
            let class_path = required_string(asset.class_path, "data asset class path")?;
            let properties = asset
                .properties
                .into_iter()
                .map(adapt_property)
                .collect::<Result<Vec<_>, _>>()?;
            let object_path = asset.object_path;
            let object_guid = asset.object_guid;
            if asset.kind == "PrimaryDataAsset" {
                Ok(SavedAsset::PrimaryDataAsset {
                    object_path,
                    class_path,
                    object_guid,
                    properties,
                })
            } else {
                Ok(SavedAsset::DataAsset {
                    object_path,
                    class_path,
                    object_guid,
                    properties,
                })
            }
        }
        "CurveTable" => Ok(SavedAsset::CurveTable {
            object_path: asset.object_path,
            class_path: required_string(asset.class_path, "curve table class path")?,
            properties: asset
                .properties
                .into_iter()
                .map(adapt_property)
                .collect::<Result<Vec<_>, _>>()?,
            row_count: asset.row_count as u64,
            curve_rows: asset
                .curve_rows
                .into_iter()
                .map(|row| SavedCurveRow {
                    name: row.name,
                    keys: row
                        .keys
                        .into_iter()
                        .map(|key| SavedCurveKey {
                            time: f32_to_wire(key.time),
                            value: f32_to_wire(key.value),
                        })
                        .collect(),
                })
                .collect(),
        }),
        "Skeleton" => Ok(SavedAsset::Skeleton {
            object_path: asset.object_path,
            class_path: required_string(asset.class_path, "skeleton class path")?,
            object_guid: asset.object_guid,
            properties: asset
                .properties
                .into_iter()
                .map(adapt_property)
                .collect::<Result<Vec<_>, _>>()?,
            bones: asset
                .bones
                .into_iter()
                .map(|bone| SavedBone {
                    name: bone.name,
                    parent_index: i64::from(bone.parent_index),
                })
                .collect(),
        }),
        "Enum" => Ok(SavedAsset::Enum {
            object_path: asset.object_path,
            class_path: required_string(asset.class_path, "enum class path")?,
            enum_cpp_form: required_string(
                asset.enum_cpp_form.map(|form| form.to_owned()),
                "enum C++ form",
            )?,
            enum_entries: asset
                .enum_entries
                .into_iter()
                .map(|entry| SavedEnumEntry {
                    name: entry.name,
                    value: entry.value,
                    display_name: entry.display_name,
                })
                .collect(),
            row_count: asset.row_count as u64,
        }),
        "Struct" => Ok(SavedAsset::Struct {
            object_path: asset.object_path,
            class_path: required_string(asset.class_path, "struct class path")?,
            struct_flags: u64::from(required_u32(asset.struct_flags, "struct flags")?),
            struct_fields: asset
                .struct_fields
                .into_iter()
                .map(|field| SavedStructField {
                    name: field.name,
                    type_name: field.type_name,
                    referenced_path: field.referenced_path,
                    display_name: field.display_name,
                })
                .collect(),
            properties: asset
                .properties
                .into_iter()
                .map(adapt_property)
                .collect::<Result<Vec<_>, _>>()?,
            row_count: asset.row_count as u64,
        }),
        "DataTable" | "CompositeDataTable" => {
            let row_struct = asset.row_struct;
            let parent_tables = (!asset.parent_tables.is_empty()).then_some(asset.parent_tables);
            let rows = asset
                .rows
                .into_iter()
                .map(|row| {
                    Ok(SavedTableRow {
                        name: row.name,
                        properties: row
                            .properties
                            .into_iter()
                            .map(adapt_property)
                            .collect::<Result<Vec<_>, _>>()?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            if asset.kind == "CompositeDataTable" {
                Ok(SavedAsset::CompositeDataTable {
                    object_path: asset.object_path,
                    row_struct,
                    parent_tables,
                    row_count: asset.row_count as u64,
                    rows,
                })
            } else {
                Ok(SavedAsset::DataTable {
                    object_path: asset.object_path,
                    row_struct,
                    parent_tables,
                    row_count: asset.row_count as u64,
                    rows,
                })
            }
        }
        kind => Err(format!("unknown generic asset kind {kind}")),
    }
}

fn adapt_property(
    property: uasset_inspection::generic::PropertyOutput,
) -> Result<SavedProperty, String> {
    Ok(SavedProperty {
        name: property.name,
        type_name: property.type_name,
        value: adapt_property_value(property.value)?,
    })
}

fn adapt_property_value(
    value: uasset_inspection::generic::PropertyValueOutput,
) -> Result<SavedPropertyValue, String> {
    use uasset_inspection::generic::PropertyValueOutput as Value;

    Ok(match value {
        Value::Bool { value } => SavedPropertyValue::Bool { value },
        Value::Int { value } => SavedPropertyValue::Int {
            value: value as f64,
        },
        Value::Uint { value } => SavedPropertyValue::UInt {
            value: value as f64,
        },
        Value::Float { value } => SavedPropertyValue::Float {
            value: f32_to_wire(value),
        },
        Value::Double { value } => SavedPropertyValue::Double {
            value: finite_f64(value),
        },
        Value::Name { value } => SavedPropertyValue::Name { value },
        Value::Enum { value } => SavedPropertyValue::EnumValue { value },
        Value::String { value } => SavedPropertyValue::StringValue { value },
        Value::Text {
            value,
            history,
            namespace,
            key,
        } => SavedPropertyValue::Text {
            value,
            history: adapt_text_history(history)?,
            namespace,
            key,
        },
        Value::Vector { x, y, z } => SavedPropertyValue::Vector {
            x: finite_f64(x),
            y: finite_f64(y),
            z: finite_f64(z),
        },
        Value::IntPoint { x, y } => SavedPropertyValue::IntPoint {
            x: f64::from(x),
            y: f64::from(y),
        },
        Value::Rotator { pitch, yaw, roll } => SavedPropertyValue::Rotator {
            pitch: finite_f64(pitch),
            yaw: finite_f64(yaw),
            roll: finite_f64(roll),
        },
        Value::Color { r, g, b, a } => SavedPropertyValue::Color {
            r: f64::from(r),
            g: f64::from(g),
            b: f64::from(b),
            a: f64::from(a),
        },
        Value::LinearColor { r, g, b, a } => SavedPropertyValue::LinearColor {
            r: f32_to_wire(r),
            g: f32_to_wire(g),
            b: f32_to_wire(b),
            a: f32_to_wire(a),
        },
        Value::DataTableRowHandle {
            table_object_path,
            row_name,
        } => SavedPropertyValue::DataTableRowHandle {
            table_object_path,
            row_name,
        },
        Value::ObjectRef { value } => SavedPropertyValue::ObjectRef { value },
        Value::Guid { value } => SavedPropertyValue::Guid { value },
        Value::SoftObjectPath { value } => SavedPropertyValue::SoftObjectPath { value },
        Value::Array { values } => SavedPropertyValue::Array {
            values: values
                .into_iter()
                .map(adapt_property_value)
                .collect::<Result<Vec<_>, _>>()?,
        },
        Value::Set { values } => SavedPropertyValue::Set {
            values: values
                .into_iter()
                .map(adapt_property_value)
                .collect::<Result<Vec<_>, _>>()?,
        },
        Value::Map { entries } => SavedPropertyValue::Map {
            entries: entries
                .into_iter()
                .map(|entry| {
                    Ok(SavedPropertyMapEntry {
                        key: adapt_property_value(entry.key)?,
                        value: adapt_property_value(entry.value)?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
        },
        Value::Struct { properties } => SavedPropertyValue::Struct {
            properties: properties
                .into_iter()
                .map(adapt_property)
                .collect::<Result<Vec<_>, _>>()?,
        },
        Value::Raw { reason, size } => SavedPropertyValue::Raw { reason, size },
    })
}

fn adapt_text_history(history: &'static str) -> Result<TextHistory, String> {
    match history {
        "none" => Ok(TextHistory::None),
        "base" => Ok(TextHistory::Base),
        history => Err(format!("unknown text history {history}")),
    }
}

fn required_string(value: Option<String>, field: &str) -> Result<String, String> {
    value.ok_or_else(|| format!("inspection is missing {field}"))
}

fn required_u32(value: Option<u32>, field: &str) -> Result<u32, String> {
    value.ok_or_else(|| format!("inspection is missing {field}"))
}

fn finite_f64(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

fn f32_to_wire(value: f32) -> Option<f64> {
    // The compatibility JSON path formats f32 values before the protocol decoder sees them.
    // Preserve that decimal boundary while keeping the inspection model typed internally.
    if !value.is_finite() {
        return None;
    }
    Some(
        value
            .to_string()
            .parse()
            .expect("a finite f32 must have a valid f64 representation"),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::Emitter;
    use crate::cancellation::CancellationToken;
    use crate::protocol::decode_request;

    const VALID_REQUEST: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/scan-request.json"
    );

    #[test]
    fn event_emission_defaults_to_one_gibibyte_cumulative_output() {
        let mut request = decode_request(VALID_REQUEST.as_bytes()).expect("valid request");
        request.limits.maximum_output_bytes = None;
        let emitter = Emitter::new(&request, CancellationToken::new());

        assert_eq!(emitter.maximum_output_bytes, 1024 * 1024 * 1024);
    }

    #[test]
    fn event_emission_checks_cancellation_before_writing() {
        let request = decode_request(VALID_REQUEST.as_bytes()).expect("valid request");
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let mut emitter = Emitter::new(&request, cancellation);
        let error = emitter
            .emit("accepted", json!({ "operation": "scan" }))
            .expect_err("cancelled emission must not write a frame");
        assert!(error.contains("event emission"));
        assert_eq!(emitter.sequence, 0);
    }

    #[test]
    fn event_emission_applies_one_cumulative_budget_to_every_frame() {
        let request = decode_request(VALID_REQUEST.as_bytes()).expect("valid request");
        let cancellation = CancellationToken::new();
        let mut emitter = Emitter::new(&request, cancellation);
        emitter.maximum_output_bytes = 1;

        let error = emitter
            .emit("accepted", json!({ "operation": "scan" }))
            .expect_err("the first frame must consume the shared output budget");

        assert!(error.contains("protocol output exceeded"));
        assert_eq!(emitter.emitted_output_bytes, 0);
        assert_eq!(emitter.sequence, 0);
    }
}
