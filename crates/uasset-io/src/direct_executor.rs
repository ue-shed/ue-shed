//! Typed direct execution for the versioned UAsset IO protocol.
//!
//! This module owns the native execution seam. It reads files, discovers project packages,
//! schedules bounded work, and returns protocol result types. Serialization is deliberately left
//! to `protocol_adapter`, which is the only process-output seam.

mod catalog;
#[cfg(test)]
mod catalog_conformance;
#[allow(dead_code)]
mod catalog_duckdb;
#[cfg(test)]
mod catalog_memory;
mod inspection;
mod project_index;
mod project_index_io;
mod project_io;
mod scanner;

use std::fs;

use uasset_inspection::generic::inspect_bytes as inspect_package_bytes;

use crate::cancellation::CancellationToken;
use crate::protocol_result::{
    AuthoringAuthority, AuthoringContractName, AuthoringContractV2, AuthoringContractVersionV2,
    AuthoringDiagnostic, AuthoringFieldValue, AuthoringFingerprint, AuthoringFloatValue,
    AuthoringMapEntry, AuthoringProducer, AuthoringRow, AuthoringSpecialFloat, AuthoringTableKind,
    AuthoringTableSchema, AuthoringTableSnapshot, AuthoringTableSnapshotV2, AuthoringTableV2,
    AuthoringValue, Completeness, ResultFrame, SavedAsset, SavedAssetInspection,
    SavedAssetScanDiagnostic, SavedAssetScanEntry, SavedAssetScanSummary, SavedPropertyValue,
};

pub(crate) use project_index::RefreshProgress;
pub(crate) use project_index_io::{
    ProjectIndexQuerySession, ProjectIndexRefreshOutput, catalog_was_quarantined, open_catalog,
    open_catalog_for_project_id, progress_phase, query as project_index_query_protocol,
    query_project_id, refresh as project_index_refresh_protocol,
    status as project_index_status_protocol,
};
pub(crate) use project_io::{
    extract_text, extract_text_with_cancellation, extract_texture,
    extract_texture_with_cancellation, saved_world, saved_world_with_cancellation_and_progress,
    scan, scan_with_cancellation,
};

#[derive(Debug, Default)]
pub(crate) struct Failure {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) retry_safe: bool,
    pub(crate) actual_generation: Option<u64>,
    pub(crate) expected_generation: Option<u64>,
}

impl Failure {
    pub(crate) fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        retry_safe: bool,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retry_safe,
            ..Self::default()
        }
    }

    pub(crate) fn stale_generation(message: impl Into<String>, expected: u64, actual: u64) -> Self {
        Self {
            code: "stale_generation".to_owned(),
            message: message.into(),
            retry_safe: true,
            actual_generation: Some(actual),
            expected_generation: Some(expected),
        }
    }
}

pub(crate) fn checkpoint(
    cancellation: &CancellationToken,
    stage: &'static str,
) -> Result<(), Failure> {
    cancellation.checkpoint(stage).map_err(|stage| Failure {
        code: "cancelled".to_owned(),
        message: format!("operation cancelled during {stage}"),
        retry_safe: true,
        ..Default::default()
    })
}

#[derive(Debug)]
pub(crate) struct Diagnostic {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) path: String,
    pub(crate) retry_safe: bool,
}

#[derive(Debug)]
pub(crate) struct ScanOutput {
    pub(crate) entries: Vec<SavedAssetScanEntry>,
    pub(crate) inventory: Vec<crate::protocol_result::SavedAssetManifestEntry>,
    pub(crate) summary: SavedAssetScanSummary,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) partial: bool,
}

#[derive(Debug)]
pub(crate) struct ProjectionOutput {
    pub(crate) results: Vec<ResultFrame>,
    pub(crate) summary: SavedAssetScanSummary,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) partial: bool,
}

#[derive(Debug)]
pub(crate) struct SavedWorldOutput {
    pub(crate) world: crate::protocol_result::SavedWorld,
    pub(crate) partial: bool,
}

pub(crate) fn inspect_with_cancellation(
    path: &str,
    cancellation: &CancellationToken,
) -> Result<(SavedAssetInspection, bool), Failure> {
    if path == "-" {
        return Err(Failure {
            code: "io".to_owned(),
            message: "protocol inspection does not support stdin asset input".to_owned(),
            retry_safe: false,
            ..Default::default()
        });
    }
    checkpoint(cancellation, "read")?;
    let bytes = fs::read(path).map_err(|error| Failure {
        code: "io".to_owned(),
        message: format!("could not read asset {path}: {error}"),
        retry_safe: true,
        ..Default::default()
    })?;
    checkpoint(cancellation, "read")?;
    let (inspection, partial) = inspect_bytes_with_cancellation(path, &bytes, cancellation)?;
    Ok((inspection, partial))
}

pub(crate) fn inspect_bytes_with_cancellation(
    path: &str,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<(SavedAssetInspection, bool), Failure> {
    inspection::inspect_bytes(path, bytes, cancellation)
}

pub(crate) fn inspect_generic_bytes(
    path: &str,
    bytes: &[u8],
) -> Result<(uasset_inspection::generic::InspectOutput, bool), Failure> {
    inspect_generic_bytes_with_cancellation(path, bytes, &CancellationToken::new())
}

pub(crate) fn inspect_generic_bytes_with_cancellation(
    path: &str,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<(uasset_inspection::generic::InspectOutput, bool), Failure> {
    checkpoint(cancellation, "parsing")?;
    let output = inspect_package_bytes(path, bytes).map_err(|error| Failure {
        code: error.kind.to_owned(),
        message: error.message,
        retry_safe: false,
        ..Default::default()
    })?;
    checkpoint(cancellation, "parsing")?;
    checkpoint(cancellation, "inspection")?;
    let partial = output.status == "partial";
    checkpoint(cancellation, "inspection")?;
    Ok((output, partial))
}

pub(crate) fn authoring_with_cancellation(
    path: &str,
    cancellation: &CancellationToken,
) -> Result<(AuthoringTableSnapshot, bool), Failure> {
    checkpoint(cancellation, "read")?;
    let bytes = fs::read(path).map_err(|error| Failure {
        code: "io".to_owned(),
        message: format!("could not read asset {path}: {error}"),
        retry_safe: true,
        ..Default::default()
    })?;
    checkpoint(cancellation, "read")?;
    authoring_bytes_with_cancellation(path, &bytes, cancellation)
}

pub(crate) fn authoring_bytes(
    path: &str,
    bytes: &[u8],
) -> Result<(AuthoringTableSnapshot, bool), Failure> {
    authoring_bytes_with_cancellation(path, bytes, &CancellationToken::new())
}

pub(crate) fn authoring_bytes_with_cancellation(
    path: &str,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<(AuthoringTableSnapshot, bool), Failure> {
    let (inspection, inspection_partial) =
        inspect_bytes_with_cancellation(path, bytes, cancellation)?;
    checkpoint(cancellation, "inspection")?;
    let mut tables = inspection.assets.iter().filter_map(|asset| match asset {
        SavedAsset::DataTable {
            object_path,
            row_struct,
            parent_tables,
            rows,
            ..
        } => Some((
            AuthoringTableKind::DataTable,
            object_path,
            row_struct,
            parent_tables,
            rows,
        )),
        SavedAsset::CompositeDataTable {
            object_path,
            row_struct,
            parent_tables,
            rows,
            ..
        } => Some((
            AuthoringTableKind::CompositeDataTable,
            object_path,
            row_struct,
            parent_tables,
            rows,
        )),
        _ => None,
    });
    let Some((kind, object_path, row_struct, parent_tables, rows)) = tables.next() else {
        return Err(Failure {
            code: "unsupported".to_owned(),
            message: "package contains no supported DataTable export".to_owned(),
            retry_safe: false,
            ..Default::default()
        });
    };
    if tables.next().is_some() {
        return Err(Failure {
            code: "unsupported".to_owned(),
            message: "package contains more than one DataTable export".to_owned(),
            retry_safe: false,
            ..Default::default()
        });
    }

    let mut partial = inspection_partial;
    checkpoint(cancellation, "inspection")?;
    let authoring_rows = rows
        .iter()
        .map(|row| {
            let fields = row
                .properties
                .iter()
                .map(|property| {
                    let (value, value_partial) = authoring_value(&property.value);
                    partial |= value_partial;
                    AuthoringFieldValue {
                        name: property.name.clone(),
                        type_name: property.type_name.clone(),
                        value,
                    }
                })
                .collect();
            AuthoringRow {
                id: format!("row:{}", row.name),
                name: row.name.clone(),
                fields,
            }
        })
        .collect();
    checkpoint(cancellation, "inspection")?;
    let diagnostics = inspection
        .decode_errors
        .iter()
        .map(|error| AuthoringDiagnostic {
            code: authoring_error_code(&error.kind).to_owned(),
            message: error.message.clone(),
            path: Some(error.object_path.clone()),
        })
        .collect();
    checkpoint(cancellation, "inspection")?;
    let snapshot = AuthoringTableSnapshot::V2(AuthoringTableSnapshotV2 {
        contract: AuthoringContractV2 {
            name: AuthoringContractName,
            version: AuthoringContractVersionV2 { major: 2, minor: 1 },
        },
        authority: AuthoringAuthority::ProjectFiles {
            package_name: inspection.package.name.clone(),
        },
        completeness: if partial {
            Completeness::Partial
        } else {
            Completeness::Complete
        },
        diagnostics,
        fingerprint: AuthoringFingerprint::Unavailable {
            reason: "not_available".to_owned(),
        },
        producer: AuthoringProducer {
            name: "uasset-parser".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        },
        table: AuthoringTableV2 {
            kind,
            object_path: object_path.clone(),
            row_struct: row_struct.clone().unwrap_or_default(),
            parent_tables: parent_tables.clone().unwrap_or_default(),
            rows: authoring_rows,
            package_name: inspection.package.name,
            schema: AuthoringTableSchema::Unavailable {
                reason: "not_available".to_owned(),
            },
        },
    });
    checkpoint(cancellation, "inspection")?;
    Ok((snapshot, partial))
}

fn authoring_error_code(kind: &crate::protocol_result::SavedAssetDecodeErrorKind) -> &'static str {
    match kind {
        crate::protocol_result::SavedAssetDecodeErrorKind::MalformedData => "malformed_data",
        crate::protocol_result::SavedAssetDecodeErrorKind::ResourceLimit => "resource_limit",
        crate::protocol_result::SavedAssetDecodeErrorKind::UnsupportedFormat => {
            "unsupported_format"
        }
        crate::protocol_result::SavedAssetDecodeErrorKind::UnsupportedVersion => {
            "unsupported_version"
        }
        crate::protocol_result::SavedAssetDecodeErrorKind::UnsupportedCapability => {
            "unsupported_capability"
        }
    }
}

fn authoring_value(value: &SavedPropertyValue) -> (AuthoringValue, bool) {
    match value {
        SavedPropertyValue::Bool { value } => (AuthoringValue::Bool { value: *value }, false),
        SavedPropertyValue::Int { value } => (
            AuthoringValue::Int {
                value: value.to_string(),
            },
            false,
        ),
        SavedPropertyValue::UInt { value } => (
            AuthoringValue::UInt {
                value: value.to_string(),
            },
            false,
        ),
        SavedPropertyValue::Float { value } => authoring_float(value, false),
        SavedPropertyValue::Double { value } => authoring_float(value, true),
        SavedPropertyValue::Name { value } => (
            AuthoringValue::Name {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::EnumValue { value } => (
            AuthoringValue::Enum {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::StringValue { value } => (
            AuthoringValue::StringValue {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::Text { value, .. } => (
            AuthoringValue::Text {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::Guid { value } => (
            AuthoringValue::Guid {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::SoftObjectPath { value } => (
            AuthoringValue::SoftObjectPath {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::ObjectRef { value } => (
            AuthoringValue::ObjectRef {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::DataTableRowHandle {
            table_object_path,
            row_name,
        } => (
            AuthoringValue::RowReference {
                table_object_path: table_object_path.clone(),
                row_name: row_name.clone(),
            },
            false,
        ),
        SavedPropertyValue::Vector { x, y, z } => (
            AuthoringValue::Vector {
                x: x.unwrap_or_default(),
                y: y.unwrap_or_default(),
                z: z.unwrap_or_default(),
            },
            x.is_none() || y.is_none() || z.is_none(),
        ),
        SavedPropertyValue::Array { values } => {
            let (values, partial) = authoring_values(values);
            (AuthoringValue::Array { values }, partial)
        }
        SavedPropertyValue::Set { values } => {
            let (values, partial) = authoring_values(values);
            (AuthoringValue::Set { values }, partial)
        }
        SavedPropertyValue::Map { entries } => {
            let mut partial = false;
            let values = entries
                .iter()
                .map(|entry| {
                    let (key, key_partial) = authoring_value(&entry.key);
                    let (value, value_partial) = authoring_value(&entry.value);
                    partial |= key_partial || value_partial;
                    AuthoringMapEntry { key, value }
                })
                .collect();
            (AuthoringValue::Map { entries: values }, partial)
        }
        SavedPropertyValue::Struct { properties } => {
            let mut partial = false;
            let fields = properties
                .iter()
                .map(|property| {
                    let (value, value_partial) = authoring_value(&property.value);
                    partial |= value_partial;
                    AuthoringFieldValue {
                        name: property.name.clone(),
                        type_name: property.type_name.clone(),
                        value,
                    }
                })
                .collect();
            (AuthoringValue::Struct { fields }, partial)
        }
        SavedPropertyValue::IntPoint { x, y } => (
            AuthoringValue::Struct {
                fields: vec![
                    authoring_field(
                        "X",
                        "IntProperty",
                        AuthoringValue::Int {
                            value: x.to_string(),
                        },
                    ),
                    authoring_field(
                        "Y",
                        "IntProperty",
                        AuthoringValue::Int {
                            value: y.to_string(),
                        },
                    ),
                ],
            },
            false,
        ),
        SavedPropertyValue::Rotator { pitch, yaw, roll } => {
            let (pitch, pitch_partial) = authoring_float(pitch, true);
            let (yaw, yaw_partial) = authoring_float(yaw, true);
            let (roll, roll_partial) = authoring_float(roll, true);
            (
                AuthoringValue::Struct {
                    fields: vec![
                        authoring_field("Pitch", "DoubleProperty", pitch),
                        authoring_field("Yaw", "DoubleProperty", yaw),
                        authoring_field("Roll", "DoubleProperty", roll),
                    ],
                },
                pitch_partial || yaw_partial || roll_partial,
            )
        }
        SavedPropertyValue::Color { r, g, b, a } => (
            AuthoringValue::Struct {
                fields: [("R", *r), ("G", *g), ("B", *b), ("A", *a)]
                    .into_iter()
                    .map(|(name, value)| {
                        authoring_field(
                            name,
                            "IntProperty",
                            AuthoringValue::Int {
                                value: value.to_string(),
                            },
                        )
                    })
                    .collect(),
            },
            false,
        ),
        SavedPropertyValue::LinearColor { r, g, b, a } => {
            let (r, r_partial) = authoring_float(r, false);
            let (g, g_partial) = authoring_float(g, false);
            let (b, b_partial) = authoring_float(b, false);
            let (a, a_partial) = authoring_float(a, false);
            (
                AuthoringValue::Struct {
                    fields: vec![
                        authoring_field("R", "FloatProperty", r),
                        authoring_field("G", "FloatProperty", g),
                        authoring_field("B", "FloatProperty", b),
                        authoring_field("A", "FloatProperty", a),
                    ],
                },
                r_partial || g_partial || b_partial || a_partial,
            )
        }
        SavedPropertyValue::Raw { reason, size } => (
            AuthoringValue::Unsupported {
                reason: reason.clone(),
                byte_size: *size,
            },
            true,
        ),
    }
}

fn authoring_float(value: &Option<f64>, is_double: bool) -> (AuthoringValue, bool) {
    let value = match value {
        Some(value) if value.is_finite() => AuthoringFloatValue::Number(*value),
        Some(value) if value.is_nan() => AuthoringFloatValue::Special(AuthoringSpecialFloat::Nan),
        Some(value) if *value == f64::INFINITY => {
            AuthoringFloatValue::Special(AuthoringSpecialFloat::Infinity)
        }
        Some(_) => AuthoringFloatValue::Special(AuthoringSpecialFloat::NegativeInfinity),
        None => {
            return (
                AuthoringValue::Unsupported {
                    reason: "non-finite floating-point value".to_owned(),
                    byte_size: 0,
                },
                true,
            );
        }
    };
    if is_double {
        (AuthoringValue::Double { value }, false)
    } else {
        (AuthoringValue::Float { value }, false)
    }
}

fn authoring_values(values: &[SavedPropertyValue]) -> (Vec<AuthoringValue>, bool) {
    let mut partial = false;
    let values = values
        .iter()
        .map(|value| {
            let (value, value_partial) = authoring_value(value);
            partial |= value_partial;
            value
        })
        .collect();
    (values, partial)
}

fn authoring_field(name: &str, type_name: &str, value: AuthoringValue) -> AuthoringFieldValue {
    AuthoringFieldValue {
        name: name.to_owned(),
        type_name: type_name.to_owned(),
        value,
    }
}

pub(crate) fn scan_failure_code(code: &str) -> String {
    match code {
        "malformed_data" => "asset_malformed_data".to_owned(),
        "resource_limit" => "asset_resource_limit".to_owned(),
        "unsupported_format" => "asset_unsupported_format".to_owned(),
        "unsupported_version" => "asset_unsupported_version".to_owned(),
        "unsupported_capability" => "asset_unsupported_capability".to_owned(),
        code => code.to_owned(),
    }
}

pub(crate) fn scan_diagnostic(code: &str, message: String, path: &str) -> Diagnostic {
    Diagnostic {
        code: code.to_owned(),
        message,
        path: path.to_owned(),
        retry_safe: matches!(code, "asset_io" | "scan_cache_write" | "inventory_io"),
    }
}

pub(crate) fn summary_diagnostics(diagnostics: &[Diagnostic]) -> Vec<SavedAssetScanDiagnostic> {
    diagnostics
        .iter()
        .map(|diagnostic| SavedAssetScanDiagnostic {
            code: diagnostic.code.clone(),
            message: diagnostic.message.clone(),
            path: diagnostic.path.clone(),
            retry_safe: diagnostic.retry_safe,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        authoring_bytes_with_cancellation, inspect_generic_bytes_with_cancellation,
        inspect_with_cancellation, scan_with_cancellation,
    };
    use crate::cancellation::CancellationToken;
    use crate::protocol::decode_request;

    const VALID_SCAN_REQUEST: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/scan-request.json"
    );

    #[test]
    fn cancellation_stops_before_read_parsing_and_discovery() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let read_error = inspect_with_cancellation("missing.uasset", &cancellation)
            .expect_err("cancelled read should not touch the filesystem");
        assert_eq!(read_error.code, "cancelled");
        assert!(read_error.message.contains("read"));

        let parsing_error = inspect_generic_bytes_with_cancellation("memory", &[], &cancellation)
            .err()
            .expect("cancelled parsing should not enter the parser");
        assert_eq!(parsing_error.code, "cancelled");
        assert!(parsing_error.message.contains("parsing"));

        let request = decode_request(VALID_SCAN_REQUEST.as_bytes()).expect("valid scan request");
        let discovery_error = scan_with_cancellation(&request, &cancellation)
            .expect_err("cancelled discovery should not enumerate files");
        assert_eq!(discovery_error.code, "cancelled");

        let authoring_error = authoring_bytes_with_cancellation("memory", &[], &cancellation)
            .expect_err("cancelled authoring should stop at its inspection boundary");
        assert_eq!(authoring_error.code, "cancelled");
    }

    #[test]
    fn cancellation_token_reports_each_protocol_stage_deterministically() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        for stage in [
            "discovery",
            "read",
            "parsing",
            "inspection",
            "event emission",
        ] {
            assert_eq!(cancellation.checkpoint(stage), Err(stage));
        }
    }
}
