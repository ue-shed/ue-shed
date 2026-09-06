//! Protocol-facing Project Index execution.
//!
//! Opens the production Catalog adapter, drives the storage-neutral coordinator, and converts
//! Catalog values into protocol result frames. Storage details stay inside the Catalog adapter.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::cancellation::CancellationToken;
use crate::protocol::ProjectIndexQuery as ProtocolQuery;
use crate::protocol_result::{
    ProjectIndexCompleteness, ProjectIndexDiagnostic, ProjectIndexItem, ProjectIndexPage,
    ProjectIndexStatusPayload, ProjectIndexSummary,
};

use super::Failure;
use super::catalog::{
    CatalogError, CatalogStatus, Completeness, Generation, ProjectId, QueryItem, QueryKind,
    QueryRequest, RefreshSummary, project_id_from_root,
};
use super::catalog_sqlite::SqliteCatalog;
use super::project_index::{self, CoordinatorError, RefreshEvent, RefreshPhase, RefreshProgress};
use super::scanner::FilesystemProjectScanner;

pub(crate) struct ProjectIndexRefreshOutput {
    pub(crate) summary: ProjectIndexSummary,
    pub(crate) diagnostics: Vec<ProjectIndexDiagnostic>,
    pub(crate) write_counts: CatalogWriteEvidence,
    pub(crate) phase_timings: ProjectIndexPhaseTimings,
    pub(crate) duration_ms: u64,
    pub(crate) storage_bytes: u64,
    pub(crate) rebuild: bool,
}

#[derive(Default)]
pub(crate) struct ProjectIndexQuerySession {
    active: Option<ActiveQueryCatalog>,
}

struct ActiveQueryCatalog {
    cache_root: String,
    expected_generation: u64,
    project_id: String,
    catalog: SqliteCatalog,
}

impl ProjectIndexQuerySession {
    pub(crate) fn query(
        &mut self,
        cache_root: &str,
        query: &ProtocolQuery,
    ) -> Result<ProjectIndexPage, Failure> {
        let project_id = query_project_id(query);
        let expected_generation = query_expected_generation(query);
        let requires_open = self.active.as_ref().is_none_or(|active| {
            active.cache_root != cache_root
                || active.project_id != project_id
                || active.expected_generation != expected_generation
        });
        if requires_open {
            self.active = Some(ActiveQueryCatalog {
                cache_root: cache_root.to_owned(),
                expected_generation,
                project_id: project_id.to_owned(),
                catalog: open_catalog_for_project_id(cache_root, project_id)?,
            });
        }
        let active = self.active.as_ref().expect("query Catalog was initialized");
        query_catalog(&active.catalog, query)
    }
}

/// Aggregate refresh phase timings for benchmark attribution. These values are intentionally
/// path-free and describe the coordinator's observable phases rather than Catalog internals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProjectIndexPhaseTimings {
    pub(crate) enumerating_ms: u64,
    pub(crate) comparing_ms: u64,
    pub(crate) reading_headers_ms: u64,
    pub(crate) committing_ms: u64,
}

#[derive(Clone, Copy, Debug, Default)]
struct ProjectIndexPhaseDurations {
    enumerating: Duration,
    comparing: Duration,
    reading_headers: Duration,
    committing: Duration,
}

impl ProjectIndexPhaseDurations {
    fn add(&mut self, phase: RefreshPhase, elapsed: Duration) {
        match phase {
            RefreshPhase::Enumerating => self.enumerating += elapsed,
            RefreshPhase::Comparing => self.comparing += elapsed,
            RefreshPhase::ReadingHeaders => self.reading_headers += elapsed,
            RefreshPhase::Committing => self.committing += elapsed,
        }
    }

    fn into_millis(self) -> ProjectIndexPhaseTimings {
        ProjectIndexPhaseTimings {
            enumerating_ms: self.enumerating.as_millis() as u64,
            comparing_ms: self.comparing.as_millis() as u64,
            reading_headers_ms: self.reading_headers.as_millis() as u64,
            committing_ms: self.committing.as_millis() as u64,
        }
    }
}

/// Bounded Catalog write evidence for telemetry. Never includes paths or asset identities.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CatalogWriteEvidence {
    pub(crate) staged_evidence_rows: u64,
    pub(crate) committed_evidence_rows: u64,
    pub(crate) removed_evidence_rows: u64,
    pub(crate) evidence_write_ms: u64,
}

pub(crate) fn open_catalog(cache_root: &str, project_root: &str) -> Result<SqliteCatalog, Failure> {
    open_catalog_for_id(cache_root, &project_id_from_root(project_root))
}

pub(crate) fn open_catalog_for_id(
    cache_root: &str,
    project_id: &ProjectId,
) -> Result<SqliteCatalog, Failure> {
    SqliteCatalog::open(Path::new(cache_root), project_id).map_err(catalog_to_failure)
}

pub(crate) fn open_catalog_for_project_id(
    cache_root: &str,
    project_id: &str,
) -> Result<SqliteCatalog, Failure> {
    // Query pages are bounded reads; avoid a full integrity scan for every page-sized worker.
    // Refresh/status opens retain the checked path above and recover corrupted catalogs.
    SqliteCatalog::open_for_query(Path::new(cache_root), &ProjectId::new(project_id))
        .map_err(catalog_to_failure)
}

pub(crate) fn catalog_was_quarantined(catalog: &SqliteCatalog) -> bool {
    catalog.quarantined_from().is_some()
}

pub(crate) fn query_project_id(query: &ProtocolQuery) -> &str {
    match query {
        ProtocolQuery::Count { project_id, .. }
        | ProtocolQuery::Maps { project_id, .. }
        | ProtocolQuery::ExactClasses { project_id, .. }
        | ProtocolQuery::ClassPrefixes { project_id, .. }
        | ProtocolQuery::ClassNameSuffixes { project_id, .. }
        | ProtocolQuery::SerializedNames { project_id, .. } => project_id,
    }
}

fn query_expected_generation(query: &ProtocolQuery) -> u64 {
    match query {
        ProtocolQuery::Count {
            expected_generation,
            ..
        }
        | ProtocolQuery::Maps {
            expected_generation,
            ..
        }
        | ProtocolQuery::ExactClasses {
            expected_generation,
            ..
        }
        | ProtocolQuery::ClassPrefixes {
            expected_generation,
            ..
        }
        | ProtocolQuery::ClassNameSuffixes {
            expected_generation,
            ..
        }
        | ProtocolQuery::SerializedNames {
            expected_generation,
            ..
        } => *expected_generation,
    }
}

pub(crate) fn status(catalog: &SqliteCatalog) -> ProjectIndexStatusPayload {
    match project_index::status(catalog) {
        CatalogStatus::Absent => ProjectIndexStatusPayload::Absent,
        CatalogStatus::Ready { summary } => ProjectIndexStatusPayload::Ready {
            summary: to_protocol_summary(summary),
        },
    }
}

pub(crate) fn query(
    catalog: &SqliteCatalog,
    query: &ProtocolQuery,
) -> Result<ProjectIndexPage, Failure> {
    query_catalog(catalog, query)
}

fn query_catalog(
    catalog: &SqliteCatalog,
    query: &ProtocolQuery,
) -> Result<ProjectIndexPage, Failure> {
    let request = to_catalog_query(query)?;
    let page = project_index::query(catalog, &request).map_err(coordinator_to_failure)?;
    Ok(ProjectIndexPage {
        generation: page.generation.get(),
        items: page.items.into_iter().map(to_protocol_item).collect(),
        next_cursor: page.next_cursor,
        project_id: page.project_id.to_string(),
    })
}

pub(crate) fn refresh(
    catalog: &mut SqliteCatalog,
    project_root: &str,
    rebuild: bool,
    cancellation: &CancellationToken,
    mut on_progress: impl FnMut(RefreshProgress),
) -> Result<ProjectIndexRefreshOutput, Failure> {
    let scanner = FilesystemProjectScanner;
    let started = Instant::now();
    let mut phase_durations = ProjectIndexPhaseDurations::default();
    let mut current_phase = RefreshPhase::Enumerating;
    let mut phase_started = Instant::now();
    let mut record_progress = |progress: RefreshProgress| {
        phase_durations.add(current_phase, phase_started.elapsed());
        current_phase = progress.phase;
        phase_started = Instant::now();
        on_progress(progress);
    };
    let events = if rebuild {
        project_index::rebuild(
            catalog,
            &scanner,
            project_root,
            cancellation,
            &mut record_progress,
        )
    } else {
        project_index::refresh(
            catalog,
            &scanner,
            project_root,
            cancellation,
            &mut record_progress,
        )
    }
    .map_err(coordinator_to_failure)?;
    phase_durations.add(current_phase, phase_started.elapsed());
    let phase_timings = phase_durations.into_millis();
    let summary = events
        .into_iter()
        .rev()
        .find_map(|event| match event {
            RefreshEvent::Completed { summary } => Some(summary),
            _ => None,
        })
        .ok_or_else(|| {
            Failure::new(
                "unavailable",
                "Project Index refresh completed without a summary",
                true,
            )
        })?;
    let writes = catalog.write_counts();
    Ok(ProjectIndexRefreshOutput {
        diagnostics: summary
            .diagnostics
            .iter()
            .map(to_protocol_diagnostic)
            .collect(),
        summary: to_protocol_summary(summary),
        write_counts: CatalogWriteEvidence {
            staged_evidence_rows: writes.staged_evidence_rows,
            committed_evidence_rows: writes.committed_evidence_rows,
            removed_evidence_rows: writes.removed_evidence_rows,
            evidence_write_ms: writes.evidence_write_duration.as_millis() as u64,
        },
        phase_timings,
        duration_ms: started.elapsed().as_millis() as u64,
        storage_bytes: catalog.storage_bytes(),
        rebuild,
    })
}

pub(crate) fn progress_phase(phase: RefreshPhase) -> &'static str {
    match phase {
        RefreshPhase::Enumerating => "enumerating",
        RefreshPhase::Comparing => "comparing",
        RefreshPhase::ReadingHeaders => "reading_headers",
        RefreshPhase::Committing => "committing",
    }
}

fn to_catalog_query(query: &ProtocolQuery) -> Result<QueryRequest, Failure> {
    let (project_id, expected_generation, limit, cursor, kind) = match query {
        ProtocolQuery::Count {
            cursor,
            expected_generation,
            limit,
            project_id,
            exact_classes,
            class_prefixes,
            class_name_suffixes,
            serialized_names,
        } => (
            project_id,
            *expected_generation,
            *limit,
            cursor.clone(),
            QueryKind::Count {
                filters: vec![
                    QueryKind::ExactClasses {
                        values: exact_classes.clone(),
                    },
                    QueryKind::ClassPrefixes {
                        values: class_prefixes.clone(),
                    },
                    QueryKind::ClassNameSuffixes {
                        values: class_name_suffixes.clone(),
                    },
                    QueryKind::SerializedNames {
                        values: serialized_names.clone(),
                    },
                ],
            },
        ),
        ProtocolQuery::Maps {
            cursor,
            expected_generation,
            limit,
            project_id,
        } => (
            project_id,
            *expected_generation,
            *limit,
            cursor.clone(),
            QueryKind::Maps,
        ),
        ProtocolQuery::ExactClasses {
            cursor,
            expected_generation,
            limit,
            project_id,
            values,
        } => (
            project_id,
            *expected_generation,
            *limit,
            cursor.clone(),
            QueryKind::ExactClasses {
                values: values.clone(),
            },
        ),
        ProtocolQuery::ClassPrefixes {
            cursor,
            expected_generation,
            limit,
            project_id,
            values,
        } => (
            project_id,
            *expected_generation,
            *limit,
            cursor.clone(),
            QueryKind::ClassPrefixes {
                values: values.clone(),
            },
        ),
        ProtocolQuery::ClassNameSuffixes {
            cursor,
            expected_generation,
            limit,
            project_id,
            values,
        } => (
            project_id,
            *expected_generation,
            *limit,
            cursor.clone(),
            QueryKind::ClassNameSuffixes {
                values: values.clone(),
            },
        ),
        ProtocolQuery::SerializedNames {
            cursor,
            expected_generation,
            limit,
            project_id,
            values,
        } => (
            project_id,
            *expected_generation,
            *limit,
            cursor.clone(),
            QueryKind::SerializedNames {
                values: values.clone(),
            },
        ),
    };
    Ok(QueryRequest {
        project_id: ProjectId::new(project_id.clone()),
        expected_generation: Generation::new(expected_generation),
        kind,
        limit: limit as usize,
        cursor,
    })
}

fn to_protocol_summary(summary: RefreshSummary) -> ProjectIndexSummary {
    ProjectIndexSummary {
        changed_packages: summary.changed_packages,
        completeness: match summary.completeness {
            Completeness::Complete => ProjectIndexCompleteness::Complete,
            Completeness::Partial => ProjectIndexCompleteness::Partial,
        },
        diagnostics: summary
            .diagnostics
            .into_iter()
            .map(|diagnostic| to_protocol_diagnostic(&diagnostic))
            .collect(),
        generation: summary.generation.get(),
        map_count: summary.map_count,
        package_count: summary.package_count,
        project_id: summary.project_id.to_string(),
        removed_packages: summary.removed_packages,
    }
}

fn to_protocol_diagnostic(
    diagnostic: &super::catalog::CatalogDiagnostic,
) -> ProjectIndexDiagnostic {
    ProjectIndexDiagnostic {
        code: diagnostic.code.clone(),
        message: diagnostic.message.clone(),
        retry_safe: diagnostic.retry_safe,
    }
}

fn to_protocol_item(item: QueryItem) -> ProjectIndexItem {
    match item {
        QueryItem::Count { count } => ProjectIndexItem::Count { count },
        QueryItem::Map {
            map_path,
            package_name,
        } => ProjectIndexItem::Map {
            map_path,
            package_name,
        },
        QueryItem::Header {
            package_path,
            package_name,
            classes,
            serialized_names,
        } => ProjectIndexItem::Header {
            classes,
            package_name,
            package_path,
            serialized_names,
        },
    }
}

fn catalog_to_failure(error: CatalogError) -> Failure {
    match error {
        CatalogError::StaleGeneration { expected, actual } => Failure::stale_generation(
            format!(
                "The Project Index generation changed since this query started (expected {}, actual {}).",
                expected.get(),
                actual.get()
            ),
            expected.get(),
            actual.get(),
        ),
        CatalogError::Corrupt { message } => Failure::new("corrupt_catalog", message, true),
        CatalogError::InvalidRequest { message } => Failure::new("invalid_request", message, false),
        CatalogError::Unavailable { message } => Failure::new("unavailable", message, true),
    }
}

fn coordinator_to_failure(error: CoordinatorError) -> Failure {
    match error {
        CoordinatorError::Catalog(error) => catalog_to_failure(error),
        CoordinatorError::Cancelled { message } => Failure::new("cancelled", message, true),
        CoordinatorError::Unavailable { message } => Failure::new("unavailable", message, true),
        CoordinatorError::InvalidRequest { message } => {
            Failure::new("invalid_request", message, false)
        }
    }
}
