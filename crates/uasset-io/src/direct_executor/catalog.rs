//! Storage-neutral Catalog seam for the Project Index refresh coordinator.
//!
//! Adapters own persistence details. Coordinator tests must program against this module only and
//! must never name SQL tables, pragmas, journal files, or migrations.

use std::fmt;

pub use uasset_parser::dependencies::PackageDependency;

/// Versioned set of package-header probes shared by current Project Index consumers. Profile 3
/// adds Asset Registry package dependencies.
pub const INDEX_PROFILE_VERSION: u32 = 3;
/// Bounded page size shared by Rust, TypeScript, and the language-neutral protocol contract.
pub const PROJECT_INDEX_MAX_PAGE_SIZE: usize = 1024;
/// Distinct strings a dictionary page may carry; dependency pages end early to stay within it.
pub const PROJECT_INDEX_MAX_PAGE_STRINGS: usize = PROJECT_INDEX_MAX_PAGE_SIZE * 128;
pub const PROJECT_INDEX_MAX_DIAGNOSTICS: usize = 64;
pub const PROJECT_INDEX_MAX_CLASSES: usize = 64;
pub const PROJECT_INDEX_MAX_NAMES: usize = 64;
/// Changed and removed paths one refresh reports; beyond this it reports only that there were more.
pub const PROJECT_INDEX_MAX_REPORTED_CHANGES: usize = 65_536;

/// Where Unreal mounts a content root: package names below `name` (`/Game/`) are files below the
/// project-relative `path` (`Content/`). Both end with `/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountPoint {
    pub name: String,
    pub path: String,
}

impl MountPoint {
    /// The project's own content: `/Game/` at `Content/`.
    pub fn game() -> Self {
        Self {
            name: "/Game/".to_owned(),
            path: "Content/".to_owned(),
        }
    }
}

/// Which content roots an index holds. Each scope is a separate index with its own identity, so
/// callers that index only `Content` never see plugin packages.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum IndexScope {
    /// The project's `Content` (`/Game/`).
    #[default]
    Content,
    /// `Content`, and the `Content` of every project plugin that can contain content.
    ContentAndPlugins,
}

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
    pub header_data: Option<uasset_inspection::package_header::PackageHeaderData>,
    pub profile_version: u32,
    pub package_name: String,
    pub classes: Vec<String>,
    pub serialized_names: Vec<String>,
    /// Asset Registry package dependencies, sorted by target then properties.
    pub dependencies: Vec<PackageDependency>,
    pub failure_code: Option<String>,
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
    /// The content roots this generation indexed, `/Game/` first.
    pub mounts: Vec<MountPoint>,
}

/// What a refresh saw change on disk since the generation it started from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RefreshChanges {
    /// The generation these changes are relative to; `None` for a first or rebuilt index.
    pub base_generation: Option<Generation>,
    /// Entries (packages and sidecars) that are new or whose size or modified time changed.
    pub changed: Vec<String>,
    /// Entries the base generation held that are gone.
    pub removed: Vec<String>,
    /// False when there were more than `PROJECT_INDEX_MAX_REPORTED_CHANGES` and the lists stop.
    pub complete: bool,
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

/// Compact committed metadata used to compare one filesystem enumeration with the Catalog.
///
/// Refresh must not hydrate classes or serialized names merely to decide whether a package changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogSnapshotEntry {
    pub signature: PackageSignature,
    pub header_profile_version: Option<u32>,
    pub header_failure: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryKind {
    Inventory,
    Maps,
    ExactClasses {
        values: Vec<String>,
    },
    ClassPrefixes {
        values: Vec<String>,
    },
    ClassNameSuffixes {
        values: Vec<String>,
    },
    SerializedNames {
        values: Vec<String>,
    },
    /// The packages at `paths`, and with `transitive` every indexed package they reach through
    /// dependencies `edges` accepts.
    Dependencies {
        paths: Vec<String>,
        transitive: bool,
        edges: EdgeFilter,
    },
    /// Indexed packages that depend on the packages at `paths` (which need not exist any more)
    /// through dependencies `edges` accepts; with `transitive`, also their dependents, and so on.
    /// A non-empty `classes` keeps results with one of those exact export classes; the walk itself
    /// passes through every package.
    Dependents {
        paths: Vec<String>,
        transitive: bool,
        edges: EdgeFilter,
        classes: Vec<String>,
    },
}

/// Which dependencies a walk follows, by Unreal's `EDependencyProperty` bits. A set field requires
/// that value; an unset field accepts either.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EdgeFilter {
    pub hard: Option<bool>,
    pub game: Option<bool>,
    pub build: Option<bool>,
}

impl EdgeFilter {
    pub fn accepts(&self, dependency: &PackageDependency) -> bool {
        self.hard.is_none_or(|hard| hard == dependency.hard)
            && self.game.is_none_or(|game| game == dependency.game)
            && self.build.is_none_or(|build| build == dependency.build)
    }
}

/// A dependency, and the indexed package it names when there is one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedDependency {
    pub dependency: PackageDependency,
    pub package_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryRequest {
    pub project_id: ProjectId,
    pub expected_generation: Generation,
    pub kind: QueryKind,
    pub limit: usize,
    pub cursor: Option<String>,
}

/// Count the union of filters in one immutable generation, without materializing evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CountRequest {
    pub project_id: ProjectId,
    pub expected_generation: Generation,
    pub filters: Vec<QueryKind>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CountResult {
    pub project_id: ProjectId,
    pub generation: Generation,
    pub count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryItem {
    Inventory {
        package_path: String,
        signature: String,
        header_data: Option<uasset_inspection::package_header::PackageHeaderData>,
    },
    Map {
        map_path: String,
        package_name: String,
    },
    Header {
        header_data: Option<uasset_inspection::package_header::PackageHeaderData>,
        package_path: String,
        package_name: String,
        classes: Vec<String>,
        serialized_names: Vec<String>,
    },
    /// A package from a dependency or dependents query, named as Unreal mounts it.
    Package {
        package_path: String,
        package_name: String,
        classes: Vec<String>,
        dependencies: Vec<ResolvedDependency>,
        /// Set when the package header could not be read, so its dependencies are unknown.
        failure_code: Option<String>,
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

    #[allow(dead_code)]
    fn committed_generation(&self) -> Option<Generation>;

    #[allow(dead_code)]
    fn lookup_committed(
        &self,
        relative_path: &str,
    ) -> Option<(PackageSignature, Option<HeaderEvidence>)>;

    fn begin_refresh(&mut self) -> Result<StagingToken, CatalogError>;

    /// Mark an exact signature/profile match as observed without reading or rewriting its evidence.
    fn observe_unchanged(
        &mut self,
        token: &StagingToken,
        relative_path: &str,
    ) -> Result<(), CatalogError>;

    /// Stage evidence for a new or changed entry.
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

    fn count(&self, request: &CountRequest) -> Result<CountResult, CatalogError> {
        validate_count_filters(&request.filters)?;
        let mut paths = std::collections::BTreeSet::new();
        for kind in &request.filters {
            let mut cursor = None;
            loop {
                let page = self.query(&QueryRequest {
                    project_id: request.project_id.clone(),
                    expected_generation: request.expected_generation,
                    kind: kind.clone(),
                    limit: PROJECT_INDEX_MAX_PAGE_SIZE,
                    cursor,
                })?;
                for item in page.items {
                    paths.insert(match item {
                        QueryItem::Map { map_path, .. } => map_path,
                        QueryItem::Header { package_path, .. }
                        | QueryItem::Inventory { package_path, .. }
                        | QueryItem::Package { package_path, .. } => package_path,
                    });
                }
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
        }
        Ok(CountResult {
            project_id: request.project_id.clone(),
            generation: request.expected_generation,
            count: paths.len() as u64,
        })
    }
}

pub fn validate_count_filters(filters: &[QueryKind]) -> Result<(), CatalogError> {
    if filters.is_empty() || filters.len() > 16 {
        return Err(CatalogError::InvalidRequest {
            message: "counts require between 1 and 16 filters".into(),
        });
    }
    if filters.iter().any(|filter| {
        matches!(
            filter,
            QueryKind::Dependencies { .. } | QueryKind::Dependents { .. }
        )
    }) {
        return Err(CatalogError::InvalidRequest {
            message: "dependency queries are not count filters".into(),
        });
    }
    Ok(())
}

/// The Catalog identity of one index scope of a project root. A `Content` index keeps the root's
/// identity; a plugin-inclusive index is a separate Catalog beside it.
pub fn project_id_for(project_root: &str, scope: IndexScope) -> ProjectId {
    let root = project_id_from_root(project_root);
    match scope {
        IndexScope::Content => root,
        IndexScope::ContentAndPlugins => ProjectId::new(format!("{root}#plugins")),
    }
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
    let mut root = project_root.replace('\\', "/");
    while root.len() > 3 && root.ends_with('/') {
        root.pop();
    }
    let path = absolute_path.replace('\\', "/");
    let prefix = path.get(..root.len());
    let root_matches = prefix.is_some_and(|prefix| {
        if cfg!(windows) {
            prefix.eq_ignore_ascii_case(&root)
        } else {
            prefix == root
        }
    });
    let suffix = root_matches
        .then(|| &path[root.len()..])
        .filter(|suffix| root.ends_with('/') || suffix.starts_with('/'));
    suffix
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

/// Maximum cursor length accepted from a caller, independent of any storage adapter.
const MAX_CURSOR_BYTES: usize = 1024;

/// Reject a page limit outside the bounded query contract.
///
/// Both Catalog adapters share this rule so a bounded page never depends on storage details.
pub(crate) fn validate_page_limit(limit: usize) -> Result<(), CatalogError> {
    if limit == 0 || limit > PROJECT_INDEX_MAX_PAGE_SIZE {
        return Err(CatalogError::InvalidRequest {
            message: format!(
                "Project Index query limit must be between 1 and {PROJECT_INDEX_MAX_PAGE_SIZE}"
            ),
        });
    }
    Ok(())
}

/// Decode a stable page cursor into the exclusive project-relative path it resumes after.
///
/// Cursors are opaque to callers: they carry the last path a page returned, so a page stays stable
/// inside one immutable Generation without exposing storage offsets.
pub(crate) fn parse_page_cursor(cursor: Option<&str>) -> Result<String, CatalogError> {
    let Some(value) = cursor else {
        return Ok(String::new());
    };
    let usable = !value.is_empty()
        && value.len() <= MAX_CURSOR_BYTES
        && !value.chars().any(char::is_control);
    if !usable {
        return Err(CatalogError::InvalidRequest {
            message: "Project Index cursor is not a stable page cursor.".to_owned(),
        });
    }
    Ok(value.to_owned())
}

/// Every query item is keyed by its project-relative path, which is also the page cursor.
pub(crate) fn item_path(item: &QueryItem) -> &str {
    match item {
        QueryItem::Map { map_path, .. } => map_path.as_str(),
        QueryItem::Header { package_path, .. }
        | QueryItem::Inventory { package_path, .. }
        | QueryItem::Package { package_path, .. } => package_path.as_str(),
    }
}

/// Opaque package plus sidecar stamps; consumers may verify selected bundles without enumerating.
pub(crate) fn bundle_signature(parts: [Option<(u64, u64)>; 4]) -> String {
    serde_json::Value::Array(
        parts
            .iter()
            .map(|part| match part {
                Some((size, modified)) => serde_json::json!({
                    "size": *size as f64,
                    "modifiedMs": *modified as f64 / 1_000_000.0
                }),
                None => serde_json::Value::Null,
            })
            .collect(),
    )
    .to_string()
}

#[cfg(test)]
mod path_tests {
    use super::{IndexScope, project_id_for, project_id_from_root, project_relative_path};

    #[test]
    fn a_plugin_inclusive_index_is_a_separate_catalog_identity() {
        let root = "C:/Project/";
        assert_eq!(
            project_id_for(root, IndexScope::Content),
            project_id_from_root(root)
        );
        let plugins = project_id_for(root, IndexScope::ContentAndPlugins);
        assert_ne!(plugins, project_id_from_root(root));
        assert_eq!(
            plugins.as_str(),
            format!("{}#plugins", project_id_from_root(root))
        );
    }

    #[test]
    fn project_relative_path_preserves_asset_path_casing() {
        let root = if cfg!(windows) {
            "C:/Project"
        } else {
            "/Project"
        };
        let absolute = format!("{root}/Content/Fixture/L_SavedWorld.umap");

        assert_eq!(
            project_relative_path(root, &absolute),
            "Content/Fixture/L_SavedWorld.umap"
        );
    }

    #[cfg(windows)]
    #[test]
    fn project_relative_path_matches_windows_root_without_lowercasing_the_suffix() {
        assert_eq!(
            project_relative_path(
                "c:\\users\\developer\\project",
                "C:\\Users\\Developer\\Project\\Content\\Maps\\L_World.umap"
            ),
            "Content/Maps/L_World.umap"
        );
    }
}
