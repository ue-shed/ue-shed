//! Native columnar join. Policies remain independently testable; authored rows stay numeric.
use crate::join_columns::*;
use crate::join_policy::*;
use crate::store::{Store, dictionary_bytes, digest};
use crate::{Result, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub(crate) const LINE_FIELDS: [&str; 22] = [
    "namespace",
    "key",
    "source",
    "source_words",
    "source_visible",
    "occ_start",
    "occ_end",
    "manifest_start",
    "manifest_end",
    "reasons",
    "facts",
    "problems",
    "origins",
    "editing",
    "notes",
    "key_change",
    "folder_start",
    "folder_end",
    "file_start",
    "file_end",
    "split_unit",
    "audience",
];
pub(crate) const CULTURE_FIELDS: [&str; 7] = [
    "state",
    "facts",
    "reasons",
    "archive",
    "po",
    "review",
    "review_record",
];
pub(crate) const L_NS: usize = 0;
pub(crate) const L_KEY: usize = 1;
pub(crate) const L_SOURCE: usize = 2;
pub(crate) const L_REASONS: usize = 9;
pub(crate) const L_PROBLEMS: usize = 11;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinInput {
    pub project_root: String,
    pub target: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_errors: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_provenances: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_diagnostics: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_change_pairs: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub string_code_units: Option<BTreeMap<String, Vec<u16>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JoinOutcome {
    pub rebuilt: bool,
    pub strategy: Option<String>,
    pub key: String,
    pub bytes: u64,
    pub count: Option<u32>,
    pub key_changes: Option<u32>,
    pub affected_lines: Option<u32>,
}
#[derive(Clone, Copy)]
pub(crate) struct Group {
    pub os: usize,
    pub oe: usize,
    pub ms: usize,
    pub me: usize,
    pub ns: u32,
    pub key: u32,
}
pub(crate) struct Joined {
    pub line: Vec<Vec<u32>>,
    pub cultures: Vec<Vec<Vec<u32>>>,
    pub groups: Vec<Group>,
    pub order: Vec<u32>,
    pub raw_order: Vec<u32>,
    pub unit: Vec<u32>,
    pub next: Vec<u32>,
    pub package_files: Vec<u32>,
    pub empty: u32,
    pub packages: PackageColumns,
    pub manifest: FileColumns,
    pub archives: Vec<FileColumns>,
    pub pos: Vec<FileColumns>,
    pub strings: Vec<String>,
    pub unit_ids: Vec<String>,
}
impl Joined {
    pub fn string(&self, id: u32) -> &str {
        &self.strings[id as usize]
    }
    pub fn saved(&self, row: usize) -> bool {
        self.groups[row].os < self.groups[row].oe
    }
    pub fn resolved(&self, row: usize) -> bool {
        self.line[L_REASONS][row] & ((1 << 9) | (1 << 10)) == 0
    }
    pub fn matches(&self, row: usize, state: u32) -> bool {
        self.cultures.iter().any(|c| c[0][row] == state)
    }
    pub fn manifest_source(&self, row: usize) -> u32 {
        let g = self.groups[row];
        if g.ms == g.me {
            self.line[L_SOURCE][row]
        } else {
            self.manifest.columns[SOURCE][self.manifest.order[g.ms] as usize]
        }
    }
    pub fn translation(&self, row: usize, ci: usize) -> Option<u32> {
        let marks = &self.cultures[ci];
        let po = marks[1][row] & (1 << 3) != 0;
        let index = marks[if po { 4 } else { 3 }][row].checked_sub(1)? as usize;
        let c = &if po {
            &self.pos[ci]
        } else {
            &self.archives[ci]
        }
        .columns;
        Some(
            c[if c[OPTIONS][index] & 128 != 0 {
                SOURCE
            } else {
                TRANSLATION
            }][index],
        )
    }
}
pub(crate) fn ordinal(a: &str, b: &str) -> Ordering {
    if !a.chars().any(|c| ('\u{f0000}'..='\u{f0800}').contains(&c))
        && !b.chars().any(|c| ('\u{f0000}'..='\u{f0800}').contains(&c))
    {
        return a.encode_utf16().cmp(b.encode_utf16());
    }
    crate::wtf8::Wtf8Buf::from_view(a)
        .to_utf16()
        .cmp(&crate::wtf8::Wtf8Buf::from_view(b).to_utf16())
}
/// Match the scanner and TypeScript: separators end a component before filename suffixes.
pub(crate) fn package_path_order(a: &[u8], b: &[u8]) -> Ordering {
    a.iter()
        .map(|byte| {
            if matches!(byte, b'/' | b'\\') {
                0
            } else {
                *byte
            }
        })
        .cmp(b.iter().map(|byte| {
            if matches!(byte, b'/' | b'\\') {
                0
            } else {
                *byte
            }
        }))
}
#[expect(
    clippy::expect_used,
    reason = "ICU ships compiled default collation data; no external locale or provider is accepted"
)]
pub(crate) fn locale(a: &str, b: &str) -> Ordering {
    static COLLATOR: std::sync::OnceLock<icu_collator::CollatorBorrowed<'static>> =
        std::sync::OnceLock::new();
    let collator = COLLATOR.get_or_init(|| {
        icu_collator::Collator::try_new(Default::default(), Default::default())
            .expect("compiled collation data")
    });
    if a.chars()
        .chain(b.chars())
        .any(|c| ('\u{f0000}'..='\u{f0800}').contains(&c))
    {
        collator.compare_utf16(
            &crate::wtf8::Wtf8Buf::from_view(a).to_utf16(),
            &crate::wtf8::Wtf8Buf::from_view(b).to_utf16(),
        )
    } else {
        collator.compare(a, b)
    }
}
fn compare_unit(p: &PackageColumns, a: usize, b: usize, empty: u32) -> Ordering {
    let c = &p.occurrence;
    let kind = |row: usize| {
        if c[O_KEY][row] == empty {
            2
        } else {
            c[O_IDENTITY][row].min(2)
        }
    };
    let order = kind(a).cmp(&kind(b));
    if order != Ordering::Equal {
        return order;
    }
    if kind(a) < 2 {
        (c[O_NS][a], c[O_KEY][a]).cmp(&(c[O_NS][b], c[O_KEY][b]))
    } else {
        (
            c[O_OBJECT][a],
            c[O_LOCATION][a],
            c[O_ROW][a],
            c[O_PROPERTY][a],
            p.package_row[a],
        )
            .cmp(&(
                c[O_OBJECT][b],
                c[O_LOCATION][b],
                c[O_ROW][b],
                c[O_PROPERTY][b],
                p.package_row[b],
            ))
    }
}
fn unique(values: impl IntoIterator<Item = u32>) -> Vec<u32> {
    let mut seen = HashSet::new();
    values.into_iter().filter(|v| seen.insert(*v)).collect()
}
pub(crate) fn intern(
    store: &mut Store,
    strings: &mut Vec<String>,
    domain: &str,
    values: &[String],
) -> Result<Vec<u32>> {
    let mut result = Vec::new();
    for batch in values.chunks(8192) {
        result.extend(
            store.intern_bytes(
                domain,
                &batch
                    .iter()
                    .map(|s| crate::wtf8::Wtf8Buf::from_view(s).into_bytes())
                    .collect::<Vec<_>>(),
            )?,
        );
    }
    for (id, value) in result.iter().zip(values) {
        let index = *id as usize;
        if index >= strings.len() {
            strings.resize(index + 1, String::new());
        }
        strings[index] = value.clone();
    }
    Ok(result)
}
fn status_reason(status: Option<u32>) -> u32 {
    1 << match status {
        Some(1) => 6,
        Some(3) => 7,
        _ => 8,
    }
}
fn same_extra(a: &str, b: &str) -> bool {
    a == b
        || serde_json::from_str::<Value>(if a.is_empty() { "{}" } else { a }).ok()
            == serde_json::from_str::<Value>(if b.is_empty() { "{}" } else { b }).ok()
}

pub(crate) fn metadata_bytes(meta: &Value) -> Result<Vec<u8>> {
    Ok(format!(
        "{{{}}}",
        meta.as_object()
            .ok_or("join metadata object")?
            .iter()
            .map(|(name, value)| Ok(format!(
                "{}:{}",
                serde_json::to_string(name)?,
                if name == "input" {
                    policy_input_json(value)?
                } else if name == "pairs" {
                    crate::wtf8::view_json(value)?
                } else {
                    serde_json::to_string(value)?
                }
            )))
            .collect::<Result<Vec<_>>>()?
            .join(",")
    )
    .into_bytes())
}
fn policy_input_json(input: &Value) -> Result<String> {
    Ok(format!(
        "{{{}}}",
        input
            .as_object()
            .ok_or("join input object")?
            .iter()
            .map(|(key, value)| Ok(format!(
                "{}:{}",
                serde_json::to_string(key)?,
                if matches!(
                    key.as_str(),
                    "review"
                        | "fileErrors"
                        | "fileProvenances"
                        | "fileDiagnostics"
                        | "keyChangePairs"
                ) {
                    crate::wtf8::view_json(value)?
                } else {
                    serde_json::to_string(value)?
                }
            )))
            .collect::<Result<Vec<_>>>()?
            .join(",")
    ))
}
pub(crate) fn policy_view(value: &Value, fields: &BTreeMap<String, Vec<u16>>) -> Value {
    match value {
        Value::String(text) => Value::String(crate::wtf8::expand_utf16(text, fields).into_view()),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| policy_view(value, fields))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    (
                        crate::wtf8::expand_utf16(key, fields).into_view(),
                        policy_view(value, fields),
                    )
                })
                .collect(),
        ),
        value => value.clone(),
    }
}
fn expand_policy(input: &JoinInput) -> Result<JoinInput> {
    let empty = BTreeMap::new();
    let fields = input.string_code_units.as_ref().unwrap_or(&empty);
    require(
        fields.keys().all(|key| !key.is_empty()),
        crate::Error::new(crate::ErrorCode::InvalidInput, "empty UTF-16 policy handle"),
    )?;
    let mut result = input.clone();
    result.review = input
        .review
        .as_ref()
        .map(|value| policy_view(value, fields));
    result.key_change_pairs = input
        .key_change_pairs
        .as_ref()
        .map(|value| policy_view(value, fields));
    result.file_provenances = input
        .file_provenances
        .as_ref()
        .map(|value| policy_view(value, fields));
    result.file_diagnostics = input
        .file_diagnostics
        .as_ref()
        .map(|value| policy_view(value, fields));
    result.file_errors = input.file_errors.as_ref().map(|values| {
        values
            .iter()
            .map(|(key, value)| {
                (
                    crate::wtf8::expand_utf16(key, fields).into_view(),
                    crate::wtf8::expand_utf16(value, fields).into_view(),
                )
            })
            .collect()
    });
    result.string_code_units = None;
    Ok(result)
}
pub fn refresh(store: &mut Store, input: &JoinInput) -> Result<JoinOutcome> {
    crate::join_incremental::reset();
    let expanded = expand_policy(input)?;
    let input = &expanded;
    let generation = store.root["generation"].clone();
    let target = &input.target;
    let cultures = target["cultures"]
        .as_array()
        .ok_or("target cultures absent")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "culture must be text".into())
        })
        .collect::<Result<Vec<_>>>()?;
    let mut paths = vec![
        target["outputPaths"]["manifest"]
            .as_str()
            .unwrap_or("<manifest>")
            .to_owned(),
    ];
    for culture in &cultures {
        paths.push(
            target["outputPaths"]["archives"][culture]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("<archive:{culture}>")),
        );
        paths.push(
            target["outputPaths"]["portableObjects"][culture]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("<po:{culture}>")),
        );
    }
    let mut dependencies = serde_json::Map::new();
    let mut names = store.root["active"]
        .as_object()
        .ok_or("active")?
        .keys()
        .filter(|name| name.starts_with("package-text.") || paths.contains(name))
        .cloned()
        .collect::<Vec<_>>();
    names.sort_by(|a, b| ordinal(a, b));
    for name in names {
        dependencies.insert(name.clone(), store.root["active"][&name].clone());
    }
    let key = format!(
        "joined-native-v2:{}",
        digest(
            format!(
                "[{}]",
                json!([
                    generation,
                    input.project_root,
                    dependencies,
                    target,
                    input.review.clone().unwrap_or(Value::Null),
                    input.key_change_pairs.clone().unwrap_or(Value::Null),
                    input.file_errors.clone().unwrap_or_default(),
                    input.file_provenances.clone().unwrap_or(json!({})),
                    input.file_diagnostics.clone().unwrap_or(json!({}))
                ])
                .as_array()
                .ok_or("join key values")?
                .iter()
                .enumerate()
                .map(|(index, value)| if index < 4 {
                    Ok(serde_json::to_string(value)?)
                } else {
                    crate::wtf8::view_json(value)
                })
                .collect::<Result<Vec<_>>>()?
                .join(",")
            )
            .as_bytes()
        )
    );
    if input.force != Some(true) && store.root["active"]["joined"] == key {
        let record = &store.root["layers"][&key];
        let mut reader = crate::snapshot::Reader::open(
            &store
                .directory
                .join(record["file"].as_str().ok_or("joined file")?),
        )?;
        crate::store::section(&mut reader, "shared.meta")?;
        return Ok(JoinOutcome {
            rebuilt: false,
            strategy: None,
            key,
            bytes: record["bytes"].as_u64().ok_or("joined bytes")?,
            count: None,
            key_changes: None,
            affected_lines: None,
        });
    }
    if input.force != Some(true)
        && let Some(result) = crate::join_incremental::refresh(
            store,
            input,
            &key,
            &Value::Object(dependencies.clone()),
        )?
    {
        return Ok(result);
    }
    crate::join_incremental::full();
    let empty = store.intern("identity", &[String::new()])?[0];
    let mut strings = dictionary_bytes(&store.directory, &store.root)?
        .into_iter()
        .map(|bytes| crate::wtf8::Wtf8Buf::from_bytes(bytes).map(|value| value.into_view()))
        .collect::<Result<Vec<_>>>()?;
    let load = |path: &String| {
        FileColumns::load(
            store,
            path.clone(),
            input
                .file_errors
                .as_ref()
                .and_then(|v| v.get(path))
                .map(String::as_str),
        )
    };
    let manifest = load(&paths[0])?;
    let mut archives = Vec::new();
    let mut pos = Vec::new();
    for ci in 0..cultures.len() {
        archives.push(load(&paths[ci * 2 + 1])?);
        pos.push(load(&paths[ci * 2 + 2])?);
    }
    let packages = PackageColumns::load(store, &strings, &input.project_root, target)?;
    let c = &packages.occurrence;
    let count = c[O_SOURCE].len();
    let path_bytes = packages
        .paths
        .iter()
        .map(|id| crate::wtf8::Wtf8Buf::from_view(&strings[*id as usize]))
        .collect::<Vec<_>>();
    let mut path_order = (0..packages.paths.len()).collect::<Vec<_>>();
    path_order
        .sort_by(|a, b| package_path_order(path_bytes[*a].as_bytes(), path_bytes[*b].as_bytes()));
    let mut rank = vec![0; path_order.len()];
    for (i, row) in path_order.iter().enumerate() {
        rank[*row] = i;
    }
    drop(path_bytes);
    let emission = |a: usize, b: usize| {
        (rank[packages.package_row[a] as usize], a)
            .cmp(&(rank[packages.package_row[b] as usize], b))
    };
    let namespaces = c[O_NS]
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let normalized_values = namespaces
        .iter()
        .map(|id| strip_namespace(&strings[*id as usize]).to_owned())
        .collect::<Vec<_>>();
    let normalized_ids = intern(store, &mut strings, "identity", &normalized_values)?;
    let namespace_map = namespaces
        .into_iter()
        .zip(normalized_ids)
        .collect::<HashMap<_, _>>();
    let mut unit_ids = Vec::with_capacity(count);
    for row in 0..count {
        unit_ids.push(packages.unit_id(row, &strings, empty)?);
    }
    let mut tables = HashMap::<(u32, u32), usize>::new();
    for row in 0..count {
        if c[O_LOCATION][row] == 2 && c[O_IDENTITY][row] == 0 && c[O_KEY][row] != empty {
            let key = (c[O_OBJECT][row], c[O_ROW][row]);
            let select = tables.get(&key).is_none_or(|previous| {
                (c[O_NS][row], c[O_KEY][row]) == (c[O_NS][*previous], c[O_KEY][*previous])
                    || locale(&unit_ids[row], &unit_ids[*previous]) != Ordering::Less
            });
            if select {
                tables.insert(key, row);
            }
        }
    }
    let mut gathered_ns = vec![ABSENT; count];
    let mut gathered_key = vec![ABSENT; count];
    for row in 0..count {
        if c[O_KEY][row] == empty {
            continue;
        }
        if c[O_IDENTITY][row] == 0 {
            gathered_ns[row] = if c[O_LOCATION][row] == 2 {
                c[O_NS][row]
            } else {
                namespace_map[&c[O_NS][row]]
            };
            gathered_key[row] = c[O_KEY][row];
        } else if c[O_IDENTITY][row] == 1
            && let Some(entry) = tables.get(&(c[O_NS][row], c[O_KEY][row]))
        {
            gathered_ns[row] = c[O_NS][*entry];
            gathered_key[row] = c[O_KEY][*entry];
        }
    }
    let compare = |a: usize, b: usize| {
        (gathered_ns[a], gathered_key[a])
            .cmp(&(gathered_ns[b], gathered_key[b]))
            .then_with(|| {
                if gathered_ns[a] == ABSENT {
                    compare_unit(&packages, a, b, empty)
                } else {
                    Ordering::Equal
                }
            })
    };
    let mut order = (0..count as u32).collect::<Vec<_>>();
    order.sort_by(|a, b| {
        compare(*a as usize, *b as usize).then_with(|| emission(*a as usize, *b as usize))
    });
    let mut raw_order = order.clone();
    raw_order.sort_by(|a, b| {
        compare_unit(&packages, *a as usize, *b as usize, empty)
            .then_with(|| emission(*a as usize, *b as usize))
    });
    let mut unit = vec![0; count];
    let mut next = vec![ABSENT; count];
    let mut start = 0;
    while start < count {
        let mut end = start + 1;
        let first = raw_order[start];
        while end < count
            && compare_unit(&packages, first as usize, raw_order[end] as usize, empty)
                == Ordering::Equal
        {
            end += 1;
        }
        for i in start..end {
            unit[raw_order[i] as usize] = first;
            if i + 1 < end {
                next[raw_order[i] as usize] = raw_order[i + 1];
            }
        }
        start = end;
    }
    let mut groups = Vec::new();
    let mut oi = 0;
    let mut mi = 0;
    let mo = &manifest.order;
    let m = &manifest.columns;
    while oi < order.len() || mi < mo.len() {
        let orow = order.get(oi).copied();
        let mrow = mo.get(mi).copied();
        let ons = orow.map_or(ABSENT, |r| gathered_ns[r as usize]);
        let oks = orow.map_or(ABSENT, |r| gathered_key[r as usize]);
        let mns = mrow.map_or(ABSENT, |r| m[NS][r as usize]);
        let mks = mrow.map_or(ABSENT, |r| m[KEY][r as usize]);
        let comparison = if orow.is_none() {
            Ordering::Greater
        } else if mrow.is_none() {
            Ordering::Less
        } else {
            (ons, oks).cmp(&(mns, mks))
        };
        let os = oi;
        let ms = mi;
        if comparison != Ordering::Greater {
            oi += 1;
            while oi < order.len()
                && compare(orow.ok_or("occurrence")? as usize, order[oi] as usize)
                    == Ordering::Equal
            {
                oi += 1;
            }
        }
        if comparison != Ordering::Less {
            mi += 1;
            while mi < mo.len() && (m[NS][mo[mi] as usize], m[KEY][mo[mi] as usize]) == (mns, mks) {
                mi += 1;
            }
        }
        groups.push(Group {
            os,
            oe: oi,
            ms,
            me: mi,
            ns: if comparison != Ordering::Greater {
                ons
            } else {
                mns
            },
            key: if comparison != Ordering::Greater {
                oks
            } else {
                mks
            },
        });
    }
    let mut package_files = vec![0; packages.paths.len()];
    let mut package_folders = vec![0; packages.paths.len()];
    let mut folder_values = Vec::<String>::new();
    let mut folder_ids = HashMap::<String, u32>::new();
    let add_folder =
        |value: String, values: &mut Vec<String>, ids: &mut HashMap<String, u32>| -> u32 {
            if let Some(id) = ids.get(&value) {
                *id
            } else {
                let id = values.len() as u32;
                values.push(value.clone());
                ids.insert(value, id);
                id
            }
        };
    let mut rows = unique(packages.package_row.iter().copied());
    let labels = rows
        .iter()
        .map(|row| file_label(&packages.relative_paths[*row as usize]))
        .collect::<Vec<_>>();
    let ids = intern(store, &mut strings, "paths", &labels)?;
    for ((row, label), id) in rows.drain(..).zip(labels).zip(ids) {
        package_files[row as usize] = id;
        package_folders[row as usize] =
            add_folder(folder(&label).into(), &mut folder_values, &mut folder_ids);
    }
    let mut manifest_files = vec![0; mo.len()];
    let evidence_rows = groups
        .iter()
        .filter(|g| g.os == g.oe)
        .flat_map(|g| mo[g.ms..g.me].iter().copied())
        .collect::<Vec<_>>();
    let labels = evidence_rows
        .iter()
        .map(|row| {
            manifest
                .path(*row as usize, &strings)
                .map(|p| file_label(&p))
        })
        .collect::<Result<Vec<_>>>()?;
    let ids = intern(store, &mut strings, "paths", &labels)?;
    for (row, id) in evidence_rows.iter().zip(ids) {
        manifest_files[*row as usize] = id;
    }
    let mut joined = Joined {
        line: vec![vec![0; groups.len()]; LINE_FIELDS.len()],
        cultures: vec![vec![vec![0; groups.len()]; 7]; cultures.len()],
        groups,
        order,
        raw_order,
        unit,
        next,
        package_files,
        empty,
        packages,
        manifest,
        archives,
        pos,
        strings,
        unit_ids,
    };
    let mut folder_rows = Vec::new();
    let mut file_rows = Vec::new();
    let mut visible_occurrence = vec![false; count];
    let mut visible_line = vec![false; joined.groups.len()];
    let mut cursors = vec![[0; 2]; cultures.len()];
    let mut pending_sources = Vec::new();
    let mut pending_rows = Vec::new();
    for row in 0..joined.groups.len() {
        let g = joined.groups[row];
        let c = &joined.packages.occurrence;
        let m = &joined.manifest.columns;
        let mo = &joined.manifest.order;
        let mut reasons = 0;
        let mut structural = 0;
        let mut origins = 0;
        let mut editing = 0;
        let mut notes = 0;
        let mut visible = false;
        let mut empty_problems = 0;
        let occurrence_rows = &joined.order[g.os..g.oe];
        let authored = occurrence_rows
            .iter()
            .any(|i| c[O_IDENTITY][*i as usize] != 1 || c[O_KEY][*i as usize] == empty);
        let has_reference = occurrence_rows
            .iter()
            .any(|i| c[O_IDENTITY][*i as usize] == 1 && c[O_KEY][*i as usize] != empty);
        let mut sources = Vec::new();
        let mut source_set = HashSet::new();
        let mut inside_packages = HashSet::new();
        let mut row_units = HashSet::new();
        let mut row_folders = Vec::new();
        let mut row_files = Vec::new();
        let mut inside = false;
        let mut outside = true;
        let mut editor_only_outside = true;
        let mut audience = 0;
        let mut out_of_scope = 0;
        let mut coverage_reasons = 0;
        for i in occurrence_rows {
            let i = *i as usize;
            let pkg = joined.packages.package_row[i] as usize;
            let representative = joined.unit[i] as usize;
            if row_units.insert(representative) {
                let mut members = Vec::new();
                let mut values = HashSet::new();
                let mut length = 0;
                let mut searchable = false;
                let mut member = representative as u32;
                while member != ABSENT {
                    let index = member as usize;
                    member = joined.next[index];
                    if c[O_IDENTITY][index] == 0
                        && c[O_KEY][index] != empty
                        && (gathered_ns[index] != g.ns || gathered_key[index] != g.key)
                    {
                        continue;
                    }
                    members.push(index);
                    let source = c[O_SOURCE][index];
                    if values.insert(source) {
                        let value = joined.string(source);
                        length = length.max(characters(value));
                        searchable |= !trim(value).is_empty();
                    }
                }
                let problems = if length >= 40
                    || c[O_IDENTITY][representative] >= 2
                    || c[O_KEY][representative] == empty
                {
                    32
                } else {
                    0
                };
                empty_problems |= problems;
                if searchable {
                    visible = true;
                    joined.line[L_PROBLEMS][row] |= problems;
                    for member in members {
                        visible_occurrence[member] = true;
                        origins |= 1
                            << match c[O_LOCATION][member] {
                                2 => 0,
                                1 => 1,
                                _ => 2,
                            };
                        editing |= if c[O_EDITABLE][member] != 0 { 1 } else { 2 };
                        audience |= crate::package_evidence::audience(c[O_AUDIENCE][member]);
                        if !trim(joined.string(c[O_NOTES][member])).is_empty() {
                            notes = 1;
                        }
                        let pkg = joined.packages.package_row[member] as usize;
                        row_folders.push(package_folders[pkg]);
                        row_files.push(joined.package_files[pkg]);
                    }
                }
            }
            if authored && c[O_IDENTITY][i] == 1 && c[O_KEY][i] != empty {
                continue;
            }
            if source_set.insert(c[O_SOURCE][i]) {
                sources.push(c[O_SOURCE][i]);
            }
            inside_packages.insert(pkg);
            let coverage = joined.packages.coverage[i];
            inside |= coverage == 1;
            outside &= coverage == 0;
            editor_only_outside &=
                coverage == 0 || crate::package_evidence::editor_only(c[O_AUDIENCE][i]);
            if coverage >= 2 {
                coverage_reasons |= 1 << (coverage + 10);
            }
        }
        if !visible {
            joined.line[L_PROBLEMS][row] |= empty_problems;
        }
        visible_line[row] = visible;
        if g.oe - g.os > 1 {
            joined.line[L_PROBLEMS][row] |= 32;
        }
        if g.ns == ABSENT {
            reasons |= 1 << if has_reference { 10 } else { 9 };
        }
        if !joined.manifest.loaded {
            reasons |= 1;
        }
        if g.me - g.ms > 1 {
            reasons |= 1 << 3;
        }
        if sources.len() > 1 {
            reasons |= 1 << 11;
        }
        let first = if g.ms == g.me { ABSENT } else { mo[g.ms] };
        let source = sources.first().copied().unwrap_or_else(|| {
            if first == ABSENT {
                empty
            } else {
                m[SOURCE][first as usize]
            }
        });
        joined.line[L_SOURCE][row] = source;
        let initial = joined.string(source);
        let initial_words = words(initial);
        let initial_visible = u32::from(!trim(initial).is_empty());
        joined.line[3][row] = initial_words;
        joined.line[4][row] = initial_visible;
        if sources.len() > 1 {
            let mut occurrences = occurrence_rows.to_vec();
            occurrences.sort_by(|a, b| {
                locale(&joined.unit_ids[*a as usize], &joined.unit_ids[*b as usize]).then_with(
                    || {
                        let a = *a as usize;
                        let b = *b as usize;
                        (rank[joined.packages.package_row[a] as usize], a)
                            .cmp(&(rank[joined.packages.package_row[b] as usize], b))
                    },
                )
            });
            let ordered = unique(
                occurrences
                    .iter()
                    .filter(|i| !authored || c[O_IDENTITY][**i as usize] != 1)
                    .map(|i| c[O_SOURCE][*i as usize]),
            );
            let value = ordered
                .iter()
                .map(|id| joined.string(*id))
                .collect::<Vec<_>>()
                .join(" ");
            require(value.len() <= 1024 * 1024, "joined source exceeds bound")?;
            joined.line[3][row] = words(&value);
            joined.line[4][row] = u32::from(!trim(&value).is_empty());
            pending_rows.push(row);
            pending_sources.push(value);
        }
        if g.oe > g.os {
            if outside {
                structural |= 1 << 8;
                out_of_scope = 1;
            } else if !inside {
                reasons |= coverage_reasons;
            } else if first == ABSENT && joined.manifest.loaded && g.ns != ABSENT {
                if crate::package_evidence::skips_editor(target) && editor_only_outside {
                    structural |= 1 << 8;
                    out_of_scope = 2;
                } else {
                    structural |= 1 << 4;
                }
            }
            if first != ABSENT && sources.len() == 1 && source != m[SOURCE][first as usize] {
                structural |= 1 << 5;
            }
            for manifest_row in &mo[g.ms..g.me] {
                if let Some(file) = manifest_package(
                    &joined
                        .manifest
                        .path(*manifest_row as usize, &joined.strings)?,
                ) {
                    let wanted = normalized(&file).to_lowercase();
                    let alternative = wanted
                        .strip_suffix(".uasset")
                        .map_or_else(|| wanted.clone(), |s| format!("{s}.umap"));
                    let present = inside_packages.iter().any(|pkg| {
                        let saved =
                            normalized(&joined.packages.relative_paths[*pkg]).to_lowercase();
                        saved == wanted || saved == alternative
                    });
                    if !present {
                        let status = joined.packages.status(&file);
                        if status == Some(0) {
                            structural |= 1 << 6;
                        } else {
                            reasons |= status_reason(status);
                        }
                    }
                }
            }
        } else if first != ABSENT {
            let mut gathered_only = true;
            for manifest_row in &mo[g.ms..g.me] {
                let index = *manifest_row as usize;
                let value = joined.manifest.path(index, &joined.strings)?;
                if m[OPTIONS][index] & 4 != 0 && !trim(joined.string(m[NOTES][index])).is_empty() {
                    notes = 1;
                }
                if m[OPTIONS][index] & 8 != 0 {
                    let metadata = serde_json::from_str::<Value>(joined.string(m[METADATA][index]))
                        .unwrap_or(Value::Null);
                    if !trim(metadata["Info"]["Comment"].as_str().unwrap_or("")).is_empty() {
                        notes = 1;
                    }
                }
                if manifest_package(&value).is_some() || normalized(&value).starts_with('/') {
                    gathered_only = false;
                }
                row_folders.push(add_folder(
                    folder(&file_label(&value)).into(),
                    &mut folder_values,
                    &mut folder_ids,
                ));
                row_files.push(manifest_files[index]);
                origins |= 1 << origin(&value);
            }
            if gathered_only {
                structural |= 1 << 7;
            } else {
                for manifest_row in &mo[g.ms..g.me] {
                    let status = manifest_package(
                        &joined
                            .manifest
                            .path(*manifest_row as usize, &joined.strings)?,
                    )
                    .and_then(|f| joined.packages.status(&f));
                    if status != Some(0) {
                        reasons |= status_reason(status);
                    }
                }
                if reasons == 0 {
                    structural |= 1 << 6;
                }
            }
            editing = 2;
        }
        joined.line[0][row] = if g.ns == ABSENT { empty } else { g.ns };
        joined.line[1][row] = if g.ns == ABSENT { empty } else { g.key };
        joined.line[5][row] = g.os as u32;
        joined.line[6][row] = g.oe as u32;
        joined.line[7][row] = g.ms as u32;
        joined.line[8][row] = g.me as u32;
        joined.line[9][row] = reasons;
        joined.line[10][row] = structural;
        joined.line[12][row] = origins;
        joined.line[13][row] = editing;
        joined.line[14][row] = notes;
        joined.line[21][row] = audience | (out_of_scope << 4);
        joined.line[16][row] = folder_rows.len() as u32;
        folder_rows.extend(unique(row_folders));
        joined.line[17][row] = folder_rows.len() as u32;
        joined.line[18][row] = file_rows.len() as u32;
        file_rows.extend(unique(row_files));
        joined.line[19][row] = file_rows.len() as u32;
        for (ci, cursor) in cursors.iter_mut().enumerate() {
            let af = &joined.archives[ci];
            let pf = &joined.pos[ci];
            let (ar, ac) = if g.ns == ABSENT {
                (ABSENT, 0)
            } else {
                af.lookup(g.ns, g.key, &mut cursor[0])
            };
            let (pr, pc) = if g.ns == ABSENT {
                (ABSENT, 0)
            } else {
                pf.lookup(g.ns, g.key, &mut cursor[1])
            };
            let a = &af.columns;
            let p = &pf.columns;
            let mut unknown = reasons;
            let mut facts = structural;
            if !af.loaded {
                unknown |= 1 << 1;
            }
            if !pf.loaded {
                unknown |= 1 << 2;
            }
            if ac > 1 {
                unknown |= 1 << 4;
            }
            if pc > 1 {
                unknown |= 1 << 5;
            }
            if target["collapseMode"] == "IdenticalNamespaceAndSource" {
                unknown |= 1 << 16;
            }
            let at = if ar == ABSENT {
                empty
            } else {
                let r = ar as usize;
                a[if a[OPTIONS][r] & 128 != 0 {
                    SOURCE
                } else {
                    TRANSLATION
                }][r]
            };
            let pt = if pr == ABSENT || p[OPTIONS][pr as usize] & 64 == 0 {
                empty
            } else {
                let r = pr as usize;
                p[if p[OPTIONS][r] & 128 != 0 {
                    SOURCE
                } else {
                    TRANSLATION
                }][r]
            };
            if (af.loaded || af.missing) && ac <= 1 && pc == 1 && pt != empty && pt != at {
                facts |= 1 << 3;
            }
            let matches = ac == 1
                && g.me - g.ms == 1
                && a[SOURCE][ar as usize] == m[SOURCE][first as usize]
                && same_extra(
                    joined.string(a[SOURCE_EXTRA][ar as usize]),
                    joined.string(m[SOURCE_EXTRA][first as usize]),
                );
            if ac == 1 && g.me - g.ms == 1 && !matches {
                facts |= 1 << 2;
            }
            if (af.loaded || af.missing) && ac <= 1 {
                if ar == ABSENT || at == empty {
                    facts |= 1 << 1;
                } else if matches {
                    facts |= 1;
                }
            }
            let mut operative = unknown;
            if !af.loaded && af.missing {
                operative &= !(1 << 1);
            }
            if !pf.loaded && pf.missing {
                operative &= !(1 << 2);
            }
            if operative != 0 {
                facts |= 1 << 9;
            }
            let marks = &mut joined.cultures[ci];
            marks[0][row] = [8, 4, 6, 7, 5, 9, 3, 2, 1, 0]
                .into_iter()
                .find(|state| facts & (1 << state) != 0)
                .unwrap_or(9);
            marks[1][row] = facts;
            marks[2][row] = unknown;
            marks[3][row] = ar.wrapping_add(1);
            marks[4][row] = pr.wrapping_add(1);
        }
    }
    let ids = intern(store, &mut joined.strings, "source", &pending_sources)?;
    for (row, id) in pending_rows.into_iter().zip(ids) {
        joined.line[L_SOURCE][row] = id;
    }
    let places = crate::package_evidence::places(&joined);
    let duplicate = crate::package_evidence::duplicates(&joined, &places);
    let mut unit_first = HashMap::<u32, usize>::new();
    for (row, _) in visible_line.iter().enumerate().take(joined.groups.len()) {
        let g = joined.groups[row];
        for i in &joined.order[g.os..g.oe] {
            let i = *i as usize;
            let representative = joined.unit[i];
            if let Some(previous) = unit_first.get(&representative).copied() {
                if previous != row {
                    joined.line[20][row] = 1;
                    joined.line[20][previous] = 1;
                }
            } else {
                unit_first.insert(representative, row);
            }
            if duplicate[i] && (visible_occurrence[i] || !visible_line[row]) {
                joined.line[L_PROBLEMS][row] |= 32;
            }
        }
    }
    let folder_global = intern(store, &mut joined.strings, "paths", &folder_values)?;
    let folder_column = folder_rows
        .iter()
        .map(|id| folder_global[*id as usize])
        .collect::<Vec<_>>();
    let marks = crate::join_marks::finish(store, input, &mut joined, &cultures)?;
    store.release_dictionary();
    let mut query_columns =
        crate::join_query::columns(&joined, target["name"].as_str().ok_or("target name")?)?;
    query_columns.extend(crate::join_places::columns(
        &joined,
        &query_columns,
        &file_rows,
    )?);
    let graph = crate::dependency_graph::Graph::rebuild(store, &joined, &query_columns)?;
    let first_folders = joined.line[16]
        .iter()
        .enumerate()
        .map(|(row, start)| {
            if *start == joined.line[17][row] {
                empty
            } else {
                folder_column[*start as usize]
            }
        })
        .collect::<Vec<_>>();
    let mut columns = Vec::new();
    for (field, name) in LINE_FIELDS.iter().enumerate() {
        columns.push((
            format!("line.{name}"),
            match *name {
                "namespace" | "key" => "identity",
                "source" => "source",
                _ => "",
            }
            .into(),
            std::mem::take(&mut joined.line[field]),
        ));
    }
    for (ci, culture) in joined.cultures.iter_mut().enumerate() {
        for (field, name) in CULTURE_FIELDS.iter().enumerate() {
            columns.push((
                format!("c{ci}.{name}"),
                String::new(),
                std::mem::take(&mut culture[field]),
            ));
        }
    }
    columns.extend(query_columns);
    columns.push((
        "occurrence.rows".into(),
        String::new(),
        joined.order.clone(),
    ));
    columns.push((
        "manifest.rows".into(),
        String::new(),
        joined.manifest.order.clone(),
    ));
    columns.push((
        "facet.folders".into(),
        "paths".into(),
        folder_column.clone(),
    ));
    columns.push(("facet.files".into(), "paths".into(), file_rows));
    columns.push(("line.folder".into(), "paths".into(), first_folders));
    let mut aliases = serde_json::Map::new();
    let mut chunks = serde_json::Map::new();
    let mut unique_columns: Vec<(String, String, Vec<u32>)> = Vec::new();
    let mut identical = HashMap::<(String, usize, u32), Vec<usize>>::new();
    for column in columns {
        if column.2.len() > crate::snapshot::MAX_SECTION / 4 {
            let mut names = Vec::new();
            for (index, part) in column
                .2
                .chunks(crate::snapshot::MAX_SECTION / 4)
                .enumerate()
            {
                let name = format!("{}.chunk{index}", column.0);
                names.push(name.clone());
                unique_columns.push((name, column.1.clone(), part.to_vec()));
            }
            chunks.insert(column.0, json!(names));
            continue;
        }
        let signature = (
            column.1.clone(),
            column.2.len(),
            crc32fast::hash(&crate::snapshot::u32_bytes(&column.2)),
        );
        let indices = identical.entry(signature).or_default();
        if let Some(index) = indices.iter().find(|i| unique_columns[**i].2 == column.2) {
            aliases.insert(column.0, json!(unique_columns[*index].0));
        } else {
            indices.push(unique_columns.len());
            unique_columns.push(column);
        }
    }
    let meta = json!({"version":3,"count":joined.groups.len(),"input":input,"aliases":aliases,"chunks":chunks,"generation":generation,"dependencies":dependencies,"packageNames":joined.packages.names,"packageStarts":joined.packages.starts,"pairs":marks["pairs"],"ambiguous":marks["ambiguous"],"oldCandidates":marks["oldCandidates"],"reducedSourceChecking":joined.pos.iter().map(|f|f.loaded&&!f.has_source).collect::<Vec<_>>()});
    let count = joined.groups.len() as u32;
    drop(joined);
    if let Some(outcome) = crate::join_overlay::publish(store, input, &key, &meta, &unique_columns)?
    {
        return Ok(outcome);
    }
    let metadata = metadata_bytes(&meta)?;
    require(
        metadata.len() <= 16 * 1024 * 1024,
        "join metadata exceeds bound",
    )?;
    graph.commit(store, &key)?;
    let record = store.publish_global(
        "joined",
        &key,
        &unique_columns,
        &metadata,
        &BTreeMap::new(),
        &["joined-base".into()],
    )?;
    Ok(JoinOutcome {
        rebuilt: true,
        strategy: Some("full".into()),
        key,
        bytes: record["bytes"].as_u64().ok_or("joined bytes")?,
        count: Some(count),
        key_changes: Some(marks["pairs"].as_array().ok_or("pairs")?.len() as u32),
        affected_lines: None,
    })
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    #[test]
    fn review_metadata_preserves_utf16_without_changing_scalar_target_paths() {
        let input: JoinInput = serde_json::from_value(json!({
            "projectRoot":"/project", "target":{"name":"\u{f0001}"},
            "review":{"handle":"handle"}, "fileErrors":{"handle":"handle"},
            "stringCodeUnits":{"handle":[0xd800, 0x61, 0xdc00]}
        }))
        .unwrap();
        let expanded = expand_policy(&input).unwrap();
        let output =
            String::from_utf8(metadata_bytes(&json!({"input":expanded})).unwrap()).unwrap();
        assert!(output.contains(r#""\ud800a\udc00":"\ud800a\udc00""#));
        assert!(output.contains("\u{f0001}"));
        assert!(!output.contains("stringCodeUnits"));
        assert!(!output.contains("handle"));
        let mut invalid = input;
        invalid.string_code_units = Some(BTreeMap::from([(String::new(), vec![0xd800])]));
        assert!(expand_policy(&invalid).is_err());
    }
}
