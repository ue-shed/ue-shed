//! Native path and label predicates over persisted byte arenas.
use crate::engine_query::EngineQuery;
use crate::join_policy::file_key;
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use rayon::prelude::*;
use rustc_hash::{FxBuildHasher, FxHashMap, FxHasher};
use std::collections::HashSet;
use std::sync::Arc;

pub(crate) struct Arena {
    starts: Arc<[u32]>,
    bytes: Arc<[u8]>,
}
impl Arena {
    fn open(query: &EngineQuery, name: &str) -> Result<Self> {
        let (starts, bytes) = rayon::join(
            || query.reader.column(&format!("query.place.{name}_offsets")),
            || query.reader.bytes(&format!("query.place.{name}_bytes")),
        );
        let (starts, bytes) = (starts?, bytes?);
        require(
            starts.first() == Some(&0)
                && starts
                    .last()
                    .is_some_and(|last| *last as usize <= bytes.len())
                && starts.windows(2).all(|pair| pair[0] <= pair[1]),
            "Invalid place byte ranges.",
        )?;
        Ok(Self { starts, bytes })
    }
    pub fn get(&self, row: u32) -> Result<&[u8]> {
        let row = row as usize;
        let begin = *self.starts.get(row).ok_or("Place row outside index.")? as usize;
        let end = *self.starts.get(row + 1).ok_or("Place end outside index.")? as usize;
        self.bytes
            .get(begin..end)
            .ok_or_else(|| "Place byte range outside arena.".into())
    }
    pub fn text(&self, row: u32) -> Result<String> {
        Wtf8Buf::from_bytes(self.get(row)?.to_vec()).map(Wtf8Buf::into_view)
    }
    fn prefix(&self, wanted: &[u8]) -> Result<Vec<bool>> {
        (0..self.starts.len() - 1)
            .map(|row| Ok(self.get(row as u32)?.starts_with(wanted)))
            .collect()
    }
}

/// Label rows by their bytes: an open-addressed table of rows into the label arena, so no label
/// is copied. Its size is a power of two, at least twice the labels; `EMPTY` marks a free slot.
struct LabelIds {
    slots: Vec<u32>,
}

const EMPTY: u32 = u32::MAX;

fn label_hash(bytes: &[u8]) -> usize {
    use std::hash::Hasher;
    let mut hasher = FxHasher::default();
    hasher.write(bytes);
    hasher.finish() as usize
}

impl LabelIds {
    /// Every label's row, rejecting a label that appears twice.
    fn new(labels: &Arena) -> Result<Self> {
        let count = labels.starts.len() - 1;
        require(count < EMPTY as usize, "Too many place labels.")?;
        let mut slots = vec![EMPTY; (count * 2).next_power_of_two().max(8)];
        let mask = slots.len() - 1;
        for row in 0..count as u32 {
            let bytes = labels.get(row)?;
            let mut slot = label_hash(bytes) & mask;
            loop {
                let held = slots[slot];
                if held == EMPTY {
                    slots[slot] = row;
                    break;
                }
                require(labels.get(held)? != bytes, "Duplicate place label.")?;
                slot = (slot + 1) & mask;
            }
        }
        Ok(Self { slots })
    }

    /// The row of the label whose bytes are `wanted`.
    fn get(&self, labels: &Arena, wanted: &[u8]) -> Option<u32> {
        let mask = self.slots.len() - 1;
        let mut slot = label_hash(wanted) & mask;
        loop {
            let held = self.slots[slot];
            if held == EMPTY {
                return None;
            }
            if labels.get(held).is_ok_and(|bytes| bytes == wanted) {
                return Some(held);
            }
            slot = (slot + 1) & mask;
        }
    }
}

/// The projection's columns `Places::open` reads, in `Places` order.
const COLUMNS: [&str; 13] = [
    "file_ids",
    "file_values",
    "asset",
    "namespace_ids",
    "namespace_values",
    "path_ids",
    "occurrence_object",
    "occurrence_package",
    "rank",
    "folder_starts",
    "folder_keys",
    "folder_labels",
    "scanned_keys",
];

pub(crate) struct Places {
    pub labels: Arena,
    label_ids: LabelIds,
    files: FxHashMap<u32, usize>,
    pub file_values: Arc<[u32]>,
    pub assets: Arc<[u32]>,
    namespaces: FxHashMap<u32, u32>,
    paths: FxHashMap<u32, usize>,
    path: Arena,
    manifest: Arena,
    pub objects: Arc<[u32]>,
    pub packages: Arc<[u32]>,
    pub rank: Arc<[u32]>,
    pub folder_starts: Arc<[u32]>,
    pub folder_keys: Arc<[u32]>,
    pub folder_labels: Arc<[u32]>,
    pub scanned_keys: Arc<[u32]>,
}

pub(crate) struct Prefix {
    path: Vec<bool>,
    manifest: Vec<bool>,
}

impl Places {
    pub fn open(query: &EngineQuery) -> Result<Arc<Self>> {
        if let Some(places) = query.places.get() {
            return Ok(places);
        }
        // The label table builds while the other columns load; every load is independent.
        let (labels, (columns, arenas)) = rayon::join(
            || -> Result<(Arena, LabelIds)> {
                let labels = Arena::open(query, "label")?;
                let label_ids = LabelIds::new(&labels)?;
                Ok((labels, label_ids))
            },
            || {
                rayon::join(
                    || {
                        COLUMNS
                            .par_iter()
                            .map(|name| query.reader.column(&format!("query.place.{name}")))
                            .collect::<Result<Vec<_>>>()
                    },
                    || {
                        ["path", "manifest"]
                            .par_iter()
                            .map(|name| Arena::open(query, name))
                            .collect::<Result<Vec<_>>>()
                    },
                )
            },
        );
        let (labels, label_ids) = labels?;
        let [
            file_ids,
            file_values,
            assets,
            namespace_ids,
            namespace_values,
            path_ids,
            objects,
            packages,
            rank,
            folder_starts,
            folder_keys,
            folder_labels,
            scanned_keys,
        ]: [Arc<[u32]>; 13] = columns?.try_into().map_err(|_| "Invalid place columns.")?;
        let [path, manifest]: [Arena; 2] =
            arenas?.try_into().map_err(|_| "Invalid place arenas.")?;
        require(
            file_ids.len() == assets.len() && file_ids.len() == file_values.len(),
            "Invalid file projection.",
        )?;
        require(
            namespace_ids.len() == namespace_values.len(),
            "Invalid namespace projection.",
        )?;
        // Later duplicates replace earlier ones, as collecting into a map did.
        let mut files = FxHashMap::with_capacity_and_hasher(file_ids.len(), FxBuildHasher);
        for (row, id) in file_ids.iter().enumerate() {
            files.insert(*id, row);
        }
        let mut namespaces =
            FxHashMap::with_capacity_and_hasher(namespace_ids.len(), FxBuildHasher);
        for (id, value) in namespace_ids.iter().zip(namespace_values.iter()) {
            namespaces.insert(*id, *value);
        }
        let mut paths = FxHashMap::with_capacity_and_hasher(path_ids.len(), FxBuildHasher);
        for (row, id) in path_ids.iter().enumerate() {
            paths.insert(*id, row);
        }
        let places = Arc::new(Self {
            labels,
            label_ids,
            files,
            file_values,
            assets,
            namespaces,
            paths,
            path,
            manifest,
            objects,
            packages,
            rank,
            folder_starts,
            folder_keys,
            folder_labels,
            scanned_keys,
        });
        Ok(query.places.store(places))
    }
    pub fn labels(&self, values: &[String], files: bool) -> HashSet<u32> {
        values
            .iter()
            .filter_map(|value| {
                let value = if files {
                    file_key(value)
                } else {
                    value.clone()
                };
                self.label_ids
                    .get(&self.labels, Wtf8Buf::from_view(&value).as_bytes())
            })
            .collect()
    }
    pub fn prefix(&self, value: &str) -> Result<Prefix> {
        let value = Wtf8Buf::from_view(&EngineQuery::normalized_path(value));
        Ok(Prefix {
            path: self.path.prefix(value.as_bytes())?,
            manifest: self.manifest.prefix(value.as_bytes())?,
        })
    }
    pub fn path_matches(&self, id: u32, prefix: &Prefix) -> Result<bool> {
        let row = *self.paths.get(&id).ok_or("Unknown occurrence path.")?;
        prefix
            .path
            .get(row)
            .copied()
            .ok_or_else(|| "Path row outside predicate.".into())
    }
    pub fn manifest_matches(&self, row: u32, prefix: &Prefix) -> Result<bool> {
        prefix
            .manifest
            .get(row as usize)
            .copied()
            .ok_or_else(|| "Manifest row outside predicate.".into())
    }
    pub fn file_row(&self, id: u32) -> Result<usize> {
        self.files
            .get(&id)
            .copied()
            .ok_or_else(|| "Unknown file in query projection.".into())
    }
    pub fn asset(&self, id: u32) -> Result<u32> {
        self.assets
            .get(self.file_row(id)?)
            .copied()
            .ok_or_else(|| "Invalid asset row.".into())
    }
    pub fn namespace(&self, id: u32) -> Result<u32> {
        self.namespaces
            .get(&id)
            .copied()
            .ok_or_else(|| "Unknown query namespace.".into())
    }
}
