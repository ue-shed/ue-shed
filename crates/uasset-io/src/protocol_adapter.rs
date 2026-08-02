//! Process adapter for the versioned UAsset IO protocol.
//!
//! The adapter keeps the process boundary small and typed. Human compatibility commands remain
//! in `legacy`; this module translates their established JSON records into the versioned event
//! stream consumed by TypeScript.

use std::env;
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};

use serde_json::{Value, json};

use crate::direct_executor;
use crate::protocol::{
    Contract, Operation, Request, ResultFrame, ScanDepth, decode_event, decode_request,
};
use crate::protocol_result::{
    InspectionStatus, SavedAsset, SavedAssetDecodeError, SavedAssetDecodeErrorKind,
    SavedAssetInspection, SavedBone, SavedCurveKey, SavedCurveRow, SavedEnumEntry,
    SavedPackageSummary, SavedPackageVersion, SavedProperty, SavedPropertyMapEntry,
    SavedPropertyValue, SavedStringTableEntry, SavedStructField, SavedTableRow, TextHistory,
};

const EXIT_SUCCESS: u8 = 0;
const EXIT_MALFORMED: u8 = 2;
const EXIT_UNSUPPORTED: u8 = 3;
const EXIT_IO: u8 = 4;
const EXIT_INTERNAL: u8 = 5;
const EXIT_PARTIAL: u8 = 6;
const EXIT_RESOURCE_LIMIT: u8 = 7;
const DEFAULT_MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
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
    let request = match decode_request(&request_bytes) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("uasset protocol: {error}");
            return EXIT_MALFORMED;
        }
    };
    let mut emitter = Emitter::new(&request);
    if let Err(error) = emitter.emit(
        "accepted",
        json!({ "operation": operation_kind(&request.operation) }),
    ) {
        eprintln!("uasset protocol: {error}");
        return EXIT_INTERNAL;
    }
    let result = execute(&request, &mut emitter);
    let terminal = match result {
        Ok(partial) => emitter.emit(
            "completed",
            json!({ "outcome": if partial { "partial" } else { "complete" } }),
        ),
        Err(error) => emitter.emit(
            "failed",
            json!({
                "code": error.code,
                "message": error.message,
                "retrySafe": error.retry_safe,
            }),
        ),
    };
    if let Err(error) = terminal {
        eprintln!("uasset protocol: {error}");
        return EXIT_INTERNAL;
    }
    EXIT_SUCCESS
}

#[derive(Debug)]
struct Failure {
    code: String,
    message: String,
    retry_safe: bool,
}

struct TemporaryPath(Option<PathBuf>);

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

struct Emitter {
    contract: Contract,
    request_id: String,
    sequence: u64,
}

impl Emitter {
    fn new(request: &Request) -> Self {
        Self {
            contract: request.contract.clone(),
            request_id: request.request_id.clone(),
            sequence: 0,
        }
    }

    fn emit(&mut self, kind: &str, fields: Value) -> Result<(), String> {
        self.emit_internal(kind, fields, true)
    }

    /// Emits a value that was already constructed from a Rust protocol type.
    ///
    /// The compatibility path validates every translated JSON result by decoding it again. A
    /// direct executor has already crossed that type boundary, so decoding the same large result
    /// a second time only adds work before the required wire serialization.
    fn emit_unvalidated(&mut self, kind: &str, fields: Value) -> Result<(), String> {
        self.emit_internal(kind, fields, false)
    }

    fn emit_internal(&mut self, kind: &str, fields: Value, validate: bool) -> Result<(), String> {
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
        let mut stdout = io::stdout().lock();
        stdout
            .write_all(&bytes)
            .and_then(|()| stdout.write_all(b"\n"))
            .and_then(|()| stdout.flush())
            .map_err(|error| format!("could not write protocol event: {error}"))?;
        self.sequence += 1;
        Ok(())
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
    }
}

fn execute(request: &Request, emitter: &mut Emitter) -> Result<bool, Failure> {
    if explicit_empty_paths(&request.operation) {
        emit_empty_result(request, emitter).map_err(internal_failure)?;
        return Ok(false);
    }
    if let Operation::Inspect { asset_path } = &request.operation {
        let (inspection, partial) = direct_executor::inspect(
            asset_path,
            request
                .limits
                .maximum_output_bytes
                .unwrap_or(DEFAULT_MAX_OUTPUT_BYTES) as usize,
        )
        .map_err(|error| Failure {
            code: error.code,
            message: error.message,
            retry_safe: error.retry_safe,
        })?;
        emit_typed_result(emitter, &ResultFrame::Inspect { inspection })?;
        return Ok(partial);
    }
    if direct_executor::supports_full_scan(request) {
        emitter
            .emit(
                "progress",
                json!({ "completedItems": 0, "phase": "discovering", "totalItems": 0 }),
            )
            .map_err(internal_failure)?;
        let output = direct_executor::scan(request).map_err(|error| Failure {
            code: error.code,
            message: error.message,
            retry_safe: error.retry_safe,
        })?;
        emitter
            .emit(
                "progress",
                json!({
                    "completedItems": 0,
                    "phase": "inspecting",
                    "totalItems": output.summary.scanned_assets
                }),
            )
            .map_err(internal_failure)?;
        for diagnostic in output.diagnostics {
            emitter
                .emit(
                    "diagnostic",
                    json!({
                        "code": diagnostic.code,
                        "message": diagnostic.message,
                        "severity": "warning"
                    }),
                )
                .map_err(internal_failure)?;
        }
        let scanned_assets = output.summary.scanned_assets;
        for entry in output.entries {
            emit_typed_result(emitter, &ResultFrame::ScanAsset { entry })?;
        }
        emit_typed_result(
            emitter,
            &ResultFrame::ScanSummary {
                summary: output.summary,
            },
        )?;
        emitter
            .emit(
                "progress",
                json!({
                    "completedItems": scanned_assets,
                    "phase": "emitting",
                    "totalItems": scanned_assets
                }),
            )
            .map_err(internal_failure)?;
        return Ok(output.partial);
    }
    let (arguments, path_list) = legacy_arguments(request).map_err(invalid_failure)?;
    let _path_guard = TemporaryPath(path_list);
    let executable = env::current_exe().map_err(|error| Failure {
        code: "startup".to_owned(),
        message: format!("could not locate uasset executable: {error}"),
        retry_safe: false,
    })?;
    let watch_worker = !request_reads_stdin(request);
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if watch_worker {
        command
            .stdin(Stdio::piped())
            .env("UE_SHED_PROTOCOL_PARENT_WATCHDOG", "1");
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command.spawn().map_err(|error| Failure {
        code: "startup".to_owned(),
        message: format!("could not start uasset worker: {error}"),
        retry_safe: true,
    })?;
    let worker_stdin = child.stdin.take();
    let (stderr_receiver, stderr_handle) = child.stderr.take().map_or((None, None), |stderr| {
        let (sender, receiver) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let mut captured = String::new();
            for line in io::BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                captured.push_str(&line);
                captured.push('\n');
                let _ = sender.send(line);
            }
            captured
        });
        (Some(receiver), Some(handle))
    });
    let stdout = child.stdout.take().ok_or_else(|| Failure {
        code: "startup".to_owned(),
        message: "uasset worker did not expose stdout".to_owned(),
        retry_safe: false,
    })?;
    let maximum_output_bytes = request
        .limits
        .maximum_output_bytes
        .unwrap_or(DEFAULT_MAX_OUTPUT_BYTES) as usize;
    let mut reader = io::BufReader::new(stdout);
    let mut line = String::new();
    let mut partial = false;
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).map_err(|error| Failure {
            code: "read".to_owned(),
            message: format!("could not read uasset worker output: {error}"),
            retry_safe: true,
        })?;
        if bytes == 0 {
            break;
        }
        if let Some(receiver) = &stderr_receiver {
            emit_progress_lines(emitter, receiver).map_err(internal_failure)?;
        }
        if line.len() > maximum_output_bytes {
            let _ = child.kill();
            return Err(Failure {
                code: "output_limit".to_owned(),
                message: "uasset worker output exceeded the configured limit".to_owned(),
                retry_safe: false,
            });
        }
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(line.trim()).map_err(|error| Failure {
            code: "worker_output".to_owned(),
            message: format!("uasset worker emitted invalid JSON: {error}"),
            retry_safe: false,
        })?;
        consume_line(request, emitter, value, &mut partial)?;
    }
    let status = child.wait().map_err(|error| Failure {
        code: "wait".to_owned(),
        message: format!("could not wait for uasset worker: {error}"),
        retry_safe: true,
    })?;
    drop(worker_stdin);
    let stderr = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if let Some(receiver) = &stderr_receiver {
        emit_progress_lines(emitter, receiver).map_err(internal_failure)?;
    }
    let code = status.code().unwrap_or(EXIT_INTERNAL as i32);
    if code == EXIT_PARTIAL as i32 {
        partial = true;
    } else if code != EXIT_SUCCESS as i32 {
        let (failure_code, retry_safe) = match code as u8 {
            EXIT_IO => ("io", true),
            EXIT_RESOURCE_LIMIT => ("resource_limit", false),
            EXIT_MALFORMED | EXIT_UNSUPPORTED => ("worker_rejected", false),
            _ => ("worker", false),
        };
        let message = worker_message(&stderr, code);
        emitter
            .emit(
                "diagnostic",
                json!({ "code": failure_code, "message": message, "severity": "warning" }),
            )
            .map_err(internal_failure)?;
        return Err(Failure {
            code: failure_code.to_owned(),
            message: worker_message(&stderr, code),
            retry_safe,
        });
    }
    Ok(partial)
}

fn worker_message(stderr: &str, code: i32) -> String {
    stderr
        .lines()
        .rfind(|line| !line.trim().is_empty())
        .map_or_else(
            || format!("uasset worker exited with code {code}"),
            str::to_owned,
        )
}

fn internal_failure(message: String) -> Failure {
    Failure {
        code: "protocol".to_owned(),
        message,
        retry_safe: false,
    }
}

fn invalid_failure(message: String) -> Failure {
    Failure {
        code: "invalid_request".to_owned(),
        message,
        retry_safe: false,
    }
}

fn explicit_empty_paths(operation: &Operation) -> bool {
    match operation {
        Operation::Scan { selection, .. }
        | Operation::ExtractText { selection }
        | Operation::ExtractTexture { selection } => selection.paths.as_deref() == Some(&[]),
        _ => false,
    }
}

fn request_reads_stdin(request: &Request) -> bool {
    matches!(
        &request.operation,
        Operation::Inspect { asset_path } | Operation::Authoring { asset_path }
            if asset_path == "-"
    )
}

fn consume_line(
    request: &Request,
    emitter: &mut Emitter,
    mut value: Value,
    partial: &mut bool,
) -> Result<(), Failure> {
    match operation_kind(&request.operation) {
        "inspect" => {
            value = normalize_inspection(value);
            emit_result(emitter, json!({ "kind": "inspect", "inspection": value }))?;
        }
        "authoring" => emit_result(emitter, json!({ "kind": "authoring", "snapshot": value }))?,
        "saved_world" => emit_result(emitter, json!({ "kind": "saved_world", "world": value }))?,
        "scan" => {
            let event = value
                .as_object_mut()
                .and_then(|object| object.remove("event"))
                .and_then(|event| event.as_str().map(str::to_owned));
            match event.as_deref() {
                Some("asset") => {
                    if let Some(inspection) = value.get_mut("inspection") {
                        *inspection = normalize_inspection(inspection.take());
                    }
                    emit_result(emitter, json!({ "kind": "scan_asset", "entry": value }))?;
                }
                Some("inventory") => {
                    emit_result(emitter, json!({ "kind": "scan_inventory", "entry": value }))?
                }
                Some("summary") => {
                    emit_result(emitter, json!({ "kind": "scan_summary", "summary": value }))?
                }
                Some("error") => {
                    *partial = true;
                    let object = value.as_object().ok_or_else(|| {
                        invalid_failure("scan error was not an object".to_owned())
                    })?;
                    emitter
						.emit(
							"diagnostic",
							json!({
								"code": object.get("code").and_then(Value::as_str).unwrap_or("asset"),
								"message": object.get("message").and_then(Value::as_str).unwrap_or("asset scan failed"),
								"severity": "warning",
							}),
						)
						.map_err(internal_failure)?;
                }
                Some(other) => {
                    return Err(invalid_failure(format!("unknown scan event {other:?}")));
                }
                None => {
                    return Err(invalid_failure(
                        "scan output did not contain an event".to_owned(),
                    ));
                }
            }
        }
        "extract_text" | "extract_texture" => {
            if value.get("event").and_then(Value::as_str) == Some("error") {
                *partial = true;
                let object = value.as_object().ok_or_else(|| {
                    invalid_failure("projection error was not an object".to_owned())
                })?;
                emitter
					.emit(
						"diagnostic",
						json!({
							"code": object.get("code").and_then(Value::as_str).unwrap_or("projection"),
							"message": object.get("message").and_then(Value::as_str).unwrap_or("projection failed"),
							"severity": "warning",
						}),
					)
					.map_err(internal_failure)?;
            } else {
                let kind = if operation_kind(&request.operation) == "extract_text" {
                    "extract_text"
                } else {
                    "extract_texture"
                };
                emit_result(emitter, json!({ "kind": kind, "event": value }))?;
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn emit_result(emitter: &mut Emitter, result: Value) -> Result<(), Failure> {
    serde_json::from_value::<ResultFrame>(result.clone()).map_err(|error| Failure {
        code: "contract".to_owned(),
        message: format!("worker result did not match the protocol: {error}"),
        retry_safe: false,
    })?;
    emitter
        .emit("result", json!({ "result": result }))
        .map_err(internal_failure)
}

fn emit_typed_result(emitter: &mut Emitter, result: &ResultFrame) -> Result<(), Failure> {
    let mut value = serde_json::to_value(result).map_err(|error| Failure {
        code: "contract".to_owned(),
        message: format!("could not serialize typed result: {error}"),
        retry_safe: false,
    })?;
    if let Some(inspection) = value.get_mut("inspection") {
        *inspection = normalize_inspection(inspection.take());
    }
    if let Some(entry) = value.get_mut("entry") {
        if let Some(inspection) = entry.get_mut("inspection") {
            *inspection = normalize_inspection(inspection.take());
        }
    }
    if let Some(summary) = value.get_mut("summary").and_then(Value::as_object_mut) {
        for key in ["inventoryComplete", "inventoryFiles"] {
            if summary.get(key).is_some_and(Value::is_null) {
                summary.remove(key);
            }
        }
    }
    emitter
        .emit_unvalidated("result", json!({ "result": value }))
        .map_err(internal_failure)
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

pub(crate) fn normalize_inspection(mut value: Value) -> Value {
    let Some(root) = value.as_object_mut() else {
        return value;
    };
    if let Some(package) = root.get_mut("package").and_then(Value::as_object_mut) {
        retain(
            package,
            &[
                "name",
                "version",
                "package_flags",
                "summary_size",
                "total_header_size",
            ],
        );
    }
    if let Some(assets) = root.get_mut("assets").and_then(Value::as_array_mut) {
        for asset in assets {
            normalize_asset(asset);
        }
    }
    if let Some(errors) = root.get_mut("decode_errors").and_then(Value::as_array_mut) {
        for error in errors {
            if let Some(object) = error.as_object_mut()
                && object.get("class_path").is_some_and(Value::is_null)
            {
                object.remove("class_path");
            }
        }
    }
    value
}

fn normalize_asset(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let keys: &[&str] = match kind {
        "StringTable" => &[
            "kind",
            "object_path",
            "string_table_namespace",
            "string_table_entries",
        ],
        "UObject" => &[
            "kind",
            "object_path",
            "class_path",
            "properties",
            "tail_bytes",
        ],
        "DataAsset" | "PrimaryDataAsset" => &[
            "kind",
            "object_path",
            "class_path",
            "object_guid",
            "properties",
        ],
        "CurveTable" => &[
            "kind",
            "object_path",
            "class_path",
            "properties",
            "row_count",
            "curve_rows",
        ],
        "Skeleton" => &[
            "kind",
            "object_path",
            "class_path",
            "object_guid",
            "properties",
            "bones",
        ],
        "Enum" => &[
            "kind",
            "object_path",
            "class_path",
            "enum_cpp_form",
            "enum_entries",
            "row_count",
        ],
        "Struct" => &[
            "kind",
            "object_path",
            "class_path",
            "struct_flags",
            "struct_fields",
            "properties",
            "row_count",
        ],
        "DataTable" | "CompositeDataTable" => &[
            "kind",
            "object_path",
            "row_struct",
            "parent_tables",
            "row_count",
            "rows",
        ],
        _ => &[],
    };
    retain(object, keys);
    for key in ["object_guid", "tail_bytes", "row_struct", "parent_tables"] {
        if object.get(key).is_some_and(Value::is_null) {
            object.remove(key);
        }
    }
}

fn retain(object: &mut serde_json::Map<String, Value>, keys: &[&str]) {
    object.retain(|key, _| keys.iter().any(|candidate| *candidate == key));
}

fn emit_progress_lines(emitter: &mut Emitter, receiver: &Receiver<String>) -> Result<(), String> {
    for line in receiver.try_iter() {
        emit_progress_line(emitter, &line)?;
    }
    Ok(())
}

fn emit_progress_line(emitter: &mut Emitter, line: &str) -> Result<(), String> {
    if line.trim().is_empty() {
        return Ok(());
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Ok(());
    };
    let Some(event) = value.get("event").and_then(Value::as_str) else {
        return Ok(());
    };
    let (phase, completed, total) = match event {
        "scan_progress" => {
            let phase = match value.get("phase").and_then(Value::as_str) {
                Some("enumerating") => "discovering",
                Some("scanning") => "inspecting",
                Some("ready") => "emitting",
                _ => "reading",
            };
            (
                phase,
                value.get("processedAssets").and_then(Value::as_u64),
                value.get("totalAssets").and_then(Value::as_u64),
            )
        }
        "saved_world_progress" => {
            let phase = match value.get("phase").and_then(Value::as_str) {
                Some("enumerating") => "discovering",
                Some("scanning") | Some("resolving") => "inspecting",
                Some("ready") => "emitting",
                _ => "reading",
            };
            (
                phase,
                value.get("processedPackages").and_then(Value::as_u64),
                value.get("totalPackages").and_then(Value::as_u64),
            )
        }
        _ => return Ok(()),
    };
    let mut fields = json!({
            "completedItems": completed.unwrap_or(0),
            "phase": phase,
    });
    if let Some(total) = total {
        fields["totalItems"] = Value::from(total);
    }
    emitter.emit("progress", fields)
}

fn emit_empty_result(request: &Request, emitter: &mut Emitter) -> Result<(), String> {
    let result = match &request.operation {
        Operation::Scan { depth, .. } => json!({
            "kind": "scan_summary",
            "summary": empty_summary(request, match depth { ScanDepth::Header => "header", ScanDepth::Full => "full" }),
        }),
        Operation::ExtractText { .. } => json!({
            "kind": "extract_text",
            "event": empty_projection_summary(request, "text"),
        }),
        Operation::ExtractTexture { .. } => json!({
            "kind": "extract_texture",
            "event": empty_projection_summary(request, "texture"),
        }),
        _ => unreachable!(),
    };
    emit_result(emitter, result).map_err(|error| error.message)
}

fn empty_summary(request: &Request, depth: &str) -> Value {
    json!({
        "cacheHits": 0,
        "depth": depth,
        "diagnostics": [],
        "emittedAssets": 0,
        "failedAssets": 0,
        "inventoryComplete": false,
        "inventoryFiles": 0,
        "partialAssets": 0,
        "projectRoot": project_root(request),
        "roots": [],
        "scannedAssets": 0,
        "schema_version": 8,
        "skippedAssets": 0,
    })
}

fn empty_projection_summary(request: &Request, depth: &str) -> Value {
    let mut summary = empty_summary(request, depth);
    summary["event"] = Value::String(
        if depth == "text" {
            "text_summary"
        } else {
            "texture_summary"
        }
        .to_owned(),
    );
    summary
}

fn project_root(request: &Request) -> String {
    match &request.operation {
        Operation::Scan { selection, .. }
        | Operation::ExtractText { selection }
        | Operation::ExtractTexture { selection } => selection.project_root.clone(),
        Operation::SavedWorld { project_root, .. } => project_root.clone(),
        Operation::Inspect { asset_path } | Operation::Authoring { asset_path } => {
            asset_path.clone()
        }
    }
}

fn legacy_arguments(request: &Request) -> Result<(Vec<String>, Option<PathBuf>), String> {
    let mut args = Vec::new();
    let mut path_list = None;
    match &request.operation {
        Operation::Inspect { asset_path } => {
            args.extend([
                "inspect".to_owned(),
                asset_path.clone(),
                "--format".to_owned(),
                "json".to_owned(),
            ]);
        }
        Operation::Authoring { asset_path } => {
            args.extend([
                "authoring".to_owned(),
                asset_path.clone(),
                "--format".to_owned(),
                "json".to_owned(),
            ]);
        }
        Operation::Scan {
            cache_path,
            depth,
            selection,
            filters,
            inventory,
        } => {
            args.extend([
                "scan".to_owned(),
                selection.project_root.clone(),
                "--format".to_owned(),
                "json".to_owned(),
                "--concurrency".to_owned(),
                request.limits.concurrency.unwrap_or(4).to_string(),
                "--depth".to_owned(),
                match depth {
                    ScanDepth::Header => "header".to_owned(),
                    ScanDepth::Full => "full".to_owned(),
                },
            ]);
            if let Some(cache_path) = cache_path {
                args.extend(["--cache".to_owned(), cache_path.clone()]);
            }
            if inventory.unwrap_or(false) {
                args.push("--inventory".to_owned());
            }
            append_paths(&mut args, &mut path_list, selection.paths.as_deref())?;
            append_filters(&mut args, filters);
            if let Some(maximum_assets) = request.limits.maximum_assets {
                args.extend(["--maximum-assets".to_owned(), maximum_assets.to_string()]);
            }
        }
        Operation::ExtractText { selection } | Operation::ExtractTexture { selection } => {
            let projection = if matches!(&request.operation, Operation::ExtractText { .. }) {
                "text"
            } else {
                "texture"
            };
            args.extend([
                "scan".to_owned(),
                selection.project_root.clone(),
                "--format".to_owned(),
                "json".to_owned(),
                "--concurrency".to_owned(),
                request.limits.concurrency.unwrap_or(4).to_string(),
                "--projection".to_owned(),
                projection.to_owned(),
            ]);
            append_paths(&mut args, &mut path_list, selection.paths.as_deref())?;
            if selection.paths.is_none() {
                if projection == "text" {
                    args.extend([
                        "--class".to_owned(),
                        "/Script/Engine.StringTable".to_owned(),
                        "--name".to_owned(),
                        "TextProperty".to_owned(),
                    ]);
                } else {
                    args.extend(["--class".to_owned(), "/Script/Engine.Texture2D".to_owned()]);
                }
            }
            if let Some(maximum_assets) = request.limits.maximum_assets {
                args.extend(["--maximum-assets".to_owned(), maximum_assets.to_string()]);
            }
        }
        Operation::SavedWorld {
            map_path,
            project_root,
        } => {
            args.extend([
                "saved-world".to_owned(),
                project_root.clone(),
                map_path.clone(),
                "--format".to_owned(),
                "json".to_owned(),
                "--concurrency".to_owned(),
                request.limits.concurrency.unwrap_or(4).to_string(),
            ]);
            if let Some(maximum_assets) = request.limits.maximum_assets {
                args.extend(["--maximum-assets".to_owned(), maximum_assets.to_string()]);
            }
        }
    }
    Ok((args, path_list))
}

fn append_paths(
    args: &mut Vec<String>,
    path_list: &mut Option<PathBuf>,
    paths: Option<&[String]>,
) -> Result<(), String> {
    let Some(paths) = paths else {
        return Ok(());
    };
    let path = env::temp_dir().join(format!(
        "ue-shed-uasset-protocol-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    ));
    fs::write(
        &path,
        serde_json::to_vec(paths).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    args.extend([
        "--path-list".to_owned(),
        path.to_string_lossy().into_owned(),
    ]);
    *path_list = Some(path);
    Ok(())
}

fn append_filters(args: &mut Vec<String>, filters: &crate::protocol::ScanFilters) {
    for value in filters.classes.as_deref().unwrap_or_default() {
        args.extend(["--class".to_owned(), value.clone()]);
    }
    for value in filters.class_prefixes.as_deref().unwrap_or_default() {
        args.extend(["--class-prefix".to_owned(), value.clone()]);
    }
    for value in filters.class_name_suffixes.as_deref().unwrap_or_default() {
        args.extend(["--class-name-suffix".to_owned(), value.clone()]);
    }
    for value in filters.names.as_deref().unwrap_or_default() {
        args.extend(["--name".to_owned(), value.clone()]);
    }
}
