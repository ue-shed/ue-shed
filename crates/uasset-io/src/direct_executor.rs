//! Typed direct execution for the versioned UAsset IO protocol.
//!
//! This module owns the native execution seam. It reads files, discovers project packages,
//! schedules bounded work, and returns protocol result types. Serialization is deliberately left
//! to `protocol_adapter`, which is the only process-output seam.

mod blueprint;
mod level_sequence;
pub(crate) use level_sequence::level_sequence_with_cancellation;
mod catalog;
mod catalog_binary;
#[cfg(test)]
mod catalog_conformance;
#[cfg(test)]
mod catalog_memory;
#[allow(dead_code)]
#[cfg(all(test, feature = "catalog-oracle"))]
mod catalog_sqlite;
mod inspection;
mod project_index;
mod project_index_io;
mod project_io;
mod scanner;

use std::fs;

use uasset_inspection::generic::inspect_bytes as inspect_package_bytes;

use crate::cancellation::CancellationToken;
use crate::protocol_result::{
    AuthoringTableSnapshot, ResultFrame, SavedAssetInspection, SavedAssetScanDiagnostic,
    SavedAssetScanEntry, SavedAssetScanSummary,
};

pub(crate) use blueprint::blueprint_with_cancellation;
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
    let (inspection, partial) = inspect_bytes_with_cancellation(path, bytes, cancellation)?;
    uasset_inspection::authoring::project_authoring_table(inspection, partial, &|stage| {
        checkpoint(cancellation, stage).map_err(|error| {
            uasset_inspection::saved_inspection::InspectionError::new(
                error.code,
                error.message,
                error.retry_safe,
            )
        })
    })
    .map_err(|error| Failure::new(error.code, error.message, error.retry_safe))
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
    fn portable_authoring_json_matches_native_file_wrapper() {
        for name in ["DT_Scalars", "CDT_Scalars", "DT_LargeScalars"] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/unreal-project/Content/Fixture/Authoring")
                .join(format!("{name}.uasset"));
            let bytes = std::fs::read(&path).expect("DataTable fixture");
            let path = path.to_str().expect("fixture path");
            let (portable, portable_partial) =
                uasset_inspection::authoring::inspect_authoring_bytes(path, &bytes)
                    .expect("portable projection");
            let (native, native_partial) =
                super::authoring_with_cancellation(path, &CancellationToken::new())
                    .expect("native file wrapper");
            assert_eq!(
                serde_json::to_value(portable).expect("portable JSON"),
                serde_json::to_value(native).expect("native JSON"),
                "{name}",
            );
            assert_eq!(portable_partial, native_partial);
        }
    }

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
