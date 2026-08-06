//! SQLite Catalog adapter.
//!
//! This module is the only place in the repository that knows the Catalog is SQLite. It owns the
//! private schema, migrations, transactional staging, atomic Generation publication, indexed
//! evidence queries, stable pagination, busy policy, integrity checking, and quarantine. Nothing
//! above the Catalog seam may depend on any of it.

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::types::Value;
use rusqlite::{
    Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior, params,
};

use super::catalog::{
    Catalog, CatalogDiagnostic, CatalogError, CatalogSnapshotEntry, CatalogStatus, Completeness,
    EntryKind, Generation, HeaderEvidence, PackageSignature, ProjectId, QueryItem, QueryKind,
    QueryPage, QueryRequest, RefreshSummary, StagedPackage, StagingToken, class_name, item_path,
    parse_page_cursor, prefix_upper_bound, reverse_characters, validate_page_limit,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CatalogWriteCounts {
    pub(crate) staged_evidence_rows: u64,
    pub(crate) committed_evidence_rows: u64,
    pub(crate) removed_evidence_rows: u64,
    pub(crate) evidence_write_duration: Duration,
}

use super::project_index::CatalogSnapshot;

/// Private Catalog schema version recorded in `user_version`.
const CATALOG_SCHEMA_VERSION: i64 = 3;
/// Cache-root subdirectory. A new directory version retires an incompatible layout wholesale.
const CATALOG_DIRECTORY: &str = "catalogs-v1";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounded streaming batch so publication never materializes a whole project.
const STREAM_BATCH: usize = 1024;
const MAX_QUARANTINE_SLOTS: u32 = 64;
/// Rebuilding secondary indexes is cheaper than maintaining them row-by-row for a large refresh.
/// Small refreshes retain the indexes so one changed package does not pay a whole-catalog rebuild.
const SECONDARY_INDEX_REBUILD_THRESHOLD: u64 = 4_096;

const KIND_PACKAGE: i64 = 0;
const KIND_SIDECAR: i64 = 1;

const META_PROJECT_ID: &str = "project_id";
const META_COMMITTED_GENERATION: &str = "committed_generation";

const SCHEMA_V3: &str = "\
CREATE TABLE IF NOT EXISTS catalog_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS committed_summary (
    generation INTEGER PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    package_count INTEGER NOT NULL,
    map_count INTEGER NOT NULL,
    changed_packages INTEGER NOT NULL,
    removed_packages INTEGER NOT NULL,
    completeness TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS committed_diagnostic (
    generation INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    retry_safe INTEGER NOT NULL,
    PRIMARY KEY (generation, ordinal)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS entry (
    id INTEGER PRIMARY KEY NOT NULL,
    relative_path TEXT UNIQUE NOT NULL,
    kind INTEGER NOT NULL,
    size INTEGER NOT NULL,
    modified_nanos INTEGER NOT NULL,
    is_map INTEGER NOT NULL,
    profile_version INTEGER,
    package_name TEXT,
    failure_code TEXT
);
CREATE INDEX IF NOT EXISTS entry_by_map ON entry (relative_path) WHERE is_map = 1;
CREATE TABLE IF NOT EXISTS entry_class (
    entry_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    class_path TEXT NOT NULL,
    class_name_reversed TEXT NOT NULL,
    PRIMARY KEY (entry_id, ordinal)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS entry_class_by_path ON entry_class (class_path, entry_id);
CREATE INDEX IF NOT EXISTS entry_class_by_name ON entry_class (class_name_reversed, entry_id);
CREATE TABLE IF NOT EXISTS entry_name (
    entry_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    serialized_name TEXT NOT NULL,
    PRIMARY KEY (entry_id, ordinal)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS entry_name_by_value ON entry_name (serialized_name, entry_id);
";

/// Staging is disposable refresh state. Keeping it in SQLite's connection-local temporary
/// database avoids growing the persistent Catalog with rows that are deleted after every publish.
const TEMP_STAGING_SCHEMA: &str = "\
CREATE TEMP TABLE IF NOT EXISTS staged_entry (
    relative_path TEXT PRIMARY KEY NOT NULL,
    kind INTEGER NOT NULL,
    size INTEGER NOT NULL,
    modified_nanos INTEGER NOT NULL,
    is_map INTEGER NOT NULL,
    profile_version INTEGER,
    package_name TEXT,
    failure_code TEXT,
    classes TEXT NOT NULL,
    serialized_names TEXT NOT NULL
) WITHOUT ROWID;
";

/// Journal mode is a measured adapter choice, not an architectural requirement.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum SqliteJournalMode {
    /// Write-ahead logging. Readers of the previous committed Generation never block on a commit.
    #[default]
    WriteAhead,
    /// Rollback journal. Leaves no sidecar file behind once a connection closes cleanly.
    #[cfg_attr(not(test), allow(dead_code))]
    Rollback,
}

impl SqliteJournalMode {
    fn pragma_value(self) -> &'static str {
        match self {
            Self::WriteAhead => "WAL",
            Self::Rollback => "DELETE",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CommittedRow {
    signature: PackageSignature,
    header: Option<HeaderEvidence>,
}

#[derive(Debug)]
struct Staging {
    direct: bool,
    generation: Generation,
    observed: BTreeSet<String>,
    pending: Vec<StagedPackage>,
}

/// Disposable SQLite Catalog for one canonical project identity.
pub(crate) struct SqliteCatalog {
    connection: Connection,
    path: PathBuf,
    project_id: ProjectId,
    journal_mode: SqliteJournalMode,
    staging: Option<Staging>,
    staging_transaction: bool,
    /// The coordinator compares a committed signature immediately before staging the same path, so
    /// one remembered row removes the second point lookup without caching whole-project state.
    last_lookup: RefCell<Option<(String, Option<CommittedRow>)>>,
    quarantined_from: Option<PathBuf>,
    writes: CatalogWriteCounts,
    #[cfg(test)]
    fail_commit_before_publish: bool,
    #[cfg(test)]
    cleanup_root: Option<PathBuf>,
}

impl std::fmt::Debug for SqliteCatalog {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SqliteCatalog")
            .field("project_id", &self.project_id)
            .field("journal_mode", &self.journal_mode)
            .field("refreshing", &self.staging.is_some())
            .finish()
    }
}

impl SqliteCatalog {
    /// Open (or create) the disposable Catalog for `project_id` beneath the configured cache root.
    ///
    /// A corrupt, foreign, or newer-than-supported Catalog is quarantined and replaced. Project
    /// content is never read or written here.
    pub(crate) fn open(
        cache_root: &Path,
        project_id: &ProjectId,
        journal_mode: SqliteJournalMode,
    ) -> Result<Self, CatalogError> {
        Self::open_with_integrity(cache_root, project_id, journal_mode, true)
    }

    /// Open a Catalog for a bounded read-only query without scanning every page for integrity.
    /// Refresh/rebuild/status opens still perform the explicit quick check; a query that encounters
    /// a damaged page returns a typed failure and the next refresh will quarantine the Catalog.
    pub(crate) fn open_for_query(
        cache_root: &Path,
        project_id: &ProjectId,
        journal_mode: SqliteJournalMode,
    ) -> Result<Self, CatalogError> {
        Self::open_with_integrity(cache_root, project_id, journal_mode, false)
    }

    fn open_with_integrity(
        cache_root: &Path,
        project_id: &ProjectId,
        journal_mode: SqliteJournalMode,
        check_integrity: bool,
    ) -> Result<Self, CatalogError> {
        let directory = cache_root.join(CATALOG_DIRECTORY);
        fs::create_dir_all(&directory).map_err(|error| CatalogError::Unavailable {
            message: format!("could not create the Project Index cache directory: {error}"),
        })?;
        let path = directory.join(catalog_file_name(project_id));
        match Self::try_open(&path, project_id, journal_mode, check_integrity) {
            Ok(catalog) => Ok(catalog),
            Err(CatalogError::Corrupt { message }) => {
                let quarantined = quarantine(&path)?;
                let mut catalog = Self::try_open(&path, project_id, journal_mode, check_integrity)
                    .map_err(|error| CatalogError::Unavailable {
                        message: format!(
                            "could not rebuild the Project Index Catalog after quarantine \
                             ({message}): {error}"
                        ),
                    })?;
                catalog.quarantined_from = quarantined;
                Ok(catalog)
            }
            Err(error) => Err(error),
        }
    }

    /// Path of the quarantined predecessor when this Catalog replaced a broken one.
    pub(crate) fn quarantined_from(&self) -> Option<&Path> {
        self.quarantined_from.as_deref()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn journal_mode(&self) -> SqliteJournalMode {
        self.journal_mode
    }

    pub(crate) fn write_counts(&self) -> CatalogWriteCounts {
        self.writes
    }

    /// Bytes currently used by the Catalog and any journal sidecar it owns.
    pub(crate) fn storage_bytes(&self) -> u64 {
        catalog_files(&self.path)
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum()
    }

    fn try_open(
        path: &Path,
        project_id: &ProjectId,
        journal_mode: SqliteJournalMode,
        check_integrity: bool,
    ) -> Result<Self, CatalogError> {
        let connection = open_connection(path, journal_mode)?;
        migrate(&connection)?;
        ensure_temp_staging_table(&connection)?;
        if check_integrity {
            verify_integrity(&connection)?;
        }
        match read_meta(&connection, META_PROJECT_ID)? {
            Some(existing) if existing != project_id.as_str() => {
                return Err(CatalogError::Corrupt {
                    message: "the Catalog at that location belongs to another project identity"
                        .to_owned(),
                });
            }
            _ => {}
        }
        Ok(Self {
            connection,
            path: path.to_owned(),
            project_id: project_id.clone(),
            journal_mode,
            staging: None,
            staging_transaction: false,
            last_lookup: RefCell::new(None),
            quarantined_from: None,
            writes: CatalogWriteCounts::default(),
            #[cfg(test)]
            fail_commit_before_publish: false,
            #[cfg(test)]
            cleanup_root: None,
        })
    }

    fn begin_staging_transaction(&mut self) -> Result<(), CatalogError> {
        if self.staging_transaction {
            return Ok(());
        }
        self.connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(storage_error)?;
        self.staging_transaction = true;
        Ok(())
    }

    fn commit_staging_transaction(&mut self) -> Result<(), CatalogError> {
        if !self.staging_transaction {
            return Ok(());
        }
        self.connection
            .execute_batch("COMMIT")
            .map_err(storage_error)?;
        self.staging_transaction = false;
        Ok(())
    }

    fn rollback_staging_transaction(&mut self) -> Result<(), CatalogError> {
        if !self.staging_transaction {
            return Ok(());
        }
        self.connection
            .execute_batch("ROLLBACK")
            .map_err(storage_error)?;
        self.staging_transaction = false;
        Ok(())
    }

    /// Flush one bounded ingest batch while retaining the surrounding refresh transaction.
    fn flush_pending_entries(&mut self) -> Result<(), CatalogError> {
        let Some(staging) = self.staging.as_mut() else {
            return Ok(());
        };
        if staging.pending.is_empty() {
            return Ok(());
        }
        let direct = staging.direct;
        let pending = std::mem::replace(&mut staging.pending, Vec::with_capacity(STREAM_BATCH));
        let count = pending.len() as u64;
        let started = Instant::now();
        let result = if direct {
            write_committed_batch(&self.connection, &pending, false)
        } else {
            write_staged_batch(&self.connection, &pending)
        };
        self.writes.evidence_write_duration += started.elapsed();
        result?;
        if direct {
            self.writes.committed_evidence_rows += count;
        } else {
            self.writes.staged_evidence_rows += count;
        }
        Ok(())
    }

    #[allow(dead_code)]
    fn committed_row(&self, relative_path: &str) -> Result<Option<CommittedRow>, CatalogError> {
        let stored = self
            .connection
            .query_row(
                "SELECT id, kind, size, modified_nanos, profile_version, package_name, failure_code \
                 FROM entry WHERE relative_path = ?1",
                params![relative_path],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(storage_error)?;
        let Some((
            entry_id,
            kind,
            size,
            modified_nanos,
            profile_version,
            package_name,
            failure_code,
        )) = stored
        else {
            return Ok(None);
        };
        let header = match profile_version {
            Some(profile_version) => Some(HeaderEvidence {
                profile_version: u32::try_from(profile_version).unwrap_or_default(),
                package_name: package_name.unwrap_or_default(),
                classes: self.read_classes(entry_id)?,
                serialized_names: self.read_serialized_names(entry_id)?,
                failure_code,
            }),
            None => None,
        };
        Ok(Some(CommittedRow {
            signature: PackageSignature {
                relative_path: relative_path.to_owned(),
                kind: decode_kind(kind),
                size: u64::try_from(size).unwrap_or_default(),
                modified_nanos: u64::try_from(modified_nanos).unwrap_or_default(),
            },
            header,
        }))
    }

    /// Read one committed row, remembering it for the staging call that follows.
    #[allow(dead_code)]
    fn remembered_row(&self, relative_path: &str) -> Result<Option<CommittedRow>, CatalogError> {
        if let Some((path, row)) = self.last_lookup.borrow().as_ref()
            && path == relative_path
        {
            return Ok(row.clone());
        }
        let row = self.committed_row(relative_path)?;
        *self.last_lookup.borrow_mut() = Some((relative_path.to_owned(), row.clone()));
        Ok(row)
    }

    fn read_classes(&self, entry_id: i64) -> Result<Vec<String>, CatalogError> {
        collect_column(
            &self.connection,
            "SELECT class_path FROM entry_class WHERE entry_id = ?1 ORDER BY ordinal",
            entry_id,
        )
    }

    fn read_serialized_names(&self, entry_id: i64) -> Result<Vec<String>, CatalogError> {
        collect_column(
            &self.connection,
            "SELECT serialized_name FROM entry_name WHERE entry_id = ?1 ORDER BY ordinal",
            entry_id,
        )
    }

    fn header_item(&self, relative_path: &str) -> Result<Option<QueryItem>, CatalogError> {
        let stored = self
            .connection
            .query_row(
                "SELECT id, package_name FROM entry WHERE relative_path = ?1",
                params![relative_path],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        let Some((entry_id, package_name)) = stored else {
            return Ok(None);
        };
        Ok(Some(QueryItem::Header {
            package_path: relative_path.to_owned(),
            package_name: package_name.unwrap_or_default(),
            classes: self.read_classes(entry_id)?,
            serialized_names: self.read_serialized_names(entry_id)?,
        }))
    }

    fn map_item(&self, relative_path: String) -> Result<QueryItem, CatalogError> {
        let package_name = self
            .connection
            .query_row(
                "SELECT package_name FROM entry WHERE relative_path = ?1",
                params![&relative_path],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(storage_error)?
            .flatten()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| relative_path.clone());
        Ok(QueryItem::Map {
            map_path: relative_path,
            package_name,
        })
    }

    fn clear_staged_rows(&self) -> Result<(), CatalogError> {
        self.connection
            .execute("DELETE FROM staged_entry", [])
            .map(|_| ())
            .map_err(storage_error)
    }

    fn restore_staging(&mut self, staging: Staging, message: &str) -> CatalogError {
        self.staging = Some(staging);
        CatalogError::InvalidRequest {
            message: message.to_owned(),
        }
    }

    fn require_committed_project(&self, project_id: &ProjectId) -> Result<(), CatalogError> {
        match read_meta(&self.connection, META_PROJECT_ID)? {
            Some(current) if current == project_id.as_str() => Ok(()),
            Some(_) => Err(CatalogError::InvalidRequest {
                message: "query project identity does not match the open Catalog".to_owned(),
            }),
            None => Err(CatalogError::InvalidRequest {
                message: "Catalog has no committed project identity".to_owned(),
            }),
        }
    }

    fn checkpoint_wal(&self) {
        if self.journal_mode == SqliteJournalMode::WriteAhead {
            let _ = self
                .connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        }
    }
}

impl Catalog for SqliteCatalog {
    fn status(&self) -> CatalogStatus {
        // A Catalog that cannot be read reports absence; the next explicit refresh recovers it.
        read_committed_status(&self.connection).unwrap_or(CatalogStatus::Absent)
    }

    fn committed_generation(&self) -> Option<Generation> {
        read_committed_generation(&self.connection).ok().flatten()
    }

    fn lookup_committed(
        &self,
        relative_path: &str,
    ) -> Option<(PackageSignature, Option<HeaderEvidence>)> {
        self.remembered_row(relative_path)
            .ok()
            .flatten()
            .map(|row| (row.signature, row.header))
    }

    fn begin_refresh(&mut self) -> Result<StagingToken, CatalogError> {
        if self.staging.is_some() || self.staging_transaction {
            return Err(CatalogError::Unavailable {
                message: "a Project Index refresh is already in progress".to_owned(),
            });
        }
        // Staging is disposable: clear anything a previously interrupted refresh left behind.
        self.clear_staged_rows()?;
        let generation = read_committed_generation(&self.connection)?
            .map(Generation::next)
            .unwrap_or(Generation::new(1));
        let direct = generation.get() == 1;
        if direct {
            self.begin_staging_transaction()?;
            if let Err(error) = drop_secondary_indexes(&self.connection) {
                let _ = self.rollback_staging_transaction();
                return Err(error);
            }
        }
        self.staging = Some(Staging {
            direct,
            generation,
            observed: BTreeSet::new(),
            pending: Vec::with_capacity(STREAM_BATCH),
        });
        *self.last_lookup.borrow_mut() = None;
        Ok(StagingToken { generation })
    }

    fn observe_unchanged(
        &mut self,
        token: &StagingToken,
        relative_path: &str,
    ) -> Result<(), CatalogError> {
        let staging = self
            .staging
            .as_mut()
            .ok_or_else(|| CatalogError::Unavailable {
                message: "no Project Index refresh is in progress".to_owned(),
            })?;
        if staging.generation != token.generation {
            return Err(CatalogError::InvalidRequest {
                message: "staging token does not match the active refresh".to_owned(),
            });
        }
        staging.observed.insert(relative_path.to_owned());
        Ok(())
    }

    fn stage_observed(
        &mut self,
        token: &StagingToken,
        entry: StagedPackage,
    ) -> Result<(), CatalogError> {
        let active = match &self.staging {
            Some(staging) => staging.generation,
            None => {
                return Err(CatalogError::Unavailable {
                    message: "no Project Index refresh is in progress".to_owned(),
                });
            }
        };
        if active != token.generation {
            return Err(CatalogError::InvalidRequest {
                message: "staging token does not match the active refresh".to_owned(),
            });
        }
        if let Some(staging) = self.staging.as_mut() {
            staging
                .observed
                .insert(entry.signature.relative_path.clone());
            staging.pending.push(entry);
        }
        self.begin_staging_transaction()?;
        if self
            .staging
            .as_ref()
            .is_some_and(|staging| staging.pending.len() >= STREAM_BATCH)
        {
            self.flush_pending_entries()?;
        }
        Ok(())
    }

    fn commit_refresh(
        &mut self,
        token: StagingToken,
        summary: RefreshSummary,
    ) -> Result<Generation, CatalogError> {
        let staging = self
            .staging
            .as_ref()
            .ok_or_else(|| CatalogError::Unavailable {
                message: "no Project Index refresh is in progress".to_owned(),
            })?;
        if staging.generation != token.generation {
            return Err(CatalogError::InvalidRequest {
                message: "staging token does not match the active refresh".to_owned(),
            });
        }
        if summary.generation != token.generation {
            return Err(CatalogError::InvalidRequest {
                message: "refresh summary generation does not match the staging token".to_owned(),
            });
        }
        if summary.project_id != self.project_id {
            return Err(CatalogError::InvalidRequest {
                message: "refresh summary project identity does not match the open Catalog"
                    .to_owned(),
            });
        }
        if let Err(error) = self.flush_pending_entries() {
            let _ = self.rollback_staging_transaction();
            self.staging = None;
            let _ = self.clear_staged_rows();
            return Err(error);
        }
        let staging = self.staging.take().expect("validated staging state");
        *self.last_lookup.borrow_mut() = None;
        #[cfg(test)]
        let fail_before_publish = self.fail_commit_before_publish;
        #[cfg(not(test))]
        let fail_before_publish = false;

        if staging.direct {
            let result = (|| {
                create_secondary_indexes(&self.connection)?;
                if fail_before_publish {
                    return Err(CatalogError::Unavailable {
                        message: "injected Project Index commit failure".to_owned(),
                    });
                }
                write_summary(&self.connection, &summary)?;
                self.commit_staging_transaction()
            })();
            if let Err(error) = result {
                let _ = self.rollback_staging_transaction();
                return Err(error);
            }
            self.checkpoint_wal();
            return Ok(token.generation);
        }

        if let Err(error) = self.commit_staging_transaction() {
            let _ = self.rollback_staging_transaction();
            let _ = self.clear_staged_rows();
            return Err(error);
        }
        let mut writes = self.writes;
        match publish(
            &mut self.connection,
            &staging.observed,
            &summary,
            &mut writes,
            fail_before_publish,
        ) {
            Ok(()) => {
                self.writes = writes;
                // Fold the write-ahead log back into the Catalog so cache bytes stay proportional
                // to the index rather than to refresh history.
                self.checkpoint_wal();
                Ok(token.generation)
            }
            Err(error) => {
                // The transaction rolled back, so the previous committed Generation is intact.
                // Staging is dropped so the Catalog stays usable for the next explicit refresh.
                let _ = self.clear_staged_rows();
                Err(error)
            }
        }
    }

    fn discard_refresh(&mut self, token: StagingToken) -> Result<(), CatalogError> {
        match self.staging.take() {
            Some(staging) if staging.generation == token.generation => {
                *self.last_lookup.borrow_mut() = None;
                self.rollback_staging_transaction()?;
                self.clear_staged_rows()
            }
            Some(staging) => {
                Err(self
                    .restore_staging(staging, "staging token does not match the active refresh"))
            }
            None => Ok(()),
        }
    }

    fn clear_for_rebuild(&mut self) -> Result<(), CatalogError> {
        self.rollback_staging_transaction()?;
        self.staging = None;
        *self.last_lookup.borrow_mut() = None;
        self.writes = CatalogWriteCounts::default();
        // Replace the connection so the exact Catalog files are discarded rather than emptied.
        let placeholder = Connection::open_in_memory().map_err(storage_error)?;
        drop(std::mem::replace(&mut self.connection, placeholder));
        remove_catalog_files(&self.path)?;
        self.connection = open_connection(&self.path, self.journal_mode)?;
        migrate(&self.connection)?;
        ensure_temp_staging_table(&self.connection)
    }

    fn query(&self, request: &QueryRequest) -> Result<QueryPage, CatalogError> {
        self.require_committed_project(&request.project_id)?;
        validate_page_limit(request.limit)?;
        let Some(generation) = read_committed_generation(&self.connection)? else {
            return Err(CatalogError::InvalidRequest {
                message: "No committed Project Index generation matches that project identity."
                    .to_owned(),
            });
        };
        if generation != request.expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: request.expected_generation,
                actual: generation,
            });
        }
        let after = parse_page_cursor(request.cursor.as_deref())?;
        // One extra row decides whether another page exists without a second counting query.
        let probe = request.limit.saturating_add(1);
        let paths = select_paths(&self.connection, &request.kind, &after, probe)?;
        let has_more = paths.len() > request.limit;
        let mut items = Vec::with_capacity(request.limit.min(paths.len()));
        for path in paths.into_iter().take(request.limit) {
            match &request.kind {
                QueryKind::Maps => items.push(self.map_item(path)?),
                _ => {
                    if let Some(item) = self.header_item(&path)? {
                        items.push(item);
                    }
                }
            }
        }
        let next_cursor = has_more
            .then(|| items.last().map(item_path).map(ToOwned::to_owned))
            .flatten();
        Ok(QueryPage {
            project_id: request.project_id.clone(),
            generation,
            items,
            next_cursor,
        })
    }
}

impl CatalogSnapshot for SqliteCatalog {
    fn committed_entries(&self) -> Vec<CatalogSnapshotEntry> {
        let mut statement = match self.connection.prepare_cached(
            "SELECT relative_path, kind, size, modified_nanos, profile_version FROM entry \
             ORDER BY relative_path",
        ) {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
        let rows = match statement.query_map([], |row| {
            let profile_version = row.get::<_, Option<i64>>(4)?;
            Ok(CatalogSnapshotEntry {
                signature: PackageSignature {
                    relative_path: row.get(0)?,
                    kind: decode_kind(row.get(1)?),
                    size: u64::try_from(row.get::<_, i64>(2)?).unwrap_or_default(),
                    modified_nanos: u64::try_from(row.get::<_, i64>(3)?).unwrap_or_default(),
                },
                header_profile_version: profile_version
                    .and_then(|version| u32::try_from(version).ok()),
            })
        }) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(Result::ok).collect()
    }
}

#[cfg(test)]
impl Drop for SqliteCatalog {
    fn drop(&mut self) {
        let Some(root) = self.cleanup_root.take() else {
            return;
        };
        // Close the Catalog before removing the disposable test cache root.
        if let Ok(placeholder) = Connection::open_in_memory() {
            drop(std::mem::replace(&mut self.connection, placeholder));
        }
        let _ = fs::remove_dir_all(root);
    }
}

/// Publish staged evidence, deletions, and the next Generation in exactly one transaction.
fn publish(
    connection: &mut Connection,
    observed: &BTreeSet<String>,
    summary: &RefreshSummary,
    writes: &mut CatalogWriteCounts,
    fail_before_publish: bool,
) -> Result<(), CatalogError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let churn = summary
        .changed_packages
        .saturating_add(summary.removed_packages);
    let rebuild_indexes = churn >= SECONDARY_INDEX_REBUILD_THRESHOLD;
    if rebuild_indexes {
        drop_secondary_indexes(&transaction)?;
    }

    // Deletions land only now, after one complete enumeration observed the whole project.
    let mut after = String::new();
    let mut removed = Vec::new();
    loop {
        let batch = committed_path_batch(&transaction, &after, STREAM_BATCH)?;
        let Some(last) = batch.last().cloned() else {
            break;
        };
        after = last;
        removed.extend(batch.into_iter().filter(|path| !observed.contains(path)));
    }
    for path in &removed {
        delete_entry(&transaction, path)?;
    }
    writes.removed_evidence_rows += removed.len() as u64;

    let mut after = String::new();
    // Generation 1 has no committed evidence to replace. Avoid issuing two delete statements for
    // every cold-build entry; later generations still remove prior evidence before upserting.
    let delete_replaced_evidence = summary.generation.get() > 1;
    loop {
        let batch = staged_entry_batch(&transaction, &after, STREAM_BATCH)?;
        let Some(last) = batch
            .last()
            .map(|entry| entry.signature.relative_path.clone())
        else {
            break;
        };
        after = last;
        write_committed_batch(&transaction, &batch, delete_replaced_evidence)?;
        writes.committed_evidence_rows += batch.len() as u64;
    }
    transaction
        .execute("DELETE FROM staged_entry", [])
        .map_err(storage_error)?;

    if rebuild_indexes {
        create_secondary_indexes(&transaction)?;
    }

    if fail_before_publish {
        return Err(CatalogError::Unavailable {
            message: "injected Project Index commit failure".to_owned(),
        });
    }

    write_summary(&transaction, summary)?;
    transaction.commit().map_err(storage_error)
}

fn drop_secondary_indexes(connection: &Connection) -> Result<(), CatalogError> {
    connection
        .execute_batch(
            "DROP INDEX IF EXISTS entry_by_map;
             DROP INDEX IF EXISTS entry_class_by_path;
             DROP INDEX IF EXISTS entry_class_by_name;
             DROP INDEX IF EXISTS entry_name_by_value;",
        )
        .map_err(storage_error)
}

fn create_secondary_indexes(connection: &Connection) -> Result<(), CatalogError> {
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS entry_by_map ON entry (relative_path) WHERE is_map = 1;
             CREATE INDEX IF NOT EXISTS entry_class_by_path ON entry_class (class_path, entry_id);
             CREATE INDEX IF NOT EXISTS entry_class_by_name ON entry_class (class_name_reversed, entry_id);
             CREATE INDEX IF NOT EXISTS entry_name_by_value ON entry_name (serialized_name, entry_id);",
        )
        .map_err(storage_error)
}

fn write_summary(connection: &Connection, summary: &RefreshSummary) -> Result<(), CatalogError> {
    // Only the newest committed summary is retained; earlier generations are not history.
    for statement in [
        "DELETE FROM committed_summary",
        "DELETE FROM committed_diagnostic",
    ] {
        connection.execute(statement, []).map_err(storage_error)?;
    }
    let generation = clamp_i64(summary.generation.get());
    connection
        .execute(
            "INSERT INTO committed_summary (generation, project_id, package_count, map_count, \
             changed_packages, removed_packages, completeness) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                generation,
                summary.project_id.as_str(),
                clamp_i64(summary.package_count),
                clamp_i64(summary.map_count),
                clamp_i64(summary.changed_packages),
                clamp_i64(summary.removed_packages),
                encode_completeness(summary.completeness)
            ],
        )
        .map_err(storage_error)?;
    for (ordinal, diagnostic) in summary.diagnostics.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO committed_diagnostic (generation, ordinal, code, message, retry_safe) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    generation,
                    clamp_usize(ordinal),
                    diagnostic.code,
                    diagnostic.message,
                    i64::from(diagnostic.retry_safe)
                ],
            )
            .map_err(storage_error)?;
    }
    write_meta(connection, META_PROJECT_ID, summary.project_id.as_str())?;
    write_meta(
        connection,
        META_COMMITTED_GENERATION,
        &summary.generation.get().to_string(),
    )
}

fn write_staged_batch(
    connection: &Connection,
    entries: &[StagedPackage],
) -> Result<(), CatalogError> {
    let mut statement = connection
        .prepare_cached(
            "INSERT INTO staged_entry (relative_path, kind, size, modified_nanos, is_map, \
             profile_version, package_name, failure_code, classes, serialized_names) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(relative_path) DO UPDATE SET kind = excluded.kind, size = excluded.size, \
             modified_nanos = excluded.modified_nanos, is_map = excluded.is_map, \
             profile_version = excluded.profile_version, package_name = excluded.package_name, \
             failure_code = excluded.failure_code, classes = excluded.classes, \
             serialized_names = excluded.serialized_names",
        )
        .map_err(storage_error)?;
    for entry in entries {
        let classes = encode_strings(
            entry
                .header
                .as_ref()
                .map(|header| header.classes.as_slice())
                .unwrap_or_default(),
        )?;
        let names = encode_strings(
            entry
                .header
                .as_ref()
                .map(|header| header.serialized_names.as_slice())
                .unwrap_or_default(),
        )?;
        statement
            .execute(params![
                entry.signature.relative_path,
                encode_kind(entry.signature.kind),
                clamp_i64(entry.signature.size),
                clamp_i64(entry.signature.modified_nanos),
                i64::from(is_map(&entry.signature)),
                header_profile_version(entry),
                header_package_name(entry),
                header_failure_code(entry),
                classes,
                names
            ])
            .map_err(storage_error)?;
    }
    Ok(())
}

fn write_committed_batch(
    connection: &Connection,
    entries: &[StagedPackage],
    delete_replaced_evidence: bool,
) -> Result<(), CatalogError> {
    let mut entry_statement = connection
        .prepare_cached(
            "INSERT INTO entry (relative_path, kind, size, modified_nanos, is_map, \
             profile_version, package_name, failure_code) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(relative_path) DO UPDATE SET kind = excluded.kind, size = excluded.size, \
             modified_nanos = excluded.modified_nanos, is_map = excluded.is_map, \
             profile_version = excluded.profile_version, package_name = excluded.package_name, \
             failure_code = excluded.failure_code RETURNING id",
        )
        .map_err(storage_error)?;
    let mut class_statement = connection
        .prepare_cached(
            "INSERT INTO entry_class (entry_id, ordinal, class_path, class_name_reversed) \
             SELECT ?1, CAST(item.key AS INTEGER), json_extract(item.value, '$[0]'), \
             json_extract(item.value, '$[1]') FROM json_each(?2) AS item",
        )
        .map_err(storage_error)?;
    let mut name_statement = connection
        .prepare_cached(
            "INSERT INTO entry_name (entry_id, ordinal, serialized_name) \
             SELECT ?1, CAST(item.key AS INTEGER), item.value FROM json_each(?2) AS item",
        )
        .map_err(storage_error)?;
    let mut class_delete = delete_replaced_evidence
        .then(|| {
            connection
                .prepare_cached("DELETE FROM entry_class WHERE entry_id = ?1")
                .map_err(storage_error)
        })
        .transpose()?;
    let mut name_delete = delete_replaced_evidence
        .then(|| {
            connection
                .prepare_cached("DELETE FROM entry_name WHERE entry_id = ?1")
                .map_err(storage_error)
        })
        .transpose()?;

    for entry in entries {
        let path = &entry.signature.relative_path;
        let entry_id = entry_statement
            .query_row(
                params![
                    path,
                    encode_kind(entry.signature.kind),
                    clamp_i64(entry.signature.size),
                    clamp_i64(entry.signature.modified_nanos),
                    i64::from(is_map(&entry.signature)),
                    header_profile_version(entry),
                    header_package_name(entry),
                    header_failure_code(entry)
                ],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)?;
        if let Some(statement) = class_delete.as_mut() {
            statement
                .execute(params![entry_id])
                .map_err(storage_error)?;
        }
        if let Some(statement) = name_delete.as_mut() {
            statement
                .execute(params![entry_id])
                .map_err(storage_error)?;
        }
        let Some(header) = entry.header.as_ref() else {
            continue;
        };
        class_statement
            .execute(params![entry_id, encode_class_rows(&header.classes)?])
            .map_err(storage_error)?;
        name_statement
            .execute(params![entry_id, encode_strings(&header.serialized_names)?])
            .map_err(storage_error)?;
    }
    Ok(())
}

fn delete_entry(transaction: &Transaction<'_>, relative_path: &str) -> Result<(), CatalogError> {
    let entry_id = transaction
        .query_row(
            "SELECT id FROM entry WHERE relative_path = ?1",
            params![relative_path],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(entry_id) = entry_id else {
        return Ok(());
    };
    delete_entry_evidence(transaction, entry_id)?;
    let mut statement = transaction
        .prepare_cached("DELETE FROM entry WHERE relative_path = ?1")
        .map_err(storage_error)?;
    statement
        .execute(params![relative_path])
        .map(|_| ())
        .map_err(storage_error)
}

fn delete_entry_evidence(transaction: &Transaction<'_>, entry_id: i64) -> Result<(), CatalogError> {
    for statement in [
        "DELETE FROM entry_class WHERE entry_id = ?1",
        "DELETE FROM entry_name WHERE entry_id = ?1",
    ] {
        let mut statement = transaction
            .prepare_cached(statement)
            .map_err(storage_error)?;
        statement
            .execute(params![entry_id])
            .map_err(storage_error)?;
    }
    Ok(())
}

fn committed_path_batch(
    connection: &Connection,
    after: &str,
    limit: usize,
) -> Result<Vec<String>, CatalogError> {
    let mut statement = connection
        .prepare_cached(
            "SELECT relative_path FROM entry WHERE relative_path > ?1 \
             ORDER BY relative_path LIMIT ?2",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(params![after, clamp_usize(limit)], |row| {
            row.get::<_, String>(0)
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn staged_entry_batch(
    connection: &Connection,
    after: &str,
    limit: usize,
) -> Result<Vec<StagedPackage>, CatalogError> {
    let mut statement = connection
        .prepare_cached(
            "SELECT relative_path, kind, size, modified_nanos, profile_version, package_name, \
             failure_code, classes, serialized_names FROM staged_entry WHERE relative_path > ?1 \
             ORDER BY relative_path LIMIT ?2",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(params![after, clamp_usize(limit)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(storage_error)?;
    let mut entries = Vec::new();
    for row in rows {
        let (
            relative_path,
            kind,
            size,
            modified_nanos,
            profile_version,
            package_name,
            failure_code,
            classes,
            names,
        ) = row.map_err(storage_error)?;
        let header = match profile_version {
            Some(profile_version) => Some(HeaderEvidence {
                profile_version: u32::try_from(profile_version).unwrap_or_default(),
                package_name: package_name.unwrap_or_default(),
                classes: decode_strings(&classes)?,
                serialized_names: decode_strings(&names)?,
                failure_code,
            }),
            None => None,
        };
        entries.push(StagedPackage {
            signature: PackageSignature {
                relative_path,
                kind: decode_kind(kind),
                size: u64::try_from(size).unwrap_or_default(),
                modified_nanos: u64::try_from(modified_nanos).unwrap_or_default(),
            },
            header,
        });
    }
    Ok(entries)
}

/// Select one ordered, bounded page of project-relative paths for a query kind.
fn select_paths(
    connection: &Connection,
    kind: &QueryKind,
    after: &str,
    limit: usize,
) -> Result<Vec<String>, CatalogError> {
    let mut arguments = vec![Value::Text(after.to_owned())];
    let sql = match kind {
        QueryKind::Maps => "SELECT relative_path FROM entry \
             WHERE is_map = 1 AND relative_path > ?1 ORDER BY relative_path LIMIT ?2"
            .to_owned(),
        QueryKind::ExactClasses { values } => {
            if values.is_empty() {
                return Ok(Vec::new());
            }
            let placeholders = value_placeholders(&mut arguments, values);
            header_query(
                "entry_class c",
                &format!("c.class_path IN ({placeholders})"),
                arguments.len() + 1,
            )
        }
        QueryKind::ClassPrefixes { values } => {
            if values.is_empty() {
                return Ok(Vec::new());
            }
            let ranges =
                range_predicates(&mut arguments, values, "c.class_path", ToOwned::to_owned);
            header_query("entry_class c", &ranges, arguments.len() + 1)
        }
        QueryKind::ClassNameSuffixes { values } => {
            if values.is_empty() {
                return Ok(Vec::new());
            }
            let ranges = range_predicates(
                &mut arguments,
                values,
                "c.class_name_reversed",
                reverse_characters,
            );
            header_query("entry_class c", &ranges, arguments.len() + 1)
        }
        QueryKind::SerializedNames { values } => {
            if values.is_empty() {
                return Ok(Vec::new());
            }
            let placeholders = value_placeholders(&mut arguments, values);
            header_query(
                "entry_name n",
                &format!("n.serialized_name IN ({placeholders})"),
                arguments.len() + 1,
            )
        }
    };
    arguments.push(Value::Integer(clamp_usize(limit)));
    let mut statement = connection.prepare_cached(&sql).map_err(storage_error)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(arguments), |row| {
            row.get::<_, String>(0)
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

/// Indexed header query shared by every non-map query kind.
fn header_query(evidence_table: &str, predicate: &str, limit_placeholder: usize) -> String {
    format!(
        "SELECT DISTINCT e.relative_path FROM entry e \
         JOIN {evidence_table} ON {alias}.entry_id = e.id \
         WHERE e.kind = {KIND_PACKAGE} AND e.profile_version IS NOT NULL \
         AND e.relative_path > ?1 AND ({predicate}) \
         ORDER BY e.relative_path LIMIT ?{limit_placeholder}",
        alias = evidence_table
            .split_whitespace()
            .next_back()
            .unwrap_or(evidence_table)
    )
}

fn value_placeholders(arguments: &mut Vec<Value>, values: &[String]) -> String {
    let mut placeholders = Vec::with_capacity(values.len());
    for value in values {
        arguments.push(Value::Text(value.clone()));
        placeholders.push(format!("?{}", arguments.len()));
    }
    placeholders.join(", ")
}

/// Build indexed range predicates so prefix and suffix queries never scan every class row.
fn range_predicates(
    arguments: &mut Vec<Value>,
    values: &[String],
    column: &str,
    transform: impl Fn(&str) -> String,
) -> String {
    let mut predicates = Vec::with_capacity(values.len());
    for value in values {
        let lower = transform(value);
        let upper = prefix_upper_bound(&lower);
        arguments.push(Value::Text(lower));
        let lower_placeholder = arguments.len();
        match upper {
            Some(upper) => {
                arguments.push(Value::Text(upper));
                predicates.push(format!(
                    "({column} >= ?{lower_placeholder} AND {column} < ?{})",
                    arguments.len()
                ));
            }
            None => predicates.push(format!("({column} >= ?{lower_placeholder})")),
        }
    }
    predicates.join(" OR ")
}

fn read_committed_status(connection: &Connection) -> Result<CatalogStatus, CatalogError> {
    let Some(generation) = read_committed_generation(connection)? else {
        return Ok(CatalogStatus::Absent);
    };
    let stored = clamp_i64(generation.get());
    let summary = connection
        .query_row(
            "SELECT project_id, package_count, map_count, changed_packages, removed_packages, \
             completeness FROM committed_summary WHERE generation = ?1",
            params![stored],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?;
    let Some((
        project_id,
        package_count,
        map_count,
        changed_packages,
        removed_packages,
        completeness,
    )) = summary
    else {
        return Ok(CatalogStatus::Absent);
    };
    let mut statement = connection
        .prepare(
            "SELECT code, message, retry_safe FROM committed_diagnostic WHERE generation = ?1 \
             ORDER BY ordinal",
        )
        .map_err(storage_error)?;
    let diagnostics = statement
        .query_map(params![stored], |row| {
            Ok(CatalogDiagnostic {
                code: row.get(0)?,
                message: row.get(1)?,
                retry_safe: row.get::<_, i64>(2)? != 0,
            })
        })
        .map_err(storage_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    Ok(CatalogStatus::Ready {
        summary: RefreshSummary {
            project_id: ProjectId::new(project_id),
            generation,
            package_count: u64::try_from(package_count).unwrap_or_default(),
            map_count: u64::try_from(map_count).unwrap_or_default(),
            changed_packages: u64::try_from(changed_packages).unwrap_or_default(),
            removed_packages: u64::try_from(removed_packages).unwrap_or_default(),
            completeness: decode_completeness(&completeness),
            diagnostics,
        },
    })
}

fn read_committed_generation(connection: &Connection) -> Result<Option<Generation>, CatalogError> {
    let Some(value) = read_meta(connection, META_COMMITTED_GENERATION)? else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(|generation| Some(Generation::new(generation)))
        .map_err(|_| CatalogError::Corrupt {
            message: "the Catalog recorded an unreadable committed generation".to_owned(),
        })
}

fn read_meta(connection: &Connection, key: &str) -> Result<Option<String>, CatalogError> {
    connection
        .query_row(
            "SELECT value FROM catalog_meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(storage_error)
}

fn write_meta(connection: &Connection, key: &str, value: &str) -> Result<(), CatalogError> {
    connection
        .execute(
            "INSERT INTO catalog_meta (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map(|_| ())
        .map_err(storage_error)
}

fn collect_column(
    connection: &Connection,
    sql: &str,
    entry_id: i64,
) -> Result<Vec<String>, CatalogError> {
    let mut statement = connection.prepare_cached(sql).map_err(storage_error)?;
    let rows = statement
        .query_map(params![entry_id], |row| row.get::<_, String>(0))
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn open_connection(
    path: &Path,
    journal_mode: SqliteJournalMode,
) -> Result<Connection, CatalogError> {
    let connection = Connection::open(path).map_err(storage_error)?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(storage_error)?;
    let requested = journal_mode.pragma_value();
    let applied: String = connection
        .query_row(&format!("PRAGMA journal_mode = {requested}"), [], |row| {
            row.get(0)
        })
        .map_err(storage_error)?;
    if !applied.eq_ignore_ascii_case(requested) {
        return Err(CatalogError::Unavailable {
            message: format!("the Catalog refused the requested journal mode ({applied})"),
        });
    }
    // The Catalog is disposable derived data, so durability is traded for refresh throughput: a
    // lost commit rebuilds, and rollback still protects the previous committed Generation.
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(storage_error)?;
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .map_err(storage_error)?;
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<(), CatalogError> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(storage_error)?;
    match version {
        0 => {
            connection.execute_batch(SCHEMA_V3).map_err(storage_error)?;
            connection
                .pragma_update(None, "user_version", CATALOG_SCHEMA_VERSION)
                .map_err(storage_error)
        }
        1 | 2 => {
            connection
                .execute_batch(
                    "DROP TABLE IF EXISTS committed_diagnostic;
                     DROP TABLE IF EXISTS committed_summary;
                     DROP TABLE IF EXISTS entry_class;
                     DROP TABLE IF EXISTS entry_name;
                     DROP TABLE IF EXISTS entry;
                     DROP TABLE IF EXISTS catalog_meta;",
                )
                .map_err(storage_error)?;
            connection.execute_batch(SCHEMA_V3).map_err(storage_error)?;
            connection
                .pragma_update(None, "user_version", CATALOG_SCHEMA_VERSION)
                .map_err(storage_error)?;
            // Catalog data is disposable. Rebuild the incompatible evidence layout and reclaim the
            // repeated path keys instead of paying a multi-gigabyte row-by-row migration.
            connection.execute_batch("VACUUM").map_err(storage_error)
        }
        version if version == CATALOG_SCHEMA_VERSION => Ok(()),
        version => Err(CatalogError::Corrupt {
            message: format!(
                "the Catalog uses schema version {version}, newer than the supported version \
                 {CATALOG_SCHEMA_VERSION}"
            ),
        }),
    }
}

fn ensure_temp_staging_table(connection: &Connection) -> Result<(), CatalogError> {
    connection
        .execute_batch(TEMP_STAGING_SCHEMA)
        .map_err(storage_error)
}

fn verify_integrity(connection: &Connection) -> Result<(), CatalogError> {
    let outcome: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(storage_error)?;
    if outcome.eq_ignore_ascii_case("ok") {
        return Ok(());
    }
    Err(CatalogError::Corrupt {
        message: "the Catalog failed its integrity check".to_owned(),
    })
}

/// Move a broken Catalog aside so a fresh one can be built without touching project content.
fn quarantine(path: &Path) -> Result<Option<PathBuf>, CatalogError> {
    if !path.exists() {
        remove_catalog_files(path)?;
        return Ok(None);
    }
    for slot in 1..=MAX_QUARANTINE_SLOTS {
        let candidate = quarantine_path(path, slot);
        if candidate.exists() {
            continue;
        }
        return match fs::rename(path, &candidate) {
            Ok(()) => {
                remove_journal_files(path)?;
                Ok(Some(candidate))
            }
            Err(error) => Err(CatalogError::Unavailable {
                message: format!("could not quarantine the Project Index Catalog: {error}"),
            }),
        };
    }
    // Quarantine slots are bounded so a repeatedly broken Catalog cannot fill the cache root.
    remove_catalog_files(path)?;
    Ok(None)
}

fn quarantine_path(path: &Path, slot: u32) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".quarantine-{slot}"));
    path.with_file_name(name)
}

fn remove_catalog_files(path: &Path) -> Result<(), CatalogError> {
    for candidate in catalog_files(path) {
        remove_file(&candidate)?;
    }
    Ok(())
}

fn remove_journal_files(path: &Path) -> Result<(), CatalogError> {
    for candidate in catalog_files(path).into_iter().skip(1) {
        remove_file(&candidate)?;
    }
    Ok(())
}

fn remove_file(path: &Path) -> Result<(), CatalogError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CatalogError::Unavailable {
            message: format!("could not discard a Project Index Catalog file: {error}"),
        }),
    }
}

/// The Catalog file first, then every journal sidecar the adapter may own.
fn catalog_files(path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![path.to_owned()];
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(suffix);
        paths.push(path.with_file_name(name));
    }
    paths
}

/// Stable, project-name-free Catalog file name derived from the canonical project identity.
fn catalog_file_name(project_id: &ProjectId) -> String {
    format!("project-{:016x}.catalog", stable_hash(project_id.as_str()))
}

/// FNV-1a 64. Deterministic across builds and platforms, and never reversed into a project path.
fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn is_map(signature: &PackageSignature) -> bool {
    signature.kind == EntryKind::Package
        && signature
            .relative_path
            .to_ascii_lowercase()
            .ends_with(".umap")
}

fn header_profile_version(entry: &StagedPackage) -> Option<i64> {
    entry
        .header
        .as_ref()
        .map(|header| i64::from(header.profile_version))
}

fn header_package_name(entry: &StagedPackage) -> Option<String> {
    entry
        .header
        .as_ref()
        .map(|header| header.package_name.clone())
}

fn header_failure_code(entry: &StagedPackage) -> Option<String> {
    entry
        .header
        .as_ref()
        .and_then(|header| header.failure_code.clone())
}

fn encode_kind(kind: EntryKind) -> i64 {
    match kind {
        EntryKind::Package => KIND_PACKAGE,
        EntryKind::Sidecar => KIND_SIDECAR,
    }
}

fn decode_kind(kind: i64) -> EntryKind {
    if kind == KIND_SIDECAR {
        EntryKind::Sidecar
    } else {
        EntryKind::Package
    }
}

fn encode_completeness(completeness: Completeness) -> &'static str {
    match completeness {
        Completeness::Complete => "complete",
        Completeness::Partial => "partial",
    }
}

fn decode_completeness(value: &str) -> Completeness {
    if value == "partial" {
        Completeness::Partial
    } else {
        Completeness::Complete
    }
}

fn encode_strings(values: &[String]) -> Result<String, CatalogError> {
    serde_json::to_string(values).map_err(|error| CatalogError::Unavailable {
        message: format!("could not encode staged Project Index evidence: {error}"),
    })
}

fn encode_class_rows(values: &[String]) -> Result<String, CatalogError> {
    let rows = values
        .iter()
        .map(|class_path| {
            [
                class_path.clone(),
                reverse_characters(class_name(class_path)),
            ]
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&rows).map_err(|error| CatalogError::Unavailable {
        message: format!("could not encode Project Index class evidence: {error}"),
    })
}

fn decode_strings(value: &str) -> Result<Vec<String>, CatalogError> {
    serde_json::from_str(value).map_err(|error| CatalogError::Corrupt {
        message: format!("could not decode staged Project Index evidence: {error}"),
    })
}

fn clamp_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn clamp_usize(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn storage_error(error: rusqlite::Error) -> CatalogError {
    let corrupt = matches!(
        &error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase
            )
    );
    if corrupt {
        return CatalogError::Corrupt {
            message: format!("the Project Index Catalog is unreadable: {error}"),
        };
    }
    CatalogError::Unavailable {
        message: format!("the Project Index Catalog is unavailable: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::cancellation::CancellationToken;
    use crate::direct_executor::catalog::{PROJECT_INDEX_MAX_PAGE_SIZE, project_id_from_root};
    use crate::direct_executor::catalog_conformance::{
        self as conformance, FIXTURE_PROJECT_ROOT, catalog_conformance_tests,
    };
    use crate::direct_executor::catalog_memory::MemoryCatalog;
    use crate::direct_executor::project_index::{CoordinatorError, refresh};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temporary_cache_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("ue-shed-catalog-{nanos}-{sequence}"));
        fs::create_dir_all(&path).expect("create temporary cache root");
        path
    }

    fn open_catalog(cache_root: &Path, journal_mode: SqliteJournalMode) -> SqliteCatalog {
        SqliteCatalog::open(
            cache_root,
            &project_id_from_root(FIXTURE_PROJECT_ROOT),
            journal_mode,
        )
        .expect("open Catalog")
    }

    fn catalog_path(cache_root: &Path) -> PathBuf {
        cache_root
            .join(CATALOG_DIRECTORY)
            .join(catalog_file_name(&project_id_from_root(
                FIXTURE_PROJECT_ROOT,
            )))
    }

    /// Conformance catalogs own their disposable cache root and remove it when dropped.
    fn write_ahead_catalog() -> SqliteCatalog {
        scoped_catalog(SqliteJournalMode::WriteAhead)
    }

    fn rollback_catalog() -> SqliteCatalog {
        scoped_catalog(SqliteJournalMode::Rollback)
    }

    fn scoped_catalog(journal_mode: SqliteJournalMode) -> SqliteCatalog {
        let root = temporary_cache_root();
        let mut catalog = open_catalog(&root, journal_mode);
        catalog.cleanup_root = Some(root);
        catalog
    }

    catalog_conformance_tests!(write_ahead_journal, write_ahead_catalog);
    catalog_conformance_tests!(rollback_journal, rollback_catalog);

    /// Reproducible journal-mode comparison behind `--ignored`, kept out of ordinary test runs.
    ///
    /// Run with:
    /// `cargo test -p uasset-io --lib -- --ignored --nocapture journal_mode_refresh_measurement`
    #[test]
    #[ignore = "timing measurement, not a behavioral assertion"]
    fn journal_mode_refresh_measurement() {
        const PACKAGES: usize = 20_000;
        let mut entries = Vec::with_capacity(PACKAGES);
        let mut headers = BTreeMap::new();
        for index in 0..PACKAGES {
            let path = format!("Content/Batch/{:02}/DT_{index:06}.uasset", index % 64);
            entries.push(conformance::package(&path, 1_024, index as u64));
            headers.insert(
                path,
                conformance::header(
                    &format!("/Game/Batch/DT_{index:06}"),
                    &["/Script/Engine.DataTable"],
                    &["RowStruct", "TextProperty"],
                ),
            );
        }
        let scanner = conformance::FakeScanner {
            entries,
            headers,
            ..conformance::FakeScanner::default()
        };
        for journal_mode in [SqliteJournalMode::WriteAhead, SqliteJournalMode::Rollback] {
            let mut catalog = scoped_catalog(journal_mode);
            let cold = std::time::Instant::now();
            refresh_catalog(&mut catalog, &scanner).expect("cold refresh");
            let cold = cold.elapsed();
            let warm = std::time::Instant::now();
            refresh_catalog(&mut catalog, &scanner).expect("warm refresh");
            let warm = warm.elapsed();
            println!(
                "{journal_mode:?}: packages={PACKAGES} cold={cold:?} warm={warm:?} \
                 bytes={} writes={:?}",
                catalog.storage_bytes(),
                catalog.write_counts()
            );
        }
    }

    fn single_table_scanner() -> conformance::FakeScanner {
        conformance::FakeScanner {
            entries: vec![conformance::package("Content/A.uasset", 10, 1)],
            headers: BTreeMap::from([(
                "Content/A.uasset".to_owned(),
                conformance::header("/Game/A", &["/Script/Engine.DataTable"], &[]),
            )]),
            ..conformance::FakeScanner::default()
        }
    }

    fn refresh_catalog(
        catalog: &mut SqliteCatalog,
        scanner: &conformance::FakeScanner,
    ) -> Result<Vec<crate::direct_executor::project_index::RefreshEvent>, CoordinatorError> {
        refresh(
            catalog,
            scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
    }

    #[test]
    fn warm_no_op_refresh_writes_no_evidence_rows() {
        let mut catalog = write_ahead_catalog();
        let scanner = conformance::FakeScanner {
            entries: vec![
                conformance::package("Content/A.uasset", 10, 1),
                conformance::sidecar("Content/A.uexp", 2, 1),
            ],
            headers: BTreeMap::from([(
                "Content/A.uasset".to_owned(),
                conformance::header("/Game/A", &["/Script/Engine.DataTable"], &["RowStruct"]),
            )]),
            ..conformance::FakeScanner::default()
        };
        refresh_catalog(&mut catalog, &scanner).expect("cold refresh");
        let cold = catalog.write_counts();
        assert_eq!(
            cold.staged_evidence_rows, 0,
            "generation one writes directly inside its unpublished transaction"
        );
        assert_eq!(cold.committed_evidence_rows, 2);
        assert_eq!(cold.removed_evidence_rows, 0);

        refresh_catalog(&mut catalog, &scanner).expect("warm refresh");
        assert_eq!(
            catalog.write_counts(),
            cold,
            "an exact warm no-op rewrites no package evidence rows"
        );
        assert_eq!(scanner.header_reads.get(), 1);
        assert_eq!(catalog.journal_mode(), SqliteJournalMode::WriteAhead);
    }

    #[test]
    fn cold_ingest_flushes_only_at_the_bounded_batch_size() {
        let mut catalog = write_ahead_catalog();
        let token = catalog.begin_refresh().expect("begin cold refresh");
        for index in 0..STREAM_BATCH - 1 {
            catalog
                .stage_observed(
                    &token,
                    StagedPackage {
                        signature: conformance::sidecar(
                            &format!("Content/Batch/A_{index:06}.uexp"),
                            1,
                            1,
                        ),
                        header: None,
                    },
                )
                .expect("buffer evidence");
        }
        let before_flush: i64 = catalog
            .connection
            .query_row("SELECT COUNT(*) FROM entry", [], |row| row.get(0))
            .expect("count buffered rows");
        assert_eq!(before_flush, 0);
        assert_eq!(catalog.write_counts().committed_evidence_rows, 0);

        catalog
            .stage_observed(
                &token,
                StagedPackage {
                    signature: conformance::sidecar("Content/Batch/A_final.uexp", 1, 1),
                    header: None,
                },
            )
            .expect("flush evidence batch");
        let after_flush: i64 = catalog
            .connection
            .query_row("SELECT COUNT(*) FROM entry", [], |row| row.get(0))
            .expect("count flushed rows");
        assert_eq!(after_flush, STREAM_BATCH as i64);
        assert_eq!(
            catalog.write_counts().committed_evidence_rows,
            STREAM_BATCH as u64
        );

        catalog
            .discard_refresh(token)
            .expect("discard cold refresh");
        assert!(catalog.committed_entries().is_empty());
    }

    #[test]
    fn staging_is_connection_local_and_map_index_is_partial() {
        let catalog = write_ahead_catalog();
        let persistent_staging: Option<String> = catalog
            .connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'staged_entry'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("inspect persistent schema");
        assert_eq!(persistent_staging, None);

        let temporary_staging: Option<String> = catalog
            .connection
            .query_row(
                "SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = 'staged_entry'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("inspect temporary schema");
        assert_eq!(temporary_staging.as_deref(), Some("staged_entry"));

        let map_index: String = catalog
            .connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'entry_by_map'",
                [],
                |row| row.get(0),
            )
            .expect("inspect map index");
        assert!(map_index.contains("WHERE is_map = 1"));

        let evidence_columns = catalog
            .connection
            .prepare("PRAGMA table_info(entry_name)")
            .expect("inspect evidence columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("read evidence columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect evidence columns");
        assert!(evidence_columns.iter().any(|column| column == "entry_id"));
        assert!(
            !evidence_columns
                .iter()
                .any(|column| column == "relative_path")
        );
    }

    #[test]
    fn version_two_catalogs_rebuild_into_compact_schema_three() {
        let connection = Connection::open_in_memory().expect("legacy catalog");
        connection
            .execute_batch(
                "CREATE TABLE entry (relative_path TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID;
                 CREATE TABLE entry_class (relative_path TEXT NOT NULL, ordinal INTEGER NOT NULL,
                     PRIMARY KEY (relative_path, ordinal)) WITHOUT ROWID;
                 CREATE TABLE entry_name (relative_path TEXT NOT NULL, ordinal INTEGER NOT NULL,
                     PRIMARY KEY (relative_path, ordinal)) WITHOUT ROWID;
                 PRAGMA user_version = 2;",
            )
            .expect("legacy schema");

        migrate(&connection).expect("migrate disposable catalog");

        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        assert_eq!(version, CATALOG_SCHEMA_VERSION);
        let entry_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM entry", [], |row| row.get(0))
            .expect("rebuilt entry table");
        assert_eq!(entry_count, 0);
    }

    #[test]
    fn interrupted_commit_rolls_back_and_keeps_the_prior_generation() {
        let mut catalog = write_ahead_catalog();
        let mut scanner = single_table_scanner();
        let first = refresh_catalog(&mut catalog, &scanner).expect("first refresh");
        let generation = conformance::completed_summary(&first).generation;

        catalog.fail_commit_before_publish = true;
        scanner.entries = vec![conformance::package("Content/B.uasset", 10, 1)];
        scanner.headers.insert(
            "Content/B.uasset".to_owned(),
            conformance::header("/Game/B", &["/Script/Engine.DataTable"], &[]),
        );
        let error = refresh_catalog(&mut catalog, &scanner).expect_err("injected commit failure");
        assert!(matches!(
            error,
            CoordinatorError::Catalog(CatalogError::Unavailable { .. })
        ));
        assert_eq!(catalog.committed_generation(), Some(generation));
        assert_eq!(
            catalog.committed_relative_paths(),
            vec!["Content/A.uasset".to_owned()],
            "a failed commit deletes nothing"
        );
        assert!(
            conformance::collect_pages(
                &catalog,
                generation,
                crate::direct_executor::catalog::QueryKind::ExactClasses {
                    values: vec!["/Script/Engine.DataTable".to_owned()]
                },
                10
            )
            .len()
                == 1
        );

        // The Catalog stays usable and the next refresh advances exactly one generation.
        catalog.fail_commit_before_publish = false;
        let recovered = refresh_catalog(&mut catalog, &scanner).expect("refresh after failure");
        let summary = conformance::completed_summary(&recovered);
        assert_eq!(summary.generation, generation.next());
        assert_eq!(summary.removed_packages, 1);
        assert_eq!(
            catalog.committed_relative_paths(),
            vec!["Content/B.uasset".to_owned()]
        );
    }

    #[test]
    fn interrupted_first_generation_rolls_back_direct_publication() {
        let mut catalog = write_ahead_catalog();
        let scanner = single_table_scanner();
        catalog.fail_commit_before_publish = true;

        assert!(refresh_catalog(&mut catalog, &scanner).is_err());
        assert_eq!(catalog.status(), CatalogStatus::Absent);
        assert!(catalog.committed_entries().is_empty());
        assert!(!catalog.staging_transaction);

        catalog.fail_commit_before_publish = false;
        refresh_catalog(&mut catalog, &scanner).expect("retry cold refresh");
        assert_eq!(catalog.committed_entries().len(), 1);
    }

    #[test]
    fn a_reopened_catalog_serves_the_committed_generation() {
        let root = temporary_cache_root();
        let generation = {
            let mut catalog = open_catalog(&root, SqliteJournalMode::default());
            let scanner = conformance::FakeScanner {
                entries: vec![conformance::package("Content/Maps/L_A.umap", 10, 1)],
                headers: BTreeMap::from([(
                    "Content/Maps/L_A.umap".to_owned(),
                    conformance::header("/Game/Maps/L_A", &["/Script/Engine.World"], &[]),
                )]),
                ..conformance::FakeScanner::default()
            };
            let events = refresh_catalog(&mut catalog, &scanner).expect("refresh");
            assert!(catalog.storage_bytes() > 0);
            conformance::completed_summary(&events).generation
        };

        let reopened = open_catalog(&root, SqliteJournalMode::default());
        assert_eq!(reopened.committed_generation(), Some(generation));
        assert!(reopened.quarantined_from().is_none());
        let items = conformance::collect_pages(
            &reopened,
            generation,
            crate::direct_executor::catalog::QueryKind::Maps,
            10,
        );
        assert_eq!(items.len(), 1);
        drop(reopened);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_reader_observes_the_previous_generation_during_a_refresh() {
        for journal_mode in [SqliteJournalMode::WriteAhead, SqliteJournalMode::Rollback] {
            let root = temporary_cache_root();
            let mut writer = open_catalog(&root, journal_mode);
            let scanner = conformance::FakeScanner {
                entries: vec![conformance::package("Content/Maps/L_A.umap", 10, 1)],
                headers: BTreeMap::from([(
                    "Content/Maps/L_A.umap".to_owned(),
                    conformance::header("/Game/Maps/L_A", &["/Script/Engine.World"], &[]),
                )]),
                ..conformance::FakeScanner::default()
            };
            let generation = conformance::completed_summary(
                &refresh_catalog(&mut writer, &scanner).expect("cold"),
            )
            .generation;

            // Hold an incomplete refresh open, then read through an independent connection.
            let token = writer.begin_refresh().expect("staging");
            writer
                .stage_observed(
                    &token,
                    StagedPackage {
                        signature: conformance::package("Content/Maps/L_B.umap", 10, 1),
                        header: Some(conformance::header(
                            "/Game/Maps/L_B",
                            &["/Script/Engine.World"],
                            &[],
                        )),
                    },
                )
                .expect("stage during refresh");

            let reader = open_catalog(&root, journal_mode);
            assert_eq!(
                reader.committed_generation(),
                Some(generation),
                "{journal_mode:?}: readers observe the previous committed generation"
            );
            let items = conformance::collect_pages(
                &reader,
                generation,
                crate::direct_executor::catalog::QueryKind::Maps,
                10,
            );
            assert_eq!(
                items.len(),
                1,
                "{journal_mode:?}: pages exclude staged rows"
            );
            drop(reader);
            writer.discard_refresh(token).expect("discard staging");
            drop(writer);
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn an_unreadable_catalog_is_quarantined_and_rebuilt() {
        let root = temporary_cache_root();
        let path = catalog_path(&root);
        fs::create_dir_all(path.parent().expect("catalog directory"))
            .expect("create catalog directory");
        fs::write(&path, b"this is not a Catalog").expect("write a broken Catalog");

        let catalog = open_catalog(&root, SqliteJournalMode::default());
        let quarantined = catalog
            .quarantined_from()
            .expect("the broken Catalog was quarantined")
            .to_owned();
        assert_eq!(
            fs::read(&quarantined).expect("read the quarantined file"),
            b"this is not a Catalog",
            "the broken file is kept for inspection instead of being deleted"
        );
        assert!(matches!(catalog.status(), CatalogStatus::Absent));
        assert_eq!(catalog.committed_generation(), None);
        drop(catalog);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_newer_schema_version_is_quarantined_rather_than_migrated_down() {
        let root = temporary_cache_root();
        drop(open_catalog(&root, SqliteJournalMode::Rollback));
        {
            let connection = Connection::open(catalog_path(&root)).expect("open the Catalog file");
            connection
                .pragma_update(None, "user_version", CATALOG_SCHEMA_VERSION + 1)
                .expect("record a newer schema version");
        }
        let catalog = open_catalog(&root, SqliteJournalMode::Rollback);
        assert!(catalog.quarantined_from().is_some());
        assert!(matches!(catalog.status(), CatalogStatus::Absent));
        drop(catalog);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_catalog_for_another_project_identity_is_quarantined() {
        let root = temporary_cache_root();
        let mut catalog = open_catalog(&root, SqliteJournalMode::default());
        refresh_catalog(&mut catalog, &single_table_scanner()).expect("refresh");
        drop(catalog);

        // The location is derived from project identity, so a mismatch can only mean a stale or
        // colliding cache file. It is quarantined instead of being answered from.
        let foreign = SqliteCatalog::open(
            &root,
            &ProjectId::new("c:/another-project"),
            SqliteJournalMode::default(),
        )
        .expect("open a foreign Catalog");
        assert!(matches!(foreign.status(), CatalogStatus::Absent));
        drop(foreign);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rebuild_discards_the_exact_catalog_files() {
        let root = temporary_cache_root();
        let mut catalog = open_catalog(&root, SqliteJournalMode::default());
        refresh_catalog(&mut catalog, &single_table_scanner()).expect("refresh");

        catalog.clear_for_rebuild().expect("rebuild");
        assert!(matches!(catalog.status(), CatalogStatus::Absent));
        assert!(catalog.committed_relative_paths().is_empty());
        assert_eq!(catalog.write_counts(), CatalogWriteCounts::default());
        assert!(
            !quarantine_path(&catalog_path(&root), 1).exists(),
            "an explicit rebuild discards rather than quarantines"
        );
        assert!(
            catalog_path(&root).exists(),
            "a fresh Catalog replaces the discarded one"
        );
        drop(catalog);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_locations_follow_canonical_project_identity() {
        let aliases = [
            "C:/Fixture",
            "C:\\Fixture",
            "C:/Fixture/",
            #[cfg(windows)]
            "c:\\fixture",
        ];
        let names: Vec<String> = aliases
            .iter()
            .map(|root| catalog_file_name(&project_id_from_root(root)))
            .collect();
        assert!(
            names.windows(2).all(|pair| pair[0] == pair[1]),
            "separators, trailing separators, and Windows case aliases share one Catalog"
        );
        assert_ne!(
            names[0],
            catalog_file_name(&project_id_from_root("C:/Other"))
        );
        assert!(
            !names[0].to_ascii_lowercase().contains("fixture"),
            "the Catalog file name must not carry a project path"
        );
    }

    #[test]
    fn memory_and_sqlite_adapters_answer_fixtures_identically() {
        use crate::direct_executor::catalog::QueryKind;

        let mut sqlite = write_ahead_catalog();
        let mut memory = MemoryCatalog::new();
        let scanner = conformance::FakeScanner {
            entries: vec![
                conformance::package("Content/Input/IA_Move.uasset", 10, 1),
                conformance::package("Content/Maps/L_Alpha.umap", 12, 2),
                conformance::package("Content/Maps/L_Beta.umap", 12, 3),
                conformance::package("Content/Text/DT_Lines.uasset", 14, 4),
                conformance::sidecar("Content/Text/DT_Lines.uexp", 4, 4),
            ],
            headers: BTreeMap::from([
                (
                    "Content/Input/IA_Move.uasset".to_owned(),
                    conformance::header(
                        "/Game/Input/IA_Move",
                        &["/Script/EnhancedInput.InputAction"],
                        &["Triggers"],
                    ),
                ),
                (
                    "Content/Maps/L_Alpha.umap".to_owned(),
                    conformance::header("/Game/Maps/L_Alpha", &["/Script/Engine.World"], &[]),
                ),
                (
                    "Content/Maps/L_Beta.umap".to_owned(),
                    conformance::header("", &["/Script/Engine.World"], &[]),
                ),
                (
                    "Content/Text/DT_Lines.uasset".to_owned(),
                    conformance::header(
                        "/Game/Text/DT_Lines",
                        &["/Script/Engine.DataTable"],
                        &["TextProperty"],
                    ),
                ),
            ]),
            ..conformance::FakeScanner::default()
        };

        let sqlite_summary = conformance::completed_summary(
            &refresh_catalog(&mut sqlite, &scanner).expect("sqlite"),
        );
        let memory_summary = conformance::completed_summary(
            &refresh(
                &mut memory,
                &scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .expect("memory refresh"),
        );
        assert_eq!(sqlite_summary, memory_summary);
        assert_eq!(sqlite.status(), memory.status());
        assert_eq!(
            sqlite.committed_relative_paths(),
            memory.committed_relative_paths()
        );
        for path in memory.committed_relative_paths() {
            assert_eq!(
                sqlite.lookup_committed(&path),
                memory.lookup_committed(&path),
                "{path} must round-trip identically"
            );
        }

        let kinds = [
            QueryKind::Maps,
            QueryKind::ExactClasses {
                values: vec!["/Script/Engine.World".to_owned()],
            },
            QueryKind::ClassPrefixes {
                values: vec!["/Script/".to_owned()],
            },
            QueryKind::ClassNameSuffixes {
                values: vec!["Table".to_owned(), "Action".to_owned()],
            },
            QueryKind::SerializedNames {
                values: vec!["TextProperty".to_owned(), "Triggers".to_owned()],
            },
            QueryKind::ExactClasses { values: Vec::new() },
        ];
        for kind in kinds {
            for limit in [1, 2, PROJECT_INDEX_MAX_PAGE_SIZE] {
                assert_eq!(
                    conformance::collect_pages(
                        &sqlite,
                        sqlite_summary.generation,
                        kind.clone(),
                        limit
                    ),
                    conformance::collect_pages(
                        &memory,
                        memory_summary.generation,
                        kind.clone(),
                        limit
                    ),
                    "{kind:?} at page size {limit} must match across adapters"
                );
            }
        }
    }
}
