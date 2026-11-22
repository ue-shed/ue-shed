//! Byte trigrams over a folded text arena: for each distinct trigram, the arena positions whose
//! string holds it. Written beside the arena when the joined layer is published; search uses it to
//! narrow a term of three or more bytes to the strings `memmem` then confirms.
use crate::engine_match::checkpoint;
use crate::{Result, require};
use std::sync::{Arc, atomic::AtomicBool};

/// Pages of a trigram table: one per leading byte pair.
const PAGES: usize = 1 << 16;
/// A page directory entry for a byte pair no trigram has started with yet.
const UNALLOCATED: u32 = u32::MAX;

/// Per-trigram build state, `(last, cursor)`, held only for the byte pairs that start a trigram:
/// a directory by the first two bytes points at 256-entry pages by the third. Real text uses a
/// small share of the 65,536 pairs, so this is a few MiB where dense tables were 128 MiB.
struct Table {
    directory: Vec<u32>,
    pages: Vec<[(u32, u32); 256]>,
}

impl Table {
    fn new() -> Self {
        Self {
            directory: vec![UNALLOCATED; PAGES],
            pages: Vec::new(),
        }
    }

    /// A trigram's `(last, cursor)`, allocating its page on first use. A `u32` directory holds
    /// the index of every one of the at most 65,536 pages.
    fn entry(&mut self, trigram: u32) -> &mut (u32, u32) {
        let pair = (trigram >> 8) as usize;
        let mut page = self.directory[pair];
        if page == UNALLOCATED {
            page = self.pages.len() as u32;
            self.pages.push([(0, 0); 256]);
            self.directory[pair] = page;
        }
        &mut self.pages[page as usize][(trigram & 255) as usize]
    }
}

fn key(bytes: &[u8]) -> u32 {
    (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2])
}

fn varint_len(value: u32) -> u32 {
    (32 - value.leading_zeros()).div_ceil(7).max(1)
}

fn put_varint(out: &mut [u8], at: &mut u32, mut value: u32) {
    while value >= 0x80 {
        out[*at as usize] = value as u8 | 0x80;
        *at += 1;
        value >>= 7;
    }
    out[*at as usize] = value as u8;
    *at += 1;
}

/// Calls `visit` once for each trigram a string holds, in arena order, with the trigram, its
/// posting's delta (the distance from the previous string that held it, or from 0) and its
/// cursor. Each trigram's `last` in `table` holds one past the last position visited.
fn each_posting(
    starts: &[u32],
    bytes: &[u8],
    table: &mut Table,
    mut visit: impl FnMut(u32, u32, &mut u32) -> Result<()>,
) -> Result<()> {
    for position in 0..u32::try_from(starts.len().saturating_sub(1))? {
        let text = bytes
            .get(starts[position as usize] as usize..starts[position as usize + 1] as usize)
            .ok_or("Arena range outside its bytes.")?;
        for window in text.windows(3) {
            let trigram = key(window);
            let (last, cursor) = table.entry(trigram);
            if *last != position + 1 {
                visit(trigram, position - last.saturating_sub(1), cursor)?;
                *last = position + 1;
            }
        }
    }
    Ok(())
}

/// The arena's sorted distinct trigrams, each one's range in the postings, and the postings: the
/// positions of the strings that hold it, ascending, as delta-encoded varints. Two passes over
/// the arena, sizing each trigram's postings and then writing them in place, so the build holds
/// the postings and a table entry per trigram in use, not an entry per occurrence.
pub(crate) fn build(starts: &[u32], bytes: &[u8]) -> Result<(Vec<u32>, Vec<u32>, Vec<u8>)> {
    // Each trigram's last position, and its postings length, then its write cursor.
    let mut table = Table::new();
    let mut keys = Vec::new();
    each_posting(starts, bytes, &mut table, |trigram, delta, cursor| {
        if *cursor == 0 {
            keys.push(trigram);
        }
        *cursor = cursor
            .checked_add(varint_len(delta))
            .ok_or("Trigram postings past 4 GiB.")?;
        Ok(())
    })?;
    // Visit only used entries; the others remain zero between passes.
    keys.sort_unstable();
    let mut offsets = Vec::with_capacity(keys.len() + 1);
    let mut total = 0u32;
    for trigram in &keys {
        let (last, length) = table.entry(*trigram);
        offsets.push(total);
        let start = total;
        total = total
            .checked_add(*length)
            .ok_or("Trigram postings past 4 GiB.")?;
        *length = start;
        *last = 0;
    }
    offsets.push(total);
    let mut postings = vec![0u8; total as usize];
    each_posting(starts, bytes, &mut table, |_, delta, cursor| {
        put_varint(&mut postings, cursor, delta);
        Ok(())
    })?;
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
    use std::collections::BTreeMap;

    #[test]
    fn postings_list_each_string_that_holds_a_trigram_once_in_order() -> Result<()> {
        let mut texts = vec!["aaaa", "abcabc", "", "xy", "bcab"];
        // Positions past 127 and 16383 take two- and three-byte varints.
        texts.extend(std::iter::repeat_n("", 200));
        texts.push("abcd");
        texts.extend(std::iter::repeat_n("", 20_000));
        texts.extend(["aaaa", "\u{4f60}\u{597d}"]);
        let mut bytes = Vec::new();
        let mut starts = vec![0];
        let mut expected = BTreeMap::<u32, Vec<u32>>::new();
        for (position, text) in texts.iter().enumerate() {
            bytes.extend_from_slice(text.as_bytes());
            starts.push(bytes.len() as u32);
            for window in text.as_bytes().windows(3) {
                let list = expected.entry(key(window)).or_default();
                if list.last() != Some(&(position as u32)) {
                    list.push(position as u32);
                }
            }
        }
        let (keys, offsets, postings) = build(&starts, &bytes)?;
        assert_eq!(keys, expected.keys().copied().collect::<Vec<_>>());
        let index = Trigrams::new(keys.into(), offsets.into(), postings.into())?;
        for (at, positions) in expected.values().enumerate() {
            assert_eq!(&index.positions(at)?, positions);
        }
        Ok(())
    }

    /// The build's output from first principles: sorted trigrams, then each one's positions as
    /// delta-encoded varints, end to end.
    fn reference(starts: &[u32], bytes: &[u8]) -> (Vec<u32>, Vec<u32>, Vec<u8>) {
        let mut positions = BTreeMap::<u32, Vec<u32>>::new();
        for position in 0..starts.len() - 1 {
            let text = &bytes[starts[position] as usize..starts[position + 1] as usize];
            for window in text.windows(3) {
                let list = positions.entry(key(window)).or_default();
                if list.last() != Some(&(position as u32)) {
                    list.push(position as u32);
                }
            }
        }
        let (mut offsets, mut postings) = (vec![0], Vec::new());
        for list in positions.values() {
            let mut previous = 0;
            for position in list {
                let mut value = position - previous;
                previous = *position;
                while value >= 0x80 {
                    postings.push(value as u8 | 0x80);
                    value >>= 7;
                }
                postings.push(value as u8);
            }
            offsets.push(postings.len() as u32);
        }
        (positions.into_keys().collect(), offsets, postings)
    }

    #[test]
    fn sparse_tables_build_exactly_the_reference_index() -> Result<()> {
        // Strings over many leading byte pairs, so the build allocates many pages.
        let mut seed = 0x2545_f491_u32;
        let mut texts = Vec::new();
        for length in 0..3000usize {
            let text = (0..length % 41)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    (seed >> 24) as u8
                })
                .collect::<Vec<_>>();
            texts.push(text);
            if length % 7 == 0 {
                texts.push(b"repeated text repeated".to_vec());
            }
        }
        texts.extend((0..=255u8).map(|byte| vec![byte; 5]));
        let mut bytes = Vec::new();
        let mut starts = vec![0];
        for text in &texts {
            bytes.extend_from_slice(text);
            starts.push(bytes.len() as u32);
        }
        assert_eq!(build(&starts, &bytes)?, reference(&starts, &bytes));
        assert_eq!(build(&[0], &[])?, (Vec::new(), vec![0], Vec::new()));
        Ok(())
    }

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
