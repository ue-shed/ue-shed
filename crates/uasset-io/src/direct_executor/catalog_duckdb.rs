//! Immutable DuckDB Catalog adapter.
//!
//! Each committed physical snapshot is a read-only DuckDB file. A small atomically replaced
//! manifest maps the logical Project Index Generation to that file. Refreshes write a new file
//! beside the committed snapshot and never mutate data visible to readers.

#[cfg(test)]
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use atomic_write_file::AtomicWriteFile;
use duckdb::arrow::array::{
    ArrayRef, BooleanArray, ListBuilder, StringArray, StringBuilder, UInt8Array, UInt32Array,
    UInt64Array,
};
use duckdb::arrow::datatypes::{DataType, Field, Schema};
use duckdb::arrow::record_batch::RecordBatch;
use duckdb::types::Value;
use duckdb::{AccessMode, Config, Connection, OptionalExt, params, params_from_iter};
use serde::{Deserialize, Serialize};

use super::catalog::{
    Catalog, CatalogDiagnostic, CatalogError, CatalogSnapshotEntry, CatalogStatus, Completeness,
    EntryKind, Generation, HeaderEvidence, PackageSignature, ProjectId, QueryItem, QueryKind,
    QueryPage, QueryRequest, RefreshSummary, StagedPackage, StagingToken, class_name, item_path,
    parse_page_cursor, validate_page_limit,
};
use super::project_index::CatalogSnapshot;

const CATALOG_DIRECTORY: &str = "catalogs-v2";
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const STREAM_BATCH: usize = 1_024;
const QUERY_THREADS: i64 = 4;
const WRITER_MEMORY_LIMIT: &str = "384MB";
const SNAPSHOT_ROW_GROUP_SIZE: u64 = 32_768;
const MAX_QUARANTINE_SLOTS: u32 = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CatalogWriteCounts {
    pub(crate) staged_evidence_rows: u64,
    pub(crate) committed_evidence_rows: u64,
    pub(crate) removed_evidence_rows: u64,
    pub(crate) evidence_write_duration: Duration,
}

const ENTRY_COLUMNS: &str = "relative_path, kind, size, modified_nanos, is_map, \
    profile_version, package_name, failure_code, classes, class_names, serialized_names";

const STAGING_SCHEMA: &str = "
CREATE TABLE staged (
    relative_path VARCHAR PRIMARY KEY,
    kind UTINYINT NOT NULL,
    size UBIGINT NOT NULL,
    modified_nanos UBIGINT NOT NULL,
    is_map BOOLEAN NOT NULL,
    profile_version UINTEGER,
    package_name VARCHAR,
    failure_code VARCHAR,
    classes VARCHAR[] NOT NULL,
    class_names VARCHAR[] NOT NULL,
    serialized_names VARCHAR[] NOT NULL
);
CREATE TABLE previous AS SELECT * FROM staged WHERE false;
CREATE TABLE observed (relative_path VARCHAR PRIMARY KEY);
";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ManifestDiagnostic {
    code: String,
    message: String,
    retry_safe: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ManifestSummary {
    changed_packages: u64,
    completeness: String,
    diagnostics: Vec<ManifestDiagnostic>,
    generation: u64,
    map_count: u64,
    package_count: u64,
    removed_packages: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Manifest {
    manifest_schema_version: u32,
    snapshot_schema_version: u32,
    project_id: String,
    physical_snapshot: String,
    previous_snapshot: Option<String>,
    summary: ManifestSummary,
}

impl ManifestSummary {
    fn from_refresh(summary: &RefreshSummary) -> Self {
        Self {
            changed_packages: summary.changed_packages,
            completeness: match summary.completeness {
                Completeness::Complete => "complete".to_owned(),
                Completeness::Partial => "partial".to_owned(),
            },
            diagnostics: summary
                .diagnostics
                .iter()
                .map(|diagnostic| ManifestDiagnostic {
                    code: diagnostic.code.clone(),
                    message: diagnostic.message.clone(),
                    retry_safe: diagnostic.retry_safe,
                })
                .collect(),
            generation: summary.generation.get(),
            map_count: summary.map_count,
            package_count: summary.package_count,
            removed_packages: summary.removed_packages,
        }
    }

    fn to_refresh(&self, project_id: &ProjectId) -> RefreshSummary {
        RefreshSummary {
            project_id: project_id.clone(),
            generation: Generation::new(self.generation),
            package_count: self.package_count,
            map_count: self.map_count,
            changed_packages: self.changed_packages,
            removed_packages: self.removed_packages,
            completeness: if self.completeness == "complete" {
                Completeness::Complete
            } else {
                Completeness::Partial
            },
            diagnostics: self
                .diagnostics
                .iter()
                .map(|diagnostic| CatalogDiagnostic {
                    code: diagnostic.code.clone(),
                    message: diagnostic.message.clone(),
                    retry_safe: diagnostic.retry_safe,
                })
                .collect(),
        }
    }
}

struct Staging {
    connection: Connection,
    generation: Generation,
    observed: BTreeSet<String>,
    pending: Vec<StagedPackage>,
    physical_snapshot: String,
    snapshot_path: PathBuf,
    staged_count: u64,
    temporary_directory: PathBuf,
}

struct QueryConnection {
    connection: Connection,
    physical_snapshot: String,
}

/// Disposable DuckDB Catalog for one canonical project identity.
pub(crate) struct DuckdbCatalog {
    directory: PathBuf,
    project_id: ProjectId,
    manifest: Option<Manifest>,
    staging: Option<Staging>,
    quarantined_from: Option<PathBuf>,
    writes: CatalogWriteCounts,
    query_connection: RefCell<Option<QueryConnection>>,
    #[cfg(test)]
    query_connection_opens: Cell<u64>,
    #[cfg(test)]
    cleanup_root: Option<PathBuf>,
}

impl std::fmt::Debug for DuckdbCatalog {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DuckdbCatalog")
            .field("project_id", &self.project_id)
            .field("generation", &self.committed_generation())
            .field("refreshing", &self.staging.is_some())
            .finish()
    }
}

impl DuckdbCatalog {
    pub(crate) fn open(cache_root: &Path, project_id: &ProjectId) -> Result<Self, CatalogError> {
        Self::open_with_integrity(cache_root, project_id, true)
    }

    #[allow(dead_code)]
    pub(crate) fn open_for_query(
        cache_root: &Path,
        project_id: &ProjectId,
    ) -> Result<Self, CatalogError> {
        Self::open_with_integrity(cache_root, project_id, false)
    }

    fn open_with_integrity(
        cache_root: &Path,
        project_id: &ProjectId,
        check_integrity: bool,
    ) -> Result<Self, CatalogError> {
        let root = cache_root.join(CATALOG_DIRECTORY);
        fs::create_dir_all(&root).map_err(io_unavailable("create the Catalog cache root"))?;
        let directory = root.join(catalog_directory_name(project_id));
        fs::create_dir_all(&directory)
            .map_err(io_unavailable("create the project Catalog directory"))?;
        match read_and_verify_manifest(&directory, project_id, check_integrity) {
            Ok(manifest) => Ok(Self {
                directory,
                project_id: project_id.clone(),
                manifest,
                staging: None,
                quarantined_from: None,
                writes: CatalogWriteCounts::default(),
                query_connection: RefCell::new(None),
                #[cfg(test)]
                query_connection_opens: Cell::new(0),
                #[cfg(test)]
                cleanup_root: None,
            }),
            Err(CatalogError::Corrupt { message }) => {
                let quarantined_from = quarantine_directory(&directory)?;
                fs::create_dir_all(&directory)
                    .map_err(io_unavailable("recreate the project Catalog directory"))?;
                let _ = message;
                Ok(Self {
                    directory,
                    project_id: project_id.clone(),
                    manifest: None,
                    staging: None,
                    quarantined_from,
                    writes: CatalogWriteCounts::default(),
                    query_connection: RefCell::new(None),
                    #[cfg(test)]
                    query_connection_opens: Cell::new(0),
                    #[cfg(test)]
                    cleanup_root: None,
                })
            }
            Err(error) => Err(error),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn quarantined_from(&self) -> Option<&Path> {
        self.quarantined_from.as_deref()
    }

    #[allow(dead_code)]
    pub(crate) fn storage_bytes(&self) -> u64 {
        fs::read_dir(&self.directory)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.metadata().ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .sum()
    }

    pub(crate) fn write_counts(&self) -> CatalogWriteCounts {
        self.writes
    }

    fn committed_snapshot_path(&self) -> Option<PathBuf> {
        self.manifest
            .as_ref()
            .map(|manifest| self.directory.join(&manifest.physical_snapshot))
    }

    fn flush_pending(&mut self) -> Result<(), CatalogError> {
        let Some(staging) = self.staging.as_mut() else {
            return Ok(());
        };
        if staging.pending.is_empty() {
            return Ok(());
        }
        let pending = std::mem::replace(&mut staging.pending, Vec::with_capacity(STREAM_BATCH));
        let count = pending.len() as u64;
        let started = Instant::now();
        append_entries(&staging.connection, "staged", &pending)?;
        self.writes.evidence_write_duration += started.elapsed();
        self.writes.staged_evidence_rows += count;
        staging.staged_count += count;
        Ok(())
    }

    fn require_staging(&self, token: &StagingToken) -> Result<&Staging, CatalogError> {
        match &self.staging {
            Some(staging) if staging.generation == token.generation => Ok(staging),
            Some(_) => Err(CatalogError::InvalidRequest {
                message: "staging token does not match the active refresh".to_owned(),
            }),
            None => Err(CatalogError::Unavailable {
                message: "no Project Index refresh is in progress".to_owned(),
            }),
        }
    }

    fn committed_connection(&self) -> Result<Option<Connection>, CatalogError> {
        self.committed_snapshot_path()
            .map(|path| open_connection(&path, AccessMode::ReadOnly))
            .transpose()
    }
}

impl Catalog for DuckdbCatalog {
    fn status(&self) -> CatalogStatus {
        match &self.manifest {
            Some(manifest) => CatalogStatus::Ready {
                summary: manifest.summary.to_refresh(&self.project_id),
            },
            None => CatalogStatus::Absent,
        }
    }

    fn committed_generation(&self) -> Option<Generation> {
        self.manifest
            .as_ref()
            .map(|manifest| Generation::new(manifest.summary.generation))
    }

    fn lookup_committed(
        &self,
        relative_path: &str,
    ) -> Option<(PackageSignature, Option<HeaderEvidence>)> {
        let connection = self.committed_connection().ok().flatten()?;
        connection
            .query_row(
                "SELECT kind, size, modified_nanos, profile_version, package_name, \
                 failure_code, classes, serialized_names FROM entry WHERE relative_path = ?1",
                params![relative_path],
                |row| {
                    let profile_version = row.get::<_, Option<u32>>(3)?;
                    let package_name = row.get::<_, Option<String>>(4)?;
                    let failure_code = row.get::<_, Option<String>>(5)?;
                    let classes = strings_from_value(row.get(6)?).map_err(to_duckdb_error)?;
                    let serialized_names =
                        strings_from_value(row.get(7)?).map_err(to_duckdb_error)?;
                    Ok((
                        PackageSignature {
                            relative_path: relative_path.to_owned(),
                            kind: decode_kind(row.get(0)?),
                            size: row.get(1)?,
                            modified_nanos: row.get(2)?,
                        },
                        profile_version.map(|profile_version| HeaderEvidence {
                            profile_version,
                            package_name: package_name.unwrap_or_default(),
                            classes,
                            serialized_names,
                            failure_code,
                        }),
                    ))
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    fn begin_refresh(&mut self) -> Result<StagingToken, CatalogError> {
        if self.staging.is_some() {
            return Err(CatalogError::Unavailable {
                message: "a Project Index refresh is already in progress".to_owned(),
            });
        }
        let generation = self
            .committed_generation()
            .map(Generation::next)
            .unwrap_or(Generation::new(1));
        let physical_snapshot = snapshot_file_name(generation);
        let snapshot_path = self.directory.join(&physical_snapshot);
        let temporary_directory = snapshot_path.with_extension("duckdb.tmp");
        if snapshot_path.exists() {
            fs::remove_file(&snapshot_path)
                .map_err(io_unavailable("remove an abandoned unpublished snapshot"))?;
        }
        if temporary_directory.exists() {
            fs::remove_dir_all(&temporary_directory)
                .map_err(io_unavailable("remove abandoned DuckDB spill files"))?;
        }
        let connection = open_writable_snapshot(&snapshot_path, &temporary_directory)?;
        connection
            .execute_batch(STAGING_SCHEMA)
            .map_err(storage_error("create DuckDB staging tables"))?;
        self.writes = CatalogWriteCounts::default();
        self.staging = Some(Staging {
            connection,
            generation,
            observed: BTreeSet::new(),
            pending: Vec::with_capacity(STREAM_BATCH),
            physical_snapshot,
            snapshot_path,
            staged_count: 0,
            temporary_directory,
        });
        Ok(StagingToken { generation })
    }

    fn observe_unchanged(
        &mut self,
        token: &StagingToken,
        relative_path: &str,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        if let Some(staging) = self.staging.as_mut() {
            staging.observed.insert(relative_path.to_owned());
        }
        Ok(())
    }

    fn stage_observed(
        &mut self,
        token: &StagingToken,
        entry: StagedPackage,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        if let Some(staging) = self.staging.as_mut() {
            staging
                .observed
                .insert(entry.signature.relative_path.clone());
            staging.pending.push(entry);
        }
        if self
            .staging
            .as_ref()
            .is_some_and(|staging| staging.pending.len() >= STREAM_BATCH)
        {
            self.flush_pending()?;
        }
        Ok(())
    }

    fn commit_refresh(
        &mut self,
        token: StagingToken,
        summary: RefreshSummary,
    ) -> Result<Generation, CatalogError> {
        self.require_staging(&token)?;
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
        self.flush_pending()?;
        let staging = self.staging.take().expect("validated staging state");

        let warm_noop =
            self.manifest.is_some() && staging.staged_count == 0 && summary.removed_packages == 0;
        if warm_noop {
            drop(staging.connection);
            let _ = fs::remove_file(&staging.snapshot_path);
            let _ = fs::remove_dir_all(&staging.temporary_directory);
            let Some(current) = self.manifest.as_ref() else {
                return Err(CatalogError::Corrupt {
                    message: "an empty first refresh cannot publish without a snapshot".to_owned(),
                });
            };
            let manifest = Manifest {
                manifest_schema_version: MANIFEST_SCHEMA_VERSION,
                snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
                project_id: self.project_id.to_string(),
                physical_snapshot: current.physical_snapshot.clone(),
                previous_snapshot: current.previous_snapshot.clone(),
                summary: ManifestSummary::from_refresh(&summary),
            };
            publish_manifest(&self.directory, &manifest)?;
            self.manifest = Some(manifest);
            return Ok(token.generation);
        }

        if let Some(previous_path) = self.committed_snapshot_path() {
            let started = Instant::now();
            copy_previous_snapshot(&previous_path, &staging.connection)?;
            self.writes.evidence_write_duration += started.elapsed();
        }
        append_observed(&staging.connection, &staging.observed)?;
        let publish_started = Instant::now();
        staging
            .connection
            .execute_batch(&format!(
                "CREATE TABLE entry AS SELECT * FROM (\
                 SELECT {ENTRY_COLUMNS} FROM previous \
                 WHERE relative_path IN (SELECT relative_path FROM observed) \
                 AND relative_path NOT IN (SELECT relative_path FROM staged) \
                 UNION ALL SELECT {ENTRY_COLUMNS} FROM staged\
                 ) ORDER BY relative_path; \
                 DROP TABLE staged; DROP TABLE previous; DROP TABLE observed; CHECKPOINT;"
            ))
            .map_err(storage_error("build the immutable DuckDB snapshot"))?;
        self.writes.evidence_write_duration += publish_started.elapsed();
        self.writes.committed_evidence_rows = staging
            .connection
            .query_row("SELECT count(*) FROM entry", [], |row| row.get(0))
            .map_err(storage_error("count committed DuckDB evidence rows"))?;
        self.writes.removed_evidence_rows = summary.removed_packages;
        drop(staging.connection);
        let _ = fs::remove_dir_all(&staging.temporary_directory);

        verify_snapshot(&staging.snapshot_path)?;
        let previous_snapshot = self
            .manifest
            .as_ref()
            .map(|manifest| manifest.physical_snapshot.clone())
            .filter(|previous| previous != &staging.physical_snapshot);
        let manifest = Manifest {
            manifest_schema_version: MANIFEST_SCHEMA_VERSION,
            snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
            project_id: self.project_id.to_string(),
            physical_snapshot: staging.physical_snapshot,
            previous_snapshot,
            summary: ManifestSummary::from_refresh(&summary),
        };
        publish_manifest(&self.directory, &manifest)?;
        cleanup_retired_snapshots(&self.directory, &manifest);
        self.manifest = Some(manifest);
        Ok(token.generation)
    }

    fn discard_refresh(&mut self, token: StagingToken) -> Result<(), CatalogError> {
        match self.staging.take() {
            Some(staging) if staging.generation == token.generation => {
                let path = staging.snapshot_path.clone();
                let temporary_directory = staging.temporary_directory.clone();
                drop(staging.connection);
                let _ = fs::remove_dir_all(temporary_directory);
                remove_if_exists(&path)
            }
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
        if let Some(staging) = self.staging.take() {
            drop(staging.connection);
        }
        let _ = quarantine_directory(&self.directory)?;
        fs::create_dir_all(&self.directory)
            .map_err(io_unavailable("recreate the project Catalog directory"))?;
        self.manifest = None;
        self.writes = CatalogWriteCounts::default();
        self.query_connection.take();
        Ok(())
    }

    fn query(&self, request: &QueryRequest) -> Result<QueryPage, CatalogError> {
        let manifest = require_manifest(&self.manifest, &self.project_id, &request.project_id)?;
        validate_page_limit(request.limit)?;
        let generation = Generation::new(manifest.summary.generation);
        if generation != request.expected_generation {
            return Err(CatalogError::StaleGeneration {
                expected: request.expected_generation,
                actual: generation,
            });
        }
        let after = parse_page_cursor(request.cursor.as_deref())?;
        let mut cached_connection = self.query_connection.borrow_mut();
        if cached_connection
            .as_ref()
            .is_none_or(|cached| cached.physical_snapshot != manifest.physical_snapshot)
        {
            let connection = open_connection(
                &self.directory.join(&manifest.physical_snapshot),
                AccessMode::ReadOnly,
            )?;
            *cached_connection = Some(QueryConnection {
                connection,
                physical_snapshot: manifest.physical_snapshot.clone(),
            });
            #[cfg(test)]
            self.query_connection_opens
                .set(self.query_connection_opens.get() + 1);
        }
        let connection = &cached_connection
            .as_ref()
            .expect("query connection was initialized")
            .connection;
        let (predicate, mut arguments) = query_predicate(&request.kind);
        let mut sql = match request.kind {
            QueryKind::Maps => format!(
                "SELECT relative_path, COALESCE(NULLIF(package_name, ''), relative_path) FROM entry \
                 WHERE relative_path > ? AND is_map AND ({predicate}) \
                 ORDER BY relative_path LIMIT ?"
            ),
            _ => format!(
                "SELECT relative_path, COALESCE(package_name, ''), classes, serialized_names \
                 FROM entry WHERE relative_path > ? AND kind = 0 AND ({predicate}) \
                 ORDER BY relative_path LIMIT ?"
            ),
        };
        arguments.insert(0, Value::Text(after));
        arguments.push(Value::UBigInt(request.limit.saturating_add(1) as u64));
        let mut statement = connection
            .prepare(&sql)
            .map_err(storage_error("prepare a bounded DuckDB query"))?;
        let rows = statement
            .query_map(params_from_iter(arguments.iter()), |row| {
                match request.kind {
                    QueryKind::Maps => Ok(QueryItem::Map {
                        map_path: row.get(0)?,
                        package_name: row.get(1)?,
                    }),
                    _ => Ok(QueryItem::Header {
                        package_path: row.get(0)?,
                        package_name: row.get(1)?,
                        classes: strings_from_value(row.get(2)?).map_err(to_duckdb_error)?,
                        serialized_names: strings_from_value(row.get(3)?)
                            .map_err(to_duckdb_error)?,
                    }),
                }
            })
            .map_err(storage_error("execute a bounded DuckDB query"))?;
        let mut items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error("read a bounded DuckDB query page"))?;
        let has_more = items.len() > request.limit;
        items.truncate(request.limit);
        let next_cursor = has_more
            .then(|| items.last().map(|item| item_path(item).to_owned()))
            .flatten();
        sql.clear();
        Ok(QueryPage {
            project_id: request.project_id.clone(),
            generation,
            items,
            next_cursor,
        })
    }
}

impl CatalogSnapshot for DuckdbCatalog {
    fn committed_entries(&self) -> Vec<CatalogSnapshotEntry> {
        let Some(connection) = self.committed_connection().ok().flatten() else {
            return Vec::new();
        };
        let mut statement = match connection.prepare(
            "SELECT relative_path, kind, size, modified_nanos, profile_version \
             FROM entry ORDER BY relative_path",
        ) {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
        let rows = match statement.query_map([], |row| {
            Ok(CatalogSnapshotEntry {
                signature: PackageSignature {
                    relative_path: row.get(0)?,
                    kind: decode_kind(row.get(1)?),
                    size: row.get(2)?,
                    modified_nanos: row.get(3)?,
                },
                header_profile_version: row.get(4)?,
            })
        }) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(Result::ok).collect()
    }
}

#[cfg(test)]
impl Drop for DuckdbCatalog {
    fn drop(&mut self) {
        if let Some(staging) = self.staging.take() {
            drop(staging.connection);
        }
        if let Some(root) = self.cleanup_root.take() {
            let _ = fs::remove_dir_all(root);
        }
    }
}

fn open_connection(path: &Path, access_mode: AccessMode) -> Result<Connection, CatalogError> {
    let config = Config::default()
        .access_mode(access_mode)
        .and_then(|config| config.threads(QUERY_THREADS))
        .and_then(|config| config.enable_autoload_extension(false))
        .and_then(|config| config.enable_external_access(false))
        .map_err(storage_error("configure DuckDB"))?;
    Connection::open_with_flags(path, config).map_err(storage_error("open DuckDB snapshot"))
}

/// DuckDB applies row-group sizing when a database is attached, not when it is opened directly.
/// This bootstrap connection never executes caller-provided SQL or paths; external access remains
/// disabled on every committed read connection.
fn open_writable_snapshot(
    path: &Path,
    temporary_directory: &Path,
) -> Result<Connection, CatalogError> {
    let config = Config::default()
        .threads(QUERY_THREADS)
        .and_then(|config| config.max_memory(WRITER_MEMORY_LIMIT))
        .and_then(|config| config.with("preserve_insertion_order", "false"))
        .and_then(|config| config.with("temp_directory", temporary_directory.to_string_lossy()))
        .and_then(|config| config.enable_autoload_extension(false))
        .and_then(|config| config.enable_external_access(true))
        .map_err(storage_error("configure the DuckDB snapshot writer"))?;
    let connection = Connection::open_in_memory_with_flags(config)
        .map_err(storage_error("open the DuckDB snapshot writer"))?;
    let escaped_path = path.to_string_lossy().replace('\'', "''");
    connection
        .execute_batch(&format!(
            "ATTACH '{escaped_path}' AS catalog (ROW_GROUP_SIZE {SNAPSHOT_ROW_GROUP_SIZE})"
        ))
        .map_err(storage_error("attach the writable DuckDB snapshot"))?;
    connection
        .execute_batch("USE catalog")
        .map_err(storage_error("select the writable DuckDB snapshot"))?;
    Ok(connection)
}

fn append_entries(
    connection: &Connection,
    table: &str,
    entries: &[StagedPackage],
) -> Result<(), CatalogError> {
    let batch = entry_record_batch(entries)?;
    let mut appender = connection
        .appender(table)
        .map_err(storage_error("open the DuckDB Arrow appender"))?;
    appender
        .append_record_batch(batch)
        .map_err(storage_error("append a DuckDB Arrow evidence batch"))?;
    appender
        .flush()
        .map_err(storage_error("flush a DuckDB Arrow evidence batch"))
}

fn entry_record_batch(entries: &[StagedPackage]) -> Result<RecordBatch, CatalogError> {
    let relative_paths = StringArray::from_iter_values(
        entries
            .iter()
            .map(|entry| entry.signature.relative_path.as_str()),
    );
    let kinds = UInt8Array::from_iter_values(
        entries
            .iter()
            .map(|entry| encode_kind(entry.signature.kind)),
    );
    let sizes = UInt64Array::from_iter_values(entries.iter().map(|entry| entry.signature.size));
    let modified =
        UInt64Array::from_iter_values(entries.iter().map(|entry| entry.signature.modified_nanos));
    let maps = BooleanArray::from_iter(entries.iter().map(|entry| Some(is_map(&entry.signature))));
    let profile_versions = UInt32Array::from(
        entries
            .iter()
            .map(|entry| entry.header.as_ref().map(|header| header.profile_version))
            .collect::<Vec<_>>(),
    );
    let package_names = StringArray::from(
        entries
            .iter()
            .map(|entry| {
                entry
                    .header
                    .as_ref()
                    .map(|header| header.package_name.as_str())
            })
            .collect::<Vec<_>>(),
    );
    let failure_codes = StringArray::from(
        entries
            .iter()
            .map(|entry| {
                entry
                    .header
                    .as_ref()
                    .and_then(|header| header.failure_code.as_deref())
            })
            .collect::<Vec<_>>(),
    );
    let classes = string_list_array(entries.iter().map(|entry| {
        entry
            .header
            .as_ref()
            .map(|header| header.classes.as_slice())
            .unwrap_or_default()
    }));
    let serialized_names = string_list_array(entries.iter().map(|entry| {
        entry
            .header
            .as_ref()
            .map(|header| header.serialized_names.as_slice())
            .unwrap_or_default()
    }));

    let class_name_lists = entries.iter().map(|entry| {
        entry
            .header
            .as_ref()
            .map(|header| {
                header
                    .classes
                    .iter()
                    .map(|class| class_name(class).to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let class_names = owned_string_list_array(class_name_lists);
    let list_type = DataType::List(Arc::new(Field::new("item", DataType::Utf8, true)));
    let schema = Arc::new(Schema::new(vec![
        Field::new("relative_path", DataType::Utf8, false),
        Field::new("kind", DataType::UInt8, false),
        Field::new("size", DataType::UInt64, false),
        Field::new("modified_nanos", DataType::UInt64, false),
        Field::new("is_map", DataType::Boolean, false),
        Field::new("profile_version", DataType::UInt32, true),
        Field::new("package_name", DataType::Utf8, true),
        Field::new("failure_code", DataType::Utf8, true),
        Field::new("classes", list_type.clone(), false),
        Field::new("class_names", list_type.clone(), false),
        Field::new("serialized_names", list_type, false),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(relative_paths) as ArrayRef,
            Arc::new(kinds),
            Arc::new(sizes),
            Arc::new(modified),
            Arc::new(maps),
            Arc::new(profile_versions),
            Arc::new(package_names),
            Arc::new(failure_codes),
            Arc::new(classes),
            Arc::new(class_names),
            Arc::new(serialized_names),
        ],
    )
    .map_err(|error| CatalogError::Unavailable {
        message: format!("could not build a bounded DuckDB Arrow batch: {error}"),
    })
}

fn string_list_array<'a>(
    lists: impl Iterator<Item = &'a [String]>,
) -> duckdb::arrow::array::ListArray {
    let mut builder = ListBuilder::new(StringBuilder::new());
    for values in lists {
        for value in values {
            builder.values().append_value(value);
        }
        builder.append(true);
    }
    builder.finish()
}

fn owned_string_list_array(
    lists: impl Iterator<Item = Vec<String>>,
) -> duckdb::arrow::array::ListArray {
    let mut builder = ListBuilder::new(StringBuilder::new());
    for values in lists {
        for value in values {
            builder.values().append_value(value);
        }
        builder.append(true);
    }
    builder.finish()
}

fn append_observed(
    connection: &Connection,
    observed: &BTreeSet<String>,
) -> Result<(), CatalogError> {
    for paths in observed.iter().collect::<Vec<_>>().chunks(STREAM_BATCH) {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "relative_path",
            DataType::Utf8,
            false,
        )]));
        let array = StringArray::from_iter_values(paths.iter().map(|path| path.as_str()));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(array)]).map_err(|error| {
            CatalogError::Unavailable {
                message: format!("could not build a bounded observed-path batch: {error}"),
            }
        })?;
        let mut appender = connection
            .appender("observed")
            .map_err(storage_error("open the observed-path Arrow appender"))?;
        appender
            .append_record_batch(batch)
            .map_err(storage_error("append observed paths"))?;
        appender
            .flush()
            .map_err(storage_error("flush observed paths"))?;
    }
    Ok(())
}

fn copy_previous_snapshot(previous: &Path, destination: &Connection) -> Result<(), CatalogError> {
    let source = open_connection(previous, AccessMode::ReadOnly)?;
    let mut statement = source
        .prepare(&format!(
            "SELECT {ENTRY_COLUMNS} FROM entry ORDER BY relative_path"
        ))
        .map_err(storage_error("prepare the prior snapshot copy"))?;
    let batches = statement
        .query_arrow([])
        .map_err(storage_error("read the prior immutable snapshot"))?;
    let mut appender = destination
        .appender("previous")
        .map_err(storage_error("open the prior-snapshot Arrow appender"))?;
    for batch in batches {
        appender
            .append_record_batch(batch)
            .map_err(storage_error("copy a prior-snapshot Arrow batch"))?;
    }
    appender
        .flush()
        .map_err(storage_error("flush the prior immutable snapshot"))
}

fn query_predicate(kind: &QueryKind) -> (String, Vec<Value>) {
    match kind {
        QueryKind::Maps => ("true".to_owned(), Vec::new()),
        QueryKind::ExactClasses { values } => list_overlap_predicate("classes", values),
        QueryKind::ClassPrefixes { values } => evidence_predicate(
            values,
            "list_bool_or(list_transform(classes, value -> starts_with(value, ?)))",
        ),
        QueryKind::ClassNameSuffixes { values } => evidence_predicate(
            values,
            "list_bool_or(list_transform(class_names, value -> ends_with(value, ?)))",
        ),
        QueryKind::SerializedNames { values } => list_overlap_predicate("serialized_names", values),
    }
}

fn list_overlap_predicate(column: &str, values: &[String]) -> (String, Vec<Value>) {
    if values.is_empty() {
        return ("false".to_owned(), Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", values.len())
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!("list_has_any({column}, [{placeholders}])"),
        values.iter().cloned().map(Value::Text).collect(),
    )
}

fn evidence_predicate(values: &[String], clause: &str) -> (String, Vec<Value>) {
    if values.is_empty() {
        return ("false".to_owned(), Vec::new());
    }
    (
        std::iter::repeat_n(clause, values.len())
            .collect::<Vec<_>>()
            .join(" OR "),
        values.iter().cloned().map(Value::Text).collect(),
    )
}

fn strings_from_value(value: Value) -> Result<Vec<String>, CatalogError> {
    match value {
        Value::List(values) => values
            .into_iter()
            .map(|value| match value {
                Value::Text(value) => Ok(value),
                _ => Err(CatalogError::Corrupt {
                    message: "DuckDB Catalog list evidence contains a non-string value".to_owned(),
                }),
            })
            .collect(),
        _ => Err(CatalogError::Corrupt {
            message: "DuckDB Catalog list evidence is not a list".to_owned(),
        }),
    }
}

fn publish_manifest(directory: &Path, manifest: &Manifest) -> Result<(), CatalogError> {
    let path = directory.join(MANIFEST_FILE);
    let mut file = AtomicWriteFile::open(&path)
        .map_err(io_unavailable("create the atomic Catalog manifest"))?;
    serde_json::to_writer(&mut file, manifest).map_err(|error| CatalogError::Unavailable {
        message: format!("could not encode the Catalog manifest: {error}"),
    })?;
    file.write_all(b"\n")
        .map_err(io_unavailable("finish the Catalog manifest"))?;
    file.commit()
        .map_err(io_unavailable("atomically publish the Catalog manifest"))
}

fn read_and_verify_manifest(
    directory: &Path,
    project_id: &ProjectId,
    check_integrity: bool,
) -> Result<Option<Manifest>, CatalogError> {
    let path = directory.join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(io_unavailable("read the Catalog manifest"))?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|error| CatalogError::Corrupt {
            message: format!("the DuckDB Catalog manifest is invalid: {error}"),
        })?;
    if manifest.manifest_schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.snapshot_schema_version != SNAPSHOT_SCHEMA_VERSION
        || manifest.project_id != project_id.as_str()
        || !valid_snapshot_name(&manifest.physical_snapshot)
        || manifest
            .previous_snapshot
            .as_deref()
            .is_some_and(|name| !valid_snapshot_name(name))
    {
        return Err(CatalogError::Corrupt {
            message: "the DuckDB Catalog manifest is incompatible or belongs to another project"
                .to_owned(),
        });
    }
    let snapshot = directory.join(&manifest.physical_snapshot);
    if !snapshot.is_file() {
        return Err(CatalogError::Corrupt {
            message: "the DuckDB Catalog manifest names a missing snapshot".to_owned(),
        });
    }
    if check_integrity {
        verify_snapshot(&snapshot)?;
    }
    Ok(Some(manifest))
}

fn verify_snapshot(path: &Path) -> Result<(), CatalogError> {
    let connection =
        open_connection(path, AccessMode::ReadOnly).map_err(|error| CatalogError::Corrupt {
            message: format!("the immutable DuckDB Catalog snapshot cannot be opened: {error}"),
        })?;
    connection
        .query_row("SELECT count(*) FROM entry", [], |row| row.get::<_, u64>(0))
        .map(|_| ())
        .map_err(|error| CatalogError::Corrupt {
            message: format!("the immutable DuckDB Catalog snapshot is invalid: {error}"),
        })
}

fn require_manifest<'a>(
    manifest: &'a Option<Manifest>,
    current_project: &ProjectId,
    requested_project: &ProjectId,
) -> Result<&'a Manifest, CatalogError> {
    if current_project != requested_project {
        return Err(CatalogError::InvalidRequest {
            message: "query project identity does not match the open Catalog".to_owned(),
        });
    }
    manifest
        .as_ref()
        .ok_or_else(|| CatalogError::InvalidRequest {
            message: "No committed Project Index generation matches that project identity."
                .to_owned(),
        })
}

fn cleanup_retired_snapshots(directory: &Path, manifest: &Manifest) {
    let retained = [
        Some(manifest.physical_snapshot.as_str()),
        manifest.previous_snapshot.as_deref(),
    ];
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten().take(128) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if valid_snapshot_name(&name)
            && !retained.iter().flatten().any(|retained| *retained == name)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn quarantine_directory(directory: &Path) -> Result<Option<PathBuf>, CatalogError> {
    if !directory.exists() {
        return Ok(None);
    }
    for slot in 0..MAX_QUARANTINE_SLOTS {
        let candidate = directory.with_extension(format!("quarantine-{slot}"));
        if candidate.exists() {
            continue;
        }
        return fs::rename(directory, &candidate)
            .map(|()| Some(candidate))
            .map_err(io_unavailable("quarantine the DuckDB Catalog"));
    }
    Err(CatalogError::Unavailable {
        message: "could not quarantine the DuckDB Catalog: all quarantine slots are occupied"
            .to_owned(),
    })
}

fn snapshot_file_name(generation: Generation) -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "snapshot-{}-{}-{nonce}.duckdb",
        generation.get(),
        std::process::id()
    )
}

fn valid_snapshot_name(name: &str) -> bool {
    name.starts_with("snapshot-")
        && name.ends_with(".duckdb")
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.'))
}

fn catalog_directory_name(project_id: &ProjectId) -> String {
    format!("{:016x}", stable_hash(project_id.as_str()))
}

fn stable_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

fn is_map(signature: &PackageSignature) -> bool {
    signature.kind == EntryKind::Package
        && signature
            .relative_path
            .to_ascii_lowercase()
            .ends_with(".umap")
}

fn encode_kind(kind: EntryKind) -> u8 {
    match kind {
        EntryKind::Package => 0,
        EntryKind::Sidecar => 1,
    }
}

fn decode_kind(kind: u8) -> EntryKind {
    if kind == 1 {
        EntryKind::Sidecar
    } else {
        EntryKind::Package
    }
}

fn remove_if_exists(path: &Path) -> Result<(), CatalogError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CatalogError::Unavailable {
            message: format!("could not remove an unpublished DuckDB snapshot: {error}"),
        }),
    }
}

fn io_unavailable(operation: &'static str) -> impl FnOnce(std::io::Error) -> CatalogError {
    move |error| CatalogError::Unavailable {
        message: format!("could not {operation}: {error}"),
    }
}

fn storage_error(operation: &'static str) -> impl FnOnce(duckdb::Error) -> CatalogError {
    move |error| CatalogError::Unavailable {
        message: format!("could not {operation}: {error}"),
    }
}

fn to_duckdb_error(error: CatalogError) -> duckdb::Error {
    duckdb::Error::FromSqlConversionFailure(
        0,
        duckdb::types::Type::List(Box::new(duckdb::types::Type::Text)),
        Box::new(error),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::direct_executor::catalog_conformance::{
        catalog_conformance_tests, fixture_project_id,
    };

    static NEXT_CACHE: AtomicU64 = AtomicU64::new(1);

    fn duckdb_catalog() -> DuckdbCatalog {
        let root = std::env::temp_dir().join(format!(
            "ue-shed-duckdb-catalog-{}-{}",
            std::process::id(),
            NEXT_CACHE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut catalog =
            DuckdbCatalog::open(&root, &fixture_project_id()).expect("open DuckDB Catalog");
        catalog.cleanup_root = Some(root);
        catalog
    }

    catalog_conformance_tests!(immutable_duckdb, duckdb_catalog);

    #[test]
    fn writable_snapshots_use_the_measured_row_group_size() {
        let root = std::env::temp_dir().join(format!(
            "ue-shed-duckdb-row-groups-{}-{}",
            std::process::id(),
            NEXT_CACHE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("create test directory");
        let path = root.join("row-groups.duckdb");
        let temporary_directory = root.join("writer.tmp");
        let connection =
            open_writable_snapshot(&path, &temporary_directory).expect("open snapshot writer");
        let maximum_memory: String = connection
            .query_row("SELECT current_setting('max_memory')", [], |row| row.get(0))
            .expect("inspect writer memory limit");
        let preserves_insertion_order: bool = connection
            .query_row(
                "SELECT current_setting('preserve_insertion_order')",
                [],
                |row| row.get(0),
            )
            .expect("inspect insertion-order policy");
        let configured_temporary_directory: String = connection
            .query_row("SELECT current_setting('temp_directory')", [], |row| {
                row.get(0)
            })
            .expect("inspect spill directory");
        let (maximum_memory_mib, unit) = maximum_memory
            .split_once(' ')
            .expect("memory limit contains a unit");
        assert_eq!(unit, "MiB");
        assert!(
            maximum_memory_mib
                .parse::<f64>()
                .expect("memory limit is numeric")
                <= 384.0
        );
        assert!(!preserves_insertion_order);
        assert_eq!(
            PathBuf::from(configured_temporary_directory),
            temporary_directory
        );
        connection
            .execute_batch(
                "CREATE TABLE probe AS SELECT range AS id FROM range(70000); CHECKPOINT;",
            )
            .expect("create multiple row groups");
        let largest_row_group: u64 = connection
            .query_row(
                "SELECT max(count) FROM pragma_storage_info('probe') WHERE column_name = 'id'",
                [],
                |row| row.get(0),
            )
            .expect("inspect row groups");
        assert!(largest_row_group <= SNAPSHOT_ROW_GROUP_SIZE);
        drop(connection);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn discarded_refresh_removes_snapshot_scoped_spill_files() {
        let mut catalog = duckdb_catalog();
        let token = catalog.begin_refresh().expect("begin refresh");
        let temporary_directory = catalog
            .staging
            .as_ref()
            .expect("staging state")
            .temporary_directory
            .clone();
        fs::create_dir_all(&temporary_directory).expect("create simulated spill directory");
        fs::write(temporary_directory.join("spill.tmp"), b"spill")
            .expect("create simulated spill file");

        catalog.discard_refresh(token).expect("discard refresh");

        assert!(!temporary_directory.exists());
    }

    #[test]
    fn bounded_queries_reuse_one_read_only_connection() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{FIXTURE_PROJECT_ROOT, refresh_fixture};
        use crate::direct_executor::project_index::refresh;

        let mut catalog = duckdb_catalog();
        let summary = refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("refresh")
        .into_iter()
        .find_map(|event| match event {
            crate::direct_executor::project_index::RefreshEvent::Completed { summary } => {
                Some(summary)
            }
            _ => None,
        })
        .expect("completed summary");
        let request = QueryRequest {
            project_id: fixture_project_id(),
            expected_generation: summary.generation,
            kind: QueryKind::Maps,
            limit: 16,
            cursor: None,
        };

        catalog.query(&request).expect("first page");
        catalog.query(&request).expect("second page");

        assert_eq!(catalog.query_connection_opens.get(), 1);
    }

    #[test]
    fn warm_noop_reuses_the_physical_snapshot() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{FIXTURE_PROJECT_ROOT, refresh_fixture};
        use crate::direct_executor::project_index::refresh;

        let mut catalog = duckdb_catalog();
        let scanner = refresh_fixture();
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("cold refresh");
        let first = catalog
            .manifest
            .as_ref()
            .expect("manifest")
            .physical_snapshot
            .clone();
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("warm refresh");
        assert_eq!(
            catalog
                .manifest
                .as_ref()
                .expect("manifest")
                .physical_snapshot,
            first
        );
    }

    #[test]
    fn an_empty_first_refresh_publishes_a_queryable_snapshot() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{
            FIXTURE_PROJECT_ROOT, FakeScanner, completed_summary,
        };
        use crate::direct_executor::project_index::refresh;

        let mut catalog = duckdb_catalog();
        let events = refresh(
            &mut catalog,
            &FakeScanner::default(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("empty refresh");
        let summary = completed_summary(&events);
        assert_eq!(summary.package_count, 0);
        assert!(
            catalog
                .committed_snapshot_path()
                .is_some_and(|path| path.is_file())
        );
        let page = catalog
            .query(&QueryRequest {
                project_id: summary.project_id,
                expected_generation: summary.generation,
                kind: QueryKind::Maps,
                limit: 10,
                cursor: None,
            })
            .expect("query empty snapshot");
        assert!(page.items.is_empty());
    }

    #[test]
    fn a_reopened_catalog_serves_the_committed_generation() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{
            FIXTURE_PROJECT_ROOT, completed_summary, refresh_fixture,
        };
        use crate::direct_executor::project_index::refresh;

        let mut catalog = duckdb_catalog();
        let root = catalog.cleanup_root.take().expect("test cache root");
        let summary = completed_summary(
            &refresh(
                &mut catalog,
                &refresh_fixture(),
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .expect("refresh"),
        );
        drop(catalog);

        let mut reopened = DuckdbCatalog::open(&root, &fixture_project_id()).expect("reopen");
        reopened.cleanup_root = Some(root);
        assert_eq!(reopened.committed_generation(), Some(summary.generation));
        assert_eq!(reopened.committed_entries().len(), 3);
    }

    #[test]
    fn a_reader_keeps_the_previous_snapshot_while_the_next_generation_publishes() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{
            FIXTURE_PROJECT_ROOT, FakeScanner, header, package, refresh_fixture,
        };
        use crate::direct_executor::project_index::refresh;

        let mut catalog = duckdb_catalog();
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("first refresh");
        let first_path = catalog.committed_snapshot_path().expect("first snapshot");
        let reader = open_connection(&first_path, AccessMode::ReadOnly).expect("old reader");
        let next = FakeScanner {
            entries: vec![package("Content/Data/DT_Replacement.uasset", 30, 300)],
            headers: std::collections::BTreeMap::from([(
                "Content/Data/DT_Replacement.uasset".to_owned(),
                header(
                    "/Game/Data/DT_Replacement",
                    &["/Script/Engine.DataTable"],
                    &[],
                ),
            )]),
            ..FakeScanner::default()
        };
        refresh(
            &mut catalog,
            &next,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("replacement refresh");

        let old_count = reader
            .query_row("SELECT count(*) FROM entry", [], |row| row.get::<_, u64>(0))
            .expect("old reader remains valid");
        assert_eq!(old_count, 3);
        assert_eq!(catalog.committed_entries().len(), 1);
        assert!(
            first_path.is_file(),
            "the previous physical snapshot is retained"
        );
    }

    #[test]
    fn a_corrupt_manifest_is_quarantined_without_touching_project_data() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{FIXTURE_PROJECT_ROOT, refresh_fixture};
        use crate::direct_executor::project_index::refresh;

        let mut catalog = duckdb_catalog();
        let root = catalog.cleanup_root.take().expect("test cache root");
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("refresh");
        let manifest_path = catalog.directory.join(MANIFEST_FILE);
        drop(catalog);
        fs::write(&manifest_path, b"not-json").expect("damage disposable manifest");

        let mut recovered = DuckdbCatalog::open(&root, &fixture_project_id()).expect("recover");
        assert!(matches!(recovered.status(), CatalogStatus::Absent));
        assert!(recovered.quarantined_from().is_some());
        recovered.cleanup_root = Some(root);
    }
}
