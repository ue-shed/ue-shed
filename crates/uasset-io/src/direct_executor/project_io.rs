use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use uasset_inspection::projection::{
    TextAssetProjection, TextureRecord, project_text_asset, project_texture_asset,
    text_feature_version_gap,
};
use uasset_inspection::saved_world::{
    SavedWorldPackageFragment, SavedWorldTransform, project_saved_world_package,
    resolve_saved_world_actors,
};
use uasset_inspection::saved_world_wire::saved_world_actor;
use uasset_inspection::text_wire::{text_coverage_gap, text_occurrence};
use uasset_inspection::texture_wire::texture_record;
use uasset_parser::asset::{AssetDecodeContext, AssetErrorKind, decode_export};
use uasset_parser::package::{
    Export, ObjectPath, Package, PackageError, PackageErrorKind, PackageIndex,
};
use uasset_parser::schema::{SchemaProvider, embedded_source_model};

use super::scanner;
use super::{
    Diagnostic, Failure, ProjectionOutput, SavedWorldOutput, ScanOutput, checkpoint,
    scan_diagnostic, scan_failure_code, summary_diagnostics,
};
use crate::cancellation::CancellationToken;
use crate::protocol::{Operation, ProjectSelection, Request, ScanDepth, ScanFilters};
use crate::protocol_result::{
    Completeness, ManifestEntryKind, ProjectionStatus, ResultFrame, SavedAssetHeader,
    SavedAssetHeaderExport, SavedAssetHeaderPackage, SavedAssetManifestEntry,
    SavedAssetProjectionDiagnostic, SavedAssetScanEntry, SavedAssetScanSummary,
    SavedAssetTextExtractionEvent, SavedAssetTextureExtractionEvent, SavedWorld,
    SavedWorldAuthority, SavedWorldContract, SavedWorldContractName, SavedWorldContractVersion,
    SavedWorldDiagnostic, SavedWorldPackageError, SavedWorldSourceKind, SavedWorldSummary,
    ScanSummaryDepth,
};

const SCHEMA_VERSION: u8 = 8;
const SCAN_CACHE_VERSION: u32 = 2;
const DEFAULT_SAVED_WORLD_MAXIMUM_ASSETS: u64 = 100_000;

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
            ..Default::default()
        });
    };
    if cache_path.is_some() && *depth == ScanDepth::Full {
        return Err(Failure {
            code: "invalid_request".to_owned(),
            message: "scan cache requires header depth".to_owned(),
            retry_safe: false,
            ..Default::default()
        });
    }
    checkpoint(cancellation, "discovery")?;
    let roots = resolve_roots(selection, cancellation)?;
    let (asset_paths, sidecar_paths) =
        scanner::discover_paths(&roots, inventory.unwrap_or(false), cancellation)?;
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
                ..Default::default()
            });
        }
    };
    checkpoint(cancellation, "discovery")?;
    let roots = resolve_roots(selection, cancellation)?;
    let (paths, _) = scanner::discover_paths(&roots, false, cancellation)?;
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
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: embedded_source_model(),
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
                if matches!(kind, ProjectionKind::Text)
                    && let Some(gap) = text_feature_version_gap(&package, export, &error)
                {
                    coverage_gap_count += 1;
                    results.extend(text_results(
                        &path_string,
                        bytes.len() as u64,
                        TextAssetProjection {
                            occurrences: Vec::new(),
                            coverage_gaps: vec![gap],
                        },
                    ));
                }
                diagnostics.push(projection_diagnostic(export, error.kind(), error.message()))
            }
        }
    }
    checkpoint(cancellation, "inspection")?;
    let partial = !diagnostics.is_empty() || coverage_gap_count != 0;
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
                coverage_gap: text_coverage_gap(gap),
            },
        });
    }
    results
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
        ..Default::default()
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
            ..Default::default()
        })?;
        if !canonical.starts_with(&canonical_project_root) {
            return Err(Failure {
                code: "invalid_request".to_owned(),
                message: format!("--path {} is outside the project root", joined.display()),
                retry_safe: false,
                ..Default::default()
            });
        }
        if canonical.is_file() && !scanner::is_package_path(&canonical) {
            return Err(Failure {
                code: "invalid_request".to_owned(),
                message: format!("--path {} is not a .uasset or .umap file", joined.display()),
                retry_safe: false,
                ..Default::default()
            });
        }
        roots.push(joined);
    }
    checkpoint(cancellation, "discovery")?;
    Ok(roots)
}

fn enforce_maximum_assets(request: &Request, count: usize) -> Result<(), Failure> {
    if let Some(maximum_assets) = request.limits.maximum_assets
        && count as u64 > maximum_assets
    {
        return Err(Failure {
            code: "resource_limit".to_owned(),
            message: format!("Scan found {count} packages, above the limit of {maximum_assets}."),
            retry_safe: false,
            ..Default::default()
        });
    }
    Ok(())
}

fn read_asset_signature_with_cancellation(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<AssetSignature>, Failure> {
    Ok(
        scanner::read_asset_signature_with_cancellation(path, cancellation)?.map(|signature| {
            AssetSignature {
                modified_nanos: signature.modified_nanos,
                path: signature.path,
                size: signature.size,
            }
        }),
    )
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
    scanner::read_package_header(&signature.path, signature.size, cancellation)
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

pub(crate) fn saved_world_with_options(
    request: &Request,
    options: SavedWorldReadOptions,
) -> Result<SavedWorldOutput, Failure> {
    saved_world_with_cancellation_progress_and_options(
        request,
        &CancellationToken::new(),
        &|_, _| {},
        options,
    )
}

#[cfg(test)]
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
    saved_world_with_cancellation_progress_and_options(
        request,
        cancellation,
        on_progress,
        SavedWorldReadOptions::default(),
    )
}

fn saved_world_with_cancellation_progress_and_options<F>(
    request: &Request,
    cancellation: &CancellationToken,
    on_progress: &F,
    options: SavedWorldReadOptions,
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
            ..Default::default()
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
            let (paths, _) = scanner::discover_paths(
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
            ..Default::default()
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
    let content_root = roots.content_root.as_path();
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
                    let result =
                        read_saved_world_package(path, content_root, options, &cancellation);
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
    let mut package_errors = Vec::new();
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
        package_errors.extend(result.errors);
    }
    checkpoint(cancellation, "inspection")?;
    let actors = resolve_saved_world_actors(&fragments);
    checkpoint(cancellation, "inspection")?;
    let resolved_actors = actors
        .iter()
        .filter(|actor| matches!(actor.transform, SavedWorldTransform::Resolved { .. }))
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
            version: SavedWorldContractVersion::CURRENT,
        },
        diagnostics,
        external_actor_root: roots
            .source
            .external_actor_root()
            .map(|path| path.to_string_lossy().into_owned()),
        map_path: roots.map_path.to_string_lossy().into_owned(),
        package_errors,
        source_kind: roots.source.kind(),
        actors: actors.into_iter().map(saved_world_actor).collect(),
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
    content_root: PathBuf,
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
        ..Default::default()
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
        ..Default::default()
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
            ..Default::default()
        });
    }
    let relative_map_path = map_path.strip_prefix(&content_root).map_err(|_| Failure {
        code: "invalid_request".to_owned(),
        message: "saved-world could not make the map path relative to Content".to_owned(),
        retry_safe: false,
        ..Default::default()
    })?;
    let external_actor_relative = external_actor_relative_path(relative_map_path)?;
    let external_actor_root = content_root
        .join("__ExternalActors__")
        .join(external_actor_relative);
    checkpoint(cancellation, "discovery")?;
    Ok(SavedWorldRoots {
        content_root: content_root.clone(),
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
            ..Default::default()
        });
    }
    let path = relative_map_path.with_extension("");
    if path.as_os_str().is_empty() || path.is_absolute() || path.starts_with("..") {
        return Err(Failure {
            code: "invalid_request".to_owned(),
            message: "saved-world map must be a relative path beneath Content".to_owned(),
            retry_safe: false,
            ..Default::default()
        });
    }
    Ok(path)
}

struct SavedWorldPackageRead {
    errors: Vec<SavedWorldPackageError>,
    failure_code: Option<String>,
    fragment: Option<SavedWorldPackageFragment>,
    partial: bool,
}

impl SavedWorldPackageRead {
    /// A package that could not be read at all. Its contents are unknown, so by convention it is
    /// reported as possibly dropping an actor (every external actor package holds one).
    fn failed(package: String, code: &str, detail: String) -> Self {
        Self {
            errors: vec![SavedWorldPackageError {
                package,
                export: None,
                category: code.to_owned(),
                detail,
                actor_dropped: true,
                count: None,
                exports: None,
            }],
            failure_code: Some(code.to_owned()),
            fragment: None,
            partial: false,
        }
    }
}

/// The long package name implied by a file path beneath `Content`, for packages whose header
/// could not be read. Falls back to the file path when it is outside `Content`.
fn package_name_from_path(path: &Path, content_root: &Path) -> String {
    path.strip_prefix(content_root).map_or_else(
        |_| path.to_string_lossy().into_owned(),
        |relative| {
            format!(
                "/Game/{}",
                relative
                    .with_extension("")
                    .to_string_lossy()
                    .replace('\\', "/")
            )
        },
    )
}

/// `packageErrors` category for decoded exports that kept property values raw.
const SKIPPED_PROPERTY_CATEGORY: &str = "skipped_property";
/// Types named in an aggregated `skipped_property` detail; the rest are counted.
const SKIPPED_PROPERTY_TYPE_LIMIT: usize = 5;
/// Property paths named in a per-export `skipped_property` detail.
const SKIPPED_PROPERTY_PATH_LIMIT: usize = 3;

/// How saved-world reports exports that decoded with raw property values.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SkippedPropertyDetail {
    /// One `skipped_property` entry per package, with counts and the most frequent types.
    #[default]
    Package,
    /// One entry per affected export, naming its first property paths. Opt-in: large maps can
    /// have thousands of such exports.
    Export,
}

/// Options for a saved-world read that are not part of the protocol request.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct SavedWorldReadOptions {
    pub(crate) skipped_property_detail: SkippedPropertyDetail,
}

fn skipped_property_errors(
    package: &str,
    exports: &[uasset_inspection::saved_world::SavedWorldIncompleteExport],
    detail: SkippedPropertyDetail,
) -> Vec<SavedWorldPackageError> {
    let entry = |export: Option<String>, count: usize, exports: usize, detail: String| {
        SavedWorldPackageError {
            package: package.to_owned(),
            export,
            category: SKIPPED_PROPERTY_CATEGORY.to_owned(),
            detail,
            actor_dropped: false,
            count: Some(count as u64),
            exports: Some(exports as u64),
        }
    };
    match detail {
        _ if exports.is_empty() => Vec::new(),
        SkippedPropertyDetail::Export => exports
            .iter()
            .map(|export| {
                let properties = &export.properties;
                let listed = properties
                    .iter()
                    .take(SKIPPED_PROPERTY_PATH_LIMIT)
                    .map(|property| format!("{} ({})", property.path, property.reason))
                    .collect::<Vec<_>>()
                    .join("; ");
                let more = properties.len().saturating_sub(SKIPPED_PROPERTY_PATH_LIMIT);
                let suffix = if more > 0 {
                    format!("; and {more} more")
                } else {
                    String::new()
                };
                entry(
                    Some(export.object_path.to_string()),
                    properties.len(),
                    1,
                    format!(
                        "{} property value(s) not decoded: {listed}{suffix}",
                        properties.len()
                    ),
                )
            })
            .collect(),
        SkippedPropertyDetail::Package => {
            let mut by_type = BTreeMap::<&str, usize>::new();
            for property in exports.iter().flat_map(|export| &export.properties) {
                *by_type.entry(property.type_name.as_str()).or_default() += 1;
            }
            let count = by_type.values().sum::<usize>();
            let mut ranked: Vec<_> = by_type.into_iter().collect();
            ranked.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
            let listed = ranked
                .iter()
                .take(SKIPPED_PROPERTY_TYPE_LIMIT)
                .map(|(name, count)| format!("{name} {count}"))
                .collect::<Vec<_>>()
                .join(", ");
            let more = ranked.len().saturating_sub(SKIPPED_PROPERTY_TYPE_LIMIT);
            let suffix = if more > 0 {
                format!(", and {more} more type(s)")
            } else {
                String::new()
            };
            vec![entry(
                None,
                count,
                exports.len(),
                format!(
                    "{count} property value(s) in {} export(s) not decoded; by type: {listed}{suffix}",
                    exports.len()
                ),
            )]
        }
    }
}

fn export_error_category(kind: AssetErrorKind) -> &'static str {
    match kind {
        AssetErrorKind::MalformedData => "export_malformed_data",
        AssetErrorKind::ResourceLimit => "export_resource_limit",
        AssetErrorKind::UnsupportedFormat => "export_unsupported_format",
        AssetErrorKind::UnsupportedVersion => "export_unsupported_version",
        AssetErrorKind::UnsupportedCapability => "export_unsupported_capability",
    }
}

/// Classes Unreal saves directly under a `Level` (or under its brush model) that are not actors:
/// UE 5.7/5.8 `UWorld::InitializeNewWorld` and `AddDefaultBrush` create `UModel`s with the level
/// as outer, `ULevel::UpdateModelComponents` creates `UModelComponent`s, and a model owns `UPolys`.
const NON_ACTOR_LEVEL_CHILD_CLASSES: &[&str] = &[
    "/Script/Engine.Model",
    "/Script/Engine.ModelComponent",
    "/Script/Engine.Polys",
];

/// Whether a failed export may have been an actor, for `packageErrors.actorDropped`.
///
/// Actors are saved with a `Level` as their outer, so anything else is not an actor. Known
/// non-actor level children are rejected, and a class the source model knows answers by its
/// inheritance. A level child of a class the reader cannot classify (typically a project or
/// Blueprint class) is conservatively reported as a possibly dropped actor: the flag means "an
/// actor may be missing", not proof that one was.
fn may_be_actor_export(package: &Package, export: &Export) -> bool {
    if !outer_is_level(package, export) {
        return false;
    }
    let Some(class_path) = export.class_path.as_ref() else {
        return true;
    };
    if NON_ACTOR_LEVEL_CHILD_CLASSES.contains(&class_path.as_str()) {
        return false;
    }
    let schemas = embedded_source_model();
    if schemas.find_class(class_path).is_some() {
        return schemas.class_is_a(class_path, "/Script/Engine.Actor");
    }
    true
}

/// Whether `export`'s outer is a `Level` export or import.
fn outer_is_level(package: &Package, export: &Export) -> bool {
    let outer_class = match export.outer_index {
        PackageIndex::Import(index) => usize::try_from(index)
            .ok()
            .and_then(|index| package.imports.get(index))
            .map(|import| import.class_path.as_str()),
        PackageIndex::Export(index) => usize::try_from(index)
            .ok()
            .and_then(|index| package.exports.get(index))
            .and_then(|outer| outer.class_path.as_ref().map(ObjectPath::as_str)),
        PackageIndex::Null => None,
    };
    // Import class paths are rendered as `//Script/Engine.Level` by the header parser.
    outer_class.is_some_and(|class| class.trim_start_matches('/') == "Script/Engine.Level")
}

fn read_saved_world_package(
    path: &Path,
    content_root: &Path,
    options: SavedWorldReadOptions,
    cancellation: &CancellationToken,
) -> Result<SavedWorldPackageRead, Failure> {
    checkpoint(cancellation, "read")?;
    let source = match fs::read(path) {
        Ok(source) => source,
        Err(error) => {
            return Ok(SavedWorldPackageRead::failed(
                package_name_from_path(path, content_root),
                "asset_io",
                error.to_string(),
            ));
        }
    };
    checkpoint(cancellation, "read")?;
    checkpoint(cancellation, "parsing")?;
    let package = match Package::parse(&source) {
        Ok(package) => package,
        Err(error) => {
            return Ok(SavedWorldPackageRead::failed(
                package_name_from_path(path, content_root),
                package_error_code(&error),
                error.to_string(),
            ));
        }
    };
    checkpoint(cancellation, "parsing")?;
    let context = AssetDecodeContext {
        source: &source,
        package: &package,
        schemas: embedded_source_model(),
    };
    let mut decoded = Vec::new();
    let mut errors = Vec::new();
    let mut failed_exports = Vec::new();
    for export in &package.exports {
        checkpoint(cancellation, "parsing")?;
        match decode_export(export, &context) {
            Ok(Some(asset)) => decoded.push(asset),
            Ok(None) => {}
            Err(error) => {
                errors.push(SavedWorldPackageError {
                    package: package.summary.package_name.clone(),
                    export: Some(export.object_path.to_string()),
                    category: export_error_category(error.kind()).to_owned(),
                    detail: error.message().to_owned(),
                    actor_dropped: may_be_actor_export(&package, export),
                    count: None,
                    exports: None,
                });
                failed_exports.push(export.object_path.clone());
            }
        }
        checkpoint(cancellation, "inspection")?;
    }
    let mut fragment = project_saved_world_package(&package, &decoded);
    fragment.failed_exports = failed_exports;
    errors.extend(skipped_property_errors(
        &package.summary.package_name,
        &fragment.incomplete_exports,
        options.skipped_property_detail,
    ));
    checkpoint(cancellation, "inspection")?;
    // Skipped property values mark their actors partial and are listed, but the export itself
    // was read, so they do not make the package partial.
    let partial = !fragment.failed_exports.is_empty();
    Ok(SavedWorldPackageRead {
        errors,
        failure_code: partial.then_some("export_decode".to_owned()),
        fragment: Some(fragment),
        partial,
    })
}

#[cfg(test)]
mod tests {
    use super::{saved_world_with_cancellation, scan_header_cache_needs_write};
    use crate::cancellation::CancellationToken;
    use crate::protocol::Request;
    use crate::protocol_result::SavedWorldActorDecode;
    use uasset_parser::package::ObjectPath;

    #[test]
    fn legacy_text_protocol_frames_preserve_occurrences_and_each_gap_reason() {
        use crate::protocol_result::{ResultFrame, SavedAssetTextExtractionEvent};
        for ue5 in [0, 1000, 1009, 1010, 1011] {
            let (bytes, package) = crate::test_support::legacy_text_package(ue5);
            let context = uasset_parser::asset::AssetDecodeContext {
                source: &bytes,
                package: &package,
                schemas: uasset_parser::schema::embedded_source_model(),
            };
            let asset = uasset_parser::asset::decode_export(&package.exports[0], &context)
                .unwrap()
                .unwrap();
            let projection = super::project_text_asset(&package, &asset);
            let frames = super::text_results("legacy.uasset", bytes.len() as u64, projection);
            assert_eq!(frames.len(), 5);
            let mut reasons = Vec::new();
            for frame in frames {
                match frame {
                    ResultFrame::ExtractText {
                        event: SavedAssetTextExtractionEvent::TextOccurrence { occurrence, .. },
                    } => assert_eq!(occurrence.source, "Hello"),
                    ResultFrame::ExtractText {
                        event: SavedAssetTextExtractionEvent::TextCoverageGap { coverage_gap, .. },
                    } => reasons.push(serde_json::to_value(coverage_gap.reason).unwrap()),
                    _ => panic!("unexpected frame"),
                }
            }
            assert_eq!(
                reasons,
                vec![
                    serde_json::json!("unsupported_text_history"),
                    serde_json::json!("legacy_container_element_without_type_information"),
                    serde_json::json!("feature_unavailable_for_engine_version"),
                    serde_json::json!("property_decoder_rejected"),
                ]
            );
        }
    }

    fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).expect("create copy directory");
        for entry in std::fs::read_dir(from).expect("read fixture directory") {
            let entry = entry.expect("fixture entry");
            let target = to.join(entry.file_name());
            if entry.file_type().expect("fixture entry type").is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), &target).expect("copy fixture file");
            }
        }
    }

    fn overwrite_export_head(path: &std::path::Path, export: &uasset_parser::package::Export) {
        let mut bytes = std::fs::read(path).expect("read package");
        let start = usize::try_from(export.serial_offset.get()).expect("offset fits");
        bytes[start..start + 8].fill(0xFF);
        std::fs::write(path, bytes).expect("corrupt export");
    }

    /// Copies one fixture map (and its external actors, when it has them) into a temporary
    /// project, returning the project root and its sorted package paths.
    fn copy_fixture_map(map: &str, label: &str) -> (std::path::PathBuf, Vec<std::path::PathBuf>) {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/unreal-project/Content");
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let project_root =
            std::env::temp_dir().join(format!("ue-shed-saved-world-{label}-{suffix}"));
        let content = project_root.join("Content");
        let map_file = content.join(format!("{map}.umap"));
        std::fs::create_dir_all(map_file.parent().expect("map directory"))
            .expect("create map directory");
        std::fs::copy(fixture.join(format!("{map}.umap")), &map_file).expect("copy map");
        let actors = fixture.join("__ExternalActors__").join(map);
        if !actors.is_dir() {
            return (project_root, vec![map_file]);
        }
        let actors_root = content.join("__ExternalActors__").join(map);
        copy_tree(&actors, &actors_root);
        let (mut packages, _) = super::scanner::discover_paths(
            std::slice::from_ref(&actors_root),
            false,
            &CancellationToken::new(),
        )
        .expect("discover copied actors");
        packages.sort();
        (project_root, packages)
    }

    fn read_fixture_world(project_root: &std::path::Path, map: &str) -> super::SavedWorldOutput {
        read_fixture_world_with(
            project_root,
            map,
            super::SkippedPropertyDetail::Package,
            true,
        )
    }

    fn read_fixture_world_with(
        project_root: &std::path::Path,
        map: &str,
        skipped_property_detail: super::SkippedPropertyDetail,
        remove: bool,
    ) -> super::SavedWorldOutput {
        let request: Request = serde_json::from_value(serde_json::json!({
            "contract": { "name": "uasset-io", "version": { "major": 1, "minor": 0 } },
            "limits": { "concurrency": 2 },
            "operation": {
                "kind": "saved_world",
                "projectRoot": project_root.to_string_lossy(),
                "mapPath": format!("Content/{map}.umap")
            },
            "requestId": "saved-world-package-errors"
        }))
        .expect("saved-world request");
        let output = super::saved_world_with_options(
            &request,
            super::SavedWorldReadOptions {
                skipped_property_detail,
            },
        )
        .expect("partial saved world still succeeds");
        if remove {
            std::fs::remove_dir_all(project_root).expect("remove copied project");
        }
        output
    }

    fn read_package(path: &std::path::Path) -> uasset_parser::package::Package {
        uasset_parser::package::Package::parse(&std::fs::read(path).expect("read package"))
            .expect("parse package")
    }

    /// The first export whose outer is a Level, which in an external actor package is its actor.
    fn level_child_export(
        package: &uasset_parser::package::Package,
    ) -> &uasset_parser::package::Export {
        package
            .exports
            .iter()
            .find(|export| super::outer_is_level(package, export))
            .expect("actor export")
    }

    #[test]
    fn saved_world_marks_actors_with_skipped_property_values_partial() {
        use uasset_parser::property::read_uobject_tagged_property_stream;

        let map = "Fixture/Offline/L_OfflineWorld";
        let (project_root, packages) = copy_fixture_map(map, "skipped");
        // Flag one scalar property of an actor subobject as binary-or-native serialized. Its
        // value can no longer be decoded, but the export and its other properties still are.
        let target = &packages[0];
        let package = read_package(target);
        let actor_path = level_child_export(&package).object_path.to_string();
        let mut bytes = std::fs::read(target).expect("read package");
        let (component_path, property) = package
            .exports
            .iter()
            .filter(|export| {
                export
                    .object_path
                    .as_str()
                    .starts_with(&format!("{actor_path}."))
            })
            .find_map(|export| {
                let mut reader = package.export_reader(&bytes, export).ok()?;
                let stream = read_uobject_tagged_property_stream(
                    &mut reader,
                    &package.summary.versions,
                    &package.names,
                    "fixture",
                )
                .ok()?;
                let record = stream.records.iter().find(|record| {
                    record.property_guid.is_none()
                        && record.extensions.is_none()
                        && matches!(
                            package.resolve_name(record.type_name.name).as_deref(),
                            Some("ObjectProperty" | "IntProperty" | "FloatProperty")
                        )
                })?;
                Some((
                    export.object_path.to_string(),
                    (
                        package.resolve_name(record.name).expect("property name"),
                        usize::try_from(record.payload.offset()).expect("offset fits") - 1,
                    ),
                ))
            })
            .expect("a scalar property on an actor subobject");
        let (property_name, flags_offset) = property;
        bytes[flags_offset] |= 0x08;
        std::fs::write(target, bytes).expect("flag property");

        let package_name = package.summary.package_name.clone();
        let read = |detail| {
            let output = read_fixture_world_with(&project_root, map, detail, false);
            assert!(
                !output.partial,
                "a skipped property does not make the package partial"
            );
            assert_eq!(output.world.summary.partial_packages, 0);
            for actor in &output.world.actors {
                let expected = if actor.actor_path == actor_path {
                    SavedWorldActorDecode::Partial
                } else {
                    SavedWorldActorDecode::Complete
                };
                assert_eq!(actor.decode, Some(expected), "{}", actor.actor_path);
            }
            assert!(
                output
                    .world
                    .actors
                    .iter()
                    .any(|actor| actor.actor_path == actor_path)
            );
            output.world.package_errors
        };

        // By default: one entry for the package, counting values and exports by type.
        let errors = read(super::SkippedPropertyDetail::Package);
        let [error] = errors.as_slice() else {
            panic!("expected one package error, got {errors:#?}");
        };
        assert_eq!(error.category, "skipped_property");
        assert_eq!(error.package, package_name);
        assert_eq!(error.export, None);
        assert_eq!((error.count, error.exports), (Some(1), Some(1)));
        assert!(!error.actor_dropped);
        assert!(
            error
                .detail
                .starts_with("1 property value(s) in 1 export(s) not decoded; by type: "),
            "{}",
            error.detail
        );

        // Opt-in: one entry per affected export, naming the property.
        let errors = read(super::SkippedPropertyDetail::Export);
        let [error] = errors.as_slice() else {
            panic!("expected one export error, got {errors:#?}");
        };
        assert_eq!(error.export.as_deref(), Some(component_path.as_str()));
        assert_eq!((error.count, error.exports), (Some(1), Some(1)));
        assert!(
            error.detail.starts_with(&format!(
                "1 property value(s) not decoded: {property_name} ("
            )),
            "{}",
            error.detail
        );
        std::fs::remove_dir_all(&project_root).expect("remove copied project");
    }

    #[test]
    fn skipped_property_aggregation_ranks_types_and_truncates() {
        use uasset_inspection::saved_world::{
            SavedWorldIncompleteExport, SavedWorldUndecodedProperty,
        };
        let property = |type_name: &str| SavedWorldUndecodedProperty {
            path: "P".to_owned(),
            reason: "unsupported type".to_owned(),
            type_name: type_name.to_owned(),
        };
        let export = |path: &str, types: &[&str]| SavedWorldIncompleteExport {
            object_path: ObjectPath::new(path),
            properties: types.iter().map(|name| property(name)).collect(),
        };
        let exports = [
            export("A", &["F", "A", "A", "B"]),
            export("B", &["A", "C", "D", "E", "G", "B"]),
        ];
        let errors = super::skipped_property_errors(
            "/Game/P",
            &exports,
            super::SkippedPropertyDetail::Package,
        );
        let [error] = errors.as_slice() else {
            panic!("one aggregated entry");
        };
        assert_eq!((error.count, error.exports), (Some(10), Some(2)));
        assert_eq!(
            error.detail,
            "10 property value(s) in 2 export(s) not decoded; by type: A 3, B 2, C 1, D 1, E 1, \
             and 2 more type(s)"
        );
        assert!(
            super::skipped_property_errors("/Game/P", &[], super::SkippedPropertyDetail::Package)
                .is_empty()
        );
        assert_eq!(
            super::skipped_property_errors(
                "/Game/P",
                &exports,
                super::SkippedPropertyDetail::Export
            )
            .len(),
            2
        );
    }

    #[test]
    fn saved_world_reports_each_package_error_and_marks_affected_actors_partial() {
        let map = "Fixture/Offline/L_OfflineWorld";
        let (project_root, packages) = copy_fixture_map(map, "errors");
        let read = |path: &std::path::Path| read_package(path);

        // One package loses its actor export, another one of its actor's subobjects, and a third
        // cannot be parsed at all.
        let (lost_actor, damaged_component, unreadable) =
            (&packages[0], &packages[1], &packages[2]);
        let package = read(lost_actor);
        let actor = level_child_export(&package);
        let lost_actor_path = actor.object_path.to_string();
        overwrite_export_head(lost_actor, actor);
        let package = read(damaged_component);
        let actor_path = level_child_export(&package).object_path.to_string();
        let component = package
            .exports
            .iter()
            .find(|export| {
                export
                    .object_path
                    .as_str()
                    .starts_with(&format!("{actor_path}."))
                    && export.serial_size >= 8
            })
            .expect("actor subobject export");
        let component_path = component.object_path.to_string();
        overwrite_export_head(damaged_component, component);
        let unreadable_name = read(unreadable).summary.package_name.clone();
        std::fs::write(unreadable, [0_u8; 16]).expect("truncate package");

        let output = read_fixture_world(&project_root, map);
        let world = output.world;
        assert!(output.partial);
        assert_eq!(world.summary.partial_packages, 2);
        assert_eq!(world.summary.failed_packages, 1);

        let errors = &world.package_errors;
        assert_eq!(errors.len(), 3, "{errors:#?}");
        let lost = errors
            .iter()
            .find(|error| error.export.as_deref() == Some(lost_actor_path.as_str()))
            .expect("lost actor error");
        assert!(lost.category.starts_with("export_"), "{}", lost.category);
        assert!(lost.actor_dropped);
        assert!(!lost.detail.is_empty());
        let damaged = errors
            .iter()
            .find(|error| error.export.as_deref() == Some(component_path.as_str()))
            .expect("damaged component error");
        assert!(!damaged.actor_dropped);
        let whole = errors
            .iter()
            .find(|error| error.export.is_none())
            .expect("unreadable package error");
        assert_eq!(whole.package, unreadable_name);
        assert!(whole.category.starts_with("asset_"), "{}", whole.category);
        assert!(whole.actor_dropped);

        assert!(
            world
                .actors
                .iter()
                .all(|actor| actor.actor_path != lost_actor_path)
        );
        for actor in &world.actors {
            let expected = if actor.actor_path == actor_path {
                SavedWorldActorDecode::Partial
            } else {
                SavedWorldActorDecode::Complete
            };
            assert_eq!(actor.decode, Some(expected), "{}", actor.actor_path);
        }
    }

    #[test]
    fn failed_level_models_are_not_reported_as_dropped_actors() {
        let map = "Fixture/Cameras/L_CameraLoad";
        let (project_root, packages) = copy_fixture_map(map, "models");
        let [map_file] = packages.as_slice() else {
            panic!("a conventional map is one package");
        };
        let package = read_package(map_file);
        let level_child = |class: &str| {
            package
                .exports
                .iter()
                .filter(|export| {
                    super::outer_is_level(&package, export)
                        && export.class_path.as_ref().map(|path| path.as_str()) == Some(class)
                        && export.serial_size >= 8
                })
                .collect::<Vec<_>>()
        };
        let models = level_child("/Script/Engine.Model");
        let model_components = level_child("/Script/Engine.ModelComponent");
        assert!(!models.is_empty(), "the fixture level saves its BSP models");
        let actor = package
            .exports
            .iter()
            .find(|export| {
                super::outer_is_level(&package, export)
                    && export
                        .class_path
                        .as_ref()
                        .is_some_and(|path| path.as_str().ends_with("Actor"))
                    && export.serial_size >= 8
            })
            .expect("a level actor");
        for export in models.iter().chain(&model_components).chain([&actor]) {
            overwrite_export_head(map_file, export);
        }
        let not_actors: Vec<String> = models
            .iter()
            .chain(&model_components)
            .map(|export| export.object_path.to_string())
            .collect();
        let actor_path = actor.object_path.to_string();

        let world = read_fixture_world(&project_root, map).world;
        for path in &not_actors {
            let error = world
                .package_errors
                .iter()
                .find(|error| error.export.as_deref() == Some(path.as_str()))
                .unwrap_or_else(|| panic!("no package error for {path}"));
            assert!(error.category.starts_with("export_"), "{}", error.category);
            assert!(!error.actor_dropped, "{path} is not an actor");
        }
        let lost = world
            .package_errors
            .iter()
            .find(|error| error.export.as_deref() == Some(actor_path.as_str()))
            .expect("actor error");
        assert!(lost.actor_dropped);
    }

    #[test]
    fn actor_classification_rejects_known_non_actors_and_keeps_unknown_level_children() {
        let package = read_package(
            &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap"),
        );
        let level_child = package
            .exports
            .iter()
            .find(|export| super::outer_is_level(&package, export))
            .expect("a level child")
            .clone();
        let with_class = |class: &str| {
            let mut export = level_child.clone();
            export.class_path = Some(ObjectPath::new(class));
            export
        };
        for class in super::NON_ACTOR_LEVEL_CHILD_CLASSES {
            assert!(
                !super::may_be_actor_export(&package, &with_class(class)),
                "{class}"
            );
        }
        // The source model knows `Actor`, and an unclassifiable project class stays possible.
        assert!(super::may_be_actor_export(
            &package,
            &with_class("/Script/Engine.Actor")
        ));
        assert!(super::may_be_actor_export(
            &package,
            &with_class("/Script/Project.MysteryActor")
        ));
        // Anything not saved under a level is never an actor.
        let nested = package
            .exports
            .iter()
            .find(|export| !super::outer_is_level(&package, export))
            .expect("a nested export");
        assert!(!super::may_be_actor_export(&package, nested));
    }

    #[test]
    fn package_names_for_unreadable_files_follow_the_content_root() {
        let content = std::path::Path::new("C:/Project/Content");
        assert_eq!(
            super::package_name_from_path(
                &content.join("__ExternalActors__/Maps/L/0/AB/CDEF.uasset"),
                content
            ),
            "/Game/__ExternalActors__/Maps/L/0/AB/CDEF"
        );
        assert_eq!(
            super::package_name_from_path(std::path::Path::new("D:/Elsewhere/X.uasset"), content),
            "D:/Elsewhere/X.uasset"
        );
    }

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

    #[test]
    fn saved_world_honors_cancellation_before_filesystem_discovery() {
        let project_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/unreal-project");
        let request: Request = serde_json::from_value(serde_json::json!({
            "contract": { "name": "uasset-io", "version": { "major": 1, "minor": 0 } },
            "limits": { "concurrency": 1 },
            "operation": {
                "kind": "saved_world",
                "projectRoot": project_root.to_string_lossy(),
                "mapPath": "Content/Fixture/Offline/L_OfflineWorld.umap"
            },
            "requestId": "cancelled-saved-world"
        }))
        .expect("saved-world request");
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let failure = saved_world_with_cancellation(&request, &cancellation)
            .expect_err("pre-cancelled saved-world inspection");
        assert_eq!(failure.code, "cancelled");
        assert!(failure.message.contains("discovery"));
        assert!(failure.retry_safe);
    }
}
