//! Evaluation-owned bulk occurrence relation. Focus-query hydration is deliberately separate.
use super::columns::{Arena, Atom, StrId};
use super::stages::Measure;
use crate::engine_query::EngineQuery;
use crate::{Result, require};
use std::collections::HashMap;
use std::sync::Arc;

const FIELDS: [&str; 10] = [
    "source",
    "notes",
    "location",
    "object",
    "property",
    "class",
    "row",
    "identity",
    "namespace",
    "key",
];
#[derive(Clone, Copy)]
pub(super) enum UnitStatus {
    Resolved,
    StringTable,
    Unresolved,
}
#[derive(Default)]
pub(super) struct OccurrenceData {
    pub columns: HashMap<&'static str, Arc<[u32]>>,
    pub packages: Vec<u32>,
    pub files: Vec<String>,
    pub statuses: Vec<UnitStatus>,
}
impl OccurrenceData {
    pub fn build(query: &mut EngineQuery, measure: &mut Measure) -> Result<Arc<Self>> {
        let mut shards = Vec::new();
        let mut path_ids = Vec::new();
        for shard in 0..query.package_count() {
            let columns = FIELDS
                .iter()
                .map(|name| {
                    Ok((
                        *name,
                        query.package_column(shard, &format!("occurrence.{name}"))?,
                    ))
                })
                .collect::<Result<HashMap<_, _>>>()?;
            let starts = query.package_column(shard, "package.occurrence_start")?;
            let paths = query.package_column(shard, "package.path")?;
            let package_base = path_ids.len() as u32;
            path_ids.extend_from_slice(&paths);
            shards.push((columns, starts, package_base));
        }
        let mut key_ids = shards
            .iter()
            .flat_map(|(columns, _, _)| columns["key"].iter().copied())
            .collect::<Vec<_>>();
        key_ids.sort_unstable();
        key_ids.dedup();
        let empty = key_ids
            .iter()
            .copied()
            .zip(query.reader.strings_batch(&key_ids)?)
            .filter(|(_, text)| text.is_empty())
            .map(|(id, _)| id)
            .collect::<std::collections::HashSet<_>>();
        let project = query.reader.meta["input"]["projectRoot"]
            .as_str()
            .ok_or("Missing project identity.")?
            .to_owned();
        let paths = query.reader.strings_batch(&path_ids)?;
        let files = measure.parallel(&paths, |path| {
            crate::join_policy::relative_package(&project, path)
        });
        let built = measure
            .parallel_chunks(&shards, 1, |(columns, starts, base)| -> Result<_> {
                let len = columns["source"].len();
                require(
                    columns.values().all(|column| column.len() == len),
                    "Invalid occurrence columns.",
                )?;
                let mut package = 0;
                let packages = (0..len)
                    .map(|row| {
                        while package + 1 < starts.len() && starts[package + 1] as usize <= row {
                            package += 1;
                        }
                        *base + package as u32
                    })
                    .collect::<Vec<_>>();
                let statuses = (0..len)
                    .map(|row| match columns["identity"][row] {
                        0 if !empty.contains(&columns["key"][row]) => UnitStatus::Resolved,
                        1 if !empty.contains(&columns["key"][row]) => UnitStatus::StringTable,
                        _ => UnitStatus::Unresolved,
                    })
                    .collect::<Vec<_>>();
                Ok((packages, statuses))
            })
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        let columns = FIELDS
            .into_iter()
            .map(|name| {
                (
                    name,
                    shards
                        .iter()
                        .flat_map(|(columns, _, _)| columns[name].iter().copied())
                        .collect::<Vec<_>>()
                        .into(),
                )
            })
            .collect();
        let (packages, statuses): (Vec<_>, Vec<_>) = built.into_iter().unzip();
        Ok(Arc::new(Self {
            columns,
            packages: packages.into_iter().flatten().collect(),
            statuses: statuses.into_iter().flatten().collect(),
            files,
        }))
    }
    pub fn value(&self, row: usize, field: &str) -> u32 {
        self.columns[field][row]
    }
    pub fn len(&self) -> usize {
        self.packages.len()
    }
    pub fn bytes(&self) -> usize {
        self.columns
            .values()
            .map(|column| column.len() * 4)
            .sum::<usize>()
            + self.packages.capacity() * 4
            + self.statuses.capacity()
            + self.files.iter().map(String::capacity).sum::<usize>()
    }
    pub fn id(&self, row: usize, arena: &Arena) -> String {
        let object = arena.text(StrId(self.value(row, "object")));
        let property = arena.text(StrId(self.value(row, "property")));
        let entry = arena.text(StrId(self.value(row, "row")));
        let suffix = match self.value(row, "location") {
            2 => format!("entry:{entry}"),
            1 => format!("row:{entry}:property:{property}"),
            _ => format!("property:{property}"),
        };
        format!(
            "occurrence:{object}:{suffix}:{}",
            self.files[self.packages[row] as usize]
        )
    }
    pub fn location(&self, row: usize, arena: &Arena) -> serde_json::Value {
        use serde_json::json;
        let text = |field| arena.text(StrId(self.value(row, field)));
        let mut location = json!({"objectPath":text("object")});
        match self.value(row, "location") {
            0 => {
                location["kind"] = json!("asset_property");
                location["propertyPath"] = json!(text("property"));
                location["classPath"] = json!(text("class"));
            }
            1 => {
                location["kind"] = json!("data_table_cell");
                location["propertyPath"] = json!(text("property"));
                location["row"] = json!(text("row"));
            }
            _ => {
                location["kind"] = json!("string_table_entry");
                location["entryKey"] = json!(text("row"));
            }
        }
        location
    }
    pub fn status(&self, row: usize, _arena: &Arena) -> &'static str {
        match self.statuses[row] {
            UnitStatus::Resolved => "resolved",
            UnitStatus::StringTable => "string_table",
            UnitStatus::Unresolved => "unresolved",
        }
    }
}

impl Arena {
    /// Parallel composition, followed by deterministic side-dictionary interning. Each row is
    /// claimed once; singleton groups need no ID until they appear in evidence.
    pub(super) fn occurrence_ids(
        &mut self,
        query: &mut EngineQuery,
        rows: &[u32],
        measure: &mut Measure,
    ) -> Result<()> {
        let data = Arc::clone(
            self.occurrences
                .data
                .as_ref()
                .ok_or("Missing occurrence relation.")?,
        );
        if self.occurrences.ids.len() < data.len() {
            self.occurrences.ids.resize(data.len(), None);
        }
        let mut rows = rows
            .iter()
            .copied()
            .filter(|row| self.occurrences.ids[*row as usize].is_none())
            .collect::<Vec<_>>();
        rows.sort_unstable();
        rows.dedup();
        let strings = rows
            .iter()
            .flat_map(|row| {
                ["object", "property", "row"].map(|field| data.value(*row as usize, field))
            })
            .collect::<Vec<_>>();
        self.load_strings(&mut query.reader, &strings)?;
        let ids = measure.parallel(&rows, |row| data.id(*row as usize, self));
        for (row, id) in rows.into_iter().zip(ids) {
            self.occurrences.ids[row as usize] = Some(self.string(&id)?);
        }
        Ok(())
    }
    pub(super) fn occurrence_location_field(&self, row: u32, name: &str) -> Atom {
        let Some(data) = &self.occurrences.data else {
            return Atom::Null;
        };
        let row = row as usize;
        let kind = data.value(row, "location");
        let field = match name {
            "objectPath" => "object",
            "propertyPath" if kind != 2 => "property",
            "classPath" if kind == 0 => "class",
            "row" if kind == 1 => "row",
            "entryKey" if kind == 2 => "row",
            "kind" => return self.occurrences.location_kinds[kind as usize],
            _ => return Atom::Null,
        };
        Atom::Str(StrId(data.value(row, field)))
    }
}
