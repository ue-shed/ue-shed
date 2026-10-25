//! Reuse checked localization dictionary blocks without rebuilding a project-wide lookup table.
use crate::snapshot::Reader;
use crate::store::{Store, decode_ids, digest, section};
use crate::{Result, require};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

pub(crate) fn mappings(
    store: &mut Store,
    reader: &mut Reader,
    name: &str,
    old: &Value,
) -> Result<Option<BTreeMap<String, Vec<u32>>>> {
    if !reader.entries.iter().any(|entry| entry.name == "file.meta") {
        return Ok(None);
    }
    let previous = Reader::open(
        &store
            .directory
            .join(old["file"].as_str().ok_or("previous layer file")?),
    )?;
    if !previous
        .entries
        .iter()
        .any(|entry| entry.name == "reuse.meta")
    {
        return Ok(None);
    }
    require(
        old["storeGeneration"] == store.root["generation"],
        "stale reuse generation",
    )?;
    let metadata: Value = serde_json::from_slice(&section(&previous, "reuse.meta")?)?;
    let mut retained = HashMap::<String, Vec<u32>>::new();
    let mut output = BTreeMap::<String, Vec<u32>>::new();
    for index in 0..reader.entries.len() {
        let entry = reader.entries[index].clone();
        if entry.kind != 4 {
            continue;
        }
        let bytes = reader.load(index)?;
        let values = crate::snapshot::strings_bytes(&bytes)?;
        let hash = digest(&bytes);
        let reusable = metadata[&entry.domain].as_array().and_then(|blocks| {
            blocks.iter().find(|block| {
                block["hash"].as_str() == Some(&hash)
                    && block["count"].as_u64() == Some(values.len() as u64)
            })
        });
        let ids = if let Some(block) = reusable {
            if !retained.contains_key(&entry.domain) {
                let ids = decode_ids(
                    &section(&previous, &format!("reuse.{}", entry.domain))?,
                    old["idEncoding"] == "delta32",
                )?;
                retained.insert(entry.domain.clone(), ids);
            }
            let start = usize::try_from(block["start"].as_u64().ok_or("reuse block start")?)?;
            let end = start
                .checked_add(values.len())
                .ok_or("reuse block overflow")?;
            retained[&entry.domain]
                .get(start..end)
                .ok_or("reuse block bounds")?
                .to_vec()
        } else {
            let mut ids = Vec::with_capacity(values.len());
            let domain = crate::dictionary::storage_domain(name, &entry.domain);
            for values in values.chunks(8192) {
                ids.extend(store.intern_bytes(&domain, values)?);
            }
            ids
        };
        output.entry(entry.domain).or_default().extend(ids);
    }
    let dictionary_count = store.root["segments"]
        .as_array()
        .ok_or("dictionary segments")?
        .last()
        .map(|segment| {
            Ok::<_, crate::Error>(
                segment["start"].as_u64().ok_or("segment start")?
                    + segment["count"].as_u64().ok_or("segment count")?,
            )
        })
        .transpose()?
        .unwrap_or(0);
    require(
        output
            .values()
            .flatten()
            .all(|id| u64::from(*id) < dictionary_count),
        "reused dictionary ID bounds",
    )?;
    Ok(Some(output))
}
