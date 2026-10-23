//! Nullable typed columns and evaluation-local dictionaries/structured values.
use super::value::{Number, Object, Value};
use crate::engine_reader::EngineReader;
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use rustc_hash::{FxHashMap, FxHasher};
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StrId(pub u32);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ValId(pub u32);
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Atom {
    #[default]
    Null,
    Bool(bool),
    Int(i64),
    Num(u64),
    Str(StrId),
    Val(ValId),
}
impl Atom {
    pub fn boolean(self) -> bool {
        self == Self::Bool(true)
    }
}
#[derive(Clone, Debug, Default)]
pub struct Bits {
    pub words: Vec<u64>,
    pub len: usize,
}
impl Bits {
    pub fn new(len: usize) -> Self {
        Self {
            words: vec![0; len.div_ceil(64)],
            len,
        }
    }
    pub fn all(len: usize) -> Self {
        let mut value = Self {
            words: vec![u64::MAX; len.div_ceil(64)],
            len,
        };
        if !len.is_multiple_of(64)
            && let Some(last) = value.words.last_mut()
        {
            *last = (1 << (len % 64)) - 1;
        }
        value
    }
    pub fn get(&self, row: usize) -> bool {
        self.words
            .get(row / 64)
            .is_some_and(|word| word & (1 << (row % 64)) != 0)
    }
    pub fn clear(&mut self, row: usize) {
        self.words[row / 64] &= !(1 << (row % 64));
    }
    pub fn set(&mut self, row: usize) {
        self.words[row / 64] |= 1 << (row % 64);
    }
    pub fn union(&mut self, other: &Self) {
        for (a, b) in self.words.iter_mut().zip(&other.words) {
            *a |= b;
        }
    }
    pub fn any(&self) -> bool {
        self.words.iter().any(|word| *word != 0)
    }
    pub fn retain(&mut self, mut predicate: impl FnMut(u32) -> bool) {
        for (index, word) in self.words.iter_mut().enumerate() {
            let mut pending = *word;
            while pending != 0 {
                let bit = pending.trailing_zeros();
                pending &= pending - 1;
                if !predicate(index as u32 * 64 + bit) {
                    *word &= !(1 << bit);
                }
            }
        }
    }
    pub fn count(&self) -> usize {
        self.words
            .iter()
            .map(|word| word.count_ones() as usize)
            .sum()
    }
    pub fn ones(&self) -> impl Iterator<Item = u32> + '_ {
        self.words
            .iter()
            .copied()
            .enumerate()
            .flat_map(|(index, mut word)| {
                std::iter::from_fn(move || {
                    if word == 0 {
                        return None;
                    }
                    let bit = word.trailing_zeros();
                    word &= word - 1;
                    Some(index as u32 * 64 + bit)
                })
            })
    }
    /// Deposit compact column bits into selection positions. Each selection word takes its
    /// chunk of compact bits at once; empty and full chunks need no per-bit work.
    pub fn deposit(&self, compact: &Self) -> Self {
        let mut result = Self::new(self.len);
        let mut source = 0usize;
        for (destination, selected) in self.words.iter().copied().enumerate() {
            let count = selected.count_ones() as usize;
            if count == 0 {
                continue;
            }
            // The next `count` compact bits, lowest first.
            let offset = source % 64;
            let mut chunk = compact.words.get(source / 64).copied().unwrap_or(0) >> offset;
            if offset > 0 {
                chunk |= compact.words.get(source / 64 + 1).copied().unwrap_or(0) << (64 - offset);
            }
            if count < 64 {
                chunk &= (1 << count) - 1;
            }
            source += count;
            result.words[destination] = if chunk == 0 {
                0
            } else if count == 64 {
                chunk
            } else if chunk.count_ones() as usize == count {
                selected
            } else {
                let (mut selected, mut word) = (selected, 0);
                while chunk != 0 {
                    let bit = selected.trailing_zeros();
                    selected &= selected - 1;
                    word |= (chunk & 1) << bit;
                    chunk >>= 1;
                }
                word
            };
        }
        result
    }
    /// The bits at `mask`'s set positions, packed in order: the inverse of `deposit`. Full mask
    /// words copy whole, and only the set bits of the source cost anything.
    pub fn extract(&self, mask: &Self) -> Self {
        let mut result = Self::new(mask.count());
        let mut at = 0;
        for (index, selected) in mask.words.iter().copied().enumerate() {
            let mut source = self.words.get(index).copied().unwrap_or(0) & selected;
            if source != 0 {
                let packed = if selected == u64::MAX {
                    source
                } else {
                    let mut word = 0;
                    while source != 0 {
                        let bit = source.trailing_zeros();
                        source &= source - 1;
                        word |= 1 << (selected & ((1 << bit) - 1)).count_ones();
                    }
                    word
                };
                result.words[at / 64] |= packed << (at % 64);
                if at % 64 > 0
                    && let Some(next) = result.words.get_mut(at / 64 + 1)
                {
                    *next |= packed >> (64 - at % 64);
                }
            }
            at += selected.count_ones() as usize;
        }
        result
    }
    /// The bits of `parents[row]` for each of `mask`'s set rows, packed in order.
    pub fn extract_through(&self, mask: &Self, parents: &[u32]) -> Self {
        let mut result = Self::new(mask.count());
        if self.any() {
            for (index, row) in mask.ones().enumerate() {
                if self.get(parents[row as usize] as usize) {
                    result.set(index);
                }
            }
        }
        result
    }
}
/// The values at a mask's set rows, in order, read through `parents` when given. Chunks of 64K
/// rows fill their own ranges of the output in parallel.
fn gather_mask<T: Copy + Send + Sync>(
    values: &[T],
    mask: &Bits,
    parents: Option<&[u32]>,
) -> Vec<T> {
    use rayon::prelude::*;
    const WORDS: usize = 1024;
    let counts = mask
        .words
        .par_chunks(WORDS)
        .map(|words| words.iter().map(|word| word.count_ones() as usize).sum())
        .collect::<Vec<usize>>();
    let total = counts.iter().sum();
    if total == 0 {
        return Vec::new();
    }
    // Any value will do as the fill; every slot is written below.
    let mut output = vec![values[0]; total];
    let mut slices = Vec::with_capacity(counts.len());
    let mut rest = output.as_mut_slice();
    for count in counts {
        let (head, tail) = std::mem::take(&mut rest).split_at_mut(count);
        slices.push(head);
        rest = tail;
    }
    mask.words
        .par_chunks(WORDS)
        .zip(slices)
        .enumerate()
        .for_each(|(chunk, (words, slice))| {
            let mut slot = 0;
            for (offset, mut word) in words.iter().copied().enumerate() {
                let base = (chunk * WORDS + offset) * 64;
                while word != 0 {
                    let row = base + word.trailing_zeros() as usize;
                    word &= word - 1;
                    slice[slot] = values[parents.map_or(row, |parents| parents[row] as usize)];
                    slot += 1;
                }
            }
        });
    output
}
#[derive(Clone, Debug)]
pub enum Data {
    Bool(Bits),
    Int(Vec<i64>),
    Num(Vec<f64>),
    Str(Vec<StrId>),
    Val(Vec<ValId>),
    Constant(Atom),
}
#[derive(Clone, Debug)]
pub struct Column {
    pub data: Data,
    pub nulls: Bits,
    pub failed: Bits,
}
impl Column {
    pub fn bytes(&self) -> usize {
        self.nulls.words.capacity() * 8
            + self.failed.words.capacity() * 8
            + match &self.data {
                Data::Bool(bits) => bits.words.capacity() * 8,
                Data::Int(values) => values.capacity() * 8,
                Data::Num(values) => values.capacity() * 8,
                Data::Str(values) => values.capacity() * 4,
                Data::Val(values) => values.capacity() * 4,
                Data::Constant(_) => 0,
            }
    }
    pub fn booleans(&self, arena: &Arena) -> Bits {
        let mut bits = match &self.data {
            Data::Bool(bits) => bits.clone(),
            Data::Constant(Atom::Bool(true)) => Bits::all(self.len()),
            Data::Constant(_) => Bits::new(self.len()),
            _ => {
                let mut bits = Bits::new(self.len());
                for row in 0..self.len() {
                    if self.get(row, arena).boolean() {
                        bits.set(row);
                    }
                }
                bits
            }
        };
        for ((word, null), failed) in bits
            .words
            .iter_mut()
            .zip(&self.nulls.words)
            .zip(&self.failed.words)
        {
            *word &= !null & !failed;
        }
        bits
    }
    pub fn constant(value: Atom, len: usize) -> Self {
        Self {
            data: Data::Constant(value),
            nulls: if value == Atom::Null {
                Bits::all(len)
            } else {
                Bits::new(len)
            },
            failed: Bits::new(len),
        }
    }
    pub fn len(&self) -> usize {
        self.nulls.len
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn get(&self, row: usize, arena: &Arena) -> Atom {
        if self.nulls.get(row) {
            return Atom::Null;
        }
        match &self.data {
            Data::Bool(values) => Atom::Bool(values.get(row)),
            Data::Int(values) => Atom::Int(values[row]),
            Data::Num(values) => Atom::Num(values[row].to_bits()),
            Data::Str(values) => Atom::Str(values[row]),
            Data::Val(values) => match &arena.values[values[row].0 as usize] {
                Structured::Scalar(value) => *value,
                _ => Atom::Val(values[row]),
            },
            Data::Constant(value) => *value,
        }
    }
    pub fn from_atoms(values: &[Atom], arena: &mut Arena) -> Result<Self> {
        use rayon::prelude::*;
        // Large inputs scan and copy in parallel; small ones stay on the calling thread. Only
        // the mixed-type case interns, and it stays serial so ids follow row order.
        const SPLIT: usize = 1 << 15;
        let words = |set: &(dyn Fn(Atom) -> bool + Sync)| Bits {
            words: values
                .par_chunks(64)
                .with_min_len(SPLIT / 64)
                .map(|chunk| {
                    chunk
                        .iter()
                        .enumerate()
                        .filter(|(_, value)| set(**value))
                        .fold(0u64, |word, (row, _)| word | 1 << row)
                })
                .collect(),
            len: values.len(),
        };
        let nulls = words(&|value| value == Atom::Null);
        let first = values
            .iter()
            .copied()
            .find(|value| *value != Atom::Null)
            .unwrap_or_default();
        if values
            .par_iter()
            .with_min_len(SPLIT)
            .all(|value| *value == first)
        {
            return Ok(Self::constant(first, values.len()));
        }
        let same = values.par_iter().with_min_len(SPLIT).all(|value| {
            *value == Atom::Null || std::mem::discriminant(value) == std::mem::discriminant(&first)
        });
        fn typed<T: Send>(values: &[Atom], read: impl Fn(Atom) -> T + Sync + Send) -> Vec<T> {
            values
                .par_iter()
                .with_min_len(SPLIT)
                .map(|value| read(*value))
                .collect()
        }
        let data = match first {
            Atom::Bool(_) if same => Data::Bool(words(&|value| value.boolean())),
            Atom::Int(_) if same => Data::Int(typed(values, |value| match value {
                Atom::Int(value) => value,
                _ => 0,
            })),
            Atom::Num(_) if same => Data::Num(typed(values, |value| match value {
                Atom::Num(value) => f64::from_bits(value),
                _ => 0.0,
            })),
            Atom::Str(_) if same => Data::Str(typed(values, |value| match value {
                Atom::Str(value) => value,
                _ => StrId(0),
            })),
            Atom::Val(_) if same => Data::Val(typed(values, |value| match value {
                Atom::Val(value) => value,
                _ => ValId(0),
            })),
            _ => Data::Val(
                values
                    .iter()
                    .map(|value| arena.structured(Structured::Scalar(*value)))
                    .collect::<Result<_>>()?,
            ),
        };
        Ok(Self {
            data,
            nulls,
            failed: Bits::new(values.len()),
        })
    }
    pub fn select(&self, rows: &[usize], _arena: &mut Arena) -> Result<Self> {
        use rayon::prelude::*;
        // Large selections copy in parallel; a word of selected bits is built at a time.
        let parallel = rows.len() >= 1 << 16;
        let select_bits = |bits: &Bits| {
            let word = |chunk: &[usize]| {
                chunk
                    .iter()
                    .enumerate()
                    .filter(|(_, row)| bits.get(**row))
                    .fold(0u64, |word, (index, _)| word | 1 << index)
            };
            let words = if parallel {
                rows.par_chunks(64).map(word).collect()
            } else {
                rows.chunks(64).map(word).collect()
            };
            Bits {
                words,
                len: rows.len(),
            }
        };
        fn gather<T: Copy + Send + Sync>(values: &[T], rows: &[usize], parallel: bool) -> Vec<T> {
            if parallel {
                rows.par_iter().map(|row| values[*row]).collect()
            } else {
                rows.iter().map(|row| values[*row]).collect()
            }
        }
        let data = match &self.data {
            Data::Constant(value) => Data::Constant(*value),
            Data::Bool(values) => Data::Bool(select_bits(values)),
            Data::Int(values) => Data::Int(gather(values, rows, parallel)),
            Data::Num(values) => Data::Num(gather(values, rows, parallel)),
            Data::Str(values) => Data::Str(gather(values, rows, parallel)),
            Data::Val(values) => Data::Val(gather(values, rows, parallel)),
        };
        Ok(Self {
            data,
            nulls: select_bits(&self.nulls),
            failed: select_bits(&self.failed),
        })
    }
    /// `select` at a mask's set rows, read through `parents` when given, without a row list.
    pub fn select_mask(&self, mask: &Bits, parents: Option<&[u32]>) -> Self {
        let bits = |bits: &Bits| match parents {
            Some(parents) => bits.extract_through(mask, parents),
            None => bits.extract(mask),
        };
        let data = match &self.data {
            Data::Constant(value) => Data::Constant(*value),
            Data::Bool(values) => Data::Bool(bits(values)),
            Data::Int(values) => Data::Int(gather_mask(values, mask, parents)),
            Data::Num(values) => Data::Num(gather_mask(values, mask, parents)),
            Data::Str(values) => Data::Str(gather_mask(values, mask, parents)),
            Data::Val(values) => Data::Val(gather_mask(values, mask, parents)),
        };
        Self {
            data,
            nulls: bits(&self.nulls),
            failed: bits(&self.failed),
        }
    }
    /// Give a constant column the storage for the source's type, as the first scatter needs.
    fn adopt(&mut self, source: &Self) {
        if let Data::Constant(value) = self.data {
            self.data = match &source.data {
                Data::Bool(_) | Data::Constant(Atom::Bool(_)) => Data::Bool(Bits::new(self.len())),
                Data::Int(_) | Data::Constant(Atom::Int(_)) => Data::Int(vec![0; self.len()]),
                Data::Num(_) | Data::Constant(Atom::Num(_)) => Data::Num(vec![0.0; self.len()]),
                Data::Str(_) | Data::Constant(Atom::Str(_)) => {
                    Data::Str(vec![StrId(0); self.len()])
                }
                Data::Val(_) | Data::Constant(Atom::Val(_)) => {
                    Data::Val(vec![ValId(0); self.len()])
                }
                Data::Constant(Atom::Null) => Data::Constant(value),
            };
        }
    }
    /// `scatter` at a mask's set rows. A source of the column's own type is written a word or a
    /// value at a time; any other source takes `scatter`, so value ids are made the same way.
    pub fn scatter_mask(&mut self, mask: &Bits, source: &Self, arena: &mut Arena) -> Result<()> {
        self.adopt(source);
        let typed = matches!(
            (&self.data, &source.data),
            (Data::Constant(Atom::Null), Data::Constant(Atom::Null))
                | (
                    Data::Bool(_),
                    Data::Bool(_) | Data::Constant(Atom::Bool(_) | Atom::Null)
                )
                | (
                    Data::Int(_),
                    Data::Int(_) | Data::Constant(Atom::Int(_) | Atom::Null)
                )
                | (
                    Data::Num(_),
                    Data::Num(_) | Data::Constant(Atom::Num(_) | Atom::Null)
                )
                | (
                    Data::Str(_),
                    Data::Str(_) | Data::Constant(Atom::Str(_) | Atom::Null)
                )
                | (
                    Data::Val(_),
                    Data::Val(_) | Data::Constant(Atom::Val(_) | Atom::Null)
                )
        );
        if !typed {
            return self.scatter(&mask.ones().collect::<Vec<_>>(), source, arena);
        }
        // Null source rows only set their null bit; every other row clears it and is written.
        // A constant null reads as null whatever its bits say.
        let mut nulls = if let Data::Constant(Atom::Null) = source.data {
            mask.clone()
        } else {
            mask.deposit(&source.nulls)
        };
        let failed = mask.deposit(&source.failed);
        fn write<T: Copy>(
            target: &mut [T],
            mask: &Bits,
            nulls: &Bits,
            mut value: impl FnMut(usize) -> T,
        ) {
            for (index, row) in mask.ones().enumerate() {
                if !nulls.get(row as usize) {
                    target[row as usize] = value(index);
                }
            }
        }
        match (&mut self.data, &source.data) {
            (Data::Bool(values), _) => {
                let set = match &source.data {
                    Data::Bool(bits) => mask.deposit(bits),
                    Data::Constant(Atom::Bool(true)) => mask.clone(),
                    _ => Bits::new(mask.len),
                };
                for (((word, selected), null), set) in values
                    .words
                    .iter_mut()
                    .zip(&mask.words)
                    .zip(&nulls.words)
                    .zip(&set.words)
                {
                    let written = selected & !null;
                    *word = (*word & !written) | (set & written);
                }
            }
            (Data::Int(values), Data::Int(source)) => write(values, mask, &nulls, |at| source[at]),
            (Data::Int(values), Data::Constant(Atom::Int(value))) => {
                write(values, mask, &nulls, |_| *value)
            }
            (Data::Num(values), Data::Num(source)) => write(values, mask, &nulls, |at| source[at]),
            (Data::Num(values), Data::Constant(Atom::Num(value))) => {
                write(values, mask, &nulls, |_| f64::from_bits(*value))
            }
            (Data::Str(values), Data::Str(source)) => write(values, mask, &nulls, |at| source[at]),
            (Data::Str(values), Data::Constant(Atom::Str(value))) => {
                write(values, mask, &nulls, |_| *value)
            }
            (Data::Val(values), Data::Constant(Atom::Val(value))) => {
                write(values, mask, &nulls, |_| *value)
            }
            // A scalar wrapper reads as its scalar: `scatter` would store a wrapped value
            // unwrapped, a wrapped null as null, and find any other wrapper's own id again.
            (Data::Val(values), Data::Val(source)) => {
                for (index, row) in mask.ones().enumerate() {
                    let row = row as usize;
                    if nulls.get(row) {
                        continue;
                    }
                    match arena.values[source[index].0 as usize] {
                        Structured::Scalar(Atom::Null) => nulls.set(row),
                        Structured::Scalar(Atom::Val(value)) => values[row] = value,
                        _ => values[row] = source[index],
                    }
                }
            }
            _ => {}
        }
        for ((word, selected), null) in self
            .nulls
            .words
            .iter_mut()
            .zip(&mask.words)
            .zip(&nulls.words)
        {
            *word = (*word & !selected) | null;
        }
        for (word, failure) in self.failed.words.iter_mut().zip(&failed.words) {
            *word |= failure;
        }
        Ok(())
    }
    /// The representation `from_atoms` gives the same values: constant when every row, nulls
    /// included, holds one value. Failures are kept as they are; only plain scalars fold.
    pub fn folded(mut self) -> Self {
        let failed = std::mem::take(&mut self.failed);
        let mut column = self.fold();
        column.failed = failed;
        column
    }
    fn fold(self) -> Self {
        let len = self.len();
        let nulls = self.nulls.count();
        if nulls > 0 && nulls < len {
            return self;
        }
        if nulls == len {
            return Self::constant(Atom::Null, len);
        }
        let first = match &self.data {
            Data::Bool(bits) => {
                let set = bits.count();
                (set == 0 || set == len).then_some(Atom::Bool(set == len))
            }
            Data::Int(values) => values
                .iter()
                .all(|value| *value == values[0])
                .then(|| Atom::Int(values[0])),
            Data::Num(values) => values
                .iter()
                .all(|value| value.to_bits() == values[0].to_bits())
                .then(|| Atom::Num(values[0].to_bits())),
            Data::Str(values) => values
                .iter()
                .all(|value| *value == values[0])
                .then(|| Atom::Str(values[0])),
            Data::Val(_) | Data::Constant(_) => None,
        };
        match first {
            Some(value) if len > 0 => Self::constant(value, len),
            _ => self,
        }
    }
    pub fn scatter(&mut self, rows: &[u32], source: &Self, arena: &mut Arena) -> Result<()> {
        self.adopt(source);
        for (index, row) in rows.iter().copied().enumerate() {
            let row = row as usize;
            let atom = source.get(index, arena);
            if atom == Atom::Null {
                self.nulls.set(row);
            } else {
                let compatible = matches!(
                    (&self.data, atom),
                    (Data::Bool(_), Atom::Bool(_))
                        | (Data::Int(_), Atom::Int(_))
                        | (Data::Num(_), Atom::Num(_))
                        | (Data::Str(_), Atom::Str(_))
                        | (Data::Val(_), _)
                );
                if !compatible {
                    let atoms = (0..self.len())
                        .map(|index| self.get(index, arena))
                        .collect::<Vec<_>>();
                    self.data = Data::Val(
                        atoms
                            .into_iter()
                            .map(|atom| arena.structured(Structured::Scalar(atom)))
                            .collect::<Result<_>>()?,
                    );
                }
                self.nulls.clear(row);
                match (&mut self.data, atom) {
                    (Data::Bool(values), Atom::Bool(value)) => {
                        if value {
                            values.set(row);
                        } else {
                            values.clear(row);
                        }
                    }
                    (Data::Int(values), Atom::Int(value)) => values[row] = value,
                    (Data::Num(values), Atom::Num(value)) => values[row] = f64::from_bits(value),
                    (Data::Str(values), Atom::Str(value)) => values[row] = value,
                    (Data::Val(values), Atom::Val(value)) => values[row] = value,
                    (Data::Val(values), atom) => {
                        values[row] = arena.structured(Structured::Scalar(atom))?
                    }
                    (Data::Constant(value), atom) if *value == atom => {}
                    _ => return Err("Incompatible cached column types.".into()),
                }
            }
            if source.failed.get(index) {
                self.failed.set(row);
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct FieldColumn {
    pub column: Arc<Column>,
    pub rows: Option<Arc<[u32]>>,
}
impl FieldColumn {
    pub fn get(&self, row: usize, arena: &Arena) -> Atom {
        self.column.get(
            self.rows.as_ref().map_or(row, |rows| rows[row] as usize),
            arena,
        )
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Structured {
    List(Arc<[Atom]>),
    Object(Arc<[(StrId, Atom)]>),
    Occurrence(u32),
    OccurrenceLocation(u32),
    Scalar(Atom),
}
#[derive(Default)]
pub struct Occurrences {
    pub(super) data: Option<Arc<super::occurrences::OccurrenceData>>,
    pub(super) ids: Vec<Option<StrId>>,
    pub(super) files: Vec<StrId>,
    pub(super) location_kinds: [Atom; 3],
    pub fields: HashMap<String, Arc<Column>>,
    pub len: usize,
    pub raw_rows: Vec<u32>,
}
/// Where a loaded store string sits: its batch's buffer and byte range.
#[derive(Clone, Copy)]
struct Span {
    batch: u32,
    start: u32,
    end: u32,
}
pub struct Arena {
    store_count: u32,
    /// Loaded store strings: each `load_strings` batch is one exact-size buffer, so a string
    /// costs a span, not an allocation of its own.
    stored: FxHashMap<StrId, Span>,
    stored_text: Vec<Box<str>>,
    side: Vec<Arc<str>>,
    strings: FxHashMap<u64, StrId>,
    string_collisions: FxHashMap<u64, Vec<StrId>>,
    pub values: Vec<Structured>,
    structures: FxHashMap<Structured, ValId>,
    /// Occurrence and occurrence-location values by row: one per row, created on first use
    /// in the same order as any other value, without a hash-consing entry.
    occurrence_values: Vec<u32>,
    location_values: Vec<u32>,
    pub occurrences: Occurrences,
    pub line_children: Option<Arc<Children>>,
    pub line_fields: HashMap<String, Arc<Column>>,
    pub occurrence_fields: HashSet<String>,
    pub(crate) recorder: super::stages::Recorder,
    pub(crate) roles_mask: Arc<Mutex<HashMap<StrId, Arc<Bits>>>>,
    pub(crate) paths_mask: Arc<Mutex<HashMap<StrId, Arc<Bits>>>>,
}
impl Arena {
    /// The arena's parts in bytes, and how many structure entries it interns.
    pub(crate) fn holders(&self) -> std::collections::BTreeMap<&'static str, u64> {
        use std::mem::size_of;
        let payload = self
            .values
            .iter()
            .map(|value| match value {
                Structured::List(values) => values.len() * size_of::<Atom>(),
                Structured::Object(values) => values.len() * size_of::<(StrId, Atom)>(),
                _ => 0,
            })
            .sum::<usize>();
        std::collections::BTreeMap::from([
            (
                "arena.values",
                (self.values.capacity() * size_of::<Structured>()) as u64,
            ),
            ("arena.valuePayload", payload as u64),
            (
                "arena.structuresMap",
                (self.structures.capacity() * (size_of::<Structured>() + size_of::<ValId>() + 1))
                    as u64,
            ),
            ("arena.structuresEntries", self.structures.len() as u64),
            (
                "arena.rowValues",
                ((self.occurrence_values.capacity() + self.location_values.capacity()) * 4) as u64,
            ),
            (
                "arena.storedMap",
                (self.stored.capacity() * (size_of::<StrId>() + size_of::<Span>() + 1)) as u64,
            ),
            (
                "arena.storedText",
                self.stored_text
                    .iter()
                    .map(|text| text.len())
                    .sum::<usize>() as u64,
            ),
            (
                "arena.side",
                (self.side.capacity() * size_of::<Arc<str>>()
                    + self.side.iter().map(|text| text.len()).sum::<usize>())
                    as u64,
            ),
            (
                "arena.stringsMap",
                (self.strings.capacity() * (size_of::<u64>() + size_of::<StrId>() + 1)) as u64,
            ),
        ])
    }
    pub(crate) fn memory(&self) -> super::stages::Memory {
        use std::mem::size_of;
        let structures = self
            .values
            .iter()
            .map(|value| match value {
                Structured::List(values) => values.len() * size_of::<Atom>(),
                Structured::Object(values) => values.len() * size_of::<(StrId, Atom)>(),
                _ => 0,
            })
            .sum::<usize>();
        let side_strings = self.side.iter().map(|text| text.len()).sum::<usize>();

        let occurrence_relation_bytes = self
            .occurrences
            .data
            .as_ref()
            .map_or(0, |data| data.bytes())
            + self.occurrences.ids.capacity() * size_of::<Option<StrId>>()
            + self.occurrences.raw_rows.capacity() * 4
            + self
                .occurrences
                .fields
                .values()
                .map(|column| column.bytes())
                .sum::<usize>()
            + self.line_children.as_ref().map_or(0, |children| {
                children.offsets.capacity() * 4 + children.members.capacity() * 4
            });
        super::stages::Memory {
            arena_bytes: self.values.capacity() * size_of::<Structured>()
                + structures
                + self.structures.capacity() * (size_of::<Structured>() + size_of::<ValId>() + 1)
                + (self.occurrence_values.capacity() + self.location_values.capacity()) * 4
                + self.stored.capacity() * (size_of::<StrId>() + size_of::<Span>() + 1)
                + self
                    .stored_text
                    .iter()
                    .map(|text| text.len())
                    .sum::<usize>(),
            side_dictionary_bytes: self.side.capacity() * size_of::<Arc<str>>()
                + side_strings
                + self.strings.capacity() * (size_of::<u64>() + size_of::<StrId>() + 1)
                + self
                    .string_collisions
                    .values()
                    .map(|values| values.capacity() * size_of::<StrId>())
                    .sum::<usize>(),
            occurrence_relation_bytes,
            ..super::stages::Memory::default()
        }
    }
    pub fn new(store_count: usize) -> Result<Self> {
        Ok(Self {
            store_count: store_count.try_into()?,
            stored: FxHashMap::default(),
            stored_text: Vec::new(),
            side: Vec::new(),
            strings: FxHashMap::default(),
            string_collisions: FxHashMap::default(),
            values: Vec::new(),
            structures: FxHashMap::default(),
            occurrence_values: Vec::new(),
            location_values: Vec::new(),
            occurrences: Occurrences::default(),
            line_children: None,
            line_fields: HashMap::new(),
            occurrence_fields: HashSet::new(),
            recorder: super::stages::Recorder::default(),
            roles_mask: Arc::default(),
            paths_mask: Arc::default(),
        })
    }
    pub fn load_strings(&mut self, reader: &mut EngineReader, ids: &[u32]) -> Result<()> {
        let dedup = super::stages::Measure::start();
        let mut seen = HashSet::new();
        let mut wanted = ids
            .iter()
            .copied()
            .filter(|id| {
                *id < self.store_count && !self.stored.contains_key(&StrId(*id)) && seen.insert(*id)
            })
            .collect::<Vec<_>>();
        wanted.sort_unstable();
        self.recorder
            .sub_stage("strings.dedup".into(), &dedup, ids.len());
        let mut measure = super::stages::Measure::start();
        let batch_read = super::stages::Measure::start();
        let texts = reader.strings_batch(&wanted)?;
        self.recorder
            .sub_stage("strings.batch".into(), &batch_read, wanted.len());
        let mut hashing = super::stages::Measure::start();
        // Hash in parallel; the batch's text is one buffer and the maps are filled in ID order.
        let hashes = hashing.parallel_chunks(&texts, 1024, |text| {
            let mut hash = FxHasher::default();
            hash.write(Wtf8Buf::from_view(text).as_bytes());
            hash.finish()
        });
        measure.include(&hashing);
        self.recorder
            .sub_stage("strings.hash".into(), &hashing, wanted.len());
        let inserting = super::stages::Measure::start();
        let mut buffer = String::with_capacity(texts.iter().map(String::len).sum());
        let batch = u32::try_from(self.stored_text.len())?;
        let mut spans = Vec::with_capacity(texts.len());
        for text in &texts {
            let start = u32::try_from(buffer.len())?;
            buffer.push_str(text);
            spans.push(Span {
                batch,
                start,
                end: u32::try_from(buffer.len())?,
            });
        }
        drop(texts);
        self.stored_text.push(buffer.into_boxed_str());
        self.stored.reserve(spans.len());
        for ((id, hash), span) in wanted.iter().copied().zip(hashes).zip(spans) {
            self.stored.insert(StrId(id), span);
            if let Some(first) = self.strings.get(&hash).copied() {
                if self.text(first) != self.text(StrId(id)) {
                    self.string_collisions
                        .entry(hash)
                        .or_default()
                        .push(StrId(id));
                }
            } else {
                self.strings.insert(hash, StrId(id));
            }
        }
        self.recorder
            .sub_stage("strings.insert".into(), &inserting, wanted.len());
        self.recorder
            .sub_stage("strings.load".into(), &measure, wanted.len());
        Ok(())
    }
    pub fn same_dictionary(&self, a: StrId, b: StrId) -> bool {
        (a.0 < self.store_count) == (b.0 < self.store_count)
    }
    pub fn string_count(&self) -> usize {
        self.store_count as usize + self.side.len()
    }
    pub fn text(&self, id: StrId) -> &str {
        if id.0 >= self.store_count {
            &self.side[(id.0 - self.store_count) as usize]
        } else {
            self.stored.get(&id).map_or("", |span| {
                &self.stored_text[span.batch as usize][span.start as usize..span.end as usize]
            })
        }
    }
    fn text_arc(&self, id: StrId) -> Arc<str> {
        if id.0 >= self.store_count {
            Arc::clone(&self.side[(id.0 - self.store_count) as usize])
        } else {
            Arc::from(self.text(id))
        }
    }
    pub fn string(&mut self, text: &str) -> Result<StrId> {
        use std::borrow::Cow;
        // A view without escaped surrogates is its own WTF-8: hash it in place.
        let (bytes, canonical) = if text.as_bytes().contains(&0xf3) {
            let bytes = Wtf8Buf::from_view(text).into_bytes();
            let canonical = Wtf8Buf::from_bytes(bytes.clone())?.into_view();
            (Cow::Owned(bytes), Cow::Owned(canonical))
        } else {
            (Cow::Borrowed(text.as_bytes()), Cow::Borrowed(text))
        };
        let mut hash = FxHasher::default();
        hash.write(&bytes);
        let hash = hash.finish();
        if let Some(first) = self.strings.get(&hash).copied() {
            if self.text(first) == canonical {
                return Ok(first);
            }
            if let Some(ids) = self.string_collisions.get(&hash)
                && let Some(id) = ids.iter().find(|id| self.text(**id) == canonical)
            {
                return Ok(*id);
            }
        }
        let id = StrId(
            self.store_count
                .checked_add(u32::try_from(self.side.len())?)
                .ok_or("Evaluation string dictionary is full.")?,
        );
        self.side.push(Arc::from(&*canonical));
        if let std::collections::hash_map::Entry::Vacant(entry) = self.strings.entry(hash) {
            entry.insert(id);
        } else {
            self.string_collisions.entry(hash).or_default().push(id);
        }
        Ok(id)
    }
    /// The ID `string` would return, if the text is already interned. Read-only.
    pub fn find_string(&self, text: &str) -> Option<StrId> {
        if text.as_bytes().contains(&0xf3) {
            return None;
        }
        let mut hash = FxHasher::default();
        hash.write(text.as_bytes());
        let hash = hash.finish();
        let first = *self.strings.get(&hash)?;
        if self.text(first) == text {
            return Some(first);
        }
        self.string_collisions
            .get(&hash)?
            .iter()
            .copied()
            .find(|id| self.text(*id) == text)
    }
    /// The ID `structured` would return, if the value is already interned. Read-only.
    pub fn find_structured(&self, value: &Structured) -> Option<ValId> {
        self.structures.get(value).copied()
    }
    pub fn structured(&mut self, value: Structured) -> Result<ValId> {
        if let Some(id) = self.structures.get(&value) {
            return Ok(*id);
        }
        let id = ValId(self.values.len().try_into()?);
        self.values.push(value.clone());
        self.structures.insert(value, id);
        Ok(id)
    }
    pub fn list(&mut self, values: Vec<Atom>) -> Result<Atom> {
        self.structured(Structured::List(values.into()))
            .map(Atom::Val)
    }
    pub fn object(&mut self, fields: Vec<(&str, Atom)>) -> Result<Atom> {
        let fields = fields
            .into_iter()
            .filter(|(_, value)| *value != Atom::Null)
            .map(|(name, value)| Ok((self.string(name)?, value)))
            .collect::<Result<Vec<_>>>()?;
        self.structured(Structured::Object(fields.into()))
            .map(Atom::Val)
    }
    /// Intern a compiled rule constant.
    pub fn literal(&mut self, literal: &super::compiler::Literal) -> Result<Atom> {
        use super::compiler::Literal;
        Ok(match literal {
            Literal::Null => Atom::Null,
            Literal::Bool(value) => Atom::Bool(*value),
            Literal::Int(value) => Atom::Int(*value),
            Literal::Num(bits) => Atom::Num(*bits),
            Literal::Str(text) => Atom::Str(self.string(text)?),
            Literal::List(values) => {
                let values = values
                    .iter()
                    .map(|value| self.literal(value))
                    .collect::<Result<_>>()?;
                self.list(values)?
            }
            Literal::Object(fields) => {
                let mut interned = Vec::with_capacity(fields.len());
                for (name, value) in fields.iter() {
                    interned.push((self.string(name)?, self.literal(value)?));
                }
                Atom::Val(self.structured(Structured::Object(interned.into()))?)
            }
        })
    }
    pub fn intern(&mut self, value: Value) -> Result<Atom> {
        Ok(match value {
            Value::Null => Atom::Null,
            Value::Bool(value) => Atom::Bool(value),
            Value::Number(Number::Int(value)) => Atom::Int(value),
            Value::Number(Number::Uint(value)) => Atom::Int(value.try_into()?),
            Value::Number(Number::Float(value)) => Atom::Num(value),
            Value::String(value) => Atom::Str(self.string(&value)?),
            Value::Array(values) => {
                let values = values
                    .iter()
                    .cloned()
                    .map(|value| self.intern(value))
                    .collect::<Result<_>>()?;
                self.list(values)?
            }
            Value::Object(values) => {
                let mut fields = Vec::with_capacity(values.0.len());
                for (name, value) in &values.0 {
                    fields.push((self.string(name)?, self.intern(value.clone())?));
                }
                Atom::Val(self.structured(Structured::Object(fields.into()))?)
            }
        })
    }
    pub fn json(&self, atom: Atom) -> serde_json::Value {
        match atom {
            Atom::Null => serde_json::Value::Null,
            Atom::Bool(value) => value.into(),
            Atom::Int(value) => value.into(),
            Atom::Num(value) => serde_json::Number::from_f64(f64::from_bits(value))
                .map_or(serde_json::Value::Null, serde_json::Value::Number),
            Atom::Str(id) => self.text(id).into(),
            Atom::Val(id) => match &self.values[id.0 as usize] {
                Structured::List(values) => {
                    serde_json::Value::Array(values.iter().map(|value| self.json(*value)).collect())
                }
                Structured::Object(fields) => serde_json::Value::Object(
                    fields
                        .iter()
                        .map(|(key, value)| (self.text(*key).to_owned(), self.json(*value)))
                        .collect(),
                ),
                Structured::Scalar(value) => self.json(*value),
                Structured::Occurrence(_) => self.value(atom).json(),
                Structured::OccurrenceLocation(row) => self
                    .occurrences
                    .data
                    .as_ref()
                    .map_or(serde_json::Value::Null, |data| {
                        data.location(*row as usize, self)
                    }),
            },
        }
    }
    pub fn value(&self, atom: Atom) -> Value {
        match atom {
            Atom::Null => Value::Null,
            Atom::Bool(value) => value.into(),
            Atom::Int(value) => value.into(),
            Atom::Num(value) => f64::from_bits(value).into(),
            Atom::Str(value) => self.text_arc(value).into(),
            Atom::Val(id) => match &self.values[id.0 as usize] {
                Structured::List(values) => values
                    .iter()
                    .map(|value| self.value(*value))
                    .collect::<Vec<_>>()
                    .into(),
                Structured::Object(values) => Value::object(Object(
                    values
                        .iter()
                        .map(|(name, value)| (self.text(*name).to_owned(), self.value(*value)))
                        .collect(),
                )),
                Structured::OccurrenceLocation(row) => {
                    let fields = [
                        "objectPath",
                        "kind",
                        "propertyPath",
                        "classPath",
                        "row",
                        "entryKey",
                    ]
                    .into_iter()
                    .filter_map(|name| {
                        let atom = self.occurrence_location_field(*row, name);
                        (atom != Atom::Null).then(|| (name.to_owned(), self.value(atom)))
                    })
                    .collect();
                    Value::object(Object(fields))
                }
                Structured::Occurrence(row) => Value::object(Object(
                    [
                        "id",
                        "packageFile",
                        "source",
                        "devNotes",
                        "location",
                        "unitStatus",
                    ]
                    .into_iter()
                    .map(|name| (name.to_owned(), self.value(self.occurrence(*row, name))))
                    .collect(),
                )),
                Structured::Scalar(value) => self.value(*value),
            },
        }
    }
    /// Rule value equality, without building values: strings compare by text across
    /// dictionaries, lists by element, and objects by key regardless of member order. Integers
    /// and floating-point numbers stay distinct.
    pub fn equal(&self, a: Atom, b: Atom) -> bool {
        if a == b {
            return true;
        }
        match (a, b) {
            (Atom::Str(a), Atom::Str(b)) => self.text(a) == self.text(b),
            (Atom::Val(x), Atom::Val(y)) => {
                match (&self.values[x.0 as usize], &self.values[y.0 as usize]) {
                    (Structured::List(x), Structured::List(y)) => {
                        x.len() == y.len()
                            && x.iter().zip(y.iter()).all(|(x, y)| self.equal(*x, *y))
                    }
                    (Structured::Object(x), Structured::Object(y)) => {
                        x.len() == y.len()
                            && x.iter().all(|(name, value)| {
                                let name = self.text(*name);
                                y.iter()
                                    .find(|(key, _)| self.text(*key) == name)
                                    .is_some_and(|(_, other)| self.equal(*value, *other))
                            })
                    }
                    // Occurrence views and wrapped scalars compare as the values they present.
                    _ => self.value(a) == self.value(b),
                }
            }
            (Atom::Val(_), _) | (_, Atom::Val(_)) => self.value(a) == self.value(b),
            _ => false,
        }
    }
    pub fn elements(&self, atom: Atom) -> Result<Option<&[Atom]>> {
        if atom == Atom::Null {
            return Ok(None);
        }
        if let Atom::Val(id) = atom
            && let Structured::List(values) = &self.values[id.0 as usize]
        {
            return Ok(Some(values));
        }
        Err("Rule operation requires a list.".into())
    }
    pub fn occurrence(&self, row: u32, name: &str) -> Atom {
        self.occurrences
            .fields
            .get(name)
            .map_or(Atom::Null, |column| column.get(row as usize, self))
    }
    pub fn occurrence_id(&mut self, row: u32) -> Result<Atom> {
        self.row_value(row, false)
    }
    pub fn occurrence_location(&mut self, row: u32) -> Result<Atom> {
        self.row_value(row, true)
    }
    fn row_value(&mut self, row: u32, location: bool) -> Result<Atom> {
        let index = if location {
            &self.location_values
        } else {
            &self.occurrence_values
        };
        if let Some(id) = index.get(row as usize).filter(|id| **id != u32::MAX) {
            return Ok(Atom::Val(ValId(*id)));
        }
        let id = u32::try_from(self.values.len())?;
        self.values.push(if location {
            Structured::OccurrenceLocation(row)
        } else {
            Structured::Occurrence(row)
        });
        let index = if location {
            &mut self.location_values
        } else {
            &mut self.occurrence_values
        };
        if index.len() <= row as usize {
            index.resize(row as usize + 1, u32::MAX);
        }
        index[row as usize] = id;
        Ok(Atom::Val(ValId(id)))
    }
    pub fn get_path(&self, mut value: Atom, path: &str) -> Atom {
        for name in path.split('.') {
            value = match value {
                Atom::Val(id) => match &self.values[id.0 as usize] {
                    Structured::Object(fields) => fields
                        .iter()
                        .find(|(key, _)| self.text(*key) == name)
                        .map_or(Atom::Null, |(_, value)| *value),
                    Structured::List(values) => name
                        .parse::<usize>()
                        .ok()
                        .and_then(|index| values.get(index))
                        .copied()
                        .unwrap_or_default(),
                    Structured::Occurrence(row) => self.occurrence(*row, name),
                    Structured::OccurrenceLocation(row) => {
                        self.occurrence_location_field(*row, name)
                    }
                    Structured::Scalar(_) => Atom::Null,
                },
                _ => Atom::Null,
            };
        }
        value
    }
}
#[derive(Clone, Default)]
pub struct Children {
    pub offsets: Arc<Vec<u32>>,
    pub members: Arc<Vec<u32>>,
    pub rows: Option<Arc<[u32]>>,
}
impl Children {
    pub fn members(&self, row: usize) -> &[u32] {
        let row = self.rows.as_ref().map_or(row, |rows| rows[row] as usize);
        &self.members[self.offsets[row] as usize..self.offsets[row + 1] as usize]
    }
}
#[derive(Default)]
pub struct Prepared {
    pub fields: HashMap<String, FieldColumn>,
    pub children: Children,
}
impl Prepared {
    pub fn field(&self, name: &str) -> Result<&FieldColumn> {
        self.fields
            .get(name)
            .ok_or_else(|| format!("Missing subject column {name}.").into())
    }
    pub fn validate(&self, len: usize) -> Result<()> {
        for field in self.fields.values() {
            require(
                field
                    .rows
                    .as_ref()
                    .map_or(field.column.len(), |rows| rows.len())
                    == len,
                "Subject column has an invalid row count.",
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::value::value;
    use super::*;

    #[test]
    fn deposit_places_each_compact_bit_at_the_next_selected_position() {
        // Selections mixing empty, sparse, dense and full words, against compact patterns that
        // exercise empty, full and partial chunks across word boundaries.
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for round in 0..64 {
            let len = 64 * 9 + round;
            let mut selection = Bits::new(len);
            for row in 0..len {
                let word = row / 64;
                let keep = match word % 4 {
                    0 => false,
                    1 => next() % 7 == 0,
                    2 => next() % 2 == 0,
                    _ => true,
                };
                if keep {
                    selection.set(row);
                }
            }
            let mut compact = Bits::new(selection.count());
            for row in 0..compact.len {
                if match round % 3 {
                    0 => next() % 2 == 0,
                    1 => true,
                    _ => next() % 9 == 0,
                } {
                    compact.set(row);
                }
            }
            let mut expected = Bits::new(len);
            for (source, row) in selection.ones().enumerate() {
                if compact.get(source) {
                    expected.set(row as usize);
                }
            }
            assert_eq!(
                selection.deposit(&compact).words,
                expected.words,
                "round {round}"
            );
        }
    }

    #[test]
    fn mask_selection_and_scatter_match_the_row_list_paths() -> Result<()> {
        // Every data type, sparse and full masks, nulls and failures, scalar-wrapped values and
        // parent rows: the mask paths must give the row-list paths' exact representation and
        // create no value ids of their own.
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut arena = Arena::new(0)?;
        let list = arena.structured(Structured::List(Arc::from([Atom::Int(1)])))?;
        let wrapped = [
            arena.structured(Structured::Scalar(Atom::Str(StrId(3))))?,
            arena.structured(Structured::Scalar(Atom::Val(list)))?,
            arena.structured(Structured::Scalar(Atom::Null))?,
        ];
        for round in 0..96 {
            let len = 64 * 40 + round * 7;
            let bits = |density: u64, next: &mut dyn FnMut() -> u64| {
                let mut bits = Bits::new(len);
                for row in 0..len {
                    let keep = match (row / 64) % 4 {
                        0 => false,
                        3 => true,
                        _ => density > 0 && next().is_multiple_of(density),
                    };
                    if keep {
                        bits.set(row);
                    }
                }
                bits
            };
            let mask = bits(2 + round as u64 % 5, &mut next);
            let nulls = if round % 3 == 0 {
                Bits::new(len)
            } else {
                bits(5, &mut next)
            };
            let failed = if round % 4 == 0 {
                bits(11, &mut next)
            } else {
                Bits::new(len)
            };
            let data = match round % 7 {
                0 => Data::Bool(bits(2, &mut next)),
                1 => Data::Int((0..len).map(|_| (next() % 9) as i64).collect()),
                2 => Data::Num((0..len).map(|_| (next() % 9) as f64 / 2.0).collect()),
                3 => Data::Str((0..len).map(|_| StrId((next() % 9) as u32)).collect()),
                4 => Data::Val(
                    (0..len)
                        .map(|_| match next() % 4 {
                            3 => list,
                            pick => wrapped[pick as usize],
                        })
                        .collect(),
                ),
                5 => Data::Constant(Atom::Str(StrId(4))),
                _ => Data::Constant(Atom::Null),
            };
            let column = Column {
                data,
                nulls,
                failed,
            };
            let rows = mask.ones().map(|row| row as usize).collect::<Vec<_>>();
            let shown = |column: &Column| format!("{column:?}");
            assert_eq!(
                shown(&column.select_mask(&mask, None)),
                shown(&column.select(&rows, &mut arena)?),
                "select, round {round}"
            );
            let parents = (0..len)
                .map(|_| (next() % len as u64) as u32)
                .collect::<Vec<_>>();
            let through = rows
                .iter()
                .map(|row| parents[*row] as usize)
                .collect::<Vec<_>>();
            assert_eq!(
                shown(&column.select_mask(&mask, Some(&parents))),
                shown(&column.select(&through, &mut arena)?),
                "select through parents, round {round}"
            );
            // Fill a cache column twice, the second time over rows the first already wrote.
            let source = column.select(&rows, &mut arena)?;
            let second = bits(3, &mut next);
            let second_rows = second.ones().map(|row| row as usize).collect::<Vec<_>>();
            let again = column.select(&second_rows, &mut arena)?;
            let ids = arena.values.len();
            let mut by_mask = Column::constant(Atom::Null, len);
            by_mask.scatter_mask(&mask, &source, &mut arena)?;
            by_mask.scatter_mask(&second, &again, &mut arena)?;
            let mask_ids = arena.values.len();
            let mut by_rows = Column::constant(Atom::Null, len);
            by_rows.scatter(&mask.ones().collect::<Vec<_>>(), &source, &mut arena)?;
            by_rows.scatter(&second.ones().collect::<Vec<_>>(), &again, &mut arena)?;
            assert_eq!(shown(&by_mask), shown(&by_rows), "scatter, round {round}");
            assert_eq!((mask_ids, arena.values.len()), (ids, ids), "round {round}");
            // `extract` is `deposit`'s inverse.
            let compact = column.nulls.extract(&mask);
            assert_eq!(
                mask.deposit(&compact).words,
                column
                    .nulls
                    .words
                    .iter()
                    .zip(&mask.words)
                    .map(|(a, b)| a & b)
                    .collect::<Vec<_>>(),
                "extract, round {round}"
            );
        }
        // Folding matches `from_atoms` for uniform, mixed and null values of each plain type.
        for atoms in [
            vec![Atom::Bool(true); 70],
            vec![Atom::Bool(false), Atom::Bool(true)],
            vec![Atom::Int(4); 3],
            vec![Atom::Int(4), Atom::Null],
            vec![Atom::Num(2.5f64.to_bits()); 2],
            vec![Atom::Str(StrId(2)); 5],
            vec![Atom::Str(StrId(2)), Atom::Str(StrId(3))],
            vec![Atom::Null; 4],
            vec![],
        ] {
            let mut typed = Column::constant(Atom::Null, atoms.len());
            let mut source = Column::from_atoms(&atoms, &mut arena)?;
            if let Data::Constant(value) = source.data
                && value != Atom::Null
            {
                // A typed column of one repeated value, as a scatter builds it.
                let mut parts = atoms.clone();
                parts.push(Atom::Null);
                source = Column::from_atoms(&parts, &mut arena)?
                    .select(&(0..atoms.len()).collect::<Vec<_>>(), &mut arena)?;
            }
            typed.scatter_mask(&Bits::all(atoms.len()), &source, &mut arena)?;
            assert_eq!(
                format!("{:?}", typed.folded()),
                format!("{:?}", Column::from_atoms(&atoms, &mut arena)?),
                "{atoms:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn dictionary_ids_follow_store_ids_and_preserve_wtf8_units() -> Result<()> {
        let mut arena = Arena::new(17)?;
        let lead = Wtf8Buf::from_utf16(&[0xd801]).into_view();
        let trail = Wtf8Buf::from_utf16(&[0xdc00]).into_view();
        let first = arena.string(&lead)?;
        assert_eq!(first, StrId(17));
        assert_eq!(arena.string(&lead)?, first);
        assert_ne!(arena.string(&trail)?, first);
        let pair = Wtf8Buf::from_utf16(&[0xd801, 0xdc00]).into_view();
        let joined = arena.string(&format!("{lead}{trail}"))?;
        assert_eq!(arena.string(&pair)?, joined);
        assert_eq!(arena.text(joined), pair);
        Ok(())
    }
    #[test]
    fn nullable_columns_and_heterogeneous_elements_keep_typed_values() -> Result<()> {
        let mut arena = Arena::new(0)?;
        let text = Atom::Str(arena.string("text")?);
        for values in [
            vec![Atom::Int(1), Atom::Null, Atom::Int(3)],
            vec![
                Atom::Num((-0.25f64).to_bits()),
                Atom::Null,
                Atom::Num(1f64.to_bits()),
            ],
            vec![Atom::Bool(true), Atom::Null, Atom::Bool(false)],
            vec![text, Atom::Null, text],
            vec![Atom::Bool(true), text, Atom::Int(3)],
        ] {
            let column = Column::from_atoms(&values, &mut arena)?;
            assert_eq!(
                (0..values.len())
                    .map(|row| column.get(row, &arena))
                    .collect::<Vec<_>>(),
                values
            );
        }
        Ok(())
    }
    #[test]
    fn structural_interning_keeps_evidence_member_order() -> Result<()> {
        let mut arena = Arena::new(0)?;
        let first = arena.intern(value!({"first":1,"second":vec!["a","b"]}))?;
        assert_eq!(
            arena.intern(value!({"first":1,"second":vec!["a","b"]}))?,
            first
        );
        let reversed = arena.intern(value!({"second":vec!["a","b"],"first":1}))?;
        assert_ne!(first, reversed);
        assert_eq!(arena.value(first), arena.value(reversed));
        assert_eq!(
            serde_json::to_string(&arena.value(first).json())?,
            r#"{"first":1,"second":["a","b"]}"#
        );
        Ok(())
    }
}
