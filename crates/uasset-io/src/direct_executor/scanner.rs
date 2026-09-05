//! Filesystem-backed package discovery and Project Index scanning.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::UNIX_EPOCH;

use uasset_parser::PackageSummary;
use uasset_parser::package::{Package, PackageError, PackageErrorKind};

use super::catalog::{
    EntryKind, HeaderEvidence, INDEX_PROFILE_VERSION, PROJECT_INDEX_MAX_CLASSES,
    PROJECT_INDEX_MAX_NAMES, PackageSignature, project_relative_path,
};
use super::project_index::{CoordinatorError, HeaderEvidenceSink, ProjectScanner};
use super::{Failure, checkpoint};
use crate::cancellation::CancellationToken;

pub(crate) const PACKAGE_EXTENSIONS: &[&str] = &["uasset", "umap"];
pub(crate) const SIDECAR_EXTENSIONS: &[&str] = &["uexp", "ubulk", "uptnl"];

const HEADER_PROBE_BYTES: usize = 4 * 1024;
const MAX_SUMMARY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024 * 1024;
const HEADER_WORKERS: usize = 4;
/// Keep read-ahead bounded while allowing workers to continue during a Catalog batch flush.
const HEADER_RESULT_BUFFER: usize = 1_024;

#[derive(Clone)]
pub(crate) struct FileSignature {
    pub(crate) modified_nanos: u64,
    pub(crate) path: PathBuf,
    pub(crate) size: u64,
}

/// Filesystem adapter for the storage-neutral Project Index coordinator.
#[derive(Debug, Default)]
pub(crate) struct FilesystemProjectScanner;

impl ProjectScanner for FilesystemProjectScanner {
    fn enumerate(
        &self,
        project_root: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<PackageSignature>, CoordinatorError> {
        let root = Path::new(project_root).join("Content");
        let mut signatures = Vec::new();
        visit_scan_files(&root, cancellation, &mut |entry, path| {
            let kind = if is_package_path(&path) {
                EntryKind::Package
            } else if is_sidecar_path(&path) {
                EntryKind::Sidecar
            } else {
                return Ok(());
            };
            // Windows directory enumeration already supplies this metadata. Avoid reopening
            // every package just to stat it. Changed headers are still revalidated after reading.
            let metadata = entry
                .metadata()
                .map_err(|error| discovery_failure(&path, error))?;
            signatures.push(PackageSignature {
                relative_path: project_relative_path(project_root, &path.to_string_lossy()),
                kind,
                size: metadata.len(),
                modified_nanos: metadata_modified_nanos(&metadata),
            });
            Ok(())
        })?;
        signatures.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(signatures)
    }

    fn read_header_evidence(
        &self,
        _project_root: &str,
        signature: &PackageSignature,
        cancellation: &CancellationToken,
    ) -> Result<HeaderEvidence, CoordinatorError> {
        if signature.kind == EntryKind::Sidecar {
            return Err(CoordinatorError::InvalidRequest {
                message: format!(
                    "sidecar entries do not have package header evidence: {}",
                    signature.relative_path
                ),
            });
        }
        let path = Path::new(_project_root).join(&signature.relative_path);
        let package = read_package_header(&path, signature.size, cancellation)?;
        let classes = bounded_header_values(
            package
                .exports
                .iter()
                .filter_map(|export| export.class_path.as_ref().map(|path| path.as_str())),
            PROJECT_INDEX_MAX_CLASSES,
        );
        // The v1 profile keeps a bounded name-map sample for serialized-name queries.
        let serialized_names = bounded_header_values(
            package.names.iter().map(String::as_str),
            PROJECT_INDEX_MAX_NAMES,
        );
        Ok(HeaderEvidence {
            profile_version: INDEX_PROFILE_VERSION,
            package_name: package.summary.package_name.clone(),
            classes,
            serialized_names,
            failure_code: None,
        })
    }

    fn stream_header_evidence(
        &self,
        project_root: &str,
        signatures: &[PackageSignature],
        cancellation: &CancellationToken,
        on_header: &mut HeaderEvidenceSink<'_>,
    ) -> Result<(), CoordinatorError> {
        if signatures.is_empty() {
            return Ok(());
        }
        let worker_count = HEADER_WORKERS.min(signatures.len());
        let lane_capacity = (HEADER_RESULT_BUFFER / worker_count).max(1);
        let mut senders = Vec::with_capacity(worker_count);
        let mut receivers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let (sender, receiver) = sync_channel(lane_capacity);
            senders.push(sender);
            receivers.push(receiver);
        }
        let stop = AtomicBool::new(false);
        let mut callback_error = None;
        std::thread::scope(|scope| {
            for (worker, sender) in senders.into_iter().enumerate() {
                let cancellation = cancellation.clone();
                let stop = &stop;
                scope.spawn(move || {
                    for index in (worker..signatures.len()).step_by(worker_count) {
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        let signature = &signatures[index];
                        let result =
                            self.read_header_evidence(project_root, signature, &cancellation);
                        if sender.send((index, result)).is_err() {
                            break;
                        }
                    }
                });
            }
            for index in 0..signatures.len() {
                let receiver = &receivers[index % worker_count];
                let received = receiver.recv();
                match received {
                    Ok((received_index, result)) => {
                        debug_assert_eq!(received_index, index);
                        if callback_error.is_none()
                            && let Err(error) = on_header(&signatures[index], result)
                        {
                            stop.store(true, Ordering::Relaxed);
                            callback_error = Some(error);
                        }
                    }
                    Err(_) if callback_error.is_some() => break,
                    Err(_) => {
                        stop.store(true, Ordering::Relaxed);
                        callback_error = Some(CoordinatorError::Unavailable {
                            message: "a Project Index header worker stopped unexpectedly"
                                .to_owned(),
                        });
                        break;
                    }
                }
            }
            // A stopped lane can close before another lane has drained its read-ahead. Close
            // all receivers before joining, so a worker blocked in send can also stop.
            drop(receivers);
        });
        match callback_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn reread_signature(
        &self,
        project_root: &str,
        relative_path: &str,
        kind: EntryKind,
        cancellation: &CancellationToken,
    ) -> Result<Option<PackageSignature>, CoordinatorError> {
        checkpoint(cancellation, "read")?;
        let relative_path = Path::new(relative_path);
        if relative_path.is_absolute() || relative_path.starts_with("..") {
            return Err(CoordinatorError::InvalidRequest {
                message: "Project Index entry path must be relative to the project root".to_owned(),
            });
        }
        let path = Path::new(project_root).join(relative_path);
        let Some(signature) = read_asset_signature(&path) else {
            return Ok(None);
        };
        let matches_kind = match kind {
            EntryKind::Package => is_package_path(&path),
            EntryKind::Sidecar => is_sidecar_path(&path),
        };
        if !matches_kind {
            return Ok(None);
        }
        checkpoint(cancellation, "read")?;
        Ok(Some(PackageSignature {
            relative_path: project_relative_path(project_root, &path.to_string_lossy()),
            kind,
            size: signature.size,
            modified_nanos: signature.modified_nanos,
        }))
    }
}

pub(crate) fn discover_paths(
    roots: &[PathBuf],
    include_sidecars: bool,
    cancellation: &CancellationToken,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), Failure> {
    let mut packages = Vec::new();
    let mut sidecars = Vec::new();
    for root in roots {
        checkpoint(cancellation, "discovery")?;
        if root.is_file() {
            packages.push(root.clone());
            continue;
        }
        visit_scan_files(root, cancellation, &mut |_, path| {
            if is_package_path(&path) {
                packages.push(path);
            } else if include_sidecars && is_sidecar_path(&path) {
                sidecars.push(path);
            }
            Ok(())
        })?;
    }
    checkpoint(cancellation, "discovery")?;
    packages.sort();
    packages.dedup();
    sidecars.sort();
    sidecars.dedup();
    Ok((packages, sidecars))
}

fn visit_scan_files(
    directory: &Path,
    cancellation: &CancellationToken,
    on_file: &mut impl FnMut(fs::DirEntry, PathBuf) -> Result<(), Failure>,
) -> Result<(), Failure> {
    checkpoint(cancellation, "discovery")?;
    let entries = fs::read_dir(directory).map_err(|error| discovery_failure(directory, error))?;
    for entry in entries {
        checkpoint(cancellation, "discovery")?;
        let entry = entry.map_err(|error| discovery_failure(directory, error))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| discovery_failure(&path, error))?;
        if file_type.is_dir() {
            visit_scan_files(&path, cancellation, on_file)?;
        } else if file_type.is_file() {
            on_file(entry, path)?;
        }
    }
    checkpoint(cancellation, "discovery")?;
    Ok(())
}

fn discovery_failure(path: &Path, error: std::io::Error) -> Failure {
    Failure {
        code: "discovery".to_owned(),
        message: format!("could not enumerate {}: {error}", path.display()),
        retry_safe: true,
        ..Default::default()
    }
}

pub(crate) fn is_package_path(path: &Path) -> bool {
    has_extension(path, PACKAGE_EXTENSIONS)
}

pub(crate) fn is_sidecar_path(path: &Path) -> bool {
    has_extension(path, SIDECAR_EXTENSIONS)
}

pub(crate) fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

pub(crate) fn read_asset_signature(path: &Path) -> Option<FileSignature> {
    let metadata = fs::metadata(path).ok()?;
    Some(FileSignature {
        modified_nanos: metadata_modified_nanos(&metadata),
        path: path.to_owned(),
        size: metadata.len(),
    })
}

fn metadata_modified_nanos(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
        })
}

pub(crate) fn read_asset_signature_with_cancellation(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<FileSignature>, Failure> {
    checkpoint(cancellation, "read")?;
    let signature = read_asset_signature(path);
    checkpoint(cancellation, "read")?;
    Ok(signature)
}

pub(crate) fn read_package_header(
    path: &Path,
    size: u64,
    cancellation: &CancellationToken,
) -> Result<Package, Failure> {
    checkpoint(cancellation, "read")?;
    let file_len = usize::try_from(size).map_err(|_| header_failure("asset_resource_limit"))?;
    if file_len == 0 {
        return Err(header_failure("asset_malformed_data"));
    }
    let mut file = File::open(path).map_err(|_| header_failure("asset_io"))?;
    let mut prefix_len = HEADER_PROBE_BYTES.min(file_len);
    let mut bytes = vec![0; prefix_len];
    file.read_exact(&mut bytes)
        .map_err(|_| header_failure("asset_io"))?;
    checkpoint(cancellation, "read")?;
    let summary = loop {
        checkpoint(cancellation, "parsing")?;
        match PackageSummary::parse_with_file_len(&bytes, file_len) {
            Ok(summary) => break summary,
            Err(error)
                if error.kind() == PackageErrorKind::MalformedData
                    && prefix_len < MAX_SUMMARY_BYTES.min(file_len) =>
            {
                let next_len = (prefix_len * 2).min(MAX_SUMMARY_BYTES).min(file_len);
                bytes.resize(next_len, 0);
                file.read_exact(&mut bytes[prefix_len..])
                    .map_err(|_| header_failure("asset_io"))?;
                checkpoint(cancellation, "read")?;
                prefix_len = next_len;
            }
            Err(error) => return Err(header_failure(package_error_code(&error))),
        }
    };
    checkpoint(cancellation, "parsing")?;
    let header_len = usize::try_from(summary.total_header_size)
        .map_err(|_| header_failure("asset_resource_limit"))?;
    if header_len > MAX_HEADER_BYTES {
        return Err(header_failure("asset_resource_limit"));
    }
    if header_len > bytes.len() {
        let previous_len = bytes.len();
        bytes.resize(header_len, 0);
        file.read_exact(&mut bytes[previous_len..])
            .map_err(|_| header_failure("asset_io"))?;
    } else {
        bytes.truncate(header_len);
    }
    checkpoint(cancellation, "read")?;
    checkpoint(cancellation, "inspection")?;
    Package::parse_header(&bytes, file_len)
        .map_err(|error| header_failure(package_error_code(&error)))
}

fn header_failure(code: &'static str) -> Failure {
    Failure {
        code: code.to_owned(),
        message: format!("could not inspect package header ({code})"),
        retry_safe: matches!(code, "asset_io"),
        ..Default::default()
    }
}

/// Keep the profile's lexicographically first unique values without cloning discarded evidence.
/// Auxiliary storage is bounded by the output limit even for very large package name maps.
fn bounded_header_values<'a>(values: impl Iterator<Item = &'a str>, limit: usize) -> Vec<String> {
    if limit == 0 {
        return Vec::new();
    }
    let mut selected = BTreeSet::new();
    for value in values {
        if selected.len() == limit && selected.last().is_some_and(|last| value >= *last) {
            continue;
        }
        selected.insert(value);
        if selected.len() > limit {
            selected.pop_last();
        }
    }
    selected.into_iter().map(str::to_owned).collect()
}

fn package_error_code(error: &PackageError) -> &'static str {
    match error.kind() {
        PackageErrorKind::MalformedData => "asset_malformed_data",
        PackageErrorKind::ResourceLimit => "asset_resource_limit",
        PackageErrorKind::UnsupportedFormat => "asset_unsupported_format",
        PackageErrorKind::UnsupportedVersion => "asset_unsupported_version",
        PackageErrorKind::UnsupportedCapability => "asset_unsupported_capability",
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{FilesystemProjectScanner, ProjectScanner, bounded_header_values};
    use crate::cancellation::CancellationToken;
    use crate::direct_executor::catalog::{EntryKind, PackageSignature};

    #[test]
    fn bounded_header_sample_preserves_order_uniqueness_and_late_small_values() {
        let mut names: Vec<_> = (0..4096).rev().map(|i| format!("Name{i:04}")).collect();
        names.extend(["".to_owned(), "Ångström".to_owned(), "名前".to_owned()]);
        names.extend(names.clone());
        let mut expected = names.clone();
        expected.sort();
        expected.dedup();
        for limit in [0, 1, 64, 4096, 8192] {
            assert_eq!(
                bounded_header_values(names.iter().map(String::as_str), limit),
                expected.iter().take(limit).cloned().collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn filesystem_scanner_enumerates_content_packages_and_sidecars() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let project_root = std::env::temp_dir().join(format!("ue-shed-scanner-{suffix}"));
        let content = project_root.join("Content");
        let package = content.join("Data").join("DT_Items.uasset");
        let sidecar = content.join("Data").join("DT_Items.uexp");
        fs::create_dir_all(package.parent().expect("package parent")).expect("create Content");
        fs::write(&package, [1, 2, 3]).expect("write package");
        fs::write(&sidecar, [4, 5]).expect("write sidecar");
        fs::write(content.join("Ignored.txt"), [6]).expect("write unrelated file");

        let scanner = FilesystemProjectScanner;
        let entries = scanner
            .enumerate(&project_root.to_string_lossy(), &CancellationToken::new())
            .expect("enumerate Content");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].relative_path, "Content/Data/DT_Items.uasset");
        assert_eq!(entries[0].kind, EntryKind::Package);
        assert_eq!(entries[1].relative_path, "Content/Data/DT_Items.uexp");
        assert_eq!(entries[1].kind, EntryKind::Sidecar);
        for entry in &entries {
            assert_eq!(
                Some(entry.clone()),
                scanner
                    .reread_signature(
                        &project_root.to_string_lossy(),
                        &entry.relative_path,
                        entry.kind,
                        &CancellationToken::new(),
                    )
                    .expect("reread discovered signature")
            );
        }
        assert_eq!(entries[0].size, 3);
        assert_eq!(entries[1].size, 2);
        fs::remove_dir_all(&project_root).expect("remove temporary project");
    }

    #[test]
    fn parallel_header_stream_preserves_signature_order() {
        let scanner = FilesystemProjectScanner;
        let signatures = (0..32)
            .map(|index| PackageSignature {
                relative_path: format!("Content/Missing/A_{index:02}.uasset"),
                kind: EntryKind::Package,
                size: 1,
                modified_nanos: 1,
            })
            .collect::<Vec<_>>();
        let mut observed = Vec::new();
        scanner
            .stream_header_evidence(
                "C:/Missing",
                &signatures,
                &CancellationToken::new(),
                &mut |signature, _| {
                    observed.push(signature.relative_path.clone());
                    Ok(())
                },
            )
            .expect("stream headers");
        assert_eq!(
            observed,
            signatures
                .iter()
                .map(|signature| signature.relative_path.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn parallel_header_stream_stops_when_the_sink_fails() {
        let signatures = (0..4096)
            .map(|index| PackageSignature {
                relative_path: format!("Content/Missing/A_{index:04}.uasset"),
                kind: EntryKind::Package,
                size: 1,
                modified_nanos: 1,
            })
            .collect::<Vec<_>>();
        let mut calls = 0;
        let error = FilesystemProjectScanner
            .stream_header_evidence(
                "C:/Missing",
                &signatures,
                &CancellationToken::new(),
                &mut |_, _| {
                    calls += 1;
                    Err(super::CoordinatorError::Unavailable {
                        message: "sink stopped".to_owned(),
                    })
                },
            )
            .expect_err("propagate the sink failure without waiting on blocked senders");
        assert_eq!(calls, 1);
        assert_eq!(error.to_string(), "sink stopped");
    }
}
