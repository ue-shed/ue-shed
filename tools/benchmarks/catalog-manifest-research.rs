// Historical manifest scaffolding for the 2026-09-05 adapter experiments.
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


// @HELPERS@
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
