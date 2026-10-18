//! Native path and label predicates over persisted byte arenas.
use crate::engine_query::EngineQuery;
use crate::join_policy::file_key;
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub(crate) struct Arena {
    starts: Arc<[u32]>,
    bytes: Arc<[u8]>,
}
impl Arena {
    fn open(query: &mut EngineQuery, name: &str) -> Result<Self> {
        let starts = query
            .reader
            .column(&format!("query.place.{name}_offsets"))?;
        let bytes = query.reader.bytes(&format!("query.place.{name}_bytes"))?;
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

pub(crate) struct Places {
    pub labels: Arena,
    label_ids: HashMap<Vec<u8>, u32>,
    files: HashMap<u32, usize>,
    pub file_values: Arc<[u32]>,
    pub assets: Arc<[u32]>,
    namespaces: HashMap<u32, u32>,
    paths: HashMap<u32, usize>,
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
    pub fn open(query: &mut EngineQuery) -> Result<Arc<Self>> {
        if let Some(places) = &query.places {
            return Ok(Arc::clone(places));
        }
        let labels = Arena::open(query, "label")?;
        let mut label_ids = HashMap::new();
        for row in 0..labels.starts.len() - 1 {
            require(
                label_ids
                    .insert(labels.get(row as u32)?.to_vec(), row as u32)
                    .is_none(),
                "Duplicate place label.",
            )?;
        }
        let file_ids = query.reader.column("query.place.file_ids")?;
        let file_values = query.reader.column("query.place.file_values")?;
        let assets = query.reader.column("query.place.asset")?;
        require(
            file_ids.len() == assets.len() && file_ids.len() == file_values.len(),
            "Invalid file projection.",
        )?;
        let namespace_ids = query.reader.column("query.place.namespace_ids")?;
        let namespace_values = query.reader.column("query.place.namespace_values")?;
        require(
            namespace_ids.len() == namespace_values.len(),
            "Invalid namespace projection.",
        )?;
        let path_ids = query.reader.column("query.place.path_ids")?;
        let places = Arc::new(Self {
            labels,
            label_ids,
            files: file_ids
                .iter()
                .enumerate()
                .map(|(row, id)| (*id, row))
                .collect(),
            file_values,
            assets,
            namespaces: namespace_ids
                .iter()
                .copied()
                .zip(namespace_values.iter().copied())
                .collect(),
            paths: path_ids
                .iter()
                .enumerate()
                .map(|(row, id)| (*id, row))
                .collect(),
            path: Arena::open(query, "path")?,
            manifest: Arena::open(query, "manifest")?,
            objects: query.reader.column("query.place.occurrence_object")?,
            packages: query.reader.column("query.place.occurrence_package")?,
            rank: query.reader.column("query.place.rank")?,
            folder_starts: query.reader.column("query.place.folder_starts")?,
            folder_keys: query.reader.column("query.place.folder_keys")?,
            folder_labels: query.reader.column("query.place.folder_labels")?,
            scanned_keys: query.reader.column("query.place.scanned_keys")?,
        });
        query.places = Some(Arc::clone(&places));
        Ok(places)
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
                    .get(Wtf8Buf::from_view(&value).as_bytes())
                    .copied()
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
