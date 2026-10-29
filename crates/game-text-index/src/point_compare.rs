//! A point against its base: the changes place by place, and with the base's localization, what
//! they do to it, judged by `loc gate`'s checks.
//!
//! Package places pair as `diffPackageText` pairs them. Code places pair by file and identity,
//! not by line, so text an edit only moved is unchanged. Findings count only what the change
//! introduces: a problem a changed file already had at the base is not reported.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use indexmap::IndexMap;
use serde::Deserialize;

use crate::join_policy::file_key;
use crate::package_evidence::editor_only;
use crate::package_text_contract::{
    ComparePointsRequest, GateCheck, PageRequest, PointChange, PointChangeCounts, PointChangeKind,
    PointComparison, PointEntry, PointFileStatus, PointFinding, PointFindingCounts, PointFindings,
    PointIdentityStatus, PointKey, PointPlace, PointPlaceKind, PointText,
};
use crate::point_localization::{Entry, Lookup, open_or_build};
use crate::points::{point_file, record_file, valid_id};
use crate::snapshot::{Reader, integers, strings_bytes};
use crate::store::Configuration;
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result, require};

/// The most rows a page returns.
pub const MAX_PAGE: u32 = 1000;

/// One text in a record, as the reader staged it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Occurrence {
    source: String,
    notes: String,
    namespace: String,
    key: String,
    object: String,
    property: String,
    class: String,
    row: String,
    /// 0 resolved, 1 String Table reference, 2 culture invariant, 3 missing key.
    identity: u32,
    /// 0 asset property, 1 DataTable cell, 2 String Table entry, 3 code.
    location: u32,
    /// 0 unknown, 1 runtime, 2 editor-only, 3 left out by the target.
    gather: u32,
    /// The encoded audience: the gather table's bit, else the audience policy's row.
    audience: u32,
}

/// One file's texts in a record, in saved order.
struct Record {
    occurrences: Vec<Occurrence>,
}

fn read_record(path: &Path) -> Result<Record> {
    let reader = Reader::open(path)?;
    let mut tables = HashMap::<String, Vec<String>>::new();
    for index in 0..reader.entries.len() {
        let entry = &reader.entries[index];
        if entry.kind != 4 {
            continue;
        }
        let values = strings_bytes(&reader.load(index)?)?;
        let table = tables.entry(entry.domain.clone()).or_default();
        for value in values {
            table.push(Wtf8Buf::from_bytes(value)?.into_view());
        }
    }
    let mut columns = HashMap::<String, (String, Vec<u32>)>::new();
    for index in 0..reader.entries.len() {
        let entry = &reader.entries[index];
        if [2, 3].contains(&entry.kind) && entry.name.starts_with("occurrence.") {
            let domain = if entry.kind == 3 {
                entry.domain.clone()
            } else {
                String::new()
            };
            columns.insert(
                entry.name.clone(),
                (domain, integers(&reader.load(index)?)?),
            );
        }
    }
    let count = columns
        .get("occurrence.identity")
        .map_or(0, |(_, values)| values.len());
    let text = |name: &str, row: usize| -> Result<String> {
        let (domain, values) = columns.get(name).ok_or("a record column")?;
        let id = *values.get(row).ok_or("a record row")? as usize;
        Ok(tables
            .get(domain)
            .and_then(|table| table.get(id))
            .ok_or("a record string")?
            .clone())
    };
    let number = |name: &str, row: usize| -> Result<u32> {
        Ok(*columns
            .get(name)
            .and_then(|(_, values)| values.get(row))
            .ok_or("a record number")?)
    };
    let mut occurrences = Vec::with_capacity(count);
    for row in 0..count {
        occurrences.push(Occurrence {
            source: text("occurrence.source", row)?,
            notes: text("occurrence.notes", row)?,
            namespace: text("occurrence.namespace", row)?,
            key: text("occurrence.key", row)?,
            object: text("occurrence.object", row)?,
            property: text("occurrence.property", row)?,
            class: text("occurrence.class", row)?,
            row: text("occurrence.row", row)?,
            identity: number("occurrence.identity", row)?,
            location: number("occurrence.location", row)?,
            gather: number("occurrence.gather", row)?,
            audience: number("occurrence.audience", row)?,
        });
    }
    Ok(Record { occurrences })
}

#[derive(Deserialize)]
struct PointManifest {
    entries: Vec<PointEntry>,
}

fn read_point(configuration: &Configuration, id: &str) -> Result<Vec<PointEntry>> {
    let file = point_file(configuration, id)?;
    let bytes = fs::read(&file).map_err(|error| {
        Error::with_source(ErrorCode::NotFound, format!("No point {id}."), error)
    })?;
    Ok(serde_json::from_slice::<PointManifest>(&bytes)?.entries)
}

/// The object path below the package: everything after the package name's first `.`.
fn package_relative(object: &str) -> &str {
    if !object.starts_with('/') {
        return object;
    }
    object.find('.').map_or("", |dot| &object[dot + 1..])
}

fn place(occurrence: &Occurrence) -> PointPlace {
    let object = package_relative(&occurrence.object).to_owned();
    match occurrence.location {
        1 => PointPlace {
            kind: PointPlaceKind::DataTableCell,
            object,
            entry: occurrence.row.clone(),
            property: occurrence.property.clone(),
            line: None,
        },
        2 => PointPlace {
            kind: PointPlaceKind::StringTableEntry,
            object,
            entry: occurrence.row.clone(),
            property: String::new(),
            line: None,
        },
        3 => PointPlace {
            kind: PointPlaceKind::Code,
            object: occurrence.object.clone(),
            entry: String::new(),
            property: occurrence.property.clone(),
            line: occurrence.row.parse().ok(),
        },
        _ => PointPlace {
            kind: PointPlaceKind::AssetProperty,
            object,
            entry: String::new(),
            property: occurrence.property.clone(),
            line: None,
        },
    }
}

fn status(occurrence: &Occurrence) -> PointIdentityStatus {
    match occurrence.identity {
        0 => PointIdentityStatus::Resolved,
        1 => PointIdentityStatus::StringTable,
        2 => PointIdentityStatus::CultureInvariant,
        _ => PointIdentityStatus::MissingKey,
    }
}

/// What makes two texts the same identity: an unresolved one has only its reason.
fn identity(occurrence: &Occurrence) -> (u32, &str, &str) {
    if occurrence.identity <= 1 {
        (occurrence.identity, &occurrence.namespace, &occurrence.key)
    } else {
        (occurrence.identity, "", "")
    }
}

fn same_text(left: &Occurrence, right: &Occurrence) -> bool {
    identity(left) == identity(right) && left.source == right.source && left.notes == right.notes
}

fn text(occurrence: &Occurrence) -> PointText {
    PointText {
        status: status(occurrence),
        namespace: occurrence.namespace.clone(),
        key: occurrence.key.clone(),
        source: occurrence.source.clone(),
        notes: occurrence.notes.clone(),
    }
}

/// A change between two texts, with the before and after occurrences kept for the findings.
struct Change<'a> {
    kind: PointChangeKind,
    path: &'a str,
    place: PointPlace,
    before: Option<&'a Occurrence>,
    after: Option<&'a Occurrence>,
}

impl Change<'_> {
    fn row(&self) -> PointChange {
        let source_changed = match (self.before, self.after) {
            (Some(before), Some(after)) => before.source != after.source,
            _ => false,
        };
        let notes_changed = match (self.before, self.after) {
            (Some(before), Some(after)) => before.notes != after.notes,
            _ => false,
        };
        PointChange {
            kind: self.kind,
            path: self.path.to_owned(),
            place: self.place.clone(),
            before: self.before.map(text),
            after: self.after.map(text),
            source_changed,
            notes_changed,
        }
    }
}

fn paired<'a>(path: &'a str, before: &'a Occurrence, after: &'a Occurrence) -> Change<'a> {
    Change {
        kind: if identity(before) == identity(after) {
            PointChangeKind::Edited
        } else {
            PointChangeKind::Rekeyed
        },
        path,
        place: place(after),
        before: Some(before),
        after: Some(after),
    }
}

/// `diffPackageText`: places by position in the package; identical texts pair first, then the
/// rest in saved order; the surplus is added or removed.
fn diff_package<'a>(
    path: &'a str,
    before: &[&'a Occurrence],
    after: &[&'a Occurrence],
    changes: &mut Vec<Change<'a>>,
    counts: &mut PointChangeCounts,
) {
    let key = |occurrence: &Occurrence| {
        let place = place(occurrence);
        (place.kind as u8, place.object, place.entry, place.property)
    };
    let mut before_places = IndexMap::<_, Vec<&Occurrence>>::new();
    for occurrence in before {
        before_places
            .entry(key(occurrence))
            .or_default()
            .push(occurrence);
    }
    let mut after_places = IndexMap::<_, Vec<&Occurrence>>::new();
    for occurrence in after {
        after_places
            .entry(key(occurrence))
            .or_default()
            .push(occurrence);
    }
    for (place_key, texts) in &after_places {
        let mut earlier = before_places.get(place_key).cloned().unwrap_or_default();
        let mut unmatched = Vec::new();
        for text in texts {
            if let Some(same) = earlier.iter().position(|e| same_text(e, text)) {
                earlier.remove(same);
                counts.unchanged += 1;
            } else {
                unmatched.push(*text);
            }
        }
        for (index, text) in unmatched.iter().enumerate() {
            changes.push(match earlier.get(index) {
                Some(before) => paired(path, before, text),
                None => Change {
                    kind: PointChangeKind::Added,
                    path,
                    place: place(text),
                    before: None,
                    after: Some(text),
                },
            });
        }
        for before in earlier.iter().skip(unmatched.len()) {
            changes.push(Change {
                kind: PointChangeKind::Removed,
                path,
                place: place(before),
                before: Some(before),
                after: None,
            });
        }
    }
    for (place_key, texts) in &before_places {
        if after_places.contains_key(place_key) {
            continue;
        }
        for before in texts {
            changes.push(Change {
                kind: PointChangeKind::Removed,
                path,
                place: place(before),
                before: Some(before),
                after: None,
            });
        }
    }
}

/// Code: identical texts pair at any line; then the same resolved key with other text is
/// `edited`; then the same macro and text with another key is `rekeyed`; the rest are added or
/// removed. Lines move with every edit above a macro, so they never pair texts.
fn diff_code<'a>(
    path: &'a str,
    before: &[&'a Occurrence],
    after: &[&'a Occurrence],
    changes: &mut Vec<Change<'a>>,
    counts: &mut PointChangeCounts,
) {
    let mut earlier = before.to_vec();
    let mut later = Vec::new();
    for text in after {
        if let Some(same) = earlier.iter().position(|e| same_text(e, text)) {
            earlier.remove(same);
            counts.unchanged += 1;
        } else {
            later.push(*text);
        }
    }
    let rules: [fn(&Occurrence, &Occurrence) -> bool; 2] = [
        |b, a| b.identity == 0 && identity(b) == identity(a),
        |b, a| b.property == a.property && b.source == a.source,
    ];
    for rule in rules {
        let mut rest = Vec::new();
        for text in later {
            if let Some(index) = earlier.iter().position(|e| rule(e, text)) {
                changes.push(paired(path, earlier.remove(index), text));
            } else {
                rest.push(text);
            }
        }
        later = rest;
    }
    for text in later {
        changes.push(Change {
            kind: PointChangeKind::Added,
            path,
            place: place(text),
            before: None,
            after: Some(text),
        });
    }
    for before in earlier {
        changes.push(Change {
            kind: PointChangeKind::Removed,
            path,
            place: place(before),
            before: Some(before),
            after: None,
        });
    }
}

/// A key with text: a resolved identity's namespace and key.
fn resolved(occurrence: Option<&Occurrence>) -> Option<(&str, &str)> {
    occurrence
        .filter(|o| o.identity == 0)
        .map(|o| (o.namespace.as_str(), o.key.as_str()))
}

struct Findings {
    rows: Vec<PointFinding>,
    seen: HashSet<(GateCheck, String, String)>,
}

impl Findings {
    fn add(
        &mut self,
        check: GateCheck,
        path: &str,
        key: Option<(&str, &str)>,
        source: &str,
        cultures: Vec<String>,
        earlier: Option<(&str, &str)>,
    ) {
        let (namespace, name) = key.unwrap_or(("", ""));
        // A key's finding is reported once, at its first changed place.
        if key.is_some()
            && !self
                .seen
                .insert((check, namespace.to_owned(), name.to_owned()))
        {
            return;
        }
        self.rows.push(PointFinding {
            check,
            path: path.to_owned(),
            namespace: key.map(|(namespace, _)| namespace.to_owned()),
            key: key.map(|(_, key)| key.to_owned()),
            source: source.to_owned(),
            cultures,
            earlier: earlier.map(|(namespace, key)| PointKey {
                namespace: namespace.to_owned(),
                key: key.to_owned(),
            }),
        });
    }
}

/// The base's entries for every key the changes name, read from the lookup once each.
fn entries(lookup: &mut Lookup, changes: &[Change]) -> Result<HashMap<(String, String), Entry>> {
    let mut found = HashMap::new();
    for change in changes {
        for key in [resolved(change.before), resolved(change.after)]
            .into_iter()
            .flatten()
        {
            let owned = (key.0.to_owned(), key.1.to_owned());
            if !found.contains_key(&owned)
                && let Some(entry) = lookup.find(key.0, key.1)?
            {
                found.insert(owned, entry);
            }
        }
    }
    Ok(found)
}

/// Whether the target's gather collects a text in `path`.
///
/// Code text the target leaves out is marked so by the scan, per gather step. Package editor text,
/// by Unreal's gather table or else the audience policy, follows the target's package setting, as
/// the index rates it out of scope; editor text the base's manifest names in the same file stays,
/// since Unreal gathered it there. Unreal gathers no empty text.
fn gathers(
    path: &str,
    occurrence: &Occurrence,
    gather_editor_only: bool,
    gathered: &HashSet<(String, String, String)>,
) -> bool {
    !occurrence.source.is_empty()
        && occurrence.gather != 3
        && (occurrence.location == 3
            || gather_editor_only
            || !editor_only(occurrence.audience)
            || resolved(Some(occurrence)).is_some_and(|(namespace, key)| {
                gathered.contains(&(file_key(path), namespace.to_owned(), key.to_owned()))
            }))
}

/// The package editor text Unreal gathered anyway: `(file, namespace, key)` where the base's
/// manifest names the key in that file. Each key is read from the lookup once.
fn gathered_editor_text(
    lookup: &mut Lookup,
    records: &HashMap<&str, Record>,
    before: &[PointEntry],
    after: &[PointEntry],
) -> Result<HashSet<(String, String, String)>> {
    let mut files = HashMap::<(String, String), HashSet<String>>::new();
    let mut gathered = HashSet::new();
    for entry in before.iter().chain(after) {
        let Some(record) = entry
            .record
            .as_ref()
            .and_then(|key| records.get(key.as_str()))
        else {
            continue;
        };
        let file = file_key(&entry.path);
        for occurrence in &record.occurrences {
            if occurrence.location == 3 || !editor_only(occurrence.audience) {
                continue;
            }
            let Some((namespace, key)) = resolved(Some(occurrence)) else {
                continue;
            };
            let owned = (namespace.to_owned(), key.to_owned());
            if !files.contains_key(&owned) {
                let found = lookup
                    .find(namespace, key)?
                    .map_or_else(HashSet::new, |found| {
                        found
                            .contexts
                            .iter()
                            .map(|context| file_key(&context.path))
                            .collect()
                    });
                files.insert(owned.clone(), found);
            }
            if files[&owned].contains(&file) {
                gathered.insert((file.clone(), owned.0, owned.1));
            }
        }
    }
    Ok(gathered)
}

/// The gate's checks on the changes, against the base's localization. `before_texts` and
/// `after_texts` are every text of the changed files at each side, so a key still used elsewhere
/// in them is not lost.
fn judge(
    lookup: &mut Lookup,
    changes: &[Change],
    before_texts: &[&Occurrence],
    after_texts: &[&Occurrence],
    files: &HashSet<String>,
) -> Result<Vec<PointFinding>> {
    let entries = entries(lookup, changes)?;
    let entry = |key: (&str, &str)| entries.get(&(key.0.to_owned(), key.1.to_owned()));
    let translated = |entry: Option<&Entry>| -> BTreeSet<usize> {
        entry.map_or_else(BTreeSet::new, |entry| {
            (0..lookup.cultures.len())
                .filter(|culture| lookup.translated(entry, *culture))
                .collect()
        })
    };
    let names = |cultures: BTreeSet<usize>| -> Vec<String> {
        cultures
            .into_iter()
            .map(|culture| lookup.cultures[culture].clone())
            .collect()
    };
    let keys_of = |texts: &[&Occurrence]| -> HashSet<(String, String)> {
        texts
            .iter()
            .filter_map(|o| resolved(Some(o)))
            .map(|(namespace, key)| (namespace.to_owned(), key.to_owned()))
            .collect()
    };
    let before_keys = keys_of(before_texts);
    let after_keys = keys_of(after_texts);
    let mut after_sources = HashMap::<(&str, &str), BTreeSet<&str>>::new();
    for occurrence in after_texts {
        if let Some(key) = resolved(Some(occurrence)) {
            after_sources
                .entry(key)
                .or_default()
                .insert(&occurrence.source);
        }
    }
    let owned = |key: (&str, &str)| (key.0.to_owned(), key.1.to_owned());
    // Text the change moved to a new key: a removed key the change no longer uses, and an added
    // key the base never had, with the same text.
    let mut moved_to = HashMap::<usize, usize>::new();
    let mut taken = HashSet::new();
    for (removed, change) in changes.iter().enumerate() {
        let Some(earlier) = resolved(change.before) else {
            continue;
        };
        if change.kind != PointChangeKind::Removed || after_keys.contains(&owned(earlier)) {
            continue;
        }
        let source = change.before.map_or("", |o| o.source.as_str());
        let target = changes.iter().enumerate().position(|(index, other)| {
            other.kind == PointChangeKind::Added
                && !taken.contains(&index)
                && other.after.is_some_and(|o| o.source == source)
                && resolved(other.after).is_some_and(|later| {
                    !before_keys.contains(&owned(later)) && entry(later).is_none()
                })
        });
        if let Some(added) = target {
            taken.insert(added);
            moved_to.insert(added, removed);
        }
    }
    let moved_from = moved_to.values().copied().collect::<HashSet<usize>>();
    let mut findings = Findings {
        rows: Vec::new(),
        seen: HashSet::new(),
    };
    let mut conflicts = Vec::new();
    for (index, change) in changes.iter().enumerate() {
        let source = change
            .after
            .or(change.before)
            .map_or("", |o| o.source.as_str());
        if let Some(after) = change.after
            && after.identity >= 2
            && change.kind != PointChangeKind::Edited
        {
            findings.add(
                GateCheck::UnresolvedKey,
                change.path,
                None,
                source,
                Vec::new(),
                None,
            );
            continue;
        }
        let later = resolved(change.after);
        let earlier = match change.kind {
            PointChangeKind::Rekeyed => resolved(change.before),
            PointChangeKind::Added => moved_to
                .get(&index)
                .and_then(|removed| resolved(changes[*removed].before)),
            _ => None,
        };
        match change.kind {
            PointChangeKind::Added | PointChangeKind::Rekeyed => {
                let lost = earlier.map_or_else(BTreeSet::new, |earlier| {
                    let kept = later.map_or_else(BTreeSet::new, |later| translated(entry(later)));
                    translated(entry(earlier))
                        .difference(&kept)
                        .copied()
                        .collect()
                });
                if !lost.is_empty() {
                    findings.add(
                        GateCheck::KeyChanged,
                        change.path,
                        later,
                        source,
                        names(lost),
                        earlier,
                    );
                } else if let Some(later) = later
                    && entry(later).is_none()
                {
                    findings.add(
                        GateCheck::NotGathered,
                        change.path,
                        Some(later),
                        source,
                        Vec::new(),
                        None,
                    );
                }
            }
            PointChangeKind::Edited => {
                if let (Some(key), Some(before), Some(after)) = (later, change.before, change.after)
                    && before.source != after.source
                    && let Some(found) = entry(key)
                {
                    let stale = translated(Some(found))
                        .into_iter()
                        .filter(|culture| {
                            found.translations[*culture]
                                .as_ref()
                                .is_some_and(|t| t.source == before.source)
                        })
                        .collect::<BTreeSet<_>>();
                    if stale.is_empty() {
                        findings.add(
                            GateCheck::TextChanged,
                            change.path,
                            Some(key),
                            source,
                            Vec::new(),
                            None,
                        );
                    } else {
                        findings.add(
                            GateCheck::TranslatedTextChanged,
                            change.path,
                            Some(key),
                            source,
                            names(stale),
                            None,
                        );
                    }
                }
            }
            PointChangeKind::Removed => {
                if let Some(key) = resolved(change.before)
                    && !moved_from.contains(&index)
                    && !after_keys.contains(&owned(key))
                    && let Some(found) = entry(key)
                    && !found.contexts.is_empty()
                    && found
                        .contexts
                        .iter()
                        .all(|context| files.contains(&file_key(&context.path)))
                {
                    findings.add(
                        GateCheck::Removed,
                        change.path,
                        Some(key),
                        source,
                        names(translated(Some(found))),
                        None,
                    );
                }
            }
        }
        if let Some(key) = later
            && change.after.is_some_and(|after| {
                change.before.is_none_or(|before| {
                    before.source != after.source || identity(before) != identity(after)
                })
            })
        {
            conflicts.push((index, key));
        }
    }
    // A key with more than one text after the change: across the changed files, or against its
    // contexts in files the change did not touch. A key the base already gave several texts is
    // not the change's conflict.
    for (index, key) in conflicts {
        let mut sources = after_sources.get(&key).cloned().unwrap_or_default();
        if let Some(found) = entry(key) {
            let base = found
                .contexts
                .iter()
                .map(|context| context.source.as_str())
                .collect::<HashSet<_>>();
            if base.len() > 1 {
                continue;
            }
            for context in &found.contexts {
                if !files.contains(&file_key(&context.path)) {
                    sources.insert(&context.source);
                }
            }
        }
        if sources.len() > 1 {
            let change = &changes[index];
            findings.add(
                GateCheck::ConflictingSource,
                change.path,
                Some(key),
                change.after.map_or("", |o| o.source.as_str()),
                Vec::new(),
                None,
            );
        }
    }
    Ok(findings.rows)
}

fn page<T: Clone>(rows: &[T], request: PageRequest) -> Vec<T> {
    rows.iter()
        .skip(request.offset as usize)
        .take(request.limit.min(MAX_PAGE) as usize)
        .cloned()
        .collect()
}

pub fn validate(request: &ComparePointsRequest) -> Result<()> {
    require(
        valid_id(&request.point) && valid_id(&request.base),
        Error::new(ErrorCode::InvalidInput, "an invalid point"),
    )?;
    require(
        request.changes.limit <= MAX_PAGE && request.findings.limit <= MAX_PAGE,
        Error::new(ErrorCode::InvalidInput, "a page above its bound"),
    )?;
    if let Some(localization) = &request.localization {
        require(
            localization.archives.len() <= 512,
            Error::new(ErrorCode::InvalidInput, "too many cultures"),
        )?;
    }
    Ok(())
}

/// Compares a point with its base: the changes, and with the base's localization, the findings.
pub fn compare(
    configuration: &Configuration,
    request: &ComparePointsRequest,
) -> Result<PointComparison> {
    let _span = crate::scan_timings::Span::new("point.compare");
    validate(request)?;
    let mut stage_seconds = BTreeMap::new();
    let started = Instant::now();
    let before_entries = read_point(configuration, &request.base)?;
    let after_entries = read_point(configuration, &request.point)?;
    let mut paths = BTreeMap::<&str, [Option<&PointEntry>; 2]>::new();
    for entry in &before_entries {
        paths.entry(&entry.path).or_default()[0] = Some(entry);
    }
    for entry in &after_entries {
        paths.entry(&entry.path).or_default()[1] = Some(entry);
    }
    let mut records = HashMap::<&str, Record>::new();
    for entry in before_entries.iter().chain(&after_entries) {
        if let Some(key) = &entry.record
            && !records.contains_key(key.as_str())
        {
            records.insert(key, read_record(&record_file(configuration, key))?);
        }
    }
    stage_seconds.insert("compare.read".into(), started.elapsed().as_secs_f64());
    let mut lookup = match &request.localization {
        None => None,
        Some(localization) => {
            let started = Instant::now();
            let (lookup, built) = open_or_build(configuration, localization)?;
            stage_seconds.insert(
                if built {
                    "compare.lookup_build"
                } else {
                    "compare.lookup_open"
                }
                .into(),
                started.elapsed().as_secs_f64(),
            );
            Some((lookup, built))
        }
    };
    let started = Instant::now();
    let gathered = match (&mut lookup, request.gather_editor_only) {
        (Some((lookup, _)), false) => {
            gathered_editor_text(lookup, &records, &before_entries, &after_entries)?
        }
        _ => HashSet::new(),
    };
    let kept = |path: &str, occurrence: &Occurrence| {
        gathers(path, occurrence, request.gather_editor_only, &gathered)
    };
    let texts = |entry: Option<&PointEntry>| -> Vec<&Occurrence> {
        entry
            .and_then(|entry| {
                let key = entry.record.as_ref()?;
                Some((entry.path.as_str(), records.get(key.as_str())?))
            })
            .map_or_else(Vec::new, |(path, record)| {
                record
                    .occurrences
                    .iter()
                    .filter(|occurrence| kept(path, occurrence))
                    .collect()
            })
    };
    let mut counts = PointChangeCounts::default();
    let mut changes = Vec::new();
    let mut before_texts = Vec::new();
    let mut after_texts = Vec::new();
    let mut complete = true;
    let mut file_findings = Vec::new();
    for (path, [before, after]) in &paths {
        let statuses = [*before, *after].map(|entry| entry.map(|e| e.status));
        if statuses.contains(&Some(PointFileStatus::Partial)) {
            complete = false;
            file_findings.push((GateCheck::PartialRead, *path));
        }
        if statuses.contains(&Some(PointFileStatus::Failed)) {
            complete = false;
        }
        if statuses.contains(&Some(PointFileStatus::Unread)) {
            complete = false;
            file_findings.push((GateCheck::GatheredSource, *path));
        }
        let (earlier, later) = (texts(*before), texts(*after));
        let (code_before, package_before): (Vec<_>, Vec<_>) =
            earlier.iter().partition(|o| o.location == 3);
        let (code_after, package_after): (Vec<_>, Vec<_>) =
            later.iter().partition(|o| o.location == 3);
        diff_package(
            path,
            &package_before,
            &package_after,
            &mut changes,
            &mut counts,
        );
        diff_code(path, &code_before, &code_after, &mut changes, &mut counts);
        before_texts.extend(earlier);
        after_texts.extend(later);
    }
    for change in &changes {
        match change.kind {
            PointChangeKind::Added => counts.added += 1,
            PointChangeKind::Removed => counts.removed += 1,
            PointChangeKind::Rekeyed => counts.rekeyed += 1,
            PointChangeKind::Edited => counts.edited += 1,
        }
    }
    stage_seconds.insert("compare.diff".into(), started.elapsed().as_secs_f64());
    let findings = match lookup {
        None => None,
        Some((mut lookup, built)) => {
            let started = Instant::now();
            let files = paths.keys().map(|path| file_key(path)).collect();
            let mut rows = judge(&mut lookup, &changes, &before_texts, &after_texts, &files)?;
            for (check, path) in file_findings {
                rows.push(PointFinding {
                    check,
                    path: path.to_owned(),
                    namespace: None,
                    key: None,
                    source: String::new(),
                    cultures: Vec::new(),
                    earlier: None,
                });
            }
            rows.sort_by(|left, right| {
                left.check
                    .cmp(&right.check)
                    .then(left.path.cmp(&right.path))
            });
            let mut counts = PointFindingCounts::default();
            for row in &rows {
                *match row.check {
                    GateCheck::KeyChanged => &mut counts.key_changed,
                    GateCheck::ConflictingSource => &mut counts.conflicting_source,
                    GateCheck::TranslatedTextChanged => &mut counts.translated_text_changed,
                    GateCheck::TextChanged => &mut counts.text_changed,
                    GateCheck::NotGathered => &mut counts.not_gathered,
                    GateCheck::UnresolvedKey => &mut counts.unresolved_key,
                    GateCheck::Removed => &mut counts.removed,
                    GateCheck::GatheredSource => &mut counts.gathered_source,
                    GateCheck::PartialRead => &mut counts.partial_read,
                } += 1;
            }
            stage_seconds.insert("compare.judge".into(), started.elapsed().as_secs_f64());
            Some(PointFindings {
                counts,
                total: u32::try_from(rows.len())?,
                rows: page(&rows, request.findings),
                built,
            })
        }
    };
    let rows = changes.iter().map(Change::row).collect::<Vec<_>>();
    Ok(PointComparison {
        point: request.point.clone(),
        base: request.base.clone(),
        counts,
        complete,
        total: u32::try_from(rows.len())?,
        changes: page(&rows, request.changes),
        findings,
        stage_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OBJECT: &str = "/Game/UI/W_Menu.W_Menu_C:WidgetTree.Title";

    fn property(property: &str, source: &str, key: &str) -> Occurrence {
        Occurrence {
            source: source.into(),
            key: key.into(),
            object: OBJECT.into(),
            property: property.into(),
            ..Occurrence::default()
        }
    }

    fn diff(before: &[Occurrence], after: &[Occurrence]) -> (Vec<PointChange>, PointChangeCounts) {
        let mut changes = Vec::new();
        let mut counts = PointChangeCounts::default();
        diff_package(
            "Content/UI/W_Menu.uasset",
            &before.iter().collect::<Vec<_>>(),
            &after.iter().collect::<Vec<_>>(),
            &mut changes,
            &mut counts,
        );
        (changes.iter().map(Change::row).collect(), counts)
    }

    // The cases of `package-text-diff.test.ts`, which the native diff pairs the same way.
    #[test]
    fn packages_pair_place_by_place_as_the_typescript_diff_does() {
        let mut notes = property("Footer", "v1", "A4");
        notes.notes = "Version".into();
        let mut renoted = notes.clone();
        renoted.notes = "Build version".into();
        let (changes, counts) = diff(
            &[
                property("Text", "Play", "A1"),
                property("ToolTip", "Start a game", "A2"),
                property("Hint", "Press any key", "A3"),
                notes,
            ],
            &[
                property("Text", "Play", "B1"),
                property("ToolTip", "Start a new game", "A2"),
                renoted,
                property("Credits", "Credits", "A5"),
            ],
        );
        assert_eq!(
            changes
                .iter()
                .map(|c| (
                    c.kind,
                    c.place.property.as_str(),
                    c.source_changed,
                    c.notes_changed
                ))
                .collect::<Vec<_>>(),
            [
                (PointChangeKind::Rekeyed, "Text", false, false),
                (PointChangeKind::Edited, "ToolTip", true, false),
                (PointChangeKind::Edited, "Footer", false, true),
                (PointChangeKind::Added, "Credits", false, false),
                (PointChangeKind::Removed, "Hint", false, false),
            ]
        );
        assert_eq!(counts.unchanged, 0);
    }

    #[test]
    fn editor_text_follows_the_targets_package_setting_unless_unreal_gathered_it() {
        const PATH: &str = "Content/UI/W_Menu.uasset";
        // Encoded audiences (text-audience.ts): the gather table's editor-only bit, the `k2_node`
        // policy row's reason, a developer folder's, and the table's runtime bit.
        let table_editor = 1;
        let policy_editor = 1 | (4 << 2);
        let developer_folder = 1 | (2 << 2);
        let runtime = 1 << 2;
        let text = |key: &str, audience: u32| Occurrence {
            audience,
            ..property("PinFriendlyName", "Target", key)
        };
        let gathered = HashSet::from([(file_key(PATH), String::new(), "Kept".to_owned())]);
        for (occurrence, judged) in [
            (text("A1", table_editor), false),
            (text("A2", policy_editor), false),
            (text("Kept", policy_editor), true),
            (text("A3", developer_folder), true),
            (text("A4", runtime), true),
        ] {
            assert_eq!(gathers(PATH, &occurrence, false, &gathered), judged);
            assert!(gathers(PATH, &occurrence, true, &gathered));
        }
        assert!(!gathers(
            "Content/UI/W_Other.uasset",
            &text("Kept", policy_editor),
            false,
            &gathered
        ));
    }

    #[test]
    fn a_new_namespace_a_table_reference_or_a_lost_key_is_a_rekey() {
        let before = [property("Text", "Play", "A1")];
        let mut namespaced = property("Text", "Play", "A1");
        namespaced.namespace = "Menu".into();
        let mut table = property("Text", "Play", "A1");
        table.identity = 1;
        table.namespace = "/Game/ST_Menu.ST_Menu".into();
        let mut invariant = property("Text", "Play!", "");
        invariant.identity = 2;
        for after in [namespaced, table, invariant] {
            let (changes, _) = diff(&before, std::slice::from_ref(&after));
            assert_eq!(changes.len(), 1);
            assert_eq!(changes[0].kind, PointChangeKind::Rekeyed);
            assert_eq!(changes[0].source_changed, after.source != "Play");
        }
    }

    #[test]
    fn places_line_up_by_position_in_the_package_not_its_name() {
        let mut relative = property("Text", "Play", "A1");
        relative.object = "W_Menu_C:WidgetTree.Title".into();
        let mut branched = property("Text", "Play", "A1");
        branched.object = "/Game/Branched/UI/W_Menu.W_Menu_C:WidgetTree.Title".into();
        let (changes, counts) = diff(&[relative], &[branched]);
        assert!(changes.is_empty());
        assert_eq!(counts.unchanged, 1);
    }

    #[test]
    fn cells_entries_and_properties_stay_apart() {
        let cell = |row: &str| Occurrence {
            location: 1,
            object: "/Game/Data/DT_Items.DT_Items".into(),
            row: row.into(),
            property: "Name".into(),
            source: "Sword".into(),
            key: "Sword".into(),
            ..Occurrence::default()
        };
        let entry = Occurrence {
            location: 2,
            row: "Sword".into(),
            ..cell("Sword")
        };
        let (changes, counts) = diff(&[cell("Sword"), entry.clone()], &[cell("Blade"), entry]);
        assert_eq!(
            changes
                .iter()
                .map(|c| (c.kind, c.place.entry.as_str()))
                .collect::<Vec<_>>(),
            [
                (PointChangeKind::Added, "Blade"),
                (PointChangeKind::Removed, "Sword")
            ]
        );
        assert_eq!(counts.unchanged, 1);
    }

    #[test]
    fn identical_texts_pair_first_at_a_place_with_several() {
        let (changes, counts) = diff(
            &[
                property("Lines", "Hello", "L1"),
                property("Lines", "Goodbye", "L2"),
                property("Lines", "See you", "L3"),
            ],
            &[
                property("Lines", "Goodbye", "L2"),
                property("Lines", "Hi", "L1"),
            ],
        );
        assert_eq!(
            changes
                .iter()
                .map(|c| (c.kind, c.source_changed))
                .collect::<Vec<_>>(),
            [
                (PointChangeKind::Edited, true),
                (PointChangeKind::Removed, false)
            ]
        );
        assert_eq!(
            changes[1].before.as_ref().map(|t| t.key.as_str()),
            Some("L3")
        );
        assert_eq!(counts.unchanged, 1);
    }
}
