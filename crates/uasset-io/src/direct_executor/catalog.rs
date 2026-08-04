//! Storage-neutral Catalog seam for the Project Index refresh coordinator.
//!
//! Adapters own persistence details. Coordinator tests must program against this module only and
//! must never name SQL tables, pragmas, journal files, or migrations.

use std::fmt;

/// Versioned set of package-header probes shared by current Project Index consumers.
pub const INDEX_PROFILE_VERSION: u32 = 1;
pub const PROJECT_INDEX_MAX_PAGE_SIZE: usize = 256;
pub const PROJECT_INDEX_MAX_DIAGNOSTICS: usize = 64;
pub const PROJECT_INDEX_MAX_CLASSES: usize = 64;
pub const PROJECT_INDEX_MAX_NAMES: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ProjectId(String);

impl ProjectId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProjectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Generation(u64);

impl Generation {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    pub const fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Package,
    Sidecar,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageSignature {
    pub relative_path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_nanos: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeaderEvidence {
    pub profile_version: u32,
    pub package_name: String,
    pub classes: Vec<String>,
    pub serialized_names: Vec<String>,
    pub failure_code: Option<String>,
}

impl HeaderEvidence {
    pub fn matches_profile(&self) -> bool {
        self.profile_version == INDEX_PROFILE_VERSION
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogDiagnostic {
    pub code: String,
    pub message: String,
    pub retry_safe: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefreshSummary {
    pub project_id: ProjectId,
    pub generation: Generation,
    pub package_count: u64,
    pub map_count: u64,
    pub changed_packages: u64,
    pub removed_packages: u64,
    pub completeness: Completeness,
    pub diagnostics: Vec<CatalogDiagnostic>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completeness {
    Complete,
    Partial,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogStatus {
    Absent,
    Ready { summary: RefreshSummary },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedPackage {
    pub signature: PackageSignature,
    pub header: Option<HeaderEvidence>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryKind {
    Maps,
    ExactClasses { values: Vec<String> },
    ClassPrefixes { values: Vec<String> },
    ClassNameSuffixes { values: Vec<String> },
    SerializedNames { values: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryRequest {
    pub project_id: ProjectId,
    pub expected_generation: Generation,
    pub kind: QueryKind,
    pub limit: usize,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryItem {
    Map {
        map_path: String,
        package_name: String,
    },
    Header {
        package_path: String,
        package_name: String,
        classes: Vec<String>,
        serialized_names: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryPage {
    pub project_id: ProjectId,
    pub generation: Generation,
    pub items: Vec<QueryItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug)]
pub enum CatalogError {
    InvalidRequest {
        message: String,
    },
    StaleGeneration {
        expected: Generation,
        actual: Generation,
    },
    Corrupt {
        message: String,
    },
    Unavailable {
        message: String,
    },
}

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest { message }
            | Self::Corrupt { message }
            | Self::Unavailable { message } => formatter.write_str(message),
            Self::StaleGeneration { expected, actual } => write!(
                formatter,
                "stale generation: expected {}, actual {}",
                expected.get(),
                actual.get()
            ),
        }
    }
}

impl std::error::Error for CatalogError {}

/// Opaque staging token. Adapters may embed generation bookkeeping; callers must not inspect it.
#[derive(Debug)]
pub struct StagingToken {
    pub(crate) generation: Generation,
}

/// Storage-neutral Catalog operations used by the refresh coordinator.
pub trait Catalog {
    fn status(&self) -> CatalogStatus;

    fn committed_generation(&self) -> Option<Generation>;

    fn lookup_committed(
        &self,
        relative_path: &str,
    ) -> Option<(PackageSignature, Option<HeaderEvidence>)>;

    fn begin_refresh(&mut self) -> Result<StagingToken, CatalogError>;

    fn stage_observed(
        &mut self,
        token: &StagingToken,
        entry: StagedPackage,
    ) -> Result<(), CatalogError>;

    fn commit_refresh(
        &mut self,
        token: StagingToken,
        summary: RefreshSummary,
    ) -> Result<Generation, CatalogError>;

    fn discard_refresh(&mut self, token: StagingToken) -> Result<(), CatalogError>;

    fn clear_for_rebuild(&mut self) -> Result<(), CatalogError>;

    fn query(&self, request: &QueryRequest) -> Result<QueryPage, CatalogError>;
}

/// Canonicalize a project root into a disposable Catalog identity.
///
/// On Windows, path comparisons ignore ASCII case. Forward slashes are normalized and a trailing
/// separator is stripped so aliases hash to one identity.
pub fn project_id_from_root(project_root: &str) -> ProjectId {
    let mut normalized = project_root.replace('\\', "/");
    while normalized.len() > 3 && normalized.ends_with('/') {
        normalized.pop();
    }
    if cfg!(windows) {
        normalized = normalized.to_ascii_lowercase();
    }
    ProjectId::new(normalized)
}

pub fn project_relative_path(project_root: &str, absolute_path: &str) -> String {
    let root = project_id_from_root(project_root).as_str().to_owned();
    let path = absolute_path.replace('\\', "/");
    let path = if cfg!(windows) {
        path.to_ascii_lowercase()
    } else {
        path
    };
    path.strip_prefix(&root)
        .map(|suffix| suffix.trim_start_matches('/').to_owned())
        .filter(|suffix| !suffix.is_empty())
        .unwrap_or_else(|| absolute_path.replace('\\', "/"))
}

pub(crate) fn class_name(class_path: &str) -> &str {
    class_path
        .rsplit_once('.')
        .map(|(_, name)| name)
        .unwrap_or(class_path)
}
