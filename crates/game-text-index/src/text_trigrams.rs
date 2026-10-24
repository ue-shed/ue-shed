//! Byte trigrams over a folded text arena: for each distinct trigram, the arena positions whose
//! string holds it. Written beside the arena when the joined layer is published; search uses it to
//! narrow a term of three or more bytes to the strings `memmem` then confirms.
use crate::engine_match::checkpoint;
use crate::{Result, require};
use rayon::slice::ParallelSliceMut;
use std::sync::{Arc, atomic::AtomicBool};

fn key(bytes: &[u8]) -> u32 {
    (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2])
}

fn push_varint(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push(value as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// The arena's sorted distinct trigrams, each one's range in the postings, and the postings: the
/// positions of the strings that hold it, ascending, as delta-encoded varints.
pub(crate) fn build(starts: &[u32], bytes: &[u8]) -> Result<(Vec<u32>, Vec<u32>, Vec<u8>)> {
    let mut pairs = Vec::new();
    for position in 0..starts.len().saturating_sub(1) {
        let text = bytes
            .get(starts[position] as usize..starts[position + 1] as usize)
            .ok_or("Arena range outside its bytes.")?;
        pairs.extend(
            text.windows(3)
                .map(|window| u64::from(key(window)) << 32 | position as u64),
        );
    }
    pairs.par_sort_unstable();
    pairs.dedup();
    let mut keys = Vec::new();
    let mut offsets = Vec::new();
    let mut postings = Vec::new();
    let mut previous = 0;
    for pair in pairs {
        let (trigram, position) = ((pair >> 32) as u32, pair as u32);
        if keys.last() != Some(&trigram) {
            keys.push(trigram);
            offsets.push(u32::try_from(postings.len())?);
            previous = 0;
        }
        push_varint(&mut postings, position - previous);
        previous = position;
    }
    offsets.push(u32::try_from(postings.len())?);
    Ok((keys, offsets, postings))
}

/// The values in both ascending lists.
pub(crate) fn intersect(mut left: Vec<u32>, right: &[u32]) -> Vec<u32> {
    let mut next = right.iter().peekable();
    left.retain(|value| {
        while next.next_if(|other| **other < *value).is_some() {}
        next.peek() == Some(&value)
    });
    left
}

/// A persisted trigram index, read without copying.
pub(crate) struct Trigrams {
    keys: Arc<[u32]>,
    offsets: Arc<[u32]>,
    postings: Arc<[u8]>,
}

impl Trigrams {
    pub fn new(keys: Arc<[u32]>, offsets: Arc<[u32]>, postings: Arc<[u8]>) -> Result<Self> {
        require(
            offsets.len() == keys.len() + 1
                && offsets.first() == Some(&0)
                && offsets.windows(2).all(|pair| pair[0] <= pair[1])
                && offsets
                    .last()
                    .is_some_and(|last| *last as usize <= postings.len())
                && keys.windows(2).all(|pair| pair[0] < pair[1]),
            "Invalid persisted trigram index.",
        )?;
        Ok(Self {
            keys,
            offsets,
            postings,
        })
    }

    fn positions(&self, index: usize) -> Result<Vec<u32>> {
        let bytes = &self.postings[self.offsets[index] as usize..self.offsets[index + 1] as usize];
        let mut result = Vec::new();
        let (mut value, mut shift, mut previous) = (0u32, 0, 0u32);
        for byte in bytes {
            require(shift < 32, "Invalid trigram posting.")?;
            value |= u32::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                previous = previous
                    .checked_add(value)
                    .ok_or("Invalid trigram posting.")?;
                result.push(previous);
                (value, shift) = (0, 0);
            } else {
                shift += 7;
            }
        }
        require(shift == 0, "Invalid trigram posting.")?;
        Ok(result)
    }

    /// The arena positions whose string holds every trigram of `term`, ascending; `None` when the
    /// term is shorter than a trigram. Callers confirm each with a substring search.
    pub fn candidates(&self, term: &[u8], cancelled: &AtomicBool) -> Result<Option<Vec<u32>>> {
        if term.len() < 3 {
            return Ok(None);
        }
        let mut wanted = term.windows(3).map(key).collect::<Vec<_>>();
        wanted.sort_unstable();
        wanted.dedup();
        let mut lists = Vec::with_capacity(wanted.len());
        for trigram in wanted {
            match self.keys.binary_search(&trigram) {
                Ok(index) => lists.push(index),
                Err(_) => return Ok(Some(Vec::new())),
            }
        }
        // Smallest first, so each intersection only narrows what is already small.
        lists.sort_by_key(|index| self.offsets[index + 1] - self.offsets[*index]);
        let mut result = self.positions(lists[0])?;
        for index in &lists[1..] {
            checkpoint(cancelled)?;
            if result.is_empty() {
                break;
            }
            result = intersect(result, &self.positions(*index)?);
        }
        Ok(Some(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_hold_every_trigram_and_include_every_containing_string() -> Result<()> {
        let texts = [
            "welcome back",
            "come back",
            "",
            "ab",
            "ababab",
            "\u{4f60}\u{597d}\u{4e16}\u{754c}",
            "\u{597d}",
            "comecome",
        ];
        let mut bytes = Vec::new();
        let mut starts = vec![0];
        for text in texts {
            bytes.extend_from_slice(text.as_bytes());
            starts.push(bytes.len() as u32);
        }
        let (keys, offsets, postings) = build(&starts, &bytes)?;
        let index = Trigrams::new(keys.into(), offsets.into(), postings.into())?;
        let cancelled = AtomicBool::new(false);
        for term in [
            "come",
            "back",
            "bab",
            "ome b",
            "\u{597d}",
            "\u{4e16}\u{754c}",
            "zzz",
            "ab",
        ] {
            let candidates = index.candidates(term.as_bytes(), &cancelled)?;
            let containing = (0..texts.len() as u32)
                .filter(|position| texts[*position as usize].contains(term))
                .collect::<Vec<_>>();
            match candidates {
                None => assert!(term.len() < 3, "{term:?}"),
                Some(candidates) => {
                    // An index narrows: confirmed candidates are exactly the containing strings.
                    let confirmed = candidates
                        .into_iter()
                        .filter(|position| texts[*position as usize].contains(term))
                        .collect::<Vec<_>>();
                    assert_eq!(confirmed, containing, "{term:?}");
                }
            }
        }
        assert!(Trigrams::new(Arc::from([2, 1]), Arc::from([0, 0, 0]), Arc::from([])).is_err());
        Ok(())
    }
}
