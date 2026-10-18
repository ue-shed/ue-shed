//! Bounded source/PO updates over existing immutable numeric columns.
#[path = "join_incremental_sources.rs"]
mod sources;
use crate::join::{JoinInput, JoinOutcome};
use crate::join_columns::{column, layer};
use crate::join_policy::words;
use crate::snapshot::Reader;
use crate::store::{Store, dictionary_selected_strings, digest, section};
use crate::{Result, require};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

thread_local! {static DIAGNOSTICS:RefCell<Value>=const{RefCell::new(Value::Null)};}
pub fn diagnostics() -> Value {
    DIAGNOSTICS.with(|value| value.borrow().clone())
}
pub(crate) fn reset() {
    DIAGNOSTICS.with(|value| *value.borrow_mut() = json!({"attempted":false,"fullJoin":false}));
}
pub(crate) fn full() {
    note("fullJoin", json!(true));
}
pub(crate) fn note(key: &str, value: Value) {
    DIAGNOSTICS.with(|state| state.borrow_mut()[key] = value);
}
fn fallback(reason: &str) -> Result<Option<JoinOutcome>> {
    note("fallback", json!(reason));
    Ok(None)
}
fn parse(bytes: &[u8]) -> Result<Value> {
    match serde_json::from_slice(bytes) {
        Ok(value) => Ok(value),
        Err(_) => crate::json_value::parse(std::str::from_utf8(bytes)?),
    }
}

struct Files {
    opened: HashMap<String, (Reader, Value)>,
    columns: HashMap<(String, String), Vec<u32>>,
}
impl Files {
    fn new() -> Self {
        Self {
            opened: HashMap::new(),
            columns: HashMap::new(),
        }
    }
    fn open(&mut self, store: &Store, key: &str) -> Result<&mut (Reader, Value)> {
        if !self.opened.contains_key(key) {
            self.opened.insert(
                key.into(),
                layer(store, key)?.ok_or("missing update input")?,
            );
        }
        Ok(self
            .opened
            .get_mut(key)
            .ok_or("missing opened update input")?)
    }
    fn col(&mut self, store: &Store, key: &str, field: &str) -> Result<&[u32]> {
        let cache = (key.to_owned(), field.to_owned());
        if !self.columns.contains_key(&cache) {
            let (reader, record) = self.open(store, key)?;
            let values = column(reader, record, field)?;
            self.columns.insert(cache.clone(), values);
        }
        Ok(&self.columns[&cache])
    }
    fn value(&mut self, store: &Store, key: &str, field: &str, row: usize) -> Result<u32> {
        self.col(store, key, field)?
            .get(row)
            .copied()
            .ok_or_else(|| "input row out of bounds".into())
    }
    fn meta(&mut self, store: &Store, key: &str) -> Result<Value> {
        let (reader, _) = self.open(store, key)?;
        parse(&section(reader, "file.meta")?)
    }
}
struct Joined {
    raw: Reader,
    record: Value,
    base: Reader,
    base_record: Value,
    meta: Value,
    columns: HashMap<String, Arc<[u32]>>,
}
impl Joined {
    fn open(store: &Store, key: &str) -> Result<Self> {
        let (mut raw, record) = layer(store, key)?.ok_or("missing joined input")?;
        let meta = parse(&section(&mut raw, "join.meta")?)?;
        let base_key = meta["base"].as_str().unwrap_or(key);
        let (base, base_record) = layer(store, base_key)?.ok_or("missing joined base")?;
        Ok(Self {
            raw,
            record,
            base,
            base_record,
            meta,
            columns: HashMap::new(),
        })
    }
    fn original_col(&mut self, name: &str) -> Result<Arc<[u32]>> {
        if !self.columns.contains_key(name) {
            let mut values = if let Some(parts) = self.meta["chunks"][name].as_array() {
                let mut values = Vec::new();
                for part in parts {
                    values.extend(column(
                        &mut self.base,
                        &self.base_record,
                        part.as_str().ok_or("chunk name")?,
                    )?);
                }
                values
            } else {
                column(
                    &mut self.base,
                    &self.base_record,
                    self.meta["aliases"][name].as_str().unwrap_or(name),
                )?
            };
            if let Some(field) = self.meta["patches"][name].as_str() {
                let rows = column(
                    &mut self.raw,
                    &self.record,
                    self.meta["patchRows"][name]
                        .as_str()
                        .unwrap_or("patch.rows"),
                )?;
                let patch = column(&mut self.raw, &self.record, field)?;
                require(rows.len() == patch.len(), "patch length")?;
                for (i, row) in rows.iter().enumerate() {
                    require(i == 0 || rows[i - 1] < *row, "patch row order")?;
                    let value = values.get_mut(*row as usize).ok_or("patch row bounds")?;
                    *value = patch[i];
                }
            }
            self.columns.insert(name.into(), values.into());
        }
        Ok(self.columns[name].clone())
    }
    fn col(&mut self, name: &str) -> Result<Arc<[u32]>> {
        if !self.columns.contains_key(name) {
            for kind in ["raw", "slice"] {
                let prefix = format!("query.{kind}.");
                if self.meta["sourcePatches"][kind].is_object()
                    && ["source_start", "source_end", "sources"]
                        .iter()
                        .any(|field| name == format!("{prefix}{field}"))
                {
                    let patch = self.meta["sourcePatches"][kind].clone();
                    let rows = column(
                        &mut self.raw,
                        &self.record,
                        patch["rows"].as_str().ok_or("source patch rows")?,
                    )?;
                    let starts = column(
                        &mut self.raw,
                        &self.record,
                        patch["starts"].as_str().ok_or("source patch starts")?,
                    )?;
                    let values = column(
                        &mut self.raw,
                        &self.record,
                        patch["values"].as_str().ok_or("source patch values")?,
                    )?;
                    let original = [
                        self.original_col(&(prefix.clone() + "source_start"))?
                            .to_vec(),
                        self.original_col(&(prefix.clone() + "source_end"))?
                            .to_vec(),
                        self.original_col(&(prefix.clone() + "sources"))?.to_vec(),
                    ];
                    let output = crate::source_patch::splice(
                        [&original[0], &original[1], &original[2]],
                        &rows,
                        &starts,
                        &values,
                    )?;
                    for (field, values) in ["source_start", "source_end", "sources"]
                        .into_iter()
                        .zip(output)
                    {
                        self.columns
                            .insert(format!("{prefix}{field}"), values.into());
                    }
                    break;
                }
            }
        }
        self.original_col(name)
    }
    fn get(&mut self, name: &str, row: usize) -> Result<u32> {
        self.col(name)?
            .get(row)
            .copied()
            .ok_or_else(|| format!("joined row outside {name}").into())
    }
}
type Hot = BTreeMap<String, BTreeMap<u32, u32>>;
fn set(hot: &mut Hot, field: &str, row: usize, value: u32) {
    hot.entry(field.into())
        .or_default()
        .insert(row as u32, value);
}
fn dependency<'a>(meta: &'a Value, name: &str) -> Option<&'a str> {
    meta["dependencies"][name].as_str()
}
fn package_value(
    store: &Store,
    files: &mut Files,
    names: &[String],
    starts: &[u32],
    member: usize,
    field: &str,
) -> Result<u32> {
    let shard = starts
        .partition_point(|start| *start <= member as u32)
        .saturating_sub(1)
        .min(names.len() - 1);
    files.value(
        store,
        &names[shard],
        &format!("occurrence.{field}"),
        member - starts[shard] as usize,
    )
}

pub(crate) fn refresh(
    store: &mut Store,
    input: &JoinInput,
    key: &str,
    dependencies: &Value,
) -> Result<Option<JoinOutcome>> {
    note("attempted", json!(true));
    if input.force == Some(true) {
        return fallback("forced");
    }
    let Some(previous_key) = store.root["active"]["joined"].as_str().map(str::to_owned) else {
        return fallback("no-base");
    };
    if !previous_key.starts_with("joined-native-v2:") {
        return fallback("native-format");
    }
    let (mut header, _) = layer(store, &previous_key)?.ok_or("missing joined header")?;
    let candidate = parse(&section(&mut header, "join.meta")?)?;
    if candidate["generation"] != store.root["generation"]
        || candidate["base"].as_str().is_some_and(|base| {
            store.root["layers"].get(base).is_none() || store.root["active"]["joined-base"] != base
        })
    {
        return fallback("generation-or-retired-base");
    }
    drop(header);
    let mut joined = Joined::open(store, &previous_key)?;
    let meta = joined.meta.clone();
    if meta["generation"] != store.root["generation"]
        || meta["oldCandidates"] != 0
        || meta["ambiguous"] != 0
        || meta["pairs"].as_array().is_some_and(|v| !v.is_empty())
    {
        return fallback("generation-or-key-matching");
    }
    let Some(graph) = crate::dependency_graph::Graph::open(store, &previous_key)? else {
        return fallback("dependency-index-revision");
    };
    let current = serde_json::to_value(input)?;
    for field in [
        "projectRoot",
        "target",
        "review",
        "keyChangePairs",
        "fileErrors",
        "fileDiagnostics",
    ] {
        let old = crate::join::policy_view(&meta["input"][field], &BTreeMap::new());
        let new = crate::join::policy_view(&current[field], &BTreeMap::new());
        if old != new {
            return fallback("input-policy");
        }
    }
    // Provenance is descriptive evidence, not a join predicate. A changed PO's fingerprint
    // must advance in the new metadata without forcing a full join. Errors/diagnostics above
    // still guard availability semantics; metadata["input"] below retains the new provenance.
    let prior = meta["dependencies"].as_object().ok_or("old dependencies")?;
    let next = dependencies.as_object().ok_or("new dependencies")?;
    if prior.len() != next.len() || next.keys().any(|name| !prior.contains_key(name)) {
        return fallback("dependency-set");
    }
    let changed = next
        .iter()
        .filter(|(name, value)| prior.get(*name) != Some(*value))
        .map(|(name, value)| {
            Ok((
                name.clone(),
                prior[name].as_str().ok_or("old key")?.to_owned(),
                value.as_str().ok_or("new key")?.to_owned(),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    // A timestamp-only provenance update changes the join key without changing an input layer.
    // Preserve the existing columns and patches through the same publication path with zero edits.
    let cultures = input.target["cultures"]
        .as_array()
        .ok_or("cultures")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "culture".into())
        })
        .collect::<Result<Vec<_>>>()?;
    let names = meta["packageNames"]
        .as_array()
        .ok_or("package names")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "package name".into())
        })
        .collect::<Result<Vec<_>>>()?;
    let starts = meta["packageStarts"]
        .as_array()
        .ok_or("package starts")?
        .iter()
        .map(|v| {
            v.as_u64()
                .map(|v| v as u32)
                .ok_or_else(|| "package start".into())
        })
        .collect::<Result<Vec<_>>>()?;
    let mut files = Files::new();
    let mut edits = BTreeMap::new();
    let mut previous_sources = BTreeMap::new();
    let mut changed_pos = HashSet::new();
    let mut po_dirty = Vec::new();
    for (name, before, after) in &changed {
        if store.root["layers"].get(before).is_none() {
            return fallback("retired-input");
        }
        if name.starts_with("package-text.") {
            let Some(shard) = names.iter().position(|value| value == name) else {
                return fallback("package-shard");
            };
            let fields = files
                .open(store, before)?
                .0
                .entries
                .iter()
                .map(|e| e.name.clone())
                .collect::<Vec<_>>();
            for field in fields {
                if matches!(
                    field.as_str(),
                    "shared.meta" | "package.signature" | "occurrence.source"
                ) {
                    continue;
                }
                let a = files.col(store, before, &field)?.to_vec();
                if a != files.col(store, after, &field)? {
                    if matches!(
                        field.as_str(),
                        "occurrence.namespace" | "occurrence.key" | "occurrence.identity"
                    ) {
                        note("changeKind", json!("reference-or-identity"));
                        return fallback("reference-membership");
                    }
                    return fallback("package-structure");
                }
            }
            let old = files.col(store, before, "occurrence.source")?.to_vec();
            let new = files.col(store, after, "occurrence.source")?;
            if old.len() != new.len() {
                return fallback("source-count");
            }
            for (index, (&a, &b)) in old.iter().zip(new).enumerate() {
                if a != b {
                    let member = starts[shard] as usize + index;
                    edits.insert(member, b);
                    previous_sources.insert(member, a);
                }
            }
            if edits.len() > 8192 {
                return fallback("edit-bound");
            }
        } else {
            let Some(ci) = cultures.iter().position(|culture| {
                input.target["outputPaths"]["portableObjects"][culture] == *name
            }) else {
                return fallback("unsupported-input");
            };
            if files.meta(store, before)?["hasSourceText"]
                != files.meta(store, after)?["hasSourceText"]
            {
                return fallback("po-source-mode");
            }
            for field in ["entry.namespace", "entry.key", "entry.ordinal"] {
                let old = files.col(store, before, field)?.to_vec();
                if old != files.col(store, after, field)? {
                    return fallback("po-identity");
                }
            }
            let old = files.col(store, before, "entry.options")?.to_vec();
            let new = files.col(store, after, "entry.options")?.to_vec();
            if old.len() != new.len() || old.iter().zip(&new).any(|(a, b)| a & 16 != b & 16) {
                return fallback("po-context-mode");
            }
            let mut dirty = vec![false; old.len()];
            let fields = files
                .open(store, after)?
                .0
                .entries
                .iter()
                .filter(|e| e.name.starts_with("entry."))
                .map(|e| e.name.clone())
                .collect::<Vec<_>>();
            for field in fields {
                let a = files.col(store, before, &field)?.to_vec();
                let b = files.col(store, after, &field)?;
                if a.len() != b.len() {
                    return fallback("po-column-length");
                }
                for (row, (a, b)) in a.iter().zip(b).enumerate() {
                    dirty[row] |= a != b;
                }
            }
            for (row, dirty) in dirty.into_iter().enumerate() {
                if dirty && new[row] & 16 == 0 {
                    po_dirty.push((
                        ci,
                        files.value(store, after, "entry.namespace", row)?,
                        files.value(store, after, "entry.key", row)?,
                    ));
                }
            }
            changed_pos.insert(ci);
        }
    }
    let mut affected = BTreeSet::new();
    let mut package_lines = BTreeSet::new();
    let mut reference_consumers = BTreeSet::new();
    for (member, source) in &edits {
        let route = graph.route(*member as u32)?;
        graph.move_source(*member as u32, previous_sources[member], *source)?;
        affected.insert(route.line as usize);
        package_lines.insert(route.line as usize);
        for consumer in graph.consumers(*member as u32)? {
            let route = graph.route(consumer)?;
            reference_consumers.insert(consumer);
            affected.insert(route.line as usize);
            package_lines.insert(route.line as usize);
        }
    }
    note(
        "changeKind",
        json!(if edits.is_empty() {
            "localization-or-provenance"
        } else {
            "text-value"
        }),
    );
    note(
        "referenceConsumersVisited",
        json!(reference_consumers.len()),
    );
    let reasons = joined.col("line.reasons")?;
    for (_, namespace, key) in po_dirty {
        if let Some(row) = graph.identity_line(namespace, key)? {
            affected.insert(row as usize);
        }
    }
    if affected.len() > 8192 {
        return fallback("affected-bound");
    }
    note("sourceEdits", json!(edits.len()));
    note("affectedLines", json!(affected.len()));
    note("poCultures", json!(changed_pos.len()));
    let empty = store.intern("identity", &[String::new()])?[0];
    let wanted = edits
        .values()
        .chain(previous_sources.values())
        .copied()
        .collect::<BTreeSet<_>>();
    let mut text = dictionary_selected_strings(&store.directory, &store.root, &wanted)?;
    let mut replacements = BTreeMap::new();
    let mut variants = BTreeMap::new();
    {
        let mut sources = sources::Sources {
            store,
            files: &mut files,
            joined: &mut joined,
            names: &names,
            starts: &starts,
            text: &mut text,
            graph: &graph,
            raw_ids: None,
        };
        for row in &package_lines {
            if sources.joined.get("line.split_unit", *row)? != 0
                || reasons[*row] & ((1 << 9) | (1 << 10)) != 0
            {
                return fallback("split-unit");
            }
            let Some((source, count)) = sources.line(*row, &graph.members("line", *row as u32)?)?
            else {
                return fallback("source-group-structure");
            };
            replacements.insert(*row, source);
            variants.insert(*row, count);
        }
    }
    let manifest_name = input.target["outputPaths"]["manifest"]
        .as_str()
        .unwrap_or("<manifest>");
    let manifest_rows = joined.col("manifest.rows")?;
    let mut hot = Hot::new();
    let mut reviews = Vec::new();
    for row in &affected {
        let row = *row;
        let source = replacements
            .get(&row)
            .copied()
            .unwrap_or(joined.get("line.source", row)?);
        let ms = joined.get("line.manifest_start", row)? as usize;
        let me = joined.get("line.manifest_end", row)? as usize;
        let manifest_source = if ms != me {
            files.value(
                store,
                dependency(&meta, manifest_name).ok_or("manifest dependency")?,
                "entry.source",
                manifest_rows[ms] as usize,
            )?
        } else {
            empty
        };
        let mut structural = joined.get("line.facts", row)?;
        let row_reasons = if replacements.contains_key(&row) {
            (reasons[row] & !(1 << 11)) | if variants[&row] > 1 { 1 << 11 } else { 0 }
        } else {
            reasons[row]
        };
        if replacements.contains_key(&row) {
            structural &= !(1 << 5);
            if ms != me && variants[&row] == 1 && source != manifest_source {
                structural |= 1 << 5;
            }
            set(&mut hot, "line.source", row, source);
            set(&mut hot, "line.source_words", row, words(&text[&source]));
            set(&mut hot, "line.facts", row, structural);
            set(&mut hot, "line.reasons", row, row_reasons);
        }
        let mut problems = joined.get("line.problems", row)? & (1 | 32);
        if row_reasons & (1 << 11) != 0 {
            problems |= 2;
        }
        let mut translation_problem = false;
        for (ci, culture) in cultures.iter().enumerate() {
            let prefix = format!("c{ci}.");
            let mut facts = (joined.get(&(prefix.clone() + "facts"), row)?
                & !((1 << 5) | (1 << 3) | (1 << 9)))
                | (structural & (1 << 5));
            let unknown = (joined.get(&(prefix.clone() + "reasons"), row)? & !(1 << 11))
                | (row_reasons & (1 << 11));
            let archive_path = input.target["outputPaths"]["archives"][culture]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("<archive:{culture}>"));
            let po_path = input.target["outputPaths"]["portableObjects"][culture]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("<po:{culture}>"));
            let archive_name = archive_path.as_str();
            let po_name = po_path.as_str();
            let ai = joined.get(&(prefix.clone() + "archive"), row)?;
            let pi = joined.get(&(prefix.clone() + "po"), row)?;
            let archive_key = dependency(&meta, archive_name);
            let po_key = store.root["active"][po_name].as_str().map(str::to_owned);
            let at = if ai == 0 {
                empty
            } else {
                let key = archive_key.ok_or("archive missing")?;
                let options = files.value(store, key, "entry.options", ai as usize - 1)?;
                files.value(
                    store,
                    key,
                    if options & 128 != 0 {
                        "entry.source"
                    } else {
                        "entry.translation"
                    },
                    ai as usize - 1,
                )?
            };
            let pt = if pi == 0 {
                empty
            } else {
                let key = po_key.as_deref().ok_or("PO missing")?;
                let options = files.value(store, key, "entry.options", pi as usize - 1)?;
                if options & 64 == 0 {
                    empty
                } else {
                    files.value(
                        store,
                        key,
                        if options & 128 != 0 {
                            "entry.source"
                        } else {
                            "entry.translation"
                        },
                        pi as usize - 1,
                    )?
                }
            };
            let archive_failure = input
                .file_errors
                .as_ref()
                .and_then(|errors| errors.get(archive_name))
                .map(String::as_str);
            let archive_available = archive_key.is_some()
                || archive_failure.is_none_or(|failure| failure == "file_missing");
            if archive_available
                && unknown & ((1 << 4) | (1 << 5)) == 0
                && pi != 0
                && pt != empty
                && pt != at
            {
                facts |= 1 << 3;
            }
            let mut operative = unknown;
            for (path, bit) in [(archive_name, 1), (po_name, 2)] {
                if dependency(&meta, path).is_none()
                    && input
                        .file_errors
                        .as_ref()
                        .and_then(|errors| errors.get(path))
                        .is_none_or(|failure| failure == "file_missing")
                {
                    operative &= !(1 << bit);
                }
            }
            if operative != 0 {
                facts |= 1 << 9;
            }
            let state = [8, 4, 6, 7, 5, 9, 3, 2, 1, 0]
                .into_iter()
                .find(|state| facts & (1 << state) != 0)
                .unwrap_or(9);
            set(&mut hot, &(prefix.clone() + "facts"), row, facts);
            set(&mut hot, &(prefix.clone() + "state"), row, state);
            set(&mut hot, &(prefix.clone() + "reasons"), row, unknown);
            translation_problem |= state == 1 || state == 2 || facts & (1 << 3) != 0;
            if state == 4 {
                problems |= 4;
            }
            if state == 5 {
                problems |= 8;
            }
            if let Some(review) = &input.review
                && review["target"] == input.target["name"]
                && reasons[row] & ((1 << 9) | (1 << 10)) == 0
            {
                let record = joined.get(&(prefix.clone() + "review_record"), row)?;
                if record != 0 {
                    let fingerprint = review["records"][record as usize - 1]["fingerprint"]
                        .as_str()
                        .ok_or("review fingerprint")?
                        .to_owned();
                    let shipped = if facts & (1 << 3) != 0 {
                        (pi != 0).then_some(pt)
                    } else {
                        (ai != 0).then_some(at)
                    };
                    reviews.push((
                        row,
                        ci,
                        if ms != me { manifest_source } else { source },
                        shipped,
                        fingerprint,
                    ));
                }
            }
        }
        if translation_problem {
            problems |= 16;
        }
        set(
            &mut hot,
            "line.problems",
            row,
            if problems == 0 { 64 } else { problems },
        );
    }
    if !reviews.is_empty() {
        let ids = reviews
            .iter()
            .flat_map(|(_, _, source, translation, _)| std::iter::once(*source).chain(*translation))
            .collect();
        let values = dictionary_selected_strings(&store.directory, &store.root, &ids)?;
        for (row, ci, source, translation, expected) in reviews {
            let source = String::from_utf16_lossy(
                &crate::wtf8::Wtf8Buf::from_view(&values[&source]).to_utf16(),
            );
            let translation = translation
                .map(|id| {
                    String::from_utf16_lossy(
                        &crate::wtf8::Wtf8Buf::from_view(&values[&id]).to_utf16(),
                    )
                })
                .unwrap_or_else(|| "\0absent".into());
            set(
                &mut hot,
                &format!("c{ci}.review"),
                row,
                if digest(format!("{source}\0{translation}").as_bytes()) == expected {
                    2
                } else {
                    3
                },
            );
        }
    }
    for (member, source) in &edits {
        set(&mut hot, "query.occurrence.sources", *member, *source);
    }
    let source_edits = {
        let mut sources = sources::Sources {
            store,
            files: &mut files,
            joined: &mut joined,
            names: &names,
            starts: &starts,
            text: &mut text,
            graph: &graph,
            raw_ids: None,
        };
        let Some(edits) = sources.queries(&package_lines, &edits, &previous_sources, &mut hot)?
        else {
            return fallback("query-source-overlay-bound");
        };
        edits
    };
    let base = meta["base"].as_str().unwrap_or(&previous_key).to_owned();
    if key == base {
        // Returning to a retained immutable base is an edge/value undo, not another build.
        // The eligibility checks and graph edits above established the same memberships.
        let bytes = store.root["layers"][&base]["bytes"]
            .as_u64()
            .ok_or("base bytes")?;
        graph.commit(store, key)?;
        let active = store.root["active"]
            .as_object_mut()
            .ok_or("active layers")?;
        active.insert("joined".into(), json!(base));
        active.remove("joined-base");
        store.publish_root()?;
        note("reusedBase", json!(true));
        return Ok(Some(JoinOutcome {
            rebuilt: true,
            strategy: Some("incremental".into()),
            key: key.into(),
            bytes,
            count: meta["count"].as_u64().map(|count| count as u32),
            key_changes: Some(0),
            affected_lines: Some(affected.len() as u32),
        }));
    }
    let mut rows = affected
        .iter()
        .map(|row| *row as u32)
        .collect::<BTreeSet<_>>();
    if meta["patches"]
        .as_object()
        .is_some_and(|fields| !fields.is_empty())
    {
        rows.extend(column(&mut joined.raw, &joined.record, "patch.rows")?);
    }
    if rows.len() > 8192 {
        return fallback("overlay-bound");
    }
    let rows = rows.into_iter().collect::<Vec<_>>();
    let mut fields = hot.keys().cloned().collect::<BTreeSet<_>>();
    if let Some(prior) = meta["patches"].as_object() {
        fields.extend(prior.keys().cloned());
    }
    let mut physical = vec![("patch.rows".into(), String::new(), rows.clone())];
    let Some(source_patches) =
        sources::pack(&mut joined, &source_edits, &mut physical, &mut fields)?
    else {
        return fallback("source-overlay-bound");
    };
    let mut patches = serde_json::Map::new();
    let mut patch_rows = serde_json::Map::new();
    for field in fields {
        let selected = if field.starts_with("query.") {
            let mut selected = hot
                .get(&field)
                .map(|edits| edits.keys().copied().collect::<BTreeSet<_>>())
                .unwrap_or_default();
            if meta["patches"][&field].is_string() {
                selected.extend(column(
                    &mut joined.raw,
                    &joined.record,
                    meta["patchRows"][&field].as_str().unwrap_or("patch.rows"),
                )?);
            }
            selected.into_iter().collect::<Vec<_>>()
        } else {
            rows.clone()
        };
        if selected.len() > 8192 {
            return fallback("field-overlay-bound");
        }
        let current = joined.col(&field)?;
        let values = selected
            .iter()
            .map(|row| {
                hot.get(&field)
                    .and_then(|edits| edits.get(row))
                    .copied()
                    .unwrap_or(current[*row as usize])
            })
            .collect::<Vec<_>>();
        let name = format!("patch.{}", physical.len());
        patches.insert(field.clone(), json!(name));
        if field.starts_with("query.") {
            let index = format!("{name}.rows");
            patch_rows.insert(field.clone(), json!(index));
            physical.push((index, String::new(), selected));
        }
        physical.push((
            name,
            if field == "line.source" || field.ends_with(".sources") {
                "source".into()
            } else {
                String::new()
            },
            values,
        ));
    }
    let mut metadata = meta.clone();
    metadata["input"] = current;
    metadata["dependencies"] = dependencies.clone();
    metadata["base"] = json!(base);
    metadata["patches"] = json!(patches);
    metadata["patchRows"] = json!(patch_rows);
    if source_patches
        .as_object()
        .is_some_and(|patches| !patches.is_empty())
    {
        metadata["version"] = json!(4);
    }
    metadata["sourcePatches"] = source_patches;
    note(
        "numericColumnsLoaded",
        json!(joined.columns.len() + files.columns.len()),
    );
    note("decodedSourceStrings", json!(text.len()));
    note("fallback", Value::Null);
    graph.commit(store, key)?;
    let record = store.publish_global(
        "joined",
        key,
        &physical,
        &crate::join::metadata_bytes(&metadata)?,
        &BTreeMap::from([("joined-base".into(), base.clone())]),
        &[],
    )?;
    Ok(Some(JoinOutcome {
        rebuilt: true,
        strategy: Some("incremental".into()),
        key: key.into(),
        bytes: record["bytes"].as_u64().ok_or("overlay bytes")?
            + store.root["layers"][&base]["bytes"]
                .as_u64()
                .ok_or("base bytes")?,
        count: meta["count"].as_u64().map(|count| count as u32),
        key_changes: Some(meta["pairs"].as_array().map_or(0, |pairs| pairs.len()) as u32),
        affected_lines: Some(affected.len() as u32),
    }))
}
