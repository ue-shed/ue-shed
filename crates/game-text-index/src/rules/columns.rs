//! Nullable typed columns and evaluation-local dictionaries/structured values.
use super::value::{Number, Object, Value};
use crate::engine_reader::EngineReader;
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

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
    pub fn select(&self, rows: &[usize], arena: &mut Arena) -> Result<Self> {
        let values = rows
            .iter()
            .map(|row| self.get(*row, arena))
            .collect::<Vec<_>>();
        let mut column = Self::from_atoms(&values, arena)?;
        for (index, row) in rows.iter().enumerate() {
            if self.failed.get(*row) {
                column.failed.set(index);
            }
        }
        Ok(column)
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
    Scalar(Atom),
}
#[derive(Default)]
pub struct Occurrences {
    pub fields: HashMap<String, Arc<Column>>,
    pub len: usize,
}
pub struct Arena {
    store_count: u32,
    stored: HashMap<StrId, Arc<str>>,
    side: Vec<Arc<str>>,
    strings: HashMap<Vec<u8>, StrId>,
    pub values: Vec<Structured>,
    structures: HashMap<Structured, ValId>,
    pub occurrences: Occurrences,
}
impl Arena {
    pub fn new(store_count: usize) -> Result<Self> {
        Ok(Self {
            store_count: store_count.try_into()?,
            stored: HashMap::new(),
            side: Vec::new(),
            strings: HashMap::new(),
            values: Vec::new(),
            structures: HashMap::new(),
            occurrences: Occurrences::default(),
        })
    }
    pub fn load_strings(&mut self, reader: &mut EngineReader, ids: &[u32]) -> Result<()> {
        let mut seen = HashSet::new();
        let mut wanted = ids
            .iter()
            .copied()
            .filter(|id| !self.stored.contains_key(&StrId(*id)) && seen.insert(*id))
            .collect::<Vec<_>>();
        wanted.sort_unstable();
        for (id, text) in wanted.iter().copied().zip(reader.strings_batch(&wanted)?) {
            self.strings
                .entry(Wtf8Buf::from_view(&text).into_bytes())
                .or_insert(StrId(id));
            self.stored.insert(StrId(id), Arc::from(text));
        }
        Ok(())
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
        if let Some(id) = self.strings.get(&bytes) {
            return Ok(*id);
        }
        let id = StrId(
            self.store_count
                .checked_add(u32::try_from(self.side.len())?)
                .ok_or("Evaluation string dictionary is full.")?,
        );
        self.side
            .push(Arc::from(Wtf8Buf::from_bytes(bytes.clone())?.into_view()));
        self.strings.insert(bytes, id);
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
                    Structured::Scalar(_) => Atom::Null,
                },
                _ => Atom::Null,
            };
        }
        value
    }
}
#[derive(Default)]
pub struct Children {
    pub offsets: Vec<u32>,
    pub members: Vec<u32>,
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
    pub timings: Vec<(String, std::time::Duration)>,
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
