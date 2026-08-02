//! Direct typed execution for protocol operations.
//!
//! This module is intentionally introduced behind the protocol boundary. Human compatibility
//! commands remain in `legacy` while operations move here one vertical slice at a time.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use uasset_inspection::generic::inspect_bytes as inspect_package_bytes;

use crate::protocol::{Operation, Request, ScanDepth};
use crate::protocol_result::{
    ResultFrame, SavedAssetInspection, SavedAssetScanDiagnostic, SavedAssetScanEntry,
    SavedAssetScanSummary, ScanSummaryDepth,
};

#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) retry_safe: bool,
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
    pub(crate) summary: SavedAssetScanSummary,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) partial: bool,
}

/// Executes one inspection without starting the compatibility worker process.
///
/// The generic inspection projection is adapted to the versioned Rust protocol type without
/// serializing and decoding the inspection through JSON.
pub(crate) fn inspect(
    path: &str,
    maximum_output_bytes: usize,
) -> Result<(SavedAssetInspection, bool), Failure> {
    if path == "-" {
        return Err(Failure {
            code: "io".to_owned(),
            message: "protocol inspection does not support stdin asset input".to_owned(),
            retry_safe: false,
        });
    }
    let bytes = fs::read(path).map_err(|error| Failure {
        code: "io".to_owned(),
        message: format!("could not read asset {path}: {error}"),
        retry_safe: true,
    })?;
    let (inspection, partial) = inspect_bytes(path, &bytes)?;
    check_result_limit(
        &ResultFrame::Inspect {
            inspection: inspection.clone(),
        },
        maximum_output_bytes,
    )?;
    Ok((inspection, partial))
}

fn inspect_bytes(path: &str, bytes: &[u8]) -> Result<(SavedAssetInspection, bool), Failure> {
    let output = inspect_package_bytes(path, bytes).map_err(|error| Failure {
        code: error.kind.to_owned(),
        message: error.message,
        retry_safe: false,
    })?;
    let partial = output.status == "partial";
    let inspection =
        crate::protocol_adapter::adapt_inspection(output).map_err(|message| Failure {
            code: "contract".to_owned(),
            message,
            retry_safe: false,
        })?;
    Ok((inspection, partial))
}

fn check_result_limit(result: &ResultFrame, maximum_output_bytes: usize) -> Result<(), Failure> {
    let bytes = serde_json::to_vec(result).map_err(|error| Failure {
        code: "contract".to_owned(),
        message: format!("result could not be serialized: {error}"),
        retry_safe: false,
    })?;
    if bytes.len() > maximum_output_bytes {
        return Err(Failure {
            code: "output_limit".to_owned(),
            message: "result exceeded the configured output limit".to_owned(),
            retry_safe: false,
        });
    }
    Ok(())
}

pub(crate) fn supports_full_scan(request: &Request) -> bool {
    let Operation::Scan {
        cache_path,
        depth,
        filters,
        inventory,
        ..
    } = &request.operation
    else {
        return false;
    };
    *depth == ScanDepth::Full
        && cache_path.is_none()
        && !inventory.unwrap_or(false)
        && filters.classes.as_deref().unwrap_or_default().is_empty()
        && filters
            .class_prefixes
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        && filters
            .class_name_suffixes
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        && filters.names.as_deref().unwrap_or_default().is_empty()
}

/// Runs the common unfiltered full scan in this process. Header filters, caches, inventories, and
/// compact projections still use the compatibility path until their typed executors are extracted.
pub(crate) fn scan(request: &Request) -> Result<ScanOutput, Failure> {
    let Operation::Scan {
        selection,
        depth: ScanDepth::Full,
        ..
    } = &request.operation
    else {
        return Err(Failure {
            code: "unsupported".to_owned(),
            message: "direct executor only supports unfiltered full scans".to_owned(),
            retry_safe: false,
        });
    };
    let roots = resolve_roots(&selection.project_root, selection.paths.as_deref())?;
    let mut paths = Vec::new();
    for root in &roots {
        if root.is_file() {
            paths.push(root.clone());
        } else {
            discover_packages(root, &mut paths).map_err(|error| Failure {
                code: "discovery".to_owned(),
                message: format!("could not enumerate {}: {error}", root.display()),
                retry_safe: true,
            })?;
        }
    }
    paths.sort();
    paths.dedup();
    if let Some(maximum_assets) = request.limits.maximum_assets {
        if paths.len() as u64 > maximum_assets {
            return Err(Failure {
                code: "resource_limit".to_owned(),
                message: format!(
                    "Scan found {} packages, above the limit of {maximum_assets}.",
                    paths.len()
                ),
                retry_safe: false,
            });
        }
    }

    let maximum_output_bytes = request
        .limits
        .maximum_output_bytes
        .unwrap_or(64 * 1024 * 1024) as usize;
    let entries = Mutex::new(Vec::with_capacity(paths.len()));
    let diagnostics = Mutex::new(Vec::new());
    let next_path = AtomicUsize::new(0);
    let failed_assets = AtomicU64::new(0);
    let partial_assets = AtomicU64::new(0);
    let fatal = Mutex::new(None);
    let worker_count = request.limits.concurrency.unwrap_or(4).max(1) as usize;
    let scanned_assets = paths.len() as u64;
    let paths = &paths;
    let next_path_ref = &next_path;
    let failed_assets_ref = &failed_assets;
    let partial_assets_ref = &partial_assets;
    std::thread::scope(|scope| {
        for _ in 0..worker_count.min(paths.len().max(1)) {
            let entries = &entries;
            let diagnostics = &diagnostics;
            let fatal = &fatal;
            let next_path = next_path_ref;
            let failed_assets = failed_assets_ref;
            let partial_assets = partial_assets_ref;
            scope.spawn(move || {
                loop {
                    let index = next_path.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(index) else {
                        break;
                    };
                    let path_string = path.to_string_lossy().into_owned();
                    match fs::read(path).map_err(|error| Failure {
                        code: "asset_io".to_owned(),
                        message: format!("could not read asset {path_string}: {error}"),
                        retry_safe: true,
                    }) {
                        Ok(bytes) => match inspect_bytes(&path_string, &bytes) {
                            Ok((inspection, asset_partial)) => {
                                if asset_partial {
                                    partial_assets.fetch_add(1, Ordering::Relaxed);
                                }
                                let entry = SavedAssetScanEntry::Full {
                                    file_bytes: bytes.len() as u64,
                                    inspection,
                                };
                                let result = ResultFrame::ScanAsset {
                                    entry: entry.clone(),
                                };
                                if let Err(error) =
                                    check_result_limit(&result, maximum_output_bytes)
                                {
                                    let mut guard = fatal
                                        .lock()
                                        .expect("direct scan fatal state must not be poisoned");
                                    if guard.is_none() {
                                        *guard = Some(error);
                                    }
                                } else {
                                    entries
                                        .lock()
                                        .expect("direct scan entries must not be poisoned")
                                        .push(entry);
                                }
                            }
                            Err(error)
                                if error.code == "output_limit" || error.code == "contract" =>
                            {
                                let mut guard = fatal
                                    .lock()
                                    .expect("direct scan fatal state must not be poisoned");
                                if guard.is_none() {
                                    *guard = Some(error);
                                }
                            }
                            Err(error) => {
                                failed_assets.fetch_add(1, Ordering::Relaxed);
                                let code = scan_failure_code(&error.code);
                                diagnostics
                                    .lock()
                                    .expect("direct scan diagnostics must not be poisoned")
                                    .push(scan_diagnostic(
                                        &code,
                                        format!("could not inspect asset ({code})"),
                                        &path_string,
                                    ));
                            }
                        },
                        Err(error) => {
                            failed_assets.fetch_add(1, Ordering::Relaxed);
                            let code = scan_failure_code(&error.code);
                            diagnostics
                                .lock()
                                .expect("direct scan diagnostics must not be poisoned")
                                .push(scan_diagnostic(
                                    &code,
                                    format!("could not inspect asset ({code})"),
                                    &path_string,
                                ));
                        }
                    }
                }
            });
        }
    });
    if let Some(error) = fatal
        .into_inner()
        .expect("direct scan fatal state must not be poisoned")
    {
        return Err(error);
    }
    let mut entries = entries
        .into_inner()
        .expect("direct scan entries must not be poisoned");
    entries.sort_by(|left, right| {
        let left_path = match left {
            SavedAssetScanEntry::Full { inspection, .. } => inspection.path.as_str(),
            SavedAssetScanEntry::Header { .. } => "",
        };
        let right_path = match right {
            SavedAssetScanEntry::Full { inspection, .. } => inspection.path.as_str(),
            SavedAssetScanEntry::Header { .. } => "",
        };
        left_path.cmp(right_path)
    });
    let diagnostics = diagnostics
        .into_inner()
        .expect("direct scan diagnostics must not be poisoned");
    let failed_assets = failed_assets.load(Ordering::Relaxed);
    let partial_assets = partial_assets.load(Ordering::Relaxed);
    let partial = failed_assets > 0 || partial_assets > 0;
    let summary_diagnostics = diagnostics
        .iter()
        .map(|diagnostic| SavedAssetScanDiagnostic {
            code: diagnostic.code.clone(),
            message: diagnostic.message.clone(),
            path: diagnostic.path.clone(),
            retry_safe: diagnostic.retry_safe,
        })
        .collect();
    let summary = SavedAssetScanSummary {
        cache_hits: 0,
        depth: ScanSummaryDepth::Full,
        diagnostics: summary_diagnostics,
        emitted_assets: entries.len() as u64,
        failed_assets,
        inventory_complete: None,
        inventory_files: None,
        partial_assets,
        project_root: selection.project_root.clone(),
        roots: roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect(),
        scanned_assets,
        schema_version: 8,
        skipped_assets: 0,
    };
    check_result_limit(
        &ResultFrame::ScanSummary {
            summary: summary.clone(),
        },
        maximum_output_bytes,
    )?;
    Ok(ScanOutput {
        entries,
        summary,
        diagnostics,
        partial,
    })
}

fn scan_failure_code(code: &str) -> String {
    match code {
        "malformed_data" => "asset_malformed_data".to_owned(),
        "resource_limit" => "asset_resource_limit".to_owned(),
        "unsupported_format" => "asset_unsupported_format".to_owned(),
        "unsupported_version" => "asset_unsupported_version".to_owned(),
        "unsupported_capability" => "asset_unsupported_capability".to_owned(),
        code => code.to_owned(),
    }
}

fn scan_diagnostic(code: &str, message: String, path: &str) -> Diagnostic {
    Diagnostic {
        code: code.to_owned(),
        message,
        path: path.to_owned(),
        retry_safe: matches!(code, "asset_io" | "scan_cache_write"),
    }
}

fn resolve_roots(
    project_root: &str,
    requested: Option<&[String]>,
) -> Result<Vec<PathBuf>, Failure> {
    let project_root = PathBuf::from(project_root);
    let Some(requested) = requested else {
        return Ok(vec![project_root.join("Content")]);
    };
    let canonical_project_root = fs::canonicalize(&project_root).map_err(|error| Failure {
        code: "discovery".to_owned(),
        message: format!(
            "scan requires a readable project root {}: {error}",
            project_root.display()
        ),
        retry_safe: true,
    })?;
    let mut roots = Vec::with_capacity(requested.len());
    for requested in requested {
        let path = PathBuf::from(requested);
        let joined = if path.is_absolute() {
            path
        } else {
            project_root.join(path)
        };
        let canonical = fs::canonicalize(&joined).map_err(|error| Failure {
            code: "discovery".to_owned(),
            message: format!("--path {} is not readable: {error}", joined.display()),
            retry_safe: true,
        })?;
        if !canonical.starts_with(&canonical_project_root) {
            return Err(Failure {
                code: "invalid_request".to_owned(),
                message: format!("--path {} is outside the project root", joined.display()),
                retry_safe: false,
            });
        }
        if canonical.is_file() && !is_package_path(&canonical) {
            return Err(Failure {
                code: "invalid_request".to_owned(),
                message: format!("--path {} is not a .uasset or .umap file", joined.display()),
                retry_safe: false,
            });
        }
        roots.push(joined);
    }
    Ok(roots)
}

fn discover_packages(directory: &Path, found: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            discover_packages(&path, found)?;
        } else if entry.file_type()?.is_file() && is_package_path(&path) {
            found.push(path);
        }
    }
    Ok(())
}

fn is_package_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("uasset") || extension.eq_ignore_ascii_case("umap")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> String {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset")
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn inspect_decodes_the_versioned_result_without_a_worker() {
        let (inspection, partial) = inspect(&fixture(), 64 * 1024 * 1024).expect("inspection");

        assert!(!partial);
        assert_eq!(inspection.schema_version, 8);
        assert!(!inspection.assets.is_empty());
    }

    #[test]
    fn inspect_applies_the_protocol_output_limit() {
        let error = inspect(&fixture(), 1).expect_err("result should exceed the limit");

        assert_eq!(error.code, "output_limit");
    }

    #[test]
    fn full_scan_uses_the_typed_inspection_projection() {
        let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/unreal-project");
        let request: Request = serde_json::from_value(json!({
            "contract": { "name": "uasset-io", "version": { "major": 1, "minor": 0 } },
            "limits": { "concurrency": 1, "maximumOutputBytes": 67108864 },
            "operation": {
                "kind": "scan",
                "depth": "full",
                "projectRoot": project_root.to_string_lossy(),
                "paths": ["Content/Fixture/Text"]
            },
            "requestId": "direct-scan-test"
        }))
        .expect("scan request decodes");

        let output = scan(&request).expect("typed scan succeeds");
        assert!(!output.partial);
        assert!(!output.entries.is_empty());
        assert!(output.entries.iter().all(|entry| matches!(
            entry,
            SavedAssetScanEntry::Full { inspection, .. } if inspection.schema_version == 8
        )));
    }
}
