//! Experimental immutable SQLite Catalog, compiled only by prepare_sqlite_catalog.py.
//! Uses the production coordinator, scanner, protocol and manifest helpers in an isolated copy.
//! Not a shipped adapter or a replacement for the accepted storage decision.
use super::catalog::*;
use super::project_index::CatalogSnapshot;
use atomic_write_file::AtomicWriteFile;
use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CATALOG_DIRECTORY: &str = "catalogs-sqlite-research-v1";
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const MAX_QUARANTINE_SLOTS: u32 = 64;
const INDEX_SERIALIZED_NAMES: bool = true;
const ENTRY_COLUMNS: &str = "relative_path,kind,size,modified_nanos,is_map,profile_version,package_name,failure_code,classes,serialized_names,reversed_classes";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CatalogWriteCounts {
    pub(crate) staged_evidence_rows: u64,
    pub(crate) committed_evidence_rows: u64,
    pub(crate) removed_evidence_rows: u64,
    pub(crate) evidence_write_duration: Duration,
}

// @MANIFEST_TYPES@

struct Staging {
    connection: Option<Connection>,
    generation: Generation,
    observed: BTreeSet<String>,
    snapshot_path: PathBuf,
    physical_snapshot: String,
    staged_count: u64,
}

/// Name retained solely to connect the isolated experiment to unchanged production callers.
pub(crate) struct DuckdbCatalog {
    directory: PathBuf,
    project_id: ProjectId,
    manifest: Option<Manifest>,
    staging: Option<Staging>,
    quarantined_from: Option<PathBuf>,
    writes: CatalogWriteCounts,
    query_connection: RefCell<Option<(String, Connection)>>,
    #[cfg(test)]
    cleanup_root: Option<PathBuf>,
}

impl std::fmt::Debug for DuckdbCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteResearchCatalog")
            .field("project_id", &self.project_id)
            .finish()
    }
}

impl DuckdbCatalog {
    pub(crate) fn open(root: &Path, project: &ProjectId) -> Result<Self, CatalogError> {
        Self::open_checked(root, project, true)
    }
    pub(crate) fn open_for_query(root: &Path, project: &ProjectId) -> Result<Self, CatalogError> {
        Self::open_checked(root, project, false)
    }
    fn open_checked(
        root: &Path,
        project: &ProjectId,
        integrity: bool,
    ) -> Result<Self, CatalogError> {
        let directory = root
            .join(CATALOG_DIRECTORY)
            .join(catalog_directory_name(project));
        fs::create_dir_all(&directory).map_err(io_unavailable("create SQLite Catalog"))?;
        let (manifest, quarantined_from) =
            match read_and_verify_manifest(&directory, project, integrity) {
                Ok(manifest) => (manifest, None),
                Err(CatalogError::Corrupt { .. }) => {
                    let old = quarantine_directory(&directory)?;
                    fs::create_dir_all(&directory)
                        .map_err(io_unavailable("recreate SQLite Catalog"))?;
                    (None, old)
                }
                Err(error) => return Err(error),
            };
        Ok(Self {
            directory,
            project_id: project.clone(),
            manifest,
            staging: None,
            quarantined_from,
            writes: CatalogWriteCounts::default(),
            query_connection: RefCell::new(None),
            #[cfg(test)]
            cleanup_root: None,
        })
    }
    pub(crate) fn quarantined_from(&self) -> Option<&Path> {
        self.quarantined_from.as_deref()
    }
    pub(crate) fn write_counts(&self) -> CatalogWriteCounts {
        self.writes
    }
    pub(crate) fn storage_bytes(&self) -> u64 {
        fs::read_dir(&self.directory)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    }
    fn require_staging(&self, token: &StagingToken) -> Result<(), CatalogError> {
        if self
            .staging
            .as_ref()
            .is_some_and(|s| s.generation == token.generation)
        {
            Ok(())
        } else {
            Err(CatalogError::InvalidRequest {
                message: "invalid staging token".into(),
            })
        }
    }
    fn committed_connection(&self) -> Result<Option<Connection>, CatalogError> {
        self.manifest
            .as_ref()
            .map(|m| {
                open_connection(
                    &self.directory.join(&m.physical_snapshot),
                    OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
            })
            .transpose()
    }
}

impl Catalog for DuckdbCatalog {
    fn status(&self) -> CatalogStatus {
        self.manifest
            .as_ref()
            .map_or(CatalogStatus::Absent, |m| CatalogStatus::Ready {
                summary: m.summary.to_refresh(&self.project_id),
            })
    }
    fn committed_generation(&self) -> Option<Generation> {
        self.manifest
            .as_ref()
            .map(|m| Generation::new(m.summary.generation))
    }
    fn lookup_committed(&self, path: &str) -> Option<(PackageSignature, Option<HeaderEvidence>)> {
        let connection = self.committed_connection().ok().flatten()?;
        connection.query_row("SELECT kind,size,modified_nanos,profile_version,package_name,failure_code,json(classes),json(serialized_names) FROM entry WHERE relative_path=?", [path], |r| {
            let version: Option<u32> = r.get(3)?;
            let header = match version {
                None => None,
                Some(profile_version) => Some(HeaderEvidence { profile_version, package_name:r.get(4)?, failure_code:r.get(5)?, classes:decode_json(r.get(6)?)?, serialized_names:decode_json(r.get(7)?)? })
            };
            Ok((PackageSignature { relative_path:path.into(),kind:decode_kind(r.get(0)?),size:r.get(1)?,modified_nanos:r.get(2)? },header))
        }).optional().ok().flatten()
    }
    fn begin_refresh(&mut self) -> Result<StagingToken, CatalogError> {
        if self.staging.is_some() {
            return Err(CatalogError::Unavailable {
                message: "refresh already active".into(),
            });
        }
        let generation = self
            .committed_generation()
            .map_or(Generation::new(1), Generation::next);
        let physical_snapshot = snapshot_file_name(generation);
        self.staging = Some(Staging {
            connection: None,
            generation,
            observed: BTreeSet::new(),
            snapshot_path: self.directory.join(&physical_snapshot),
            physical_snapshot,
            staged_count: 0,
        });
        self.writes = CatalogWriteCounts::default();
        Ok(StagingToken { generation })
    }
    fn observe_unchanged(&mut self, token: &StagingToken, path: &str) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        self.staging.as_mut().unwrap().observed.insert(path.into());
        Ok(())
    }
    fn stage_observed(
        &mut self,
        token: &StagingToken,
        entry: StagedPackage,
    ) -> Result<(), CatalogError> {
        self.require_staging(token)?;
        let started = Instant::now();
        let staging = self.staging.as_mut().unwrap();
        let connection = writer(staging)?;
        let empty = Vec::new();
        let classes = entry.header.as_ref().map_or(&empty, |h| &h.classes);
        let names = entry
            .header
            .as_ref()
            .map_or(&empty, |h| &h.serialized_names);
        let reversed = classes
            .iter()
            .map(|v| class_name(v).chars().rev().collect::<String>())
            .collect::<Vec<_>>();
        connection
            .prepare_cached(
                "INSERT OR REPLACE INTO entry VALUES (?,?,?,?,?,?,?,?,jsonb(?),jsonb(?),jsonb(?))",
            )
            .map_err(storage_error("prepare staged entry"))?
            .execute(params![
                entry.signature.relative_path,
                encode_kind(entry.signature.kind),
                entry.signature.size,
                entry.signature.modified_nanos,
                is_map(&entry.signature),
                entry.header.as_ref().map(|h| h.profile_version),
                entry.header.as_ref().map(|h| h.package_name.as_str()),
                entry
                    .header
                    .as_ref()
                    .and_then(|h| h.failure_code.as_deref()),
                serde_json::to_string(classes).unwrap(),
                serde_json::to_string(names).unwrap(),
                serde_json::to_string(&reversed).unwrap()
            ])
            .map_err(storage_error("stage entry"))?;
        staging.observed.insert(entry.signature.relative_path);
        staging.staged_count += 1;
        self.writes.staged_evidence_rows += 1;
        self.writes.evidence_write_duration += started.elapsed();
        Ok(())
    }
    fn commit_refresh(
        &mut self,
        token: StagingToken,
        summary: RefreshSummary,
    ) -> Result<Generation, CatalogError> {
        self.require_staging(&token)?;
        if summary.generation != token.generation || summary.project_id != self.project_id {
            return Err(CatalogError::InvalidRequest {
                message: "summary does not match staging".into(),
            });
        }
        let mut staging = self.staging.take().unwrap();
        let physical_snapshot;
        let previous_snapshot;
        if let Some(current) = self.manifest.as_ref()
            && staging.staged_count == 0
            && summary.removed_packages == 0
        {
            physical_snapshot = current.physical_snapshot.clone();
            previous_snapshot = current.previous_snapshot.clone();
        } else {
            let started = Instant::now();
            writer(&mut staging)?;
            let connection = staging.connection.as_ref().unwrap();
            if let Some(old) = &self.manifest {
                connection
                    .execute(
                        "ATTACH DATABASE ? AS prior",
                        [self
                            .directory
                            .join(&old.physical_snapshot)
                            .to_string_lossy()
                            .as_ref()],
                    )
                    .map_err(storage_error("attach prior snapshot"))?;
                connection
                    .execute_batch(
                        "CREATE TEMP TABLE observed(relative_path TEXT PRIMARY KEY) WITHOUT ROWID",
                    )
                    .map_err(storage_error("create observed paths"))?;
                {
                    let mut insert = connection
                        .prepare("INSERT INTO observed VALUES (?)")
                        .map_err(storage_error("prepare observed paths"))?;
                    for path in &staging.observed {
                        insert
                            .execute([path])
                            .map_err(storage_error("observe path"))?;
                    }
                }
                connection.execute_batch(&format!("INSERT OR IGNORE INTO entry SELECT {} FROM prior.entry e JOIN observed USING(relative_path)", ENTRY_COLUMNS.split(',').map(|c|format!("e.{c}")).collect::<Vec<_>>().join(","))).map_err(storage_error("copy retained evidence"))?;
            }
            // Reassign IDs in path order for every physical snapshot, including insertions.
            // The full copy/rebase/index cost is deliberately inside the measured commit.
            let name_postings = if INDEX_SERIALIZED_NAMES {
                "INSERT OR IGNORE INTO posting SELECT 1,j.value,e.id FROM entry e,json_each(e.serialized_names) j WHERE e.kind=0 ORDER BY j.value,e.id;"
            } else {
                ""
            };
            connection.execute_batch(&format!("ALTER TABLE entry RENAME TO staged;
                CREATE TABLE entry(id INTEGER PRIMARY KEY,relative_path TEXT NOT NULL UNIQUE,kind INTEGER NOT NULL,size INTEGER NOT NULL,modified_nanos INTEGER NOT NULL,is_map INTEGER NOT NULL,profile_version INTEGER,package_name TEXT,failure_code TEXT,classes BLOB NOT NULL,serialized_names BLOB NOT NULL,reversed_classes BLOB NOT NULL);
                INSERT INTO entry({ENTRY_COLUMNS}) SELECT {ENTRY_COLUMNS} FROM staged ORDER BY relative_path;
                DROP TABLE staged;
                CREATE INDEX maps ON entry(relative_path) WHERE is_map=1;
                CREATE TABLE posting(kind INTEGER NOT NULL,value TEXT NOT NULL,id INTEGER NOT NULL,PRIMARY KEY(kind,value,id)) WITHOUT ROWID;
                INSERT OR IGNORE INTO posting SELECT 0,j.value,e.id FROM entry e,json_each(e.classes) j WHERE e.kind=0 ORDER BY j.value,e.id;
                {name_postings}
                INSERT OR IGNORE INTO posting SELECT 2,j.value,e.id FROM entry e,json_each(e.reversed_classes) j WHERE e.kind=0 ORDER BY j.value,e.id;
                ANALYZE; COMMIT;")).map_err(storage_error("build immutable postings"))?;
            self.writes.committed_evidence_rows = connection
                .query_row("SELECT count(*) FROM entry", [], |r| r.get(0))
                .map_err(storage_error("count committed entries"))?;
            self.writes.removed_evidence_rows = summary.removed_packages;
            self.writes.evidence_write_duration += started.elapsed();
            drop(staging.connection.take());
            verify_snapshot(&staging.snapshot_path)?;
            physical_snapshot = staging.physical_snapshot;
            previous_snapshot = self.manifest.as_ref().map(|m| m.physical_snapshot.clone());
        }
        let manifest = Manifest {
            manifest_schema_version: MANIFEST_SCHEMA_VERSION,
            snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
            project_id: self.project_id.to_string(),
            physical_snapshot,
            previous_snapshot,
            summary: ManifestSummary::from_refresh(&summary),
        };
        publish_manifest(&self.directory, &manifest)?;
        self.query_connection.take();
        cleanup_retired_snapshots(&self.directory, &manifest);
        self.manifest = Some(manifest);
        Ok(token.generation)
    }
    fn discard_refresh(&mut self, token: StagingToken) -> Result<(), CatalogError> {
        if self.staging.is_none() {
            return Ok(());
        }
        self.require_staging(&token)?;
        let staging = self.staging.take().unwrap();
        drop(staging.connection);
        remove_if_exists(&staging.snapshot_path)
    }
    fn clear_for_rebuild(&mut self) -> Result<(), CatalogError> {
        self.staging.take();
        self.query_connection.take();
        quarantine_directory(&self.directory)?;
        fs::create_dir_all(&self.directory).map_err(io_unavailable("recreate Catalog"))?;
        self.manifest = None;
        self.writes = CatalogWriteCounts::default();
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
        let cursor = parse_page_cursor(request.cursor.as_deref())?;
        let mut cached = self.query_connection.borrow_mut();
        if cached
            .as_ref()
            .is_none_or(|(name, _)| name != &manifest.physical_snapshot)
        {
            *cached = Some((
                manifest.physical_snapshot.clone(),
                open_connection(
                    &self.directory.join(&manifest.physical_snapshot),
                    OpenFlags::SQLITE_OPEN_READ_ONLY,
                )?,
            ));
        }
        let connection = &cached.as_ref().unwrap().1;
        let (sql, args) = query_sql(&request.kind, cursor, request.limit + 1);
        let mut statement = connection
            .prepare(&sql)
            .map_err(storage_error("prepare bounded query"))?;
        let rows = statement
            .query_map(params_from_iter(args), |row| {
                if matches!(request.kind, QueryKind::Maps) {
                    Ok(QueryItem::Map {
                        map_path: row.get(0)?,
                        package_name: row.get(1)?,
                    })
                } else {
                    Ok(QueryItem::Header {
                        package_path: row.get(0)?,
                        package_name: row.get(1)?,
                        classes: decode_json(row.get(2)?)?,
                        serialized_names: decode_json(row.get(3)?)?,
                    })
                }
            })
            .map_err(storage_error("query page"))?;
        let mut items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error("decode page"))?;
        let more = items.len() > request.limit;
        items.truncate(request.limit);
        let next_cursor = more
            .then(|| items.last().map(|i| item_path(i).to_owned()))
            .flatten();
        Ok(QueryPage {
            project_id: request.project_id.clone(),
            generation,
            items,
            next_cursor,
        })
    }
}

impl CatalogSnapshot for DuckdbCatalog {
    fn committed_entries(&self) -> Result<Vec<CatalogSnapshotEntry>, CatalogError> {
        let Some(connection) = self.committed_connection()? else {
            return Ok(Vec::new());
        };
        let mut statement=connection.prepare("SELECT relative_path,kind,size,modified_nanos,profile_version,failure_code IS NOT NULL FROM entry ORDER BY relative_path").map_err(storage_error("prepare compact inventory"))?;
        statement
            .query_map([], |r| {
                Ok(CatalogSnapshotEntry {
                    signature: PackageSignature {
                        relative_path: r.get(0)?,
                        kind: decode_kind(r.get(1)?),
                        size: r.get(2)?,
                        modified_nanos: r.get(3)?,
                    },
                    header_profile_version: r.get(4)?,
                    header_failure: r.get(5)?,
                })
            })
            .map_err(storage_error("read compact inventory"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error("decode compact inventory"))
    }
}

fn writer(staging: &mut Staging) -> Result<&Connection, CatalogError> {
    if staging.connection.is_none() {
        let connection = open_connection(
            &staging.snapshot_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN;
            CREATE TABLE entry(relative_path TEXT PRIMARY KEY,kind INTEGER NOT NULL,size INTEGER NOT NULL,modified_nanos INTEGER NOT NULL,is_map INTEGER NOT NULL,profile_version INTEGER,package_name TEXT,failure_code TEXT,classes BLOB NOT NULL,serialized_names BLOB NOT NULL,reversed_classes BLOB NOT NULL) WITHOUT ROWID;").map_err(storage_error("create unpublished snapshot"))?;
        staging.connection = Some(connection);
    }
    Ok(staging.connection.as_ref().unwrap())
}
fn open_connection(path: &Path, flags: OpenFlags) -> Result<Connection, CatalogError> {
    let connection =
        Connection::open_with_flags(path, flags).map_err(storage_error("open SQLite snapshot"))?;
    connection
        .execute_batch("PRAGMA cache_size=-65536; PRAGMA temp_store=FILE")
        .map_err(storage_error("configure SQLite"))?;
    Ok(connection)
}
fn decode_json(value: String) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str(&value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn query_sql(kind: &QueryKind, cursor: String, limit: usize) -> (String, Vec<Value>) {
    let mut args = vec![Value::Text(cursor)];
    if !INDEX_SERIALIZED_NAMES && let QueryKind::SerializedNames { values } = kind {
        let predicate = if values.is_empty() {
            "0".to_owned()
        } else {
            format!("value IN ({})", vec!["?"; values.len()].join(","))
        };
        args.extend(values.iter().cloned().map(Value::Text));
        args.push(Value::Integer(limit as i64));
        return (
            format!(
                "SELECT relative_path,COALESCE(package_name,''),json(classes),json(serialized_names) FROM entry WHERE relative_path>? AND kind=0 AND EXISTS (SELECT 1 FROM json_each(entry.serialized_names) WHERE {predicate}) ORDER BY relative_path LIMIT ?"
            ),
            args,
        );
    }
    if matches!(kind, QueryKind::Maps) {
        args.push(Value::Integer(limit as i64));
        return ("SELECT relative_path,COALESCE(NULLIF(package_name,''),relative_path) FROM entry WHERE relative_path>? AND is_map=1 ORDER BY relative_path LIMIT ?".into(),args);
    }
    let (index_kind, values, ranges, reverse) = match kind {
        QueryKind::ExactClasses { values } => (0, values, false, false),
        QueryKind::SerializedNames { values } => (1, values, false, false),
        QueryKind::ClassPrefixes { values } => (0, values, true, false),
        QueryKind::ClassNameSuffixes { values } => (2, values, true, true),
        QueryKind::Maps => unreachable!(),
    };
    let mut clauses = Vec::new();
    for value in values {
        let value = if reverse {
            value.chars().rev().collect()
        } else {
            value.clone()
        };
        if !ranges {
            clauses.push("value=?".to_owned());
            args.push(Value::Text(value));
        } else {
            let mut chars = value.chars().collect::<Vec<_>>();
            let mut upper = None;
            while let Some(last) = chars.pop() {
                let next = if last as u32 == 0xd7ff {
                    0xe000
                } else {
                    last as u32 + 1
                };
                if let Some(next) = char::from_u32(next) {
                    chars.push(next);
                    upper = Some(chars.iter().collect::<String>());
                    break;
                }
            }
            args.push(Value::Text(value));
            if let Some(upper) = upper {
                clauses.push("(value>=? AND value<?)".into());
                args.push(Value::Text(upper));
            } else {
                clauses.push("value>=?".into());
            }
        }
    }
    args.push(Value::Integer(limit as i64));
    let predicate = if clauses.is_empty() {
        "0".into()
    } else {
        clauses.join(" OR ")
    };
    (
        format!(
            "WITH candidates AS MATERIALIZED (SELECT DISTINCT id FROM posting WHERE id >= (SELECT id FROM entry WHERE relative_path>? ORDER BY relative_path LIMIT 1) AND kind={index_kind} AND ({predicate}) ORDER BY id LIMIT ?) SELECT e.relative_path,COALESCE(e.package_name,''),json(e.classes),json(e.serialized_names) FROM candidates c JOIN entry e USING(id) ORDER BY e.id"
        ),
        args,
    )
}

// @MANIFEST_HELPERS@

#[cfg(test)]
impl Drop for DuckdbCatalog {
    fn drop(&mut self) {
        self.staging.take();
        self.query_connection.take();
        if let Some(root) = self.cleanup_root.take() {
            let _ = fs::remove_dir_all(root);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::direct_executor::catalog_conformance::{
        catalog_conformance_tests, fixture_project_id,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    fn sqlite_catalog() -> DuckdbCatalog {
        let root = std::env::temp_dir().join(format!(
            "ue-shed-sqlite-research-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut catalog = DuckdbCatalog::open(&root, &fixture_project_id()).unwrap();
        catalog.cleanup_root = Some(root);
        catalog
    }
    catalog_conformance_tests!(sqlite_research, sqlite_catalog);
}
