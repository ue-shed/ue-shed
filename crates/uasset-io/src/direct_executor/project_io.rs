use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use uasset_inspection::projection::{
    Evidence, EvidenceSource, EvidenceUnavailableReason, TextAssetProjection, TextEditCapability,
    TextIdentity, TextIdentityReason, TextLocation, TextureRecord, project_text_asset,
    project_texture_asset,
};
use uasset_inspection::saved_world::{
    SavedWorldActorPosition, SavedWorldPackageFragment, SavedWorldPosition,
    project_saved_world_package, resolve_saved_world_positions,
};
use uasset_parser::PackageSummary;
use uasset_parser::asset::{AssetDecodeContext, AssetErrorKind, decode_export};
use uasset_parser::package::{Package, PackageError, PackageErrorKind};
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};

use super::{
    Diagnostic, Failure, ProjectionOutput, SavedWorldOutput, ScanOutput, checkpoint,
    scan_diagnostic, scan_failure_code, summary_diagnostics,
};
use crate::cancellation::CancellationToken;
use crate::protocol::{Operation, ProjectSelection, Request, ScanDepth, ScanFilters};
use crate::protocol_result::{
    Completeness, EditCapability, ManifestEntryKind, ProjectionStatus, ResultFrame,
    SavedAssetHeader, SavedAssetHeaderExport, SavedAssetHeaderPackage, SavedAssetManifestEntry,
    SavedAssetProjectionDiagnostic, SavedAssetScanEntry, SavedAssetScanSummary,
    SavedAssetTextCoverageGap, SavedAssetTextExtractionEvent, SavedAssetTextOccurrence,
    SavedAssetTextureExtractionEvent, SavedAssetTextureRecord, SavedWorld, SavedWorldActor,
    SavedWorldAuthority, SavedWorldContract, SavedWorldContractName, SavedWorldContractVersion,
    SavedWorldDiagnostic, SavedWorldPosition as WireWorldPosition, SavedWorldSourceKind,
    SavedWorldSummary, SavedWorldVector, ScanSummaryDepth, TextCoverageGapReason,
    TextExtractionIdentity, TextExtractionLocation, TextUnresolvedReason, TextureDimensions,
    TextureEvidence, TextureEvidenceSource, TextureUnavailableReason,
};

const SCHEMA_VERSION: u8 = 8;
const SCAN_CACHE_VERSION: u32 = 2;
const HEADER_PROBE_BYTES: usize = 4 * 1024;
const MAX_SUMMARY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_SAVED_WORLD_MAXIMUM_ASSETS: u64 = 100_000;

const PACKAGE_EXTENSIONS: &[&str] = &["uasset", "umap"];
const SIDECAR_EXTENSIONS: &[&str] = &["uexp", "ubulk", "uptnl"];

#[derive(Clone)]
struct AssetSignature {
    modified_nanos: u64,
    path: PathBuf,
    size: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct ScanHeaderExport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    class_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    class_path: Option<String>,
    object_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct ScanHeaderCacheEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    exports: Vec<ScanHeaderExport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    matched_names: Vec<String>,
    matched: bool,
    modified_nanos: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    package_name: String,
    path: String,
    size: u64,
}

#[derive(Deserialize, Serialize)]
struct ScanHeaderCache {
    entries: Vec<ScanHeaderCacheEntry>,
    filters: String,
    schema_version: u8,
    version: u32,
}

struct ScanWorkResult {
    entry: Option<SavedAssetScanEntry>,
    diagnostic: Option<Diagnostic>,
    cache_entry: Option<ScanHeaderCacheEntry>,
    cache_hit: bool,
    failed: bool,
    partial: bool,
    skipped: bool,
}

struct ProjectionWorkResult {
    results: Vec<ResultFrame>,
    diagnostic: Option<Diagnostic>,
    failed: bool,
    partial: bool,
    skipped: bool,
}

pub(crate) fn scan(request: &Request) -> Result<ScanOutput, Failure> {
    scan_with_cancellation(request, &CancellationToken::new())
}

pub(crate) fn scan_with_cancellation(
    request: &Request,
    cancellation: &CancellationToken,
) -> Result<ScanOutput, Failure> {
    let Operation::Scan {
        cache_path,
        depth,
        selection,
        filters,
        inventory,
    } = &request.operation
    else {
        return Err(Failure {
            code: "unsupported".to_owned(),
            message: "direct executor expected a scan operation".to_owned(),
            retry_safe: false,
        });
    };
    if cache_path.is_some() && *depth == ScanDepth::Full {
        return Err(Failure {
            code: "invalid_request".to_owned(),
            message: "scan cache requires header depth".to_owned(),
            retry_safe: false,
        });
    }
    checkpoint(cancellation, "discovery")?;
    let roots = resolve_roots(selection, cancellation)?;
    let (asset_paths, sidecar_paths) =
        discover_paths(&roots, inventory.unwrap_or(false), cancellation)?;
    checkpoint(cancellation, "discovery")?;
    enforce_maximum_assets(request, asset_paths.len())?;
    let inventory_requested = inventory.unwrap_or(false);
    let mut diagnostics = Vec::new();
    let mut inventory_entries = Vec::new();
    let mut inventory_complete = true;
    let asset_signatures =
        if inventory_requested {
            for path in &sidecar_paths {
                match read_asset_signature_with_cancellation(path, cancellation)? {
                    Some(signature) => inventory_entries
                        .push(manifest_entry(&signature, ManifestEntryKind::Sidecar)),
                    None => record_inventory_metadata_failure(
                        path,
                        &mut inventory_complete,
                        &mut diagnostics,
                    ),
                }
            }
            let mut signatures = Vec::with_capacity(asset_paths.len());
            for path in &asset_paths {
                let signature = read_asset_signature_with_cancellation(path, cancellation)?;
                match &signature {
                    Some(signature) => inventory_entries
                        .push(manifest_entry(signature, ManifestEntryKind::Package)),
                    None => record_inventory_metadata_failure(
                        path,
                        &mut inventory_complete,
                        &mut diagnostics,
                    ),
                }
                signatures.push(signature);
            }
            inventory_entries.sort_by(|left, right| left.path.cmp(&right.path));
            checkpoint(cancellation, "read")?;
            Some(signatures)
        } else {
            None
        };

    checkpoint(cancellation, "read")?;
    let cached_entries = load_scan_header_cache(cache_path.as_deref(), filters);
    let cache_was_loaded = cached_entries.is_some();
    let cached_entry_count = cached_entries.as_ref().map_or(0, Vec::len);
    let cached_by_path = cached_entries
        .unwrap_or_default()
        .into_iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    checkpoint(cancellation, "read")?;
    let collect_headers = cache_path.is_some() && *depth == ScanDepth::Header;
    let next_path = AtomicUsize::new(0);
    let worker_count = request.limits.concurrency.unwrap_or(4).max(1) as usize;
    let slots = Mutex::new(
        (0..asset_paths.len())
            .map(|_| None::<Result<ScanWorkResult, Failure>>)
            .collect::<Vec<_>>(),
    );
    let paths = &asset_paths;
    let signatures = asset_signatures.as_deref();
    std::thread::scope(|scope| {
        for _ in 0..worker_count.min(asset_paths.len().max(1)) {
            let next_path = &next_path;
            let slots = &slots;
            let cached_by_path = &cached_by_path;
            let cancellation = cancellation.clone();
            scope.spawn(move || {
                loop {
                    if checkpoint(&cancellation, "discovery").is_err() {
                        break;
                    }
                    let index = next_path.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(index) else {
                        break;
                    };
                    let signature = match signatures {
                        Some(signatures) => signatures[index].clone(),
                        None => match read_asset_signature_with_cancellation(path, &cancellation) {
                            Ok(signature) => signature,
                            Err(error) => {
                                slots
                                    .lock()
                                    .expect("direct scan slots must not be poisoned")[index] =
                                    Some(Err(error));
                                continue;
                            }
                        },
                    };
                    let result = scan_one_path_with_cancellation(
                        path,
                        signature,
                        depth.clone(),
                        filters,
                        cached_by_path,
                        collect_headers,
                        &cancellation,
                    );
                    slots
                        .lock()
                        .expect("direct scan slots must not be poisoned")[index] = Some(result);
                }
            });
        }
    });

    let mut entries = Vec::new();
    let mut cache_entries = Vec::new();
    let mut cache_hits = 0_u64;
    let mut failed_assets = 0_u64;
    let mut partial_assets = 0_u64;
    let mut skipped_assets = 0_u64;
    let results = slots
        .into_inner()
        .expect("direct scan slots must not be poisoned");
    for result in results.into_iter().flatten() {
        let result = result?;
        checkpoint(cancellation, "inspection")?;
        if result.cache_hit {
            cache_hits += 1;
        }
        if result.failed {
            failed_assets += 1;
        }
        if result.partial {
            partial_assets += 1;
        }
        if result.skipped {
            skipped_assets += 1;
        }
        if let Some(diagnostic) = result.diagnostic {
            diagnostics.push(diagnostic);
        }
        if let Some(entry) = result.entry {
            entries.push(entry);
        }
        if let Some(cache_entry) = result.cache_entry {
            cache_entries.push(cache_entry);
        }
    }

    if collect_headers
        && scan_header_cache_needs_write(
            cache_was_loaded,
            cached_entry_count,
            cached_by_path.len(),
            asset_paths.len(),
            cache_hits,
        )
    {
        checkpoint(cancellation, "emitting")?;
        cache_entries.sort_by(|left, right| left.path.cmp(&right.path));
        if let Err(error) = save_scan_header_cache(cache_path.as_deref(), filters, cache_entries) {
            diagnostics.push(scan_diagnostic(
                "scan_cache_write",
                format!("could not write scan cache: {error}"),
                cache_path.as_deref().unwrap_or_default(),
            ));
        }
        checkpoint(cancellation, "emitting")?;
    }

    let depth = match depth {
        ScanDepth::Header => ScanSummaryDepth::Header,
        ScanDepth::Full => ScanSummaryDepth::Full,
    };
    let summary = SavedAssetScanSummary {
        cache_hits,
        depth,
        diagnostics: summary_diagnostics(&diagnostics),
        emitted_assets: entries.len() as u64,
        failed_assets,
        inventory_complete: Some(inventory_complete),
        inventory_files: Some(if inventory_requested {
            inventory_entries.len() as u64
        } else {
            0
        }),
        partial_assets,
        project_root: selection.project_root.clone(),
        roots: roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect(),
        scanned_assets: asset_paths.len() as u64,
        schema_version: SCHEMA_VERSION,
        skipped_assets,
    };
    let partial = failed_assets > 0
        || partial_assets > 0
        || !inventory_complete
        || diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "scan_cache_write");
    checkpoint(cancellation, "inspection")?;
    Ok(ScanOutput {
        entries,
        inventory: inventory_entries,
        summary,
        diagnostics,
        partial,
    })
}

fn scan_one_path_with_cancellation(
    path: &Path,
    signature: Option<AssetSignature>,
    depth: ScanDepth,
    filters: &ScanFilters,
    cached_by_path: &BTreeMap<String, ScanHeaderCacheEntry>,
    collect_headers: bool,
    cancellation: &CancellationToken,
) -> Result<ScanWorkResult, Failure> {
    checkpoint(cancellation, "read")?;
    let Some(signature) = signature else {
        return Ok(ScanWorkResult {
            entry: None,
            diagnostic: Some(scan_diagnostic(
                "asset_io",
                format!("could not read asset {}", path.display()),
                &path.to_string_lossy(),
            )),
            cache_entry: None,
            cache_hit: false,
            failed: true,
            partial: false,
            skipped: false,
        });
    };
    match depth {
        ScanDepth::Header => {
            let key = signature.path.to_string_lossy().into_owned();
            let (entry, cache_hit) = match cached_by_path.get(&key) {
                Some(entry) if scan_header_entry_matches(entry, &signature) => {
                    (entry.clone(), true)
                }
                _ => (read_scan_header(&signature, filters, cancellation)?, false),
            };
            if let Some(code) = &entry.failure_code {
                return Ok(ScanWorkResult {
                    entry: None,
                    diagnostic: Some(scan_diagnostic(
                        code,
                        format!("could not inspect asset ({code})"),
                        &key,
                    )),
                    cache_entry: collect_headers.then_some(entry),
                    cache_hit,
                    failed: true,
                    partial: false,
                    skipped: false,
                });
            }
            if !entry.matched {
                return Ok(ScanWorkResult {
                    entry: None,
                    diagnostic: None,
                    cache_entry: collect_headers.then_some(entry),
                    cache_hit,
                    failed: false,
                    partial: false,
                    skipped: true,
                });
            }
            let header = header_result(&entry);
            Ok(ScanWorkResult {
                entry: Some(SavedAssetScanEntry::Header {
                    file_bytes: signature.size,
                    header,
                }),
                diagnostic: None,
                cache_entry: collect_headers.then_some(entry),
                cache_hit,
                failed: false,
                partial: false,
                skipped: false,
            })
        }
        ScanDepth::Full => {
            if !filters_empty(filters) {
                match read_package_header(&signature, cancellation) {
                    Ok(package) => {
                        checkpoint(cancellation, "inspection")?;
                        if !package_matches(&package, filters) {
                            return Ok(ScanWorkResult {
                                entry: None,
                                diagnostic: None,
                                cache_entry: None,
                                cache_hit: false,
                                failed: false,
                                partial: false,
                                skipped: true,
                            });
                        }
                        checkpoint(cancellation, "inspection")?;
                    }
                    Err(error) if error.code == "cancelled" => return Err(error),
                    Err(error) => {
                        return Ok(ScanWorkResult {
                            entry: None,
                            diagnostic: Some(scan_diagnostic(
                                &error.code,
                                format!("could not inspect asset ({})", error.code),
                                &signature.path.to_string_lossy(),
                            )),
                            cache_entry: None,
                            cache_hit: false,
                            failed: true,
                            partial: false,
                            skipped: false,
                        });
                    }
                }
            }
            let path_string = signature.path.to_string_lossy().into_owned();
            checkpoint(cancellation, "read")?;
            let bytes = match fs::read(path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    return Ok(ScanWorkResult {
                        entry: None,
                        diagnostic: Some(scan_diagnostic(
                            "asset_io",
                            format!("could not read asset {path_string}: {error}"),
                            &path_string,
                        )),
                        cache_entry: None,
                        cache_hit: false,
                        failed: true,
                        partial: false,
                        skipped: false,
                    });
                }
            };
            checkpoint(cancellation, "read")?;
            match super::inspect_bytes_with_cancellation(&path_string, &bytes, cancellation) {
                Ok((inspection, partial)) => Ok(ScanWorkResult {
                    entry: Some(SavedAssetScanEntry::Full {
                        file_bytes: bytes.len() as u64,
                        inspection,
                    }),
                    diagnostic: None,
                    cache_entry: None,
                    cache_hit: false,
                    failed: false,
                    partial,
                    skipped: false,
                }),
                Err(error) if error.code == "cancelled" => Err(error),
                Err(error) => Ok(ScanWorkResult {
                    entry: None,
                    diagnostic: Some(scan_diagnostic(
                        &scan_failure_code(&error.code),
                        format!(
                            "could not inspect asset ({})",
                            scan_failure_code(&error.code)
                        ),
                        &path_string,
                    )),
                    cache_entry: None,
                    cache_hit: false,
                    failed: true,
                    partial: false,
                    skipped: false,
                }),
            }
        }
    }
}

pub(crate) fn extract_text(request: &Request) -> Result<ProjectionOutput, Failure> {
    extract_text_with_cancellation(request, &CancellationToken::new())
}

pub(crate) fn extract_text_with_cancellation(
    request: &Request,
    cancellation: &CancellationToken,
) -> Result<ProjectionOutput, Failure> {
    projection(request, ProjectionKind::Text, cancellation)
}

pub(crate) fn extract_texture(request: &Request) -> Result<ProjectionOutput, Failure> {
    extract_texture_with_cancellation(request, &CancellationToken::new())
}

pub(crate) fn extract_texture_with_cancellation(
    request: &Request,
    cancellation: &CancellationToken,
) -> Result<ProjectionOutput, Failure> {
    projection(request, ProjectionKind::Texture, cancellation)
}

#[derive(Clone, Copy)]
enum ProjectionKind {
    Text,
    Texture,
}

fn projection(
    request: &Request,
    kind: ProjectionKind,
    cancellation: &CancellationToken,
) -> Result<ProjectionOutput, Failure> {
    let selection = match (&request.operation, kind) {
        (Operation::ExtractText { selection }, ProjectionKind::Text)
        | (Operation::ExtractTexture { selection }, ProjectionKind::Texture) => selection,
        _ => {
            return Err(Failure {
                code: "unsupported".to_owned(),
                message: "direct executor expected a compact extraction operation".to_owned(),
                retry_safe: false,
            });
        }
    };
    checkpoint(cancellation, "discovery")?;
    let roots = resolve_roots(selection, cancellation)?;
    let (paths, _) = discover_paths(&roots, false, cancellation)?;
    checkpoint(cancellation, "discovery")?;
    enforce_maximum_assets(request, paths.len())?;
    let filters = projection_filters(kind, selection.paths.is_none());
    let next_path = AtomicUsize::new(0);
    let worker_count = request.limits.concurrency.unwrap_or(4).max(1) as usize;
    let slots = Mutex::new(
        (0..paths.len())
            .map(|_| None::<Result<ProjectionWorkResult, Failure>>)
            .collect::<Vec<_>>(),
    );
    let path_refs = &paths;
    std::thread::scope(|scope| {
        for _ in 0..worker_count.min(paths.len().max(1)) {
            let next_path = &next_path;
            let slots = &slots;
            let filters = &filters;
            let cancellation = cancellation.clone();
            scope.spawn(move || {
                loop {
                    if checkpoint(&cancellation, "discovery").is_err() {
                        break;
                    }
                    let index = next_path.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = path_refs.get(index) else {
                        break;
                    };
                    let result = project_one_path(path, kind, filters, &cancellation);
                    slots
                        .lock()
                        .expect("direct projection slots must not be poisoned")[index] =
                        Some(result);
                }
            });
        }
    });

    let mut results = Vec::new();
    let mut diagnostics = Vec::new();
    let mut emitted_assets = 0_u64;
    let mut failed_assets = 0_u64;
    let mut partial_assets = 0_u64;
    let mut skipped_assets = 0_u64;
    for result in slots
        .into_inner()
        .expect("direct projection slots must not be poisoned")
        .into_iter()
        .flatten()
    {
        let result = result?;
        checkpoint(cancellation, "inspection")?;
        if result.diagnostic.is_some() {
            failed_assets += u64::from(result.failed);
        }
        if result.partial {
            partial_assets += 1;
        }
        if result.skipped {
            skipped_assets += 1;
        }
        if result.diagnostic.is_some() {
            diagnostics.extend(result.diagnostic);
        } else if !result.results.is_empty() {
            emitted_assets += 1;
        }
        results.extend(result.results);
    }
    let depth = match kind {
        ProjectionKind::Text => ScanSummaryDepth::Text,
        ProjectionKind::Texture => ScanSummaryDepth::Texture,
    };
    let summary = SavedAssetScanSummary {
        cache_hits: 0,
        depth,
        diagnostics: summary_diagnostics(&diagnostics),
        emitted_assets,
        failed_assets,
        inventory_complete: Some(false),
        inventory_files: Some(0),
        partial_assets,
        project_root: selection.project_root.clone(),
        roots: roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect(),
        scanned_assets: paths.len() as u64,
        schema_version: SCHEMA_VERSION,
        skipped_assets,
    };
    let summary_result = match kind {
        ProjectionKind::Text => ResultFrame::ExtractText {
            event: SavedAssetTextExtractionEvent::TextSummary {
                summary: summary.clone(),
            },
        },
        ProjectionKind::Texture => ResultFrame::ExtractTexture {
            event: SavedAssetTextureExtractionEvent::TextureSummary {
                summary: summary.clone(),
            },
        },
    };
    results.push(summary_result);
    checkpoint(cancellation, "inspection")?;
    let partial = failed_assets > 0 || partial_assets > 0;
    Ok(ProjectionOutput {
        results,
        summary,
        diagnostics,
        partial,
    })
}

fn project_one_path(
    path: &Path,
    kind: ProjectionKind,
    filters: &ScanFilters,
    cancellation: &CancellationToken,
) -> Result<ProjectionWorkResult, Failure> {
    let path_string = path.to_string_lossy().into_owned();
    checkpoint(cancellation, "read")?;
    if !filters_empty(filters) {
        let Some(signature) = read_asset_signature_with_cancellation(path, cancellation)? else {
            return Ok(ProjectionWorkResult {
                results: Vec::new(),
                diagnostic: Some(scan_diagnostic(
                    "asset_io",
                    format!("could not read asset {path_string}"),
                    &path_string,
                )),
                failed: true,
                partial: false,
                skipped: false,
            });
        };
        match read_package_header(&signature, cancellation) {
            Ok(package) => {
                checkpoint(cancellation, "inspection")?;
                if !package_matches(&package, filters) {
                    return Ok(ProjectionWorkResult {
                        results: Vec::new(),
                        diagnostic: None,
                        failed: false,
                        partial: false,
                        skipped: true,
                    });
                }
                checkpoint(cancellation, "inspection")?;
            }
            Err(error) if error.code == "cancelled" => return Err(error),
            Err(error) => {
                return Ok(ProjectionWorkResult {
                    results: Vec::new(),
                    diagnostic: Some(scan_diagnostic(
                        &error.code,
                        format!("could not inspect asset ({})", error.code),
                        &path_string,
                    )),
                    failed: true,
                    partial: false,
                    skipped: false,
                });
            }
        }
    }
    checkpoint(cancellation, "read")?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Ok(ProjectionWorkResult {
                results: Vec::new(),
                diagnostic: Some(scan_diagnostic(
                    "asset_io",
                    format!("could not read asset {path_string}: {error}"),
                    &path_string,
                )),
                failed: true,
                partial: false,
                skipped: false,
            });
        }
    };
    checkpoint(cancellation, "read")?;
    checkpoint(cancellation, "parsing")?;
    let package = match Package::parse(&bytes) {
        Ok(package) => package,
        Err(error) => {
            let code = package_error_code(&error);
            return Ok(ProjectionWorkResult {
                results: Vec::new(),
                diagnostic: Some(scan_diagnostic(
                    code,
                    format!("could not inspect asset ({code})"),
                    &path_string,
                )),
                failed: true,
                partial: false,
                skipped: false,
            });
        }
    };
    checkpoint(cancellation, "parsing")?;
    checkpoint(cancellation, "inspection")?;
    let schemas = EmptySchemas;
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: &schemas,
    };
    let mut results = Vec::new();
    let mut diagnostics = Vec::new();
    let mut occurrence_count = 0_u64;
    let mut coverage_gap_count = 0_u64;
    let mut texture_count = 0_u64;
    for export in &package.exports {
        checkpoint(cancellation, "parsing")?;
        if matches!(kind, ProjectionKind::Texture)
            && export.class_path.as_ref().is_none_or(|class_path| {
                class_path.as_str() != uasset_inspection::projection::TEXTURE2D_CLASS
            })
        {
            continue;
        }
        checkpoint(cancellation, "inspection")?;
        match decode_export(export, &context) {
            Ok(Some(asset)) => match kind {
                ProjectionKind::Text => {
                    let projection = project_text_asset(&package, &asset);
                    checkpoint(cancellation, "inspection")?;
                    occurrence_count += projection.occurrences.len() as u64;
                    coverage_gap_count += projection.coverage_gaps.len() as u64;
                    results.extend(text_results(&path_string, bytes.len() as u64, projection));
                }
                ProjectionKind::Texture => {
                    if let Some(record) =
                        project_texture_asset(&package, &asset, bytes.len() as u64)
                    {
                        checkpoint(cancellation, "inspection")?;
                        texture_count += 1;
                        results.push(texture_record_result(&path_string, record));
                    }
                }
            },
            Ok(None) => {}
            Err(error) => {
                diagnostics.push(projection_diagnostic(export, error.kind(), error.message()))
            }
        }
    }
    checkpoint(cancellation, "inspection")?;
    let partial = !diagnostics.is_empty();
    match kind {
        ProjectionKind::Text => results.push(ResultFrame::ExtractText {
            event: SavedAssetTextExtractionEvent::TextPackage {
                file_bytes: bytes.len() as u64,
                path: path_string,
                schema_version: 1,
                status: if partial {
                    ProjectionStatus::Partial
                } else {
                    ProjectionStatus::Complete
                },
                diagnostics,
                occurrences: occurrence_count,
                coverage_gaps: coverage_gap_count,
            },
        }),
        ProjectionKind::Texture => results.push(ResultFrame::ExtractTexture {
            event: SavedAssetTextureExtractionEvent::TexturePackage {
                file_bytes: bytes.len() as u64,
                path: path_string,
                schema_version: 1,
                status: if partial {
                    ProjectionStatus::Partial
                } else {
                    ProjectionStatus::Complete
                },
                diagnostics,
                records: texture_count,
            },
        }),
    }
    Ok(ProjectionWorkResult {
        results,
        diagnostic: None,
        failed: false,
        partial,
        skipped: false,
    })
}

fn text_results(path: &str, file_bytes: u64, projection: TextAssetProjection) -> Vec<ResultFrame> {
    let mut results = Vec::new();
    for occurrence in projection.occurrences {
        results.push(ResultFrame::ExtractText {
            event: SavedAssetTextExtractionEvent::TextOccurrence {
                schema_version: 1,
                path: path.to_owned(),
                file_bytes,
                occurrence: text_occurrence(occurrence),
            },
        });
    }
    for gap in projection.coverage_gaps {
        results.push(ResultFrame::ExtractText {
            event: SavedAssetTextExtractionEvent::TextCoverageGap {
                schema_version: 1,
                path: path.to_owned(),
                coverage_gap: SavedAssetTextCoverageGap {
                    object_path: gap.object_path,
                    property_path: gap.property_path,
                    reason: match gap.reason {
                        uasset_inspection::projection::TextCoverageGapReason::UnsupportedTextHistory => {
                            TextCoverageGapReason::UnsupportedTextHistory
                        }
                    },
                },
            },
        });
    }
    results
}

fn text_occurrence(
    occurrence: uasset_inspection::projection::TextOccurrence,
) -> SavedAssetTextOccurrence {
    SavedAssetTextOccurrence {
        source: occurrence.source,
        identity: match occurrence.identity {
            TextIdentity::Resolved { namespace, key } => {
                TextExtractionIdentity::Resolved { namespace, key }
            }
            TextIdentity::Unresolved { reason } => TextExtractionIdentity::Unresolved {
                reason: match reason {
                    TextIdentityReason::CultureInvariant => TextUnresolvedReason::CultureInvariant,
                    TextIdentityReason::MissingKey => TextUnresolvedReason::MissingKey,
                },
            },
        },
        location: match occurrence.location {
            TextLocation::DataTableCell {
                object_path,
                row,
                property_path,
            } => TextExtractionLocation::DataTableCell {
                object_path,
                row,
                property_path,
            },
            TextLocation::StringTableEntry {
                object_path,
                entry_key,
            } => TextExtractionLocation::StringTableEntry {
                object_path,
                entry_key,
            },
            TextLocation::AssetProperty {
                object_path,
                class_path,
                property_path,
            } => TextExtractionLocation::AssetProperty {
                object_path,
                class_path,
                property_path,
            },
        },
        edit_capability: match occurrence.edit_capability {
            TextEditCapability::SourceEditable => EditCapability::SourceEditable,
            TextEditCapability::ReadOnly => EditCapability::ReadOnly,
        },
    }
}

fn texture_record_result(path: &str, record: TextureRecord) -> ResultFrame {
    ResultFrame::ExtractTexture {
        event: SavedAssetTextureExtractionEvent::TextureRecord {
            schema_version: 1,
            path: path.to_owned(),
            record: texture_record(record),
        },
    }
}

fn texture_record(record: TextureRecord) -> SavedAssetTextureRecord {
    SavedAssetTextureRecord {
        object_path: record.object_path,
        package_file_bytes: texture_evidence(record.package_file_bytes),
        dimensions: texture_evidence(record.dimensions),
        source_format: texture_evidence(record.source_format),
        source_mips: texture_evidence(record.source_mips),
        compression: texture_evidence(record.compression),
        s_rgb: texture_evidence(record.s_rgb),
        texture_group: texture_evidence(record.texture_group),
        mip_generation: texture_evidence(record.mip_generation),
    }
}

fn texture_evidence<T>(value: Evidence<T>) -> TextureEvidence<T::Wire>
where
    T: TextureWire,
{
    match value {
        Evidence::Available { source, value } => TextureEvidence::Available {
            source: match source {
                EvidenceSource::Serialized => TextureEvidenceSource::Serialized,
                EvidenceSource::File => TextureEvidenceSource::File,
            },
            value: value.into_wire(),
        },
        Evidence::Unavailable { reason } => TextureEvidence::Unavailable {
            reason: match reason {
                EvidenceUnavailableReason::NotSerialized => TextureUnavailableReason::NotSerialized,
                EvidenceUnavailableReason::WrongValueKind => {
                    TextureUnavailableReason::WrongValueKind
                }
                EvidenceUnavailableReason::MissingSource => TextureUnavailableReason::MissingSource,
            },
        },
    }
}

trait TextureWire {
    type Wire;

    fn into_wire(self) -> Self::Wire;
}

impl TextureWire for u64 {
    type Wire = u64;

    fn into_wire(self) -> Self::Wire {
        self
    }
}

impl TextureWire for String {
    type Wire = String;

    fn into_wire(self) -> Self::Wire {
        self
    }
}

impl TextureWire for bool {
    type Wire = bool;

    fn into_wire(self) -> Self::Wire {
        self
    }
}

impl TextureWire for uasset_inspection::projection::TextureDimensions {
    type Wire = TextureDimensions;

    fn into_wire(self) -> Self::Wire {
        TextureDimensions {
            width: self.width,
            height: self.height,
        }
    }
}

fn projection_diagnostic(
    export: &uasset_parser::package::Export,
    kind: AssetErrorKind,
    message: &str,
) -> SavedAssetProjectionDiagnostic {
    SavedAssetProjectionDiagnostic {
        object_path: export.object_path.to_string(),
        class_path: export.class_path.as_ref().map(ToString::to_string),
        code: projection_error_kind(kind),
        message: message.to_owned(),
    }
}

fn projection_error_kind(
    kind: AssetErrorKind,
) -> crate::protocol_result::SavedAssetDecodeErrorKind {
    match kind {
        AssetErrorKind::MalformedData => {
            crate::protocol_result::SavedAssetDecodeErrorKind::MalformedData
        }
        AssetErrorKind::ResourceLimit => {
            crate::protocol_result::SavedAssetDecodeErrorKind::ResourceLimit
        }
        AssetErrorKind::UnsupportedFormat => {
            crate::protocol_result::SavedAssetDecodeErrorKind::UnsupportedFormat
        }
        AssetErrorKind::UnsupportedVersion => {
            crate::protocol_result::SavedAssetDecodeErrorKind::UnsupportedVersion
        }
        AssetErrorKind::UnsupportedCapability => {
            crate::protocol_result::SavedAssetDecodeErrorKind::UnsupportedCapability
        }
    }
}

fn projection_filters(kind: ProjectionKind, implicit_selection: bool) -> ScanFilters {
    if !implicit_selection {
        return ScanFilters {
            class_name_suffixes: None,
            class_prefixes: None,
            classes: None,
            names: None,
        };
    }
    match kind {
        ProjectionKind::Text => ScanFilters {
            class_name_suffixes: None,
            class_prefixes: None,
            classes: Some(vec!["/Script/Engine.StringTable".to_owned()]),
            names: Some(vec!["TextProperty".to_owned()]),
        },
        ProjectionKind::Texture => ScanFilters {
            class_name_suffixes: None,
            class_prefixes: None,
            classes: Some(vec![
                uasset_inspection::projection::TEXTURE2D_CLASS.to_owned(),
            ]),
            names: None,
        },
    }
}

fn filters_empty(filters: &ScanFilters) -> bool {
    filters.classes.as_deref().unwrap_or_default().is_empty()
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

fn package_matches(package: &Package, filters: &ScanFilters) -> bool {
    if filters_empty(filters) {
        return true;
    }
    let class_matched = package.exports.iter().any(|export| {
        export.class_path.as_ref().is_some_and(|class_path| {
            let class_path = class_path.to_string();
            filters
                .classes
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|filter| class_filter_matches(filter, &class_path))
                || filters
                    .class_prefixes
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .any(|prefix| class_path.starts_with(prefix))
                || filters
                    .class_name_suffixes
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .any(|suffix| class_name_suffix_matches(suffix, &class_path))
        })
    });
    class_matched
        || filters
            .names
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|name| package.names.iter().any(|entry| entry == name))
}

fn class_filter_matches(filter: &str, class_path: &str) -> bool {
    if filter.contains('/') {
        return filter == class_path;
    }
    class_path
        .rsplit_once('.')
        .is_some_and(|(_, name)| name == filter)
}

fn class_name_suffix_matches(suffix: &str, class_path: &str) -> bool {
    !suffix.is_empty()
        && class_path
            .rsplit_once('.')
            .is_some_and(|(_, name)| name.ends_with(suffix))
}

fn read_scan_header(
    signature: &AssetSignature,
    filters: &ScanFilters,
    cancellation: &CancellationToken,
) -> Result<ScanHeaderCacheEntry, Failure> {
    let path = signature.path.to_string_lossy().into_owned();
    let package = match read_package_header(signature, cancellation) {
        Ok(package) => package,
        Err(error) if error.code != "cancelled" => {
            return Ok(ScanHeaderCacheEntry {
                failure_code: Some(error.code),
                exports: Vec::new(),
                matched_names: Vec::new(),
                matched: false,
                modified_nanos: signature.modified_nanos,
                package_name: String::new(),
                path,
                size: signature.size,
            });
        }
        Err(error) => return Err(error),
    };
    checkpoint(cancellation, "inspection")?;
    let exports = package
        .exports
        .iter()
        .filter(|export| {
            filters_empty(filters)
                || export
                    .class_path
                    .as_ref()
                    .is_some_and(|class_path| class_matches(&class_path.to_string(), filters))
        })
        .map(|export| {
            let class_path = export.class_path.as_ref().map(ToString::to_string);
            ScanHeaderExport {
                class_name: class_path
                    .as_deref()
                    .and_then(|value| value.rsplit_once('.'))
                    .map(|(_, name)| name.to_owned()),
                class_path,
                object_path: export.object_path.to_string(),
            }
        })
        .collect::<Vec<_>>();
    let matched_names = filters
        .names
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|name| package.names.iter().any(|entry| entry == *name))
        .cloned()
        .collect::<Vec<_>>();
    checkpoint(cancellation, "inspection")?;
    Ok(ScanHeaderCacheEntry {
        failure_code: None,
        matched: filters_empty(filters) || !exports.is_empty() || !matched_names.is_empty(),
        exports,
        matched_names,
        modified_nanos: signature.modified_nanos,
        package_name: package.summary.package_name.clone(),
        path,
        size: signature.size,
    })
}

fn class_matches(class_path: &str, filters: &ScanFilters) -> bool {
    filters
        .classes
        .as_deref()
        .unwrap_or_default()
        .iter()
        .any(|filter| class_filter_matches(filter, class_path))
        || filters
            .class_prefixes
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|prefix| class_path.starts_with(prefix))
        || filters
            .class_name_suffixes
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|suffix| class_name_suffix_matches(suffix, class_path))
}

fn header_result(entry: &ScanHeaderCacheEntry) -> SavedAssetHeader {
    SavedAssetHeader {
        exports: entry
            .exports
            .iter()
            .map(|export| SavedAssetHeaderExport {
                class_name: export.class_name.clone(),
                class_path: export.class_path.clone(),
                object_path: export.object_path.clone(),
            })
            .collect(),
        matched_names: Some(entry.matched_names.clone()),
        package: SavedAssetHeaderPackage {
            name: entry.package_name.clone(),
        },
        path: entry.path.clone(),
        schema_version: SCHEMA_VERSION,
    }
}

fn filters_fingerprint(filters: &ScanFilters) -> String {
    let group = |values: &[String]| {
        let mut sorted = values.to_vec();
        sorted.sort();
        sorted.join(",")
    };
    format!(
        "classes={}|prefixes={}|suffixes={}|names={}",
        group(filters.classes.as_deref().unwrap_or_default()),
        group(filters.class_prefixes.as_deref().unwrap_or_default()),
        group(filters.class_name_suffixes.as_deref().unwrap_or_default()),
        group(filters.names.as_deref().unwrap_or_default())
    )
}

fn scan_header_entry_matches(entry: &ScanHeaderCacheEntry, signature: &AssetSignature) -> bool {
    entry.path == signature.path.to_string_lossy()
        && entry.size == signature.size
        && entry.modified_nanos == signature.modified_nanos
}

fn scan_header_cache_needs_write(
    cache_was_loaded: bool,
    cached_entry_count: usize,
    unique_cached_entry_count: usize,
    asset_count: usize,
    cache_hits: u64,
) -> bool {
    !cache_was_loaded
        || cached_entry_count != asset_count
        || unique_cached_entry_count != asset_count
        || cache_hits != asset_count as u64
}

fn load_scan_header_cache(
    path: Option<&str>,
    filters: &ScanFilters,
) -> Option<Vec<ScanHeaderCacheEntry>> {
    let path = path?;
    let cache = serde_json::from_slice::<ScanHeaderCache>(&fs::read(path).ok()?).ok()?;
    (cache.version == SCAN_CACHE_VERSION
        && cache.schema_version == SCHEMA_VERSION
        && cache.filters == filters_fingerprint(filters))
    .then_some(cache.entries)
}

fn save_scan_header_cache(
    path: Option<&str>,
    filters: &ScanFilters,
    entries: Vec<ScanHeaderCacheEntry>,
) -> io::Result<()> {
    let Some(path) = path else {
        return Ok(());
    };
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let rendered = serde_json::to_vec(&ScanHeaderCache {
        entries,
        filters: filters_fingerprint(filters),
        schema_version: SCHEMA_VERSION,
        version: SCAN_CACHE_VERSION,
    })
    .map_err(io::Error::other)?;
    fs::write(path, rendered)
}

fn resolve_roots(
    selection: &ProjectSelection,
    cancellation: &CancellationToken,
) -> Result<Vec<PathBuf>, Failure> {
    checkpoint(cancellation, "discovery")?;
    let project_root = PathBuf::from(&selection.project_root);
    let Some(requested) = &selection.paths else {
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
        checkpoint(cancellation, "discovery")?;
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
    checkpoint(cancellation, "discovery")?;
    Ok(roots)
}

fn discover_paths(
    roots: &[PathBuf],
    include_sidecars: bool,
    cancellation: &CancellationToken,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), Failure> {
    let mut packages = Vec::new();
    let mut sidecars = Vec::new();
    for root in roots {
        checkpoint(cancellation, "discovery")?;
        if root.is_file() {
            packages.push(root.clone());
            continue;
        }
        discover_scan_files(
            root,
            &mut packages,
            &mut sidecars,
            include_sidecars,
            cancellation,
        )?;
    }
    checkpoint(cancellation, "discovery")?;
    packages.sort();
    packages.dedup();
    sidecars.sort();
    sidecars.dedup();
    checkpoint(cancellation, "discovery")?;
    Ok((packages, sidecars))
}

fn enforce_maximum_assets(request: &Request, count: usize) -> Result<(), Failure> {
    if let Some(maximum_assets) = request.limits.maximum_assets
        && count as u64 > maximum_assets
    {
        return Err(Failure {
            code: "resource_limit".to_owned(),
            message: format!("Scan found {count} packages, above the limit of {maximum_assets}."),
            retry_safe: false,
        });
    }
    Ok(())
}

fn discover_scan_files(
    directory: &Path,
    packages: &mut Vec<PathBuf>,
    sidecars: &mut Vec<PathBuf>,
    include_sidecars: bool,
    cancellation: &CancellationToken,
) -> Result<(), Failure> {
    checkpoint(cancellation, "discovery")?;
    let mut entries = fs::read_dir(directory)
        .map_err(|error| Failure {
            code: "discovery".to_owned(),
            message: format!("could not enumerate {}: {error}", directory.display()),
            retry_safe: true,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| Failure {
            code: "discovery".to_owned(),
            message: format!("could not enumerate {}: {error}", directory.display()),
            retry_safe: true,
        })?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        checkpoint(cancellation, "discovery")?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| Failure {
            code: "discovery".to_owned(),
            message: format!("could not enumerate {}: {error}", path.display()),
            retry_safe: true,
        })?;
        if file_type.is_dir() {
            discover_scan_files(&path, packages, sidecars, include_sidecars, cancellation)?;
        } else if file_type.is_file() && is_package_path(&path) {
            packages.push(path);
        } else if include_sidecars && file_type.is_file() && is_sidecar_path(&path) {
            sidecars.push(path);
        }
    }
    checkpoint(cancellation, "discovery")?;
    Ok(())
}

fn is_package_path(path: &Path) -> bool {
    has_extension(path, PACKAGE_EXTENSIONS)
}

fn is_sidecar_path(path: &Path) -> bool {
    has_extension(path, SIDECAR_EXTENSIONS)
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

fn read_asset_signature(path: &Path) -> Option<AssetSignature> {
    let metadata = fs::metadata(path).ok()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
        });
    Some(AssetSignature {
        modified_nanos,
        path: path.to_owned(),
        size: metadata.len(),
    })
}

fn read_asset_signature_with_cancellation(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<AssetSignature>, Failure> {
    checkpoint(cancellation, "read")?;
    let signature = read_asset_signature(path);
    checkpoint(cancellation, "read")?;
    Ok(signature)
}

fn record_inventory_metadata_failure(
    path: &Path,
    inventory_complete: &mut bool,
    diagnostics: &mut Vec<Diagnostic>,
) {
    *inventory_complete = false;
    diagnostics.push(scan_diagnostic(
        "inventory_io",
        format!("could not read inventory metadata for {}", path.display()),
        &path.to_string_lossy(),
    ));
}

fn manifest_entry(signature: &AssetSignature, kind: ManifestEntryKind) -> SavedAssetManifestEntry {
    SavedAssetManifestEntry {
        kind,
        modified_ms: signature.modified_nanos as f64 / 1_000_000.0,
        path: signature.path.to_string_lossy().into_owned(),
        size: signature.size,
    }
}

fn read_package_header(
    signature: &AssetSignature,
    cancellation: &CancellationToken,
) -> Result<Package, Failure> {
    checkpoint(cancellation, "read")?;
    let file_len =
        usize::try_from(signature.size).map_err(|_| header_failure("asset_resource_limit"))?;
    if file_len == 0 {
        return Err(header_failure("asset_malformed_data"));
    }
    let mut file = File::open(&signature.path).map_err(|_| header_failure("asset_io"))?;
    let mut prefix_len = HEADER_PROBE_BYTES.min(file_len);
    let mut bytes = vec![0; prefix_len];
    file.read_exact(&mut bytes)
        .map_err(|_| header_failure("asset_io"))?;
    checkpoint(cancellation, "read")?;
    let summary = loop {
        checkpoint(cancellation, "parsing")?;
        match PackageSummary::parse_with_file_len(&bytes, file_len) {
            Ok(summary) => break summary,
            Err(error)
                if error.kind() == PackageErrorKind::MalformedData
                    && prefix_len < MAX_SUMMARY_BYTES.min(file_len) =>
            {
                let next_len = (prefix_len * 2).min(MAX_SUMMARY_BYTES).min(file_len);
                bytes.resize(next_len, 0);
                file.read_exact(&mut bytes[prefix_len..])
                    .map_err(|_| header_failure("asset_io"))?;
                checkpoint(cancellation, "read")?;
                prefix_len = next_len;
            }
            Err(error) => return Err(header_failure(package_error_code(&error))),
        }
    };
    checkpoint(cancellation, "parsing")?;
    let header_len = usize::try_from(summary.total_header_size)
        .map_err(|_| header_failure("asset_resource_limit"))?;
    if header_len > MAX_HEADER_BYTES {
        return Err(header_failure("asset_resource_limit"));
    }
    if header_len > bytes.len() {
        let previous_len = bytes.len();
        bytes.resize(header_len, 0);
        file.read_exact(&mut bytes[previous_len..])
            .map_err(|_| header_failure("asset_io"))?;
    } else {
        bytes.truncate(header_len);
    }
    checkpoint(cancellation, "read")?;
    checkpoint(cancellation, "inspection")?;
    Package::parse_header(&bytes, file_len)
        .map_err(|error| header_failure(package_error_code(&error)))
}

fn header_failure(code: &'static str) -> Failure {
    Failure {
        code: code.to_owned(),
        message: format!("could not inspect package header ({code})"),
        retry_safe: matches!(code, "asset_io"),
    }
}

fn package_error_code(error: &PackageError) -> &'static str {
    match error.kind() {
        PackageErrorKind::MalformedData => "asset_malformed_data",
        PackageErrorKind::ResourceLimit => "asset_resource_limit",
        PackageErrorKind::UnsupportedFormat => "asset_unsupported_format",
        PackageErrorKind::UnsupportedVersion => "asset_unsupported_version",
        PackageErrorKind::UnsupportedCapability => "asset_unsupported_capability",
    }
}

pub(crate) fn saved_world(request: &Request) -> Result<SavedWorldOutput, Failure> {
    saved_world_with_cancellation(request, &CancellationToken::new())
}

pub(crate) fn saved_world_with_cancellation(
    request: &Request,
    cancellation: &CancellationToken,
) -> Result<SavedWorldOutput, Failure> {
    saved_world_with_cancellation_and_progress(request, cancellation, &|_, _| {})
}

pub(crate) fn saved_world_with_cancellation_and_progress<F>(
    request: &Request,
    cancellation: &CancellationToken,
    on_progress: &F,
) -> Result<SavedWorldOutput, Failure>
where
    F: Fn(u64, u64) + Sync,
{
    let Operation::SavedWorld {
        map_path,
        project_root,
    } = &request.operation
    else {
        return Err(Failure {
            code: "unsupported".to_owned(),
            message: "direct executor expected a saved-world operation".to_owned(),
            retry_safe: false,
        });
    };
    checkpoint(cancellation, "discovery")?;
    let roots =
        resolve_saved_world_roots(Path::new(project_root), Path::new(map_path), cancellation)?;
    let mut package_paths = match &roots.source {
        SavedWorldSource::Level => vec![roots.map_path.clone()],
        SavedWorldSource::WorldPartition {
            external_actor_root,
        } => {
            let (paths, _) = discover_paths(
                std::slice::from_ref(external_actor_root),
                false,
                cancellation,
            )?;
            paths
        }
    };
    package_paths.sort();
    package_paths.dedup();
    let maximum_assets = request
        .limits
        .maximum_assets
        .unwrap_or(DEFAULT_SAVED_WORLD_MAXIMUM_ASSETS);
    if package_paths.len() as u64 > maximum_assets {
        return Err(Failure {
            code: "resource_limit".to_owned(),
            message: format!(
                "saved map found {} packages, above the requested limit {}",
                package_paths.len(),
                maximum_assets
            ),
            retry_safe: false,
        });
    }
    let total_packages = package_paths.len() as u64;
    on_progress(0, total_packages);
    let next_path = AtomicUsize::new(0);
    let completed_packages = AtomicUsize::new(0);
    let worker_count = request.limits.concurrency.unwrap_or(4).max(1) as usize;
    let slots = Mutex::new(
        (0..package_paths.len())
            .map(|_| None::<Result<SavedWorldPackageRead, Failure>>)
            .collect::<Vec<_>>(),
    );
    let paths = &package_paths;
    std::thread::scope(|scope| {
        for _ in 0..worker_count.min(package_paths.len().max(1)) {
            let next_path = &next_path;
            let completed_packages = &completed_packages;
            let slots = &slots;
            let cancellation = cancellation.clone();
            scope.spawn(move || {
                loop {
                    if checkpoint(&cancellation, "discovery").is_err() {
                        break;
                    }
                    let index = next_path.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(index) else {
                        break;
                    };
                    let result = read_saved_world_package(path, &cancellation);
                    slots
                        .lock()
                        .expect("saved-world slots must not be poisoned")[index] = Some(result);
                    let completed_packages =
                        completed_packages.fetch_add(1, Ordering::Relaxed) as u64 + 1;
                    on_progress(completed_packages, total_packages);
                }
            });
        }
    });

    let mut fragments = Vec::new();
    let mut diagnostic_counts = BTreeMap::<String, u64>::new();
    let mut partial_packages = 0_u64;
    let mut failed_packages = 0_u64;
    for result in slots
        .into_inner()
        .expect("saved-world slots must not be poisoned")
        .into_iter()
        .flatten()
    {
        let result = result?;
        checkpoint(cancellation, "inspection")?;
        if let Some(fragment) = result.fragment {
            fragments.push(fragment);
            if result.partial {
                partial_packages += 1;
            }
        } else {
            failed_packages += 1;
        }
        if let Some(code) = result.failure_code {
            *diagnostic_counts.entry(code).or_default() += 1;
        }
    }
    checkpoint(cancellation, "inspection")?;
    let positions = resolve_saved_world_positions(&fragments);
    checkpoint(cancellation, "inspection")?;
    let resolved_actors = positions
        .iter()
        .filter(|position| matches!(position.position, SavedWorldPosition::Resolved { .. }))
        .count() as u64;
    let diagnostics = diagnostic_counts
        .into_iter()
        .map(|(code, count)| SavedWorldDiagnostic {
            code,
            message: format!("{count} saved map package(s) could not be fully read"),
            retry_safe: true,
        })
        .collect();
    let partial = partial_packages > 0 || failed_packages > 0;
    checkpoint(cancellation, "inspection")?;
    let world = SavedWorld {
        authority: SavedWorldAuthority {
            kind: crate::protocol_result::ProjectFilesKind,
            map_package: roots.map_package,
        },
        completeness: if partial {
            Completeness::Partial
        } else {
            Completeness::Complete
        },
        contract: SavedWorldContract {
            name: SavedWorldContractName,
            version: SavedWorldContractVersion { major: 1, minor: 1 },
        },
        diagnostics,
        external_actor_root: roots
            .source
            .external_actor_root()
            .map(|path| path.to_string_lossy().into_owned()),
        map_path: roots.map_path.to_string_lossy().into_owned(),
        source_kind: roots.source.kind(),
        actors: positions.into_iter().map(saved_world_actor).collect(),
        summary: SavedWorldSummary {
            failed_packages,
            partial_packages,
            resolved_actors,
            scanned_packages: package_paths.len() as u64,
        },
    };
    Ok(SavedWorldOutput { world, partial })
}

struct SavedWorldRoots {
    map_package: String,
    map_path: PathBuf,
    source: SavedWorldSource,
}

enum SavedWorldSource {
    Level,
    WorldPartition { external_actor_root: PathBuf },
}

impl SavedWorldSource {
    fn external_actor_root(&self) -> Option<&Path> {
        match self {
            Self::Level => None,
            Self::WorldPartition {
                external_actor_root,
            } => Some(external_actor_root),
        }
    }

    fn kind(&self) -> SavedWorldSourceKind {
        match self {
            Self::Level => SavedWorldSourceKind::Level,
            Self::WorldPartition { .. } => SavedWorldSourceKind::WorldPartition,
        }
    }
}

fn resolve_saved_world_roots(
    project_root: &Path,
    requested_map_path: &Path,
    cancellation: &CancellationToken,
) -> Result<SavedWorldRoots, Failure> {
    checkpoint(cancellation, "discovery")?;
    let project_root = fs::canonicalize(project_root).map_err(|error| Failure {
        code: "io".to_owned(),
        message: format!(
            "saved-world requires a readable project root {}: {error}",
            project_root.display()
        ),
        retry_safe: true,
    })?;
    let content_root = project_root.join("Content");
    let map_candidate = if requested_map_path.is_absolute() {
        requested_map_path.to_owned()
    } else {
        project_root.join(requested_map_path)
    };
    let map_path = fs::canonicalize(&map_candidate).map_err(|error| Failure {
        code: "io".to_owned(),
        message: format!(
            "saved-world requires a readable .umap inside the project: {}: {error}",
            map_candidate.display()
        ),
        retry_safe: true,
    })?;
    checkpoint(cancellation, "discovery")?;
    if !map_path.starts_with(&content_root) {
        return Err(Failure {
            code: "invalid_request".to_owned(),
            message: format!(
                "saved-world map {} is outside the project's Content directory",
                map_candidate.display()
            ),
            retry_safe: false,
        });
    }
    let relative_map_path = map_path.strip_prefix(&content_root).map_err(|_| Failure {
        code: "invalid_request".to_owned(),
        message: "saved-world could not make the map path relative to Content".to_owned(),
        retry_safe: false,
    })?;
    let external_actor_relative = external_actor_relative_path(relative_map_path)?;
    let external_actor_root = content_root
        .join("__ExternalActors__")
        .join(external_actor_relative);
    checkpoint(cancellation, "discovery")?;
    Ok(SavedWorldRoots {
        map_package: format!(
            "/Game/{}",
            relative_map_path
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/")
        ),
        map_path,
        source: if external_actor_root.is_dir() {
            SavedWorldSource::WorldPartition {
                external_actor_root,
            }
        } else {
            SavedWorldSource::Level
        },
    })
}

fn external_actor_relative_path(relative_map_path: &Path) -> Result<PathBuf, Failure> {
    if relative_map_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("umap")
    {
        return Err(Failure {
            code: "invalid_request".to_owned(),
            message: format!(
                "saved-world map {} must have a .umap extension",
                relative_map_path.display()
            ),
            retry_safe: false,
        });
    }
    let path = relative_map_path.with_extension("");
    if path.as_os_str().is_empty() || path.is_absolute() || path.starts_with("..") {
        return Err(Failure {
            code: "invalid_request".to_owned(),
            message: "saved-world map must be a relative path beneath Content".to_owned(),
            retry_safe: false,
        });
    }
    Ok(path)
}

struct SavedWorldPackageRead {
    failure_code: Option<String>,
    fragment: Option<SavedWorldPackageFragment>,
    partial: bool,
}

fn read_saved_world_package(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<SavedWorldPackageRead, Failure> {
    checkpoint(cancellation, "read")?;
    let source = match fs::read(path) {
        Ok(source) => source,
        Err(_) => {
            return Ok(SavedWorldPackageRead {
                failure_code: Some("asset_io".to_owned()),
                fragment: None,
                partial: false,
            });
        }
    };
    checkpoint(cancellation, "read")?;
    checkpoint(cancellation, "parsing")?;
    let package = match Package::parse(&source) {
        Ok(package) => package,
        Err(error) => {
            return Ok(SavedWorldPackageRead {
                failure_code: Some(package_error_code(&error).to_owned()),
                fragment: None,
                partial: false,
            });
        }
    };
    checkpoint(cancellation, "parsing")?;
    let schemas = EmptySchemas;
    let context = AssetDecodeContext {
        source: &source,
        package: &package,
        schemas: &schemas,
    };
    let mut decoded = Vec::new();
    let mut partial = false;
    for export in &package.exports {
        checkpoint(cancellation, "parsing")?;
        match decode_export(export, &context) {
            Ok(Some(asset)) => decoded.push(asset),
            Ok(None) => {}
            Err(_) => partial = true,
        }
        checkpoint(cancellation, "inspection")?;
    }
    let fragment = project_saved_world_package(&package, &decoded);
    checkpoint(cancellation, "inspection")?;
    Ok(SavedWorldPackageRead {
        failure_code: partial.then_some("export_decode".to_owned()),
        fragment: Some(fragment),
        partial,
    })
}

fn saved_world_actor(position: SavedWorldActorPosition) -> SavedWorldActor {
    SavedWorldActor {
        actor_guid: position.actor_guid.map(|guid| guid.to_string()),
        actor_path: position.actor_path.to_string(),
        class_path: position.class_path.to_string(),
        label: position.label,
        package_name: position.package_name,
        position: saved_world_position(position.position),
    }
}

fn saved_world_position(position: SavedWorldPosition) -> WireWorldPosition {
    match position {
        SavedWorldPosition::Resolved { location } => WireWorldPosition::Resolved {
            location: SavedWorldVector {
                x: location.x,
                y: location.y,
                z: location.z,
            },
        },
        SavedWorldPosition::MissingRootComponent => WireWorldPosition::MissingRootComponent,
        SavedWorldPosition::MissingAttachmentParent { parent_path } => {
            WireWorldPosition::MissingAttachmentParent {
                parent_path: parent_path.to_string(),
            }
        }
        SavedWorldPosition::AttachmentCycle { component_path } => {
            WireWorldPosition::AttachmentCycle {
                component_path: component_path.to_string(),
            }
        }
        SavedWorldPosition::AmbiguousComponentPath { component_path } => {
            WireWorldPosition::AmbiguousComponentPath {
                component_path: component_path.to_string(),
            }
        }
        SavedWorldPosition::UnsupportedAbsoluteTransform { component_path } => {
            WireWorldPosition::UnsupportedAbsoluteTransform {
                component_path: component_path.to_string(),
            }
        }
    }
}

struct EmptySchemas;

impl SchemaProvider for EmptySchemas {
    fn find_struct(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&StructSchema> {
        None
    }

    fn find_class(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&ClassSchema> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::scan_header_cache_needs_write;

    #[test]
    fn exact_header_cache_hit_is_a_no_op() {
        assert!(!scan_header_cache_needs_write(true, 10, 10, 10, 10));
    }

    #[test]
    fn header_cache_rewrites_for_missing_changed_added_deleted_or_duplicate_entries() {
        assert!(scan_header_cache_needs_write(false, 0, 0, 10, 0));
        assert!(scan_header_cache_needs_write(true, 10, 10, 10, 9));
        assert!(scan_header_cache_needs_write(true, 10, 10, 11, 10));
        assert!(scan_header_cache_needs_write(true, 11, 11, 10, 10));
        assert!(scan_header_cache_needs_write(true, 11, 10, 10, 10));
    }
}
