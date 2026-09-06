//! Bounded parallel discovery; directory work is shared, signatures stay worker-local.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};

use super::{
    CancellationToken, EntryKind, Failure, PackageSignature, checkpoint, discovery_failure,
    is_package_path, is_sidecar_path, metadata_modified_nanos, project_relative_path,
};

const MAX_WORKERS: usize = 32;
const MAX_QUEUED_DIRECTORIES: usize = 1_024;

struct Work {
    pending: Vec<PathBuf>,
    active: usize,
    workers: usize,
    failure: Option<Failure>,
}

struct DirectoryQueue {
    work: Mutex<Work>,
    changed: Condvar,
    stopped: AtomicBool,
    capacity: usize,
    maximum_workers: usize,
}

impl DirectoryQueue {
    fn take(&self) -> Option<PathBuf> {
        let mut work = self.work.lock().expect("directory queue lock");
        loop {
            if work.failure.is_some() {
                return None;
            }
            if let Some(path) = work.pending.pop() {
                work.active += 1;
                return Some(path);
            }
            if work.active == 0 {
                return None;
            }
            work = self.changed.wait(work).expect("directory queue wait");
        }
    }

    /// Never wait for queue capacity: a full queue is traversed locally, avoiding producer deadlock.
    fn offer(&self, path: PathBuf) -> Result<bool, PathBuf> {
        let mut work = self.work.lock().expect("directory queue lock");
        if work.pending.len() == self.capacity {
            return Err(path);
        }
        work.pending.push(path);
        let spawn = work.failure.is_none()
            && work.workers < self.maximum_workers
            && work.pending.len() > work.workers - work.active;
        if spawn {
            work.workers += 1;
        }
        self.changed.notify_one();
        Ok(spawn)
    }

    fn finish(&self, result: Result<(), Failure>) {
        let mut work = self.work.lock().expect("directory queue lock");
        work.active -= 1;
        if let Err(error) = result
            && work.failure.is_none()
        {
            work.failure = Some(error);
            self.stopped.store(true, Ordering::Relaxed);
        }
        self.changed.notify_all();
    }
}

pub(super) fn enumerate(
    project_root: &str,
    cancellation: &CancellationToken,
) -> Result<Vec<PackageSignature>, Failure> {
    let workers = std::thread::available_parallelism()
        .map_or(4, std::num::NonZeroUsize::get)
        .min(MAX_WORKERS);
    enumerate_with_limits(project_root, cancellation, workers, MAX_QUEUED_DIRECTORIES)
}

fn enumerate_with_limits(
    project_root: &str,
    cancellation: &CancellationToken,
    workers: usize,
    queue_capacity: usize,
) -> Result<Vec<PackageSignature>, Failure> {
    checkpoint(cancellation, "discovery")?;
    let queue = DirectoryQueue {
        work: Mutex::new(Work {
            pending: vec![Path::new(project_root).join("Content")],
            active: 0,
            workers: 1,
            failure: None,
        }),
        changed: Condvar::new(),
        stopped: AtomicBool::new(false),
        capacity: queue_capacity,
        maximum_workers: workers,
    };
    let output = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        // Start on the caller. Additional workers are created only when queued directories
        // outnumber idle workers, so a tiny or flat tree pays no fixed pool startup cost.
        work_directories(scope, project_root, cancellation, &queue, &output);
    });
    if let Some(error) = queue
        .work
        .into_inner()
        .expect("directory queue lock")
        .failure
    {
        return Err(error);
    }
    checkpoint(cancellation, "discovery")?;
    let mut signatures = output.into_inner().expect("discovery output lock");
    signatures.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(signatures)
}

fn work_directories<'scope, 'env: 'scope>(
    scope: &'scope std::thread::Scope<'scope, 'env>,
    project_root: &'scope str,
    cancellation: &'scope CancellationToken,
    queue: &'scope DirectoryQueue,
    output: &'scope Mutex<Vec<PackageSignature>>,
) {
    let mut signatures = Vec::new();
    let spawn_worker = || {
        scope.spawn(move || work_directories(scope, project_root, cancellation, queue, output));
    };
    while let Some(directory) = queue.take() {
        queue.finish(visit_directory(
            &directory,
            project_root,
            cancellation,
            queue,
            &mut signatures,
            &spawn_worker,
        ));
    }
    output
        .lock()
        .expect("discovery output lock")
        .append(&mut signatures);
}

fn visit_directory(
    directory: &Path,
    project_root: &str,
    cancellation: &CancellationToken,
    queue: &DirectoryQueue,
    signatures: &mut Vec<PackageSignature>,
    spawn_worker: &impl Fn(),
) -> Result<(), Failure> {
    checkpoint(cancellation, "discovery")?;
    let entries = fs::read_dir(directory).map_err(|error| discovery_failure(directory, error))?;
    for entry in entries {
        checkpoint(cancellation, "discovery")?;
        if queue.stopped.load(Ordering::Relaxed) {
            return Ok(());
        }
        let entry = entry.map_err(|error| discovery_failure(directory, error))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|error| discovery_failure(&path, error))?;
        if kind.is_dir() {
            match queue.offer(path) {
                Ok(true) => spawn_worker(),
                Ok(false) => {}
                Err(path) => visit_directory(
                    &path,
                    project_root,
                    cancellation,
                    queue,
                    signatures,
                    spawn_worker,
                )?,
            }
        } else if kind.is_file() {
            let kind = if is_package_path(&path) {
                EntryKind::Package
            } else if is_sidecar_path(&path) {
                EntryKind::Sidecar
            } else {
                continue;
            };
            // Reuse enumeration metadata on Windows; do not reopen each file to stat it.
            let metadata = entry
                .metadata()
                .map_err(|error| discovery_failure(&path, error))?;
            signatures.push(PackageSignature {
                relative_path: project_relative_path(project_root, &path.to_string_lossy()),
                kind,
                size: metadata.len(),
                modified_nanos: metadata_modified_nanos(&metadata),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TemporaryProject(PathBuf);
    impl TemporaryProject {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("ue-shed-discovery-{unique}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TemporaryProject {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn parallel_discovery_matches_serial_with_a_saturated_queue() {
        let project = TemporaryProject::new();
        let content = project.0.join("Content");
        for i in 0..96 {
            let directory = content.join(format!("Tree/Branch{i}/Nested"));
            fs::create_dir_all(&directory).unwrap();
            for name in [
                "Asset.UASSET",
                "Map.umap",
                "Asset.uexp",
                "Asset.ubulk",
                "Asset.uptnl",
                "Ignore.txt",
            ] {
                fs::write(directory.join(name), [1, 2, 3]).unwrap();
            }
        }
        let root = project.0.to_string_lossy();
        let mut expected = Vec::new();
        super::super::visit_scan_files(&content, &CancellationToken::new(), &mut |entry, path| {
            let kind = if is_package_path(&path) {
                EntryKind::Package
            } else if is_sidecar_path(&path) {
                EntryKind::Sidecar
            } else {
                return Ok(());
            };
            let metadata = entry.metadata().unwrap();
            expected.push(PackageSignature {
                relative_path: project_relative_path(&root, &path.to_string_lossy()),
                kind,
                size: metadata.len(),
                modified_nanos: metadata_modified_nanos(&metadata),
            });
            Ok(())
        })
        .unwrap();
        expected.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        for workers in [1, 4, 32] {
            for capacity in [1, 4] {
                let actual =
                    enumerate_with_limits(&root, &CancellationToken::new(), workers, capacity)
                        .unwrap();
                assert_eq!(actual, expected);
                assert_eq!(actual.len(), 96 * 5);
            }
        }
    }

    #[test]
    fn discovery_failure_releases_waiting_workers_and_cancellation_is_typed() {
        let project = TemporaryProject::new();
        // A file where a directory is required must fail cleanly with multiple discovery workers.
        fs::write(project.0.join("Content"), [1]).unwrap();
        let error = enumerate_with_limits(
            &project.0.to_string_lossy(),
            &CancellationToken::new(),
            8,
            1,
        )
        .unwrap_err();
        assert_eq!(error.code, "discovery");
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let error =
            enumerate_with_limits(&project.0.to_string_lossy(), &cancelled, 8, 1).unwrap_err();
        assert_eq!(error.code, "cancelled");
    }

    #[cfg(unix)]
    #[test]
    fn discovery_does_not_follow_directory_symlinks() {
        let project = TemporaryProject::new();
        fs::create_dir(project.0.join("Content")).unwrap();
        fs::create_dir(project.0.join("Outside")).unwrap();
        fs::write(project.0.join("Outside/Ignore.uasset"), [1]).unwrap();
        std::os::unix::fs::symlink(project.0.join("Outside"), project.0.join("Content/Link"))
            .unwrap();
        assert!(
            enumerate(&project.0.to_string_lossy(), &CancellationToken::new())
                .unwrap()
                .is_empty()
        );
    }
}
