//! Read-only pinned native query view. No writer lease or JavaScript column reconstruction.
use crate::dictionary_image::{self, SegmentImage, SegmentKey};
use crate::snapshot::{Reader, integers};
use crate::store::{Configuration, decode_ids, open_root, section};
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result, require};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Arc;

const MAX_PATCH_ROWS: usize = 8192;

struct Layer {
    reader: Reader,
    record: Value,
}

struct Segment {
    key: SegmentKey,
    start: u32,
    count: u32,
    reader: Reader,
    offsets: Vec<u32>,
    frames: Vec<u32>,
    /// The segment's strings for random access, built on the reader's first string lookup.
    image: Option<Arc<SegmentImage>>,
}

impl Segment {
    fn image(&self) -> Result<&SegmentImage> {
        Ok(self.image.as_ref().ok_or("Dictionary image is absent.")?)
    }
}

/// A string ID's segment and its index within the segment.
fn string_position(segments: &[Segment], id: u32) -> Result<(usize, usize)> {
    let segment_index = segments
        .partition_point(|segment| segment.start <= id)
        .checked_sub(1)
        .ok_or("String ID precedes dictionary.")?;
    let segment = &segments[segment_index];
    let local = id
        .checked_sub(segment.start)
        .ok_or("Invalid local string ID.")? as usize;
    require(
        local < segment.count as usize,
        "String ID exceeds dictionary.",
    )?;
    Ok((segment_index, local))
}

/// A string through its segment's image, once every segment is imaged.
fn imaged_string(segments: &[Segment], id: u32) -> Result<String> {
    let (segment_index, local) = string_position(segments, id)?;
    Wtf8Buf::from_bytes(segments[segment_index].image()?.get(local)?).map(Wtf8Buf::into_view)
}

/// Raw columns a rule evaluation reads. They belong to the evaluation, not to the reader's
/// query cache, and are dropped as soon as the evaluation has built what it needs from them.
#[derive(Default)]
struct ScopedColumns {
    columns: HashMap<(String, String), Arc<[u32]>>,
    bytes: HashMap<String, Arc<[u8]>>,
}
/// Every input is selected from the same immutable joined metadata and held open until drop.
/// Writers may publish or compact concurrently without changing this reader's results.
pub struct EngineReader {
    evaluation: Option<ScopedColumns>,
    pub generation: String,
    pub joined_key: String,
    pub meta: Value,
    base: String,
    layers: HashMap<String, Layer>,
    segments: Vec<Segment>,
    columns: HashMap<(String, String), Arc<[u32]>>,
    byte_columns: HashMap<String, Arc<[u8]>>,
    imaged: bool,
    empty_ids: Option<Arc<BTreeSet<u32>>>,
}

fn text(value: &Value, name: &str) -> Result<String> {
    Ok(value[name]
        .as_str()
        .ok_or_else(|| format!("Missing {name}."))?
        .to_owned())
}

fn parse(bytes: &[u8]) -> Result<Value> {
    crate::json_value::parse(std::str::from_utf8(bytes)?)
}

fn open_layer(directory: &Path, root: &Value, key: &str) -> Result<Layer> {
    let record = root["layers"]
        .get(key)
        .ok_or("Missing query input layer.")?
        .clone();
    let reader = Reader::open(&directory.join(text(&record, "file")?))?;
    Ok(Layer { reader, record })
}

impl EngineReader {
    /// Read-only opens never create or repair caches. A publication racing acquisition retries
    /// the entire acquisition; a returned reader never reopens inputs by mutable filesystem names.
    pub fn open(configuration: &Configuration, expected_joined: Option<&str>) -> Result<Self> {
        let directory = configuration.directory()?;
        for attempt in 0..3 {
            match Self::acquire(configuration, expected_joined) {
                Ok(reader) => return Ok(reader),
                Err(error)
                    if matches!(error.code, ErrorCode::Io | ErrorCode::NotFound) && attempt < 2 =>
                {
                    if !directory.join("manifest.json").exists() {
                        return Err(Error::with_source(
                            ErrorCode::NotFound,
                            "No committed Game Text index.",
                            error,
                        ));
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(Error::new(
            ErrorCode::Unavailable,
            "Could not pin the Game Text snapshot.",
        ))
    }

    fn acquire(configuration: &Configuration, expected_joined: Option<&str>) -> Result<Self> {
        let (_, mut root) = open_root(configuration)?;
        if let Some(prefix) = &configuration.view_prefix {
            let active = root["active"]
                .as_object_mut()
                .ok_or("Invalid active layers.")?;
            for name in ["joined", "joined-base", "joined.invalidated"] {
                active.remove(name);
                if let Some(value) = active.get(&format!("{prefix}{name}")).cloned() {
                    active.insert(name.into(), value);
                }
            }
        }
        require(
            root["active"].get("joined.invalidated").is_none(),
            Error::new(
                ErrorCode::StaleGeneration,
                "The joined view was invalidated; refresh it before querying.",
            ),
        )?;
        let joined_key = root["active"]["joined"]
            .as_str()
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "No joined target is published."))?
            .to_owned();
        require(
            expected_joined.is_none_or(|expected| expected == joined_key),
            Error::new(
                ErrorCode::StaleGeneration,
                "The joined target changed before its reader opened.",
            ),
        )?;
        let generation = text(&root, "generation")?;
        let directory = configuration.directory()?;
        let mut joined = open_layer(&directory, &root, &joined_key)?;
        require(
            joined
                .reader
                .entries
                .iter()
                .find(|entry| entry.name == "join.meta")
                .is_some_and(|entry| entry.raw <= 16 * 1024 * 1024),
            "Joined metadata exceeds its bound.",
        )?;
        let meta = parse(&section(&mut joined.reader, "join.meta")?)?;
        require(
            meta["generation"] == generation,
            Error::new(
                ErrorCode::StaleGeneration,
                "Joined target dictionary generation differs.",
            ),
        )?;
        require(
            matches!(meta["version"].as_u64(), Some(3 | 4)),
            "Unsupported joined metadata version.",
        )?;
        for kind in ["raw", "slice"] {
            if meta["sourcePatches"].get(kind).is_some() {
                require(
                    meta["version"] == 4 && meta["base"].is_string(),
                    "Invalid source-patch base or version.",
                )?;
                for field in ["sources", "source_start", "source_end"] {
                    require(
                        meta["patches"]
                            .get(format!("query.{kind}.{field}"))
                            .is_none(),
                        "Overlapping source patches.",
                    )?;
                }
            }
        }
        let base = meta["base"].as_str().unwrap_or(&joined_key).to_owned();
        if meta["base"].is_string() {
            require(
                root["active"]["joined-base"] == base,
                Error::new(
                    ErrorCode::StaleGeneration,
                    "The joined base is no longer retained.",
                ),
            )?;
        }
        let mut wanted = BTreeSet::from([base.clone()]);
        for (name, key) in meta["dependencies"]
            .as_object()
            .ok_or("Invalid joined dependencies.")?
        {
            require(
                root["active"].get(name) == Some(key),
                Error::new(
                    ErrorCode::StaleGeneration,
                    "Joined inputs changed; refresh the target before opening a reader.",
                ),
            )?;
            wanted.insert(key.as_str().ok_or("Invalid dependency key.")?.to_owned());
        }
        let mut layers = HashMap::from([(joined_key.clone(), joined)]);
        for key in wanted {
            if !layers.contains_key(&key) {
                layers.insert(key.clone(), open_layer(&directory, &root, &key)?);
            }
        }
        let mut segments = Vec::new();
        for record in root["segments"]
            .as_array()
            .ok_or("Invalid dictionary segments.")?
        {
            let path = directory.join(text(record, "file")?);
            let mut reader = Reader::open(&path)?;
            let offsets = integers(&section(&mut reader, "front.offsets")?)?;
            let frames = integers(&section(&mut reader, "front.frames")?)?;
            let start = u32::try_from(record["start"].as_u64().ok_or("Invalid segment start.")?)?;
            let count = u32::try_from(record["count"].as_u64().ok_or("Invalid segment count.")?)?;
            require(
                offsets.len() == frames.len() && offsets.len() == (count as usize).div_ceil(64),
                "Invalid dictionary fence lengths.",
            )?;
            segments.push(Segment {
                key: (path, start, count),
                start,
                count,
                reader,
                offsets,
                frames,
                image: None,
            });
        }
        Ok(Self {
            evaluation: None,
            generation,
            joined_key,
            meta,
            base,
            layers,
            segments,
            columns: HashMap::new(),
            byte_columns: HashMap::new(),
            imaged: false,
            empty_ids: None,
        })
    }

    /// Heap bytes of the cached columns, dictionary images and evaluation scope.
    pub(crate) fn cache_bytes(&self) -> usize {
        let columns = |columns: &HashMap<(String, String), Arc<[u32]>>| {
            columns
                .values()
                .map(|column| column.len() * 4)
                .sum::<usize>()
        };
        let bytes = |bytes: &HashMap<String, Arc<[u8]>>| {
            bytes.values().map(|value| value.len()).sum::<usize>()
        };
        columns(&self.columns)
            + bytes(&self.byte_columns)
            + self
                .segments
                .iter()
                .filter_map(|segment| segment.image.as_ref())
                .map(|image| image.heap_bytes())
                .sum::<usize>()
            + self
                .evaluation
                .as_ref()
                .map_or(0, |scope| columns(&scope.columns) + bytes(&scope.bytes))
    }
    pub(crate) fn begin_evaluation(&mut self) -> Result<()> {
        require(self.evaluation.is_none(), "Nested rule column scope.")?;
        self.evaluation = Some(ScopedColumns::default());
        Ok(())
    }
    pub(crate) fn release_evaluation_columns(&mut self) {
        if let Some(scope) = &mut self.evaluation {
            *scope = ScopedColumns::default();
        }
    }
    pub(crate) fn end_evaluation(&mut self) {
        self.evaluation = None;
    }
    fn raw_columns(&mut self) -> &mut HashMap<(String, String), Arc<[u32]>> {
        match &mut self.evaluation {
            Some(scope) => &mut scope.columns,
            None => &mut self.columns,
        }
    }
    fn raw_bytes(&mut self) -> &mut HashMap<String, Arc<[u8]>> {
        match &mut self.evaluation {
            Some(scope) => &mut scope.bytes,
            None => &mut self.byte_columns,
        }
    }
    pub fn layer_column(&mut self, key: &str, name: &str) -> Result<Arc<[u32]>> {
        let cache_key = (key.to_owned(), name.to_owned());
        if let Some(values) = self.raw_columns().get(&cache_key) {
            return Ok(Arc::clone(values));
        }
        let layer = self
            .layers
            .get_mut(key)
            .ok_or("Query input was not pinned.")?;
        let bytes = section(&mut layer.reader, name)?;
        let values: Arc<[u32]> = if layer.record["stringColumns"].get(name).is_some() {
            decode_ids(&bytes, layer.record["idEncoding"] == "delta32")?
        } else {
            integers(&bytes)?
        }
        .into();
        self.raw_columns().insert(cache_key, Arc::clone(&values));
        Ok(values)
    }

    pub fn input_column(&mut self, name: &str, field: &str) -> Result<Arc<[u32]>> {
        let key = self.meta["dependencies"][name]
            .as_str()
            .ok_or("Joined input dependency is absent.")?
            .to_owned();
        self.layer_column(&key, field)
    }

    pub fn input_metadata(&mut self, name: &str, section_name: &str) -> Result<Value> {
        let key = self.meta["dependencies"][name]
            .as_str()
            .ok_or("Joined input dependency is absent.")?;
        let layer = self
            .layers
            .get_mut(key)
            .ok_or("Query input was not pinned.")?;
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("inputMetadata");
        parse(&section(&mut layer.reader, section_name)?)
    }

    /// Packed byte arenas use numeric physical sections. Read them directly so native query
    /// opens do not retain both a decoded u32 copy and a byte copy of every identity/source arena.
    pub fn bytes(&mut self, name: &str) -> Result<Arc<[u8]>> {
        if let Some(value) = self.raw_bytes().get(name) {
            return Ok(Arc::clone(value));
        }
        require(
            self.meta["patches"].get(name).is_none(),
            "Byte arenas cannot use scalar patches.",
        )?;
        let fields = if let Some(chunks) = self.meta["chunks"][name].as_array() {
            chunks
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or("Invalid byte chunk.")
                })
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            vec![
                self.meta["aliases"][name]
                    .as_str()
                    .unwrap_or(name)
                    .to_owned(),
            ]
        };
        let layer = self
            .layers
            .get_mut(&self.base)
            .ok_or("Query base was not pinned.")?;
        let mut bytes = Vec::new();
        for field in fields {
            require(
                layer.record["stringColumns"].get(&field).is_none(),
                "A string-ID column is not a byte arena.",
            )?;
            bytes.extend_from_slice(&section(&mut layer.reader, &field)?);
        }
        let bytes: Arc<[u8]> = bytes.into();
        self.raw_bytes().insert(name.into(), Arc::clone(&bytes));
        Ok(bytes)
    }

    /// Read logical columns: immutable full-build columns plus one flat bounded overlay.
    pub fn column(&mut self, name: &str) -> Result<Arc<[u32]>> {
        let cache_key = (String::new(), name.to_owned());
        if let Some(values) = self.raw_columns().get(&cache_key) {
            return Ok(Arc::clone(values));
        }
        if let Some(kind) = self.source_patch_kind(name) {
            return self.source_patch(&kind, name);
        }
        let original = self.original_column(name)?;
        if self.meta["patches"][name].is_null() {
            self.raw_columns().insert(cache_key, Arc::clone(&original));
            return Ok(original);
        }
        let mut values = original.to_vec();
        if let Some(field) = self.meta["patches"][name].as_str().map(str::to_owned) {
            let key = self.joined_key.clone();
            let rows_name = self.meta["patchRows"][name]
                .as_str()
                .unwrap_or("patch.rows")
                .to_owned();
            let rows = self.layer_column(&key, &rows_name)?;
            let patch = self.layer_column(&key, &field)?;
            require(
                rows.len() <= MAX_PATCH_ROWS && rows.len() == patch.len(),
                "Invalid patch lengths.",
            )?;
            for (index, row) in rows.iter().enumerate() {
                require(
                    index == 0 || rows[index - 1] < *row,
                    "Invalid patch ordering.",
                )?;
                *values
                    .get_mut(*row as usize)
                    .ok_or("Patch row outside base column.")? = patch[index];
            }
        }
        let values: Arc<[u32]> = values.into();
        self.raw_columns().insert(cache_key, Arc::clone(&values));
        Ok(values)
    }

    fn original_column(&mut self, name: &str) -> Result<Arc<[u32]>> {
        let base = self.base.clone();
        if let Some(chunks) = self.meta["chunks"][name].as_array() {
            let chunks = chunks
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or("Invalid column chunk."))
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut values = Vec::new();
            for chunk in chunks {
                values.extend_from_slice(&self.layer_column(&base, &chunk)?);
            }
            Ok(values.into())
        } else {
            let field = self.meta["aliases"][name]
                .as_str()
                .unwrap_or(name)
                .to_owned();
            self.layer_column(&base, &field)
        }
    }

    fn source_patch_kind(&self, name: &str) -> Option<String> {
        ["raw", "slice"]
            .into_iter()
            .find(|kind| {
                self.meta["sourcePatches"][kind].is_object()
                    && ["sources", "source_start", "source_end"]
                        .iter()
                        .any(|field| name == format!("query.{kind}.{field}"))
            })
            .map(str::to_owned)
    }

    fn source_patch(&mut self, kind: &str, name: &str) -> Result<Arc<[u32]>> {
        let key = self.joined_key.clone();
        let patch = self.meta["sourcePatches"][kind].clone();
        let rows = self.layer_column(&key, &text(&patch, "rows")?)?;
        let starts = self.layer_column(&key, &text(&patch, "starts")?)?;
        let values = self.layer_column(&key, &text(&patch, "values")?)?;
        let prefix = format!("query.{kind}.");
        let mut original = Vec::new();
        for field in ["source_start", "source_end", "sources"] {
            original.push(self.original_column(&format!("{prefix}{field}"))?);
        }
        let [out_starts, out_ends, out_values] = crate::source_patch::splice(
            [&original[0], &original[1], &original[2]],
            &rows,
            &starts,
            &values,
        )?;
        for (field, values) in [
            ("source_start", out_starts),
            ("source_end", out_ends),
            ("sources", out_values),
        ] {
            self.columns
                .insert((String::new(), format!("{prefix}{field}")), values.into());
        }
        self.columns
            .get(&(String::new(), name.to_owned()))
            .cloned()
            .ok_or_else(|| "Source patch field is absent.".into())
    }

    pub fn value(&mut self, name: &str, row: usize) -> Result<u32> {
        self.column(name)?
            .get(row)
            .copied()
            .ok_or_else(|| format!("Row outside {name}.").into())
    }

    pub fn has_column(&self, name: &str) -> bool {
        if self.meta["chunks"].get(name).is_some() {
            return true;
        }
        let physical = self.meta["aliases"][name].as_str().unwrap_or(name);
        self.layers.get(&self.base).is_some_and(|layer| {
            layer
                .reader
                .entries
                .iter()
                .any(|entry| entry.name == physical)
        })
    }

    /// Images every segment for random access, building the missing images in parallel. A
    /// segment file never changes, so an image another reader built for it is reused.
    fn image_segments(&mut self) -> Result<()> {
        if self.imaged {
            return Ok(());
        }
        use rayon::prelude::*;
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("dictionaryImages");
        for segment in &mut self.segments {
            segment.image = dictionary_image::shared(&segment.key);
        }
        self.segments
            .par_iter_mut()
            .filter(|segment| segment.image.is_none())
            .try_for_each(|segment| -> Result<()> {
                let image = Arc::new(SegmentImage::build(
                    &mut segment.reader,
                    &segment.offsets,
                    &segment.frames,
                    segment.count,
                )?);
                dictionary_image::publish(segment.key.clone(), &image);
                segment.image = Some(image);
                Ok(())
            })?;
        self.imaged = true;
        Ok(())
    }

    /// One string, decoded alone from its segment's image. All dictionary IO uses pinned file
    /// descriptors, even after compaction unlinks old generation filenames.
    pub fn string(&mut self, id: u32) -> Result<String> {
        self.image_segments()?;
        imaged_string(&self.segments, id)
    }

    /// The global ID of a string equal to `value`, comparing its exact WTF-8 bytes. Each
    /// segment is sorted, so this is a binary search of each segment's image.
    pub fn find_string(&mut self, value: &str) -> Result<Option<u32>> {
        self.image_segments()?;
        let wanted = Wtf8Buf::from_view(value).into_bytes();
        for segment in &self.segments {
            if let Some(local) = segment.image()?.find(&wanted)? {
                return Ok(Some(segment.start + u32::try_from(local)?));
            }
        }
        Ok(None)
    }

    pub fn strings(&mut self, ids: &[u32]) -> Result<Vec<String>> {
        ids.iter().map(|id| self.string(*id)).collect()
    }

    /// The strings of many IDs, in their order, decoded in parallel.
    pub fn strings_batch(&mut self, ids: &[u32]) -> Result<Vec<String>> {
        use rayon::prelude::*;
        self.image_segments()?;
        let segments = &self.segments;
        ids.par_iter()
            .map(|id| imaged_string(segments, *id))
            .collect()
    }

    pub(crate) fn empty_string_ids(&mut self) -> Result<Arc<BTreeSet<u32>>> {
        if let Some(ids) = &self.empty_ids {
            return Ok(Arc::clone(ids));
        }
        // Each immutable segment is sorted by WTF-8 bytes. If it contains an empty string,
        // that string is first in the segment, at its own append-history-dependent global ID.
        let starts = self
            .segments
            .iter()
            .filter(|s| s.count > 0)
            .map(|s| s.start)
            .collect::<Vec<_>>();
        let mut ids = BTreeSet::new();
        for start in starts {
            if self.string(start)?.is_empty() {
                ids.insert(start);
            }
        }
        let ids = Arc::new(ids);
        self.empty_ids = Some(Arc::clone(&ids));
        Ok(ids)
    }

    pub fn dictionary_count(&self) -> Result<usize> {
        Ok(self
            .segments
            .last()
            .map_or(0, |segment| {
                u64::from(segment.start) + u64::from(segment.count)
            })
            .try_into()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn configuration() -> Configuration {
        Configuration {
            cache_root: crate::test_directory("engine-reader"),
            project_key: "fixture-project".into(),
            target_key: "Game".into(),
            shared_project: false,
            view_prefix: None,
        }
    }

    fn fixture(config: &Configuration) -> Result<(Store, Vec<u32>)> {
        let mut store = Store::writer(config.clone())?;
        let strings = [
            Wtf8Buf::from_utf8("First source"),
            Wtf8Buf::from_utf16(&[0xd800, 65, 0xdfff]),
        ];
        let ids = store.intern_bytes(
            "source",
            &strings
                .iter()
                .map(|s| s.as_bytes().to_vec())
                .collect::<Vec<_>>(),
        )?;
        let metadata = json!({"version":3,"generation":store.root["generation"],"dependencies":{},"aliases":{"line.source":"sources"},"count":2});
        store.publish_global(
            "joined",
            "joined-native-v1:base",
            &[
                ("sources".into(), "source".into(), ids.clone()),
                ("query.raw.source_start".into(), String::new(), vec![0, 1]),
                ("query.raw.source_end".into(), String::new(), vec![1, 2]),
                ("source-a".into(), "source".into(), vec![ids[0]]),
                ("source-b".into(), "source".into(), vec![ids[1]]),
            ],
            &serde_json::to_vec(&metadata)?,
            &BTreeMap::new(),
            &[],
        )?;
        Ok((store, ids))
    }

    #[test]
    fn reads_aliases_and_utf16_without_a_writer_or_eager_source_preparation() -> Result<()> {
        let config = configuration();
        let (store, ids) = fixture(&config)?;
        drop(store);
        let mut reader = EngineReader::open(&config, Some("joined-native-v1:base"))?;
        assert!(reader.columns.is_empty());
        assert!(
            reader
                .segments
                .iter()
                .all(|segment| segment.image.is_none())
        );
        assert_eq!(&*reader.column("line.source")?, &ids);
        assert_eq!(reader.string(ids[0])?, "First source");
        assert_eq!(
            Wtf8Buf::from_view(&reader.string(ids[1])?).to_utf16(),
            [0xd800, 65, 0xdfff]
        );
        let writer = Store::writer(config.clone())?;
        drop(writer);
        drop(reader);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn empty_string_lookup_uses_segment_content_in_shifted_append_only_dictionaries() -> Result<()>
    {
        let config = configuration();
        let (mut store, _) = fixture(&config)?;
        // The fixture's initial segment contains only nonempty strings, starting at ID zero.
        let empty = store.intern("identity", &[String::new()])?[0];
        assert_ne!(empty, 0);
        store.publish_root()?;
        let mut reader = EngineReader::open(&config, None)?;
        assert!(!reader.string(0)?.is_empty());
        assert_eq!(&*reader.empty_string_ids()?, &BTreeSet::from([empty]));
        assert_eq!(reader.string(empty)?, "");
        assert_eq!(&*reader.empty_string_ids()?, &BTreeSet::from([empty]));
        // Exact lookups search every segment, including the later appended one.
        assert_eq!(reader.find_string("")?, Some(empty));
        assert_eq!(reader.find_string("First source")?, Some(0));
        drop(reader);
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn exact_string_lookup_compares_wtf8_bytes_across_blocks() -> Result<()> {
        let config = configuration();
        let (mut store, fixture_ids) = fixture(&config)?;
        // More than one 64-string block, with case, prefix and lone-surrogate neighbours.
        let mut values = (0..150)
            .map(|n| format!("Spore {n:03}"))
            .collect::<Vec<_>>();
        values.extend(["spore 001".into(), "Spore".into(), "Spore 001 ".into()]);
        let lone = Wtf8Buf::from_utf16(&[0xd800, 65]).into_view();
        values.push(lone.clone());
        let bytes = values
            .iter()
            .map(|value| Wtf8Buf::from_view(value).into_bytes())
            .collect::<Vec<_>>();
        let ids = store.intern_bytes("source", &bytes)?;
        store.publish_root()?;
        drop(store);
        let mut reader = EngineReader::open(&config, None)?;
        for (value, id) in values.iter().zip(&ids) {
            assert_eq!(reader.find_string(value)?, Some(*id), "{value:?}");
        }
        assert_eq!(reader.find_string("First source")?, Some(fixture_ids[0]));
        for absent in ["Spore 150", "spore", "", "Spore 0", "Spore 001  "] {
            assert_eq!(reader.find_string(absent)?, None, "{absent:?}");
        }
        assert_eq!(
            reader.find_string(&Wtf8Buf::from_utf16(&[0xd800]).into_view())?,
            None
        );
        drop(reader);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn pinned_reader_survives_publication_and_compaction_without_reopening_old_paths() -> Result<()>
    {
        let config = configuration();
        let (mut store, ids) = fixture(&config)?;
        let mut reader = EngineReader::open(&config, None)?;
        let metadata = json!({"version":3,"generation":store.root["generation"],"dependencies":{},"aliases":{"line.source":"sources"},"count":1});
        store.publish_global(
            "joined",
            "joined-native-v1:next",
            &[("sources".into(), "source".into(), vec![ids[1]])],
            &serde_json::to_vec(&metadata)?,
            &BTreeMap::new(),
            &[],
        )?;
        assert_eq!(&*reader.column("line.source")?, &ids);
        assert!(store.compact(true)?.compacted);
        // These strings have never been read by the old reader. File handles, not warmed caches,
        // keep its dictionary available after the writer retires the old physical generation.
        assert_eq!(reader.string(ids[0])?, "First source");
        assert_eq!(
            Wtf8Buf::from_view(&reader.string(ids[1])?).to_utf16(),
            [0xd800, 65, 0xdfff]
        );
        drop(reader);
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn reads_flat_scalar_and_variable_source_patches_over_chunked_base_columns() -> Result<()> {
        let config = configuration();
        let (mut store, ids) = fixture(&config)?;
        let metadata = json!({"version":4,"generation":store.root["generation"],"dependencies":{},"base":"joined-native-v1:base","aliases":{"line.source":"sources"},"chunks":{"query.raw.sources":["source-a","source-b"]},"patches":{"line.source":"patch.source"},"patchRows":{},"sourcePatches":{"raw":{"rows":"source.rows","starts":"source.starts","values":"source.values"}},"count":2});
        store.publish_global(
            "joined",
            "joined-native-v1:patch",
            &[
                ("patch.rows".into(), String::new(), vec![1]),
                ("patch.source".into(), "source".into(), vec![ids[0]]),
                ("source.rows".into(), String::new(), vec![0]),
                ("source.starts".into(), String::new(), vec![0, 2]),
                (
                    "source.values".into(),
                    "source".into(),
                    vec![ids[1], ids[0]],
                ),
            ],
            &serde_json::to_vec(&metadata)?,
            &BTreeMap::from([("joined-base".into(), "joined-native-v1:base".into())]),
            &[],
        )?;
        let mut reader = EngineReader::open(&config, None)?;
        assert_eq!(&*reader.column("line.source")?, &[ids[0], ids[0]]);
        assert_eq!(
            &*reader.column("query.raw.sources")?,
            &[ids[1], ids[0], ids[1]]
        );
        assert_eq!(&*reader.column("query.raw.source_start")?, &[0, 2]);
        assert_eq!(&*reader.column("query.raw.source_end")?, &[2, 3]);
        drop(reader);
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn rejects_changed_joined_identity_instead_of_silently_opening_a_different_view() -> Result<()>
    {
        let config = configuration();
        let (store, _) = fixture(&config)?;
        let error = EngineReader::open(&config, Some("joined-native-v1:other"))
            .err()
            .ok_or("Expected stale view.")?;
        assert_eq!(error.code, ErrorCode::StaleGeneration);
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }
}
