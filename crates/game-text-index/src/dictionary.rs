//! Cold external sort, exact cross-domain deduplication, and A64 sort-rank IDs.
use crate::snapshot::{Reader, Writer, integers, u32_bytes};
use crate::{Result, require};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Serialize, Deserialize, Clone)]
pub struct LayerInput {
    pub name: String,
    pub file: PathBuf,
}
#[derive(Clone)]
pub(crate) enum LayerSource {
    File(PathBuf),
    Memory(std::sync::Arc<crate::localization::columns::LocalLayer>),
}
impl LayerSource {
    pub(crate) fn open(&self) -> Result<Reader> {
        match self {
            Self::File(path) => Reader::open(path),
            Self::Memory(layer) => Ok(Reader::memory(layer.clone())),
        }
    }
}
pub(crate) struct SourceLayer {
    pub name: String,
    pub key: String,
    pub source: LayerSource,
}
#[derive(Serialize, Deserialize)]
pub struct Segment {
    file: String,
    start: u32,
    count: u32,
    domain: String,
    domains: Vec<String>,
    #[serde(rename = "utf8Bytes")]
    utf8_bytes: u64,
    bytes: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerRecord {
    file: String,
    key: String,
    store_generation: String,
    segment_count: usize,
    bytes: u64,
    string_columns: BTreeMap<String, String>,
    id_encoding: String,
}
#[derive(Eq, PartialEq, Ord, PartialOrd)]
struct Item {
    key: Vec<u8>,
    owner: u32,
    occurrence: u32,
}
struct Range {
    base: usize,
    count: usize,
    owner: usize,
}
fn put(w: &mut impl Write, n: u32) -> Result<()> {
    w.write_all(&n.to_le_bytes())?;
    Ok(())
}
fn get(r: &mut impl Read) -> Result<Option<u32>> {
    let mut b = [0; 4];
    let n = r.read(&mut b[..1])?;
    if n == 0 {
        return Ok(None);
    }
    r.read_exact(&mut b[1..])?;
    Ok(Some(u32::from_le_bytes(b)))
}
fn key(r: &mut impl Read, n: u32) -> Result<Vec<u8>> {
    require(n <= 1024 * 1024, "sort key cap")?;
    let mut b = vec![0; n as usize];
    r.read_exact(&mut b)?;
    Ok(b)
}
fn item(r: &mut impl Read) -> Result<Option<Item>> {
    let Some(n) = get(r)? else {
        return Ok(None);
    };
    let occurrence = get(r)?.ok_or("truncated sort occurrence")?;
    let owner = get(r)?.ok_or("truncated sort owner")?;
    Ok(Some(Item {
        key: key(r, n)?,
        owner,
        occurrence,
    }))
}
fn flush(items: &mut Vec<Item>, runs: &mut Vec<PathBuf>, staging: &Path) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let mut measure = crate::scan_timings::Cursor::new();
    items.par_sort_unstable();
    measure.mark("dictionary.sort_run");
    let path = staging.join(format!("run-{}", runs.len()));
    let mut w = BufWriter::with_capacity(
        1024 * 1024,
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?,
    );
    for i in items.iter() {
        put(&mut w, i.key.len() as u32)?;
        put(&mut w, i.occurrence)?;
        put(&mut w, i.owner)?;
        w.write_all(&i.key)?;
    }
    w.flush()?;
    items.clear();
    runs.push(path);
    Ok(())
}
#[expect(
    clippy::expect_used,
    reason = "the culture regex is a source literal, exercised by dictionary tests"
)]
pub(crate) fn storage_domain(name: &str, domain: &str) -> String {
    if domain == "translation" {
        static CULTURE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let path = name.replace('\\', "/");
        if let Some(capture) = CULTURE
            .get_or_init(|| {
                regex::Regex::new(r"/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)/[^/]+\.(?:archive|po)$")
                    .expect("culture pattern")
            })
            .captures(&path)
        {
            let culture = &capture[1];
            if culture.len() <= 16 {
                return format!("culture.{culture}");
            }
        }
    }
    domain.into()
}
/// Preserve each local block's canonical bytes and IDs for content-hash refresh reuse.
pub(crate) fn reuse_blocks(reader: &mut Reader) -> Result<Value> {
    let mut blocks = serde_json::Map::<String, Value>::new();
    for index in 0..reader.entries.len() {
        let entry = reader.entries[index].clone();
        if entry.kind != 4 {
            continue;
        }
        let bytes = reader.load(index)?;
        let count = crate::snapshot::strings_bytes(&bytes)?.len();
        let list = blocks
            .entry(entry.domain)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("reuse blocks")?;
        let start = list.last().map_or(0, |last| {
            last["start"].as_u64().unwrap_or(0) + last["count"].as_u64().unwrap_or(0)
        });
        list.push(json!({"start":start,"count":count,"hash":crate::store::digest(&bytes)}));
    }
    Ok(Value::Object(blocks))
}
fn varint(b: &mut Vec<u8>, mut n: u32) {
    while n >= 128 {
        b.push((n as u8 & 127) | 128);
        n >>= 7;
    }
    b.push(n as u8);
}
fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}
pub fn a64(keys: &[Vec<u8>]) -> Result<Vec<u8>> {
    require(!keys.is_empty() && keys.len() <= 64, "A64 block count")?;
    let mut out = Vec::new();
    varint(&mut out, keys.len() as u32);
    let mut previous: &[u8] = &[];
    for key in keys {
        let guid = key.len() == 32 && key.iter().all(|&c| nibble(c).is_some());
        if guid {
            let mut mask = 0u32;
            for (i, &c) in key.iter().enumerate() {
                if c.is_ascii_uppercase() {
                    mask |= 1 << i;
                }
            }
            out.push(if mask == 0 { 1 } else { 2 });
            for pair in key.as_chunks::<2>().0 {
                out.push(
                    (nibble(pair[0]).ok_or("invalid GUID hexadecimal digit")? << 4)
                        | nibble(pair[1]).ok_or("invalid GUID hexadecimal digit")?,
                );
            }
            if mask != 0 {
                out.extend_from_slice(&mask.to_le_bytes());
            }
        } else {
            out.push(0);
            let prefix = previous.iter().zip(key).take_while(|(a, b)| a == b).count();
            varint(&mut out, prefix as u32);
            varint(&mut out, (key.len() - prefix) as u32);
            out.extend_from_slice(&key[prefix..]);
        }
        previous = key;
    }
    Ok(out)
}
pub(crate) fn segment(
    input: &Path,
    output: &Path,
    domain: &str,
    start: u32,
    count: u32,
    file: String,
) -> Result<Segment> {
    let mut r = BufReader::with_capacity(1024 * 1024, File::open(input)?);
    let mut w = Writer::new(&output.join(format!("{file}.payload")))?;
    let mut order = Vec::new();
    let mut frame = Vec::new();
    let mut fences = Vec::new();
    let mut offsets = Vec::new();
    let mut frames = Vec::new();
    let mut block = Vec::new();
    let mut frame_id = 0;
    let mut utf8_bytes = 0;
    let mut seen = 0;
    let level = match domain {
        "paths" => 9,
        "identity" => 6,
        _ => 3,
    };
    loop {
        let next = get(&mut r)?;
        if let Some(n) = next {
            let bytes = key(&mut r, n)?;
            utf8_bytes += bytes.len() as u64;
            block.push(bytes);
            seen += 1;
        }
        if block.len() == 64 || (next.is_none() && !block.is_empty()) {
            let encoded = a64(&block)?;
            if !frame.is_empty() && frame.len() + encoded.len() > 256 * 1024 {
                order.push(w.add(&format!("front.b{frame_id}"), 0, "", &frame, level)?);
                frame.clear();
                frame_id += 1;
            }
            offsets.push(frame.len() as u32);
            frames.push(frame_id);
            crate::wtf8::validate(&block[0])?;
            fences.push(block[0].clone());
            frame.extend_from_slice(&encoded);
            block.clear();
        }
        if next.is_none() {
            break;
        }
    }
    require(seen == count, "dictionary count")?;
    if !frame.is_empty() {
        order.push(w.add(&format!("front.b{frame_id}"), 0, "", &frame, level)?);
    }
    order.push(w.add(
        "front.fences",
        0,
        "",
        &crate::snapshot::string_block_bytes(&fences)?,
        1,
    )?);
    order.push(w.column("front.offsets", &offsets)?);
    order.push(w.column("front.frames", &frames)?);
    order.push(w.column("front.masks", &vec![1; offsets.len()])?);
    let bytes = w.finish(&output.join(&file), &order)?;
    Ok(Segment {
        file,
        start,
        count,
        domain: domain.into(),
        domains: vec![domain.into()],
        utf8_bytes,
        bytes,
    })
}
/// Output must be a fresh directory. Temporary runs are removed on completion or ordinary error.
pub fn build(layers: &[LayerInput], output: &Path, run_bytes: usize) -> Result<Value> {
    build_configured(layers, output, run_bytes, None)
}
/// Callers supply store identities; standalone builds use deterministic keys.
pub fn build_configured(
    layers: &[LayerInput],
    output: &Path,
    run_bytes: usize,
    configuration: Option<(&str, &BTreeMap<String, String>)>,
) -> Result<Value> {
    let sources = layers
        .iter()
        .map(|layer| SourceLayer {
            name: layer.name.clone(),
            key: String::new(),
            source: LayerSource::File(layer.file.clone()),
        })
        .collect::<Vec<_>>();
    build_sources(&sources, output, run_bytes, configuration)
}
pub(crate) fn build_sources(
    layers: &[SourceLayer],
    output: &Path,
    run_bytes: usize,
    configuration: Option<(&str, &BTreeMap<String, String>)>,
) -> Result<Value> {
    fs::create_dir(output)?;
    let staging = output.join("staging");
    fs::create_dir(&staging)?;
    let result = build_inner(layers, output, &staging, run_bytes, configuration);
    fs::remove_dir_all(&staging)?;
    result
}
fn build_inner(
    layers: &[SourceLayer],
    output: &Path,
    staging: &Path,
    run_bytes: usize,
    configuration: Option<(&str, &BTreeMap<String, String>)>,
) -> Result<Value> {
    let mut measure = crate::scan_timings::Cursor::new();
    for layer in layers {
        if crate::scan_timings::enabled()
            && let LayerSource::File(file) = &layer.source
        {
            crate::scan_timings::count("publication.staged_bytes", fs::metadata(file)?.len());
        }
    }
    crate::scan_timings::count("publication.inputs", layers.len() as u64);
    let started = Instant::now();
    require(
        (1024 * 1024..=256 * 1024 * 1024).contains(&run_bytes),
        "sort run budget",
    )?;
    let mut domains = Vec::<String>::new();
    let mut ranges = Vec::new();
    let mut total = 0;
    for layer in layers {
        let reader = layer.source.open()?;
        let mut range = BTreeMap::new();
        for e in &reader.entries {
            if e.kind != 4 || range.contains_key(&e.domain) {
                continue;
            }
            let domain = storage_domain(&layer.name, &e.domain);
            let owner = domains
                .iter()
                .position(|s| s == &domain)
                .unwrap_or_else(|| {
                    domains.push(domain);
                    domains.len() - 1
                });
            range.insert(
                e.domain.clone(),
                Range {
                    base: total,
                    count: e.strings as usize,
                    owner,
                },
            );
            total += e.strings as usize;
        }
        ranges.push(range);
    }
    require(
        total < u32::MAX as usize && domains.len() <= 4096,
        "mapping count",
    )?;
    let mut mapping = vec![0u32; total];
    let mut items = Vec::new();
    let mut bytes = 0;
    let mut runs = Vec::new();
    for (layer, range) in layers.iter().zip(&ranges) {
        let reader = layer.source.open()?;
        let mut positions = BTreeMap::<String, usize>::new();
        for id in 0..reader.entries.len() {
            let e = reader.entries[id].clone();
            if e.kind != 4 {
                continue;
            }
            let r = &range[&e.domain];
            let position = positions.entry(e.domain).or_default();
            for s in crate::snapshot::strings_bytes(&reader.load(id)?)? {
                if bytes + s.len() + 48 > run_bytes {
                    flush(&mut items, &mut runs, staging)?;
                    bytes = 0;
                }
                bytes += s.len() + 48;
                items.push(Item {
                    key: s,
                    owner: r.owner as u32,
                    occurrence: (r.base + *position) as u32,
                });
                *position += 1;
            }
        }
        for (domain, r) in range {
            require(positions.get(domain) == Some(&r.count), "domain count")?;
        }
    }
    flush(&mut items, &mut runs, staging)?;
    drop(items);
    let collect_sort_seconds = started.elapsed().as_secs_f64();
    measure.mark("dictionary.collect_sort");
    let merge_start = Instant::now();
    let mut readers: Vec<_> = runs
        .iter()
        .map(|p| File::open(p).map(|f| BufReader::with_capacity(1024 * 1024, f)))
        .collect::<std::io::Result<_>>()?;
    let mut writers = Vec::new();
    for i in 0..domains.len() {
        writers.push(BufWriter::with_capacity(
            1024 * 1024,
            File::create(staging.join(format!("domain-{i}")))?,
        ));
    }
    let mut heap = BinaryHeap::new();
    for (i, r) in readers.iter_mut().enumerate() {
        if let Some(item) = item(r)? {
            heap.push(Reverse((item, i)));
        }
    }
    let mut counts = vec![0u32; domains.len()];
    let mut rank_ids = Vec::new();
    let mut rank_owners = Vec::new();
    let mut previous = None::<Vec<u8>>;
    while let Some(Reverse((item, i))) = heap.pop() {
        if previous.as_ref() != Some(&item.key) {
            let owner = item.owner as usize;
            let w = &mut writers[owner];
            put(w, item.key.len() as u32)?;
            w.write_all(&item.key)?;
            rank_ids.push(counts[owner]);
            rank_owners.push(owner);
            counts[owner] += 1;
            previous = Some(item.key.clone());
        }
        mapping[item.occurrence as usize] = (rank_ids.len() - 1) as u32;
        if let Some(next) = self::item(&mut readers[i])? {
            heap.push(Reverse((next, i)));
        }
    }
    for w in &mut writers {
        w.flush()?;
    }
    drop(writers);
    drop(readers);
    for path in &runs {
        fs::remove_file(path)?;
    }
    let merge_seconds = merge_start.elapsed().as_secs_f64();
    measure.mark("dictionary.merge");
    let encode_start = Instant::now();
    let mut bases = vec![0u32; domains.len()];
    let mut segments = Vec::new();
    let mut base = 0;
    for (owner, domain) in domains.iter().enumerate() {
        bases[owner] = base;
        if counts[owner] == 0 {
            continue;
        }
        segments.push(segment(
            &staging.join(format!("domain-{owner}")),
            output,
            domain,
            base,
            counts[owner],
            if let Some((generation, _)) = configuration {
                format!("strings-{generation}-{owner:08x}.snapshot")
            } else {
                format!("strings-{owner:08x}.snapshot")
            },
        )?);
        base += counts[owner];
        fs::remove_file(staging.join(format!("domain-{owner}")))?;
    }
    for (rank, id) in rank_ids.iter_mut().enumerate() {
        *id += bases[rank_owners[rank]];
    }
    for id in &mut mapping {
        *id = rank_ids[*id as usize];
    }
    drop(rank_ids);
    drop(rank_owners);
    let dictionary_encode_seconds = encode_start.elapsed().as_secs_f64();
    measure.mark("dictionary.dictionary");
    let layer_start = Instant::now();
    let generation = configuration.map_or("00000000-0000-0000-0000-000000000001", |c| c.0);
    let mut records = BTreeMap::new();
    let mut active = BTreeMap::new();
    let mut layer_bytes = 0;
    // Dictionary IDs are final. Each layer owns its reader, payload and output filename; root
    // records are folded in input order after every encoder has finished.
    let encoded = layers
        .par_iter()
        .zip(&ranges)
        .enumerate()
        .map(|(i, (layer, range))| {
            let _span = crate::scan_timings::Span::new("dictionary.encode_layer_parallel");
            let mut reader = layer.source.open()?;
            let file = if configuration.is_some() {
                format!("layer-{generation}-{i:08x}.snapshot")
            } else {
                format!("layer-{i:08x}.snapshot")
            };
            let mut writer = Writer::new(&staging.join(format!("layer-{i}.payload")))?;
            let mut order = Vec::new();
            let mut columns = BTreeMap::new();
            for id in 0..reader.entries.len() {
                let e = reader.entries[id].clone();
                if e.kind == 4 || e.name.ends_with(".starts") || e.name == "input.hash" {
                    continue;
                }
                let mut data = reader.load(id)?;
                if e.kind == 3 {
                    let _span = crate::scan_timings::Span::new("dictionary.remap_columns");
                    let r = &range[&e.domain];
                    let mut previous = 0u32;
                    let mut remapped = Vec::new();
                    for local in integers(&data)? {
                        require((local as usize) < r.count, "local ID outside domain")?;
                        let global = mapping[r.base + local as usize];
                        let delta = global.wrapping_sub(previous) as i32;
                        remapped.push(((delta << 1) ^ (delta >> 31)) as u32);
                        previous = global;
                    }
                    data = u32_bytes(&remapped);
                    columns.insert(e.name.clone(), e.domain.clone());
                }
                order.push(writer.add(
                    &e.name,
                    if e.kind == 3 { 2 } else { e.kind },
                    "",
                    &data,
                    1,
                )?);
            }
            if reader.entries.iter().any(|entry| entry.name == "file.meta") {
                for (domain, local) in range {
                    let field = format!("reuse.{domain}");
                    columns.insert(field.clone(), domain.clone());
                    order.push(writer.add(
                        &field,
                        2,
                        "",
                        &crate::store::encode_ids(&mapping[local.base..local.base + local.count]),
                        1,
                    )?);
                }
                let blocks = reuse_blocks(&mut reader)?;
                order.push(writer.add("reuse.meta", 0, "", &serde_json::to_vec(&blocks)?, 1)?);
            }
            let key = if let Some((_, keys)) = configuration {
                keys.get(&layer.name).ok_or("missing layer key")?.clone()
            } else if let Some(id) = reader.entries.iter().position(|e| e.name == "input.hash") {
                format!(
                    "native-cold-v1:{}:{}",
                    layer.name,
                    String::from_utf8(reader.load(id)?)?
                )
            } else {
                format!("native-cold:{i}")
            };
            let mut record = LayerRecord {
                file: file.clone(),
                key: key.clone(),
                store_generation: generation.into(),
                segment_count: segments.len(),
                bytes: 0,
                string_columns: columns,
                id_encoding: "delta32".into(),
            };
            order.push(writer.add("shared.meta", 0, "", &serde_json::to_vec(&record)?, 1)?);
            record.bytes = writer.finish(&output.join(file), &order)?;
            Ok::<_, crate::Error>((layer.name.clone(), key, record))
        })
        .collect::<Result<Vec<_>>>()?;
    for (name, key, record) in encoded {
        layer_bytes += record.bytes;
        records.insert(key.clone(), record);
        active.insert(name, key);
    }
    let root = json!({"version":2,"generation":generation,"active":active,"layers":records,"segments":segments,"garbageUpperBytes":0});
    let mut w = Writer::new(&staging.join("root.payload"))?;
    let id = w.add("index.meta", 0, "", &serde_json::to_vec(&root)?, 1)?;
    w.finish(&output.join("snapshot-00000000.snapshot"), &[id])?;
    fs::write(output.join("index.json"), serde_json::to_vec_pretty(&root)?)?;
    let layer_encode_seconds = layer_start.elapsed().as_secs_f64();
    measure.mark("dictionary.layers");
    Ok(
        json!({"seconds":started.elapsed().as_secs_f64(),"collectSortSeconds":collect_sort_seconds,"mergeSeconds":merge_seconds,"dictionaryEncodeSeconds":dictionary_encode_seconds,"layerEncodeSeconds":layer_encode_seconds,"strings":base,"occurrences":total,"runs":runs.len(),"dictionaryBytes":segments.iter().map(|s|s.bytes).sum::<u64>(),"layerBytes":layer_bytes,"layers":layers.len()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guid_tags_and_front_suffix() {
        let block = a64(&[
            b"0123456789abcdef0123456789abcdef".to_vec(),
            b"0123456789ABCDEF0123456789abcdef".to_vec(),
        ])
        .unwrap();
        assert_eq!(block[0], 2);
        assert_eq!(block[1], 1);
        assert_eq!(block[18], 2);
        assert_eq!(block.len(), 39);
        assert_eq!(
            a64(&[b"abc".to_vec(), b"abd".to_vec()]).unwrap(),
            [2, 0, 0, 3, b'a', b'b', b'c', 0, 2, 1, b'd']
        );
    }
    #[test]
    fn external_runs_deduplicate_across_domains_and_produce_identical_rank_ids() {
        let root = crate::test_directory("sort-unit");
        fs::create_dir_all(&root).unwrap();
        let raw = root.join("input.snapshot");
        let mut w = Writer::new(&root.join("payload")).unwrap();
        let mut order = Vec::new();
        let strings: Vec<_> = (0..10000)
            .map(|i| format!("synthetic-{i:06}-{}", "text ".repeat(28)))
            .collect();
        for (domain, reverse) in [("source", false), ("identity", true)] {
            let values: Vec<_> = if reverse {
                strings.iter().rev().cloned().collect()
            } else {
                strings.clone()
            };
            let block = w
                .add(
                    &format!("{domain}.b0"),
                    4,
                    domain,
                    &crate::snapshot::string_block(&values).unwrap(),
                    3,
                )
                .unwrap();
            w.entries[block].strings = 10000;
            order.push(block);
            order.push(w.column(&format!("{domain}.starts"), &[0]).unwrap());
            let column = w
                .add(
                    &format!("value.{domain}"),
                    3,
                    domain,
                    &u32_bytes(&(0..10000).collect::<Vec<_>>()),
                    1,
                )
                .unwrap();
            w.entries[column].strings = 10000;
            order.push(column);
        }
        w.finish(&raw, &order).unwrap();
        let input = (0..4)
            .map(|i| LayerInput {
                name: format!("probe-{i}"),
                file: raw.clone(),
            })
            .collect::<Vec<_>>();
        let small = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap()
            .install(|| build(&input, &root.join("small"), 1024 * 1024))
            .unwrap();
        let large = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .unwrap()
            .install(|| build(&input, &root.join("large"), 64 * 1024 * 1024))
            .unwrap();
        assert!(small["runs"].as_u64().unwrap() > 1);
        assert_eq!(small["strings"], 10000);
        assert_eq!(small["strings"], large["strings"]);
        for file in [
            "strings-00000000.snapshot",
            "layer-00000000.snapshot",
            "layer-00000001.snapshot",
            "layer-00000002.snapshot",
            "layer-00000003.snapshot",
            "snapshot-00000000.snapshot",
            "index.json",
        ] {
            assert_eq!(
                fs::read(root.join("small").join(file)).unwrap(),
                fs::read(root.join("large").join(file)).unwrap()
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
