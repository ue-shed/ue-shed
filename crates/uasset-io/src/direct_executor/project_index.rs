//! Project Index refresh coordinator.
//!
//! Owns one-traversal refresh, signature comparison, header rebuild policy, Generation publication,
//! and bounded queries. Storage details stay behind the Catalog seam; filesystem details stay behind
//! the ProjectScanner seam so coordinator tests can inject deterministic fixtures.

use std::collections::{BTreeMap, BTreeSet};

use crate::cancellation::CancellationToken;

use super::catalog::{
    Catalog, CatalogDiagnostic, CatalogError, CatalogStatus, Completeness, EntryKind,
    HeaderEvidence, INDEX_PROFILE_VERSION, PROJECT_INDEX_MAX_CLASSES,
    PROJECT_INDEX_MAX_DIAGNOSTICS, PROJECT_INDEX_MAX_NAMES, PackageSignature, QueryPage,
    QueryRequest, RefreshSummary, StagedPackage, project_id_from_root,
};
use super::{Failure, checkpoint};

const MAX_SIGNATURE_REVALIDATION_ATTEMPTS: usize = 3;

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

    fn reread_signature(
        &self,
        project_root: &str,
        relative_path: &str,
        kind: EntryKind,
        cancellation: &CancellationToken,
    ) -> Result<Option<PackageSignature>, CoordinatorError>;
}

/// Snapshot helper used by the coordinator to compute deletions without exposing SQL.
pub trait CatalogSnapshot: Catalog {
    fn committed_relative_paths(&self) -> Vec<String>;
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
    let prior_paths: BTreeSet<String> = catalog.committed_relative_paths().into_iter().collect();
    let prior_packages: BTreeMap<String, PackageSignature> = prior_paths
        .iter()
        .filter_map(|path| {
            catalog
                .lookup_committed(path)
                .map(|(signature, _)| (path.clone(), signature))
        })
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

        for signature in &enumerated {
            checkpoint(cancellation, "read")?;
            if signature.kind == EntryKind::Package {
                completed_packages += 1;
            }
            emit_progress(
                &mut events,
                on_progress,
                RefreshPhase::Comparing,
                completed_packages,
                Some(total_packages),
            );

            let prior = catalog.lookup_committed(&signature.relative_path);
            let can_reuse = matches!(
                &prior,
                Some((prior_signature, Some(header)))
                    if prior_signature == signature && header.matches_profile()
            );

            let staged = if signature.kind == EntryKind::Sidecar {
                StagedPackage {
                    signature: signature.clone(),
                    header: None,
                }
            } else if can_reuse {
                StagedPackage {
                    signature: signature.clone(),
                    header: prior.and_then(|(_, header)| header),
                }
            } else {
                emit_progress(
                    &mut events,
                    on_progress,
                    RefreshPhase::ReadingHeaders,
                    completed_packages,
                    Some(total_packages),
                );
                let staged = stage_with_revalidation(
                    scanner,
                    project_root,
                    signature,
                    cancellation,
                    &mut diagnostics,
                )?;
                changed_packages += 1;
                staged
            };

            if staged.signature.kind == EntryKind::Package {
                package_count += 1;
                if staged
                    .signature
                    .relative_path
                    .to_ascii_lowercase()
                    .ends_with(".umap")
                {
                    map_count += 1;
                }
            }
            catalog.stage_observed(staging, staged)?;
        }

        let observed: BTreeSet<_> = enumerated
            .iter()
            .map(|signature| signature.relative_path.clone())
            .collect();
        let removed_packages = prior_packages
            .iter()
            .filter(|(path, signature)| {
                signature.kind == EntryKind::Package && !observed.contains(*path)
            })
            .count() as u64;

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

fn stage_with_revalidation<S: ProjectScanner>(
    scanner: &S,
    project_root: &str,
    signature: &PackageSignature,
    cancellation: &CancellationToken,
    diagnostics: &mut Vec<CatalogDiagnostic>,
) -> Result<StagedPackage, CoordinatorError> {
    let mut current = signature.clone();
    for _ in 0..MAX_SIGNATURE_REVALIDATION_ATTEMPTS {
        checkpoint(cancellation, "inspection")?;
        let header = match scanner.read_header_evidence(project_root, &current, cancellation) {
            Ok(mut evidence) => {
                evidence.profile_version = INDEX_PROFILE_VERSION;
                evidence.classes.truncate(PROJECT_INDEX_MAX_CLASSES);
                evidence.serialized_names.truncate(PROJECT_INDEX_MAX_NAMES);
                evidence
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
        let revalidated = scanner.reread_signature(
            project_root,
            &current.relative_path,
            current.kind,
            cancellation,
        )?;
        match revalidated {
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

/// Test-only helpers kept next to the coordinator so conformance stays adapter-neutral.
#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;
    use crate::direct_executor::catalog::{
        CatalogError, CatalogStatus, EntryKind, Generation, HeaderEvidence, INDEX_PROFILE_VERSION,
        PackageSignature, ProjectId, QueryKind, QueryRequest,
    };
    use crate::direct_executor::catalog_memory::MemoryCatalog;

    #[derive(Default)]
    struct FakeScanner {
        entries: Vec<PackageSignature>,
        headers: BTreeMap<String, HeaderEvidence>,
        reread: BTreeMap<String, PackageSignature>,
        header_reads: std::cell::Cell<u64>,
        fail_after_header: BTreeSet<String>,
        unstable: BTreeSet<String>,
    }

    impl ProjectScanner for FakeScanner {
        fn enumerate(
            &self,
            _project_root: &str,
            cancellation: &CancellationToken,
        ) -> Result<Vec<PackageSignature>, CoordinatorError> {
            checkpoint(cancellation, "discovery")?;
            Ok(self.entries.clone())
        }

        fn read_header_evidence(
            &self,
            _project_root: &str,
            signature: &PackageSignature,
            cancellation: &CancellationToken,
        ) -> Result<HeaderEvidence, CoordinatorError> {
            checkpoint(cancellation, "inspection")?;
            self.header_reads.set(self.header_reads.get() + 1);
            if self.fail_after_header.contains(&signature.relative_path) {
                return Err(CoordinatorError::Unavailable {
                    message: "injected header failure".to_owned(),
                });
            }
            self.headers
                .get(&signature.relative_path)
                .cloned()
                .ok_or_else(|| CoordinatorError::Unavailable {
                    message: format!("missing header fixture for {}", signature.relative_path),
                })
        }

        fn reread_signature(
            &self,
            _project_root: &str,
            relative_path: &str,
            kind: EntryKind,
            cancellation: &CancellationToken,
        ) -> Result<Option<PackageSignature>, CoordinatorError> {
            checkpoint(cancellation, "read")?;
            if self.unstable.contains(relative_path) {
                let mut next = self
                    .reread
                    .get(relative_path)
                    .cloned()
                    .or_else(|| {
                        self.entries
                            .iter()
                            .find(|entry| entry.relative_path == relative_path)
                            .cloned()
                    })
                    .unwrap_or(PackageSignature {
                        relative_path: relative_path.to_owned(),
                        kind,
                        size: 1,
                        modified_nanos: 1,
                    });
                // Keep changing after every header read so revalidation cannot settle.
                next.modified_nanos = next
                    .modified_nanos
                    .saturating_add(self.header_reads.get().max(1));
                return Ok(Some(next));
            }
            Ok(self.reread.get(relative_path).cloned().or_else(|| {
                self.entries
                    .iter()
                    .find(|entry| entry.relative_path == relative_path)
                    .cloned()
            }))
        }
    }

    fn package(path: &str, size: u64, modified_nanos: u64) -> PackageSignature {
        PackageSignature {
            relative_path: path.to_owned(),
            kind: EntryKind::Package,
            size,
            modified_nanos,
        }
    }

    fn sidecar(path: &str, size: u64, modified_nanos: u64) -> PackageSignature {
        PackageSignature {
            relative_path: path.to_owned(),
            kind: EntryKind::Sidecar,
            size,
            modified_nanos,
        }
    }

    fn header(package_name: &str, classes: &[&str], names: &[&str]) -> HeaderEvidence {
        HeaderEvidence {
            profile_version: INDEX_PROFILE_VERSION,
            package_name: package_name.to_owned(),
            classes: classes.iter().map(|value| (*value).to_owned()).collect(),
            serialized_names: names.iter().map(|value| (*value).to_owned()).collect(),
            failure_code: None,
        }
    }

    fn completed_summary(events: &[RefreshEvent]) -> RefreshSummary {
        events
            .iter()
            .find_map(|event| match event {
                RefreshEvent::Completed { summary } => Some(summary.clone()),
                _ => None,
            })
            .expect("refresh completed")
    }

    #[test]
    fn cold_refresh_then_warm_noop_reads_zero_headers() {
        let mut catalog = MemoryCatalog::new();
        let scanner = FakeScanner {
            entries: vec![
                package("Content/Maps/L_Fixture.umap", 10, 100),
                package("Content/Data/DT_Items.uasset", 20, 200),
                sidecar("Content/Data/DT_Items.uexp", 5, 200),
            ],
            headers: BTreeMap::from([
                (
                    "Content/Maps/L_Fixture.umap".to_owned(),
                    header("/Game/Maps/L_Fixture", &[], &[]),
                ),
                (
                    "Content/Data/DT_Items.uasset".to_owned(),
                    header(
                        "/Game/Data/DT_Items",
                        &["/Script/Engine.DataTable"],
                        &["TextProperty"],
                    ),
                ),
            ]),
            ..FakeScanner::default()
        };

        let cold = refresh(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect("cold refresh");
        let cold_summary = completed_summary(&cold);
        assert_eq!(cold_summary.generation, Generation::new(1));
        assert_eq!(cold_summary.package_count, 2);
        assert_eq!(cold_summary.map_count, 1);
        assert_eq!(cold_summary.changed_packages, 2);
        assert_eq!(scanner.header_reads.get(), 2);

        let warm = refresh(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect("warm refresh");
        let warm_summary = completed_summary(&warm);
        assert_eq!(warm_summary.generation, Generation::new(2));
        assert_eq!(warm_summary.changed_packages, 0);
        assert_eq!(warm_summary.removed_packages, 0);
        assert_eq!(scanner.header_reads.get(), 2);
    }

    #[test]
    fn rebuild_clears_generation_before_cold_refresh() {
        let mut catalog = MemoryCatalog::new();
        let scanner = FakeScanner {
            entries: vec![package("Content/A.uasset", 10, 1)],
            headers: BTreeMap::from([(
                "Content/A.uasset".to_owned(),
                header("/Game/A", &["/Script/Engine.DataTable"], &[]),
            )]),
            ..FakeScanner::default()
        };
        let first = refresh(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect("initial refresh");
        assert_eq!(completed_summary(&first).generation, Generation::new(1));
        let warm = refresh(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect("warm refresh");
        assert_eq!(completed_summary(&warm).generation, Generation::new(2));

        let rebuilt = rebuild(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect("rebuild");
        assert_eq!(completed_summary(&rebuilt).generation, Generation::new(1));
    }

    #[test]
    fn changed_deleted_renamed_and_sidecar_updates_are_detected() {
        let mut catalog = MemoryCatalog::new();
        let mut scanner = FakeScanner {
            entries: vec![
                package("Content/A.uasset", 10, 1),
                package("Content/B.uasset", 10, 1),
                sidecar("Content/A.uexp", 2, 1),
            ],
            headers: BTreeMap::from([
                (
                    "Content/A.uasset".to_owned(),
                    header("/Game/A", &["/Script/Engine.DataTable"], &[]),
                ),
                (
                    "Content/B.uasset".to_owned(),
                    header("/Game/B", &["/Script/Engine.Texture2D"], &[]),
                ),
            ]),
            ..FakeScanner::default()
        };
        refresh(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect("initial refresh");

        scanner.entries = vec![
            package("Content/A.uasset", 11, 2), // changed
            package("Content/C.uasset", 10, 1), // rename B -> C
            sidecar("Content/A.uexp", 3, 2),    // sidecar-only change
        ];
        scanner.headers.insert(
            "Content/A.uasset".to_owned(),
            header("/Game/A", &["/Script/Engine.DataTable"], &["RowStruct"]),
        );
        scanner.headers.insert(
            "Content/C.uasset".to_owned(),
            header("/Game/C", &["/Script/Engine.Texture2D"], &[]),
        );

        let events = refresh(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect("delta refresh");
        let summary = completed_summary(&events);
        assert_eq!(summary.changed_packages, 2);
        assert_eq!(summary.removed_packages, 1);
        assert_eq!(summary.package_count, 2);
        assert_eq!(scanner.header_reads.get(), 4); // 2 cold + A + C

        let page = query(
            &catalog,
            &QueryRequest {
                project_id: ProjectId::new("c:/fixture"),
                expected_generation: summary.generation,
                kind: QueryKind::ExactClasses {
                    values: vec!["/Script/Engine.DataTable".to_owned()],
                },
                limit: 10,
                cursor: None,
            },
        )
        .expect("query");
        assert_eq!(page.items.len(), 1);
    }

    #[test]
    fn cancellation_discards_staging_and_keeps_prior_generation() {
        let mut catalog = MemoryCatalog::new();
        let scanner = FakeScanner {
            entries: vec![package("Content/A.uasset", 10, 1)],
            headers: BTreeMap::from([(
                "Content/A.uasset".to_owned(),
                header("/Game/A", &["/Script/Engine.DataTable"], &[]),
            )]),
            ..FakeScanner::default()
        };
        let first = refresh(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect("first refresh");
        let generation = completed_summary(&first).generation;

        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let error = refresh(&mut catalog, &scanner, "C:/Fixture", &cancellation, |_| {})
            .expect_err("cancelled refresh");
        assert!(matches!(error, CoordinatorError::Cancelled { .. }));
        assert_eq!(catalog.committed_generation(), Some(generation));
        assert!(
            query(
                &catalog,
                &QueryRequest {
                    project_id: ProjectId::new("c:/fixture"),
                    expected_generation: generation,
                    kind: QueryKind::Maps,
                    limit: 10,
                    cursor: None,
                },
            )
            .is_ok()
        );
    }

    #[test]
    fn stale_generation_queries_fail_explicitly_and_ordering_is_stable() {
        let mut catalog = MemoryCatalog::new();
        let scanner = FakeScanner {
            entries: vec![
                package("Content/B.uasset", 10, 1),
                package("Content/A.uasset", 10, 1),
            ],
            headers: BTreeMap::from([
                (
                    "Content/A.uasset".to_owned(),
                    header("/Game/A", &["/Script/Engine.DataTable"], &[]),
                ),
                (
                    "Content/B.uasset".to_owned(),
                    header("/Game/B", &["/Script/Engine.DataTable"], &[]),
                ),
            ]),
            ..FakeScanner::default()
        };
        let summary = completed_summary(
            &refresh(
                &mut catalog,
                &scanner,
                "C:/Fixture",
                &CancellationToken::new(),
                |_| {},
            )
            .expect("refresh"),
        );
        let page = query(
            &catalog,
            &QueryRequest {
                project_id: ProjectId::new("c:/fixture"),
                expected_generation: summary.generation,
                kind: QueryKind::ExactClasses {
                    values: vec!["/Script/Engine.DataTable".to_owned()],
                },
                limit: 10,
                cursor: None,
            },
        )
        .expect("page");
        let paths = page
            .items
            .iter()
            .map(|item| match item {
                crate::direct_executor::catalog::QueryItem::Header { package_path, .. } => {
                    package_path.as_str()
                }
                _ => "",
            })
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec!["Content/A.uasset", "Content/B.uasset"] // BTreeMap path order
        );

        let stale = query(
            &catalog,
            &QueryRequest {
                project_id: ProjectId::new("c:/fixture"),
                expected_generation: Generation::new(99),
                kind: QueryKind::Maps,
                limit: 10,
                cursor: None,
            },
        )
        .expect_err("stale");
        assert!(matches!(
            stale,
            CoordinatorError::Catalog(CatalogError::StaleGeneration { .. })
        ));
    }

    #[test]
    fn signature_revalidation_rejects_unstable_packages() {
        let mut catalog = MemoryCatalog::new();
        let scanner = FakeScanner {
            entries: vec![package("Content/A.uasset", 10, 1)],
            headers: BTreeMap::from([(
                "Content/A.uasset".to_owned(),
                header("/Game/A", &["/Script/Engine.DataTable"], &[]),
            )]),
            unstable: BTreeSet::from(["Content/A.uasset".to_owned()]),
            ..FakeScanner::default()
        };
        let error = refresh(
            &mut catalog,
            &scanner,
            "C:/Fixture",
            &CancellationToken::new(),
            |_| {},
        )
        .expect_err("unstable signature");
        assert!(matches!(error, CoordinatorError::Unavailable { .. }));
        assert!(matches!(catalog.status(), CatalogStatus::Absent));
    }
}
