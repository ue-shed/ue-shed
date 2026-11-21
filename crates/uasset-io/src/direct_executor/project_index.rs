//! Project Index refresh coordinator.
//!
//! Owns one-traversal refresh, signature comparison, header rebuild policy, Generation publication,
//! and bounded queries. Storage details stay behind the Catalog seam; filesystem details stay behind
//! the ProjectScanner seam so coordinator tests can inject deterministic fixtures.

use std::borrow::Cow;

use crate::cancellation::CancellationToken;

use super::catalog::{
    Catalog, CatalogDiagnostic, CatalogError, CatalogSnapshotEntry, CatalogStatus, CommittedEntry,
    Completeness, EntryKind, EvidencePreparer, HeaderEvidence, INDEX_PROFILE_VERSION, IndexScope,
    MountPoint, PROJECT_INDEX_MAX_CLASSES, PROJECT_INDEX_MAX_DIAGNOSTICS, PROJECT_INDEX_MAX_NAMES,
    PackageSignature, QueryPage, QueryRequest, RefreshChanges, RefreshSummary, is_map_path,
    project_id_for,
};
use super::{Failure, checkpoint};

const MAX_SIGNATURE_REVALIDATION_ATTEMPTS: usize = 3;
const PROGRESS_PACKAGE_INTERVAL: u64 = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshPhase {
    Enumerating,
    Comparing,
    ReadingHeaders,
    Committing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefreshProgress {
    pub phase: RefreshPhase,
    pub completed_packages: u64,
    pub total_packages: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefreshEvent {
    Started {
        rebuild: bool,
    },
    Progress(RefreshProgress),
    Completed {
        summary: RefreshSummary,
        changes: RefreshChanges,
    },
}

/// Evidence and the signature observed immediately after reading it. Keep signature failures
/// separate: the coordinator propagates these, while header failures become partial evidence.
pub struct HeaderObservation<E = HeaderEvidence> {
    pub evidence: E,
    pub signature: Result<Option<PackageSignature>, CoordinatorError>,
}

impl HeaderObservation {
    /// The observation with its evidence prepared on the calling thread.
    pub fn prepare<P: EvidencePreparer>(
        self,
        preparer: &P,
        worker: &mut P::Worker,
    ) -> HeaderObservation<P::Prepared> {
        HeaderObservation {
            evidence: preparer.prepare(worker, self.evidence),
            signature: self.signature,
        }
    }
}

pub type HeaderEvidenceSink<'a, E> = dyn FnMut(
        &PackageSignature,
        Result<HeaderObservation<E>, CoordinatorError>,
    ) -> Result<(), CoordinatorError>
    + 'a;

/// Filesystem/header probing boundary used by the coordinator.
pub trait ProjectScanner {
    /// The content roots this scanner indexes; each scope is its own Catalog identity.
    fn scope(&self) -> IndexScope {
        IndexScope::Content
    }

    /// Where Unreal mounts the content roots this scanner enumerates, `/Game/` first.
    fn mount_points(&self) -> Vec<MountPoint> {
        vec![MountPoint::game()]
    }

    fn enumerate(
        &self,
        project_root: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<PackageSignature>, CoordinatorError>;

    fn read_header_evidence(
        &self,
        project_root: &str,
        signature: &PackageSignature,
        cancellation: &CancellationToken,
    ) -> Result<HeaderEvidence, CoordinatorError>;

    /// Stream headers with their post-read signatures in signature order, each prepared by
    /// `preparer` on the thread that read it. Each thread uses one preparer worker, and a worker's
    /// prepared values are delivered in the order it prepared them. The default preserves
    /// deterministic test scanners; filesystem adapters may read ahead with bounded parallelism.
    fn stream_header_evidence<P: EvidencePreparer>(
        &self,
        project_root: &str,
        signatures: &[PackageSignature],
        cancellation: &CancellationToken,
        preparer: &P,
        on_header: &mut HeaderEvidenceSink<'_, P::Prepared>,
    ) -> Result<(), CoordinatorError> {
        let mut worker = preparer.worker();
        for signature in signatures {
            on_header(
                signature,
                observe_header(self, project_root, signature, cancellation)
                    .map(|observation| observation.prepare(preparer, &mut worker)),
            )?;
        }
        Ok(())
    }

    fn reread_signature(
        &self,
        project_root: &str,
        relative_path: &str,
        kind: EntryKind,
        cancellation: &CancellationToken,
    ) -> Result<Option<PackageSignature>, CoordinatorError>;

    /// A package's evidence and the signature observed right after reading it. The default reads
    /// the evidence and then rereads the signature; a filesystem adapter may take both from one
    /// open file.
    fn read_header_observation(
        &self,
        project_root: &str,
        signature: &PackageSignature,
        cancellation: &CancellationToken,
    ) -> Result<HeaderObservation, CoordinatorError> {
        let evidence = self.read_header_evidence(project_root, signature, cancellation)?;
        checkpoint(cancellation, "read")?;
        let signature = self.reread_signature(
            project_root,
            &signature.relative_path,
            signature.kind,
            cancellation,
        );
        Ok(HeaderObservation {
            evidence,
            signature,
        })
    }
}

pub(crate) fn observe_header<S: ProjectScanner + ?Sized>(
    scanner: &S,
    project_root: &str,
    signature: &PackageSignature,
    cancellation: &CancellationToken,
) -> Result<HeaderObservation, CoordinatorError> {
    scanner.read_header_observation(project_root, signature, cancellation)
}

/// Snapshot helper used by the coordinator to compute deletions without exposing SQL.
pub trait CatalogSnapshot: Catalog {
    fn committed_entries(&self) -> Result<Vec<CatalogSnapshotEntry>, CatalogError>;

    /// Calls `visit` with each committed entry in path order; an entry's position in this order
    /// is the index `Catalog::observe_unchanged_committed` receives. Adapters may decode entries
    /// as they visit them, so the committed inventory is never held whole; the default copies
    /// `committed_entries`.
    fn visit_committed_entries(
        &self,
        visit: &mut dyn FnMut(CommittedEntry<'_>) -> Result<(), CoordinatorError>,
    ) -> Result<(), CoordinatorError> {
        let mut entries = self.committed_entries()?;
        if !entries.is_sorted_by(|a, b| a.signature.relative_path <= b.signature.relative_path) {
            entries.sort_by(|a, b| a.signature.relative_path.cmp(&b.signature.relative_path));
        }
        for entry in &entries {
            visit(CommittedEntry {
                relative_path: &entry.signature.relative_path,
                kind: entry.signature.kind,
                size: entry.signature.size,
                modified_nanos: entry.signature.modified_nanos,
                header_profile_version: entry.header_profile_version,
                header_failure: entry.header_failure,
            })?;
        }
        Ok(())
    }

    #[allow(dead_code)]
    fn committed_relative_paths(&self) -> Result<Vec<String>, CatalogError> {
        Ok(self
            .committed_entries()?
            .into_iter()
            .map(|entry| entry.signature.relative_path)
            .collect())
    }
}

#[derive(Debug)]
pub enum CoordinatorError {
    Catalog(CatalogError),
    Cancelled { message: String },
    Unavailable { message: String },
    InvalidRequest { message: String },
}

impl From<CatalogError> for CoordinatorError {
    fn from(value: CatalogError) -> Self {
        Self::Catalog(value)
    }
}

impl From<Failure> for CoordinatorError {
    fn from(value: Failure) -> Self {
        if value.code == "cancelled" {
            Self::Cancelled {
                message: value.message,
            }
        } else if value.code == "invalid_request" {
            Self::InvalidRequest {
                message: value.message,
            }
        } else {
            Self::Unavailable {
                message: value.message,
            }
        }
    }
}

impl std::fmt::Display for CoordinatorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Catalog(error) => write!(formatter, "{error}"),
            Self::Cancelled { message }
            | Self::Unavailable { message }
            | Self::InvalidRequest { message } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CoordinatorError {}

pub fn status<C: Catalog>(catalog: &C) -> CatalogStatus {
    catalog.status()
}

pub fn query<C: Catalog>(
    catalog: &C,
    request: &QueryRequest,
) -> Result<QueryPage, CoordinatorError> {
    Ok(catalog.query(request)?)
}

/// A refresh that lists at most `PROJECT_INDEX_MAX_REPORTED_CHANGES` changed and removed paths,
/// as the Catalog conformance suite runs it.
#[cfg(test)]
pub fn refresh<C: CatalogSnapshot, S: ProjectScanner>(
    catalog: &mut C,
    scanner: &S,
    project_root: &str,
    cancellation: &CancellationToken,
    on_progress: impl FnMut(RefreshProgress),
) -> Result<Vec<RefreshEvent>, CoordinatorError> {
    refresh_listing_changes(
        catalog,
        scanner,
        project_root,
        super::catalog::PROJECT_INDEX_MAX_REPORTED_CHANGES,
        cancellation,
        on_progress,
    )
}

/// A refresh that lists at most `maximum_changes` changed and removed paths. Past it the change
/// report is incomplete: both lists are empty and `total` counts the changes.
pub fn refresh_listing_changes<C: CatalogSnapshot, S: ProjectScanner>(
    catalog: &mut C,
    scanner: &S,
    project_root: &str,
    maximum_changes: usize,
    cancellation: &CancellationToken,
    mut on_progress: impl FnMut(RefreshProgress),
) -> Result<Vec<RefreshEvent>, CoordinatorError> {
    run_refresh(
        catalog,
        scanner,
        project_root,
        false,
        maximum_changes,
        cancellation,
        &mut on_progress,
    )
}

/// A rebuild that lists at most `PROJECT_INDEX_MAX_REPORTED_CHANGES` changed and removed paths,
/// as the Catalog conformance suite runs it.
#[cfg(test)]
pub fn rebuild<C: CatalogSnapshot, S: ProjectScanner>(
    catalog: &mut C,
    scanner: &S,
    project_root: &str,
    cancellation: &CancellationToken,
    on_progress: impl FnMut(RefreshProgress),
) -> Result<Vec<RefreshEvent>, CoordinatorError> {
    rebuild_listing_changes(
        catalog,
        scanner,
        project_root,
        super::catalog::PROJECT_INDEX_MAX_REPORTED_CHANGES,
        cancellation,
        on_progress,
    )
}

/// A rebuild that lists at most `maximum_changes` changed and removed paths, as
/// `refresh_listing_changes` does.
pub fn rebuild_listing_changes<C: CatalogSnapshot, S: ProjectScanner>(
    catalog: &mut C,
    scanner: &S,
    project_root: &str,
    maximum_changes: usize,
    cancellation: &CancellationToken,
    mut on_progress: impl FnMut(RefreshProgress),
) -> Result<Vec<RefreshEvent>, CoordinatorError> {
    catalog.clear_for_rebuild()?;
    run_refresh(
        catalog,
        scanner,
        project_root,
        true,
        maximum_changes,
        cancellation,
        &mut on_progress,
    )
}

fn run_refresh<C: CatalogSnapshot, S: ProjectScanner>(
    catalog: &mut C,
    scanner: &S,
    project_root: &str,
    rebuild: bool,
    maximum_changes: usize,
    cancellation: &CancellationToken,
    on_progress: &mut impl FnMut(RefreshProgress),
) -> Result<Vec<RefreshEvent>, CoordinatorError> {
    let project_id = project_id_for(project_root, scanner.scope());
    let mut events = vec![RefreshEvent::Started { rebuild }];
    let base_generation = catalog.committed_generation();
    let mut token = Some(catalog.begin_refresh()?);
    let result = (|| {
        checkpoint(cancellation, "discovery")?;
        let mut enumerated = scanner.enumerate(project_root, cancellation)?;
        // Scanners list in path order already; sort only when one did not.
        if !enumerated.is_sorted_by(|a, b| a.relative_path <= b.relative_path) {
            enumerated.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        }
        let total_packages = enumerated
            .iter()
            .filter(|entry| entry.kind == EntryKind::Package)
            .count() as u64;
        emit_progress(
            &mut events,
            on_progress,
            RefreshPhase::Enumerating,
            0,
            Some(total_packages),
        );

        let mut diagnostics = RefreshDiagnostics::default();
        let mut changes = ChangeReport::new(base_generation, maximum_changes);

        emit_progress(
            &mut events,
            on_progress,
            RefreshPhase::Comparing,
            0,
            Some(total_packages),
        );
        // Compare against the committed entries as the Catalog visits them: nothing committed is
        // copied or held whole.
        let comparison = compare(
            catalog,
            &enumerated,
            total_packages,
            &mut changes,
            cancellation,
            &mut |completed| {
                emit_progress(
                    &mut events,
                    on_progress,
                    RefreshPhase::Comparing,
                    completed,
                    Some(total_packages),
                );
            },
        )?;
        #[expect(
            clippy::expect_used,
            reason = "the token is set above and taken only at commit, after this borrow ends"
        )]
        let staging = token
            .as_ref()
            .expect("staging token present for refresh body");
        for (signature, reuse) in enumerated.iter().zip(&comparison.reuse) {
            if let Some(committed_index) = reuse {
                catalog.observe_unchanged_committed(
                    staging,
                    &signature.relative_path,
                    *committed_index as usize,
                )?;
            }
        }

        emit_progress(
            &mut events,
            on_progress,
            RefreshPhase::ReadingHeaders,
            0,
            Some(comparison.changed_packages),
        );
        let mut changed_package_entries = Vec::with_capacity(comparison.changed_packages as usize);
        let mut changed_sidecars = Vec::new();
        for (signature, reuse) in enumerated.into_iter().zip(comparison.reuse) {
            if reuse.is_some() {
                continue;
            }
            if signature.kind == EntryKind::Sidecar {
                changed_sidecars.push(signature);
            } else {
                changed_package_entries.push(signature);
            }
        }
        // Header workers prepare evidence for this Catalog as they read it; the coordinator only
        // stages it. Each staged entry follows the previous one in path order, so changed
        // sidecars are staged between the packages around them.
        let preparer = catalog.evidence_preparer(staging)?;
        let preparer = Normalizing(&preparer);
        let mut coordinator_worker = preparer.worker();
        catalog.stage_in_path_order(staging)?;
        let mut sidecars = changed_sidecars.into_iter().peekable();
        let changed_packages = comparison.changed_packages;
        let mut completed_headers = 0_u64;
        scanner.stream_header_evidence(
            project_root,
            &changed_package_entries,
            cancellation,
            &preparer,
            &mut |signature, header_result| {
                checkpoint(cancellation, "inspection")?;
                while let Some(sidecar) =
                    sidecars.next_if(|sidecar| sidecar.relative_path < signature.relative_path)
                {
                    catalog.stage_prepared(staging, &sidecar, None)?;
                }
                let (staged, header) = stage_with_initial_header(
                    scanner,
                    project_root,
                    signature,
                    header_result,
                    &preparer,
                    &mut coordinator_worker,
                    &mut |released| Ok(catalog.release_prepared(staging, released)?),
                    cancellation,
                    &mut diagnostics,
                )?;
                completed_headers += 1;
                if should_emit_package_progress(completed_headers, changed_packages) {
                    emit_progress(
                        &mut events,
                        on_progress,
                        RefreshPhase::ReadingHeaders,
                        completed_headers,
                        Some(changed_packages),
                    );
                }
                catalog.stage_prepared(staging, &staged, Some(header))?;
                Ok(())
            },
        )?;
        for sidecar in sidecars {
            catalog.stage_prepared(staging, &sidecar, None)?;
        }
        drop(changed_package_entries);

        emit_progress(
            &mut events,
            on_progress,
            RefreshPhase::Committing,
            total_packages,
            Some(total_packages),
        );
        let summary = RefreshSummary {
            project_id,
            generation: staging.generation,
            package_count: comparison.package_count,
            map_count: comparison.map_count,
            changed_packages,
            removed_packages: comparison.removed_packages,
            completeness: if diagnostics.kept.is_empty() {
                Completeness::Complete
            } else {
                Completeness::Partial
            },
            diagnostics: diagnostics.kept,
            omitted_diagnostics: diagnostics.omitted,
            mounts: scanner.mount_points(),
        };
        #[expect(
            clippy::expect_used,
            reason = "the token is set before the refresh body and taken only here or on failure"
        )]
        let staging = token.take().expect("staging token present for commit");
        catalog.commit_refresh(staging, summary.clone())?;
        events.push(RefreshEvent::Completed {
            summary,
            changes: changes.finish(),
        });
        Ok(events)
    })();

    match result {
        Ok(events) => Ok(events),
        Err(error) => {
            if let Some(staging) = token.take() {
                let _ = catalog.discard_refresh(staging);
            }
            Err(error)
        }
    }
}

/// One enumeration compared with the committed entries.
struct Comparison {
    /// For each enumerated entry, the committed entry it reuses unchanged, else `None`.
    reuse: Vec<Option<u32>>,
    package_count: u64,
    map_count: u64,
    changed_packages: u64,
    removed_packages: u64,
}

/// Merges the enumeration with the committed entries (both in path order) as the Catalog visits
/// them: which entries reuse their committed evidence, what changed, and what was removed.
fn compare<C: CatalogSnapshot>(
    catalog: &C,
    enumerated: &[PackageSignature],
    total_packages: u64,
    changes: &mut ChangeReport,
    cancellation: &CancellationToken,
    on_progress: &mut dyn FnMut(u64),
) -> Result<Comparison, CoordinatorError> {
    let mut comparison = Comparison {
        reuse: Vec::with_capacity(enumerated.len()),
        package_count: 0,
        map_count: 0,
        changed_packages: 0,
        removed_packages: 0,
    };
    let mut completed_packages = 0_u64;
    // Records one enumerated entry against the committed entry at its path, if there is one.
    let mut observe = |comparison: &mut Comparison,
                       changes: &mut ChangeReport,
                       signature: &PackageSignature,
                       prior: Option<(u32, &CommittedEntry<'_>)>|
     -> Result<(), CoordinatorError> {
        checkpoint(cancellation, "read")?;
        if signature.kind == EntryKind::Package {
            completed_packages += 1;
        }
        // A changed file differs on disk; a reused profile or a failed read is re-read
        // without counting as a change.
        if prior.is_none_or(|(_, prior)| !prior.has_signature(signature)) {
            changes.changed(&signature.relative_path);
        }
        let reuse = prior
            .filter(|(_, prior)| {
                prior.has_signature(signature)
                    && (signature.kind == EntryKind::Sidecar
                        || (prior.header_profile_version == Some(INDEX_PROFILE_VERSION)
                            && !prior.header_failure))
            })
            .map(|(index, _)| index);
        if reuse.is_none() && signature.kind == EntryKind::Package {
            comparison.changed_packages += 1;
        }
        comparison.reuse.push(reuse);
        if signature.kind == EntryKind::Package {
            comparison.package_count += 1;
            if is_map_path(&signature.relative_path) {
                comparison.map_count += 1;
            }
        }
        if should_emit_package_progress(completed_packages, total_packages) {
            on_progress(completed_packages);
        }
        Ok(())
    };
    let mut next = 0;
    let mut index = 0_u32;
    catalog.visit_committed_entries(&mut |prior| {
        while let Some(signature) = enumerated
            .get(next)
            .filter(|signature| signature.relative_path.as_str() < prior.relative_path)
        {
            observe(&mut comparison, changes, signature, None)?;
            next += 1;
        }
        let mut present = false;
        while let Some(signature) = enumerated
            .get(next)
            .filter(|signature| signature.relative_path == prior.relative_path)
        {
            observe(&mut comparison, changes, signature, Some((index, &prior)))?;
            present = true;
            next += 1;
        }
        if !present {
            changes.removed(prior.relative_path);
            if prior.kind == EntryKind::Package {
                comparison.removed_packages += 1;
            }
        }
        index = index
            .checked_add(1)
            .ok_or_else(|| CoordinatorError::Unavailable {
                message: "the committed Project Index has more than u32::MAX entries".to_owned(),
            })?;
        Ok(())
    })?;
    for signature in &enumerated[next..] {
        observe(&mut comparison, changes, signature, None)?;
    }
    Ok(comparison)
}

/// Evidence as every Project Index consumer reads it: the current profile, and at most the
/// profile's classes and names. Header workers apply it before preparing evidence.
fn normalize(evidence: &mut HeaderEvidence) {
    evidence.profile_version = INDEX_PROFILE_VERSION;
    evidence.classes.truncate(PROJECT_INDEX_MAX_CLASSES);
    evidence.serialized_names.truncate(PROJECT_INDEX_MAX_NAMES);
}

/// A Catalog's preparer behind [`normalize`].
struct Normalizing<'a, P>(&'a P);

impl<P: EvidencePreparer> EvidencePreparer for Normalizing<'_, P> {
    type Worker = P::Worker;
    type Prepared = P::Prepared;

    fn worker(&self) -> P::Worker {
        self.0.worker()
    }

    fn prepare(&self, worker: &mut P::Worker, mut evidence: HeaderEvidence) -> P::Prepared {
        normalize(&mut evidence);
        self.0.prepare(worker, evidence)
    }
}

/// The signature and prepared evidence to stage for one package: its first observation, or a
/// reread when the package changed while it was read. Observations a reread replaces go to
/// `release`, so their preparer worker's order is kept.
#[expect(
    clippy::too_many_arguments,
    reason = "one package's revalidation needs the scanner, preparer and diagnostics together"
)]
fn stage_with_initial_header<'s, S: ProjectScanner, P: EvidencePreparer>(
    scanner: &S,
    project_root: &str,
    signature: &'s PackageSignature,
    first: Result<HeaderObservation<P::Prepared>, CoordinatorError>,
    preparer: &P,
    worker: &mut P::Worker,
    release: &mut dyn FnMut(P::Prepared) -> Result<(), CoordinatorError>,
    cancellation: &CancellationToken,
    diagnostics: &mut RefreshDiagnostics,
) -> Result<(Cow<'s, PackageSignature>, P::Prepared), CoordinatorError> {
    let mut current = Cow::Borrowed(signature);
    let mut next_header = Some(first);
    for _ in 0..MAX_SIGNATURE_REVALIDATION_ATTEMPTS {
        checkpoint(cancellation, "inspection")?;
        let result = next_header.take().unwrap_or_else(|| {
            observe_header(scanner, project_root, &current, cancellation)
                .map(|observation| observation.prepare(preparer, worker))
        });
        let (header, revalidated) = match result {
            Ok(HeaderObservation {
                evidence,
                signature,
            }) => (evidence, signature),
            Err(CoordinatorError::Cancelled { message }) => {
                return Err(CoordinatorError::Cancelled { message });
            }
            Err(_) => {
                push_diagnostic(
                    diagnostics,
                    "header_read",
                    format!(
                        "could not read header evidence for {}",
                        current.relative_path
                    ),
                    true,
                );
                let failure = HeaderEvidence {
                    header_data: None,
                    profile_version: INDEX_PROFILE_VERSION,
                    package_name: String::new(),
                    classes: Vec::new(),
                    serialized_names: Vec::new(),
                    dependencies: Vec::new(),
                    failure_code: Some("header_read".to_owned()),
                };
                return Ok((current, preparer.prepare(worker, failure)));
            }
        };
        checkpoint(cancellation, "read")?;
        match revalidated? {
            Some(next) if next == *current => return Ok((current, header)),
            Some(next) => {
                release(header)?;
                current = Cow::Owned(next);
            }
            None => {
                push_diagnostic(
                    diagnostics,
                    "signature_missing",
                    format!(
                        "package disappeared during header read: {}",
                        current.relative_path
                    ),
                    true,
                );
                return Err(CoordinatorError::Unavailable {
                    message: format!(
                        "package disappeared during header read: {}",
                        signature.relative_path
                    ),
                });
            }
        }
    }
    push_diagnostic(
        diagnostics,
        "signature_unstable",
        format!(
            "package signature kept changing during header read: {}",
            signature.relative_path
        ),
        true,
    );
    Err(CoordinatorError::Unavailable {
        message: format!(
            "package signature kept changing during header read: {}",
            signature.relative_path
        ),
    })
}

/// Changed and removed paths, bounded by the refresh's change limit so a first build of a large
/// project does not hold every path twice. Every change is counted, listed or not.
struct ChangeReport {
    changes: RefreshChanges,
    maximum: usize,
}

impl ChangeReport {
    fn new(base_generation: Option<super::catalog::Generation>, maximum: usize) -> Self {
        Self {
            changes: RefreshChanges {
                base_generation,
                complete: true,
                ..RefreshChanges::default()
            },
            maximum,
        }
    }

    fn changed(&mut self, path: &str) {
        self.changes.total += 1;
        if self.has_room() {
            self.changes.changed.push(path.to_owned());
        }
    }

    fn removed(&mut self, path: &str) {
        self.changes.total += 1;
        if self.has_room() {
            self.changes.removed.push(path.to_owned());
        }
    }

    fn has_room(&mut self) -> bool {
        if self.changes.changed.len() + self.changes.removed.len() >= self.maximum {
            self.changes.complete = false;
        }
        self.changes.complete
    }

    fn finish(mut self) -> RefreshChanges {
        if !self.changes.complete {
            self.changes.changed.clear();
            self.changes.removed.clear();
        }
        self.changes
    }
}

/// The first `PROJECT_INDEX_MAX_DIAGNOSTICS` diagnostics a refresh records, and how many more.
#[derive(Debug, Default)]
struct RefreshDiagnostics {
    kept: Vec<CatalogDiagnostic>,
    omitted: u64,
}

fn push_diagnostic(
    diagnostics: &mut RefreshDiagnostics,
    code: &str,
    message: String,
    retry_safe: bool,
) {
    if diagnostics.kept.len() >= PROJECT_INDEX_MAX_DIAGNOSTICS {
        diagnostics.omitted += 1;
        return;
    }
    diagnostics.kept.push(CatalogDiagnostic {
        code: code.to_owned(),
        message,
        retry_safe,
    });
}

fn emit_progress(
    events: &mut Vec<RefreshEvent>,
    on_progress: &mut impl FnMut(RefreshProgress),
    phase: RefreshPhase,
    completed_packages: u64,
    total_packages: Option<u64>,
) {
    let progress = RefreshProgress {
        phase,
        completed_packages,
        total_packages,
    };
    on_progress(progress.clone());
    events.push(RefreshEvent::Progress(progress));
}

fn should_emit_package_progress(completed: u64, total: u64) -> bool {
    completed > 0 && (completed == total || completed.is_multiple_of(PROGRESS_PACKAGE_INTERVAL))
}

/// The coordinator is proven through the adapter-neutral Catalog conformance suite. Every storage
/// adapter runs the same suite unchanged, so coordinator tests never name a storage implementation.
#[cfg(test)]
mod tests {
    use super::{PROGRESS_PACKAGE_INTERVAL, should_emit_package_progress};
    use crate::direct_executor::catalog_conformance::catalog_conformance_tests;
    use crate::direct_executor::catalog_memory::MemoryCatalog;

    catalog_conformance_tests!(memory_adapter, MemoryCatalog::new);

    #[test]
    fn worker_signature_error_is_propagated_without_publishing_partial_evidence() {
        use super::*;
        use crate::direct_executor::catalog::PlainEvidence;
        use crate::direct_executor::catalog_conformance::FakeScanner;

        let signature = PackageSignature {
            relative_path: "Content/A.uasset".to_owned(),
            kind: EntryKind::Package,
            size: 1,
            modified_nanos: 1,
        };
        let first = Ok(HeaderObservation {
            evidence: HeaderEvidence {
                header_data: None,
                profile_version: INDEX_PROFILE_VERSION,
                package_name: "/Game/A".to_owned(),
                classes: Vec::new(),
                serialized_names: Vec::new(),
                dependencies: Vec::new(),
                failure_code: None,
            },
            signature: Err(CoordinatorError::Unavailable {
                message: "signature read failed".to_owned(),
            }),
        });
        let scanner = FakeScanner::default();
        let mut diagnostics = RefreshDiagnostics::default();
        let error = stage_with_initial_header(
            &scanner,
            "C:/Fixture",
            &signature,
            first,
            &PlainEvidence,
            &mut (),
            &mut |_| Ok(()),
            &CancellationToken::new(),
            &mut diagnostics,
        )
        .expect_err("signature errors must abort refresh");
        assert_eq!(error.to_string(), "signature read failed");
        assert!(diagnostics.kept.is_empty());
        assert_eq!(diagnostics.omitted, 0);
        assert_eq!(scanner.header_reads.get(), 0);
    }

    #[test]
    fn package_progress_is_bounded_by_fixed_intervals() {
        assert!(!should_emit_package_progress(0, 10_000));
        assert!(!should_emit_package_progress(1, 10_000));
        assert!(should_emit_package_progress(
            PROGRESS_PACKAGE_INTERVAL,
            10_000
        ));
        assert!(should_emit_package_progress(10_000, 10_000));
    }
}
