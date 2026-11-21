//! Filesystem-backed package discovery and Project Index scanning.

mod discovery;
mod plugins;

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use uasset_inspection::package_header::{
    LeadingHeader, MAX_HEADER_BYTES, MAX_SUMMARY_BYTES, PackageHeaderData, parse_leading_header,
};
use uasset_parser::package::{Package, PackageError, PackageErrorKind};
use uasset_parser::{HeaderIndex, PackageSummary};

use super::catalog::{
    EntryKind, EvidencePreparer, HeaderEvidence, INDEX_PROFILE_VERSION, IndexScope, MountPoint,
    PROJECT_INDEX_MAX_CLASSES, PROJECT_INDEX_MAX_DEPENDENCIES, PROJECT_INDEX_MAX_NAMES,
    PackageSignature, project_relative_path,
};
use super::catalog_dependencies::package_name_for_path;
use super::project_index::{
    CoordinatorError, HeaderEvidenceSink, HeaderObservation, ProjectScanner, observe_header,
};
use super::{Failure, checkpoint};
use crate::cancellation::CancellationToken;

pub(crate) const PACKAGE_EXTENSIONS: &[&str] = &["uasset", "umap"];
pub(crate) const SIDECAR_EXTENSIONS: &[&str] = &["uexp", "ubulk", "uptnl"];

/// The first read of a package: most saved headers end within it, so one read holds the whole
/// header. Larger headers read the rest once the summary gives their size.
const HEADER_PROBE_BYTES: usize = 16 * 1024;
/// A header worker keeps a read buffer this large between packages; one that grew past it for a
/// very large header gives the memory back.
const HEADER_SCRATCH_RETAIN_BYTES: usize = 4 * 1024 * 1024;
// Header parsing and post-read signature checks share these workers. Keep the same global
// read-ahead bound when scaling up, and respect smaller hosts' available parallelism. Header reads
// wait mostly on the operating system's file opens and reads rather than the CPU, so more workers
// than cores still help; past 24 the gain is small while each worker's string dictionary and
// buffers still cost memory.
const MAX_HEADER_WORKERS: usize = 24;
/// Keep read-ahead bounded while allowing workers to continue during a Catalog batch flush:
/// workers never read more than this many packages past the first one not yet delivered.
const HEADER_RESULT_BUFFER: usize = 1_024;
/// Packages a worker claims at once. Small enough that one slow package (a very large map)
/// holds back only its own chunk while the other workers keep claiming.
const HEADER_CHUNK: usize = 16;

thread_local! {
    /// Each header worker's read buffer, reused across the packages it reads. Its length is the
    /// part already initialized, so reuse never zero-fills again.
    static HEADER_SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone)]
pub(crate) struct FileSignature {
    pub(crate) modified_nanos: u64,
    pub(crate) path: PathBuf,
    pub(crate) size: u64,
}

/// Filesystem adapter for the storage-neutral Project Index coordinator.
#[derive(Debug)]
pub(crate) struct FilesystemProjectScanner {
    scope: IndexScope,
    /// `/Game/` first, then plugin content mount points for a plugin-inclusive scope.
    mounts: Vec<MountPoint>,
}

impl FilesystemProjectScanner {
    /// A scanner for one index scope of a project, with the mount points Unreal would give it.
    pub(crate) fn new(
        project_root: &str,
        scope: IndexScope,
        cancellation: &CancellationToken,
    ) -> Result<Self, Failure> {
        let mut mounts = vec![MountPoint::game()];
        if scope == IndexScope::ContentAndPlugins {
            mounts.extend(plugins::content_mount_points(
                Path::new(project_root),
                cancellation,
            )?);
        }
        Ok(Self { scope, mounts })
    }

    /// A scanner for the project's `Content` alone.
    #[cfg(test)]
    pub(crate) fn content() -> Self {
        Self {
            scope: IndexScope::Content,
            mounts: vec![MountPoint::game()],
        }
    }
}

impl ProjectScanner for FilesystemProjectScanner {
    fn scope(&self) -> IndexScope {
        self.scope
    }

    fn mount_points(&self) -> Vec<MountPoint> {
        self.mounts.clone()
    }

    fn enumerate(
        &self,
        project_root: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<PackageSignature>, CoordinatorError> {
        let further_roots = self.mounts[1..]
            .iter()
            .map(|mount| Path::new(project_root).join(&mount.path))
            .collect::<Vec<_>>();
        discovery::enumerate(project_root, &further_roots, cancellation).map_err(Into::into)
    }

    fn read_header_evidence(
        &self,
        project_root: &str,
        signature: &PackageSignature,
        cancellation: &CancellationToken,
    ) -> Result<HeaderEvidence, CoordinatorError> {
        let path = self.package_path(project_root, signature)?;
        checkpoint(cancellation, "read")?;
        let file_len = header_file_len(signature.size)?;
        let mut file = File::open(&path).map_err(|_| header_failure("asset_io"))?;
        Ok(HEADER_SCRATCH.with_borrow_mut(|scratch| {
            let evidence =
                self.header_evidence(&mut file, file_len, signature, scratch, cancellation);
            release_large_scratch(scratch);
            evidence
        })?)
    }

    /// Reads the evidence and then the signature from the same open file, so a package costs one
    /// open: the signature is the file's metadata after its header was read.
    fn read_header_observation(
        &self,
        project_root: &str,
        signature: &PackageSignature,
        cancellation: &CancellationToken,
    ) -> Result<HeaderObservation, CoordinatorError> {
        let path = self.package_path(project_root, signature)?;
        checkpoint(cancellation, "read")?;
        let file_len = header_file_len(signature.size)?;
        let mut file = File::open(&path).map_err(|_| header_failure("asset_io"))?;
        let evidence = HEADER_SCRATCH.with_borrow_mut(|scratch| {
            let evidence =
                self.header_evidence(&mut file, file_len, signature, scratch, cancellation);
            release_large_scratch(scratch);
            evidence
        })?;
        checkpoint(cancellation, "read")?;
        let observed = match file.metadata() {
            Ok(metadata) if metadata.is_file() => Some(PackageSignature {
                relative_path: project_relative_path(project_root, &path.to_string_lossy()),
                kind: signature.kind,
                size: metadata.len(),
                modified_nanos: metadata_modified_nanos(&metadata),
            }),
            _ => None,
        };
        drop(file);
        checkpoint(cancellation, "read")?;
        Ok(HeaderObservation {
            evidence,
            signature: Ok(observed),
        })
    }

    fn stream_header_evidence<P: EvidencePreparer>(
        &self,
        project_root: &str,
        signatures: &[PackageSignature],
        cancellation: &CancellationToken,
        preparer: &P,
        on_header: &mut HeaderEvidenceSink<'_, P::Prepared>,
    ) -> Result<(), CoordinatorError> {
        if signatures.is_empty() {
            return Ok(());
        }
        let worker_count = std::thread::available_parallelism()
            .map_or(4, std::num::NonZeroUsize::get)
            .min(MAX_HEADER_WORKERS)
            .min(signatures.len().div_ceil(HEADER_CHUNK));
        // Workers claim chunks in order from a shared cursor, never more than the read-ahead
        // window past the first package not yet delivered, so a chunk held up by one slow
        // package stalls neither the others nor memory. Results are delivered in order.
        let claims = Mutex::new(HeaderClaims {
            next: 0,
            delivered: 0,
            stopped: false,
        });
        let stop = AtomicBool::new(false);
        let claimed = Condvar::new();
        let window_chunks = HEADER_RESULT_BUFFER.div_ceil(HEADER_CHUNK);
        // One slot per chunk the window allows, so a send never waits for the consumer.
        let (sender, receiver) = sync_channel(window_chunks + worker_count);
        let mut callback_error = None;
        std::thread::scope(|scope| {
            for _ in 0..worker_count {
                let cancellation = cancellation.clone();
                let sender = sender.clone();
                let (claims, claimed, stop) = (&claims, &claimed, &stop);
                scope.spawn(move || {
                    // A worker that unwinds stops the others, so none waits on a window that
                    // will never move.
                    let _stop_on_unwind = StopOnDrop {
                        claims,
                        claimed,
                        stop,
                    };
                    // Chunks are claimed in order and delivered in order, so this worker's
                    // prepared values reach the sink in the order it prepares them.
                    let mut worker = preparer.worker();
                    while let Some(start) = claim_chunk(claims, claimed, signatures.len()) {
                        let end = (start + HEADER_CHUNK).min(signatures.len());
                        let mut results = Vec::with_capacity(end - start);
                        for signature in &signatures[start..end] {
                            if stop.load(Ordering::Relaxed) {
                                return;
                            }
                            results.push(
                                observe_header(self, project_root, signature, &cancellation)
                                    .map(|observation| observation.prepare(preparer, &mut worker)),
                            );
                        }
                        if sender.send((start, results)).is_err() {
                            return;
                        }
                    }
                });
            }
            drop(sender);
            let mut ready = HashMap::new();
            let mut next = 0;
            'deliver: while next < signatures.len() {
                let results = match ready.remove(&next) {
                    Some(results) => results,
                    None => match receiver.recv() {
                        Ok((start, results)) => {
                            ready.insert(start, results);
                            continue;
                        }
                        Err(_) => {
                            callback_error = Some(CoordinatorError::Unavailable {
                                message: "a Project Index header worker stopped unexpectedly"
                                    .to_owned(),
                            });
                            break;
                        }
                    },
                };
                for result in results {
                    if let Err(error) = on_header(&signatures[next], result) {
                        callback_error = Some(error);
                        break 'deliver;
                    }
                    next += 1;
                }
                claims
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .delivered = next;
                claimed.notify_all();
            }
            // Stop and release every worker before joining: one may wait on the window and
            // another in a send.
            stop_claims(&claims, &claimed, &stop);
            drop(receiver);
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

impl FilesystemProjectScanner {
    fn package_path(
        &self,
        project_root: &str,
        signature: &PackageSignature,
    ) -> Result<PathBuf, CoordinatorError> {
        if signature.kind == EntryKind::Sidecar {
            return Err(CoordinatorError::InvalidRequest {
                message: format!(
                    "sidecar entries do not have package header evidence: {}",
                    signature.relative_path
                ),
            });
        }
        Ok(Path::new(project_root).join(&signature.relative_path))
    }

    /// A package's index evidence from its open file, read into `scratch`.
    fn header_evidence(
        &self,
        file: &mut File,
        file_len: usize,
        signature: &PackageSignature,
        scratch: &mut Vec<u8>,
        cancellation: &CancellationToken,
    ) -> Result<HeaderEvidence, Failure> {
        let (summary, header_len) = read_header_into(file, file_len, scratch, cancellation)?;
        checkpoint(cancellation, "inspection")?;
        let header = &scratch[..header_len];
        let index = HeaderIndex::parse_with_summary(header, file_len, summary)
            .map_err(|error| header_failure(package_error_code(&error)))?;
        // Unreal names a package from its file location; the saved name can be stale.
        let mounted_name = package_name_for_path(&self.mounts, &signature.relative_path);
        let dependencies = within_dependency_limit(
            index
                .asset_registry_dependencies(
                    header,
                    mounted_name
                        .as_deref()
                        .unwrap_or(&index.summary.package_name),
                )
                .map_err(|error| header_failure(package_error_code(&error)))?,
        )?;
        let classes = index
            .export_class_paths()
            .map_err(|error| header_failure(package_error_code(&error)))?;
        let classes = bounded_header_values(
            classes.iter().map(String::as_str),
            PROJECT_INDEX_MAX_CLASSES,
        );
        // The v1 profile keeps a bounded name-map sample for serialized-name queries.
        let serialized_names = bounded_header_values(
            index.names().iter().map(|name| name.as_ref()),
            PROJECT_INDEX_MAX_NAMES,
        );
        Ok(HeaderEvidence {
            header_data: Some(PackageHeaderData::from_header_index(&index)),
            profile_version: INDEX_PROFILE_VERSION,
            package_name: index.summary.package_name,
            classes,
            serialized_names,
            dependencies,
            failure_code: None,
        })
    }
}

/// Claims of a parallel header stream: the next chunk to claim, the packages delivered so far,
/// and whether the stream stopped.
struct HeaderClaims {
    next: usize,
    delivered: usize,
    stopped: bool,
}

/// The next chunk's first package, once it is inside the read-ahead window; `None` when the
/// stream is done or stopped.
fn claim_chunk(claims: &Mutex<HeaderClaims>, claimed: &Condvar, len: usize) -> Option<usize> {
    let mut state = claims.lock().unwrap_or_else(PoisonError::into_inner);
    loop {
        if state.stopped || state.next >= len {
            return None;
        }
        if state.next < state.delivered + HEADER_RESULT_BUFFER {
            let start = state.next;
            state.next += HEADER_CHUNK;
            return Some(start);
        }
        state = claimed.wait(state).unwrap_or_else(PoisonError::into_inner);
    }
}

fn stop_claims(claims: &Mutex<HeaderClaims>, claimed: &Condvar, stop: &AtomicBool) {
    stop.store(true, Ordering::Relaxed);
    claims
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .stopped = true;
    claimed.notify_all();
}

/// Stops a header stream when a worker unwinds, so no other worker waits on a window that
/// will never move.
struct StopOnDrop<'a> {
    claims: &'a Mutex<HeaderClaims>,
    claimed: &'a Condvar,
    stop: &'a AtomicBool,
}

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            stop_claims(self.claims, self.claimed, self.stop);
        }
    }
}

fn header_file_len(size: u64) -> Result<usize, Failure> {
    let file_len = usize::try_from(size).map_err(|_| header_failure("asset_resource_limit"))?;
    if file_len == 0 {
        return Err(header_failure("asset_malformed_data"));
    }
    Ok(file_len)
}

/// Gives back a header buffer that grew for an unusually large header.
fn release_large_scratch(scratch: &mut Vec<u8>) {
    if scratch.len() > HEADER_SCRATCH_RETAIN_BYTES {
        scratch.truncate(HEADER_PROBE_BYTES);
        scratch.shrink_to(HEADER_PROBE_BYTES);
    }
}

/// Fills `scratch[from..to]` from the file, growing (and zero-filling) the buffer only past
/// what earlier reads already initialized.
fn read_span(
    file: &mut File,
    scratch: &mut Vec<u8>,
    from: usize,
    to: usize,
) -> Result<(), Failure> {
    if scratch.len() < to {
        scratch.resize(to, 0);
    }
    file.read_exact(&mut scratch[from..to])
        .map_err(|_| header_failure("asset_io"))
}

/// Reads a package's summary and then its whole header into `scratch[..header_len]`: one read
/// of the probe window, then the rest of a larger header, or a doubling summary window while the
/// summary does not yet parse (up to [`MAX_SUMMARY_BYTES`]).
fn read_header_into(
    file: &mut File,
    file_len: usize,
    scratch: &mut Vec<u8>,
    cancellation: &CancellationToken,
) -> Result<(PackageSummary, usize), Failure> {
    checkpoint(cancellation, "read")?;
    let mut prefix_len = HEADER_PROBE_BYTES.min(file_len);
    read_span(file, scratch, 0, prefix_len)?;
    checkpoint(cancellation, "read")?;
    let summary = loop {
        checkpoint(cancellation, "parsing")?;
        match PackageSummary::parse_with_file_len(&scratch[..prefix_len], file_len) {
            Ok(summary) => break summary,
            Err(error)
                if error.kind() == PackageErrorKind::MalformedData
                    && prefix_len < MAX_SUMMARY_BYTES.min(file_len) =>
            {
                let next_len = (prefix_len * 2).min(MAX_SUMMARY_BYTES).min(file_len);
                read_span(file, scratch, prefix_len, next_len)?;
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
    if header_len > prefix_len {
        read_span(file, scratch, prefix_len, header_len)?;
    }
    checkpoint(cancellation, "read")?;
    Ok((summary, header_len))
}

/// Every package and sidecar under the project's `Content`, as the Project Index enumerates them
/// (directory-listing metadata, path order), walked on at most `maximum_workers` threads.
pub(crate) fn enumerate_content(
    project_root: &str,
    cancellation: &CancellationToken,
    maximum_workers: usize,
) -> Result<Vec<PackageSignature>, Failure> {
    discovery::enumerate_bounded(project_root, cancellation, maximum_workers)
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

pub(crate) fn metadata_modified_nanos(metadata: &fs::Metadata) -> u64 {
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
    read_package_header_bytes(path, size, cancellation).map(|(package, _)| package)
}

/// Reads and parses a package header, returning the header bytes for later header sections.
pub(crate) fn read_package_header_bytes(
    path: &Path,
    size: u64,
    cancellation: &CancellationToken,
) -> Result<(Package, Vec<u8>), Failure> {
    checkpoint(cancellation, "read")?;
    let file_len = header_file_len(size)?;
    let mut file = File::open(path).map_err(|_| header_failure("asset_io"))?;
    let mut bytes = Vec::new();
    let (summary, header_len) = read_header_into(&mut file, file_len, &mut bytes, cancellation)?;
    bytes.truncate(header_len);
    checkpoint(cancellation, "inspection")?;
    Package::parse_header_with_summary(&bytes, file_len, summary)
        .map(|package| (package, bytes))
        .map_err(|error| header_failure(package_error_code(&error)))
}

/// Reads a package header from a file holding the package's first bytes, given the size of the
/// whole package, or says how many leading bytes the header needs. This is the read
/// [`read_package_header_bytes`] makes, with the file length declared instead of measured. It
/// reads the summary window and then the header, never export data the file may also hold.
pub(crate) fn read_leading_package_header(
    path: &Path,
    file_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<LeadingHeader, Failure> {
    checkpoint(cancellation, "read")?;
    let io_failure = |error: std::io::Error| {
        Failure::new(
            "io",
            format!(
                "could not read the package's leading bytes from {}: {error}",
                path.display()
            ),
            true,
        )
    };
    let mut file = File::open(path).map_err(io_failure)?;
    let supplied = file.metadata().map_err(io_failure)?.len();
    if file_bytes == 0 || supplied > file_bytes {
        return Err(Failure::new(
            "invalid_request",
            format!(
                "the package's declared size ({file_bytes} bytes) must be positive and at least \
                 the {supplied} leading bytes in {}",
                path.display()
            ),
            false,
        ));
    }
    let supplied = usize::try_from(supplied).unwrap_or(usize::MAX);
    let mut bytes = Vec::new();
    let mut wanted = MAX_SUMMARY_BYTES.min(supplied);
    loop {
        let previous_len = bytes.len();
        bytes.resize(wanted, 0);
        file.read_exact(&mut bytes[previous_len..])
            .map_err(io_failure)?;
        checkpoint(cancellation, "read")?;
        checkpoint(cancellation, "parsing")?;
        let read = parse_leading_header(&bytes, file_bytes)
            .map_err(|error| Failure::new(error.code(), error.to_string(), false))?;
        checkpoint(cancellation, "parsing")?;
        match read {
            LeadingHeader::NeedsBytes(required)
                if required <= supplied as u64 && required > bytes.len() as u64 =>
            {
                // The file holds more than was read; read what the header asked for.
                wanted = usize::try_from(required).unwrap_or(usize::MAX);
            }
            read => return Ok(read),
        }
    }
}

fn header_failure(code: &'static str) -> Failure {
    Failure {
        code: code.to_owned(),
        message: format!("could not inspect package header ({code})"),
        retry_safe: matches!(code, "asset_io"),
        ..Default::default()
    }
}

/// A package's dependencies, or a header failure when there are more than one page can carry:
/// the index records them as unknown rather than keeping part of them.
fn within_dependency_limit<T>(dependencies: Vec<T>) -> Result<Vec<T>, Failure> {
    if dependencies.len() > PROJECT_INDEX_MAX_DEPENDENCIES {
        return Err(header_failure("dependencies_over_limit"));
    }
    Ok(dependencies)
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

    use super::{
        FilesystemProjectScanner, PROJECT_INDEX_MAX_DEPENDENCIES, ProjectScanner,
        bounded_header_values, within_dependency_limit,
    };

    #[test]
    fn a_package_over_the_dependency_limit_records_a_failure() {
        assert_eq!(
            within_dependency_limit(vec![(); PROJECT_INDEX_MAX_DEPENDENCIES])
                .ok()
                .map(|d| d.len()),
            Some(PROJECT_INDEX_MAX_DEPENDENCIES)
        );
        let failure = within_dependency_limit(vec![(); PROJECT_INDEX_MAX_DEPENDENCIES + 1])
            .expect_err("over the limit");
        assert_eq!(failure.code, "dependencies_over_limit");
    }
    use crate::cancellation::CancellationToken;
    use crate::direct_executor::catalog::{EntryKind, PackageSignature, PlainEvidence};

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

        let scanner = FilesystemProjectScanner::content();
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
        let scanner = FilesystemProjectScanner::content();
        for count in [1, 31, 129, 2051] {
            let signatures = (0..count)
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
                    &PlainEvidence,
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
        let error = FilesystemProjectScanner::content()
            .stream_header_evidence(
                "C:/Missing",
                &signatures,
                &CancellationToken::new(),
                &PlainEvidence,
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
