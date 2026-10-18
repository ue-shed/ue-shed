//! Replace authored package records using existing global IDs for every retained record.
use crate::builder::PackageInput;
use crate::join_columns::{column, layer};
use crate::snapshot::{Reader, integers};
use crate::store::Store;
use crate::{Error, ErrorCode, Result, require};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

type Columns = BTreeMap<String, (String, Vec<u32>)>;
struct Records {
    columns: Columns,
    copies: Vec<usize>,
    packages: usize,
}
impl Records {
    fn new(columns: Columns) -> Result<Self> {
        let get = |name: &str| {
            columns
                .get(name)
                .map(|(_, values)| values.as_slice())
                .ok_or_else(|| Error::from(format!("missing package column {name}")))
        };
        let packages = get("package.path")?.len();
        let occurrences = get("occurrence.source")?.len();
        let gaps = get("gap.reason")?.len();
        let missing = get("missing.key")?.len();
        let mut copies = vec![0usize];
        for value in get("occurrence.copies")? {
            let count = if value & 1 != 0 {
                (value >> 2) as usize
            } else {
                0
            };
            copies.push(
                copies
                    .last()
                    .copied()
                    .ok_or("copy offset")?
                    .checked_add(count)
                    .ok_or("copy overflow")?,
            );
        }
        require(copies.len() == occurrences + 1, "copy occurrence lengths")?;
        for (name, (_, values)) in &columns {
            let expected = if name.starts_with("package.") {
                if let Some(total) = match name.as_str() {
                    "package.occurrence_start" => Some(occurrences),
                    "package.gap_start" => Some(gaps),
                    "package.missing_start" => Some(missing),
                    _ => None,
                } {
                    require(
                        values.first() == Some(&0)
                            && values.last().map(|v| *v as usize) == Some(total)
                            && values.windows(2).all(|p| p[0] <= p[1]),
                        "package range order",
                    )?;
                    packages + 1
                } else {
                    packages
                }
            } else if name.starts_with("occurrence.") {
                occurrences
            } else if name.starts_with("copy.") {
                *copies.last().ok_or("copy offsets")?
            } else if name.starts_with("gap.") {
                gaps
            } else if name.starts_with("missing.") {
                missing
            } else {
                return Err(format!("unexpected package column {name}").into());
            };
            require(
                values.len() == expected,
                format!("package column length: {name}"),
            )?;
        }
        Ok(Self {
            columns,
            copies,
            packages,
        })
    }
    fn range(&self, name: &str, row: usize) -> Result<Range<usize>> {
        require(row < self.packages, "package row bounds")?;
        let offset = if name.starts_with("occurrence.") || name.starts_with("copy.") {
            "package.occurrence_start"
        } else if name.starts_with("gap.") {
            "package.gap_start"
        } else if name.starts_with("missing.") {
            "package.missing_start"
        } else {
            return Ok(row..row + 1);
        };
        let starts = &self.columns.get(offset).ok_or("package offsets")?.1;
        let mut range = starts[row] as usize..starts[row + 1] as usize;
        if name.starts_with("copy.") {
            range = self.copies[range.start]..self.copies[range.end];
        }
        Ok(range)
    }
}

fn authored(store: &mut Store, file: &std::path::Path) -> Result<Records> {
    let mut reader = Reader::open(file)?;
    let mut maps = BTreeMap::<String, Vec<u32>>::new();
    for index in 0..reader.entries.len() {
        let entry = reader.entries[index].clone();
        if entry.kind != 4 {
            continue;
        }
        let values = crate::snapshot::strings_bytes(&reader.load(index)?)?;
        let ids = maps.entry(entry.domain.clone()).or_default();
        for values in values.chunks(8192) {
            ids.extend(crate::bounded_intern::intern(store, &entry.domain, values)?);
        }
    }
    let mut columns = BTreeMap::new();
    for index in 0..reader.entries.len() {
        let entry = reader.entries[index].clone();
        if ![2, 3].contains(&entry.kind) || entry.name.ends_with(".starts") {
            continue;
        }
        let mut values = integers(&reader.load(index)?)?;
        let domain = if entry.kind == 3 {
            let map = maps.get(&entry.domain).ok_or("package string domain")?;
            for id in &mut values {
                *id = *map.get(*id as usize).ok_or("package local string ID")?;
            }
            entry.domain
        } else {
            String::new()
        };
        columns.insert(entry.name, (domain, values));
    }
    Records::new(columns)
}

pub(crate) fn publish(
    store: &mut Store,
    inputs: &[PackageInput],
    removed: &[String],
) -> Result<Vec<Value>> {
    for input in inputs {
        require(
            store.root["active"][&input.name].as_str() == Some(&input.previous_key),
            Error::new(
                ErrorCode::StaleGeneration,
                "package shard changed before replacement",
            ),
        )?;
    }
    let mut records = Vec::new();
    for input in inputs {
        if let Some(record) = store.root["layers"].get(&input.key).cloned() {
            require(
                record["storeGeneration"] == store.root["generation"],
                "cached package generation",
            )?;
            let mut cached = Reader::open(
                &store
                    .directory
                    .join(record["file"].as_str().ok_or("cached package file")?),
            )?;
            crate::store::section(&mut cached, "shared.meta")?;
            if input.key != input.previous_key {
                let old = store.root["layers"][&input.previous_key].clone();
                let obsolete = store.obsolete_bytes(&old, &record)?;
                store.root["garbageUpperBytes"] = serde_json::json!(
                    store.root["garbageUpperBytes"]
                        .as_u64()
                        .unwrap_or(0)
                        .checked_add(obsolete)
                        .ok_or("package garbage estimate overflow")?
                );
            }
            store.root["active"][&input.name] = Value::String(input.key.clone());
            records.push(record);
            continue;
        }
        let (mut reader, record) =
            layer(store, &input.previous_key)?.ok_or("previous package shard")?;
        require(
            record["storeGeneration"] == store.root["generation"],
            "previous package generation",
        )?;
        let mut columns = Columns::new();
        for entry in reader.entries.clone() {
            if entry.kind != 2 {
                continue;
            }
            let domain = record["stringColumns"][&entry.name]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let values = column(&mut reader, &record, &entry.name)?;
            columns.insert(entry.name, (domain, values));
        }
        let old = Records::new(columns)?;
        let new = authored(store, &input.file)?;
        require(
            old.columns.keys().eq(new.columns.keys())
                && old
                    .columns
                    .iter()
                    .all(|(name, (domain, _))| new.columns[name].0 == *domain),
            "package column format changed",
        )?;
        let selected = input
            .rows
            .iter()
            .map(|row| {
                if *row >= 0 {
                    (&old, *row as usize)
                } else {
                    (&new, (-1 - row) as usize)
                }
            })
            .collect::<Vec<_>>();
        let mut paths = BTreeSet::new();
        let mut replacements = BTreeSet::new();
        for (records, row) in &selected {
            require(*row < records.packages, "replacement package row bounds")?;
            require(
                paths.insert(records.columns["package.path"].1[*row]),
                "duplicate replacement package path",
            )?;
            if std::ptr::eq(*records, &new) {
                replacements.insert(*row);
            }
        }
        require(
            replacements.len() == new.packages,
            "unused replacement package records",
        )?;
        let mut output = Vec::new();
        for (name, (domain, _)) in &old.columns {
            let offset = match name.as_str() {
                "package.occurrence_start" => Some("occurrence.source"),
                "package.gap_start" => Some("gap.reason"),
                "package.missing_start" => Some("missing.key"),
                _ => None,
            };
            let mut values = Vec::<u32>::new();
            if let Some(field) = offset {
                values.push(0);
                for (records, row) in &selected {
                    let end = values
                        .last()
                        .copied()
                        .ok_or("replacement offset")?
                        .checked_add(u32::try_from(records.range(field, *row)?.len())?)
                        .ok_or("replacement offset overflow")?;
                    values.push(end);
                }
            } else {
                for (records, row) in &selected {
                    let range = records.range(name, *row)?;
                    values.extend_from_slice(
                        records.columns[name]
                            .1
                            .get(range)
                            .ok_or("package value range")?,
                    );
                }
            }
            output.push((name.clone(), domain.clone(), values));
        }
        let next =
            store.prepare_global(&input.name, &input.key, &output, &[], &BTreeMap::new(), &[])?;
        let obsolete = store.obsolete_bytes(&record, &next)?;
        store.root["garbageUpperBytes"] = serde_json::json!(
            store.root["garbageUpperBytes"]
                .as_u64()
                .unwrap_or(0)
                .checked_add(obsolete)
                .ok_or("package garbage estimate overflow")?
        );
        records.push(next);
    }
    for name in removed {
        store.root["active"]
            .as_object_mut()
            .ok_or("active package layers")?
            .remove(name);
    }
    store.publish_root()?;
    Ok(records)
}
