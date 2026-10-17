//! Probe immutable A64 fence indexes for small updates; keep bulk cold interning unchanged.
use crate::snapshot::{Reader, integers, strings_bytes};
use crate::store::{Store, section, token};
use crate::{Result, require};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};

pub(crate) fn intern(store: &mut Store, domain: &str, values: &[Vec<u8>]) -> Result<Vec<u32>> {
    let mut pending = values.iter().cloned().collect::<BTreeSet<_>>();
    for value in &pending {
        crate::wtf8::validate(value)?;
        require(value.len() <= 1024 * 1024, "string cap")?;
    }
    let mut found = BTreeMap::new();
    for segment in store.root["segments"].as_array().ok_or("segments")? {
        if pending.is_empty() {
            break;
        }
        let mut reader = Reader::open(
            &store
                .directory
                .join(segment["file"].as_str().ok_or("segment file")?),
        )?;
        let fences = strings_bytes(&section(&mut reader, "front.fences")?)?;
        let offsets = integers(&section(&mut reader, "front.offsets")?)?;
        let frames = integers(&section(&mut reader, "front.frames")?)?;
        let count = segment["count"].as_u64().ok_or("segment count")? as usize;
        require(
            fences.len() == offsets.len()
                && offsets.len() == frames.len()
                && offsets.len() == count.div_ceil(64),
            "front index lengths",
        )?;
        require(
            fences.windows(2).all(|v| v[0] < v[1]),
            "front fences not ordered",
        )?;
        let mut frame_id = u32::MAX;
        let mut block_id = usize::MAX;
        let mut frame = Vec::new();
        let mut block = Vec::new();
        let mut matched = Vec::new();
        for value in &pending {
            let position = fences.partition_point(|fence| fence <= value);
            if position == 0 {
                continue;
            }
            let index = position - 1;
            if frame_id != frames[index] {
                frame = section(&mut reader, &format!("front.b{}", frames[index]))?;
                frame_id = frames[index];
            }
            if block_id != index {
                let end = if frames.get(index + 1) == Some(&frame_id) {
                    offsets[index + 1] as usize
                } else {
                    frame.len()
                };
                block = crate::store::decode_a64_bytes(
                    frame
                        .get(offsets[index] as usize..end)
                        .ok_or("front bounds")?,
                )?;
                require(
                    block.len() == 64.min(count - index * 64),
                    "front block count",
                )?;
                block_id = index;
            }
            if let Ok(rank) = block.binary_search(value) {
                let id = segment["start"].as_u64().ok_or("segment start")? as u32
                    + (index * 64 + rank) as u32;
                found.insert(value.clone(), id);
                matched.push(value.clone());
            }
        }
        for value in matched {
            pending.remove(&value);
        }
    }
    if !pending.is_empty() {
        require(
            store.root["segments"].as_array().ok_or("segments")?.len() < 256,
            "dictionary requires compaction",
        )?;
        let base = store.root["segments"]
            .as_array()
            .ok_or("invalid shared root array")?
            .last()
            .map(|s| {
                Ok::<_, crate::Error>(
                    s["start"].as_u64().ok_or("invalid segment start")?
                        + s["count"].as_u64().ok_or("invalid segment count")?,
                )
            })
            .transpose()?
            .unwrap_or(0) as u32;
        let raw = store.directory.join(format!("{}.tmp", token()));
        let result = (|| {
            let mut stream = BufWriter::with_capacity(
                crate::snapshot::BLOCK_BYTES,
                OpenOptions::new().create_new(true).write(true).open(&raw)?,
            );
            for value in &pending {
                stream.write_all(&(value.len() as u32).to_le_bytes())?;
                stream.write_all(value)?;
            }
            stream.flush()?;
            drop(stream);
            let segment = crate::dictionary::segment(
                &raw,
                &store.directory,
                domain,
                base,
                pending.len() as u32,
                format!("strings-{}.snapshot", token()),
            )?;
            store.root["segments"]
                .as_array_mut()
                .ok_or("invalid shared root array")?
                .push(serde_json::to_value(segment)?);
            for (index, value) in pending.into_iter().enumerate() {
                found.insert(value, base + index as u32);
            }
            Ok::<_, crate::Error>(())
        })();
        let _ = fs::remove_file(raw);
        result?;
    }
    values
        .iter()
        .map(|value| {
            found
                .get(value)
                .copied()
                .ok_or_else(|| "missing bounded intern value".into())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Configuration, dictionary_bytes, dictionary_selected_strings};
    #[test]
    fn bounded_fences_deduplicate_across_blocks_segments_and_wtf8() {
        let config = Configuration {
            cache_root: crate::test_directory("bounded-intern"),
            project_key: "generic-project".into(),
            target_key: "Probe".into(),
            shared_project: false,
            view_prefix: None,
        };
        let mut store = Store::writer(config.clone()).unwrap();
        let mut values = (0..193)
            .map(|i| format!("value-{i:04}").into_bytes())
            .collect::<Vec<_>>();
        values.extend([
            Vec::new(),
            vec![0xed, 0xa0, 0x80],
            vec![0xed, 0xbf, 0xbf],
            "emoji 😀".as_bytes().to_vec(),
        ]);
        let ids = intern(&mut store, "source", &values).unwrap();
        let before = store.root["segments"].as_array().unwrap().len();
        let repeated = values
            .iter()
            .rev()
            .chain(values.iter())
            .cloned()
            .collect::<Vec<_>>();
        let actual = intern(&mut store, "translation", &repeated).unwrap();
        let expected = ids
            .iter()
            .rev()
            .chain(ids.iter())
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
        assert_eq!(store.root["segments"].as_array().unwrap().len(), before);
        let more = vec![
            b"aaa-new".to_vec(),
            values[64].clone(),
            b"zzz-new".to_vec(),
            values[192].clone(),
        ];
        let second = intern(&mut store, "identity", &more).unwrap();
        assert_eq!(second[1], ids[64]);
        assert_eq!(second[3], ids[192]);
        assert_eq!(intern(&mut store, "paths", &more).unwrap(), second);
        let all = dictionary_bytes(&store.directory, &store.root).unwrap();
        for (value, id) in values.iter().zip(&ids) {
            assert_eq!(&all[*id as usize], value);
        }
        let selected = dictionary_selected_strings(
            &store.directory,
            &store.root,
            &ids.iter().copied().collect(),
        )
        .unwrap();
        for (value, id) in values.iter().zip(&ids) {
            assert_eq!(
                crate::wtf8::Wtf8Buf::from_view(&selected[id]).as_bytes(),
                value
            );
        }
        assert!(intern(&mut store, "source", &[vec![0xff]]).is_err());
        assert!(intern(&mut store, "source", &[vec![b'a'; 1024 * 1024 + 1]]).is_err());
        store.publish_root().unwrap();
        drop(store);
        let reopened = Store::writer(config.clone()).unwrap();
        assert_eq!(
            dictionary_bytes(&reopened.directory, &reopened.root).unwrap(),
            all
        );
        drop(reopened);
        fs::remove_dir_all(config.cache_root).unwrap();
    }
}
