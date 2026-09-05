//! Project Index refresh coordinator.
//!
//! Owns one-traversal refresh, signature comparison, header rebuild policy, Generation publication,
//! and bounded queries. Storage details stay behind the Catalog seam; filesystem details stay behind
//! the ProjectScanner seam so coordinator tests can inject deterministic fixtures.

use std::collections::{BTreeMap, BTreeSet};

use crate::cancellation::CancellationToken;

use super::catalog::{
    Catalog, CatalogDiagnostic, CatalogError, CatalogSnapshotEntry, CatalogStatus, Completeness,
    EntryKind, HeaderEvidence, INDEX_PROFILE_VERSION, PROJECT_INDEX_MAX_CLASSES,
    PROJECT_INDEX_MAX_DIAGNOSTICS, PROJECT_INDEX_MAX_NAMES, PackageSignature, QueryPage,
    QueryRequest, RefreshSummary, StagedPackage, project_id_from_root,
};
use super::{Failure, checkpoint};

const MAX_SIGNATURE_REVALIDATION_ATTEMPTS: usize = 3;
const PROGRESS_PACKAGE_INTERVAL: u64 = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshPhase {
    Enumerating,
    Comparing,
    ReadingHeaders,
    Committing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefreshProgress {
    pub phase: RefreshPhase,
    pub completed_packages: u64,
    pub total_packages: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefreshEvent {
    Started { rebuild: bool },
    Progress(RefreshProgress),
    Completed { summary: RefreshSummary },
}

/// Evidence and the signature observed immediately after reading it. Keep signature failures
/// separate: the coordinator propagates these, while header failures become partial evidence.
pub struct HeaderObservation {
    pub evidence: HeaderEvidence,
    pub signature: Result<Option<PackageSignature>, CoordinatorError>,
}

pub type HeaderEvidenceSink<'a> = dyn FnMut(
        &PackageSignature,
        Result<HeaderObservation, CoordinatorError>,
    ) -> Result<(), CoordinatorError>
    + 'a;

/// Filesystem/header probing boundary used by the coordinator.
pub trait ProjectScanner {
    fn enumerate(
        &self,
        project_root: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<PackageSignature>, CoordinatorError>;

    fn read_header_evidence(
        &self,
        project_root: &str,
        signature: &PackageSignature,
        cancellation: &CancellationToken,
    ) -> Result<HeaderEvidence, CoordinatorError>;

    /// Stream headers with their post-read signatures in signature order. The default preserves
    /// deterministic test scanners; filesystem adapters may read ahead with bounded parallelism.
    fn stream_header_evidence(
        &self,
        project_root: &str,
        signatures: &[PackageSignature],
        cancellation: &CancellationToken,
        on_header: &mut HeaderEvidenceSink<'_>,
    ) -> Result<(), CoordinatorError> {
        for signature in signatures {
            on_header(
                signature,
                observe_header(self, project_root, signature, cancellation),
            )?;
        }
        Ok(())
    }

    fn reread_signature(
        &self,
        project_root: &str,
        relative_path: &str,
        kind: EntryKind,
        cancellation: &CancellationToken,
    ) -> Result<Option<PackageSignature>, CoordinatorError>;
}

pub(crate) fn observe_header<S: ProjectScanner + ?Sized>(
    scanner: &S,
    project_root: &str,
    signature: &PackageSignature,
    cancellation: &CancellationToken,
) -> Result<HeaderObservation, CoordinatorError> {
    let evidence = scanner.read_header_evidence(project_root, signature, cancellation)?;
    checkpoint(cancellation, "read")?;
    let signature = scanner.reread_signature(
        project_root,
        &signature.relative_path,
        signature.kind,
        cancellation,
    );
    Ok(HeaderObservation {
        evidence,
        signature,
    })
}

/// Snapshot helper used by the coordinator to compute deletions without exposing SQL.
pub trait CatalogSnapshot: Catalog {
    fn committed_entries(&self) -> Result<Vec<CatalogSnapshotEntry>, CatalogError>;

    #[allow(dead_code)]
    fn committed_relative_paths(&self) -> Result<Vec<String>, CatalogError> {
        Ok(self
            .committed_entries()?
            .into_iter()
            .map(|entry| entry.signature.relative_path)
            .collect())
    }
}

#[derive(Debug)]
pub enum CoordinatorError {
    Catalog(CatalogError),
    Cancelled { message: String },
    Unavailable { message: String },
    InvalidRequest { message: String },
}

impl From<CatalogError> for CoordinatorError {
    fn from(value: CatalogError) -> Self {
        Self::Catalog(value)
    }
}

impl From<Failure> for CoordinatorError {
    fn from(value: Failure) -> Self {
        if value.code == "cancelled" {
            Self::Cancelled {
                message: value.message,
            }
        } else if value.code == "invalid_request" {
            Self::InvalidRequest {
                message: value.message,
            }
        } else {
            Self::Unavailable {
                message: value.message,
            }
        }
    }
}

impl std::fmt::Display for CoordinatorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Catalog(error) => write!(formatter, "{error}"),
            Self::Cancelled { message }
            | Self::Unavailable { message }
            | Self::InvalidRequest { message } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CoordinatorError {}

pub fn status<C: Catalog>(catalog: &C) -> CatalogStatus {
    catalog.status()
}

pub fn query<C: Catalog>(
    catalog: &C,
    request: &QueryRequest,
) -> Result<QueryPage, CoordinatorError> {
    Ok(catalog.query(request)?)
}

pub fn refresh<C: CatalogSnapshot, S: ProjectScanner>(
    catalog: &mut C,
    scanner: &S,
    project_root: &str,
    cancellation: &CancellationToken,
    mut on_progress: impl FnMut(RefreshProgress),
) -> Result<Vec<RefreshEvent>, CoordinatorError> {
    run_refresh(
        catalog,
        scanner,
        project_root,
        false,
        cancellation,
        &mut on_progress,
    )
}

pub fn rebuild<C: CatalogSnapshot, S: ProjectScanner>(
    catalog: &mut C,
    scanner: &S,
    project_root: &str,
    cancellation: &CancellationToken,
    mut on_progress: impl FnMut(RefreshProgress),
) -> Result<Vec<RefreshEvent>, CoordinatorError> {
    catalog.clear_for_rebuild()?;
    run_refresh(
        catalog,
        scanner,
        project_root,
        true,
        cancellation,
        &mut on_progress,
    )
}

fn run_refresh<C: CatalogSnapshot, S: ProjectScanner>(
    catalog: &mut C,
    scanner: &S,
    project_root: &str,
    rebuild: bool,
    cancellation: &CancellationToken,
    on_progress: &mut impl FnMut(RefreshProgress),
) -> Result<Vec<RefreshEvent>, CoordinatorError> {
    let project_id = project_id_from_root(project_root);
    let mut events = vec![RefreshEvent::Started { rebuild }];
    let prior_entries: BTreeMap<String, CatalogSnapshotEntry> = catalog
        .committed_entries()?
        .into_iter()
        .map(|entry| (entry.signature.relative_path.clone(), entry))
        .collect();
    let mut token = Some(catalog.begin_refresh()?);
    let result = (|| {
        let staging = token
            .as_ref()
            .expect("staging token present for refresh body");
        checkpoint(cancellation, "discovery")?;
        let enumerated = scanner.enumerate(project_root, cancellation)?;
        let total_packages = enumerated
            .iter()
            .filter(|entry| entry.kind == EntryKind::Package)
            .count() as u64;
        emit_progress(
            &mut events,
            on_progress,
            RefreshPhase::Enumerating,
            0,
            Some(total_packages),
        );

        let mut changed_packages = 0_u64;
        let mut package_count = 0_u64;
        let mut map_count = 0_u64;
        let mut diagnostics = Vec::new();
        let mut completed_packages = 0_u64;
        let mut changed_entries = Vec::new();
        let observed: BTreeSet<_> = enumerated
            .iter()
            .map(|signature| signature.relative_path.clone())
            .collect();

        emit_progress(
            &mut events,
            on_progress,
            RefreshPhase::Comparing,
            0,
            Some(total_packages),
        );
        for signature in &enumerated {
            checkpoint(cancellation, "read")?;
            if signature.kind == EntryKind::Package {
                completed_packages += 1;
            }
            let prior = prior_entries.get(&signature.relative_path);
            let can_reuse = prior.is_some_and(|prior| {
                prior.signature == *signature
                    && (signature.kind == EntryKind::Sidecar
                        || (prior.header_profile_version == Some(INDEX_PROFILE_VERSION)
                            && !prior.header_failure))
            });

            if can_reuse {
                catalog.observe_unchanged(staging, &signature.relative_path)?;
            } else {
                if signature.kind == EntryKind::Package {
                    changed_packages += 1;
                }
                changed_entries.push(signature.clone());
            }

            if signature.kind == EntryKind::Package {
                package_count += 1;
                if signature
                    .relative_path
                    .to_ascii_lowercase()
                    .ends_with(".umap")
                {
                    map_count += 1;
                }
            }
            if should_emit_package_progress(completed_packages, total_packages) {
                emit_progress(
                    &mut events,
                    on_progress,
                    RefreshPhase::Comparing,
                    completed_packages,
                    Some(total_packages),
                );
            }
        }

        let removed_packages = prior_entries
            .values()
            .filter(|entry| {
                entry.signature.kind == EntryKind::Package
                    && !observed.contains(&entry.signature.relative_path)
            })
            .count() as u64;

        emit_progress(
            &mut events,
            on_progress,
            RefreshPhase::ReadingHeaders,
            0,
            Some(changed_packages),
        );
        let mut completed_headers = 0_u64;
        let mut changed_package_entries = Vec::with_capacity(changed_packages as usize);
        for signature in changed_entries {
            if signature.kind == EntryKind::Sidecar {
                catalog.stage_observed(
                    staging,
                    StagedPackage {
                        signature,
                        header: None,
                    },
                )?;
            } else {
                changed_package_entries.push(signature);
            }
        }
        scanner.stream_header_evidence(
            project_root,
            &changed_package_entries,
            cancellation,
            &mut |signature, header_result| {
                checkpoint(cancellation, "inspection")?;
                let staged = stage_with_initial_header(
                    scanner,
                    project_root,
                    signature,
                    header_result,
                    cancellation,
                    &mut diagnostics,
                )?;
                completed_headers += 1;
                if should_emit_package_progress(completed_headers, changed_packages) {
                    emit_progress(
                        &mut events,
                        on_progress,
                        RefreshPhase::ReadingHeaders,
                        completed_headers,
                        Some(changed_packages),
                    );
                }
                catalog.stage_observed(staging, staged)?;
                Ok(())
            },
        )?;

        if diagnostics.len() > PROJECT_INDEX_MAX_DIAGNOSTICS {
            diagnostics.truncate(PROJECT_INDEX_MAX_DIAGNOSTICS);
        }
        emit_progress(
            &mut events,
            on_progress,
            RefreshPhase::Committing,
            completed_packages,
            Some(total_packages),
        );
        let summary = RefreshSummary {
            project_id,
            generation: staging.generation,
            package_count,
            map_count,
            changed_packages,
            removed_packages,
            completeness: if diagnostics.is_empty() {
                Completeness::Complete
            } else {
                Completeness::Partial
            },
            diagnostics,
        };
        let staging = token.take().expect("staging token present for commit");
        catalog.commit_refresh(staging, summary.clone())?;
        events.push(RefreshEvent::Completed { summary });
        Ok(events)
    })();

    match result {
        Ok(events) => Ok(events),
        Err(error) => {
            if let Some(staging) = token.take() {
                let _ = catalog.discard_refresh(staging);
            }
            Err(error)
        }
    }
}

fn stage_with_initial_header<S: ProjectScanner>(
    scanner: &S,
    project_root: &str,
    signature: &PackageSignature,
    first: Result<HeaderObservation, CoordinatorError>,
    cancellation: &CancellationToken,
    diagnostics: &mut Vec<CatalogDiagnostic>,
) -> Result<StagedPackage, CoordinatorError> {
    let mut current = signature.clone();
    let mut next_header = Some(first);
    for _ in 0..MAX_SIGNATURE_REVALIDATION_ATTEMPTS {
        checkpoint(cancellation, "inspection")?;
        let result = next_header
            .take()
            .unwrap_or_else(|| observe_header(scanner, project_root, &current, cancellation));
        let (header, revalidated) = match result {
            Ok(HeaderObservation {
                mut evidence,
                signature,
            }) => {
                evidence.profile_version = INDEX_PROFILE_VERSION;
                evidence.classes.truncate(PROJECT_INDEX_MAX_CLASSES);
                evidence.serialized_names.truncate(PROJECT_INDEX_MAX_NAMES);
                (evidence, signature)
            }
            Err(CoordinatorError::Cancelled { message }) => {
                return Err(CoordinatorError::Cancelled { message });
            }
            Err(_) => {
                push_diagnostic(
                    diagnostics,
                    "header_read",
                    format!(
                        "could not read header evidence for {}",
                        current.relative_path
                    ),
                    true,
                );
                return Ok(StagedPackage {
                    signature: current,
                    header: Some(HeaderEvidence {
                        profile_version: INDEX_PROFILE_VERSION,
                        package_name: String::new(),
                        classes: Vec::new(),
                        serialized_names: Vec::new(),
                        failure_code: Some("header_read".to_owned()),
                    }),
                });
            }
        };
        checkpoint(cancellation, "read")?;
        match revalidated? {
            Some(next) if next == current => {
                return Ok(StagedPackage {
                    signature: current,
                    header: Some(header),
                });
            }
            Some(next) => current = next,
            None => {
                push_diagnostic(
                    diagnostics,
                    "signature_missing",
                    format!(
                        "package disappeared during header read: {}",
                        current.relative_path
                    ),
                    true,
                );
                return Err(CoordinatorError::Unavailable {
                    message: format!(
                        "package disappeared during header read: {}",
                        signature.relative_path
                    ),
                });
            }
        }
    }
    push_diagnostic(
        diagnostics,
        "signature_unstable",
        format!(
            "package signature kept changing during header read: {}",
            signature.relative_path
        ),
        true,
    );
    Err(CoordinatorError::Unavailable {
        message: format!(
            "package signature kept changing during header read: {}",
            signature.relative_path
        ),
    })
}

fn push_diagnostic(
    diagnostics: &mut Vec<CatalogDiagnostic>,
    code: &str,
    message: String,
    retry_safe: bool,
) {
    if diagnostics.len() >= PROJECT_INDEX_MAX_DIAGNOSTICS {
        return;
    }
    diagnostics.push(CatalogDiagnostic {
        code: code.to_owned(),
        message,
        retry_safe,
    });
}

fn emit_progress(
    events: &mut Vec<RefreshEvent>,
    on_progress: &mut impl FnMut(RefreshProgress),
    phase: RefreshPhase,
    completed_packages: u64,
    total_packages: Option<u64>,
) {
    let progress = RefreshProgress {
        phase,
        completed_packages,
        total_packages,
    };
    on_progress(progress.clone());
    events.push(RefreshEvent::Progress(progress));
}

fn should_emit_package_progress(completed: u64, total: u64) -> bool {
    completed > 0 && (completed == total || completed.is_multiple_of(PROGRESS_PACKAGE_INTERVAL))
}

/// The coordinator is proven through the adapter-neutral Catalog conformance suite. Every storage
/// adapter runs the same suite unchanged, so coordinator tests never name a storage implementation.
#[cfg(test)]
mod tests {
    use super::{PROGRESS_PACKAGE_INTERVAL, should_emit_package_progress};
    use crate::direct_executor::catalog_conformance::catalog_conformance_tests;
    use crate::direct_executor::catalog_memory::MemoryCatalog;

    catalog_conformance_tests!(memory_adapter, MemoryCatalog::new);

    #[test]
    fn worker_signature_error_is_propagated_without_publishing_partial_evidence() {
        use super::*;
        use crate::direct_executor::catalog_conformance::FakeScanner;

        let signature = PackageSignature {
            relative_path: "Content/A.uasset".to_owned(),
            kind: EntryKind::Package,
            size: 1,
            modified_nanos: 1,
        };
        let first = Ok(HeaderObservation {
            evidence: HeaderEvidence {
                profile_version: INDEX_PROFILE_VERSION,
                package_name: "/Game/A".to_owned(),
                classes: Vec::new(),
                serialized_names: Vec::new(),
                failure_code: None,
            },
            signature: Err(CoordinatorError::Unavailable {
                message: "signature read failed".to_owned(),
            }),
        });
        let scanner = FakeScanner::default();
        let mut diagnostics = Vec::new();
        let error = stage_with_initial_header(
            &scanner,
            "C:/Fixture",
            &signature,
            first,
            &CancellationToken::new(),
            &mut diagnostics,
        )
        .expect_err("signature errors must abort refresh");
        assert_eq!(error.to_string(), "signature read failed");
        assert!(diagnostics.is_empty());
        assert_eq!(scanner.header_reads.get(), 0);
    }

    #[test]
    fn package_progress_is_bounded_by_fixed_intervals() {
        assert!(!should_emit_package_progress(0, 10_000));
        assert!(!should_emit_package_progress(1, 10_000));
        assert!(should_emit_package_progress(
            PROGRESS_PACKAGE_INTERVAL,
            10_000
        ));
        assert!(should_emit_package_progress(10_000, 10_000));
    }
}
