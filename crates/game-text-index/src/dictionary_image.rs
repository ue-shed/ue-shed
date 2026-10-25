//! A dictionary segment held for random access. On disk a segment is front-coded 64-string blocks
//! in zstd frames of up to 256 KiB: compact, and fast to read whole, but one string costs its
//! frame's expansion. A query reader instead holds each segment as its strings compressed one by
//! one against the segment's FSST symbol table, so a lookup decodes only the string it wants.
//! Segment files never change, so each is imaged once and shared by every reader that pins it.
use crate::snapshot::Reader;
use crate::store::{decode_a64_bytes, section};
use crate::{Result, require};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

/// The symbol table trains on every this many frames' strings; FSST itself samples 16 KiB of them.
const TRAINING_STRIDE: u32 = 8;

/// A segment file and its place in the dictionary.
pub(crate) type SegmentKey = (PathBuf, u32, u32);

pub(crate) struct SegmentImage {
    compressor: fsst::Compressor,
    /// Each string's start in `bytes`, then the end of the last.
    starts: Vec<u32>,
    bytes: Vec<u8>,
}

/// One frame's strings in ID order: the frame is expanded once and its blocks decoded.
fn frame_strings(
    reader: &Reader,
    offsets: &[u32],
    frames: &[u32],
    blocks: std::ops::Range<usize>,
) -> Result<Vec<Vec<u8>>> {
    let frame = frames[blocks.start];
    let bytes = section(reader, &format!("front.b{frame}"))?;
    let mut strings = Vec::new();
    for block in blocks.clone() {
        let start = *offsets
            .get(block)
            .ok_or("Dictionary block outside offsets.")? as usize;
        let end = if block + 1 < blocks.end {
            offsets[block + 1] as usize
        } else {
            bytes.len()
        };
        strings.extend(decode_a64_bytes(
            bytes.get(start..end).ok_or("Dictionary block range.")?,
        )?);
    }
    Ok(strings)
}

impl SegmentImage {
    /// Images a segment from its frames: trains the symbol table on a stride of them, then
    /// expands and compresses the frames in parallel, joining them in ID order. Readers load
    /// sections at explicit offsets, so the frames load at once.
    pub fn build(reader: &Reader, offsets: &[u32], frames: &[u32], count: u32) -> Result<Self> {
        use rayon::prelude::*;
        require(
            offsets.len() == frames.len(),
            "Dictionary block columns differ in length.",
        )?;
        // Each frame's run of blocks; a frame's blocks are adjacent.
        let mut runs = Vec::new();
        for block in 0..frames.len() {
            if block == 0 || frames[block] != frames[block - 1] {
                runs.push(block..block + 1);
            } else if let Some(run) = runs.last_mut() {
                run.end = block + 1;
            }
        }
        let training = runs
            .par_iter()
            .enumerate()
            .filter(|(index, _)| (*index as u32).is_multiple_of(TRAINING_STRIDE))
            .map(|(_, run)| frame_strings(reader, offsets, frames, run.clone()))
            .collect::<Result<Vec<_>>>()?;
        let compressor =
            fsst::Compressor::train(&training.iter().flatten().map(Vec::as_slice).collect());
        drop(training);
        // Each frame's string lengths and compressed bytes.
        let compressed = runs
            .par_iter()
            .map(|run| -> Result<(Vec<u32>, Vec<u8>)> {
                let mut lengths = Vec::new();
                let mut bytes = Vec::new();
                for value in frame_strings(reader, offsets, frames, run.clone())? {
                    let encoded = compressor.compress(&value);
                    lengths.push(u32::try_from(encoded.len())?);
                    bytes.extend_from_slice(&encoded);
                }
                Ok((lengths, bytes))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut starts = Vec::with_capacity(count as usize + 1);
        let mut bytes = Vec::with_capacity(compressed.iter().map(|(_, bytes)| bytes.len()).sum());
        for (lengths, frame) in compressed {
            let mut at = u32::try_from(bytes.len())?;
            for length in lengths {
                starts.push(at);
                at = at
                    .checked_add(length)
                    .ok_or("Dictionary image past 4 GiB.")?;
            }
            bytes.extend_from_slice(&frame);
        }
        starts.push(u32::try_from(bytes.len())?);
        require(
            starts.len() == count as usize + 1,
            "Dictionary segment count differs from its blocks.",
        )?;
        Ok(Self {
            compressor,
            starts,
            bytes,
        })
    }

    pub fn len(&self) -> usize {
        self.starts.len() - 1
    }

    /// The WTF-8 bytes of the segment's `local`th string.
    pub fn get(&self, local: usize) -> Result<Vec<u8>> {
        let begin = *self
            .starts
            .get(local)
            .ok_or("String outside dictionary segment.")? as usize;
        let end = *self
            .starts
            .get(local + 1)
            .ok_or("String outside dictionary segment.")? as usize;
        Ok(self.compressor.decompressor().decompress(
            self.bytes
                .get(begin..end)
                .ok_or("Dictionary string range.")?,
        ))
    }

    /// The position of `wanted` in the segment, which is sorted by WTF-8 bytes.
    pub fn find(&self, wanted: &[u8]) -> Result<Option<usize>> {
        let (mut low, mut high) = (0, self.len());
        while low < high {
            let middle = low + (high - low) / 2;
            match self.get(middle)?.as_slice().cmp(wanted) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Equal => return Ok(Some(middle)),
                std::cmp::Ordering::Greater => high = middle,
            }
        }
        Ok(None)
    }

    pub fn heap_bytes(&self) -> usize {
        self.starts.len() * 4 + self.bytes.len()
    }
}

fn registry() -> &'static Mutex<HashMap<SegmentKey, Weak<SegmentImage>>> {
    static IMAGES: OnceLock<Mutex<HashMap<SegmentKey, Weak<SegmentImage>>>> = OnceLock::new();
    IMAGES.get_or_init(Default::default)
}

/// The image another reader already holds for `key`.
pub(crate) fn shared(key: &SegmentKey) -> Option<Arc<SegmentImage>> {
    registry().lock().ok()?.get(key)?.upgrade()
}

/// Offers `image` to later readers, dropping entries no reader holds any more.
pub(crate) fn publish(key: SegmentKey, image: &Arc<SegmentImage>) {
    if let Ok(mut images) = registry().lock() {
        images.retain(|_, held| held.strong_count() > 0);
        images.insert(key, Arc::downgrade(image));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::Writer;

    #[test]
    fn an_image_returns_and_finds_every_string_of_a_segment() -> Result<()> {
        let mut strings = (0..300)
            .map(|index| format!("line {index:04} of the \u{4e16}\u{754c} corpus").into_bytes())
            .collect::<Vec<_>>();
        strings.extend([
            "00000000000000000000000000000000".as_bytes().to_vec(),
            vec![0xed, 0xa0, 0x80],
        ]);
        strings.push(Vec::new());
        strings.sort();
        let directory = crate::test_directory("dictionary-image");
        std::fs::create_dir_all(&directory)?;
        // Frames of two blocks, the last of one, so the image reads frames shared and alone.
        let mut writer = Writer::new(&directory.join("segment.payload"))?;
        let mut order = Vec::new();
        let mut offsets = Vec::new();
        let mut frames = Vec::new();
        for (frame, group) in strings.chunks(128).enumerate() {
            let mut bytes = Vec::new();
            for block in group.chunks(64) {
                offsets.push(bytes.len() as u32);
                frames.push(frame as u32);
                bytes.extend(crate::dictionary::a64(block)?);
            }
            order.push(writer.add(&format!("front.b{frame}"), 0, "", &bytes, 3)?);
        }
        let path = directory.join("segment.snapshot");
        writer.finish(&path, &order)?;
        let reader = Reader::open(&path)?;
        let image = SegmentImage::build(&reader, &offsets, &frames, strings.len() as u32)?;
        assert_eq!(image.len(), strings.len());
        for (local, value) in strings.iter().enumerate() {
            assert_eq!(&image.get(local)?, value);
            assert_eq!(image.find(value)?, Some(local));
        }
        assert_eq!(image.find(b"line 0000 of the")?, None);
        assert!(image.get(strings.len()).is_err());
        drop(reader);
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }
}
