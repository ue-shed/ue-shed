//! Persist the same path predicates and UTF-16 label ranks as Phase 6's query places.
use crate::Result;
use crate::join::{Joined, ordinal};
use crate::join_columns::{NS, O_OBJECT, PATH};
use crate::join_policy::{file_key, folder, normalized, trim};
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::borrow::Cow;

type Column = (String, String, Vec<u32>);
/// Distinct labels in first-interned order. Each is stored once: `table` is an open-addressed
/// index of IDs into `values`, a power of two in size, `EMPTY` where free, at most 70% full.
#[derive(Default)]
struct Labels {
    table: Vec<u32>,
    values: Vec<String>,
}
const EMPTY: u32 = u32::MAX;
fn label_hash(value: &str) -> usize {
    use std::hash::Hasher;
    let mut hasher = rustc_hash::FxHasher::default();
    hasher.write(value.as_bytes());
    hasher.finish() as usize
}
impl Labels {
    /// `value`'s ID, or the free slot it would take.
    fn find(&self, value: &str) -> std::result::Result<u32, usize> {
        let mask = self.table.len() - 1;
        let mut slot = label_hash(value) & mask;
        loop {
            match self.table[slot] {
                EMPTY => return Err(slot),
                id if self.values[id as usize] == value => return Ok(id),
                _ => slot = (slot + 1) & mask,
            }
        }
    }
    /// Room for one more label within the load factor, rehashing into a doubled table if not.
    fn reserve_one(&mut self) {
        if (self.values.len() + 1) * 10 <= self.table.len() * 7 {
            return;
        }
        let size = (self.table.len() * 2).max(16);
        self.table = vec![EMPTY; size];
        let mask = size - 1;
        for (id, value) in self.values.iter().enumerate() {
            let mut slot = label_hash(value) & mask;
            while self.table[slot] != EMPTY {
                slot = (slot + 1) & mask;
            }
            self.table[slot] = id as u32;
        }
    }
    fn insert(&mut self, value: impl AsRef<str> + Into<String>) -> u32 {
        self.reserve_one();
        match self.find(value.as_ref()) {
            Ok(id) => id,
            Err(slot) => {
                let id = self.values.len() as u32;
                self.table[slot] = id;
                self.values.push(value.into());
                id
            }
        }
    }
    fn intern(&mut self, value: &str) -> u32 {
        self.insert(value)
    }
    /// `intern` for a value already owned, which a new label keeps without copying.
    fn intern_owned(&mut self, value: String) -> u32 {
        self.insert(value)
    }
}
fn path(value: &str) -> String {
    normalized(trim(value)).to_lowercase()
}
fn wtf8_bytes(view: &str) -> Cow<'_, [u8]> {
    if !view.as_bytes().contains(&0xf3) {
        Cow::Borrowed(view.as_bytes())
    } else {
        Cow::Owned(crate::wtf8::Wtf8Buf::from_view(view).into_bytes())
    }
}
fn unique(j: &Joined, columns: &[&[u32]]) -> Vec<u32> {
    let cap: usize = columns.iter().map(|c| c.len()).sum();
    let mut seen = FxHashSet::with_capacity_and_hasher(cap.min(1 << 20), Default::default());
    let mut ids = Vec::with_capacity(cap.min(1 << 20));
    for column in columns {
        for &id in *column {
            if seen.insert(id) {
                ids.push(id);
            }
        }
    }
    let bytes = ids
        .par_iter()
        .map(|&id| wtf8_bytes(j.string(id)))
        .collect::<Vec<_>>();
    let mut indices = (0..ids.len()).collect::<Vec<_>>();
    indices.par_sort_unstable_by(|&a, &b| bytes[a].as_ref().cmp(bytes[b].as_ref()));
    indices.into_iter().map(|i| ids[i]).collect()
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
    let mut folder_cache = FxHashMap::<String, Vec<(u32, u32)>>::default();
    let mut folder_key_ids = FxHashMap::<u32, u32>::default();
    let mut asset_key_ids = FxHashMap::<u32, u32>::default();
    for id in &ids {
        let value = j.string(*id);
        file_labels.push(labels.intern(value));
        let asset = labels.intern_owned(file_key(value));
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
                    .or_insert_with(|| labels.intern_owned(path(&label)));
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
    // The keys of scanned packages not already labelled, computed in parallel, then interned in
    // scan order so label IDs are assigned as before.
    let mut computed = j
        .packages
        .paths
        .par_iter()
        .map(|id| (!asset_key_ids.contains_key(id)).then(|| file_key(j.string(*id))))
        .collect::<Vec<_>>();
    let scanned_keys = j
        .packages
        .paths
        .iter()
        .zip(computed.iter_mut())
        .map(|(id, computed)| {
            *asset_key_ids.entry(*id).or_insert_with(|| {
                labels.intern_owned(computed.take().unwrap_or_else(|| file_key(j.string(*id))))
            })
        })
        .collect();
    drop(computed);
    push(&mut result, "scanned_keys", "", scanned_keys);
    drop(folder_cache);
    drop(folder_key_ids);
    drop(asset_key_ids);
    let mut order = (0..labels.values.len()).collect::<Vec<_>>();
    order.par_sort_unstable_by(|a, b| ordinal(&labels.values[*a], &labels.values[*b]));
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
        .par_iter()
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

#[cfg(test)]
mod tests {
    use super::Labels;

    #[test]
    fn labels_keep_first_interned_ids_across_growth() {
        let mut labels = Labels::default();
        assert_eq!(labels.intern(""), 0);
        let values = (0..1000).map(|n| format!("Label/{n}")).collect::<Vec<_>>();
        for (index, value) in values.iter().enumerate() {
            let id = if index % 2 == 0 {
                labels.intern(value)
            } else {
                labels.intern_owned(value.clone())
            };
            assert_eq!(id as usize, index + 1);
        }
        for (index, value) in values.iter().enumerate() {
            assert_eq!(labels.intern(value) as usize, index + 1);
            assert_eq!(labels.intern_owned(value.clone()) as usize, index + 1);
        }
        assert_eq!(labels.intern(""), 0);
        assert_eq!(labels.values.len(), values.len() + 1);
        assert_eq!(&labels.values[1..], values.as_slice());
    }
}
