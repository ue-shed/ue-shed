//! Row sets: one bit per row of a listing relation. A search is the intersection of its atoms,
//! each evaluated once over every row and cached by its normalized form, so a facet or count
//! that leaves a clause out, or a keystroke that changes only the text, reuses the others.
use crate::Result;
use crate::engine_match::checkpoint;
use std::collections::HashMap;
use std::sync::{Arc, atomic::AtomicBool};

/// The cache's bound on the bytes of the sets it keeps.
const ATOM_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct RowSet {
    words: Arc<[u64]>,
    len: usize,
}

impl RowSet {
    /// The rows of `0..len` for which `test` holds.
    pub fn from_fn(
        len: usize,
        cancelled: &AtomicBool,
        mut test: impl FnMut(usize) -> Result<bool>,
    ) -> Result<Self> {
        let mut words = vec![0u64; len.div_ceil(64)];
        for row in 0..len {
            if row & 255 == 0 {
                checkpoint(cancelled)?;
            }
            if test(row)? {
                words[row / 64] |= 1 << (row % 64);
            }
        }
        Ok(Self {
            words: words.into(),
            len,
        })
    }

    /// The listed rows of `0..len`; a row may be listed more than once.
    pub fn from_rows(len: usize, rows: &[u32]) -> Result<Self> {
        let mut words = vec![0u64; len.div_ceil(64)];
        for row in rows {
            let row = *row as usize;
            crate::require(row < len, "A row outside its relation.")?;
            words[row / 64] |= 1 << (row % 64);
        }
        Ok(Self {
            words: words.into(),
            len,
        })
    }

    /// The rows in any of the sets, none when there are none.
    pub fn union<'a>(len: usize, sets: impl IntoIterator<Item = &'a RowSet>) -> Self {
        let mut words = vec![0u64; len.div_ceil(64)];
        for set in sets {
            for (word, other) in words.iter_mut().zip(set.words.iter()) {
                *word |= other;
            }
        }
        Self {
            words: words.into(),
            len,
        }
    }

    pub fn contains(&self, row: usize) -> bool {
        row < self.len && self.words[row / 64] & (1 << (row % 64)) != 0
    }

    pub fn bytes(&self) -> usize {
        self.words.len() * 8
    }

    /// The rows in every set, `len` rows when there are none.
    pub fn intersection(len: usize, sets: &[RowSet]) -> Result<Self> {
        let mut words = vec![u64::MAX; len.div_ceil(64)];
        if !len.is_multiple_of(64)
            && let Some(last) = words.last_mut()
        {
            *last = (1u64 << (len % 64)) - 1;
        }
        for set in sets {
            crate::require(set.len == len, "Row sets of different relations.")?;
            for (word, other) in words.iter_mut().zip(set.words.iter()) {
                *word &= other;
            }
        }
        Ok(Self {
            words: words.into(),
            len,
        })
    }

    /// The set's rows in `order`, a permutation of the relation's rows.
    pub fn in_order(&self, order: &[u32], cancelled: &AtomicBool) -> Result<Vec<u32>> {
        let mut rows = Vec::new();
        for (index, row) in order.iter().enumerate() {
            if index & 4095 == 0 {
                checkpoint(cancelled)?;
            }
            if self.contains(*row as usize) {
                rows.push(*row);
            }
        }
        Ok(rows)
    }
}

/// Atom sets by normalized key, least recently used first out, bounded by their bytes.
#[derive(Default)]
pub(crate) struct AtomCache {
    entries: HashMap<String, (RowSet, u64)>,
    clock: u64,
    bytes: usize,
}

impl AtomCache {
    pub fn get(&mut self, key: &str) -> Option<RowSet> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(key).map(|(set, used)| {
            *used = clock;
            set.clone()
        })
    }

    pub fn insert(&mut self, key: String, set: RowSet) {
        if set.bytes() > ATOM_CACHE_BYTES {
            return;
        }
        while self.bytes + set.bytes() > ATOM_CACHE_BYTES {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some((removed, _)) = self.entries.remove(&oldest) {
                self.bytes -= removed.bytes();
            }
        }
        self.clock += 1;
        self.bytes += set.bytes();
        if let Some((replaced, _)) = self.entries.insert(key, (set, self.clock)) {
            self.bytes -= replaced.bytes();
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_intersect_list_in_order_and_the_cache_evicts_the_least_recently_used() -> Result<()> {
        let cancelled = AtomicBool::new(false);
        let even = RowSet::from_fn(130, &cancelled, |row| Ok(row % 2 == 0))?;
        let small = RowSet::from_fn(130, &cancelled, |row| Ok(row < 7 || row == 128))?;
        let both = RowSet::intersection(130, &[even.clone(), small])?;
        assert_eq!(
            both.in_order(&[128, 6, 5, 4, 2, 0], &cancelled)?,
            [128, 6, 4, 2, 0]
        );
        assert!(!RowSet::intersection(130, &[])?.contains(130));
        assert!(RowSet::intersection(130, &[])?.contains(129));
        let wrong = RowSet::from_fn(3, &cancelled, |_| Ok(true))?;
        assert!(RowSet::intersection(130, &[wrong]).is_err());
        let mut cache = AtomCache::default();
        cache.insert("even".into(), even);
        assert!(cache.get("even").is_some());
        assert!(cache.get("odd").is_none());
        assert_eq!(cache.len(), 1);
        assert!(
            RowSet::from_fn(1, &AtomicBool::new(true), |_| Ok(true)).is_err(),
            "evaluation stops when cancelled"
        );
        Ok(())
    }
}
