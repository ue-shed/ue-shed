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
    /// Deposit compact column bits into selection positions, copying dense words at once.
    pub fn deposit(&self, compact: &Self) -> Self {
        let mut result = Self::new(self.len);
        let mut source = 0usize;
        for (destination, selected) in self.words.iter().copied().enumerate() {
            if selected == u64::MAX {
                let offset = source % 64;
                result.words[destination] =
                    compact.words.get(source / 64).copied().unwrap_or(0) >> offset;
                if offset > 0 {
                    result.words[destination] |=
                        compact.words.get(source / 64 + 1).copied().unwrap_or(0) << (64 - offset);
                }
                source += 64;
            } else {
                let mut selected = selected;
                while selected != 0 {
                    let bit = selected.trailing_zeros();
                    selected &= selected - 1;
                    if compact.get(source) {
                        result.words[destination] |= 1 << bit;
                    }
                    source += 1;
                }
            }
        }
        result
    }
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
        let mut nulls = Bits::new(values.len());
        for (row, value) in values.iter().enumerate() {
            if *value == Atom::Null {
                nulls.set(row);
            }
        }
        let first = values
            .iter()
            .copied()
            .find(|value| *value != Atom::Null)
            .unwrap_or_default();
        if values.iter().all(|value| *value == first) {
            return Ok(Self::constant(first, values.len()));
        }
        let same = values.iter().all(|value| {
            *value == Atom::Null || std::mem::discriminant(value) == std::mem::discriminant(&first)
        });
        let data = match first {
            Atom::Bool(_) if same => {
                let mut bits = Bits::new(values.len());
                for (row, value) in values.iter().enumerate() {
                    if value.boolean() {
                        bits.set(row);
                    }
                }
                Data::Bool(bits)
            }
            Atom::Int(_) if same => Data::Int(
                values
                    .iter()
                    .map(|value| {
                        if let Atom::Int(value) = value {
                            *value
                        } else {
                            0
                        }
                    })
                    .collect(),
            ),
            Atom::Num(_) if same => Data::Num(
                values
                    .iter()
                    .map(|value| {
                        if let Atom::Num(value) = value {
                            f64::from_bits(*value)
                        } else {
                            0.0
                        }
                    })
                    .collect(),
            ),
            Atom::Str(_) if same => Data::Str(
                values
                    .iter()
                    .map(|value| {
                        if let Atom::Str(value) = value {
                            *value
                        } else {
                            StrId(0)
                        }
                    })
                    .collect(),
            ),
            Atom::Val(_) if same => Data::Val(
                values
                    .iter()
                    .map(|value| {
                        if let Atom::Val(value) = value {
                            *value
                        } else {
                            ValId(0)
                        }
                    })
                    .collect(),
            ),
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
        let select_bits = |bits: &Bits| {
            let mut selected = Bits::new(rows.len());
            for (index, row) in rows.iter().enumerate() {
                if bits.get(*row) {
                    selected.set(index);
                }
            }
            selected
        };
        let data = match &self.data {
            Data::Constant(value) => Data::Constant(*value),
            Data::Bool(values) => Data::Bool(select_bits(values)),
            Data::Int(values) => Data::Int(rows.iter().map(|row| values[*row]).collect()),
            Data::Num(values) => Data::Num(rows.iter().map(|row| values[*row]).collect()),
            Data::Str(values) => Data::Str(rows.iter().map(|row| values[*row]).collect()),
            Data::Val(values) => Data::Val(rows.iter().map(|row| values[*row]).collect()),
        };
        Ok(Self {
            data,
            nulls: select_bits(&self.nulls),
            failed: select_bits(&self.failed),
        })
    }
    pub fn scatter(&mut self, rows: &[u32], source: &Self, arena: &mut Arena) -> Result<()> {
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
    pub(super) places: Vec<Option<Arc<serde_json::Value>>>,
    pub(super) location_kinds: [Atom; 3],
    pub fields: HashMap<String, Arc<Column>>,
    pub len: usize,
    pub raw_rows: Vec<u32>,
}
pub struct Arena {
    store_count: u32,
    stored: HashMap<StrId, Arc<str>>,
    side: Vec<Arc<str>>,
    strings: FxHashMap<u64, StrId>,
    string_collisions: FxHashMap<u64, Vec<StrId>>,
    pub values: Vec<Structured>,
    structures: HashMap<Structured, ValId>,
    pub occurrences: Occurrences,
    pub line_children: Option<Arc<Children>>,
    pub line_fields: HashMap<String, Arc<Column>>,
    pub occurrence_fields: HashSet<String>,
    pub(crate) recorder: super::stages::Recorder,
    pub(crate) roles_mask: Arc<Mutex<HashMap<StrId, Arc<Bits>>>>,
    pub(crate) paths_mask: Arc<Mutex<HashMap<StrId, Arc<Bits>>>>,
}
fn json_bytes(value: &serde_json::Value) -> usize {
    use serde_json::Value;
    match value {
        Value::String(text) => text.capacity(),
        Value::Array(values) => {
            values.capacity() * std::mem::size_of::<Value>()
                + values.iter().map(json_bytes).sum::<usize>()
        }
        Value::Object(fields) => {
            fields.len() * (std::mem::size_of::<(String, Value)>() + 1)
                + fields
                    .iter()
                    .map(|(key, value)| key.capacity() + json_bytes(value))
                    .sum::<usize>()
        }
        _ => 0,
    }
}
impl Arena {
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
            + self.occurrences.places.capacity() * size_of::<Option<Arc<serde_json::Value>>>()
            + self
                .occurrences
                .places
                .iter()
                .flatten()
                .map(|place| json_bytes(place))
                .sum::<usize>()
            + self.line_children.as_ref().map_or(0, |children| {
                children.offsets.capacity() * 4 + children.members.capacity() * 4
            });
        super::stages::Memory {
            arena_bytes: self.values.capacity() * size_of::<Structured>()
                + structures
                + self.structures.capacity() * (size_of::<Structured>() + size_of::<ValId>() + 1)
                + self.stored.capacity() * (size_of::<StrId>() + size_of::<Arc<str>>() + 1)
                + self.stored.values().map(|text| text.len()).sum::<usize>(),
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
            stored: HashMap::new(),
            side: Vec::new(),
            strings: FxHashMap::default(),
            string_collisions: FxHashMap::default(),
            values: Vec::new(),
            structures: HashMap::new(),
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
        let mut seen = HashSet::new();
        let mut wanted = ids
            .iter()
            .copied()
            .filter(|id| {
                *id < self.store_count && !self.stored.contains_key(&StrId(*id)) && seen.insert(*id)
            })
            .collect::<Vec<_>>();
        wanted.sort_unstable();
        for (id, text) in wanted.iter().copied().zip(reader.strings_batch(&wanted)?) {
            let mut hash = FxHasher::default();
            hash.write(Wtf8Buf::from_view(&text).as_bytes());
            if let Some(first) = self.strings.get(&hash.finish()).copied() {
                if self.text(first) != text {
                    self.string_collisions
                        .entry(hash.finish())
                        .or_default()
                        .push(StrId(id));
                }
            } else {
                self.strings.insert(hash.finish(), StrId(id));
            }
            self.stored.insert(StrId(id), Arc::from(text));
        }
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
            self.stored.get(&id).map_or("", AsRef::as_ref)
        }
    }
    fn text_arc(&self, id: StrId) -> Arc<str> {
        if id.0 >= self.store_count {
            Arc::clone(&self.side[(id.0 - self.store_count) as usize])
        } else {
            self.stored.get(&id).cloned().unwrap_or_default()
        }
    }
    pub fn string(&mut self, text: &str) -> Result<StrId> {
        let bytes = Wtf8Buf::from_view(text).into_bytes();
        let mut hash = FxHasher::default();
        hash.write(&bytes);
        let hash = hash.finish();
        let canonical = if text.as_bytes().contains(&0xf3) {
            std::borrow::Cow::Owned(Wtf8Buf::from_bytes(bytes.clone())?.into_view())
        } else {
            std::borrow::Cow::Borrowed(text)
        };
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
        self.side
            .push(Arc::from(Wtf8Buf::from_bytes(bytes.clone())?.into_view()));
        if let std::collections::hash_map::Entry::Vacant(entry) = self.strings.entry(hash) {
            entry.insert(id);
        } else {
            self.string_collisions.entry(hash).or_default().push(id);
        }
        Ok(id)
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
        self.structured(Structured::Occurrence(row)).map(Atom::Val)
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
