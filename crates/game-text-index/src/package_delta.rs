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
    /// The package offsets an extent's values are ranged by; a package column has none.
    fn starts(&self, extent: Extent) -> Result<Option<&[u32]>> {
        let offset = match extent {
            Extent::Package => return Ok(None),
            Extent::Occurrence | Extent::Copy => "package.occurrence_start",
            Extent::Gap => "package.gap_start",
            Extent::Missing => "package.missing_start",
        };
        Ok(Some(
            self.columns
                .get(offset)
                .ok_or("package offsets")?
                .1
                .as_slice(),
        ))
    }
    /// A package row's values in a column of `extent`, given that extent's `starts`.
    fn span(&self, extent: Extent, starts: Option<&[u32]>, row: usize) -> Range<usize> {
        let Some(starts) = starts else {
            return row..row + 1;
        };
        let range = starts[row] as usize..starts[row + 1] as usize;
        if matches!(extent, Extent::Copy) {
            self.copies[range.start]..self.copies[range.end]
        } else {
            range
        }
    }
}

/// What a package column's values are counted per: package, occurrence, copy, gap or missing key.
#[derive(Clone, Copy)]
enum Extent {
    Package,
    Occurrence,
    Copy,
    Gap,
    Missing,
}
impl Extent {
    fn of(name: &str) -> Self {
        if name.starts_with("occurrence.") {
            Self::Occurrence
        } else if name.starts_with("copy.") {
            Self::Copy
        } else if name.starts_with("gap.") {
            Self::Gap
        } else if name.starts_with("missing.") {
            Self::Missing
        } else {
            Self::Package
        }
    }
}

/// A file's local strings by domain, each domain's blocks in file order.
type LocalStrings = BTreeMap<String, Vec<Vec<u8>>>;

fn local_strings(file: &std::path::Path) -> Result<LocalStrings> {
    let reader = Reader::open(file)?;
    let mut strings = LocalStrings::new();
    for index in 0..reader.entries.len() {
        if reader.entries[index].kind != 4 {
            continue;
        }
        let values = crate::snapshot::strings_bytes(&reader.load(index)?)?;
        strings
            .entry(reader.entries[index].domain.clone())
            .or_default()
            .extend(values);
    }
    Ok(strings)
}

/// The dictionary segments interning `files` adds: 8192-string chunks of each domain, or one
/// segment per domain.
fn segment_demand<'a>(files: impl IntoIterator<Item = &'a LocalStrings>) -> (usize, usize) {
    let mut totals = BTreeMap::<&str, usize>::new();
    for file in files {
        for (domain, values) in file {
            if !values.is_empty() {
                *totals.entry(domain).or_default() += values.len();
            }
        }
    }
    (
        totals.values().map(|count| count.div_ceil(8192)).sum(),
        totals.len(),
    )
}

/// Interns every file's strings one domain at a time across all files, so a change to every
/// shard adds a few segments per domain instead of one per shard and domain. Returns each file's
/// local-to-global ID map per domain.
fn intern_across(
    store: &mut Store,
    mut files: Vec<LocalStrings>,
    bounded: bool,
) -> Result<Vec<BTreeMap<String, Vec<u32>>>> {
    let domains = files
        .iter()
        .flat_map(|file| file.keys().cloned())
        .collect::<BTreeSet<_>>();
    let mut maps = vec![BTreeMap::new(); files.len()];
    for domain in domains {
        let mut values = Vec::new();
        let mut owners = Vec::new();
        for (owner, file) in files.iter_mut().enumerate() {
            if let Some(local) = file.remove(&domain) {
                owners.push((owner, local.len()));
                values.extend(local);
            }
        }
        let mut ids = Vec::with_capacity(values.len());
        if bounded {
            for chunk in values.chunks(8192) {
                ids.extend(store.intern_bytes(&domain, chunk)?);
            }
        } else if !values.is_empty() {
            ids = store.intern_bytes(&domain, &values)?;
        }
        require(ids.len() == values.len(), "package string count")?;
        let mut start = 0;
        for (owner, count) in owners {
            maps[owner].insert(domain.clone(), ids[start..start + count].to_vec());
            start += count;
        }
    }
    Ok(maps)
}

fn authored(file: &std::path::Path, maps: &BTreeMap<String, Vec<u32>>) -> Result<Records> {
    let reader = Reader::open(file)?;
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

/// Adds the bytes a replaced layer leaves unreachable to the root's garbage estimate.
fn add_garbage(store: &mut Store, old: &Value, next: &Value) -> Result<()> {
    let obsolete = store.obsolete_bytes(old, next)?;
    store.root["garbageUpperBytes"] = serde_json::json!(
        store.root["garbageUpperBytes"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(obsolete)
            .ok_or("package garbage estimate overflow")?
    );
    Ok(())
}

/// Replaces every input shard and removes `removed` in one root publication. Rows select each
/// record of the next shard: a retained row of the previous shard, or a record of the input
/// file. A shard with no retained row (one the store doesn't hold, or one in an older column
/// format) is written from its file alone.
#[cfg(test)]
pub(crate) fn publish(
    store: &mut Store,
    inputs: &[PackageInput],
    removed: &[String],
) -> Result<Vec<Value>> {
    publish_timed(store, inputs, removed, &mut Vec::new())
}

/// `publish`, adding each stage's seconds to `stages`.
pub(crate) fn publish_timed(
    store: &mut Store,
    inputs: &[PackageInput],
    removed: &[String],
    stages: &mut Vec<(&'static str, f64)>,
) -> Result<Vec<Value>> {
    let _span = crate::scan_timings::Span::new("package_delta.publish");
    let mut clock = std::time::Instant::now();
    let mut charge = |stage: &'static str, totals: &mut BTreeMap<&'static str, f64>| {
        let now = std::time::Instant::now();
        *totals.entry(stage).or_default() += (now - clock).as_secs_f64();
        clock = now;
    };
    let mut totals = BTreeMap::new();
    for input in inputs {
        require(
            store.root["active"][&input.name].as_str() == input.previous_key.as_deref(),
            Error::new(
                ErrorCode::StaleGeneration,
                "package shard changed before replacement",
            ),
        )?;
    }
    // Compaction remaps every global ID. Complete it before loading any old record columns.
    // Only active destinations survive compaction. Cached inactive keys may need reauthoring.
    let active = store.root["active"]
        .as_object()
        .ok_or("active layers")?
        .values()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let mut staged = BTreeMap::new();
    for (index, input) in inputs.iter().enumerate() {
        if !active.contains(&input.key) {
            staged.insert(index, local_strings(&input.file)?);
        }
    }
    let (chunks, domains) = segment_demand(staged.values());
    let bounded = store.reserve_segments(chunks, domains)?;
    // Inputs still cached after any compaction need no strings.
    let authored_inputs = staged
        .into_iter()
        .filter(|(index, _)| store.root["layers"].get(&inputs[*index].key).is_none())
        .collect::<Vec<_>>();
    let (owners, files): (Vec<_>, Vec<_>) = authored_inputs.into_iter().unzip();
    let mut maps = owners
        .into_iter()
        .zip(intern_across(store, files, bounded)?)
        .collect::<BTreeMap<_, _>>();
    charge("publish.strings", &mut totals);
    let mut records = Vec::new();
    for (index, input) in inputs.iter().enumerate() {
        if let Some(record) = store.root["layers"].get(&input.key).cloned() {
            require(
                record["storeGeneration"] == store.root["generation"],
                "cached package generation",
            )?;
            let cached = Reader::open(
                &store
                    .directory
                    .join(record["file"].as_str().ok_or("cached package file")?),
            )?;
            crate::store::section(&cached, "shared.meta")?;
            if let Some(previous) = &input.previous_key
                && input.key != *previous
            {
                let old = store.root["layers"][previous].clone();
                add_garbage(store, &old, &record)?;
            }
            store.root["active"][&input.name] = Value::String(input.key.clone());
            records.push(record);
            continue;
        }
        let rows = input.rows()?;
        let previous = match &input.previous_key {
            Some(key) => Some(
                store.root["layers"]
                    .get(key)
                    .cloned()
                    .ok_or("previous package shard")?,
            ),
            None => None,
        };
        // Only retained rows need the previous shard's columns.
        let old = match &input.previous_key {
            Some(key) if rows.iter().any(|row| *row >= 0) => {
                let (mut reader, record) = layer(store, key)?.ok_or("previous package shard")?;
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
                Some(Records::new(columns)?)
            }
            _ => None,
        };
        charge("publish.previous", &mut totals);
        let new = authored(
            &input.file,
            &maps.remove(&index).ok_or("uninterned package input")?,
        )?;
        require(
            old.as_ref().is_none_or(|old| {
                old.columns.keys().eq(new.columns.keys())
                    && old
                        .columns
                        .iter()
                        .all(|(name, (domain, _))| new.columns[name].0 == *domain)
            }),
            "package column format changed",
        )?;
        let selected = rows
            .iter()
            .map(|row| {
                if *row >= 0 {
                    old.as_ref()
                        .map(|old| (old, *row as usize))
                        .ok_or_else(|| Error::from("retained row without a previous shard"))
                } else {
                    Ok((&new, (-1 - row) as usize))
                }
            })
            .collect::<Result<Vec<_>>>()?;
        let mut paths = Vec::with_capacity(selected.len());
        let mut replacements = vec![false; new.packages];
        let mut replaced = 0;
        for (records, row) in &selected {
            require(*row < records.packages, "replacement package row bounds")?;
            paths.push(records.columns["package.path"].1[*row]);
            if std::ptr::eq(*records, &new) && !std::mem::replace(&mut replacements[*row], true) {
                replaced += 1;
            }
        }
        paths.sort_unstable();
        require(
            paths.windows(2).all(|pair| pair[0] != pair[1]),
            "duplicate replacement package path",
        )?;
        require(
            replaced == new.packages,
            "unused replacement package records",
        )?;
        // Each column resolves its offsets once, not once per row.
        let mut output = Vec::new();
        for (name, (domain, _)) in &new.columns {
            let counted = match name.as_str() {
                "package.occurrence_start" => Some(Extent::Occurrence),
                "package.gap_start" => Some(Extent::Gap),
                "package.missing_start" => Some(Extent::Missing),
                _ => None,
            };
            let extent = counted.unwrap_or(Extent::of(name));
            let new_starts = new.starts(extent)?;
            let old_starts = match &old {
                Some(old) => old.starts(extent)?,
                None => None,
            };
            let mut values = Vec::<u32>::with_capacity(selected.len() + 1);
            if counted.is_some() {
                values.push(0);
                let mut end = 0u32;
                for (records, row) in &selected {
                    let row_starts = if std::ptr::eq(*records, &new) {
                        new_starts
                    } else {
                        old_starts
                    };
                    end = end
                        .checked_add(u32::try_from(records.span(extent, row_starts, *row).len())?)
                        .ok_or("replacement offset overflow")?;
                    values.push(end);
                }
            } else {
                let new_values = &new.columns[name].1;
                let old_values = old.as_ref().map(|old| &old.columns[name].1);
                for (records, row) in &selected {
                    let (row_starts, source) = if std::ptr::eq(*records, &new) {
                        (new_starts, new_values)
                    } else {
                        (old_starts, old_values.ok_or("previous package column")?)
                    };
                    values.extend_from_slice(
                        source
                            .get(records.span(extent, row_starts, *row))
                            .ok_or("package value range")?,
                    );
                }
            }
            output.push((name.clone(), domain.clone(), values));
        }
        charge("publish.splice", &mut totals);
        let next =
            store.prepare_global(&input.name, &input.key, &output, &[], &BTreeMap::new(), &[])?;
        charge("publish.encode", &mut totals);
        if let Some(record) = &previous {
            add_garbage(store, record, &next)?;
        }
        charge("publish.garbage", &mut totals);
        records.push(next);
    }
    for name in removed {
        store.root["active"]
            .as_object_mut()
            .ok_or("active package layers")?
            .remove(name);
    }
    store.publish_root()?;
    charge("publish.root", &mut totals);
    stages.extend(totals);
    Ok(records)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::snapshot::{Writer, string_block, u32_bytes};
    use crate::store::{Configuration, dictionary_bytes, token};
    use std::path::{Path, PathBuf};

    fn input(directory: &Path, path: &str, key: &str, sources: &[String]) -> Result<PathBuf> {
        let file = directory.join(format!("{key}.snapshot"));
        let mut writer = Writer::new(&directory.join(format!("{}.payload", token())))?;
        let mut order = Vec::new();
        for (domain, values) in [
            ("paths", vec![path.to_owned()]),
            ("identity", vec![key.to_owned()]),
            ("source", sources.to_vec()),
        ] {
            // One string per block makes the cached revert require the per-domain path.
            for (block, value) in values.iter().enumerate() {
                let index = writer.add(
                    &format!("{domain}.b{block}"),
                    4,
                    domain,
                    &string_block(std::slice::from_ref(value))?,
                    1,
                )?;
                writer.entries[index].strings = values.len() as u32;
                order.push(index);
            }
            order.push(writer.column(
                &format!("{domain}.starts"),
                &(0..values.len() as u32).collect::<Vec<_>>(),
            )?);
        }
        for (name, domain, values) in [
            ("package.path", "paths", vec![0]),
            ("package.signature", "identity", vec![0]),
            (
                "occurrence.source",
                "source",
                (0..sources.len() as u32).collect(),
            ),
        ] {
            let index = writer.add(name, 3, domain, &u32_bytes(&values), 1)?;
            writer.entries[index].strings = if domain == "source" {
                sources.len() as u32
            } else {
                1
            };
            order.push(index);
        }
        for (name, values) in [
            ("package.status", vec![0]),
            ("package.occurrence_start", vec![0, sources.len() as u32]),
            ("package.gap_start", vec![0, 0]),
            ("package.missing_start", vec![0, 0]),
            ("occurrence.copies", vec![0; sources.len()]),
            ("gap.reason", vec![]),
            ("missing.key", vec![]),
        ] {
            order.push(writer.column(name, &values)?);
        }
        writer.finish(&file, &order)?;
        Ok(file)
    }

    #[test]
    fn mixed_cached_revert_reserves_inputs_evicted_by_compaction() -> Result<()> {
        let configuration = Configuration {
            cache_root: crate::test_directory("cached-package-revert"),
            project_key: "project".into(),
            target_key: "text".into(),
            shared_project: false,
            view_prefix: None,
        };
        let mut store = Store::writer(configuration.clone())?;
        let sources = (0..300)
            .map(|row| format!("retained-{row}"))
            .collect::<Vec<_>>();
        let a = input(&configuration.cache_root, "first", "a", &sources)?;
        let c = input(&configuration.cache_root, "first", "c", &["current".into()])?;
        let old = input(&configuration.cache_root, "second", "old", &["old".into()])?;
        let b = input(&configuration.cache_root, "second", "b", &["new".into()])?;
        store.publish_local("package-text.0", "a", &a)?;
        store.publish_local("package-text.0", "c", &c)?;
        store.publish_local("package-text.1", "old", &old)?;
        while store.root["segments"].as_array().ok_or("segments")?.len() < 256 {
            store.intern(
                "source",
                &[format!(
                    "dead-{}",
                    store.root["segments"].as_array().ok_or("segments")?.len()
                )],
            )?;
        }
        store.publish_root()?;
        assert!(store.root["layers"].get("a").is_some());
        let generation = store.root["generation"].clone();
        let result = publish(
            &mut store,
            &[
                PackageInput {
                    name: "package-text.1".into(),
                    key: "b".into(),
                    previous_key: Some("old".into()),
                    rows_file: None,
                    file: b,
                    rows: vec![-1],
                },
                PackageInput {
                    name: "package-text.0".into(),
                    key: "a".into(),
                    previous_key: Some("c".into()),
                    rows_file: None,
                    file: a,
                    rows: vec![-1],
                },
            ],
            &[],
        )?;
        assert_eq!(result.len(), 2);
        assert_ne!(store.root["generation"], generation);
        assert_eq!(store.root["active"]["package-text.0"], "a");
        assert_eq!(store.root["active"]["package-text.1"], "b");
        let values = dictionary_bytes(&store.directory, &store.root)?;
        for (name, expected) in [
            ("package-text.0", sources),
            ("package-text.1", vec!["new".into()]),
        ] {
            let (mut reader, record) = layer(&store, name)?.ok_or("package layer")?;
            let ids = column(&mut reader, &record, "occurrence.source")?;
            assert_eq!(
                ids.iter()
                    .map(|id| String::from_utf8(values[*id as usize].clone()))
                    .collect::<std::result::Result<Vec<_>, _>>()?,
                expected
            );
        }
        // An already-active destination cannot be evicted and still needs no authored input.
        publish(
            &mut store,
            &[PackageInput {
                name: "package-text.0".into(),
                key: "a".into(),
                previous_key: Some("a".into()),
                rows_file: None,
                file: configuration.cache_root.join("not-staged.snapshot"),
                rows: vec![],
            }],
            &[],
        )?;
        drop(store);
        let reopened = Store::writer(configuration.clone())?;
        assert_eq!(reopened.root["active"]["package-text.0"], "a");
        assert_eq!(reopened.root["active"]["package-text.1"], "b");
        drop(reopened);
        std::fs::remove_dir_all(configuration.cache_root)?;
        Ok(())
    }

    /// A shard snapshot of `packages` (path, signature, sources), in the given (path) order.
    pub(crate) fn shard(
        directory: &Path,
        key: &str,
        packages: &[(String, String, Vec<String>)],
    ) -> PathBuf {
        let file = directory.join(format!("{key}.snapshot"));
        let mut writer = Writer::new(&directory.join(format!("{}.payload", token()))).unwrap();
        let mut order = Vec::new();
        let sources = packages
            .iter()
            .flat_map(|(_, _, sources)| sources.clone())
            .collect::<Vec<_>>();
        for (domain, values) in [
            ("paths", packages.iter().map(|p| p.0.clone()).collect()),
            ("identity", packages.iter().map(|p| p.1.clone()).collect()),
            ("source", sources.clone()),
        ] {
            let values: Vec<String> = values;
            if values.is_empty() {
                continue;
            }
            let index = writer
                .add(
                    &format!("{domain}.b0"),
                    4,
                    domain,
                    &string_block(&values).unwrap(),
                    1,
                )
                .unwrap();
            writer.entries[index].strings = values.len() as u32;
            order.push(index);
            order.push(writer.column(&format!("{domain}.starts"), &[0]).unwrap());
        }
        let count = |values: usize| (0..values as u32).collect::<Vec<_>>();
        for (name, domain, values) in [
            ("package.path", "paths", count(packages.len())),
            ("package.signature", "identity", count(packages.len())),
            ("occurrence.source", "source", count(sources.len())),
        ] {
            let index = writer.add(name, 3, domain, &u32_bytes(&values), 1).unwrap();
            writer.entries[index].strings = values.len() as u32;
            order.push(index);
        }
        let mut starts = vec![0u32];
        for (_, _, sources) in packages {
            starts.push(starts.last().unwrap() + sources.len() as u32);
        }
        for (name, values) in [
            ("package.status", vec![0; packages.len()]),
            ("package.occurrence_start", starts),
            ("package.gap_start", vec![0; packages.len() + 1]),
            ("package.missing_start", vec![0; packages.len() + 1]),
            ("occurrence.copies", vec![0; sources.len()]),
            ("gap.reason", vec![]),
            ("missing.key", vec![]),
        ] {
            order.push(writer.column(name, &values).unwrap());
        }
        writer.finish(&file, &order).unwrap();
        file
    }

    pub(crate) fn package(shard: usize, name: &str, source: &str) -> (String, String, Vec<String>) {
        (
            format!("Content/S{shard:03}/{name}.uasset"),
            format!("{name}-signature"),
            vec![format!("{source} {shard}")],
        )
    }

    /// The shard's packages and their occurrence sources, as text.
    fn contents(store: &Store, name: &str) -> Result<Vec<(String, Vec<String>)>> {
        let values = dictionary_bytes(&store.directory, &store.root)?;
        let text = |id: &u32| String::from_utf8(values[*id as usize].clone()).unwrap();
        let (mut reader, record) = layer(store, name)?.ok_or("package layer")?;
        let paths = column(&mut reader, &record, "package.path")?;
        let starts = column(&mut reader, &record, "package.occurrence_start")?;
        let sources = column(&mut reader, &record, "occurrence.source")?;
        Ok(paths
            .iter()
            .enumerate()
            .map(|(row, path)| {
                (
                    text(path),
                    sources[starts[row] as usize..starts[row + 1] as usize]
                        .iter()
                        .map(text)
                        .collect(),
                )
            })
            .collect())
    }

    #[test]
    fn one_publication_replaces_every_shard_and_adds_a_new_one() -> Result<()> {
        let configuration = Configuration {
            cache_root: crate::test_directory("package-delta-every-shard"),
            project_key: "project".into(),
            target_key: "text".into(),
            shared_project: false,
            view_prefix: None,
        };
        let root = configuration.cache_root.clone();
        let mut store = Store::writer(configuration.clone())?;
        // 255 held shards of two packages; the change adds a package to every one, edits the
        // second package of every other one, and starts shard 255.
        for group in 0..255 {
            let file = shard(
                &root,
                &format!("old-{group}"),
                &[package(group, "B", "kept"), package(group, "D", "before")],
            );
            store.publish_local(
                &format!("package-text.{group}"),
                &format!("old-{group}"),
                &file,
            )?;
        }
        // A full dictionary makes the replacement compact before it reads any previous shard.
        while store.root["segments"].as_array().ok_or("segments")?.len() < 256 {
            let next = store.root["segments"].as_array().ok_or("segments")?.len();
            store.intern("source", &[format!("dead-{next}")])?;
        }
        store.publish_root()?;
        let mut inputs = Vec::new();
        for group in 0..256 {
            let edited = group % 2 == 0;
            let mut changed = vec![package(group, "A", "added")];
            if edited {
                changed.push(package(group, "D", "after"));
            }
            let file = shard(&root, &format!("new-{group}"), &changed);
            let (previous_key, rows) = if group == 255 {
                (None, vec![-1])
            } else if edited {
                // A (new row 0), B (old row 0), D (new row 1).
                (Some(format!("old-{group}")), vec![-1, 0, -2])
            } else {
                (Some(format!("old-{group}")), vec![-1, 0, 1])
            };
            // Half the inputs send their rows as a file.
            let rows_file = (group % 4 < 2).then(|| {
                let path = root.join(format!("rows-{group}.i32"));
                let bytes = rows
                    .iter()
                    .flat_map(|row| (*row as i32).to_le_bytes())
                    .collect::<Vec<_>>();
                std::fs::write(&path, bytes).unwrap();
                path
            });
            inputs.push(PackageInput {
                name: format!("package-text.{group}"),
                key: format!("new-{group}"),
                previous_key,
                file,
                rows: if rows_file.is_some() { vec![] } else { rows },
                rows_file,
            });
        }
        let request = crate::builder::BuildRequest::PublishPackages {
            configuration: configuration.clone(),
            inputs: inputs.clone(),
            removed_names: vec![],
        };
        request.validate()?;
        let generation = store.root["generation"].clone();
        let records = publish(&mut store, &inputs, &[])?;
        assert_eq!(records.len(), 256);
        assert_ne!(
            store.root["generation"], generation,
            "the dictionary was compacted"
        );
        assert!(store.root["segments"].as_array().ok_or("segments")?.len() <= 256);
        drop(store);
        let store = Store::writer(configuration.clone())?;
        for group in 0..256 {
            assert_eq!(
                store.root["active"][format!("package-text.{group}")],
                format!("new-{group}")
            );
            let mut expected = vec![(
                format!("Content/S{group:03}/A.uasset"),
                vec![format!("added {group}")],
            )];
            if group < 255 {
                expected.push((
                    format!("Content/S{group:03}/B.uasset"),
                    vec![format!("kept {group}")],
                ));
                let text = if group % 2 == 0 { "after" } else { "before" };
                expected.push((
                    format!("Content/S{group:03}/D.uasset"),
                    vec![format!("{text} {group}")],
                ));
            }
            assert_eq!(
                contents(&store, &format!("package-text.{group}"))?,
                expected
            );
        }
        drop(store);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn a_stale_or_unheld_shard_is_rejected_before_anything_is_written() -> Result<()> {
        let configuration = Configuration {
            cache_root: crate::test_directory("package-delta-stale"),
            project_key: "project".into(),
            target_key: "text".into(),
            shared_project: false,
            view_prefix: None,
        };
        let root = configuration.cache_root.clone();
        let mut store = Store::writer(configuration.clone())?;
        let held = shard(&root, "held", &[package(0, "B", "kept")]);
        store.publish_local("package-text.0", "held", &held)?;
        let file = shard(&root, "next", &[package(0, "A", "added")]);
        let generation = store.root["generation"].clone();
        for previous_key in [None, Some("other".to_owned())] {
            let error = publish(
                &mut store,
                &[PackageInput {
                    name: "package-text.0".into(),
                    key: "next".into(),
                    previous_key,
                    file: file.clone(),
                    rows: vec![-1],
                    rows_file: None,
                }],
                &[],
            )
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::StaleGeneration);
        }
        assert_eq!(store.root["generation"], generation);
        // A retained row needs a previous shard.
        let error = publish(
            &mut store,
            &[PackageInput {
                name: "package-text.1".into(),
                key: "fresh".into(),
                previous_key: None,
                file,
                rows: vec![0],
                rows_file: None,
            }],
            &[],
        )
        .unwrap_err();
        assert!(error.to_string().contains("retained row"));
        drop(store);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
