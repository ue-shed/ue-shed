//! What on disk differs from what a view's index holds: saved packages by path and bundle
//! signature, and with a target, its localization inputs and review file by size and time.
//!
//! Read-only: the store is opened from its committed root without a writer lease, and nothing is
//! written. The reader observes the disk (its Project Index walk or the paths a host names) and
//! hands the packages here; localization files are stated here, since they need no walk.
use crate::engine_types::invalid;
use crate::join_policy::characters;
use crate::package_text_plan::{SHARDS, shard};
use crate::snapshot::Reader;
use crate::store::{Configuration, dictionary_selected_strings, open_root};
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
#[cfg(test)]
use ts_rs::TS;

pub use crate::engine_changes::{Change, ChangeCounts};

/// The most changes one page lists.
pub const MAX_DISK_CHANGES_PAGE: u32 = 1000;
/// The most paths one `paths` request names.
pub const MAX_DISK_CHANGE_PATHS: usize = 4096;
/// Shards whose strings are read from the dictionary at once: one pass over its segments each.
const SHARD_BATCH: usize = 32;

/// A `disk_changes` request: what on disk differs from what the configuration's view indexed.
///
/// Without `paths`, the reader walks the project's `Content` as the Project Index does. With
/// `paths` (project-relative), it checks only those packages and files: a sidecar checks its
/// package, and a target's localization input is checked when named. With `target`, the view's
/// joined target must be that target, and its localization inputs and review file are checked
/// too. A page lists at most `limit` items after the cursor `after`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskChangesRequest {
    #[cfg_attr(test, ts(type = "string"))]
    pub project_root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub paths: Option<Vec<String>>,
    /// The last path of the previous page; absent for the first.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "exact_option"
    )]
    #[cfg_attr(test, ts(optional, type = "string"))]
    pub after: Option<String>,
    /// Items one page lists, from 1 to 1000.
    pub limit: u32,
}

impl DiskChangesRequest {
    pub fn validate(&self) -> Result<()> {
        require(
            !self.project_root.as_os_str().is_empty(),
            invalid("A project root is required."),
        )?;
        require(
            (1..=MAX_DISK_CHANGES_PAGE).contains(&self.limit),
            invalid("A page lists between 1 and 1000 changes."),
        )?;
        if let Some(target) = &self.target {
            require(
                !target.is_empty() && characters(target) <= 1024,
                invalid("Invalid localization target."),
            )?;
        }
        if let Some(paths) = &self.paths {
            require(
                paths.len() <= MAX_DISK_CHANGE_PATHS,
                invalid("A disk check names at most 4096 paths."),
            )?;
            for path in paths {
                require(relative(path), invalid("A path must be project-relative."))?;
            }
        }
        if let Some(after) = &self.after {
            require(
                !after.is_empty() && characters(after) <= 32767,
                invalid("Invalid disk change cursor."),
            )?;
        }
        Ok(())
    }

    /// Whether `other` asks the same question, whatever its page.
    pub fn same_check(&self, other: &Self) -> bool {
        self.project_root == other.project_root
            && self.target == other.target
            && self.paths == other.paths
    }
}

/// A non-empty, project-relative path with no `..` part.
fn relative(path: &str) -> bool {
    let normal = path.replace('\\', "/");
    !normal.is_empty()
        && characters(&normal) <= 1024
        && !normal.starts_with('/')
        && !normal.contains(':')
        && normal.split('/').all(|part| part != "..")
}

/// What a changed item is.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum DiskChangeKind {
    /// A saved package, with its sidecars.
    Package,
    /// One of the target's localization inputs, or its review file.
    Localization,
}

/// One path whose disk state differs from the index.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct DiskChangeItem {
    pub kind: DiskChangeKind,
    pub change: Change,
    /// The project-relative path, `/`-separated: a package's as the Project Index lists it. It is
    /// the file's own name, as `changedSince` names a changed package.
    // In Rust, the dictionary's scalar view; `exact` writes the name it stands for.
    #[serde(with = "exact")]
    #[cfg_attr(test, ts(type = "string"))]
    pub path: String,
}

/// A path's scalar view in Rust and its exact text on the wire, the text `view_json` writes for
/// the engine's answers. Paths are filesystem names, so their text is UTF-8; a view that is not
/// (a lone surrogate) is sent as the view.
mod exact {
    use crate::wtf8::Wtf8Buf;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(view: &str, serializer: S) -> Result<S::Ok, S::Error> {
        let text = Wtf8Buf::from_view(view);
        serializer.serialize_str(text.to_utf8().unwrap_or(view))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
        Ok(Wtf8Buf::from_utf8(&String::deserialize(deserializer)?).into_view())
    }
}

/// `exact` for an optional path.
mod exact_option {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        view: &Option<String>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match view {
            Some(view) => super::exact::serialize(view, serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<String>, D::Error> {
        Ok(Option::<String>::deserialize(deserializer)?
            .map(|text| crate::wtf8::Wtf8Buf::from_utf8(&text).into_view()))
    }
}

/// A view's WTF-8 bytes: the engine's path order, which `changed_since` lists IDs in too.
fn wtf8(view: &str) -> Vec<u8> {
    Wtf8Buf::from_view(view).into_bytes()
}

/// Every difference the request covers, not only the page's.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct DiskChangeCounts {
    pub packages: ChangeCounts,
    pub localization: ChangeCounts,
}

/// A `disk_changes` answer. `items` lists differences in path order (the paths' WTF-8 bytes), so
/// the cursor of the next page is the last path listed.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DiskChangesAnswer {
    /// The view has no index yet: nothing to compare with.
    NotIndexed,
    Ready {
        counts: DiskChangeCounts,
        items: Vec<DiskChangeItem>,
        /// The cursor of the next page; absent on the last.
        #[serde(
            rename = "nextCursor",
            default,
            skip_serializing_if = "Option::is_none",
            with = "exact_option"
        )]
        #[cfg_attr(test, ts(optional, rename = "nextCursor", type = "string"))]
        next_cursor: Option<String>,
    },
}

/// A target's review file as a join read it: its path, and its size and modification time
/// (`FileProvenance` spelling) when it existed.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "JoinedReviewFile"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFile {
    pub relative_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub modified_time: Option<String>,
}

/// One saved package on disk: its project-relative path (the file's own name, not a view) and
/// bundle signature, as the Catalog signs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiskPackage {
    pub path: String,
    pub signature: String,
}

/// What the reader saw on disk.
pub enum Observed<'a> {
    /// Every package of the walk, in path order.
    Walk(&'a [DiskPackage]),
    /// The packages a host named, each with its signature, or none when it isn't on disk; and
    /// the other files it named, which are checked when they are the target's inputs.
    Paths {
        packages: &'a [(String, Option<String>)],
        files: &'a BTreeSet<String>,
    },
}

/// The packages a request's `paths` name: each package itself, and for a sidecar, the packages
/// it can belong to. Other paths are returned as files. Only `Content` is walked by the Project
/// Index, so a package elsewhere is neither.
pub fn named_packages(paths: &[String]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut packages = BTreeSet::new();
    let mut files = BTreeSet::new();
    for path in paths {
        let path = path.replace('\\', "/");
        let split = path
            .rsplit_once('.')
            .filter(|(stem, _)| !stem.is_empty() && !stem.ends_with('/'))
            .map(|(stem, extension)| (stem.to_owned(), extension.to_ascii_lowercase()));
        match split {
            Some((stem, extension))
                if path.starts_with("Content/")
                    && matches!(extension.as_str(), "uexp" | "ubulk" | "uptnl") =>
            {
                packages.insert(format!("{stem}.uasset"));
                packages.insert(format!("{stem}.umap"));
            }
            Some((_, extension))
                if path.starts_with("Content/")
                    && matches!(extension.as_str(), "uasset" | "umap") =>
            {
                packages.insert(path);
            }
            _ => {
                files.insert(path);
            }
        }
    }
    (packages, files)
}

/// A difference found, before paging.
type Found = (DiskChangeKind, Change, String);

/// Every difference between the view's index and what was observed, in path order with counts;
/// `None` when the view has no index yet. `cancelled` is polled between shards.
pub fn compare(
    configuration: &Configuration,
    request: &DiskChangesRequest,
    observed: Observed<'_>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Option<(DiskChangeCounts, Vec<DiskChangeItem>)>> {
    // A writer publishing meanwhile may remove a root this check opened; retry it whole.
    for attempt in 0..3 {
        match compare_once(configuration, request, &observed, cancelled) {
            Err(error)
                if matches!(error.code, ErrorCode::Io | ErrorCode::NotFound) && attempt < 2 => {}
            other => return other,
        }
    }
    Err(Error::new(
        ErrorCode::Unavailable,
        "Could not pin the Game Text snapshot.",
    ))
}

fn compare_once(
    configuration: &Configuration,
    request: &DiskChangesRequest,
    observed: &Observed<'_>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Option<(DiskChangeCounts, Vec<DiskChangeItem>)>> {
    let directory = configuration.directory()?;
    if !directory.join("manifest.json").is_file() {
        return Ok(None);
    }
    let (_, root) = open_root(configuration)?;
    let joined = match &configuration.view_prefix {
        Some(prefix) => &root["active"][format!("{prefix}joined")],
        None => &root["active"]["joined"],
    };
    let Some(joined) = joined.as_str() else {
        return Ok(None);
    };
    let (input, shards) = joined_input(&directory, &root, joined)?;
    let mut found = Vec::new();
    packages(&directory, &root, &shards, observed, cancelled, &mut found)?;
    if let Some(target) = &request.target {
        require(
            input.target == *target,
            invalid("The configuration's view is another target's; use the target's view."),
        )?;
        let files = match observed {
            Observed::Walk(_) => None,
            Observed::Paths { files, .. } => Some(
                files
                    .iter()
                    .map(|file| Wtf8Buf::from_utf8(file).into_view())
                    .collect::<BTreeSet<_>>(),
            ),
        };
        localization(&request.project_root, &input, files.as_ref(), &mut found)?;
    }
    if cancelled() {
        return Err(Error::new(
            ErrorCode::Cancelled,
            "The disk check was cancelled.",
        ));
    }
    found.sort_by_cached_key(|item| wtf8(&item.2));
    let mut counts = DiskChangeCounts::default();
    let items = found
        .into_iter()
        .map(|(kind, change, path)| {
            let counted = match kind {
                DiskChangeKind::Package => &mut counts.packages,
                DiskChangeKind::Localization => &mut counts.localization,
            };
            *match change {
                Change::Added => &mut counted.added,
                Change::Changed => &mut counted.changed,
                Change::Removed => &mut counted.removed,
            } += 1;
            DiskChangeItem { kind, change, path }
        })
        .collect();
    Ok(Some((counts, items)))
}

/// One page of a comparison's items, after the path `after` (a view, as items hold them).
pub fn page(
    counts: DiskChangeCounts,
    items: &[DiskChangeItem],
    after: Option<&str>,
    limit: u32,
) -> DiskChangesAnswer {
    let start = after.map_or(0, |after| {
        let after = wtf8(after);
        items.partition_point(|item| wtf8(&item.path) <= after)
    });
    let end = (start + limit as usize).min(items.len());
    let page = items[start..end].to_vec();
    let next_cursor = (end < items.len())
        .then(|| page.last().map(|item| item.path.clone()))
        .flatten();
    DiskChangesAnswer::Ready {
        counts,
        items: page,
        next_cursor,
    }
}

/// The packages of the shards the view's joined layer read compared with the observed ones, shard
/// by shard so only a batch of shards' strings is held at once. Shards published since, by a
/// project refresh or another target's scan, are not this view's until it is joined again.
///
/// Observed paths are the files' own names: each is converted once to the dictionary's scalar
/// view, as a scan interns it, then compared and listed as that view. Its shard is the one a scan
/// stores it in, which the file's own name selects.
fn packages(
    directory: &Path,
    root: &Value,
    shards: &BTreeMap<String, String>,
    observed: &Observed<'_>,
    cancelled: &dyn Fn() -> bool,
    found: &mut Vec<Found>,
) -> Result<()> {
    let view = |path: &str| Wtf8Buf::from_utf8(path).into_view();
    // The observed packages of each shard, by path, with their signatures.
    let mut disk: Vec<Vec<(String, Option<String>)>> = vec![Vec::new(); SHARDS];
    let mut wanted: Option<Vec<BTreeSet<String>>> = None;
    match observed {
        Observed::Walk(packages) => {
            for package in *packages {
                disk[shard(&package.path)]
                    .push((view(&package.path), Some(view(&package.signature))));
            }
        }
        Observed::Paths { packages, .. } => {
            let mut named = vec![BTreeSet::new(); SHARDS];
            for (path, signature) in *packages {
                let group = shard(path);
                named[group].insert(view(path));
                disk[group].push((view(path), signature.as_deref().map(view)));
            }
            wanted = Some(named);
        }
    }
    let groups = (0..SHARDS)
        .filter(|group| {
            wanted.as_ref().map_or(
                !disk[*group].is_empty() || shards.contains_key(&shard_name(*group)),
                |named| !named[*group].is_empty(),
            )
        })
        .collect::<Vec<_>>();
    for batch in groups.chunks(SHARD_BATCH) {
        if cancelled() {
            return Err(Error::new(
                ErrorCode::Cancelled,
                "The disk check was cancelled.",
            ));
        }
        // Each shard's (path, signature) string IDs, then their strings in one dictionary pass. A
        // check of named paths reads the signatures of only the rows it names, in a second pass.
        let mut rows = Vec::with_capacity(batch.len());
        let mut ids = BTreeSet::new();
        for group in batch {
            let shard_rows = match shards.get(&shard_name(*group)) {
                Some(key) => shard_columns(directory, root, key)?,
                None => Vec::new(),
            };
            for (path, signature) in &shard_rows {
                ids.insert(*path);
                if wanted.is_none() {
                    ids.insert(*signature);
                }
            }
            rows.push(shard_rows);
        }
        let mut strings = dictionary_selected_strings(directory, root, &ids)?;
        if let Some(named) = &wanted {
            let mut signatures = BTreeSet::new();
            for (group, shard_rows) in batch.iter().zip(&rows) {
                for (path, signature) in shard_rows {
                    let path = strings
                        .get(path)
                        .ok_or("Package string outside the dictionary.")?;
                    if named[*group].contains(path.as_str()) {
                        signatures.insert(*signature);
                    }
                }
            }
            signatures.retain(|id| !strings.contains_key(id));
            strings.extend(dictionary_selected_strings(directory, root, &signatures)?);
        }
        let text = |id: &u32| -> Result<&str> {
            Ok(strings
                .get(id)
                .ok_or("Package string outside the dictionary.")?
                .as_str())
        };
        for (group, shard_rows) in batch.iter().zip(rows) {
            let mut indexed = Vec::with_capacity(shard_rows.len());
            for (path, signature) in &shard_rows {
                let path = text(path)?;
                if wanted
                    .as_ref()
                    .is_none_or(|named| named[*group].contains(path))
                {
                    indexed.push((path, text(signature)?));
                }
            }
            indexed.sort_unstable();
            // A path a shard lists twice is one package.
            indexed.dedup_by(|a, b| a.0 == b.0);
            let on_disk = &mut disk[*group];
            on_disk.sort_unstable();
            on_disk.dedup_by(|a, b| a.0 == b.0);
            let on_disk = on_disk
                .iter()
                .map(|(path, signature)| (path.as_str(), signature.as_deref()))
                .collect::<Vec<_>>();
            merge(&indexed, &on_disk, found);
        }
    }
    Ok(())
}

fn shard_name(group: usize) -> String {
    format!("package-text.{group}")
}

/// One shard layer's package path and signature string IDs, row by row.
fn shard_columns(directory: &Path, root: &Value, key: &str) -> Result<Vec<(u32, u32)>> {
    let record = &root["layers"][key];
    // The store keeps a joined layer's inputs; a root without one was replaced meanwhile.
    require(
        record.is_object(),
        Error::new(
            ErrorCode::NotFound,
            "A package shard of the joined view is no longer in the store.",
        ),
    )?;
    let mut reader = Reader::open(&directory.join(record["file"].as_str().ok_or("Layer file.")?))?;
    let paths = crate::join_columns::column(&mut reader, record, "package.path")?;
    let signatures = crate::join_columns::column(&mut reader, record, "package.signature")?;
    require(
        paths.len() == signatures.len(),
        "Package column lengths differ.",
    )?;
    Ok(paths.into_iter().zip(signatures).collect())
}

/// Indexed and observed packages of one shard, both in path order, merged by path.
fn merge(indexed: &[(&str, &str)], on_disk: &[(&str, Option<&str>)], found: &mut Vec<Found>) {
    let on_disk = on_disk
        .iter()
        .filter_map(|(path, signature)| signature.map(|signature| (*path, signature)))
        .collect::<Vec<_>>();
    let (mut i, mut j) = (0, 0);
    loop {
        let change = match (indexed.get(i), on_disk.get(j)) {
            (Some(a), Some(b)) if a.0 == b.0 => {
                i += 1;
                j += 1;
                (a.1 != b.1).then_some((Change::Changed, a.0))
            }
            (Some(a), Some(b)) if a.0 < b.0 => {
                i += 1;
                Some((Change::Removed, a.0))
            }
            (Some(a), None) => {
                i += 1;
                Some((Change::Removed, a.0))
            }
            (_, Some(b)) => {
                j += 1;
                Some((Change::Added, b.0))
            }
            (None, None) => break,
        };
        if let Some((change, path)) = change {
            found.push((DiskChangeKind::Package, change, path.to_owned()));
        }
    }
}

/// What a joined target recorded of its localization inputs, and the inputs it read.
#[derive(Deserialize)]
struct JoinedMeta {
    input: JoinedInput,
    dependencies: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinedInput {
    target: Value,
    #[serde(default)]
    file_provenances: BTreeMap<String, Recorded>,
    #[serde(default)]
    file_errors: BTreeMap<String, String>,
    #[serde(default)]
    review_file: Option<ReviewFile>,
}

/// A file's size and modification time as an import recorded them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recorded {
    size: u64,
    modified_time: String,
}

/// The target's name and its recorded inputs.
struct Inputs {
    target: String,
    paths: Vec<String>,
    provenances: BTreeMap<String, Recorded>,
    errors: BTreeMap<String, String>,
    review: Option<ReviewFile>,
}

/// The joined layer's recorded inputs, and its package-text shards by name: the packages it shows.
fn joined_input(
    directory: &Path,
    root: &Value,
    key: &str,
) -> Result<(Inputs, BTreeMap<String, String>)> {
    let record = &root["layers"][key];
    let reader = Reader::open(&directory.join(record["file"].as_str().ok_or("Joined file.")?))?;
    require(
        reader
            .entries
            .iter()
            .find(|entry| entry.name == "join.meta")
            .is_some_and(|entry| entry.raw <= 16 * 1024 * 1024),
        "Joined metadata exceeds its bound.",
    )?;
    let bytes = crate::store::section(&reader, "join.meta")?;
    let meta: JoinedMeta = crate::json_value::parse_as(std::str::from_utf8(&bytes)?)?;
    let paths = crate::join::input_paths(&meta.input.target, Some(&meta.input.file_errors))?;
    let target = meta.input.target["name"]
        .as_str()
        .ok_or("Joined target name.")?
        .to_owned();
    let shards = crate::engine_changes::package_shards(&meta.dependencies)?
        .into_iter()
        .collect();
    let inputs = Inputs {
        target,
        paths,
        provenances: meta.input.file_provenances,
        errors: meta.input.file_errors,
        review: meta.input.review_file,
    };
    Ok((inputs, shards))
}

/// The target's localization inputs and review file compared with the files on disk by size
/// and modification time. With `named`, only the inputs named are checked.
///
/// - recorded and on disk: changed when its size or time differs;
/// - recorded and missing: removed;
/// - not recorded, on disk: added, unless the import failed to read it for another reason than
///   its absence: then its size and time are unknown, and a refresh would not record them.
fn localization(
    project_root: &Path,
    input: &Inputs,
    named: Option<&BTreeSet<String>>,
    found: &mut Vec<Found>,
) -> Result<()> {
    let mut seen = BTreeSet::new();
    for path in &input.paths {
        // A `<...>` placeholder names an output the target lacks, not a file.
        if path.starts_with('<') || !seen.insert(path.as_str()) {
            continue;
        }
        if named.is_some_and(|named| !named.contains(path)) {
            continue;
        }
        let recorded = input
            .provenances
            .get(path)
            .map(|recorded| (recorded.size, recorded.modified_time.as_str()));
        let failed = input
            .errors
            .get(path)
            .is_some_and(|code| code != "file_missing");
        if let Some(change) = file_change(project_root, path, recorded, failed)? {
            found.push((DiskChangeKind::Localization, change, path.clone()));
        }
    }
    if let Some(review) = &input.review
        && named.is_none_or(|named| named.contains(&review.relative_path))
    {
        let recorded = review.size.zip(review.modified_time.as_deref());
        if let Some(change) = file_change(project_root, &review.relative_path, recorded, false)? {
            found.push((
                DiskChangeKind::Localization,
                change,
                review.relative_path.clone(),
            ));
        }
    }
    Ok(())
}

fn file_change(
    project_root: &Path,
    path: &str,
    recorded: Option<(u64, &str)>,
    failed: bool,
) -> Result<Option<Change>> {
    let file = project_root.join(Wtf8Buf::from_view(path).to_utf8()?);
    let current = match std::fs::metadata(&file) {
        Ok(metadata) if metadata.is_file() => Some(metadata),
        Ok(_) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    Ok(match (recorded, current) {
        (Some((size, time)), Some(metadata)) => (metadata.len() != size
            || crate::localization::import::timestamp(&metadata) != time)
            .then_some(Change::Changed),
        (Some(_), None) => Some(Change::Removed),
        (None, Some(_)) if !failed => Some(Change::Added),
        (None, _) => None,
    })
}

#[cfg(test)]
mod tests;
