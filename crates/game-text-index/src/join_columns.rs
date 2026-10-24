//! Numeric joined input views, with no per-row authored objects.
const LOCALIZATION_FIELDS: [&str; 12] = [
    "namespace",
    "key",
    "source",
    "translation",
    "path",
    "notes",
    "metadata",
    "source-extra",
    "translation-extra",
    "po-extra",
    "options",
    "ordinal",
];
use crate::join_policy::{ABSENT, GatherPolicy, relative_package, uri_component};
use crate::snapshot::{Reader, integers};
use crate::store::{Store, decode_ids, section};
use crate::{Result, require};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const NS: usize = 0;
pub(crate) const KEY: usize = 1;
pub(crate) const SOURCE: usize = 2;
pub(crate) const TRANSLATION: usize = 3;
pub(crate) const PATH: usize = 4;
pub(crate) const NOTES: usize = 5;
pub(crate) const METADATA: usize = 6;
pub(crate) const SOURCE_EXTRA: usize = 7;
pub(crate) const TRANSLATION_EXTRA: usize = 8;
pub(crate) const OPTIONS: usize = 10;
pub(crate) const ORDINAL: usize = 11;
pub(crate) fn layer(store: &Store, name: &str) -> Result<Option<(Reader, Value)>> {
    let Some(key) = store.root["active"][name]
        .as_str()
        .or_else(|| store.root["layers"].get(name).map(|_| name))
    else {
        return Ok(None);
    };
    let record = &store.root["layers"][key];
    Ok(Some((
        Reader::open(
            &store
                .directory
                .join(record["file"].as_str().ok_or("layer file absent")?),
        )?,
        record.clone(),
    )))
}
pub(crate) fn column(reader: &mut Reader, record: &Value, name: &str) -> Result<Vec<u32>> {
    let data = section(reader, name)?;
    if record["stringColumns"].get(name).is_some() {
        decode_ids(&data, record["idEncoding"] == "delta32")
    } else {
        integers(&data)
    }
}
pub(crate) struct FileColumns {
    pub name: String,
    pub columns: [Vec<u32>; 12],
    pub order: Vec<u32>,
    pub loaded: bool,
    pub missing: bool,
    pub has_source: bool,
    pub prefix: String,
}
impl FileColumns {
    pub fn load(store: &Store, name: String, failure: Option<&str>) -> Result<Self> {
        let mut result = Self {
            name,
            columns: std::array::from_fn(|_| Vec::new()),
            order: Vec::new(),
            loaded: false,
            missing: failure.is_none_or(|f| f == "file_missing"),
            has_source: false,
            prefix: String::new(),
        };
        // An active layer can belong to an earlier successful import. A current failure
        // must hide that evidence without deleting snapshots pinned by older readers.
        if failure.is_some() {
            return Ok(result);
        }
        if let Some((mut reader, record)) = layer(store, &result.name)? {
            let meta: Value = serde_json::from_slice(&section(&reader, "file.meta")?)?;
            let count = meta["count"].as_u64().ok_or("file count absent")? as usize;
            result.loaded = true;
            result.missing = false;
            result.has_source = meta["hasSourceText"]
                .as_bool()
                .ok_or("source availability absent")?;
            result.prefix = meta["pathPrefix"].as_str().unwrap_or("").into();
            for (field, name) in LOCALIZATION_FIELDS.iter().enumerate() {
                // Native translations may be the foreign source, including their metadata.
                // PO extras are only needed for hydration.
                if field == 9 {
                    continue;
                }
                result.columns[field] = column(&mut reader, &record, &format!("entry.{name}"))?;
                require(
                    result.columns[field].len() == count,
                    "join file column lengths differ",
                )?;
            }
            result.order = (0..count as u32).collect();
            let c = &result.columns;
            result.order.sort_by_key(|row| {
                let row = *row as usize;
                (c[NS][row], c[KEY][row], c[ORDINAL][row])
            });
        }
        Ok(result)
    }
    pub fn path(&self, row: usize, strings: &[String]) -> Result<String> {
        let path = strings
            .get(self.columns[PATH][row] as usize)
            .ok_or("manifest path ID")?;
        Ok(if self.columns[OPTIONS][row] & 1024 != 0 {
            format!("{}{path}", self.prefix)
        } else {
            path.clone()
        })
    }
    pub fn lookup(&self, namespace: u32, key: u32, cursor: &mut usize) -> (u32, usize) {
        let c = &self.columns;
        while let Some(row) = self.order.get(*cursor) {
            let row = *row as usize;
            if c[OPTIONS][row] & 16 != 0 || (c[NS][row], c[KEY][row]) < (namespace, key) {
                *cursor += 1;
            } else {
                break;
            }
        }
        let start = *cursor;
        while self
            .order
            .get(*cursor)
            .is_some_and(|row| (c[NS][*row as usize], c[KEY][*row as usize]) == (namespace, key))
        {
            *cursor += 1;
        }
        (
            if *cursor == start {
                ABSENT
            } else {
                self.order[start]
            },
            *cursor - start,
        )
    }
}
pub(crate) const OCCURRENCE_FIELDS: [&str; 14] = [
    "source",
    "notes",
    "namespace",
    "key",
    "object",
    "property",
    "class",
    "row",
    "identity",
    "location",
    "editable",
    "gather",
    "audience",
    "copies",
];
pub(crate) const O_SOURCE: usize = 0;
pub(crate) const O_NOTES: usize = 1;
pub(crate) const O_NS: usize = 2;
pub(crate) const O_KEY: usize = 3;
pub(crate) const O_OBJECT: usize = 4;
pub(crate) const O_PROPERTY: usize = 5;
pub(crate) const O_CLASS: usize = 6;
pub(crate) const O_ROW: usize = 7;
pub(crate) const O_IDENTITY: usize = 8;
pub(crate) const O_LOCATION: usize = 9;
pub(crate) const O_EDITABLE: usize = 10;
pub(crate) const O_AUDIENCE: usize = 12;
pub(crate) const O_COPIES: usize = 13;
pub(crate) struct PackageColumns {
    pub names: Vec<String>,
    pub starts: Vec<u32>,
    pub occurrence: [Vec<u32>; 14],
    pub package_row: Vec<u32>,
    pub paths: Vec<u32>,
    pub status: Vec<u32>,
    pub coverage: Vec<u32>,
    pub relative_paths: Vec<String>,
    pub statuses: BTreeMap<String, u32>,
}
impl PackageColumns {
    pub fn load(store: &Store, strings: &[String], project: &str, target: &Value) -> Result<Self> {
        let mut names: Vec<_> = store.root["active"]
            .as_object()
            .ok_or("active layers absent")?
            .keys()
            .filter(|s| s.starts_with("package-text."))
            .cloned()
            .collect();
        names.sort();
        let mut result = Self {
            names,
            starts: Vec::new(),
            occurrence: std::array::from_fn(|_| Vec::new()),
            package_row: Vec::new(),
            paths: Vec::new(),
            status: Vec::new(),
            coverage: Vec::new(),
            relative_paths: Vec::new(),
            statuses: BTreeMap::new(),
        };
        for name in &result.names {
            let (mut reader, record) = layer(store, name)?.ok_or("package shard absent")?;
            let offset = result.occurrence[O_SOURCE].len();
            result.starts.push(offset as u32);
            let paths = column(&mut reader, &record, "package.path")?;
            let status = column(&mut reader, &record, "package.status")?;
            let starts = column(&mut reader, &record, "package.occurrence_start")?;
            require(
                starts.len() == paths.len() + 1 && status.len() == paths.len(),
                "package range length",
            )?;

            for (field, name) in OCCURRENCE_FIELDS.iter().enumerate() {
                result.occurrence[field].extend(column(
                    &mut reader,
                    &record,
                    &format!("occurrence.{name}"),
                )?);
            }
            let occurrence_count = result.occurrence[O_SOURCE].len();
            result.package_row.resize(occurrence_count, 0);
            for row in 0..paths.len() {
                let package = result.paths.len() as u32;
                let next = status[row];
                let next = if next == 2 { 1 } else { next };
                require(
                    starts[row] <= starts[row + 1]
                        && offset + starts[row + 1] as usize <= occurrence_count,
                    "package occurrence range",
                )?;
                result.package_row
                    [offset + starts[row] as usize..offset + starts[row + 1] as usize]
                    .fill(package);
                result.paths.push(paths[row]);
                result.status.push(next);
                let path = relative_package(
                    project,
                    strings.get(paths[row] as usize).ok_or("package path ID")?,
                );
                let key = crate::join_policy::normalized(&path).to_lowercase();
                let previous = result.statuses.get(&key).copied();
                if previous != Some(3) && !(previous == Some(1) && next == 0) {
                    result.statuses.insert(key, next);
                }
                result.relative_paths.push(path);
            }
        }
        result.starts.push(result.occurrence[O_SOURCE].len() as u32);
        let count = result.occurrence[O_SOURCE].len();
        require(
            result.occurrence.iter().all(|v| v.len() == count),
            "occurrence column lengths differ",
        )?;
        let policy = GatherPolicy::from_target(target)?;
        let mut ratings = BTreeMap::<(u32, u32, u32), u32>::new();
        for row in 0..count {
            let package = result.package_row[row];
            let class = result.occurrence[O_CLASS][row];
            let kind = result.occurrence[O_LOCATION][row];
            let rating = if let Some(value) = ratings.get(&(package, class, kind)) {
                *value
            } else {
                let value = policy.coverage(
                    &result.relative_paths[package as usize],
                    strings.get(class as usize).ok_or("class ID")?,
                    kind,
                );
                ratings.insert((package, class, kind), value);
                value
            };
            result.coverage.push(rating);
        }
        Ok(result)
    }
    pub fn status(&self, path: &str) -> Option<u32> {
        let key = crate::join_policy::normalized(path).to_lowercase();
        self.statuses.get(&key).copied().or_else(|| {
            self.statuses
                .get(
                    &key.strip_suffix(".uasset")
                        .map_or_else(|| key.clone(), |base| format!("{base}.umap")),
                )
                .copied()
        })
    }
    /// Package layers are published from a complete inventory. No layers means preparation has
    /// not run; an empty published layer means the prepared project really has no packages.
    pub fn absence_is_known(&self, path: &str) -> bool {
        match self.status(path) {
            Some(0) => true,
            None => !self.names.is_empty(),
            _ => false,
        }
    }
    pub fn unit_id(&self, row: usize, strings: &[String], empty: u32) -> Result<String> {
        let c = &self.occurrence;
        let text = |field: usize| -> Result<&str> {
            strings
                .get(c[field][row] as usize)
                .map(String::as_str)
                .ok_or_else(|| "unit string ID".into())
        };
        if c[O_IDENTITY][row] < 2 && c[O_KEY][row] != empty {
            // One unit per key Unreal translates: without the package marker, as gathered text
            // has it. String Table entries and references keep their namespace or table.
            let namespace = text(O_NS)?;
            return Ok(format!(
                "{}:{}:{}",
                if c[O_IDENTITY][row] == 0 {
                    "unreal"
                } else {
                    "string-table"
                },
                uri_component(if c[O_IDENTITY][row] == 0 && c[O_LOCATION][row] != 2 {
                    crate::join_policy::strip_namespace(namespace)
                } else {
                    namespace
                }),
                uri_component(text(O_KEY)?)
            ));
        }
        let suffix = match c[O_LOCATION][row] {
            2 => format!("entry:{}", text(O_ROW)?),
            1 => format!("row:{}:property:{}", text(O_ROW)?, text(O_PROPERTY)?),
            _ => format!("property:{}", text(O_PROPERTY)?),
        };
        Ok(format!(
            "occurrence:{}:{suffix}:{}",
            text(O_OBJECT)?,
            self.relative_paths[self.package_row[row] as usize]
        ))
    }
}
