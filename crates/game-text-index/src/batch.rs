//! Column batches: how the engine streams rows to the host.
//!
//! A batch body is a `u32` header length, the JSON header, zero padding to 8 bytes, then the
//! buffers at the offsets the header gives, each 8-aligned and counted from the end of the
//! padding. Each batch has its own string table: `u32` offsets over WTF-8 bytes, a string used
//! twice stored once, and a bitset of the entries that hold lone surrogates.
//!
//! Each relation declares its columns once, here; the contract generates them into TypeScript. A
//! request's rows carry the columns it names, in its order, which is also the order of each row
//! object's keys on the host. A list that can grow without bound is a relation of its own, sent as
//! its own part: its rows name their parent's row, and they are sent before the parent's batch.
use crate::engine::Reply;
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result, require};
use serde::Serialize;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
#[cfg(test)]
use ts_rs::TS;

/// Rows a batch holds at most.
pub const BATCH_ROWS: usize = 4096;
/// Buffer bytes after which a batch is sent.
pub const BATCH_BYTES: usize = 4 << 20;

/// A column's type on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum ColumnType {
    U32,
    I32,
    F64,
    /// A bitset.
    Bool,
    /// A `u32` index into the batch's string table.
    Str,
    /// A string-table index whose entry is JSON text: an open-ended or nested value the host
    /// reads per row, such as a finding's evidence or a place's location.
    Json,
    /// `u32` offsets, one per row and one more, over `u32` values.
    U32List,
    /// `u32` offsets, one per row and one more, over string-table indices.
    StrList,
}

/// What a row without a value holds on the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum Missing {
    /// Every row has a value.
    Never,
    /// The row object holds `null`.
    Null,
    /// The row object has no such key.
    Omit,
}

#[derive(Debug)]
pub struct Column {
    pub name: &'static str,
    pub kind: ColumnType,
    pub missing: Missing,
}
const fn column(name: &'static str, kind: ColumnType, missing: Missing) -> Column {
    Column {
        name,
        kind,
        missing,
    }
}

#[derive(Debug)]
pub struct Relation {
    pub name: &'static str,
    pub columns: &'static [Column],
}
impl Relation {
    pub fn column(&self, name: &str) -> Option<&'static Column> {
        self.columns.iter().find(|column| column.name == name)
    }
    /// The columns named, in the order named.
    pub fn select(&'static self, names: &[&str]) -> Result<Vec<&'static Column>> {
        names
            .iter()
            .map(|name| {
                self.columns
                    .iter()
                    .find(|column| column.name == *name)
                    .ok_or_else(|| {
                        crate::engine_types::invalid(&format!(
                            "The {} relation has no column {name}.",
                            self.name
                        ))
                    })
            })
            .collect()
    }
    /// Every column, in declared order.
    pub fn all(&'static self) -> Vec<&'static Column> {
        self.columns.iter().collect()
    }
    /// Every column but `parent`: rows that belong to no other row.
    pub fn without_parent(&'static self) -> Vec<&'static Column> {
        self.columns
            .iter()
            .filter(|column| column.name != "parent")
            .collect()
    }
}

use ColumnType::{F64, Json, Str, StrList, U32};
use Missing::{Never, Null, Omit};

/// Grouped counts of lines: each group's key, as text, and its measures.
pub static GROUP: Relation = Relation {
    name: "group",
    columns: &[
        column("key", StrList, Never),
        column("lines", U32, Never),
        column("sourceWords", F64, Omit),
        column("lineBreakWords", F64, Omit),
        column("unknownWords", F64, Omit),
    ],
};

/// A corpus unit: saved text grouped by identity. Its places are the `place` relation.
pub static UNIT: Relation = Relation {
    name: "unit",
    columns: &[
        column("id", Str, Never),
        column("identity", Json, Never),
        column("source", Json, Never),
        column("reviewSignals", StrList, Never),
        column("findings", StrList, Omit),
        column("findingsOmitted", U32, Omit),
    ],
};

/// A saved place: a unit's occurrence, a line's place, or a member of a finding's place set.
/// `parent` is the row of the unit or line it belongs to, or the place set's ID.
pub static PLACE: Relation = Relation {
    name: "place",
    columns: &[
        column("parent", U32, Never),
        column("devNotes", Str, Omit),
        column("id", Str, Never),
        column("packageFile", Str, Never),
        column("objectPath", Str, Never),
        column("origin", Str, Never),
        column("source", Str, Never),
        column("identity", Json, Never),
        column("location", Json, Never),
        column("editCapability", Str, Never),
        column("audience", Str, Omit),
        column("audienceReason", Str, Omit),
        column("audienceRule", Str, Omit),
        column("copies", Json, Omit),
    ],
};

/// A package's coverage.
pub static PACKAGE: Relation = Relation {
    name: "package",
    columns: &[
        column("packageFile", Str, Never),
        column("status", Str, Never),
    ],
};

/// A corpus diagnostic.
pub static DIAGNOSTIC: Relation = Relation {
    name: "diagnostic",
    columns: &[
        column("code", Str, Never),
        column("message", Str, Never),
        column("packageFile", Str, Never),
        column("objectPath", Str, Omit),
        column("propertyPath", Str, Omit),
        column("coverageGapCounts", Json, Omit),
    ],
};

/// A localization line and the fields a line read names. Its places are the `place` relation.
pub static LINE: Relation = Relation {
    name: "line",
    columns: &[
        column("id", Str, Never),
        column("origin", Json, Never),
        column("identity", Json, Null),
        column("source", Str, Never),
        column("manifest", Json, Never),
        column("cultures", Json, Never),
        column("keyChange", Json, Omit),
        column("audience", Str, Omit),
        column("outOfScope", Str, Omit),
        column("marks", Json, Never),
        column("problems", StrList, Never),
        column("signals", StrList, Never),
    ],
};

/// A unit as a query lists it. An open group's rows name the group's position as `parent`.
pub static BROWSE_UNIT: Relation = Relation {
    name: "browseUnit",
    columns: &[
        column("parent", U32, Omit),
        column("id", Str, Never),
        column("identity", Json, Never),
        column("source", Json, Never),
        column("contexts", Json, Never),
        column("occurrenceCount", U32, Never),
        column("remainingContextCount", U32, Never),
        column("characterCount", U32, Never),
        column("wordCount", U32, Never),
        column("reviewSignals", StrList, Never),
        column("locationKinds", StrList, Never),
        column("audience", Str, Never),
        column("localization", Json, Omit),
        column("problems", StrList, Never),
        column("findings", StrList, Omit),
        column("findingsOmitted", U32, Omit),
    ],
};

/// A line as a query lists it. An open group's rows name the group's position as `parent`.
pub static BROWSE_LINE: Relation = Relation {
    name: "browseLine",
    columns: &[
        column("parent", U32, Omit),
        column("id", Str, Never),
        column("source", Str, Never),
        column("identity", Json, Never),
        column("audience", Str, Never),
        column("manifestLocations", StrList, Never),
        column("remainingLocationCount", U32, Never),
        column("origin", Json, Never),
        column("cultures", Json, Never),
        column("outOfScope", Str, Omit),
        column("keyChange", Json, Omit),
        column("problems", StrList, Never),
        column("findings", StrList, Omit),
        column("findingsOmitted", U32, Omit),
    ],
};

/// A finding in its family's host shape; `places` in it names a place set.
pub static FINDING: Relation = Relation {
    name: "finding",
    columns: &[column("finding", Json, Never)],
};

/// Every relation, in the order the contract lists them.
pub static RELATIONS: [&Relation; 9] = [
    &GROUP,
    &UNIT,
    &PLACE,
    &PACKAGE,
    &DIAGNOSTIC,
    &LINE,
    &FINDING,
    &BROWSE_UNIT,
    &BROWSE_LINE,
];

/// A batch's header, the JSON after its length.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct BatchHeader {
    /// The part of the answer the batch belongs to.
    pub part: &'static str,
    /// The relation its columns describe.
    pub relation: &'static str,
    pub rows: u32,
    pub columns: Vec<ColumnHeader>,
    pub strings: StringsHeader,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ColumnHeader {
    pub name: &'static str,
    #[serde(rename = "type")]
    pub kind: ColumnType,
    /// The values, or a list column's offsets.
    pub offset: u32,
    /// A list column's values.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub values: Option<u32>,
    /// A bitset of the rows that have a value; absent when every row has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub validity: Option<u32>,
    /// What a row without a value holds.
    pub missing: Missing,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct StringsHeader {
    pub entries: u32,
    /// `u32` offsets, one per entry and one more, into `bytes`.
    pub offsets: u32,
    pub bytes: u32,
    /// A bitset of the entries holding lone surrogates; absent when none does.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub lone_surrogates: Option<u32>,
}

/// One batch's string table.
#[derive(Default)]
struct Strings {
    index: HashMap<Vec<u8>, u32>,
    offsets: Vec<u32>,
    bytes: Vec<u8>,
    lone: Vec<u32>,
}
impl Strings {
    fn intern(&mut self, bytes: Cow<'_, [u8]>) -> Result<u32> {
        if let Some(index) = self.index.get(bytes.as_ref()) {
            return Ok(*index);
        }
        let index = u32::try_from(self.index.len()).map_err(|_| "Too many batch strings.")?;
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        self.bytes.extend_from_slice(&bytes);
        self.offsets
            .push(u32::try_from(self.bytes.len()).map_err(|_| "A batch's strings exceed 4 GiB.")?);
        // WTF-8 spells a lone surrogate 0xED 0xA0..=0xBF; valid UTF-8 never does.
        if bytes
            .windows(2)
            .any(|pair| pair[0] == 0xed && pair[1] >= 0xa0)
        {
            self.lone.push(index);
        }
        self.index.insert(bytes.into_owned(), index);
        Ok(index)
    }
    /// A string value: a reversible view, stored as its WTF-8 bytes.
    fn view(&mut self, view: &str) -> Result<u32> {
        if view.as_bytes().contains(&0xf3) {
            self.intern(Cow::Owned(Wtf8Buf::from_view(view).into_bytes()))
        } else {
            self.intern(Cow::Borrowed(view.as_bytes()))
        }
    }
    fn size(&self) -> usize {
        self.bytes.len() + 4 * self.offsets.len() + self.lone.len() * 4
    }
}

enum Values {
    /// Little-endian `u32`, `i32` or `f64` values, or string-table indices.
    Fixed(Vec<u8>),
    Bits(Vec<u8>),
    Lists {
        offsets: Vec<u32>,
        values: Vec<u32>,
    },
}
impl Values {
    fn size(&self) -> usize {
        match self {
            Self::Fixed(bytes) | Self::Bits(bytes) => bytes.len(),
            Self::Lists { offsets, values } => 4 * (offsets.len() + values.len()),
        }
    }
}

struct Cells {
    column: &'static Column,
    values: Values,
    /// Allocated at the first row without a value.
    validity: Option<Vec<u8>>,
}

fn set_bit(bits: &mut Vec<u8>, index: usize, value: bool) {
    if bits.len() <= index / 8 {
        bits.resize(index / 8 + 1, 0);
    }
    if value {
        bits[index / 8] |= 1 << (index % 8);
    }
}

fn wrong(column: &Column, expected: &str) -> Error {
    Error::new(
        ErrorCode::Internal,
        format!("Batch column {} expects {expected}.", column.name),
    )
}

fn list_offset(values: &[u32]) -> Result<u32> {
    Ok(u32::try_from(values.len()).map_err(|_| "A list column overflowed.")?)
}

impl Cells {
    fn new(column: &'static Column) -> Self {
        let values = match column.kind {
            ColumnType::Bool => Values::Bits(Vec::new()),
            ColumnType::U32List | StrList => Values::Lists {
                offsets: vec![0],
                values: Vec::new(),
            },
            _ => Values::Fixed(Vec::new()),
        };
        Self {
            column,
            values,
            validity: None,
        }
    }
    fn mark(&mut self, row: usize, present: bool) {
        match &mut self.validity {
            Some(bits) => set_bit(bits, row, present),
            None if !present => {
                let mut bits = Vec::new();
                for earlier in 0..row {
                    set_bit(&mut bits, earlier, true);
                }
                set_bit(&mut bits, row, false);
                self.validity = Some(bits);
            }
            None => {}
        }
    }
    fn push(&mut self, strings: &mut Strings, row: usize, value: Option<&Value>) -> Result<()> {
        let column = self.column;
        let value = match value {
            Some(Value::Null) if column.kind != Json || column.missing != Never => None,
            value => value,
        };
        let Some(value) = value else {
            require(
                column.missing != Never,
                Error::new(
                    ErrorCode::Internal,
                    format!("A batch row has no {}.", column.name),
                ),
            )?;
            self.mark(row, false);
            return self.push_empty(row);
        };
        self.mark(row, true);
        match (&mut self.values, column.kind) {
            (Values::Fixed(bytes), ColumnType::U32) => {
                let value = value
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or_else(|| wrong(column, "a u32"))?;
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            (Values::Fixed(bytes), ColumnType::I32) => {
                let value = value
                    .as_i64()
                    .and_then(|value| i32::try_from(value).ok())
                    .ok_or_else(|| wrong(column, "an i32"))?;
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            (Values::Fixed(bytes), ColumnType::F64) => {
                let value = value.as_f64().ok_or_else(|| wrong(column, "a number"))?;
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            (Values::Fixed(bytes), ColumnType::Str) => {
                let text = value.as_str().ok_or_else(|| wrong(column, "a string"))?;
                bytes.extend_from_slice(&strings.view(text)?.to_le_bytes());
            }
            (Values::Fixed(bytes), Json) => {
                // JSON text spells lone surrogates as escapes, so it is always UTF-8.
                let text = crate::wtf8::view_json(value)?;
                let index = strings.intern(Cow::Owned(text.into_bytes()))?;
                bytes.extend_from_slice(&index.to_le_bytes());
            }
            (Values::Bits(bits), ColumnType::Bool) => {
                let value = value.as_bool().ok_or_else(|| wrong(column, "a boolean"))?;
                set_bit(bits, row, value);
            }
            (Values::Lists { offsets, values }, kind) => {
                let items = value.as_array().ok_or_else(|| wrong(column, "a list"))?;
                for item in items {
                    values.push(if kind == StrList {
                        strings.view(item.as_str().ok_or_else(|| wrong(column, "strings"))?)?
                    } else {
                        item.as_u64()
                            .and_then(|value| u32::try_from(value).ok())
                            .ok_or_else(|| wrong(column, "u32 values"))?
                    });
                }
                offsets.push(list_offset(values)?);
            }
            _ => return Err("A batch column's values don't match its type.".into()),
        }
        Ok(())
    }
    fn push_u32(&mut self, row: usize, value: u32) {
        self.mark(row, true);
        if let Values::Fixed(bytes) = &mut self.values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    fn push_empty(&mut self, row: usize) -> Result<()> {
        match &mut self.values {
            Values::Fixed(bytes) => {
                let width = if self.column.kind == F64 { 8 } else { 4 };
                bytes.resize(bytes.len() + width, 0);
            }
            Values::Bits(bits) => set_bit(bits, row, false),
            Values::Lists { offsets, values } => offsets.push(list_offset(values)?),
        }
        Ok(())
    }
    fn size(&self) -> usize {
        self.values.size() + self.validity.as_ref().map_or(0, Vec::len)
    }
}

/// Buffers laid out for one body, each 8-aligned.
#[derive(Default)]
struct Layout(Vec<u8>);
impl Layout {
    fn place(&mut self, bytes: &[u8]) -> Result<u32> {
        self.0.resize(self.0.len().next_multiple_of(8), 0);
        let offset = u32::try_from(self.0.len()).map_err(|_| "A batch exceeds 4 GiB.")?;
        self.0.extend_from_slice(bytes);
        Ok(offset)
    }
    fn place_u32(&mut self, values: &[u32]) -> Result<u32> {
        self.0.resize(self.0.len().next_multiple_of(8), 0);
        let offset = u32::try_from(self.0.len()).map_err(|_| "A batch exceeds 4 GiB.")?;
        self.0.reserve(4 * values.len());
        for value in values {
            self.0.extend_from_slice(&value.to_le_bytes());
        }
        Ok(offset)
    }
    /// A bitset over `rows`, every byte of it present.
    fn place_bits(&mut self, bits: &[u8], rows: usize) -> Result<u32> {
        let offset = self.place(bits)?;
        self.0
            .resize(offset as usize + rows.div_ceil(8).max(bits.len()), 0);
        Ok(offset)
    }
}

/// Rows of one relation for one part of an answer, sent in batches.
pub struct Batches {
    relation: &'static Relation,
    part: &'static str,
    cells: Vec<Cells>,
    strings: Strings,
    rows: usize,
    sent: u32,
}
impl Batches {
    pub fn new(
        relation: &'static Relation,
        part: &'static str,
        columns: Vec<&'static Column>,
    ) -> Self {
        Self {
            relation,
            part,
            cells: columns.into_iter().map(Cells::new).collect(),
            strings: Strings::default(),
            rows: 0,
            sent: 0,
        }
    }
    /// The row number the next row gets in this part: what its children name as their parent.
    pub fn next_row(&self) -> u32 {
        self.sent + self.rows as u32
    }
    /// Adds a row from an object's fields, by column name.
    pub fn push(&mut self, row: &Value) -> Result<()> {
        self.push_with_parent(None, row)
    }
    /// Adds a row whose `parent` column is `parent`, its other columns from an object's fields.
    pub fn push_child(&mut self, parent: u32, row: &Value) -> Result<()> {
        self.push_with_parent(Some(parent), row)
    }
    fn push_with_parent(&mut self, parent: Option<u32>, row: &Value) -> Result<()> {
        let index = self.rows;
        for cells in &mut self.cells {
            match parent {
                Some(parent) if cells.column.name == "parent" => cells.push_u32(index, parent),
                _ => cells.push(&mut self.strings, index, row.get(cells.column.name))?,
            }
        }
        self.rows += 1;
        Ok(())
    }
    /// Whether the batch should be sent before another row is added.
    pub fn full(&self) -> bool {
        self.rows >= BATCH_ROWS
            || self.strings.size() + self.cells.iter().map(Cells::size).sum::<usize>()
                >= BATCH_BYTES
    }
    /// Sends the rows added since the last batch, if any.
    pub fn flush(&mut self, reply: &mut dyn Reply) -> Result<()> {
        if self.rows == 0 {
            return Ok(());
        }
        let body = self.encode()?;
        require(
            body.len() <= crate::session::MAX_BODY,
            Error::new(
                ErrorCode::LimitExceeded,
                format!(
                    "A {} row is too large for one frame; read it with a narrower request.",
                    self.relation.name
                ),
            ),
        )?;
        self.sent += self.rows as u32;
        self.rows = 0;
        self.strings = Strings::default();
        for cells in &mut self.cells {
            *cells = Cells::new(cells.column);
        }
        reply.batch(body)
    }
    /// Sends the last batch and returns the part's row count.
    pub fn finish(mut self, reply: &mut dyn Reply) -> Result<u32> {
        self.flush(reply)?;
        Ok(self.sent)
    }
    fn encode(&self) -> Result<Vec<u8>> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("batchEncode");
        let rows = self.rows;
        let mut layout = Layout::default();
        let mut columns = Vec::with_capacity(self.cells.len());
        for cells in &self.cells {
            let (offset, values) = match &cells.values {
                Values::Fixed(bytes) => (layout.place(bytes)?, None),
                Values::Bits(bits) => (layout.place_bits(bits, rows)?, None),
                Values::Lists { offsets, values } => {
                    (layout.place_u32(offsets)?, Some(layout.place_u32(values)?))
                }
            };
            let validity = match &cells.validity {
                Some(bits) => Some(layout.place_bits(bits, rows)?),
                None => None,
            };
            columns.push(ColumnHeader {
                name: cells.column.name,
                kind: cells.column.kind,
                offset,
                values,
                validity,
                missing: cells.column.missing,
            });
        }
        let entries = self.strings.index.len();
        let offsets = if entries == 0 {
            layout.place_u32(&[0])?
        } else {
            layout.place_u32(&self.strings.offsets)?
        };
        let bytes = layout.place(&self.strings.bytes)?;
        let lone_surrogates = if self.strings.lone.is_empty() {
            None
        } else {
            let mut bits = Vec::new();
            for entry in &self.strings.lone {
                set_bit(&mut bits, *entry as usize, true);
            }
            Some(layout.place_bits(&bits, entries)?)
        };
        let header = serde_json::to_vec(&BatchHeader {
            part: self.part,
            relation: self.relation.name,
            rows: rows as u32,
            columns,
            strings: StringsHeader {
                entries: entries as u32,
                offsets,
                bytes,
                lone_surrogates,
            },
        })?;
        let start = (4 + header.len()).next_multiple_of(8);
        let mut body = Vec::with_capacity(start + layout.0.len());
        body.extend_from_slice(&(header.len() as u32).to_le_bytes());
        body.extend_from_slice(&header);
        body.resize(start, 0);
        body.extend_from_slice(&layout.0);
        Ok(body)
    }
}

/// The TypeScript the contract generates for the relations: each column's type and what a row
/// without a value holds.
pub fn relations_typescript() -> Result<String> {
    let mut text = String::from(
        "/** Each relation's columns: their wire type, and what a row without a value holds. */\n\
         export type Relations = {\n",
    );
    for relation in RELATIONS {
        text.push_str(&format!("\treadonly {}: {{\n", relation.name));
        for column in relation.columns {
            text.push_str(&format!(
                "\t\treadonly {}: {{ readonly type: {}; readonly missing: {} }};\n",
                column.name,
                serde_json::to_string(&column.kind)?,
                serde_json::to_string(&column.missing)?
            ));
        }
        text.push_str("\t};\n");
    }
    text.push_str("};\n");
    Ok(text)
}

/// A batch's part and its rows as objects, as a host reads them; for tests.
#[cfg(test)]
pub(crate) fn read(body: &[u8]) -> Result<(String, Vec<Value>)> {
    let length = u32::from_le_bytes(body[..4].try_into()?) as usize;
    let header: Value = serde_json::from_slice(&body[4..4 + length])?;
    let buffers = &body[(4 + length).next_multiple_of(8)..];
    let number = |value: &Value| -> Result<usize> {
        Ok(value.as_u64().ok_or("A batch header number is missing.")? as usize)
    };
    let u32_at = |offset: usize, index: usize| {
        let at = offset + 4 * index;
        u32::from_le_bytes([
            buffers[at],
            buffers[at + 1],
            buffers[at + 2],
            buffers[at + 3],
        ])
    };
    let bit = |offset: usize, index: usize| buffers[offset + index / 8] & (1 << (index % 8)) != 0;
    let strings = &header["strings"];
    let (offsets, bytes) = (number(&strings["offsets"])?, number(&strings["bytes"])?);
    let string = |index: u32| -> Result<String> {
        let (start, end) = (
            u32_at(offsets, index as usize) as usize,
            u32_at(offsets, index as usize + 1) as usize,
        );
        Ok(Wtf8Buf::from_bytes(buffers[bytes + start..bytes + end].to_vec())?.into_view())
    };
    let columns = header["columns"]
        .as_array()
        .ok_or("A batch has no columns.")?;
    let mut rows = Vec::new();
    for row in 0..number(&header["rows"])? {
        let mut object = serde_json::Map::new();
        for column in columns {
            let name = column["name"].as_str().ok_or("A column has no name.")?;
            let offset = number(&column["offset"])?;
            if let Some(validity) = column.get("validity")
                && !bit(number(validity)?, row)
            {
                if column["missing"] == "null" {
                    object.insert(name.into(), Value::Null);
                }
                continue;
            }
            let list = |values: usize, text: bool| -> Result<Value> {
                (u32_at(offset, row)..u32_at(offset, row + 1))
                    .map(|index| {
                        let value = u32_at(values, index as usize);
                        Ok(if text {
                            Value::String(string(value)?)
                        } else {
                            Value::from(value)
                        })
                    })
                    .collect::<Result<Vec<_>>>()
                    .map(Value::Array)
            };
            let value = match column["type"].as_str().ok_or("A column has no type.")? {
                "u32" => Value::from(u32_at(offset, row)),
                "i32" => Value::from(u32_at(offset, row) as i32),
                "f64" => Value::from(f64::from_le_bytes(
                    buffers[offset + 8 * row..offset + 8 * row + 8].try_into()?,
                )),
                "bool" => Value::Bool(bit(offset, row)),
                "str" => Value::String(string(u32_at(offset, row))?),
                "json" => crate::json_value::parse(&string(u32_at(offset, row))?)?,
                "u32List" => list(number(&column["values"])?, false)?,
                "strList" => list(number(&column["values"])?, true)?,
                kind => return Err(format!("Unknown column type {kind}.").into()),
            };
            object.insert(name.into(), value);
        }
        rows.push(Value::Object(object));
    }
    Ok((
        header["part"]
            .as_str()
            .ok_or("A batch has no part.")?
            .into(),
        rows,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Default)]
    struct Sent(Vec<Vec<u8>>);
    impl Reply for Sent {
        fn part(&mut self, _: Vec<u8>) -> Result<()> {
            Ok(())
        }
        fn batch(&mut self, body: Vec<u8>) -> Result<()> {
            self.0.push(body);
            Ok(())
        }
    }

    fn header(body: &[u8]) -> Result<(Value, usize)> {
        let length = u32::from_le_bytes(body[..4].try_into()?) as usize;
        let header: Value = serde_json::from_slice(&body[4..4 + length])?;
        Ok((header, (4 + length).next_multiple_of(8)))
    }
    fn u32_at(body: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([body[at], body[at + 1], body[at + 2], body[at + 3]])
    }
    fn at(start: usize, value: &Value) -> Result<usize> {
        Ok(start + value.as_u64().ok_or("offset")? as usize)
    }

    #[test]
    fn a_batch_lays_out_aligned_buffers_and_one_string_table() -> Result<()> {
        let mut sent = Sent::default();
        let lone = Wtf8Buf::from_utf16(&[0x61, 0xd800]).into_view();
        let mut batches = Batches::new(&GROUP, "rows", GROUP.all());
        batches.push(&json!({"key": ["de", lone], "lines": 3, "sourceWords": 2.5}))?;
        batches.push(&json!({"key": ["de"], "lines": 1}))?;
        assert_eq!(batches.finish(&mut sent)?, 2);
        let body = &sent.0[0];
        let (header, start) = header(body)?;
        assert_eq!(start % 8, 0);
        assert_eq!(header["rows"], 2);
        assert_eq!(header["relation"], "group");
        for column in header["columns"].as_array().ok_or("columns")? {
            assert_eq!(column["offset"].as_u64().ok_or("offset")? % 8, 0);
        }
        // "de" is stored once; the lone surrogate is flagged.
        let strings = &header["strings"];
        assert_eq!(strings["entries"], 2);
        assert_eq!(body[at(start, &strings["loneSurrogates"])?], 0b10);
        let bytes = at(start, &strings["bytes"])?;
        let offsets = at(start, &strings["offsets"])?;
        let second = u32_at(body, offsets + 4) as usize..u32_at(body, offsets + 8) as usize;
        assert_eq!(
            &body[bytes + second.start..bytes + second.end],
            b"a\xed\xa0\x80"
        );
        // `sourceWords` is missing on the second row and omitted there.
        let words = &header["columns"][2];
        assert_eq!(words["missing"], "omit");
        assert_eq!(body[at(start, &words["validity"])?], 0b01);
        // A host reads the rows back as they went in.
        assert_eq!(
            read(body)?.1,
            [
                json!({"key": ["de", lone], "lines": 3, "sourceWords": 2.5}),
                json!({"key": ["de"], "lines": 1})
            ]
        );
        Ok(())
    }

    #[test]
    fn children_name_their_parents_and_rows_split_into_batches() -> Result<()> {
        let mut sent = Sent::default();
        let mut parents = Batches::new(&PACKAGE, "packages", PACKAGE.all());
        let mut children =
            Batches::new(&PLACE, "places", PLACE.select(&["parent", "packageFile"])?);
        for index in 0..=BATCH_ROWS {
            children.push_child(parents.next_row(), &json!({"packageFile": "a"}))?;
            parents.push(&json!({"packageFile": format!("p{index}"), "status": "complete"}))?;
            if parents.full() {
                children.flush(&mut sent)?;
                parents.flush(&mut sent)?;
            }
        }
        children.flush(&mut sent)?;
        assert_eq!(parents.finish(&mut sent)?, BATCH_ROWS as u32 + 1);
        let parts = sent
            .0
            .iter()
            .map(|body| {
                let (header, _) = header(body)?;
                Ok((header["part"].clone(), header["rows"].clone()))
            })
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(
            parts,
            [
                (json!("places"), json!(BATCH_ROWS)),
                (json!("packages"), json!(BATCH_ROWS)),
                (json!("places"), json!(1)),
                (json!("packages"), json!(1)),
            ]
        );
        // The last child names the last parent, counted across batches.
        let (header, start) = header(&sent.0[2])?;
        let parent = at(start, &header["columns"][0]["offset"])?;
        assert_eq!(u32_at(&sent.0[2], parent), BATCH_ROWS as u32);
        Ok(())
    }

    #[test]
    fn a_missing_required_value_and_an_unknown_column_fail() {
        let mut batches = Batches::new(&PACKAGE, "packages", PACKAGE.all());
        assert!(batches.push(&json!({"packageFile": "a"})).is_err());
        assert!(PACKAGE.select(&["nope"]).is_err());
    }
}
