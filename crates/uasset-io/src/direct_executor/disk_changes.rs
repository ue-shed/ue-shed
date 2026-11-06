//! The `disk_changes` builder action: what on disk differs from a view's Game Text index.
//!
//! The walk is the Project Index's own (`scanner::enumerate_content`): the same `Content` root,
//! package and sidecar rules and directory-listing metadata, so a package's signature here is the
//! one the Catalog recorded and the package-text shards hold. Named paths are stated one by one.
//! Nothing is written: no Catalog, no index, no cache file.
use std::path::Path;
use std::time::Instant;

use game_text_index::builder::BuildOutcome;
use game_text_index::disk_changes::{
    DiskChangeCounts, DiskChangeItem, DiskChangesAnswer, DiskChangesRequest, DiskPackage, Observed,
    compare, named_packages, page,
};
use game_text_index::store::Configuration;
use game_text_index::{Error, ErrorCode, Result};

use super::Failure;
use super::catalog::{EntryKind, PackageSignature, bundle_signature};
use super::scanner::enumerate_content;
use crate::cancellation::CancellationToken;

/// Threads the walk uses at most, so a check stays light beside an editor or a scan.
const WALK_THREADS: usize = 8;
const SIDECARS: [&str; 3] = ["uexp", "ubulk", "uptnl"];

/// The session's last check: its differences, kept so later pages of it need no new check.
#[derive(Default)]
pub(crate) struct DiskChecks {
    last: Option<Checked>,
}

struct Checked {
    configuration: Configuration,
    request: DiskChangesRequest,
    counts: DiskChangeCounts,
    items: Vec<DiskChangeItem>,
}

/// A page of a disk check. A first page (no `after`) always checks again; a later page of the
/// same check reads the differences the first one kept.
pub(crate) fn check_disk(
    checks: &mut DiskChecks,
    configuration: &Configuration,
    request: &DiskChangesRequest,
    cancellation: &CancellationToken,
) -> Result<BuildOutcome> {
    request.validate()?;
    let started = Instant::now();
    let mut outcome = BuildOutcome::new("disk_changes");
    let kept = request.after.is_some()
        && checks.last.as_ref().is_some_and(|last| {
            last.configuration == *configuration && last.request.same_check(request)
        });
    if !kept {
        checks.last = None;
        let cancelled = || cancellation.is_cancelled();
        let (observed, compared) = match &request.paths {
            None => {
                let packages = walk(&request.project_root, cancellation)?;
                let walked = started.elapsed().as_secs_f64();
                let compared = compare(
                    configuration,
                    request,
                    Observed::Walk(&packages),
                    &cancelled,
                )?;
                (walked, compared)
            }
            Some(paths) => {
                let (packages, files) = named_packages(paths);
                let packages = packages
                    .into_iter()
                    .map(|path| {
                        let signature = stated(&request.project_root, &path)?;
                        Ok((path, signature))
                    })
                    .collect::<Result<Vec<_>>>()?;
                let stated = started.elapsed().as_secs_f64();
                let compared = compare(
                    configuration,
                    request,
                    Observed::Paths {
                        packages: &packages,
                        files: &files,
                    },
                    &cancelled,
                )?;
                (stated, compared)
            }
        };
        outcome
            .stage_seconds
            .insert("disk_changes.observe".into(), observed);
        let Some((counts, items)) = compared else {
            outcome.disk_changes = Some(Box::new(DiskChangesAnswer::NotIndexed));
            outcome
                .stage_seconds
                .insert("disk_changes".into(), started.elapsed().as_secs_f64());
            return Ok(outcome);
        };
        checks.last = Some(Checked {
            configuration: configuration.clone(),
            request: request.clone(),
            counts,
            items,
        });
    }
    let last = checks
        .last
        .as_ref()
        .ok_or_else(|| Error::new(ErrorCode::Internal, "The disk check kept no result."))?;
    outcome.disk_changes = Some(Box::new(page(
        last.counts,
        &last.items,
        request.after.as_deref(),
        request.limit,
    )));
    outcome
        .stage_seconds
        .insert("disk_changes".into(), started.elapsed().as_secs_f64());
    Ok(outcome)
}

/// Every package under `Content` with its bundle signature, from one Project Index walk: each
/// package is grouped with its sidecars from the same listing, as the Catalog groups them.
fn walk(project_root: &Path, cancellation: &CancellationToken) -> Result<Vec<DiskPackage>> {
    let listing = enumerate_content(&project_root.to_string_lossy(), cancellation, WALK_THREADS)
        .map_err(failure)?;
    Ok(packages(&listing))
}

/// The listing's packages with their signatures. `listing` is in path order.
fn packages(listing: &[PackageSignature]) -> Vec<DiskPackage> {
    let stamp = |path: &str| {
        listing
            .binary_search_by(|entry| entry.relative_path.as_str().cmp(path))
            .ok()
            .map(|row| (listing[row].size, listing[row].modified_nanos))
    };
    listing
        .iter()
        .filter(|entry| entry.kind == EntryKind::Package)
        .map(|entry| {
            let path = &entry.relative_path;
            let stem = path
                .rsplit_once('.')
                .map_or(path.as_str(), |(stem, _)| stem);
            let mut parts = [Some((entry.size, entry.modified_nanos)), None, None, None];
            for (part, extension) in parts[1..].iter_mut().zip(SIDECARS) {
                *part = stamp(&format!("{stem}.{extension}"));
            }
            DiskPackage {
                path: path.clone(),
                signature: bundle_signature(parts),
            }
        })
        .collect()
}

/// A named package's signature from its files' metadata, or `None` when it isn't on disk.
fn stated(project_root: &Path, path: &str) -> Result<Option<String>> {
    let file = project_root.join(path);
    match std::fs::metadata(&file) {
        Ok(metadata) if metadata.is_file() => super::project_io::bundle_signature(&file)
            .map(Some)
            .map_err(failure),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn failure(failure: Failure) -> Error {
    Error::new(
        if failure.code == "cancelled" {
            ErrorCode::Cancelled
        } else {
            ErrorCode::Io
        },
        failure.message,
    )
}

#[cfg(test)]
mod tests;
