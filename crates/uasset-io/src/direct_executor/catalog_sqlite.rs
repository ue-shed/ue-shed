//! Immutable SQLite Catalog. Atomic manifests publish read-only physical snapshots.
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

const CATALOG_DIRECTORY: &str = "catalogs-v3";
const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const MAX_QUARANTINE_SLOTS: u32 = 64;
const ENTRY_COLUMNS: &str = "relative_path,kind,size,modified_nanos,is_map,profile_version,package_name,failure_code,classes,serialized_names,reversed_classes";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CatalogWriteCounts {
    pub(crate) staged_evidence_rows: u64,
    pub(crate) committed_evidence_rows: u64,
    pub(crate) removed_evidence_rows: u64,
    pub(crate) evidence_write_duration: Duration,
}

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
    connection: Option<Connection>,
    generation: Generation,
    observed: BTreeSet<String>,
    snapshot_path: PathBuf,
    physical_snapshot: String,
    staged_count: u64,
    prior_snapshot: Option<PathBuf>,
    cleanup: SnapshotCleanup,
}

/// A failed or discarded publication must not retain unpublished data or rollback journals.
/// Staging drops its connection before this guard, including on commit errors.
struct SnapshotCleanup {
    path: PathBuf,
    published: bool,
}

impl Drop for SnapshotCleanup {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
            let mut journal = self.path.as_os_str().to_owned();
            journal.push("-journal");
            let _ = fs::remove_file(PathBuf::from(journal));
        }
    }
}

/// Disposable Catalog for one canonical project identity.
pub(crate) struct SqliteCatalog {
    directory: PathBuf,
    project_id: ProjectId,
    manifest: Option<Manifest>,
    staging: Option<Staging>,
    quarantined_from: Option<PathBuf>,
    writes: CatalogWriteCounts,
    query_connection: RefCell<Option<(String, Connection)>>,
    #[cfg(test)]
    cleanup_root: Option<PathBuf>,
    #[cfg(test)]
    query_connection_opens: std::cell::Cell<u64>,
}

impl std::fmt::Debug for SqliteCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteCatalog")
            .field("project_id", &self.project_id)
            .finish()
    }
}

impl SqliteCatalog {
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
            #[cfg(test)]
            query_connection_opens: std::cell::Cell::new(0),
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
    fn committed_snapshot_path(&self) -> Option<PathBuf> {
        self.manifest
            .as_ref()
            .map(|m| self.directory.join(&m.physical_snapshot))
    }
    fn committed_connection(&self) -> Result<Option<Connection>, CatalogError> {
        self.committed_snapshot_path()
            .map(|path| open_connection(&path, OpenFlags::SQLITE_OPEN_READ_ONLY))
            .transpose()
    }
}

impl Catalog for SqliteCatalog {
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
            Ok((PackageSignature { relative_path:path.into(),kind:decode_kind(r.get(0)?),size:decode_unsigned(r.get(1)?)?,modified_nanos:decode_unsigned(r.get(2)?)? },header))
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
            cleanup: SnapshotCleanup {
                path: self.directory.join(&physical_snapshot),
                published: false,
            },
            connection: None,
            generation,
            observed: BTreeSet::new(),
            snapshot_path: self.directory.join(&physical_snapshot),
            physical_snapshot,
            staged_count: 0,
            prior_snapshot: self.committed_snapshot_path(),
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
                &format!("INSERT INTO entry({ENTRY_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,jsonb(?),jsonb(?),jsonb(?)) ON CONFLICT(relative_path) DO UPDATE SET kind=excluded.kind,size=excluded.size,modified_nanos=excluded.modified_nanos,is_map=excluded.is_map,profile_version=excluded.profile_version,package_name=excluded.package_name,failure_code=excluded.failure_code,classes=excluded.classes,serialized_names=excluded.serialized_names,reversed_classes=excluded.reversed_classes"),
            )
            .map_err(storage_error("prepare staged entry"))?
            .execute(params![
                entry.signature.relative_path,
                encode_kind(entry.signature.kind),
                entry.signature.size.to_be_bytes().as_slice(),
                entry.signature.modified_nanos.to_be_bytes().as_slice(),
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
        if staging.prior_snapshot.is_some() {
            let connection = staging.connection.as_ref().unwrap();
            connection
                .prepare_cached(
                    "DELETE FROM posting WHERE id=(SELECT id FROM entry WHERE relative_path=?)",
                )
                .map_err(storage_error("prepare changed postings"))?
                .execute([&entry.signature.relative_path])
                .map_err(storage_error("remove changed postings"))?;
            connection.prepare_cached("INSERT OR IGNORE INTO posting SELECT 0,j.value,e.id FROM entry e,json_each(e.classes) j WHERE e.relative_path=? AND e.kind=0 UNION ALL SELECT 2,j.value,e.id FROM entry e,json_each(e.reversed_classes) j WHERE e.relative_path=? AND e.kind=0")
                .map_err(storage_error("prepare replacement postings"))?
                .execute([&entry.signature.relative_path, &entry.signature.relative_path]).map_err(storage_error("replace changed postings"))?;
        }
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
            if staging.prior_snapshot.is_some() && summary.removed_packages > 0 {
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
                connection.execute_batch("DELETE FROM posting WHERE id IN (SELECT id FROM entry WHERE relative_path NOT IN (SELECT relative_path FROM observed)); DELETE FROM entry WHERE relative_path NOT IN (SELECT relative_path FROM observed);")
                    .map_err(storage_error("remove missing evidence"))?;
            }
            if staging.prior_snapshot.is_none() {
                connection.execute_batch("CREATE INDEX maps ON entry(relative_path) WHERE is_map=1;
                    CREATE INDEX inventory ON entry(relative_path,kind,size,modified_nanos,profile_version,failure_code);
                    CREATE TABLE posting(kind INTEGER NOT NULL,value TEXT NOT NULL,id INTEGER NOT NULL,PRIMARY KEY(kind,value,id)) WITHOUT ROWID;
                    INSERT OR IGNORE INTO posting SELECT 0,j.value,e.id FROM entry e,json_each(e.classes) j WHERE e.kind=0 ORDER BY j.value,e.id;
                    INSERT OR IGNORE INTO posting SELECT 2,j.value,e.id FROM entry e,json_each(e.reversed_classes) j WHERE e.kind=0 ORDER BY j.value,e.id;
                    CREATE INDEX posting_entry ON posting(id);
                    ANALYZE;") .map_err(storage_error("build class postings"))?;
            }
            connection
                .execute_batch("COMMIT")
                .map_err(storage_error("commit unpublished snapshot"))?;
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
        staging.cleanup.published = true;
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
            #[cfg(test)]
            self.query_connection_opens
                .set(self.query_connection_opens.get() + 1);
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

impl CatalogSnapshot for SqliteCatalog {
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
                        size: decode_unsigned(r.get(2)?)?,
                        modified_nanos: decode_unsigned(r.get(3)?)?,
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
        // Published databases never change and use rollback journaling, so their main file is
        // a complete snapshot even while readers hold it open. Mutate only the private copy.
        if let Some(prior) = &staging.prior_snapshot {
            fs::copy(prior, &staging.snapshot_path)
                .map_err(io_unavailable("copy committed snapshot"))?;
        }
        let connection = open_connection(
            &staging.snapshot_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        connection
            .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN")
            .map_err(storage_error("begin unpublished snapshot"))?;
        if staging.prior_snapshot.is_none() {
            connection.execute_batch("CREATE TABLE entry(id INTEGER PRIMARY KEY,relative_path TEXT NOT NULL UNIQUE,kind INTEGER NOT NULL,size BLOB NOT NULL CHECK(length(size)=8),modified_nanos BLOB NOT NULL CHECK(length(modified_nanos)=8),is_map INTEGER NOT NULL,profile_version INTEGER,package_name TEXT,failure_code TEXT,classes BLOB NOT NULL,serialized_names BLOB NOT NULL,reversed_classes BLOB NOT NULL)")
                .map_err(storage_error("create unpublished snapshot"))?;
        }
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

// SQLite integers are signed; fixed-width blobs preserve the Catalog's entire u64 domain.
fn decode_unsigned(value: Vec<u8>) -> rusqlite::Result<u64> {
    let bytes: &[u8; 8] = value.as_slice().try_into().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(error))
    })?;
    Ok(u64::from_be_bytes(*bytes))
}
fn query_sql(kind: &QueryKind, cursor: String, limit: usize) -> (String, Vec<Value>) {
    let mut args = vec![Value::Text(cursor)];
    if let QueryKind::SerializedNames { values } = kind {
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
        QueryKind::SerializedNames { .. } => unreachable!(),
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
            "WITH candidates AS MATERIALIZED (SELECT DISTINCT e.id,e.relative_path FROM posting p JOIN entry e USING(id) WHERE e.relative_path>? AND p.kind={index_kind} AND ({predicate}) ORDER BY e.relative_path LIMIT ?) SELECT e.relative_path,COALESCE(e.package_name,''),json(e.classes),json(e.serialized_names) FROM candidates c JOIN entry e USING(id) ORDER BY e.relative_path"
        ),
        args,
    )
}

fn publish_manifest(directory: &Path, manifest: &Manifest) -> Result<(), CatalogError> {
    let path = directory.join(MANIFEST_FILE);
    // Reject an invalid destination before creating an atomic-write temporary file.
    if path.is_dir() {
        return Err(CatalogError::Unavailable {
            message: "the Catalog manifest path is a directory".to_owned(),
        });
    }
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
            message: format!("the SQLite Catalog manifest is invalid: {error}"),
        })?;
    if manifest.manifest_schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.snapshot_schema_version != SNAPSHOT_SCHEMA_VERSION
        || manifest.project_id != project_id.as_str()
        || manifest.summary.generation == 0
        || manifest.summary.map_count > manifest.summary.package_count
        || !matches!(
            manifest.summary.completeness.as_str(),
            "complete" | "partial"
        )
        || !valid_snapshot_name(&manifest.physical_snapshot)
        || manifest
            .previous_snapshot
            .as_deref()
            .is_some_and(|name| !valid_snapshot_name(name))
    {
        return Err(CatalogError::Corrupt {
            message: "the SQLite Catalog manifest is incompatible or belongs to another project"
                .to_owned(),
        });
    }
    let snapshot = directory.join(&manifest.physical_snapshot);
    if !snapshot.is_file() {
        return Err(CatalogError::Corrupt {
            message: "the SQLite Catalog manifest names a missing snapshot".to_owned(),
        });
    }
    if check_integrity {
        verify_snapshot(&snapshot)?;
    }
    Ok(Some(manifest))
}

fn verify_snapshot(path: &Path) -> Result<(), CatalogError> {
    let connection = open_connection(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| {
        CatalogError::Corrupt {
            message: format!("the immutable SQLite Catalog snapshot cannot be opened: {error}"),
        }
    })?;
    // Prepare the complete persisted shape, including postings. Counting entry rows alone
    // would accept a partially missing schema and postpone failure until the first query.
    connection
        .prepare(&format!(
            "SELECT {},p.kind,p.value,p.id FROM entry e LEFT JOIN posting p USING(id) LIMIT 0",
            ENTRY_COLUMNS
                .split(',')
                .map(|column| format!("e.{column}"))
                .collect::<Vec<_>>()
                .join(",")
        ))
        .map_err(|error| CatalogError::Corrupt {
            message: format!("the immutable SQLite Catalog schema is invalid: {error}"),
        })?;
    connection
        .query_row("SELECT count(*) FROM entry", [], |row| row.get::<_, u64>(0))
        .map(|_| ())
        .map_err(|error| CatalogError::Corrupt {
            message: format!("the immutable SQLite Catalog snapshot is invalid: {error}"),
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
            .map_err(io_unavailable("quarantine the SQLite Catalog"));
    }
    Err(CatalogError::Unavailable {
        message: "could not quarantine the SQLite Catalog: all quarantine slots are occupied"
            .to_owned(),
    })
}

fn snapshot_file_name(generation: Generation) -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "snapshot-{}-{}-{nonce}.sqlite",
        generation.get(),
        std::process::id()
    )
}

fn valid_snapshot_name(name: &str) -> bool {
    name.starts_with("snapshot-")
        && name.ends_with(".sqlite")
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
            message: format!("could not remove an unpublished SQLite snapshot: {error}"),
        }),
    }
}

fn io_unavailable(operation: &'static str) -> impl FnOnce(std::io::Error) -> CatalogError {
    move |error| CatalogError::Unavailable {
        message: format!("could not {operation}: {error}"),
    }
}

fn storage_error(operation: &'static str) -> impl FnOnce(rusqlite::Error) -> CatalogError {
    move |error| CatalogError::Unavailable {
        message: format!("could not {operation}: {error}"),
    }
}

#[cfg(test)]
impl Drop for SqliteCatalog {
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
    fn sqlite_catalog() -> SqliteCatalog {
        let root = std::env::temp_dir().join(format!(
            "ue-shed-sqlite-catalog-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut catalog = SqliteCatalog::open(&root, &fixture_project_id()).unwrap();
        catalog.cleanup_root = Some(root);
        catalog
    }
    catalog_conformance_tests!(immutable_sqlite, sqlite_catalog);

    #[test]
    fn a_missing_postings_table_is_quarantined_before_refresh() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{FIXTURE_PROJECT_ROOT, refresh_fixture};
        use crate::direct_executor::project_index::refresh;
        let mut catalog = sqlite_catalog();
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let root = catalog.cleanup_root.take().unwrap();
        let snapshot = catalog.committed_snapshot_path().unwrap();
        drop(catalog);
        let connection = Connection::open(snapshot).unwrap();
        connection.execute_batch("DROP TABLE posting").unwrap();
        drop(connection);
        let mut reopened = SqliteCatalog::open(&root, &fixture_project_id()).unwrap();
        reopened.cleanup_root = Some(root);
        assert!(reopened.quarantined_from().is_some());
        assert!(matches!(reopened.status(), CatalogStatus::Absent));
    }

    #[test]
    fn incremental_updates_preserve_old_bytes_and_path_pagination() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{
            FIXTURE_PROJECT_ROOT, FakeScanner, collect_pages, header, package,
        };
        use crate::direct_executor::project_index::refresh;
        let mut catalog = sqlite_catalog();
        let mut scanner = FakeScanner::default();
        // Deliberately stage out of order: row IDs must not become pagination keys.
        for name in ["Z", "A"] {
            let path = format!("Content/{name}.uasset");
            scanner.entries.push(package(&path, 1, 1));
            scanner
                .headers
                .insert(path, header(name, &["/Script/Test.Widget"], &[]));
        }
        let run = |catalog: &mut SqliteCatalog, scanner: &FakeScanner| {
            refresh(
                catalog,
                scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .unwrap();
        };
        run(&mut catalog, &scanner);
        let previous = catalog.committed_snapshot_path().unwrap();
        let bytes = fs::read(&previous).unwrap();
        scanner.entries.push(package("Content/M.uasset", 1, 1));
        scanner.headers.insert(
            "Content/M.uasset".into(),
            header("M", &["/Script/Test.Widget"], &[]),
        );
        scanner.entries[0].modified_nanos = 2;
        scanner.headers.insert(
            "Content/Z.uasset".into(),
            header("Z", &["/Script/Test.Other"], &[]),
        );
        run(&mut catalog, &scanner);
        assert_eq!(
            fs::read(previous).unwrap(),
            bytes,
            "publication never mutates the old snapshot"
        );
        for kind in [
            QueryKind::ExactClasses {
                values: vec!["/Script/Test.Widget".into()],
            },
            QueryKind::ClassPrefixes {
                values: vec!["/Script/Test.W".into()],
            },
            QueryKind::ClassNameSuffixes {
                values: vec!["Widget".into()],
            },
        ] {
            let items = collect_pages(&catalog, catalog.committed_generation().unwrap(), kind, 1);
            assert_eq!(
                items.iter().map(item_path).collect::<Vec<_>>(),
                ["Content/A.uasset", "Content/M.uasset"]
            );
        }
        // Deletion-only refresh must initialize a private writer and remove all stale postings.
        scanner
            .entries
            .retain(|e| e.relative_path != "Content/A.uasset");
        run(&mut catalog, &scanner);
        let items = collect_pages(
            &catalog,
            catalog.committed_generation().unwrap(),
            QueryKind::ExactClasses {
                values: vec!["/Script/Test.Widget".into()],
            },
            1,
        );
        assert_eq!(
            items.iter().map(item_path).collect::<Vec<_>>(),
            ["Content/M.uasset"]
        );
    }

    #[test]
    fn signatures_preserve_the_full_unsigned_domain() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{FIXTURE_PROJECT_ROOT, refresh_fixture};
        use crate::direct_executor::project_index::refresh;
        let mut catalog = sqlite_catalog();
        let mut scanner = refresh_fixture();
        scanner.entries[0].size = u64::MAX;
        scanner.entries[0].modified_nanos = u64::MAX;
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .unwrap();
        let signature = &scanner.entries[0];
        assert_eq!(
            catalog
                .lookup_committed(&signature.relative_path)
                .unwrap()
                .0,
            *signature
        );
        assert!(
            catalog
                .committed_entries()
                .unwrap()
                .iter()
                .any(|e| e.signature == *signature)
        );
    }

    #[test]
    fn failed_publication_removes_unpublished_snapshot_and_journal() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{FIXTURE_PROJECT_ROOT, refresh_fixture};
        use crate::direct_executor::project_index::refresh;
        let mut catalog = sqlite_catalog();
        fs::create_dir(catalog.directory.join(MANIFEST_FILE)).unwrap();
        assert!(
            refresh(
                &mut catalog,
                &refresh_fixture(),
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {}
            )
            .is_err()
        );
        assert!(matches!(catalog.status(), CatalogStatus::Absent));
        let files = fs::read_dir(&catalog.directory)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(files, [std::ffi::OsString::from(MANIFEST_FILE)]);
    }

    #[test]
    fn discard_closes_writer_before_removing_files() {
        use crate::direct_executor::catalog_conformance::{header, package};
        let mut catalog = sqlite_catalog();
        let token = catalog.begin_refresh().unwrap();
        assert!(catalog.staging.as_ref().unwrap().connection.is_none());
        catalog
            .stage_observed(
                &token,
                StagedPackage {
                    signature: package("Content/A.uasset", 1, 1),
                    header: Some(header("/Game/A", &["Class"], &[])),
                },
            )
            .unwrap();
        let path = catalog.staging.as_ref().unwrap().snapshot_path.clone();
        assert!(path.is_file());
        catalog.discard_refresh(token).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&catalog.directory).unwrap().count(), 0);
    }
    #[test]
    fn bounded_queries_reuse_one_read_only_connection() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{FIXTURE_PROJECT_ROOT, refresh_fixture};
        use crate::direct_executor::project_index::refresh;

        let mut catalog = sqlite_catalog();
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

        let mut catalog = sqlite_catalog();
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

        let mut catalog = sqlite_catalog();
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

        let mut catalog = sqlite_catalog();
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

        let mut reopened = SqliteCatalog::open(&root, &fixture_project_id()).expect("reopen");
        reopened.cleanup_root = Some(root);
        assert_eq!(reopened.committed_generation(), Some(summary.generation));
        assert_eq!(
            reopened
                .committed_entries()
                .expect("committed entries")
                .len(),
            3
        );
    }

    #[test]
    fn a_reader_keeps_the_previous_snapshot_while_the_next_generation_publishes() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{
            FIXTURE_PROJECT_ROOT, FakeScanner, header, package, refresh_fixture,
        };
        use crate::direct_executor::project_index::refresh;

        let mut catalog = sqlite_catalog();
        refresh(
            &mut catalog,
            &refresh_fixture(),
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("first refresh");
        let first_path = catalog.committed_snapshot_path().expect("first snapshot");
        let reader =
            open_connection(&first_path, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("old reader");
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
        assert_eq!(
            catalog
                .committed_entries()
                .expect("committed entries")
                .len(),
            1
        );
        assert!(
            first_path.is_file(),
            "the previous physical snapshot is retained"
        );
    }

    #[test]
    fn unreadable_snapshot_aborts_refresh_without_replacing_generation() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{
            FIXTURE_PROJECT_ROOT, FakeScanner, refresh_fixture,
        };
        use crate::direct_executor::project_index::{CoordinatorError, refresh};

        for missing in [true, false] {
            let mut catalog = sqlite_catalog();
            refresh(
                &mut catalog,
                &refresh_fixture(),
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .expect("initial refresh");
            let generation = catalog.committed_generation();
            let manifest_path = catalog.directory.join(MANIFEST_FILE);
            let manifest = fs::read(&manifest_path).expect("read committed manifest");
            let snapshot = catalog.committed_snapshot_path().expect("snapshot");
            if missing {
                fs::remove_file(&snapshot).expect("remove disposable snapshot");
            } else {
                fs::write(&snapshot, b"corrupted snapshot").expect("corrupt disposable snapshot");
            }
            let error = refresh(
                &mut catalog,
                &FakeScanner::default(),
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .expect_err("unreadable committed evidence must abort refresh");
            assert!(matches!(
                error,
                CoordinatorError::Catalog(CatalogError::Unavailable { .. })
            ));
            assert_eq!(catalog.committed_generation(), generation);
            assert_eq!(
                fs::read(&manifest_path).expect("manifest survives"),
                manifest
            );
            assert!(catalog.staging.is_none());
        }
    }

    #[test]
    fn a_corrupt_manifest_is_quarantined_without_touching_project_data() {
        use crate::cancellation::CancellationToken;
        use crate::direct_executor::catalog_conformance::{FIXTURE_PROJECT_ROOT, refresh_fixture};
        use crate::direct_executor::project_index::refresh;

        let mut catalog = sqlite_catalog();
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

        let mut recovered = SqliteCatalog::open(&root, &fixture_project_id()).expect("recover");
        assert!(matches!(recovered.status(), CatalogStatus::Absent));
        assert!(recovered.quarantined_from().is_some());
        recovered.cleanup_root = Some(root);
    }
}
