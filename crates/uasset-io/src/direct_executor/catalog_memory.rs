//! In-memory Catalog adapter for coordinator conformance tests.
//!
//! This adapter exercises the same refresh coordinator as production without naming SQL, journals,
//! or migrations.

use std::collections::BTreeMap;

use super::catalog::{
    Catalog, CatalogError, CatalogStatus, EntryKind, Generation, HeaderEvidence,
    PROJECT_INDEX_MAX_PAGE_SIZE, PackageSignature, ProjectId, QueryItem, QueryKind, QueryPage,
    QueryRequest, RefreshSummary, StagedPackage, StagingToken, class_name,
};
use super::project_index::CatalogSnapshot;

#[derive(Clone, Debug)]
struct CommittedRow {
    signature: PackageSignature,
    header: Option<HeaderEvidence>,
}

#[derive(Clone, Debug)]
struct CommittedState {
    generation: Generation,
    summary: RefreshSummary,
    rows: BTreeMap<String, CommittedRow>,
}

#[derive(Debug)]
struct StagingState {
    token: Generation,
    rows: BTreeMap<String, CommittedRow>,
}

/// Disposable in-memory Catalog keyed by project identity.
#[derive(Debug, Default)]
pub struct MemoryCatalog {
    project_id: Option<ProjectId>,
    committed: Option<CommittedState>,
    staging: Option<StagingState>,
}

impl MemoryCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn snapshot_committed_paths(&self) -> Vec<String> {
        self.committed
            .as_ref()
            .map(|state| state.rows.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn require_project(&self, project_id: &ProjectId) -> Result<(), CatalogError> {
        match &self.project_id {
            Some(current) if current == project_id => Ok(()),
            Some(_) => Err(CatalogError::InvalidRequest {
                message: "query project identity does not match the open Catalog".to_owned(),
            }),
            None => Err(CatalogError::InvalidRequest {
                message: "Catalog has no committed project identity".to_owned(),
            }),
        }
    }

    fn ensure_project(&mut self, project_id: ProjectId) {
        self.project_id = Some(project_id);
    }
}

impl Catalog for MemoryCatalog {
    fn status(&self) -> CatalogStatus {
        match &self.committed {
            Some(state) => CatalogStatus::Ready {
                summary: state.summary.clone(),
            },
            None => CatalogStatus::Absent,
        }
    }

    fn committed_generation(&self) -> Option<Generation> {
        self.committed.as_ref().map(|state| state.generation)
    }

    fn lookup_committed(
        &self,
        relative_path: &str,
    ) -> Option<(PackageSignature, Option<HeaderEvidence>)> {
        self.committed.as_ref().and_then(|state| {
            state
                .rows
                .get(relative_path)
                .map(|row| (row.signature.clone(), row.header.clone()))
        })
    }

    fn begin_refresh(&mut self) -> Result<StagingToken, CatalogError> {
        if self.staging.is_some() {
            return Err(CatalogError::Unavailable {
                message: "a Project Index refresh is already in progress".to_owned(),
            });
        }
        let generation = self
            .committed
            .as_ref()
            .map(|state| state.generation.next())
            .unwrap_or(Generation::new(1));
        self.staging = Some(StagingState {
            token: generation,
            rows: BTreeMap::new(),
        });
        Ok(StagingToken { generation })
    }

    fn stage_observed(
        &mut self,
        token: &StagingToken,
        entry: StagedPackage,
    ) -> Result<(), CatalogError> {
        let staging = self
            .staging
            .as_mut()
            .ok_or_else(|| CatalogError::Unavailable {
                message: "no Project Index refresh is in progress".to_owned(),
            })?;
        if staging.token != token.generation {
            return Err(CatalogError::InvalidRequest {
                message: "staging token does not match the active refresh".to_owned(),
            });
        }
        staging.rows.insert(
            entry.signature.relative_path.clone(),
            CommittedRow {
                signature: entry.signature,
                header: entry.header,
            },
        );
        Ok(())
    }

    fn commit_refresh(
        &mut self,
        token: StagingToken,
        summary: RefreshSummary,
    ) -> Result<Generation, CatalogError> {
        let staging = self
            .staging
            .take()
            .ok_or_else(|| CatalogError::Unavailable {
                message: "no Project Index refresh is in progress".to_owned(),
            })?;
        if staging.token != token.generation {
            self.staging = Some(staging);
            return Err(CatalogError::InvalidRequest {
                message: "staging token does not match the active refresh".to_owned(),
            });
        }
        if summary.generation != token.generation {
            self.staging = Some(staging);
            return Err(CatalogError::InvalidRequest {
                message: "refresh summary generation does not match the staging token".to_owned(),
            });
        }
        self.ensure_project(summary.project_id.clone());
        self.committed = Some(CommittedState {
            generation: token.generation,
            summary,
            rows: staging.rows,
        });
        Ok(token.generation)
    }

    fn discard_refresh(&mut self, token: StagingToken) -> Result<(), CatalogError> {
        match self.staging.take() {
            Some(staging) if staging.token == token.generation => Ok(()),
            Some(staging) => {
                self.staging = Some(staging);
                Err(CatalogError::InvalidRequest {
                    message: "staging token does not match the active refresh".to_owned(),
                })
            }
            None => Ok(()),
        }
    }

    fn clear_for_rebuild(&mut self) -> Result<(), CatalogError> {
        self.staging = None;
        self.committed = None;
        Ok(())
    }

    fn query(&self, request: &QueryRequest) -> Result<QueryPage, CatalogError> {
        self.require_project(&request.project_id)?;
        if request.limit == 0 || request.limit > PROJECT_INDEX_MAX_PAGE_SIZE {
            return Err(CatalogError::InvalidRequest {
                message: format!(
                    "Project Index query limit must be between 1 and {PROJECT_INDEX_MAX_PAGE_SIZE}"
                ),
            });
        }
        let Some(state) = &self.committed else {
            return Err(CatalogError::InvalidRequest {
                message: "No committed Project Index generation matches that project identity."
                    .to_owned(),
            });
        };
        if state.generation != request.expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: request.expected_generation,
                actual: state.generation,
            });
        }
        let items = collect_items(&state.rows, &request.kind);
        let offset = parse_cursor(request.cursor.as_deref())?;
        let end = (offset + request.limit).min(items.len());
        let page_items = items[offset..end].to_vec();
        let next_cursor = if end < items.len() {
            Some(end.to_string())
        } else {
            None
        };
        Ok(QueryPage {
            project_id: request.project_id.clone(),
            generation: state.generation,
            items: page_items,
            next_cursor,
        })
    }
}

impl CatalogSnapshot for MemoryCatalog {
    fn committed_relative_paths(&self) -> Vec<String> {
        self.snapshot_committed_paths()
    }
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize, CatalogError> {
    match cursor {
        None => Ok(0),
        Some(value) if value.chars().all(|ch| ch.is_ascii_digit()) => value
            .parse::<usize>()
            .map_err(|_| CatalogError::InvalidRequest {
                message: "Project Index cursor is not a stable page offset.".to_owned(),
            }),
        Some(_) => Err(CatalogError::InvalidRequest {
            message: "Project Index cursor is not a stable page offset.".to_owned(),
        }),
    }
}

fn collect_items(rows: &BTreeMap<String, CommittedRow>, kind: &QueryKind) -> Vec<QueryItem> {
    match kind {
        QueryKind::Maps => rows
            .values()
            .filter(|row| {
                row.signature.kind == EntryKind::Package
                    && row
                        .signature
                        .relative_path
                        .to_ascii_lowercase()
                        .ends_with(".umap")
            })
            .map(|row| QueryItem::Map {
                map_path: row.signature.relative_path.clone(),
                package_name: row
                    .header
                    .as_ref()
                    .map(|header| header.package_name.clone())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| row.signature.relative_path.clone()),
            })
            .collect(),
        QueryKind::ExactClasses { values } => header_items(rows, |header| {
            values
                .iter()
                .any(|value| header.classes.iter().any(|class| class == value))
        }),
        QueryKind::ClassPrefixes { values } => header_items(rows, |header| {
            values
                .iter()
                .any(|prefix| header.classes.iter().any(|class| class.starts_with(prefix)))
        }),
        QueryKind::ClassNameSuffixes { values } => header_items(rows, |header| {
            values.iter().any(|suffix| {
                header
                    .classes
                    .iter()
                    .any(|class| class_name(class).ends_with(suffix))
            })
        }),
        QueryKind::SerializedNames { values } => header_items(rows, |header| {
            values
                .iter()
                .any(|value| header.serialized_names.iter().any(|name| name == value))
        }),
    }
}

fn header_items(
    rows: &BTreeMap<String, CommittedRow>,
    predicate: impl Fn(&HeaderEvidence) -> bool,
) -> Vec<QueryItem> {
    rows.values()
        .filter(|row| row.signature.kind == EntryKind::Package)
        .filter_map(|row| {
            let header = row.header.as_ref()?;
            if !predicate(header) {
                return None;
            }
            Some(QueryItem::Header {
                package_path: row.signature.relative_path.clone(),
                package_name: header.package_name.clone(),
                classes: header.classes.clone(),
                serialized_names: header.serialized_names.clone(),
            })
        })
        .collect()
}
