//! Persist the same path predicates and UTF-16 label ranks as Phase 6's query places.
use crate::Result;
use crate::join::{Joined, ordinal};
use crate::join_columns::{NS, O_OBJECT, PATH};
use crate::join_policy::{file_key, folder, normalized, trim};
use std::collections::{BTreeSet, HashMap};

type Column = (String, String, Vec<u32>);
#[derive(Default)]
struct Labels {
    ids: HashMap<String, u32>,
    values: Vec<String>,
}
impl Labels {
    fn intern(&mut self, value: &str) -> u32 {
        if let Some(id) = self.ids.get(value) {
            return *id;
        }
        let id = self.values.len() as u32;
        self.values.push(value.into());
        self.ids.insert(value.into(), id);
        id
    }
}
fn path(value: &str) -> String {
    normalized(trim(value)).to_lowercase()
}
fn unique(j: &Joined, columns: &[&[u32]]) -> Vec<u32> {
    let ids = columns
        .iter()
        .flat_map(|v| v.iter())
        .copied()
        .collect::<BTreeSet<_>>();
    let mut values = ids
        .into_iter()
        .map(|id| (id, crate::wtf8::Wtf8Buf::from_view(j.string(id))))
        .collect::<Vec<_>>();
    values.sort_by(|a, b| a.1.as_bytes().cmp(b.1.as_bytes()));
    values.into_iter().map(|v| v.0).collect()
}
fn push(result: &mut Vec<Column>, name: &str, domain: &str, values: Vec<u32>) {
    result.push((format!("query.place.{name}"), domain.into(), values));
}
fn pack(result: &mut Vec<Column>, name: &str, values: &[String]) -> Result<()> {
    let (bytes, offsets) = crate::join_query::packed(values)?;
    push(result, &format!("{name}_bytes"), "", bytes);
    push(result, &format!("{name}_offsets"), "", offsets);
    Ok(())
}
pub(crate) fn columns(
    j: &Joined,
    query: &[Column],
    files: &[u32],
    paths: Vec<Column>,
) -> Result<Vec<Column>> {
    let find = |name| {
        query
            .iter()
            .find(|v| v.0 == name)
            .map(|v| v.2.as_slice())
            .ok_or("query place input missing")
    };
    let mut result = Vec::new();
    let mut labels = Labels::default();
    labels.intern("");
    let ids = unique(
        j,
        &[files, find("query.raw.files")?, find("query.slice.files")?],
    );
    let mut assets = Vec::new();
    let mut file_labels = Vec::new();
    let mut starts = Vec::new();
    let mut folders = Vec::new();
    let mut folder_keys = Vec::new();
    let mut folder_cache = HashMap::<String, Vec<(u32, u32)>>::new();
    let mut folder_key_ids = HashMap::<u32, u32>::new();
    let mut asset_key_ids = HashMap::<u32, u32>::new();
    for id in &ids {
        let value = j.string(*id);
        file_labels.push(labels.intern(value));
        let asset = labels.intern(&file_key(value));
        assets.push(asset);
        asset_key_ids.insert(*id, asset);
        starts.push(folders.len() as u32);
        let parent = folder(value);
        if let Some(cached) = folder_cache.get(parent) {
            for (label, key) in cached {
                folders.push(*label);
                folder_keys.push(*key);
            }
        } else {
            let parts = parent.split('/').collect::<Vec<_>>();
            let mut cached = Vec::with_capacity(parts.len());
            for depth in 1..=parts.len() {
                let label = parts[..depth].join("/");
                let label_id = labels.intern(&label);
                let key = *folder_key_ids
                    .entry(label_id)
                    .or_insert_with(|| labels.intern(&path(&label)));
                folders.push(label_id);
                folder_keys.push(key);
                cached.push((label_id, key));
            }
            folder_cache.insert(parent.to_owned(), cached);
        }
    }
    starts.push(folders.len() as u32);
    push(&mut result, "file_ids", "paths", ids);
    push(&mut result, "file_values", "", file_labels);
    push(&mut result, "asset", "", assets);
    push(&mut result, "folder_starts", "", starts);
    push(&mut result, "folder_labels", "", folders);
    push(&mut result, "folder_keys", "", folder_keys);
    let namespaces = unique(j, &[&j.line[NS], find("query.raw.namespace")?]);
    let namespace_values = namespaces
        .iter()
        .map(|id| labels.intern(j.string(*id)))
        .collect();
    push(&mut result, "namespace_ids", "identity", namespaces);
    push(&mut result, "namespace_values", "", namespace_values);
    let scanned_keys = j
        .packages
        .paths
        .iter()
        .map(|id| {
            *asset_key_ids
                .entry(*id)
                .or_insert_with(|| labels.intern(&file_key(j.string(*id))))
        })
        .collect();
    push(&mut result, "scanned_keys", "", scanned_keys);
    drop(folder_cache);
    drop(folder_key_ids);
    drop(asset_key_ids);
    let mut order = (0..labels.values.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| ordinal(&labels.values[*a], &labels.values[*b]));
    let mut rank = vec![0; order.len()];
    for (row, id) in order.into_iter().enumerate() {
        rank[id] = row as u32;
    }
    push(&mut result, "rank", "", rank);
    pack(&mut result, "label", &labels.values)?;
    drop(labels);
    result.extend(paths);
    Ok(result)
}

/// Path columns depend only on the completed join, so queries can prepare beside them.
pub(crate) fn prepare_paths(j: &Joined) -> Result<Vec<Column>> {
    let mut result = Vec::new();
    let path_ids = unique(j, &[&j.packages.paths, &j.packages.occurrence[O_OBJECT]]);
    let paths = path_ids
        .iter()
        .map(|id| path(j.string(*id)))
        .collect::<Vec<_>>();
    push(&mut result, "path_ids", "paths", path_ids);
    push(
        &mut result,
        "occurrence_object",
        "paths",
        j.packages.occurrence[O_OBJECT].clone(),
    );
    let occurrence_package = j
        .packages
        .package_row
        .iter()
        .map(|row| j.packages.paths[*row as usize])
        .collect();
    push(
        &mut result,
        "occurrence_package",
        "paths",
        occurrence_package,
    );
    pack(&mut result, "path", &paths)?;
    let paths = (0..j.manifest.columns[PATH].len())
        .map(|row| j.manifest.path(row, &j.strings).map(|v| path(&v)))
        .collect::<Result<Vec<_>>>()?;
    pack(&mut result, "manifest", &paths)?;
    Ok(result)
}
