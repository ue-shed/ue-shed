//! What changed in a target since an earlier generation of it: its lines or its packages, diffed
//! from the joined layers the store still retains, a page at a time.
//!
//! A target's generation is its joined key. The key is a digest of every input the join read, so
//! it moves exactly when something the target shows changed, and it stays equal across refreshes
//! that change nothing. Earlier joined layers and their inputs stay in the store until compaction,
//! and every layer of one dictionary generation shares its string IDs, so two generations compare
//! column by column, without materialising strings.
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::engine_reader::EngineReader;
use crate::engine_types::invalid;
use crate::join_policy::characters;
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
#[cfg(test)]
use ts_rs::TS;

/// The most changes one page lists.
pub const MAX_CHANGES_PAGE: u32 = 1000;
/// Rows compared between cancellation checks.
const CHECK_ROWS: usize = 4096;

/// What a `changed_since` request diffs: the target's lines, or its project's packages.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Lines,
    Packages,
}

/// A `changed_since` request: what changed in the open target since generation `since`, a page
/// of at most `limit` changes after the cursor `after`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangedSinceRequest {
    /// A generation an earlier refresh or open reported for this target.
    pub since: String,
    pub kind: ChangeKind,
    /// The last ID of the previous page; absent for the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub after: Option<String>,
    /// Changes one page lists, from 1 to 1000.
    pub limit: u32,
}

impl ChangedSinceRequest {
    pub fn validate(&self) -> Result<()> {
        require(
            !self.since.is_empty() && characters(&self.since) <= 1024,
            invalid("A generation is required."),
        )?;
        require(
            (1..=MAX_CHANGES_PAGE).contains(&self.limit),
            invalid("A page lists between 1 and 1000 changes."),
        )?;
        if let Some(after) = &self.after {
            require(
                !after.is_empty() && characters(after) <= 3 * 32767 + 1024,
                invalid("Invalid change cursor."),
            )?;
        }
        Ok(())
    }
}

/// How an item differs between the two generations, or between the disk and the index.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum Change {
    Added,
    Changed,
    Removed,
}

/// Why the engine can't diff against a generation; the host decides what to do instead.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum TooOldReason {
    /// The generation's joined layer, or one of its inputs, is no longer in the store: a
    /// compaction removed it, or renumbered the strings it shares with the current one.
    Compacted,
    /// The generation was written in a joined format other than the current one.
    Format,
    /// The string is not a generation this store produced for this target and view.
    Unknown,
}

/// Every change between the two generations, not only the page's.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ChangeCounts {
    pub added: u32,
    pub changed: u32,
    pub removed: u32,
}

/// One changed line or package.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ChangeItem {
    pub change: Change,
    /// A line's ID (`<target>:["namespace","key"]` or `<target>:unresolved:<unit ID>`), or a
    /// package's path as the package-text shards store it.
    pub id: String,
    /// A line's namespace and key, when it has that identity: as the current generation has it,
    /// or for a removed line, as the earlier one had it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub key: Option<String>,
}

/// A `changed_since` answer. `changes` lists the items in ID order (WTF-8 bytes), so the cursor of
/// the next page is the last ID listed; it is never an "everything is new" stand-in.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ChangedSinceAnswer {
    /// `since` is the current generation.
    Same,
    TooOld {
        reason: TooOldReason,
    },
    Changes {
        counts: ChangeCounts,
        items: Vec<ChangeItem>,
        /// The cursor of the next page; absent on the last.
        #[serde(rename = "nextCursor", skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional, rename = "nextCursor"))]
        next_cursor: Option<String>,
    },
}

/// One changed item as the cache keeps it: its ID's WTF-8 bytes and its identity's strings.
struct Changed {
    id: Vec<u8>,
    change: Change,
    identity: Option<(String, String)>,
}

enum Outcome {
    TooOld(TooOldReason),
    Changes {
        counts: ChangeCounts,
        items: Vec<Changed>,
    },
}

/// One kind's diff against one earlier generation, cached on the reader so paging is cheap. It
/// holds only the changed items.
pub(crate) struct ChangeSet {
    since: String,
    outcome: Outcome,
}

/// Whether `since` has the shape of a joined key, and whether its format is the current one.
fn key_format(since: &str) -> Option<bool> {
    let (version, digest) = since.strip_prefix("joined-native-v")?.split_once(':')?;
    if version.is_empty()
        || !version.bytes().all(|byte| byte.is_ascii_digit())
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    Some(since.starts_with(crate::join::JOINED_KEY_PREFIX))
}

/// The joined layer's dependency keys, by input name.
fn dependencies(meta: &Value) -> Result<&serde_json::Map<String, Value>> {
    Ok(meta["dependencies"]
        .as_object()
        .ok_or("Invalid joined dependencies.")?)
}

impl EngineQuery {
    /// A page of what changed in this reader's target since generation `request.since`.
    pub fn changed_since(
        &self,
        request: &ChangedSinceRequest,
        cancelled: &AtomicBool,
    ) -> Result<ChangedSinceAnswer> {
        request.validate()?;
        if request.since == self.reader.joined_key {
            return Ok(ChangedSinceAnswer::Same);
        }
        let cached = self
            .changes
            .lock()
            .get(&request.kind)
            .filter(|set| set.since == request.since)
            .cloned();
        let set = match cached {
            Some(set) => set,
            None => {
                let outcome = self.diff(&request.since, request.kind, cancelled)?;
                let set = Arc::new(ChangeSet {
                    since: request.since.clone(),
                    outcome,
                });
                self.changes.lock().insert(request.kind, Arc::clone(&set));
                set
            }
        };
        Ok(match &set.outcome {
            Outcome::TooOld(reason) => ChangedSinceAnswer::TooOld { reason: *reason },
            Outcome::Changes { counts, items } => {
                let start = match &request.after {
                    Some(after) => {
                        let after = Wtf8Buf::from_view(after).into_bytes();
                        items.partition_point(|item| item.id <= after)
                    }
                    None => 0,
                };
                let end = (start + request.limit as usize).min(items.len());
                let page = items[start..end]
                    .iter()
                    .map(|item| {
                        let (namespace, key) = item.identity.clone().unzip();
                        Ok(ChangeItem {
                            change: item.change,
                            id: Wtf8Buf::from_bytes(item.id.clone())?.into_view(),
                            namespace,
                            key,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                let next_cursor = (end < items.len())
                    .then(|| page.last().map(|item| item.id.clone()))
                    .flatten();
                ChangedSinceAnswer::Changes {
                    counts: *counts,
                    items: page,
                    next_cursor,
                }
            }
        })
    }

    /// The earlier generation opened beside this one, or why it can't be.
    fn earlier(&self, since: &str) -> Result<std::result::Result<EngineReader, TooOldReason>> {
        match key_format(since) {
            None => return Ok(Err(TooOldReason::Unknown)),
            Some(false) => return Ok(Err(TooOldReason::Format)),
            Some(true) => {}
        }
        let Some(retained) = EngineReader::retained(&self.configuration, since)? else {
            return Ok(Err(TooOldReason::Compacted));
        };
        let root = &retained.root;
        // A compaction after this reader opened renumbered the strings: this reader is stale.
        require(
            root["generation"] == self.reader.generation.as_str(),
            Error::new(
                ErrorCode::StaleGeneration,
                "The Game Text store was compacted after this reader opened; reopen the target.",
            ),
        )?;
        let meta = &retained.meta;
        if !matches!(meta["version"].as_u64(), Some(3 | 4)) {
            return Ok(Err(TooOldReason::Format));
        }
        // A layer from before the last compaction, kept under its key with renumbered strings.
        if meta["generation"] != root["generation"]
            || retained.record()["storeGeneration"] != root["generation"]
        {
            return Ok(Err(TooOldReason::Compacted));
        }
        let current = &self.reader.meta["input"];
        if meta["input"]["target"]["name"] != current["target"]["name"]
            || meta["input"]["projectRoot"] != current["projectRoot"]
        {
            return Ok(Err(TooOldReason::Unknown));
        }
        let mut inputs = dependencies(meta)?
            .values()
            .map(|key| key.as_str().ok_or("Invalid dependency key."))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if let Some(base) = meta["base"].as_str() {
            inputs.push(base);
        }
        for key in inputs {
            let record = &root["layers"][key];
            if record.is_null() || record["storeGeneration"] != root["generation"] {
                return Ok(Err(TooOldReason::Compacted));
            }
        }
        Ok(Ok(EngineReader::open_retained(retained)?))
    }

    fn diff(&self, since: &str, kind: ChangeKind, cancelled: &AtomicBool) -> Result<Outcome> {
        checkpoint(cancelled)?;
        let earlier = match self.earlier(since)? {
            Ok(earlier) => earlier,
            Err(reason) => return Ok(Outcome::TooOld(reason)),
        };
        let mut items = match kind {
            ChangeKind::Lines => self.line_changes(&earlier, cancelled)?,
            ChangeKind::Packages => self.package_changes(&earlier, cancelled)?,
        };
        items.sort_unstable_by(|a, b| a.id.cmp(&b.id));
        let mut counts = ChangeCounts::default();
        for item in &items {
            *match item.change {
                Change::Added => &mut counts.added,
                Change::Changed => &mut counts.changed,
                Change::Removed => &mut counts.removed,
            } += 1;
        }
        Ok(Outcome::Changes { counts, items })
    }

    /// The strings of IDs from either generation. Both share one dictionary generation, so the
    /// current reader resolves every ID it holds, and the earlier one, opened on the store's newer
    /// root, resolves IDs appended after this reader opened.
    fn either_strings(&self, earlier: &EngineReader, ids: &[u32]) -> Result<Vec<String>> {
        let known = self.reader.dictionary_count()?;
        if ids.iter().all(|id| (*id as usize) < known) {
            self.reader.strings_batch(ids)
        } else {
            earlier.strings_batch(ids)
        }
    }

    /// Lines added, changed or removed, matched by line ID.
    fn line_changes(&self, earlier: &EngineReader, cancelled: &AtomicBool) -> Result<Vec<Changed>> {
        let old = LineSide::open(earlier)?;
        let new = LineSide::open(&self.reader)?;
        let compare = LineComparison::new(earlier, &self.reader, &old, &new)?;
        let index = self.id_index("line")?;
        let target = Wtf8Buf::from_view(self.target["name"].as_str().ok_or("Target name.")?);
        let unresolved = [target.as_bytes(), b":unresolved:"].concat();
        let mut matched = vec![false; new.count];
        // (row, change, from the earlier generation)
        let mut rows = Vec::new();
        for row in 0..old.count {
            if row % CHECK_ROWS == 0 {
                checkpoint(cancelled)?;
            }
            match index.find(old.id(row)) {
                None => rows.push((row, Change::Removed, true)),
                Some(current) => {
                    matched[current] = true;
                    if compare.differs(row, current)? {
                        rows.push((current, Change::Changed, false));
                    }
                }
            }
        }
        for (row, seen) in matched.iter().enumerate() {
            if !seen {
                rows.push((row, Change::Added, false));
            }
        }
        checkpoint(cancelled)?;
        let mut identities = Vec::new();
        let mut items = Vec::with_capacity(rows.len());
        for (row, change, earlier_row) in rows {
            let side = if earlier_row { &old } else { &new };
            let id = side.id(row);
            if !id.starts_with(&unresolved) {
                identities.push((items.len(), side.namespace[row], side.key[row]));
            }
            items.push(Changed {
                id: id.to_vec(),
                change,
                identity: None,
            });
        }
        let ids = identities
            .iter()
            .flat_map(|(_, namespace, key)| [*namespace, *key])
            .collect::<Vec<_>>();
        let mut strings = self.either_strings(earlier, &ids)?.into_iter();
        for (item, _, _) in identities {
            let namespace = strings.next().ok_or("Missing namespace string.")?;
            let key = strings.next().ok_or("Missing key string.")?;
            items[item].identity = Some((namespace, key));
        }
        Ok(items)
    }

    /// Packages added, changed or removed, by path: the paths and signatures of the package-text
    /// shards whose keys differ between the two generations.
    fn package_changes(
        &self,
        earlier: &EngineReader,
        cancelled: &AtomicBool,
    ) -> Result<Vec<Changed>> {
        let shards = |meta: &Value| -> Result<Vec<(String, String)>> {
            dependencies(meta)?
                .iter()
                .filter(|(name, _)| name.starts_with("package-text."))
                .map(|(name, key)| {
                    Ok((
                        name.clone(),
                        key.as_str().ok_or("Invalid dependency key.")?.to_owned(),
                    ))
                })
                .collect()
        };
        let before = shards(&earlier.meta)?;
        let after = shards(&self.reader.meta)?;
        // Each side's (path, signature) string IDs from the shards that differ.
        let packages = |reader: &EngineReader,
                        own: &[(String, String)],
                        other: &[(String, String)]|
         -> Result<Vec<(u32, u32)>> {
            let mut rows = Vec::new();
            for (name, key) in own {
                if other
                    .iter()
                    .any(|shard| shard.0 == *name && shard.1 == *key)
                {
                    continue;
                }
                checkpoint(cancelled)?;
                let paths = reader.layer_column(key, "package.path")?;
                let signatures = reader.layer_column(key, "package.signature")?;
                require(
                    paths.len() == signatures.len(),
                    "Package column lengths differ.",
                )?;
                rows.extend(paths.iter().copied().zip(signatures.iter().copied()));
            }
            rows.sort_unstable();
            Ok(rows)
        };
        let old = packages(earlier, &before, &after)?;
        let new = packages(&self.reader, &after, &before)?;
        checkpoint(cancelled)?;
        let (mut i, mut j) = (0, 0);
        let mut changes = Vec::new();
        while i < old.len() || j < new.len() {
            match (old.get(i), new.get(j)) {
                (Some(a), Some(b)) if a.0 == b.0 => {
                    if a.1 != b.1 {
                        changes.push((b.0, Change::Changed));
                    }
                    i += 1;
                    j += 1;
                }
                (Some(a), Some(b)) if a.0 < b.0 => {
                    changes.push((a.0, Change::Removed));
                    i += 1;
                }
                (Some(a), None) => {
                    changes.push((a.0, Change::Removed));
                    i += 1;
                }
                (_, Some(b)) => {
                    changes.push((b.0, Change::Added));
                    j += 1;
                }
                (None, None) => break,
            }
        }
        // A path a shard lists twice is one package.
        changes.dedup_by_key(|change| change.0);
        let ids = changes.iter().map(|change| change.0).collect::<Vec<_>>();
        let paths = self.either_strings(earlier, &ids)?;
        Ok(changes
            .into_iter()
            .zip(paths)
            .map(|((_, change), path)| Changed {
                id: Wtf8Buf::from_view(&path).into_bytes(),
                change,
                identity: None,
            })
            .collect())
    }
}

/// One generation's line IDs and identities.
struct LineSide {
    count: usize,
    starts: Arc<[u32]>,
    bytes: Arc<[u8]>,
    namespace: Arc<[u32]>,
    key: Arc<[u32]>,
}

impl LineSide {
    fn open(reader: &EngineReader) -> Result<Self> {
        let starts = reader.column("query.line.id_starts")?;
        let bytes = reader.bytes("query.line.id_utf8")?;
        let namespace = reader.column("line.namespace")?;
        let key = reader.column("line.key")?;
        let count = namespace.len();
        require(
            starts.len() == count + 1
                && key.len() == count
                && starts.first() == Some(&0)
                && starts.windows(2).all(|range| range[0] <= range[1])
                && starts
                    .last()
                    .is_some_and(|end| *end as usize <= bytes.len()),
            "Invalid line identity offsets.",
        )?;
        Ok(Self {
            count,
            starts,
            bytes,
            namespace,
            key,
        })
    }

    fn id(&self, row: usize) -> &[u8] {
        &self.bytes[self.starts[row] as usize..self.starts[row + 1] as usize]
    }
}

/// The line columns compared value for value: string IDs and flags.
const LINE_VALUES: [&str; 11] = [
    "line.namespace",
    "line.key",
    "line.source",
    "line.source_visible",
    "line.reasons",
    "line.facts",
    "line.origins",
    "line.editing",
    "line.notes",
    "line.audience",
    "line.split_unit",
];
/// One culture's columns compared value for value.
const CULTURE_VALUES: [&str; 4] = ["state", "facts", "reasons", "review"];

/// One side of a column pair: the earlier generation's, then the current one's.
type Pair = (Arc<[u32]>, Arc<[u32]>);
/// A generation's unit IDs: offsets into a WTF-8 arena.
type UnitIds = (Arc<[u32]>, Arc<[u8]>);

/// The translations a culture's lines name in one input: each entry's text ID, chosen as the
/// join chose it, or none for a PO entry without a pending edit.
struct Entries {
    /// The input's layer key; equal keys hold equal entries.
    key: Option<String>,
    options: Arc<[u32]>,
    sources: Arc<[u32]>,
    translations: Arc<[u32]>,
    po: bool,
}

impl Entries {
    fn open(reader: &EngineReader, culture: &str, po: bool) -> Result<Self> {
        let field = if po { "portableObjects" } else { "archives" };
        let path = reader.meta["input"]["target"]["outputPaths"][field][culture].as_str();
        let key = path
            .and_then(|path| reader.meta["dependencies"][path].as_str())
            .map(str::to_owned);
        let empty: Arc<[u32]> = Arc::from(Vec::new());
        let (options, sources, translations) = match &key {
            Some(key) => (
                reader.layer_column(key, "entry.options")?,
                reader.layer_column(key, "entry.source")?,
                reader.layer_column(key, "entry.translation")?,
            ),
            None => (empty.clone(), empty.clone(), empty),
        };
        Ok(Self {
            key,
            options,
            sources,
            translations,
            po,
        })
    }

    /// The text of entry `entry`, numbered from one; `None` for no entry or no pending edit.
    fn text(&self, entry: u32) -> Result<Option<u32>> {
        let Some(row) = (entry as usize).checked_sub(1) else {
            return Ok(None);
        };
        let options = *self
            .options
            .get(row)
            .ok_or("Translation entry outside input.")?;
        if self.po && options & 64 == 0 {
            return Ok(None);
        }
        let values = if options & 128 != 0 {
            &self.sources
        } else {
            &self.translations
        };
        Ok(Some(
            *values.get(row).ok_or("Translation entry outside values.")?,
        ))
    }
}

/// One culture both generations have, and the columns that show it.
struct CultureComparison {
    values: Vec<Pair>,
    review_record: Pair,
    entries: [(Pair, Entries, Entries); 2],
}

/// What a host shows for a line, in both generations: its identity, source, facts and flags, its
/// files, its units, its key-change pair and, per culture, its state, review and translations.
struct LineComparison<'a> {
    earlier: &'a EngineReader,
    current: &'a EngineReader,
    values: Vec<Pair>,
    key_change: Pair,
    files: [Pair; 2],
    facet_files: Pair,
    line_starts: Pair,
    slice_raw: Pair,
    raw_ids: [UnitIds; 2],
    cultures: Vec<CultureComparison>,
    /// The cultures differ, so every line shows a different set of cultures.
    every_line: bool,
}

fn pair(earlier: &EngineReader, current: &EngineReader, name: &str) -> Result<Pair> {
    Ok((earlier.column(name)?, current.column(name)?))
}

fn cultures(reader: &EngineReader) -> Result<Vec<String>> {
    reader.meta["input"]["target"]["cultures"]
        .as_array()
        .ok_or("Target cultures are absent.")?
        .iter()
        .map(|culture| {
            Ok(culture
                .as_str()
                .ok_or("Invalid target culture.")?
                .to_owned())
        })
        .collect()
}

impl<'a> LineComparison<'a> {
    fn new(
        earlier: &'a EngineReader,
        current: &'a EngineReader,
        old: &LineSide,
        new: &LineSide,
    ) -> Result<Self> {
        let values = LINE_VALUES
            .iter()
            .map(|name| pair(earlier, current, name))
            .collect::<Result<Vec<_>>>()?;
        for (a, b) in &values {
            require(
                a.len() == old.count && b.len() == new.count,
                "Line column lengths differ.",
            )?;
        }
        let raw_ids = [earlier, current].map(|reader| {
            Ok::<_, Error>((
                reader.column("query.raw.id_starts")?,
                reader.bytes("query.raw.id_utf8")?,
            ))
        });
        let [old_raw, new_raw] = raw_ids;
        let raw_ids = [old_raw?, new_raw?];
        for (starts, bytes) in &raw_ids {
            require(
                starts.windows(2).all(|range| range[0] <= range[1])
                    && starts
                        .last()
                        .is_some_and(|end| *end as usize <= bytes.len()),
                "Invalid unit identity offsets.",
            )?;
        }
        let before = cultures(earlier)?;
        let after = cultures(current)?;
        let mut sorted = (before.clone(), after.clone());
        sorted.0.sort();
        sorted.1.sort();
        let reduced =
            |reader: &EngineReader, ci: usize| reader.meta["reducedSourceChecking"][ci].clone();
        let mut every_line = sorted.0 != sorted.1;
        let mut compared = Vec::new();
        if !every_line {
            for (nci, culture) in after.iter().enumerate() {
                let oci = before
                    .iter()
                    .position(|name| name == culture)
                    .ok_or("Culture outside target.")?;
                every_line |= reduced(earlier, oci) != reduced(current, nci);
                let column = |reader: &EngineReader, ci: usize, field: &str| {
                    reader.column(&format!("c{ci}.{field}"))
                };
                let pair = |field: &str| -> Result<Pair> {
                    Ok((column(earlier, oci, field)?, column(current, nci, field)?))
                };
                compared.push(CultureComparison {
                    values: CULTURE_VALUES
                        .iter()
                        .map(|field| pair(field))
                        .collect::<Result<Vec<_>>>()?,
                    review_record: pair("review_record")?,
                    entries: [
                        (
                            pair("archive")?,
                            Entries::open(earlier, culture, false)?,
                            Entries::open(current, culture, false)?,
                        ),
                        (
                            pair("po")?,
                            Entries::open(earlier, culture, true)?,
                            Entries::open(current, culture, true)?,
                        ),
                    ],
                });
            }
        }
        let comparison = Self {
            earlier,
            current,
            values,
            key_change: pair(earlier, current, "line.key_change")?,
            files: [
                pair(earlier, current, "line.file_start")?,
                pair(earlier, current, "line.file_end")?,
            ],
            facet_files: pair(earlier, current, "facet.files")?,
            line_starts: pair(earlier, current, "query.line.starts")?,
            slice_raw: pair(earlier, current, "query.slice.raw")?,
            raw_ids,
            cultures: compared,
            every_line,
        };
        // Every per-line column has a value for each line of its generation.
        let mut per_line = vec![
            &comparison.key_change,
            &comparison.files[0],
            &comparison.files[1],
        ];
        for culture in &comparison.cultures {
            per_line.extend(&culture.values);
            per_line.push(&culture.review_record);
            per_line.extend(culture.entries.iter().map(|(rows, _, _)| rows));
        }
        require(
            per_line
                .iter()
                .all(|(a, b)| a.len() == old.count && b.len() == new.count)
                && comparison.line_starts.0.len() == old.count + 1
                && comparison.line_starts.1.len() == new.count + 1,
            "Line column lengths differ.",
        )?;
        Ok(comparison)
    }

    /// Whether anything a host shows for earlier line `old` differs in current line `new`.
    fn differs(&self, old: usize, new: usize) -> Result<bool> {
        if self.every_line {
            return Ok(true);
        }
        let value = |pair: &Pair| -> Result<bool> {
            Ok(pair.0.get(old).ok_or("Line outside column.")?
                != pair.1.get(new).ok_or("Line outside column.")?)
        };
        for pair in &self.values {
            if value(pair)? {
                return Ok(true);
            }
        }
        if self.key_change_differs(old, new)? || self.files_differ(old, new)? {
            return Ok(true);
        }
        for culture in &self.cultures {
            for pair in &culture.values {
                if value(pair)? {
                    return Ok(true);
                }
            }
            let records = [
                culture.review_record.0[old] as usize,
                culture.review_record.1[new] as usize,
            ];
            if (records[0] == 0) != (records[1] == 0)
                || (records[0] != 0
                    && self.earlier.meta["input"]["review"]["records"][records[0] - 1]
                        != self.current.meta["input"]["review"]["records"][records[1] - 1])
            {
                return Ok(true);
            }
            for (rows, before, after) in &culture.entries {
                let (a, b) = (rows.0[old], rows.1[new]);
                let same = if before.key.is_some() && before.key == after.key {
                    a == b
                } else {
                    before.text(a)? == after.text(b)?
                };
                if !same {
                    return Ok(true);
                }
            }
        }
        self.units_differ(old, new)
    }

    /// Whether the key-change pairs differ: which side of a pair the line is, and the pair.
    fn key_change_differs(&self, old: usize, new: usize) -> Result<bool> {
        let (a, b) = (self.key_change.0[old], self.key_change.1[new]);
        if a == 0 || b == 0 {
            return Ok(a != b);
        }
        let pair = |reader: &EngineReader, value: u32| -> Result<Value> {
            let index = (value / 2)
                .checked_sub(1)
                .ok_or("Invalid key-change pair.")?;
            Ok(reader.meta["pairs"][index as usize].clone())
        };
        Ok(a % 2 != b % 2 || pair(self.earlier, a)? != pair(self.current, b)?)
    }

    /// Whether the files the line comes from differ, as path string IDs.
    fn files_differ(&self, old: usize, new: usize) -> Result<bool> {
        let range = |side: usize, row: usize| -> Result<&[u32]> {
            let (starts, ends, files) = if side == 0 {
                (&self.files[0].0, &self.files[1].0, &self.facet_files.0)
            } else {
                (&self.files[0].1, &self.files[1].1, &self.facet_files.1)
            };
            Ok(files
                .get(starts[row] as usize..ends[row] as usize)
                .ok_or("Invalid line file range.")?)
        };
        Ok(range(0, old)? != range(1, new)?)
    }

    /// Whether the line's set of units differs, by unit ID.
    fn units_differ(&self, old: usize, new: usize) -> Result<bool> {
        let units = |side: usize, row: usize| -> Result<Vec<&[u8]>> {
            let (starts, raws) = if side == 0 {
                (&self.line_starts.0, &self.slice_raw.0)
            } else {
                (&self.line_starts.1, &self.slice_raw.1)
            };
            let (id_starts, bytes) = &self.raw_ids[side];
            let begin = *starts.get(row).ok_or("Invalid line slices.")? as usize;
            let end = *starts.get(row + 1).ok_or("Invalid line slices.")? as usize;
            let mut units = raws
                .get(begin..end)
                .ok_or("Invalid line slices.")?
                .iter()
                .map(|raw| {
                    let raw = *raw as usize;
                    let start = *id_starts.get(raw).ok_or("Unit outside identities.")? as usize;
                    let end = *id_starts.get(raw + 1).ok_or("Unit outside identities.")? as usize;
                    Ok(bytes.get(start..end).ok_or("Invalid unit identity.")?)
                })
                .collect::<Result<Vec<_>>>()?;
            units.sort_unstable();
            units.dedup();
            Ok(units)
        };
        Ok(units(0, old)? != units(1, new)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::join_fact_tests::Fixture;
    use serde_json::json;

    const PACKAGE: &str = "Content/Text/Example.uasset";

    /// A package's occurrence of each `(key, source)`.
    fn text(keys: &[(&str, &str, &str)]) -> Vec<Value> {
        keys.iter()
            .map(|(key, source, _)| {
                json!({"namespace":"UI","key":key,"source":source,
                    "object":"/Game/Text/Example.Example","property":"Label"})
            })
            .collect()
    }

    /// The target's manifest and archives for `(key, source, German translation)`, and empty POs.
    fn localization(fixture: &mut Fixture, keys: &[(&str, &str, &str)]) -> Result<()> {
        let rows = |translation: &dyn Fn(&str, &str) -> String| {
            keys.iter()
                .map(|(key, source, german)| {
                    json!({"namespace":"UI","key":key,"source":source,
                        "translation":translation(source, german),
                        "path":"/Game/Text/Example.Example.Label"})
                })
                .collect::<Vec<_>>()
        };
        fixture.file("Game.manifest", "manifest", &rows(&|_, _| String::new()))?;
        fixture.file("en.archive", "archive", &rows(&|source, _| source.into()))?;
        fixture.file("de.archive", "archive", &rows(&|_, german| german.into()))?;
        fixture.file("en.po", "po", &[])?;
        fixture.file("de.po", "po", &[])
    }

    fn generation(fixture: &mut Fixture, keys: &[(&str, &str, &str)]) -> Result<String> {
        localization(fixture, keys)?;
        fixture.shard("package-text.0", &[(PACKAGE, "signature", text(keys))])?;
        Ok(fixture.join()?.key)
    }

    fn request(
        since: &str,
        kind: ChangeKind,
        after: Option<String>,
        limit: u32,
    ) -> ChangedSinceRequest {
        ChangedSinceRequest {
            since: since.into(),
            kind,
            after,
            limit,
        }
    }

    type Page = (ChangeCounts, Vec<ChangeItem>, Option<String>);

    fn changes(answer: ChangedSinceAnswer) -> Result<Page> {
        match answer {
            ChangedSinceAnswer::Changes {
                counts,
                items,
                next_cursor,
            } => Ok((counts, items, next_cursor)),
            other => Err(format!("Expected changes, not {other:?}.").into()),
        }
    }

    fn item(change: Change, id: &str, key: Option<&str>) -> ChangeItem {
        ChangeItem {
            change,
            id: id.into(),
            namespace: key.map(|_| "UI".into()),
            key: key.map(str::to_owned),
        }
    }

    const ONE_EACH: ChangeCounts = ChangeCounts {
        added: 1,
        changed: 1,
        removed: 1,
    };

    #[test]
    fn the_current_generation_is_the_same_without_a_diff() -> Result<()> {
        let mut fixture = Fixture::new()?;
        let key = generation(&mut fixture, &[("A", "Alpha", "Alfa")])?;
        let query = EngineQuery::open(&fixture.configuration, Some(&key))?;
        let cancelled = AtomicBool::new(false);
        for kind in [ChangeKind::Lines, ChangeKind::Packages] {
            assert_eq!(
                query.changed_since(&request(&key, kind, None, 10), &cancelled)?,
                ChangedSinceAnswer::Same
            );
        }
        assert!(query.changes.lock().is_empty());
        // A refresh that changes nothing keeps the generation.
        assert_eq!(fixture.join()?.key, key);
        Ok(())
    }

    #[test]
    fn lines_added_changed_and_removed_across_a_localization_change_page_by_id() -> Result<()> {
        let mut fixture = Fixture::new()?;
        let first = generation(
            &mut fixture,
            &[
                ("A", "Alpha", "Alfa"),
                ("B", "Beta", "Beta"),
                ("C", "Gamma", "Gamma"),
            ],
        )?;
        // The translation of A changes, C is no longer gathered or saved, and D is new.
        let second = generation(
            &mut fixture,
            &[
                ("A", "Alpha", "Alpha neu"),
                ("B", "Beta", "Beta"),
                ("D", "Delta", "Delta"),
            ],
        )?;
        assert_ne!(first, second);
        let query = EngineQuery::open(&fixture.configuration, Some(&second))?;
        let cancelled = AtomicBool::new(false);
        let expected = vec![
            item(Change::Changed, r#"Game:["UI","A"]"#, Some("A")),
            item(Change::Removed, r#"Game:["UI","C"]"#, Some("C")),
            item(Change::Added, r#"Game:["UI","D"]"#, Some("D")),
        ];
        let lines = |after: Option<String>, limit| {
            query.changed_since(
                &request(&first, ChangeKind::Lines, after, limit),
                &cancelled,
            )
        };
        let (counts, items, next) = changes(lines(None, 1000)?)?;
        assert_eq!(counts, ONE_EACH);
        assert_eq!(items, expected);
        assert_eq!(next, None);
        // A page at a time: each cursor is the last ID listed, read from the cached diff.
        let mut after = None;
        let mut paged = Vec::new();
        loop {
            let (page_counts, items, next) = changes(lines(after, 1)?)?;
            assert_eq!(page_counts, counts);
            assert_eq!(items.len(), 1);
            paged.extend(items);
            match next {
                Some(cursor) => after = Some(cursor),
                None => break,
            }
        }
        assert_eq!(paged, expected);
        let (_, items, _) = changes(lines(Some(r#"Game:["UI","B"]"#.into()), 10)?)?;
        assert_eq!(items, expected[1..]);
        Ok(())
    }

    #[test]
    fn packages_added_changed_and_removed_from_the_shards_that_differ() -> Result<()> {
        let mut fixture = Fixture::new()?;
        let keys = [("A", "Alpha", "Alfa")];
        localization(&mut fixture, &keys)?;
        fixture.shard(
            "package-text.0",
            &[
                (PACKAGE, "first", text(&keys)),
                ("Content/Text/Empty.uasset", "first", vec![]),
            ],
        )?;
        fixture.shard(
            "package-text.1",
            &[("Content/Other/Kept.uasset", "first", vec![])],
        )?;
        let first = fixture.join()?.key;
        // The text package is saved again, a package without text goes and another comes.
        fixture.shard(
            "package-text.0",
            &[
                (PACKAGE, "second", text(&keys)),
                ("Content/Text/Added.uasset", "first", vec![]),
            ],
        )?;
        let second = fixture.join()?.key;
        let query = EngineQuery::open(&fixture.configuration, Some(&second))?;
        let cancelled = AtomicBool::new(false);
        let read = |kind| query.changed_since(&request(&first, kind, None, 1000), &cancelled);
        let (counts, items, next) = changes(read(ChangeKind::Packages)?)?;
        assert_eq!(
            items,
            vec![
                item(Change::Added, "Content/Text/Added.uasset", None),
                item(Change::Removed, "Content/Text/Empty.uasset", None),
                item(Change::Changed, PACKAGE, None),
            ]
        );
        assert_eq!(counts, ONE_EACH);
        assert_eq!(next, None);
        // The line's text and translations didn't change.
        let (counts, _, _) = changes(read(ChangeKind::Lines)?)?;
        assert_eq!(counts, ChangeCounts::default());
        Ok(())
    }

    #[test]
    fn a_generation_from_before_a_compaction_is_too_old() -> Result<()> {
        let mut fixture = Fixture::new()?;
        let first = generation(&mut fixture, &[("A", "Alpha", "Alfa")])?;
        let second = generation(&mut fixture, &[("A", "Alpha", "Alpha neu")])?;
        assert!(fixture.store()?.compact(true)?.compacted);
        // The compaction renews the dictionary generation, so the same inputs join to a new key.
        let third = fixture.join()?.key;
        assert_ne!(third, second);
        let query = EngineQuery::open(&fixture.configuration, Some(&third))?;
        let cancelled = AtomicBool::new(false);
        for since in [&first, &second] {
            for kind in [ChangeKind::Lines, ChangeKind::Packages] {
                assert_eq!(
                    query.changed_since(&request(since, kind, None, 10), &cancelled)?,
                    ChangedSinceAnswer::TooOld {
                        reason: TooOldReason::Compacted
                    }
                );
            }
        }
        Ok(())
    }

    #[test]
    fn a_string_this_store_did_not_produce_for_the_target_is_unknown() -> Result<()> {
        let mut fixture = Fixture::new()?;
        let game = generation(&mut fixture, &[("A", "Alpha", "Alfa")])?;
        fixture.target["name"] = json!("Other");
        let other = fixture.join()?.key;
        let query = EngineQuery::open(&fixture.configuration, Some(&other))?;
        let cancelled = AtomicBool::new(false);
        let digest = "0".repeat(64);
        let prefix = crate::join::JOINED_KEY_PREFIX;
        for (since, reason) in [
            ("not a generation".to_owned(), TooOldReason::Unknown),
            (game.to_uppercase(), TooOldReason::Unknown),
            // Another target's generation in the same store.
            (game.clone(), TooOldReason::Unknown),
            (format!("joined-native-v7:{digest}"), TooOldReason::Format),
            // A well-formed key the store no longer lists.
            (format!("{prefix}{digest}"), TooOldReason::Compacted),
        ] {
            let answer =
                query.changed_since(&request(&since, ChangeKind::Lines, None, 10), &cancelled)?;
            assert_eq!(answer, ChangedSinceAnswer::TooOld { reason }, "{since}");
        }
        for limit in [0, MAX_CHANGES_PAGE + 1] {
            let error = query
                .changed_since(&request(&game, ChangeKind::Lines, None, limit), &cancelled)
                .err()
                .ok_or("bounded page")?;
            assert_eq!(error.code, ErrorCode::InvalidInput);
        }
        Ok(())
    }
}
