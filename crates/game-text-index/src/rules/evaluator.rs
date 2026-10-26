//! Column-at-a-time DAG evaluation with selection short circuiting and tuple memoization.
use super::HostCollator;
use super::columns::{
    Arena, Atom, Bits, Children, Column, FieldColumn, Occurrences, Prepared, StrId, Structured,
};
use super::compiler::{CompiledRule, Literal, NodeId, Op, Program, Subject};
use super::kernel::Kernel;
use super::selection::Selection;
use super::stages::{Measure, Phase, PhaseTime, Recorder, subject_stage};
use super::text;
use super::tuple::{Key as TupleKey, Packer};
use super::value::Value as ScalarValue;
use crate::engine_types::REASONS;
use crate::{Error, ErrorCode, Result, require};
use rustc_hash::FxHashMap;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Default)]
pub struct Relation {
    pub subject: Option<Subject>,
    pub fields: HashMap<String, Vec<Value>>,
    pub occurrences: Vec<Vec<Value>>,
}
impl Relation {
    pub fn len(&self) -> usize {
        self.fields.values().next().map_or(0, Vec::len)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// An affected occurrence as rules see it. Rows number this relation's occurrences in
    /// order, across subject rows.
    pub fn place(&self, row: u32) -> Result<Value> {
        let occurrence = self
            .occurrences
            .iter()
            .flatten()
            .nth(row as usize)
            .ok_or("Missing affected occurrence.")?;
        let mut arena = Arena::new(0)?;
        let value = ScalarValue::from_json(occurrence);
        let mut place = serde_json::Map::new();
        for name in OCCURRENCE_FIELDS {
            let atom = arena.intern(value[name].clone())?;
            place.insert(name.into(), arena.json(atom));
        }
        Ok(Value::Object(place))
    }
}
/// Dense IDs of values, equal under `Evaluator::key` (numbers by value, objects whatever their
/// member order), built from the values' parts instead of their written keys. Memoized per atom,
/// so a value repeated across rows is identified once.
#[derive(Default)]
struct KeyIds {
    atoms: FxHashMap<Atom, u32>,
    texts: FxHashMap<Box<str>, u32>,
    shapes: FxHashMap<Box<[u32]>, u32>,
    next: u32,
}
impl KeyIds {
    // `null` (and non-finite numbers, which keys write as `null`), `false` and `true`.
    const NULL: u32 = 0;
    const FALSE: u32 = 1;
    const TRUE: u32 = 2;
    // Shape tags, the first element of a shape's parts.
    const NUMBER: u32 = 0;
    const LIST: u32 = 1;
    const OBJECT: u32 = 2;
    fn of(&mut self, atom: Atom, arena: &Arena) -> u32 {
        if let Some(id) = self.atoms.get(&atom) {
            return *id;
        }
        let id = match atom {
            Atom::Null => Self::NULL,
            Atom::Bool(value) => [Self::FALSE, Self::TRUE][usize::from(value)],
            Atom::Int(value) => self.number(value as f64),
            Atom::Num(bits) => self.number(f64::from_bits(bits)),
            Atom::Str(text) => self.text(arena.text(text)),
            Atom::Val(value) => match &arena.values[value.0 as usize] {
                Structured::List(values) => {
                    let mut parts = vec![Self::LIST];
                    for value in values.iter() {
                        parts.push(self.of(*value, arena));
                    }
                    self.shape(parts)
                }
                Structured::Object(fields)
                    if fields.iter().enumerate().all(|(index, (key, _))| {
                        fields[..index]
                            .iter()
                            .all(|(other, _)| arena.text(*other) != arena.text(*key))
                    }) =>
                {
                    let mut members = fields
                        .iter()
                        .map(|(key, value)| (self.text(arena.text(*key)), self.of(*value, arena)))
                        .collect::<Vec<_>>();
                    self.object(&mut members)
                }
                Structured::Scalar(value) => self.of(*value, arena),
                // Occurrence views and objects with repeated keys are keyed as the JSON they
                // present, as `write_atom` writes them.
                _ => self.json(&arena.json(atom)),
            },
        };
        self.atoms.insert(atom, id);
        id
    }
    fn json(&mut self, value: &Value) -> u32 {
        match value {
            Value::Null => Self::NULL,
            Value::Bool(value) => [Self::FALSE, Self::TRUE][usize::from(*value)],
            Value::Number(number) => self.number(number.as_f64().unwrap_or(f64::NAN)),
            Value::String(text) => self.text(text),
            Value::Array(values) => {
                let mut parts = vec![Self::LIST];
                for value in values {
                    parts.push(self.json(value));
                }
                self.shape(parts)
            }
            Value::Object(fields) => {
                let mut members = fields
                    .iter()
                    .map(|(key, value)| (self.text(key), self.json(value)))
                    .collect::<Vec<_>>();
                self.object(&mut members)
            }
        }
    }
    fn fresh(&mut self) -> u32 {
        self.next += 1;
        Self::TRUE + self.next
    }
    /// Numbers equal as keys write the same JavaScript text: equal finite values, `-0` as `0`.
    fn number(&mut self, value: f64) -> u32 {
        if !value.is_finite() {
            return Self::NULL;
        }
        let bits = if value == 0.0 { 0 } else { value.to_bits() };
        #[allow(clippy::cast_possible_truncation)]
        self.shape(vec![Self::NUMBER, (bits >> 32) as u32, bits as u32])
    }
    fn text(&mut self, text: &str) -> u32 {
        if let Some(id) = self.texts.get(text) {
            return *id;
        }
        let id = self.fresh();
        self.texts.insert(text.into(), id);
        id
    }
    /// Members in name order; names are unique, so the order is canonical.
    fn object(&mut self, members: &mut [(u32, u32)]) -> u32 {
        members.sort_unstable();
        let mut parts = vec![Self::OBJECT];
        for (name, value) in members.iter() {
            parts.extend([*name, *value]);
        }
        self.shape(parts)
    }
    fn shape(&mut self, parts: Vec<u32>) -> u32 {
        if let Some(id) = self.shapes.get(parts.as_slice()) {
            return *id;
        }
        let id = self.fresh();
        self.shapes.insert(parts.into_boxed_slice(), id);
        id
    }
}
/// An occurrence's fields as places show them.
const OCCURRENCE_FIELDS: [&str; 6] = [
    "id",
    "packageFile",
    "source",
    "devNotes",
    "location",
    "unitStatus",
];
/// Fields rules can read beyond what places show; they are never part of a published place.
const OCCURRENCE_RULE_FIELDS: [&str; 2] = ["audience", "unresolvedReason"];
/// The occurrences a finding affects: relation rows in emission order and their IDs. Places are
/// hydrated from the index only when they are read.
#[derive(Debug, Default)]
pub struct Affected {
    pub rows: Box<[u32]>,
    pub ids: Box<[Option<Arc<str>>]>,
}
/// The relation rows of an occurrence list.
pub(super) fn occurrence_rows(arena: &Arena, set: Atom) -> Result<Vec<u32>> {
    arena
        .elements(set)?
        .unwrap_or_default()
        .iter()
        .map(|atom| {
            if let Atom::Val(id) = atom
                && let Structured::Occurrence(row) = arena.values[id.0 as usize]
            {
                Ok(row)
            } else {
                Err("Finding affected must be an occurrence list.".into())
            }
        })
        .collect()
}
pub trait SubjectRows {
    fn subject(&self) -> Subject;
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Compatibility/emission reads. Native execution overrides prepare and never reads row JSON.
    fn field(&mut self, row: usize, name: &str) -> Result<Value>;
    fn occurrences(&mut self, row: usize) -> Result<Vec<Value>>;
    fn affected(
        &mut self,
        arena: &mut Arena,
        sets: &[Atom],
        measure: &mut Measure,
    ) -> Result<HashMap<Atom, Arc<Affected>>> {
        measure
            .parallel(sets, |set| {
                let rows = occurrence_rows(arena, *set)?;
                let ids = rows
                    .iter()
                    .map(|row| match arena.occurrence(*row, "id") {
                        Atom::Str(id) => Some(Arc::from(arena.text(id))),
                        _ => None,
                    })
                    .collect();
                Ok((
                    *set,
                    Arc::new(Affected {
                        rows: rows.into(),
                        ids,
                    }),
                ))
            })
            .into_iter()
            .collect()
    }
    fn dictionary_len(&self) -> Result<usize> {
        Ok(0)
    }
    fn checkpoint(&self) -> Result<()> {
        Ok(())
    }
    #[doc(hidden)]
    fn prepare(
        &mut self,
        names: &[String],
        arena: &mut Arena,
        with_children: bool,
    ) -> Result<Prepared> {
        let len = self.len();
        let mut prepared = Prepared::default();
        for name in names {
            let values = (0..len)
                .map(|row| Ok(ScalarValue::from_json(&self.field(row, name)?)))
                .collect::<Result<Vec<_>>>()?;
            let atoms = values
                .into_iter()
                .map(|value| arena.intern(value))
                .collect::<Result<Vec<_>>>()?;
            prepared.fields.insert(
                name.clone(),
                FieldColumn {
                    column: Arc::new(Column::from_atoms(&atoms, arena)?),
                    rows: None,
                },
            );
        }
        if !with_children {
            return Ok(prepared);
        }
        let mut values = HashMap::<String, Vec<Atom>>::new();
        let mut children = Children {
            offsets: Arc::new(vec![0]),
            ..Children::default()
        };
        let mut count = 0;
        for row in 0..len {
            for occurrence in self.occurrences(row)? {
                let occurrence = ScalarValue::from_json(&occurrence);
                for name in OCCURRENCE_FIELDS.into_iter().chain(OCCURRENCE_RULE_FIELDS) {
                    values
                        .entry(name.into())
                        .or_default()
                        .push(arena.intern(occurrence[name].clone())?);
                }
                Arc::make_mut(&mut children.members).push(count);
                count += 1;
            }
            Arc::make_mut(&mut children.offsets).push(count);
        }
        arena.occurrences = Occurrences {
            len: count as usize,
            raw_rows: Vec::new(),
            fields: values
                .into_iter()
                .map(|(name, values)| Ok((name, Arc::new(Column::from_atoms(&values, arena)?))))
                .collect::<Result<_>>()?,
            ..Occurrences::default()
        };
        prepared.children = children;
        Ok(prepared)
    }
}
impl SubjectRows for Relation {
    fn subject(&self) -> Subject {
        self.subject.unwrap_or(Subject::Line)
    }
    fn len(&self) -> usize {
        self.len()
    }
    fn field(&mut self, row: usize, name: &str) -> Result<Value> {
        self.fields
            .get(name)
            .and_then(|values| values.get(row))
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::InvalidInput,
                    format!("Missing subject field {name}."),
                )
            })
    }
    fn occurrences(&mut self, row: usize) -> Result<Vec<Value>> {
        Ok(self.occurrences.get(row).cloned().unwrap_or_default())
    }
}
#[derive(Clone, Debug)]
pub struct Emission {
    pub rule: usize,
    pub row: usize,
    pub subject: Subject,
    pub actual: Value,
    pub expectation: Value,
    pub fix: Value,
    pub extra: Value,
    pub translation_origin: Value,
    pub recovery: String,
    pub affected: Arc<Affected>,
}
pub struct Evaluation {
    pub findings: Vec<Emission>,
    pub diagnostics: Vec<Diagnostic>,
    pub masks: HashMap<usize, Vec<u64>>,
}
#[derive(Clone, Copy)]
pub(super) enum Slot {
    Value(Atom),
    Limit,
}
enum Computed {
    List(Vec<Atom>),
    /// A result that is already interned.
    Found(Atom),
    Out(super::out::Out),
    Limit,
}
#[derive(Clone, Copy)]
pub(crate) struct Evidence {
    pub actual: Atom,
    pub expectation: Atom,
    pub fix: Atom,
    pub extra: Atom,
    pub translation_origin: Atom,
    /// `Bool(true)` when the rule's `shadowed` holds for the finding.
    pub shadowed: Atom,
}
/// A finding as evaluation produced it: interned evidence in the evaluation's arena.
pub(crate) struct Finding {
    pub rule: usize,
    pub row: u32,
    pub subject: Subject,
    pub evidence: Evidence,
    pub recovery: StrId,
    pub affected: Arc<Affected>,
}
impl Finding {
    pub fn emission(&self, arena: &Arena) -> Emission {
        let evidence = self.evidence;
        Emission {
            rule: self.rule,
            row: self.row as usize,
            subject: self.subject,
            actual: arena.json(evidence.actual),
            expectation: arena.json(evidence.expectation),
            fix: arena.json(evidence.fix),
            extra: arena.json(evidence.extra),
            translation_origin: arena.json(evidence.translation_origin),
            recovery: arena.text(self.recovery).to_owned(),
            affected: Arc::clone(&self.affected),
        }
    }
}
/// One subject's evaluation, its findings still in the arena it ran in.
pub(crate) struct Evaluated {
    pub findings: Vec<Finding>,
    pub diagnostics: Vec<Diagnostic>,
    pub masks: HashMap<usize, Vec<u64>>,
    /// Line-culture diagnostics that do not come from a rule.
    pub projection: Vec<Diagnostic>,
    pub recorder: Recorder,
    /// Each cross-row node's groups over every row, for the next evaluation; `None` when a node
    /// can't be followed incrementally.
    pub groups: Option<Vec<super::incremental::NodeGroups>>,
    /// The rows evaluated, when an incremental evaluation evaluated only some.
    pub evaluated: Option<Bits>,
}
struct Pending {
    rule: usize,
    row: u32,
    subject: Subject,
    evidence: Evidence,
    recovery: Atom,
    affected: Atom,
}
#[derive(Default)]
struct RuleEvidence {
    rows: Vec<u32>,
    values: Vec<Evidence>,
}
/// A row's memo lookup in the hashed scalar path.
#[derive(Clone, Copy, Default)]
enum Probe {
    #[default]
    Failed,
    Hit(Slot),
    Miss(TupleKey),
    /// Its key needs the packer's overflow tables, which only the serial pass may grow.
    Unpacked,
}
/// A string's format parse, with the one property of it that is read for every row.
struct Parsed {
    pattern: super::grammar::Pattern,
    /// Plural, ordinal, gender and hpp modifiers validate per culture.
    culture_dependent: bool,
}
impl Parsed {
    fn new(pattern: super::grammar::Pattern) -> Self {
        let culture_dependent = pattern.modifiers.iter().any(|modifier| {
            matches!(
                modifier.name.as_str(),
                "plural" | "ordinal" | "gender" | "hpp"
            )
        });
        Self {
            pattern,
            culture_dependent,
        }
    }
}
struct DenseSelection {
    suffixes: Vec<Vec<Atom>>,
    /// Each row's suffix; empty when every row has the first.
    groups: Vec<u8>,
}
/// A subject row's diagnostic. The subject is the evaluation's; `code` indexes
/// `DIAGNOSTIC_CODES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub row: u32,
    pub code: u8,
}
/// The reasons a line could not be checked, then the evaluator's own codes. Stored diagnostics
/// name these; the order only fixes `code`.
pub const DIAGNOSTIC_CODES: [&str; REASONS.len() + 5] = {
    let mut codes = [""; REASONS.len() + 5];
    let mut index = 0;
    while index < REASONS.len() {
        codes[index] = REASONS[index];
        index += 1;
    }
    codes[REASONS.len()] = "reduced_source_checking";
    codes[REASONS.len() + 1] = "source_unavailable";
    codes[REASONS.len() + 2] = "translation_unavailable";
    codes[REASONS.len() + 3] = "unsupported_culture";
    codes[REASONS.len() + 4] = "syntax_limit";
    codes
};
const REDUCED_SOURCE_CHECKING: u8 = REASONS.len() as u8;
const SOURCE_UNAVAILABLE: u8 = REASONS.len() as u8 + 1;
const TRANSLATION_UNAVAILABLE: u8 = REASONS.len() as u8 + 2;
const UNSUPPORTED_CULTURE: u8 = REASONS.len() as u8 + 3;
const SYNTAX_LIMIT: u8 = REASONS.len() as u8 + 4;
impl Diagnostic {
    fn new(row: impl TryInto<u32>, code: u8) -> Result<Self> {
        Ok(Self {
            row: row
                .try_into()
                .map_err(|_| "Diagnostic row is out of range.")?,
            code,
        })
    }
    pub fn name(self) -> &'static str {
        DIAGNOSTIC_CODES[self.code as usize]
    }
}
fn diagnostic_code(name: &str) -> Result<u8> {
    DIAGNOSTIC_CODES
        .iter()
        .position(|code| *code == name)
        .map(|code| code as u8)
        .ok_or_else(|| format!("Unknown diagnostic code {name}.").into())
}
/// A format pattern's culture: the first suffix atom, `en` when there is none.
fn pattern_culture<'a>(arena: &'a Arena, suffix: &[Atom]) -> &'a str {
    match suffix.first() {
        Some(Atom::Str(id)) => arena.text(*id),
        _ => "en",
    }
}
/// The distinct scalar suffixes of a selection, in first-row order, and each row's group.
/// `None` past 32 distinct suffixes, where a dense memo per suffix no longer pays.
fn suffix_groups(
    arena: &Arena,
    columns: &[Column],
    len: usize,
    measure: &mut Measure,
) -> Option<(Vec<Vec<Atom>>, Vec<u8>)> {
    const LIMIT: usize = 32;
    let suffix = |row: usize| {
        columns
            .iter()
            .map(|column| column.get(row, arena))
            .collect::<Vec<_>>()
    };
    let same = |row: usize, known: &[Atom]| {
        columns
            .iter()
            .zip(known)
            .all(|(column, atom)| column.get(row, arena) == *atom)
    };
    if columns
        .iter()
        .all(|column| matches!(column.data, super::columns::Data::Constant(_)))
    {
        return Some((vec![suffix(0)], Vec::new()));
    }
    const CHUNK: usize = 1 << 16;
    let chunks = (0..len.div_ceil(CHUNK)).collect::<Vec<_>>();
    let found = measure.parallel_chunks(&chunks, 1, |chunk| {
        let mut distinct = Vec::<Vec<Atom>>::new();
        for row in chunk * CHUNK..((chunk + 1) * CHUNK).min(len) {
            if !distinct.iter().any(|known| same(row, known)) {
                if distinct.len() == LIMIT {
                    return None;
                }
                distinct.push(suffix(row));
            }
        }
        Some(distinct)
    });
    let mut suffixes = Vec::new();
    for distinct in found {
        for value in distinct? {
            if !suffixes.contains(&value) {
                if suffixes.len() == LIMIT {
                    return None;
                }
                suffixes.push(value);
            }
        }
    }
    let groups = measure.parallel_range(len, |row| {
        suffixes
            .iter()
            .position(|known| same(row, known))
            .unwrap_or_default() as u8
    });
    Some((suffixes, groups))
}
/// Each row's memoized result, in parallel. A row over its limit is null and failed.
fn gather(
    measure: &mut Measure,
    failures: &mut Bits,
    slot: impl Fn(usize) -> Option<Slot> + Sync + Send,
) -> Vec<Atom> {
    let len = failures.len;
    let any_limited = std::sync::atomic::AtomicBool::new(false);
    let output = measure.parallel_range(len, |row| match slot(row) {
        Some(Slot::Value(value)) => value,
        Some(Slot::Limit) => {
            any_limited.store(true, std::sync::atomic::Ordering::Relaxed);
            Atom::Null
        }
        None => Atom::Null,
    });
    if !any_limited.into_inner() {
        return output;
    }
    let limited = measure.parallel_range(len.div_ceil(64), |word| {
        (word * 64..((word + 1) * 64).min(len))
            .filter(|row| matches!(slot(*row), Some(Slot::Limit)))
            .fold(0u64, |bits, row| bits | 1 << (row % 64))
    });
    for (word, limited) in failures.words.iter_mut().zip(limited) {
        *word |= limited;
    }
    output
}
#[cfg(test)]
type TimedEvaluation = (Evaluation, Recorder, Vec<Diagnostic>);
struct Evaluator<'a> {
    program: &'a Program,
    arena: Arena,
    prepared: Prepared,
    kernel: Kernel<'a>,
    literals: Vec<Option<Atom>>,
    cache: Vec<FxHashMap<TupleKey, Slot>>,
    packer: Packer,
    cache_last: Vec<usize>,
    node_last: Vec<usize>,
    cache_ids: Vec<usize>,
    references: HashMap<String, usize>,
    masks: HashMap<usize, Bits>,
    evidence: Vec<Option<RuleEvidence>>,
    children: HashMap<usize, Atom>,
    dense: Vec<Vec<(Vec<Atom>, super::memo::DenseMemo)>>,
    parsed: Vec<Option<Arc<Parsed>>>,
    /// The parse every string without format syntax shares.
    unformatted: Arc<Parsed>,
    cheap_columns: Vec<Option<(Column, Bits)>>,
    independent: Vec<bool>,
    /// Each group aggregate's value for every subject row, computed once.
    aggregates: Vec<Option<Arc<Column>>>,
    /// Each corpus count's rows by key, built once.
    corpus_tables: HashMap<NodeId, Arc<HashMap<String, i64>>>,
    /// The rows an incremental evaluation evaluates; aggregates still read every row.
    restrict: Option<Bits>,
    len: usize,
}
impl<'a> Evaluator<'a> {
    /// What the arena and the evaluator's caches hold, by part.
    fn holders(&self) -> std::collections::BTreeMap<&'static str, u64> {
        let mut holders = self.arena.holders();
        let cheap = self
            .cheap_columns
            .iter()
            .flatten()
            .map(|(column, ready)| column.bytes() + ready.words.capacity() * 8)
            .sum::<usize>();
        let prepared = self
            .prepared
            .fields
            .values()
            .map(|field| field.column.bytes())
            .sum::<usize>();
        let memory = self.memory();
        holders.insert("cheapColumns", cheap as u64);
        holders.insert("preparedFields", prepared as u64);
        holders.insert("memos", memory.memos_bytes as u64);
        holders
    }
    fn memory(&self) -> super::stages::Memory {
        let mut memory = self.arena.memory();
        memory.live_node_columns_bytes = self
            .cheap_columns
            .iter()
            .flatten()
            .map(|(column, ready)| column.bytes() + ready.words.capacity() * 8)
            .sum::<usize>()
            + self
                .prepared
                .fields
                .values()
                .map(|field| field.column.bytes())
                .sum::<usize>();
        memory.memos_bytes = self
            .cache
            .iter()
            .map(|cache| {
                cache.capacity()
                    * (std::mem::size_of::<TupleKey>() + std::mem::size_of::<Slot>() + 1)
            })
            .sum::<usize>()
            + self
                .dense
                .iter()
                .flatten()
                .map(|(suffix, memo)| {
                    suffix.capacity() * std::mem::size_of::<Atom>() + memo.bytes()
                })
                .sum::<usize>()
            + self.packer.bytes()
            + self.parsed.capacity() * std::mem::size_of::<Option<Arc<Parsed>>>();
        memory
    }
    fn new(
        program: &'a Program,
        arena: Arena,
        prepared: Prepared,
        collator: &'a HostCollator,
        len: usize,
        subject: Subject,
    ) -> Result<Self> {
        let mut value = Self {
            program,
            kernel: Kernel::new(collator, &program.roles, &arena),
            arena,
            literals: vec![None; program.nodes.len()],
            cache: Vec::new(),
            packer: Packer::default(),
            cache_last: Vec::new(),
            node_last: program
                .node_last_consumer
                .iter()
                .map(|last| {
                    last[match subject {
                        Subject::Line => 0,
                        Subject::LineCulture => 1,
                        Subject::UnitSource => 2,
                    }]
                })
                .collect(),
            dense: Vec::new(),
            parsed: Vec::new(),
            unformatted: Arc::new(Parsed::new(super::grammar::parse_pattern(""))),
            cheap_columns: (0..program.nodes.len()).map(|_| None).collect(),
            independent: vec![false; program.nodes.len()],
            aggregates: vec![None; program.nodes.len()],
            corpus_tables: HashMap::new(),
            restrict: None,
            len,
            cache_ids: Vec::new(),
            prepared,
            references: program
                .rules
                .iter()
                .map(|rule| (rule.rule.id.clone(), rule.ordinal))
                .collect(),
            masks: HashMap::new(),
            evidence: (0..program
                .rules
                .iter()
                .map(|rule| rule.ordinal + 1)
                .max()
                .unwrap_or(0))
                .map(|_| None)
                .collect(),
            children: HashMap::new(),
        };
        let mut groups = HashMap::new();
        for (id, node) in program.nodes.iter().enumerate() {
            let next = groups.len();
            let cache = *groups.entry(&node.op).or_insert(next);
            value.cache_ids.push(cache);
            if let Op::Lit(literal) = &node.op {
                value.literals[id] = Some(value.arena.literal(literal)?);
            }
        }
        value.cache = (0..groups.len()).map(|_| FxHashMap::default()).collect();
        value.cache_last = vec![0; groups.len()];
        for (node, cache) in value.cache_ids.iter().enumerate() {
            value.cache_last[*cache] = value.cache_last[*cache].max(value.node_last[node]);
        }
        value.dense = (0..groups.len()).map(|_| Vec::new()).collect();
        for (id, node) in program.nodes.iter().enumerate() {
            value.independent[id] = !matches!(
                node.op,
                Op::Var(_)
                    | Op::Finding(_)
                    | Op::FindingField(..)
                    | Op::Filter(_)
                    | Op::Map(_)
                    | Op::FlatMap(_)
                    | Op::Any(_)
                    | Op::All(_)
                    | Op::SortLocale
                    | Op::SortCodeUnit
            ) && node.args.iter().all(|arg| value.independent[*arg]);
        }
        Ok(value)
    }
    fn children(&mut self, row: usize) -> Result<Atom> {
        let parent = self
            .prepared
            .children
            .rows
            .as_ref()
            .map_or(row, |rows| rows[row] as usize);
        if let Some(value) = self.children.get(&parent) {
            return Ok(*value);
        }
        let members = self.prepared.children.members(row).to_vec();
        let values = members
            .into_iter()
            .map(|row| self.arena.occurrence_id(row))
            .collect::<Result<_>>()?;
        let value = self.arena.list(values)?;
        self.children.insert(parent, value);
        Ok(value)
    }
    fn evaluate(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let mut measure = Measure::start();
        let children = self.arena.recorder.kernel_wall();
        let result = self.evaluate_inner(id, selection);
        measure.exclude(self.arena.recorder.kernel_wall().saturating_sub(children));
        let op = &self.program.nodes[id].op;
        let structural = matches!(
            op,
            Op::Lit(_)
                | Op::Field(_)
                | Op::Var(_)
                | Op::Occurrences
                | Op::Finding(_)
                | Op::FindingField(..)
                | Op::And
                | Op::Or
                | Op::If
                | Op::Coalesce
                | Op::Filter(_)
                | Op::Map(_)
                | Op::FlatMap(_)
                | Op::Any(_)
                | Op::All(_)
                | Op::SortLocale
                | Op::SortCodeUnit
        );
        self.arena.recorder.kernel(
            op.name(),
            &measure,
            if structural { selection.len() } else { 0 },
            0,
            0,
        );
        result
    }
    fn evaluate_inner(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        if selection.len() == 0 {
            return Ok(Column::constant(Atom::Null, 0));
        }
        let op = &self.program.nodes[id].op;
        let cacheable = self.independent[id]
            && (super::vector::cheap(op) || matches!(op, Op::And | Op::Or | Op::If | Op::Coalesce));
        if cacheable
            && self.cheap_columns[id].is_none()
            && selection.len() == self.len
            && selection
                .mask()
                .is_some_and(|mask| mask.count() == self.len)
        {
            let column = self.node(id, selection)?;
            self.cheap_columns[id] = Some((column.clone(), Bits::all(self.len)));
            return Ok(column);
        }
        // Most selections are bitsets: find, compute and mark the missing rows a word at a time.
        if cacheable && let Some(mask) = selection.mask() {
            let mut missing = mask.clone();
            if let Some((_, ready)) = &self.cheap_columns[id] {
                for (word, done) in missing.words.iter_mut().zip(&ready.words) {
                    *word &= !done;
                }
            }
            if missing.any() {
                let narrowed = Selection::from_mask(missing);
                let column = self.node(id, &narrowed)?;
                let (cached, ready) = self.cheap_columns[id].get_or_insert_with(|| {
                    (Column::constant(Atom::Null, self.len), Bits::new(self.len))
                });
                cached.scatter_mask(&narrowed.rows.mask, &column, &mut self.arena)?;
                for (word, done) in ready.words.iter_mut().zip(&narrowed.rows.mask.words) {
                    *word |= done;
                }
            }
            return Ok(self.cheap_columns[id]
                .as_ref()
                .ok_or("Missing cached column.")?
                .0
                .select_mask(mask, None));
        }
        if cacheable {
            let missing = if let Some((_, ready)) = &self.cheap_columns[id] {
                selection
                    .rows
                    .iter()
                    .enumerate()
                    .filter_map(|(index, row)| (!ready.get(row as usize)).then_some(index))
                    .collect::<Vec<_>>()
            } else {
                (0..selection.len()).collect()
            };
            if !missing.is_empty() {
                let narrowed = selection.select(&missing, &mut self.arena)?;
                let column = self.node(id, &narrowed)?;
                let (cached, ready) = self.cheap_columns[id].get_or_insert_with(|| {
                    (Column::constant(Atom::Null, self.len), Bits::new(self.len))
                });
                cached.scatter(
                    &narrowed.rows.iter().collect::<Vec<_>>(),
                    &column,
                    &mut self.arena,
                )?;
                for row in narrowed.rows.iter() {
                    ready.set(row as usize);
                }
            }
            let rows = selection
                .rows
                .iter()
                .map(|row| row as usize)
                .collect::<Vec<_>>();
            return self.cheap_columns[id]
                .as_ref()
                .ok_or("Missing cached column.")?
                .0
                .select(&rows, &mut self.arena);
        }
        let column = self.node(id, selection)?;
        Ok(column)
    }

    fn node(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        match &node.op {
            Op::Lit(_) => Ok(Column::constant(
                self.literals[id].ok_or("Missing compiled literal.")?,
                selection.len(),
            )),
            Op::Field(name) => {
                let field = self.prepared.field(name)?;
                if let Some(mask) = selection.mask() {
                    return Ok(field.column.select_mask(mask, field.rows.as_deref()));
                }
                let rows = selection
                    .rows
                    .iter()
                    .map(|row| {
                        field
                            .rows
                            .as_ref()
                            .map_or(row as usize, |parents| parents[row as usize] as usize)
                    })
                    .collect::<Vec<_>>();
                field.column.select(&rows, &mut self.arena)
            }
            Op::Var(name) => selection
                .variables
                .get(&**name)
                .cloned()
                .ok_or_else(|| "Missing element binding column.".into()),
            Op::Occurrences => {
                let values = selection
                    .rows
                    .iter()
                    .map(|row| self.children(row as usize))
                    .collect::<Result<Vec<_>>>()?;
                Column::from_atoms(&values, &mut self.arena)
            }
            Op::Finding(_) | Op::FindingField(..) => {
                let reference = node
                    .op
                    .reference()
                    .and_then(|name| self.references.get(name))
                    .copied();
                if let (Op::Finding(_), Some(mask)) = (&node.op, selection.mask()) {
                    let found = reference
                        .and_then(|id| self.masks.get(&id))
                        .map_or_else(|| Bits::new(selection.len()), |found| found.extract(mask));
                    return Ok(Column {
                        data: super::columns::Data::Bool(found),
                        nulls: Bits::new(selection.len()),
                        failed: Bits::new(selection.len()),
                    }
                    .folded());
                }
                let mut values = Vec::with_capacity(selection.len());
                for row in selection.rows.iter() {
                    if let Op::Finding(_) = node.op {
                        values.push(Atom::Bool(
                            reference
                                .and_then(|id| self.masks.get(&id))
                                .is_some_and(|mask| mask.get(row as usize)),
                        ));
                    } else if let Op::FindingField(_, path) = &node.op {
                        let value = reference
                            .and_then(|id| self.evidence[id].as_ref())
                            .and_then(|evidence| {
                                evidence
                                    .rows
                                    .binary_search(&row)
                                    .ok()
                                    .map(|index| &evidence.values[index])
                            })
                            .map_or(Atom::Null, |evidence| {
                                let (field, path) = path.split_once('.').unwrap_or((path, ""));
                                let value = match field {
                                    "actual" => evidence.actual,
                                    "expectation" => evidence.expectation,
                                    "fix" => evidence.fix,
                                    "extra" => evidence.extra,
                                    _ => Atom::Null,
                                };
                                if path.is_empty() {
                                    value
                                } else {
                                    self.arena.get_path(value, path)
                                }
                            });
                        values.push(value);
                    }
                }
                Column::from_atoms(&values, &mut self.arena)
            }
            Op::And | Op::Or | Op::Coalesce => self.short_circuit(id, selection),
            Op::If => self.conditional(id, selection),
            Op::Filter(_)
            | Op::Map(_)
            | Op::FlatMap(_)
            | Op::Any(_)
            | Op::All(_)
            | Op::SortCodeUnit
            | Op::SortLocale => self.list_operator(id, selection),
            Op::CorpusCount => self.corpus_count(id, selection),
            op if op.is_aggregate() => {
                let column = match &self.aggregates[id] {
                    Some(column) => Arc::clone(column),
                    None => {
                        let column = Arc::new(self.group_aggregate(id)?);
                        self.aggregates[id] = Some(Arc::clone(&column));
                        column
                    }
                };
                if let Some(mask) = selection.mask() {
                    return Ok(column.select_mask(mask, None));
                }
                let rows = selection
                    .rows
                    .iter()
                    .map(|row| row as usize)
                    .collect::<Vec<_>>();
                column.select(&rows, &mut self.arena)
            }
            _ => self.scalar(id, selection),
        }
    }
    /// A value as a group, tally or corpus key. Values that compare equal have equal keys:
    /// numbers by value and objects whatever their member order, as `eq` compares them.
    fn key(&self, value: Atom) -> String {
        let mut key = String::new();
        super::identity::write_atom(&self.arena, value, true, &mut key);
        key
    }
    /// The order `groupRank` sorts by: lists element-wise, strings with the host collator,
    /// numbers numerically, and null first.
    fn order(&self, a: Atom, b: Atom) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        if let (Ok(Some(a)), Ok(Some(b))) = (self.arena.elements(a), self.arena.elements(b)) {
            for (a, b) in a.iter().zip(b) {
                let order = self.order(*a, *b);
                if order != Ordering::Equal {
                    return order;
                }
            }
            return a.len().cmp(&b.len());
        }
        match (a, b) {
            (Atom::Null, Atom::Null) => Ordering::Equal,
            (Atom::Null, _) => Ordering::Less,
            (_, Atom::Null) => Ordering::Greater,
            (Atom::Str(a), Atom::Str(b)) => self
                .kernel
                .collator
                .compare(self.arena.text(a), self.arena.text(b)),
            (Atom::Int(a), Atom::Int(b)) => a.cmp(&b),
            // Arithmetic yields floating-point numbers, whole ones included.
            (Atom::Int(_) | Atom::Num(_), Atom::Int(_) | Atom::Num(_)) => {
                let number = |atom| match atom {
                    Atom::Int(value) => value as f64,
                    // -0 equals 0, so it orders with it; `total_cmp` would put it first.
                    Atom::Num(bits) if f64::from_bits(bits) == 0.0 => 0.0,
                    Atom::Num(bits) => f64::from_bits(bits),
                    _ => f64::NAN,
                };
                number(a).total_cmp(&number(b))
            }
            (Atom::Bool(a), Atom::Bool(b)) => a.cmp(&b),
            _ => self.key(a).cmp(&self.key(b)),
        }
    }
    /// A group aggregate's value for every subject row (Phase 2 specification §3.1). Rows outside
    /// `among`, or whose key is null, are null; a row whose inputs failed fails.
    fn group_aggregate(&mut self, id: NodeId) -> Result<Column> {
        let op = self.program.nodes[id].op.clone();
        let args = self.program.nodes[id].args.clone();
        let all = Selection::from_mask(Bits::all(self.len));
        if op == Op::ExistsOther {
            return self.exists_other(&args, &all);
        }
        let by = self.evaluate(args[0], &all)?;
        let among = self.evaluate(args[1], &all)?;
        let mut failed = Bits::new(self.len);
        let mut groups = HashMap::<String, Vec<usize>>::new();
        for row in 0..self.len {
            if by.failed.get(row) || among.failed.get(row) {
                failed.set(row);
                continue;
            }
            let value = by.get(row, &self.arena);
            if value != Atom::Null && among.get(row, &self.arena).boolean() {
                groups.entry(self.key(value)).or_default().push(row);
            }
        }
        let mut values = vec![Atom::Null; self.len];
        match op {
            Op::GroupCount => {
                for members in groups.values() {
                    let count = Atom::Int(i64::try_from(members.len())?);
                    for row in members {
                        values[*row] = count;
                    }
                }
            }
            Op::GroupRank | Op::GroupTake => {
                let order = self.evaluate(args[2], &all)?;
                let taken = if op == Op::GroupTake {
                    let n = match self.literals[args[4]] {
                        Some(Atom::Int(n)) => usize::try_from(n)?,
                        _ => return Err("groupTake needs a whole-number n.".into()),
                    };
                    Some((self.evaluate(args[3], &all)?, n))
                } else {
                    None
                };
                for members in groups.values_mut() {
                    members.sort_by(|a, b| {
                        self.order(order.get(*a, &self.arena), order.get(*b, &self.arena))
                            .then(a.cmp(b))
                    });
                    if let Some((value, n)) = &taken {
                        let list = members
                            .iter()
                            .take(*n)
                            .map(|row| value.get(*row, &self.arena))
                            .collect::<Vec<_>>();
                        let list = self.arena.list(list)?;
                        for row in members.iter() {
                            values[*row] = list;
                        }
                    } else {
                        for (rank, row) in members.iter().enumerate() {
                            values[*row] = Atom::Int(i64::try_from(rank)?);
                        }
                    }
                }
                for row in 0..self.len {
                    if order.failed.get(row)
                        || taken
                            .as_ref()
                            .is_some_and(|(value, _)| value.failed.get(row))
                    {
                        failed.set(row);
                    }
                }
            }
            Op::GroupTally => {
                let value = self.evaluate(args[2], &all)?;
                let display = self.evaluate(args[3], &all)?;
                for members in groups.values() {
                    // Each distinct value: its rows, and the code-unit-smallest display.
                    let mut tally = Vec::<(Atom, i64, Atom)>::new();
                    let mut positions = FxHashMap::<String, usize>::default();
                    for row in members {
                        if value.failed.get(*row) || display.failed.get(*row) {
                            failed.set(*row);
                            continue;
                        }
                        let item = value.get(*row, &self.arena);
                        if item == Atom::Null {
                            continue;
                        }
                        let key = self.key(item);
                        let shown = display.get(*row, &self.arena);
                        match positions.get(&key) {
                            Some(&at) => {
                                let entry = &mut tally[at];
                                entry.1 += 1;
                                if text::code_unit_compare(
                                    &self.text_of(shown),
                                    &self.text_of(entry.2),
                                )
                                .is_lt()
                                {
                                    entry.2 = shown;
                                }
                            }
                            None => {
                                positions.insert(key, tally.len());
                                tally.push((item, 1, shown));
                            }
                        }
                    }
                    tally.sort_by(|a, b| {
                        b.1.cmp(&a.1).then_with(|| {
                            text::code_unit_compare(&self.text_of(a.2), &self.text_of(b.2))
                        })
                    });
                    let entries = tally
                        .into_iter()
                        .map(|(item, count, shown)| {
                            self.arena.object(vec![
                                ("value", item),
                                ("count", Atom::Int(count)),
                                ("display", shown),
                            ])
                        })
                        .collect::<Result<Vec<_>>>()?;
                    let list = self.arena.list(entries)?;
                    for row in members {
                        values[*row] = list;
                    }
                }
            }
            _ => return Err(format!("{} is not a group aggregate.", op.name()).into()),
        }
        let mut column = Column::from_atoms(&values, &mut self.arena)?;
        column.failed = failed;
        Ok(column)
    }
    /// A display value's text for code-unit comparison; non-strings compare as their JSON.
    fn text_of(&self, value: Atom) -> String {
        match value {
            Atom::Str(id) => self.arena.text(id).to_owned(),
            Atom::Null => String::new(),
            _ => self.key(value),
        }
    }
    /// Whether a node reads nothing of its row: no field, occurrence list, finding or aggregate.
    fn item_only(&self, id: NodeId) -> bool {
        let mut pending = vec![id];
        while let Some(id) = pending.pop() {
            let node = &self.program.nodes[id];
            if node.op.is_aggregate()
                || matches!(
                    node.op,
                    Op::Field(_) | Op::Occurrences | Op::Finding(_) | Op::FindingField(..)
                )
            {
                return false;
            }
            pending.extend_from_slice(&node.args);
        }
        true
    }
    /// Whether a node reads the `item` variable anywhere below it.
    fn reads_item(&self, id: NodeId) -> bool {
        self.reads(id, |op| matches!(op, Op::Var(name) if &**name == "item"))
    }
    /// Whether the expression at `id` holds an operation `test` accepts.
    fn reads(&self, id: NodeId, test: impl Fn(&Op) -> bool) -> bool {
        let mut pending = vec![id];
        while let Some(id) = pending.pop() {
            let node = &self.program.nodes[id];
            if test(&node.op) {
                return true;
            }
            pending.extend_from_slice(&node.args);
        }
        false
    }
    /// `existsOther` (Phase 2 specification §3.1): whether some site of the row has another
    /// distinct tuple with the same `by` whose every `differing` value differs. Counted by
    /// inclusion–exclusion over distinct tuples, not pairwise.
    ///
    /// Tuples are distinct, so rows holding the same site list and row-level values (the same
    /// atoms) give the same answer: only the first such row is expanded into its sites. A line's
    /// cultures share their line's atoms. Tuple values compare by dense IDs of their keys.
    fn exists_other(&mut self, args: &[NodeId], all: &Selection) -> Result<Column> {
        let mut measure = Measure::start();
        let among = self.evaluate(args[1], all)?;
        let over = self.evaluate(args[2], all)?;
        let mut failed = Bits::new(self.len);
        let mut members = Vec::new();
        for row in 0..self.len {
            if among.failed.get(row) || over.failed.get(row) {
                failed.set(row);
            } else if among.get(row, &self.arena).boolean() {
                members.push(row);
            }
        }
        self.exists_other_stage("inputs", &mut measure, self.len);
        // `by` and each `differing` value, read per row unless they read the site.
        let differing = &self.program.nodes[args[3]];
        let listed = differing.op == Op::List;
        let mut parts = vec![args[0]];
        if listed {
            parts.extend_from_slice(&differing.args);
        } else {
            parts.push(args[3]);
        }
        let member_rows = all.select(&members, &mut self.arena)?;
        let mut row_values = Vec::with_capacity(parts.len());
        for part in &parts {
            row_values.push(if self.reads_item(*part) {
                None
            } else {
                Some(self.evaluate(*part, &member_rows)?)
            });
        }
        self.exists_other_stage("parts", &mut measure, members.len());
        // Rows share a signature only when the parts read per site read nothing of the row.
        let shared = parts
            .iter()
            .zip(&row_values)
            .all(|(part, value)| value.is_some() || self.item_only(*part));
        let mut ids = KeyIds::default();
        let mut signatures = FxHashMap::<Vec<Atom>, usize>::default();
        let mut representative = vec![usize::MAX; members.len()];
        let mut signature = Vec::with_capacity(parts.len() + 1);
        for (index, row) in members.iter().enumerate() {
            if row_values
                .iter()
                .flatten()
                .any(|column| column.failed.get(index))
            {
                failed.set(*row);
                continue;
            }
            if !shared {
                representative[index] = index;
                continue;
            }
            signature.clear();
            signature.push(over.get(*row, &self.arena));
            for column in row_values.iter().flatten() {
                signature.push(column.get(index, &self.arena));
            }
            representative[index] = match signatures.get(&signature) {
                Some(first) => *first,
                None => {
                    signatures.insert(signature.clone(), index);
                    index
                }
            };
        }
        let distinct_rows = signatures.len();
        drop(signatures);
        self.exists_other_stage("signatures", &mut measure, distinct_rows);
        // Expand each representative into its sites.
        let mut parents = Vec::new();
        let mut elements = Vec::new();
        for (index, row) in members.iter().enumerate() {
            if representative[index] != index {
                continue;
            }
            if let Some(sites) = self.arena.elements(over.get(*row, &self.arena))? {
                for site in sites {
                    parents.push(index);
                    elements.push(*site);
                }
            }
        }
        let mut expanded = member_rows.select(&parents, &mut self.arena)?;
        expanded.variables.insert(
            "item".into(),
            Column::from_atoms(&elements, &mut self.arena)?,
        );
        let mut element_values = Vec::with_capacity(parts.len());
        for (part, row_value) in parts.iter().zip(&row_values) {
            element_values.push(if row_value.is_none() {
                Some(self.evaluate(*part, &expanded)?)
            } else {
                None
            });
        }
        self.exists_other_stage("sites", &mut measure, elements.len());
        // Each site's tuple: the ID of its `by`, then of each `differing` value.
        let mut tuples = Vec::<Option<Box<[u32]>>>::with_capacity(elements.len());
        let mut width = listed.then(|| parts.len() - 1);
        let mut values = Vec::new();
        // A row with sites, every one with a null `by`, has a null key (§3): its result is null.
        let mut keyed = vec![false; members.len()];
        let mut sited = vec![false; members.len()];
        for (element, parent) in parents.iter().enumerate() {
            let row = members[*parent];
            sited[*parent] = true;
            if element_values
                .iter()
                .flatten()
                .any(|column| column.failed.get(element))
            {
                failed.set(row);
                tuples.push(None);
                continue;
            }
            values.clear();
            for (row_value, element_value) in row_values.iter().zip(&element_values) {
                values.push(match (row_value, element_value) {
                    (Some(column), _) => column.get(*parent, &self.arena),
                    (_, Some(column)) => column.get(element, &self.arena),
                    _ => Atom::Null,
                });
            }
            if values[0] == Atom::Null {
                tuples.push(None);
                continue;
            }
            keyed[*parent] = true;
            let mut tuple = vec![ids.of(values[0], &self.arena)];
            if listed {
                for value in &values[1..] {
                    tuple.push(ids.of(*value, &self.arena));
                }
            } else {
                let Some(listed) = self.arena.elements(values[1])? else {
                    tuples.push(None);
                    continue;
                };
                require(
                    *width.get_or_insert(listed.len()) == listed.len(),
                    "existsOther's differing lists must all have the same length.",
                )?;
                for value in listed {
                    tuple.push(ids.of(*value, &self.arena));
                }
            }
            tuples.push(Some(tuple.into()));
        }
        self.exists_other_stage("tuples", &mut measure, tuples.len());
        let width = width.unwrap_or(0);
        require(
            width < 16,
            "existsOther compares at most 15 differing values.",
        )?;
        // Distinct tuples counted per (subset of the differing dimensions, by, their values).
        let project = |subset: u32, tuple: &[u32], into: &mut Vec<u32>| {
            into.clear();
            into.push(subset);
            into.push(tuple[0]);
            for dimension in 0..width {
                if subset & (1 << dimension) != 0 {
                    into.push(tuple[dimension + 1]);
                }
            }
        };
        let distinct = tuples
            .iter()
            .flatten()
            .collect::<std::collections::HashSet<_>>();
        let mut counts = FxHashMap::<Box<[u32]>, i64>::default();
        let mut key = Vec::with_capacity(width + 2);
        for tuple in distinct {
            for subset in 0..1u32 << width {
                project(subset, tuple, &mut key);
                match counts.get_mut(&key[..]) {
                    Some(count) => *count += 1,
                    None => {
                        counts.insert(key.as_slice().into(), 1);
                    }
                }
            }
        }
        self.exists_other_stage("count", &mut measure, counts.len());
        let mut found = vec![false; members.len()];
        for (tuple, parent) in tuples.iter().zip(&parents) {
            let Some(tuple) = tuple else {
                continue;
            };
            let mut others = 0;
            for subset in 0..1u32 << width {
                project(subset, tuple, &mut key);
                let count = counts[&key[..]];
                others += if subset.count_ones() % 2 == 0 {
                    count
                } else {
                    -count
                };
            }
            if others > 0 {
                found[*parent] = true;
            }
        }
        let mut values = vec![Atom::Null; self.len];
        for (index, row) in members.iter().enumerate() {
            let first = representative[index];
            if first == usize::MAX {
                continue;
            }
            // A row fails with the row whose sites it shares.
            if failed.get(members[first]) {
                failed.set(*row);
            } else if keyed[first] || !sited[first] {
                values[*row] = Atom::Bool(found[first]);
            }
        }
        let mut column = Column::from_atoms(&values, &mut self.arena)?;
        column.failed = failed;
        self.exists_other_stage("match", &mut measure, self.len);
        Ok(column)
    }
    /// Each cross-row node's groups per subject row, over every row, as the aggregates evaluate
    /// them: `by` and `among`, an `existsOther` whose `by` reads the site per site, and a
    /// `corpusCount`'s `key` with its table. `None` when a node reads another rule's findings,
    /// which no rule has produced yet, or a variable bound outside it.
    fn cross_row_groups(
        &mut self,
        nodes: &[NodeId],
    ) -> Result<Option<Vec<super::incremental::NodeGroups>>> {
        use super::incremental::NodeGroups;
        let all = Selection::from_mask(Bits::all(self.len));
        let mut output = Vec::with_capacity(nodes.len());
        for &id in nodes {
            let op = self.program.nodes[id].op.clone();
            let args = self.program.nodes[id].args.clone();
            if args.iter().any(|arg| {
                self.reads(*arg, |op| {
                    matches!(op, Op::Finding(_) | Op::FindingField(..))
                })
            }) {
                return Ok(None);
            }
            let mut groups = NodeGroups {
                node: id,
                keyed: true,
                ..NodeGroups::default()
            };
            match op {
                Op::CorpusCount => {
                    // A key read per element of an enclosing lambda can't be read per row.
                    if self.reads_unbound(args[0], &[]) {
                        groups.keyed = false;
                    } else {
                        let key = self.evaluate(args[0], &all)?;
                        self.number_groups(&mut groups, &key, None)?;
                    }
                    let table = match self.corpus_tables.get(&id) {
                        Some(table) => Arc::clone(table),
                        None => {
                            let table = Arc::new(self.corpus_table(&args)?);
                            self.corpus_tables.insert(id, Arc::clone(&table));
                            table
                        }
                    };
                    let mut counts = table
                        .iter()
                        .map(|(key, count)| (super::incremental::key_hash(key), *count))
                        .collect::<Vec<_>>();
                    counts.sort_unstable();
                    groups.table = Some(counts);
                }
                Op::ExistsOther => {
                    if self.reads_unbound(args[0], &["item"])
                        || self.reads_unbound(args[1], &[])
                        || self.reads_unbound(args[2], &[])
                    {
                        return Ok(None);
                    }
                    if self.reads_item(args[0]) {
                        self.site_groups(&mut groups, &args, &all)?;
                    } else {
                        let by = self.evaluate(args[0], &all)?;
                        let among = self.evaluate(args[1], &all)?;
                        self.number_groups(&mut groups, &by, Some(&among))?;
                    }
                }
                _ => {
                    if self.reads_unbound(args[0], &[]) || self.reads_unbound(args[1], &[]) {
                        return Ok(None);
                    }
                    let by = self.evaluate(args[0], &all)?;
                    let among = self.evaluate(args[1], &all)?;
                    self.number_groups(&mut groups, &by, Some(&among))?;
                }
            }
            output.push(groups);
        }
        Ok(Some(output))
    }
    /// One group per row: its `by`, where `among` holds.
    fn number_groups(
        &self,
        groups: &mut super::incremental::NodeGroups,
        by: &Column,
        among: Option<&Column>,
    ) -> Result<()> {
        use super::incremental::{FAILED_GROUP, NO_GROUP, key_hash};
        let mut numbers = FxHashMap::<u64, u32>::default();
        groups.groups = Vec::with_capacity(self.len);
        for row in 0..self.len {
            if by.failed.get(row) || among.is_some_and(|among| among.failed.get(row)) {
                groups.groups.push(FAILED_GROUP);
                continue;
            }
            let value = by.get(row, &self.arena);
            if value == Atom::Null
                || among.is_some_and(|among| !among.get(row, &self.arena).boolean())
            {
                groups.groups.push(NO_GROUP);
                continue;
            }
            let number = Self::group_number(groups, &mut numbers, key_hash(&self.key(value)))?;
            groups.groups.push(number);
        }
        Ok(())
    }
    /// `existsOther` keyed by site: each member row's groups are its sites' `by` values. Rows
    /// with the same sites share them when `by` reads only the site, as in `exists_other`.
    fn site_groups(
        &mut self,
        groups: &mut super::incremental::NodeGroups,
        args: &[NodeId],
        all: &Selection,
    ) -> Result<()> {
        use super::incremental::{FAILED_GROUP, key_hash};
        let among = self.evaluate(args[1], all)?;
        let over = self.evaluate(args[2], all)?;
        let shared = self.item_only(args[0]);
        let mut first = FxHashMap::<Atom, usize>::default();
        let mut representative = vec![usize::MAX; self.len];
        let mut failed = Bits::new(self.len);
        let mut parents = Vec::new();
        let mut elements = Vec::new();
        for (row, representative) in representative.iter_mut().enumerate() {
            if among.failed.get(row) || over.failed.get(row) {
                failed.set(row);
                continue;
            }
            if !among.get(row, &self.arena).boolean() {
                continue;
            }
            let sites = over.get(row, &self.arena);
            if shared {
                if let Some(first) = first.get(&sites) {
                    *representative = *first;
                    continue;
                }
                first.insert(sites, row);
            }
            *representative = row;
            if let Some(list) = self.arena.elements(sites)? {
                for site in list {
                    parents.push(row);
                    elements.push(*site);
                }
            }
        }
        let mut expanded = all.select(&parents, &mut self.arena)?;
        expanded.variables.insert(
            "item".into(),
            Column::from_atoms(&elements, &mut self.arena)?,
        );
        let by = self.evaluate(args[0], &expanded)?;
        let mut numbers = FxHashMap::<u64, u32>::default();
        let mut sites = FxHashMap::<usize, Vec<u32>>::default();
        for (element, parent) in parents.iter().enumerate() {
            if by.failed.get(element) {
                failed.set(*parent);
                continue;
            }
            let value = by.get(element, &self.arena);
            if value != Atom::Null {
                let number = Self::group_number(groups, &mut numbers, key_hash(&self.key(value)))?;
                sites.entry(*parent).or_default().push(number);
            }
        }
        for numbers in sites.values_mut() {
            numbers.sort_unstable();
            numbers.dedup();
        }
        let mut starts = Vec::with_capacity(self.len + 1);
        starts.push(0);
        for (row, first) in representative.iter().enumerate() {
            if failed.get(row) || *first != usize::MAX && failed.get(*first) {
                groups.groups.push(FAILED_GROUP);
            } else if let Some(numbers) = sites.get(first) {
                groups.groups.extend_from_slice(numbers);
            }
            starts.push(u32::try_from(groups.groups.len())?);
        }
        groups.starts = Some(starts);
        Ok(())
    }
    fn group_number(
        groups: &mut super::incremental::NodeGroups,
        numbers: &mut FxHashMap<u64, u32>,
        hash: u64,
    ) -> Result<u32> {
        let next = u32::try_from(groups.hashes.len())?;
        let number = *numbers.entry(hash).or_insert(next);
        if number == next {
            groups.hashes.push(hash);
        }
        Ok(number)
    }
    /// Whether the expression at `id` reads a variable that neither `bound` nor one of its own
    /// lambdas binds.
    fn reads_unbound(&self, id: NodeId, bound: &[&str]) -> bool {
        let node = &self.program.nodes[id];
        // The arguments each operation evaluates with its element bound.
        let (variable, bodies): (Option<&str>, &[usize]) = match &node.op {
            Op::Var(name) => return !bound.contains(&&**name),
            Op::ExistsOther => (Some("item"), &[0, 3]),
            Op::CorpusCount => (Some("item"), &[1, 2]),
            op => (op.binding(), &[1, 2, 3]),
        };
        node.args
            .iter()
            .enumerate()
            .any(|(index, arg)| match variable {
                Some(variable) if bodies.contains(&index) => {
                    let mut inner = bound.to_vec();
                    inner.push(variable);
                    self.reads_unbound(*arg, &inner)
                }
                _ => self.reads_unbound(*arg, bound),
            })
    }
    /// Record one step of `existsOther` and start timing the next.
    fn exists_other_stage(&self, step: &str, measure: &mut Measure, rows: usize) {
        self.arena
            .recorder
            .sub_stage(format!("existsOther.{step}"), measure, rows);
        *measure = Measure::start();
    }
    /// `corpusCount` (Phase 2 specification §3.2): the corpus rows whose `by` equals the selected
    /// rows' `key`. The table is built once, from every occurrence in the project.
    fn corpus_count(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let args = self.program.nodes[id].args.clone();
        let table = match self.corpus_tables.get(&id) {
            Some(table) => Arc::clone(table),
            None => {
                let table = Arc::new(self.corpus_table(&args)?);
                self.corpus_tables.insert(id, Arc::clone(&table));
                table
            }
        };
        let keys = self.evaluate(args[0], selection)?;
        let values = (0..selection.len())
            .map(|index| match keys.get(index, &self.arena) {
                Atom::Null => Atom::Null,
                key => Atom::Int(table.get(&self.key(key)).copied().unwrap_or(0)),
            })
            .collect::<Vec<_>>();
        let mut column = Column::from_atoms(&values, &mut self.arena)?;
        column.failed = keys.failed.clone();
        Ok(column)
    }
    fn corpus_table(&mut self, args: &[NodeId]) -> Result<HashMap<String, i64>> {
        let mut table = HashMap::new();
        // The prepared occurrence relation: every occurrence in the project for native subjects.
        let len = self.arena.occurrences.len;
        if self.len == 0 || len == 0 {
            return Ok(table);
        }
        // Corpus rows have no subject row; `by` and `among` read only `item` (compiler).
        let mut corpus = Selection::new(vec![0]).select(&vec![0; len], &mut self.arena)?;
        let elements = (0..len)
            .map(|row| self.arena.occurrence_id(u32::try_from(row)?))
            .collect::<Result<Vec<_>>>()?;
        corpus.variables.insert(
            "item".into(),
            Column::from_atoms(&elements, &mut self.arena)?,
        );
        let among = self.evaluate(args[1], &corpus)?;
        let failed = "A corpus count failed on an occurrence.";
        require(!among.failed.any(), failed)?;
        // `by` runs only where `among` holds: a census key is costly and most rows don't count.
        let members = corpus.select_bits(&among.booleans(&self.arena), &mut self.arena)?;
        let by = self.evaluate(args[2], &members)?;
        require(!by.failed.any(), failed)?;
        for index in 0..members.len() {
            let key = by.get(index, &self.arena);
            if key != Atom::Null {
                *table.entry(self.key(key)).or_default() += 1;
            }
        }
        Ok(table)
    }
    fn short_circuit(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        if node.op != Op::Coalesce {
            let and = node.op == Op::And;
            let mut output = if and {
                Bits::all(selection.len())
            } else {
                Bits::new(selection.len())
            };
            let mut failed = Bits::new(selection.len());
            let mut pending = Bits::all(selection.len());
            for arg in &node.args {
                if !pending.any() {
                    break;
                }
                let narrowed = selection.select_bits(&pending, &mut self.arena)?;
                let values = self.evaluate(*arg, &narrowed)?;
                let truths = pending.deposit(&values.booleans(&self.arena));
                let failures = pending.deposit(&values.failed);
                for ((((out, later), failure), truth), error) in output
                    .words
                    .iter_mut()
                    .zip(&mut pending.words)
                    .zip(&mut failed.words)
                    .zip(&truths.words)
                    .zip(&failures.words)
                {
                    *failure |= error;
                    let decisive = *later & !error & if and { !truth } else { *truth };
                    if and {
                        *out &= !decisive;
                    } else {
                        *out |= decisive;
                    }
                    *later &= !error & if and { *truth } else { !truth };
                }
            }
            return Ok(Column {
                data: super::columns::Data::Bool(output),
                nulls: Bits::new(selection.len()),
                failed,
            });
        }
        let mut output = vec![
            if node.op == Op::Coalesce {
                Atom::Null
            } else {
                Atom::Bool(node.op == Op::And)
            };
            selection.len()
        ];
        let mut failed = Bits::new(selection.len());
        let mut pending = (0..selection.len()).collect::<Vec<_>>();
        for arg in &node.args {
            if pending.is_empty() {
                break;
            }
            let narrowed = selection.select(&pending, &mut self.arena)?;
            let values = self.evaluate(*arg, &narrowed)?;
            let mut later = Vec::new();
            for (index, destination) in pending.iter().copied().enumerate() {
                let value = values.get(index, &self.arena);
                if values.failed.get(index) {
                    failed.set(destination);
                } else if node.op == Op::Coalesce {
                    if value == Atom::Null {
                        later.push(destination);
                    } else {
                        output[destination] = value;
                    }
                } else if value.boolean() == (node.op == Op::Or) {
                    output[destination] = Atom::Bool(node.op == Op::Or);
                } else {
                    later.push(destination);
                }
            }
            pending = later;
        }
        let mut column = Column::from_atoms(&output, &mut self.arena)?;
        column.failed = failed;
        Ok(column)
    }
    fn conditional(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        let condition = self.evaluate(node.args[0], selection)?;
        // Branch rows as bitsets. When both branches give the same plain scalar type, they are
        // written into one column; otherwise the rows are joined as atoms, as below.
        let len = selection.len();
        let truths = condition.booleans(&self.arena);
        let mut untrue = Bits::all(len);
        for ((word, truth), failure) in untrue
            .words
            .iter_mut()
            .zip(&truths.words)
            .zip(&condition.failed.words)
        {
            *word &= !truth & !failure;
        }
        let mut branches = Vec::with_capacity(2);
        for (branch, rows) in [(node.args[1], truths), (node.args[2], untrue)] {
            let narrowed = selection.select_bits(&rows, &mut self.arena)?;
            branches.push((rows, self.evaluate(branch, &narrowed)?));
        }
        let plain = |column: &Column| match &column.data {
            super::columns::Data::Bool(_) | super::columns::Data::Constant(Atom::Bool(_)) => {
                Some(0)
            }
            super::columns::Data::Int(_) | super::columns::Data::Constant(Atom::Int(_)) => Some(1),
            super::columns::Data::Num(_) | super::columns::Data::Constant(Atom::Num(_)) => Some(2),
            super::columns::Data::Str(_) | super::columns::Data::Constant(Atom::Str(_)) => Some(3),
            super::columns::Data::Constant(Atom::Null) => None,
            _ => Some(4),
        };
        let kinds = branches
            .iter()
            .filter_map(|(_, column)| plain(column))
            .collect::<HashSet<_>>();
        if kinds.len() <= 1 && !kinds.contains(&4) {
            let mut output = Column::constant(Atom::Null, len);
            output.failed = condition.failed.clone();
            for (rows, values) in &branches {
                output.scatter_mask(rows, values, &mut self.arena)?;
            }
            return Ok(output.folded());
        }
        let mut output = vec![Atom::Null; len];
        let mut failed = condition.failed.clone();
        for (rows, values) in &branches {
            for (index, destination) in rows.ones().enumerate() {
                output[destination as usize] = values.get(index, &self.arena);
                if values.failed.get(index) {
                    failed.set(destination as usize);
                }
            }
        }
        let mut column = Column::from_atoms(&output, &mut self.arena)?;
        column.failed = failed;
        Ok(column)
    }
    fn scalar(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        let columns = node
            .args
            .iter()
            .map(|arg| self.evaluate(*arg, selection))
            .collect::<Result<Vec<_>>>()?;
        let len = selection.len();
        // Every row has the same input: compute the one tuple as a one-row selection, through
        // the same memo and interning, and repeat its result. Failed or mixed-null rows take
        // the per-row path, so no row reaches a computation it would not have reached.
        let uniform = |column: &Column| {
            let nulls = column.nulls.count();
            matches!(column.data, super::columns::Data::Constant(_))
                && !column.failed.any()
                && (nulls == 0 || nulls == column.len())
        };
        if len > 1 && !super::vector::cheap(&node.op) && columns.iter().all(uniform) {
            let shortcut = Measure::start();
            let one = columns
                .iter()
                .map(|column| Column::constant(column.get(0, &self.arena), 1))
                .collect::<Vec<_>>();
            let single = self.scalar_columns(id, &Selection::from_mask(Bits::all(1)), one)?;
            let column = if single.failed.get(0) {
                let mut column = Column::constant(Atom::Null, len);
                column.failed = Bits::all(len);
                column
            } else {
                Column::constant(single.get(0, &self.arena), len)
            };
            // The one-row call recorded the kernel's time; the other rows are memo hits.
            self.arena
                .recorder
                .kernel(node.op.name(), &Measure::start(), len - 1, 0, len - 1);
            self.arena
                .recorder
                .sub_stage(format!("{}.constant", node.op.name()), &shortcut, len);
            return Ok(column);
        }
        self.scalar_columns(id, selection, columns)
    }
    fn scalar_columns(
        &mut self,
        id: NodeId,
        selection: &Selection,
        columns: Vec<Column>,
    ) -> Result<Column> {
        let node = &self.program.nodes[id];
        let cache = self.cache_ids[id];
        let mut started = Measure::start();
        let mut failures = Bits::new(selection.len());
        for column in &columns {
            failures.union(&column.failed);
        }
        if super::vector::cheap(&node.op) {
            use super::columns::Data;
            if node.op == Op::IsNull
                || (node.op == Op::Not
                    && matches!(columns[0].data, Data::Bool(_) | Data::Constant(_)))
            {
                let mut bits = if node.op == Op::IsNull {
                    columns[0].nulls.clone()
                } else {
                    match &columns[0].data {
                        Data::Bool(values) => {
                            let mut bits = Bits::all(selection.len());
                            for ((word, value), null) in bits
                                .words
                                .iter_mut()
                                .zip(&values.words)
                                .zip(&columns[0].nulls.words)
                            {
                                *word &= !value | null;
                            }
                            bits
                        }
                        Data::Constant(value) => {
                            if value.boolean() {
                                Bits::new(selection.len())
                            } else {
                                Bits::all(selection.len())
                            }
                        }
                        _ => unreachable!(),
                    }
                };
                for (word, failed) in bits.words.iter_mut().zip(&failures.words) {
                    *word &= !failed;
                }
                self.arena.recorder.kernel(
                    node.op.name(),
                    &started,
                    selection.len(),
                    selection.len(),
                    0,
                );
                return Ok(Column {
                    data: Data::Bool(bits),
                    nulls: failures.clone(),
                    failed: failures,
                });
            }
            // Rows run in parallel; the first error any row hits is the operator's.
            let error = std::sync::Mutex::new(None::<Error>);
            let len = selection.len();
            let arena = &self.arena;
            let run = |row: usize, inputs: &mut Vec<Atom>| {
                inputs.clear();
                inputs.extend(columns.iter().map(|column| column.get(row, arena)));
                super::vector::run(arena, &node.op, inputs).unwrap_or_else(|cause| {
                    let mut first = error
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    first.get_or_insert(cause);
                    Atom::Null
                })
            };
            if node.result == super::compiler::Type::Bool {
                let words =
                    started.fill(len.div_ceil(64), 256, |start, words: &mut [(u64, u64)]| {
                        let mut inputs = Vec::with_capacity(columns.len());
                        for (offset, (bits, nulls)) in words.iter_mut().enumerate() {
                            let word = start + offset;
                            *nulls = failures.words[word];
                            for row in word * 64..((word + 1) * 64).min(len) {
                                if failures.get(row) {
                                    continue;
                                }
                                match run(row, &mut inputs) {
                                    Atom::Bool(true) => *bits |= 1 << (row % 64),
                                    Atom::Null => *nulls |= 1 << (row % 64),
                                    _ => {}
                                }
                            }
                        }
                    });
                if let Some(cause) = error
                    .into_inner()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                {
                    return Err(cause);
                }
                let bits = Bits {
                    words: words.iter().map(|(bits, _)| *bits).collect(),
                    len,
                };
                let nulls = Bits {
                    words: words.iter().map(|(_, nulls)| *nulls).collect(),
                    len,
                };
                self.arena.recorder.kernel(
                    node.op.name(),
                    &started,
                    selection.len(),
                    selection.len(),
                    0,
                );
                return Ok(Column {
                    data: Data::Bool(bits),
                    nulls,
                    failed: failures,
                });
            }
            let output = started.fill(len, 4096, |start, slots: &mut [Atom]| {
                let mut inputs = Vec::with_capacity(columns.len());
                for (offset, slot) in slots.iter_mut().enumerate() {
                    let row = start + offset;
                    if !failures.get(row) {
                        *slot = run(row, &mut inputs);
                    }
                }
            });
            if let Some(cause) = error
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
            {
                return Err(cause);
            }
            let mut output = Column::from_atoms(&output, &mut self.arena)?;
            output.failed = failures;
            self.arena.recorder.kernel(
                node.op.name(),
                &started,
                selection.len(),
                selection.len(),
                0,
            );
            return Ok(output);
        }
        if !columns.is_empty()
            && matches!(
                &columns[0].data,
                super::columns::Data::Str(_) | super::columns::Data::Constant(Atom::Str(_))
            )
        {
            // A short, fixed scalar suffix gets a separate dense dictionary memo. Resolve
            // suffixes once per selection, rather than hashing them for every row.
            if let Some((suffixes, dense_rows)) =
                suffix_groups(&self.arena, &columns[1..], selection.len(), &mut started)
            {
                return self.dense_scalar(
                    id,
                    selection,
                    &columns,
                    failures,
                    DenseSelection {
                        suffixes,
                        groups: dense_rows,
                    },
                    started,
                );
            }
        }
        // A bounded chunk of rows at a time: keys and memo hits in parallel, then the chunk's
        // misses deduplicated in row order, computed and committed before the next chunk
        // probes. A key is computed in the chunk where it first appears, so tasks still run
        // and intern in first-row order, and the dedup table stays the size of a chunk.
        let len = selection.len();
        let arity = columns.len();
        let mut output = vec![Atom::Null; len];
        let mut limited = Vec::<u32>::new();
        // (row, task): the rows whose result a task computes.
        let mut misses = Vec::<(u32, u32)>::new();
        let mut keys = Vec::<TupleKey>::new();
        // Each task's tuple, `arity` atoms at a time.
        let mut atoms = Vec::<Atom>::new();
        let mut missing = FxHashMap::<TupleKey, u32>::default();
        let mut results = Vec::<Slot>::new();
        let mut tuple = vec![Atom::Null; arity];
        let mut phases = <[PhaseTime; 5]>::default();
        let mut distinct_inputs = 0;
        let nested = self.arena.recorder.kernel_wall();
        const CHUNK: usize = 1 << 16;
        for chunk in (0..len).step_by(CHUNK) {
            let mut probe = Measure::start();
            let probes = {
                let arena = &self.arena;
                let packer = &self.packer;
                let memo = &self.cache[cache];
                probe.fill(
                    (chunk + CHUNK).min(len) - chunk,
                    4096,
                    |start, probes: &mut [Probe]| {
                        let mut tuple = Vec::with_capacity(arity);
                        for (offset, probe) in probes.iter_mut().enumerate() {
                            let row = chunk + start + offset;
                            if failures.get(row) {
                                continue;
                            }
                            tuple.clear();
                            tuple.extend(columns.iter().map(|column| column.get(row, arena)));
                            *probe = match packer.try_key(&tuple) {
                                Some(key) => match memo.get(&key) {
                                    Some(value) => Probe::Hit(*value),
                                    None => Probe::Miss(key),
                                },
                                None => Probe::Unpacked,
                            };
                        }
                    },
                )
            };
            probe.into_phase(&mut phases[0], &mut started);
            let claim = Measure::start();
            missing.clear();
            keys.clear();
            atoms.clear();
            misses.clear();
            for (offset, probe) in probes.into_iter().enumerate() {
                let row = chunk + offset;
                let key = match probe {
                    Probe::Failed => continue,
                    Probe::Hit(Slot::Value(value)) => {
                        output[row] = value;
                        continue;
                    }
                    Probe::Hit(Slot::Limit) => {
                        limited.push(row as u32);
                        continue;
                    }
                    Probe::Miss(key) => key,
                    Probe::Unpacked => {
                        for (atom, column) in tuple.iter_mut().zip(&columns) {
                            *atom = column.get(row, &self.arena);
                        }
                        let key = self.packer.key(&tuple);
                        match self.cache[cache].get(&key) {
                            Some(Slot::Value(value)) => {
                                output[row] = *value;
                                continue;
                            }
                            Some(Slot::Limit) => {
                                limited.push(row as u32);
                                continue;
                            }
                            None => key,
                        }
                    }
                };
                let next = u32::try_from(keys.len())?;
                let task = *missing.entry(key).or_insert_with(|| {
                    keys.push(key);
                    atoms.extend(columns.iter().map(|column| column.get(row, &self.arena)));
                    next
                });
                misses.push((row as u32, task));
            }
            claim.into_phase(&mut phases[1], &mut started);
            if keys.is_empty() {
                continue;
            }
            let task_tuple = |task: usize| &atoms[task * arity..(task + 1) * arity];
            if matches!(node.op, Op::MatchesRole | Op::PathHasPrefix) {
                // Prepare each shared occurrence bitset before tuple workers start, avoiding
                // competing first-use builds of the same role or prefix in the Rayon pool.
                let roles = (0..keys.len())
                    .filter_map(|task| match task_tuple(task) {
                        [Atom::Val(_), Atom::Str(key)] => Some(*key),
                        _ => None,
                    })
                    .collect::<HashSet<_>>();
                for key in roles {
                    self.kernel
                        .occurrence_mask(&self.arena, key, node.op == Op::MatchesRole)?;
                }
            }
            distinct_inputs += keys.len();
            self.cache[cache].reserve(keys.len());
            results.clear();
            // Bound temporary structured results while keeping interning order stable.
            for batch in (0..keys.len()).collect::<Vec<_>>().chunks(4096) {
                let arena = &self.arena;
                let kernel = &self.kernel;
                let mut compute = Measure::start();
                let computed = compute
                    .parallel(batch, |task| {
                        let tuple = task_tuple(*task);
                        if node.op == Op::List {
                            return Ok(Computed::List(tuple.to_vec()));
                        }
                        match kernel.run(arena, &node.op, tuple) {
                            Ok(value) => Ok(arena
                                .find(&value)
                                .map_or(Computed::Out(value), Computed::Found)),
                            Err(error) if error.code == ErrorCode::LimitExceeded => {
                                Ok(Computed::Limit)
                            }
                            Err(error) => Err(error),
                        }
                    })
                    .into_iter()
                    .collect::<Result<Vec<_>>>()?;
                compute.into_phase(&mut phases[2], &mut started);
                let commit = Measure::start();
                for (task, value) in batch.iter().zip(computed) {
                    let result = match value {
                        Computed::List(values) => Slot::Value(self.arena.list(values)?),
                        Computed::Found(value) => Slot::Value(value),
                        Computed::Out(value) => Slot::Value(self.arena.build(value)?),
                        Computed::Limit => Slot::Limit,
                    };
                    self.cache[cache].insert(keys[*task], result);
                    results.push(result);
                }
                commit.into_phase(&mut phases[3], &mut started);
            }
            let gather = Measure::start();
            for (row, task) in misses.iter().copied() {
                match results[task as usize] {
                    Slot::Value(value) => output[row as usize] = value,
                    Slot::Limit => limited.push(row),
                }
            }
            gather.into_phase(&mut phases[4], &mut started);
        }
        let gather = Measure::start();
        // A row over its limit is null and failed.
        for row in limited {
            failures.set(row as usize);
        }
        let mut column = Column::from_atoms(&output, &mut self.arena)?;
        column.failed = failures;
        gather.into_phase(&mut phases[4], &mut started);
        self.phases(&node.op, "hashed", &phases, selection.len());
        started.exclude(self.arena.recorder.kernel_wall().saturating_sub(nested));
        self.arena.recorder.kernel(
            node.op.name(),
            &started,
            selection.len(),
            distinct_inputs,
            selection.len().saturating_sub(distinct_inputs),
        );
        Ok(column)
    }
    /// A memo kernel's phases as sub-stages: keys or probes, the serial claim, the parallel
    /// compute, the serial commit, and the gather into the output column.
    fn phases(&self, op: &Op, path: &str, phases: &[PhaseTime; 5], rows: usize) {
        for (name, phase) in ["keys", "claim", "compute", "commit", "gather"]
            .into_iter()
            .zip(phases)
        {
            self.arena
                .recorder
                .phase(format!("{}.{path}.{name}", op.name()), phase, rows);
        }
    }
    fn dense_scalar(
        &mut self,
        id: NodeId,
        selection: &Selection,
        columns: &[Column],
        mut failures: Bits,
        inputs: DenseSelection,
        mut started: Measure,
    ) -> Result<Column> {
        let DenseSelection { suffixes, groups } = inputs;
        let node = &self.program.nodes[id];
        let cache = self.cache_ids[id];
        let pattern = node.op == Op::FormatPattern;
        let neutral = Vec::new();
        let mut keys = suffixes.clone();
        if pattern {
            keys.push(neutral.clone());
        }
        let cache_groups = keys
            .iter()
            .map(|key| {
                if let Some(index) = self.dense[cache].iter().position(|(value, _)| value == key) {
                    index
                } else {
                    self.dense[cache].push((key.clone(), super::memo::DenseMemo::default()));
                    self.dense[cache].len() - 1
                }
            })
            .collect::<Vec<_>>();
        let mut phases = <[PhaseTime; 5]>::default();
        let mut keyed = Measure::start();
        if pattern {
            if self.parsed.len() < self.arena.string_count() {
                self.parsed.resize(self.arena.string_count(), None);
            }
            let parsed = &self.parsed;
            let mut missing = keyed.parallel_range(selection.len(), |row| {
                match columns[0].get(row, &self.arena) {
                    Atom::Str(text) if !failures.get(row) && parsed[text.0 as usize].is_none() => {
                        text.0
                    }
                    _ => u32::MAX,
                }
            });
            missing.retain(|text| *text != u32::MAX);
            missing.sort_unstable();
            missing.dedup();
            let unformatted = &self.unformatted;
            let parses = keyed.parallel(&missing, |text| {
                let text = self.arena.text(StrId(*text));
                if text.len() <= 1_000_000
                    && !text
                        .bytes()
                        .any(|byte| matches!(byte, b'{' | b'}' | b'`' | b'|'))
                {
                    Arc::clone(unformatted)
                } else {
                    Arc::new(Parsed::new(super::grammar::parse_pattern(text)))
                }
            });
            for (text, parse) in missing.into_iter().zip(parses) {
                self.parsed[text as usize] = Some(parse);
            }
        }
        let parsed = &self.parsed;
        // Each row's text and memo group in one word; `NONE` for failed and non-string rows.
        const NONE: u64 = u64::MAX;
        let key = |packed: u64| {
            (packed != NONE).then_some((StrId(packed as u32), (packed >> 32) as usize))
        };
        let row_keys = keyed.parallel_range(selection.len(), |row| {
            if failures.get(row) {
                return NONE;
            }
            let Atom::Str(text) = columns[0].get(row, &self.arena) else {
                return NONE;
            };
            let independent = pattern
                && parsed[text.0 as usize]
                    .as_ref()
                    .is_some_and(|parse| !parse.culture_dependent);
            let group = cache_groups[if independent {
                suffixes.len()
            } else {
                groups.get(row).copied().unwrap_or(0) as usize
            }];
            (group as u64) << 32 | u64::from(text.0)
        });
        keyed.into_phase(&mut phases[0], &mut started);
        // Most rows' inputs are in the memo already. Find the rest in parallel, then claim them
        // in row order, which is the order a pass over every row would claim them in.
        let mut claim = Measure::start();
        const CHUNK: usize = 1 << 16;
        let memos = &self.dense[cache];
        let unclaimed = claim.parallel_chunks(
            &(0..row_keys.len().div_ceil(CHUNK)).collect::<Vec<_>>(),
            1,
            |chunk| {
                (chunk * CHUNK..((chunk + 1) * CHUNK).min(row_keys.len()))
                    .filter(|row| {
                        key(row_keys[*row])
                            .is_some_and(|(text, group)| memos[group].1.missing(text.0 as usize))
                    })
                    .collect::<Vec<_>>()
            },
        );
        let mut tasks = Vec::new();
        for row in unclaimed.into_iter().flatten() {
            if let Some((text, group)) = key(row_keys[row])
                && self.dense[cache][group].1.claim(text.0 as usize)
            {
                tasks.push((text, group));
            }
        }
        let distinct_inputs = tasks.len();
        if pattern {
            // Every unformatted string validates to the same result for a culture: build it
            // once per group.
            let mut shared = HashMap::new();
            let mut formatted = Vec::with_capacity(tasks.len());
            for (text, group) in tasks {
                let parse = self.parsed[text.0 as usize]
                    .as_ref()
                    .ok_or("Missing parsed pattern.")?;
                if !Arc::ptr_eq(parse, &self.unformatted) {
                    formatted.push((text, group));
                    continue;
                }
                let value = match shared.get(&group) {
                    Some(value) => *value,
                    None => {
                        let culture = pattern_culture(&self.arena, &self.dense[cache][group].0);
                        let value = Slot::Value(
                            self.arena.build(
                                super::grammar::validate_pattern(
                                    self.unformatted.pattern.clone(),
                                    culture,
                                )
                                .into(),
                            )?,
                        );
                        shared.insert(group, value);
                        value
                    }
                };
                self.dense[cache][group].1.insert(text.0 as usize, value);
            }
            tasks = formatted;
        }
        claim.into_phase(&mut phases[1], &mut started);
        for batch in tasks.chunks(4096) {
            let mut compute = Measure::start();
            let computed = compute.parallel(
                batch,
                |(text, group)| -> Result<std::result::Result<Atom, super::out::Out>> {
                    let suffix = &self.dense[cache][*group].0;
                    let value = if pattern {
                        let parse = self.parsed[text.0 as usize]
                            .as_ref()
                            .ok_or("Missing parsed pattern.")?;
                        super::out::Out::from(super::grammar::validate_pattern(
                            parse.pattern.clone(),
                            pattern_culture(&self.arena, suffix),
                        ))
                    } else {
                        let mut inputs = Vec::with_capacity(suffix.len() + 1);
                        inputs.push(Atom::Str(*text));
                        inputs.extend_from_slice(suffix);
                        self.kernel.run(&self.arena, &node.op, &inputs)?
                    };
                    // Already-interned results resolve here, on the worker.
                    Ok(self.arena.find(&value).ok_or(value))
                },
            );
            compute.into_phase(&mut phases[2], &mut started);
            let commit = Measure::start();
            for ((text, group), value) in batch.iter().zip(computed) {
                let value = match value {
                    Ok(Ok(value)) => Slot::Value(value),
                    Ok(Err(value)) => Slot::Value(self.arena.build(value)?),
                    Err(error) if error.code == ErrorCode::LimitExceeded => Slot::Limit,
                    Err(error) => return Err(error),
                };
                self.dense[cache][*group].1.insert(text.0 as usize, value);
            }
            commit.into_phase(&mut phases[3], &mut started);
        }
        let mut gathered = Measure::start();
        let output = gather(&mut gathered, &mut failures, |row| {
            key(row_keys[row])
                .and_then(|(text, group)| self.dense[cache][group].1.get(text.0 as usize))
        });
        let mut output = Column::from_atoms(&output, &mut self.arena)?;
        output.failed = failures;
        gathered.into_phase(&mut phases[4], &mut started);
        self.phases(&node.op, "dense", &phases, selection.len());
        self.arena.recorder.kernel(
            node.op.name(),
            &started,
            selection.len(),
            distinct_inputs,
            selection.len().saturating_sub(distinct_inputs),
        );
        Ok(output)
    }
    fn list_operator(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        let input = self.evaluate(node.args[0], selection)?;
        if matches!(node.op, Op::Any(_) | Op::All(_)) {
            return self.list_boolean(id, selection, &input);
        }
        // Lists are small. Expansion/grouping is parallel by row chunk, with scalar bodies
        // evaluated over the element relation through the same distinct-tuple memo.
        let mut measure = Measure::start();
        let rows = (0..selection.len()).collect::<Vec<_>>();
        let groups = measure
            .parallel(&rows, |row| {
                let row = *row;
                if input.failed.get(row) {
                    return Ok(None);
                }
                Ok(self
                    .arena
                    .elements(input.get(row, &self.arena))?
                    .map(<[Atom]>::to_vec))
            })
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        self.arena
            .recorder
            .kernel(node.op.name(), &measure, 0, 0, 0);
        let mut parents = Vec::new();
        let mut elements = Vec::new();
        let mut offsets = vec![0];
        for group in &groups {
            for element in group.iter().flatten() {
                parents.push(offsets.len() - 1);
                elements.push(*element);
            }
            offsets.push(elements.len());
        }
        let mut expanded = selection.select(&parents, &mut self.arena)?;
        let variable = node.op.binding().unwrap_or("item").to_owned();
        expanded
            .variables
            .insert(variable, Column::from_atoms(&elements, &mut self.arena)?);
        let body = if node.args.len() > 1 {
            self.evaluate(node.args[1], &expanded)?
        } else {
            Column::from_atoms(&elements, &mut self.arena)?
        };
        let mut failed = input.failed.clone();
        let mut output = Vec::with_capacity(groups.len());
        for (row, group) in groups.iter().enumerate() {
            if group.is_none() {
                output.push(Atom::Null);
                continue;
            }
            let mut values = Vec::new();
            let mut sorted = Vec::new();
            for index in offsets[row]..offsets[row + 1] {
                if body.failed.get(index) {
                    failed.set(row);
                }
                let evaluated = body.get(index, &self.arena);
                match node.op {
                    Op::Filter(_) if evaluated.boolean() => values.push(elements[index]),
                    Op::Map(_) => values.push(evaluated),
                    Op::FlatMap(_) => {
                        if let Some(elements) = self.arena.elements(evaluated)? {
                            values.extend_from_slice(elements);
                        }
                    }
                    Op::SortCodeUnit | Op::SortLocale => sorted.push((elements[index], evaluated)),
                    _ => {}
                }
            }
            if matches!(node.op, Op::SortCodeUnit | Op::SortLocale) {
                sorted.sort_by(|a, b| {
                    let a = if let Atom::Str(id) = a.1 {
                        self.arena.text(id)
                    } else {
                        ""
                    };
                    let b = if let Atom::Str(id) = b.1 {
                        self.arena.text(id)
                    } else {
                        ""
                    };
                    if node.op == Op::SortLocale {
                        self.kernel.collator.compare(a, b)
                    } else {
                        text::code_unit_compare(a, b)
                    }
                });
                values = sorted.into_iter().map(|(value, _)| value).collect();
            }
            output.push(self.arena.list(values)?);
        }
        let mut column = Column::from_atoms(&output, &mut self.arena)?;
        column.failed = failed;
        Ok(column)
    }
    fn list_boolean(
        &mut self,
        id: NodeId,
        selection: &Selection,
        input: &Column,
    ) -> Result<Column> {
        let node = &self.program.nodes[id];
        let all = matches!(node.op, Op::All(_));
        let mut failed = input.failed.clone();
        let mut output = vec![Atom::Null; selection.len()];
        let mut pending = Vec::new();
        for (row, destination) in output.iter_mut().enumerate() {
            if !failed.get(row)
                && let Some(elements) = self.arena.elements(input.get(row, &self.arena))?
            {
                *destination = Atom::Bool(all);
                if !elements.is_empty() {
                    pending.push(row);
                }
            }
        }
        let variable = node.op.binding().unwrap_or("item").to_owned();
        let mut offset = 0;
        while !pending.is_empty() {
            let mut expanded = selection.select(&pending, &mut self.arena)?;
            let elements = pending
                .iter()
                .map(|row| {
                    Ok(self
                        .arena
                        .elements(input.get(*row, &self.arena))?
                        .ok_or("Missing pending list.")?[offset])
                })
                .collect::<Result<Vec<_>>>()?;
            expanded.variables.insert(
                variable.clone(),
                Column::from_atoms(&elements, &mut self.arena)?,
            );
            let body = self.evaluate(node.args[1], &expanded)?;
            let mut later = Vec::new();
            for (index, row) in pending.into_iter().enumerate() {
                if body.failed.get(index) {
                    failed.set(row);
                } else if body.get(index, &self.arena).boolean() != all {
                    output[row] = Atom::Bool(!all);
                } else if self
                    .arena
                    .elements(input.get(row, &self.arena))?
                    .ok_or("Missing list.")?
                    .len()
                    > offset + 1
                {
                    later.push(row);
                }
            }
            pending = later;
            offset += 1;
        }
        let mut column = Column::from_atoms(&output, &mut self.arena)?;
        column.failed = failed;
        Ok(column)
    }
    fn diagnostics(&mut self, len: usize) -> Result<Vec<Diagnostic>> {
        let checkable = self.prepared.field("line.checkable")?.clone();
        let comparable = self.prepared.field("line.comparable")?.clone();
        let gathered = self.prepared.field("line.gathered")?.clone();
        let latest = self.prepared.field("latest")?.clone();
        let reasons = self.prepared.field("unknownReasons")?.clone();
        let reduced = self.prepared.field("reducedSourceChecking")?.clone();
        // The row sets, the issue codes and the output are built in parallel and kept in row
        // order; their time is recorded as one `diagnostics` kernel.
        let mut work = Measure::start();
        let nested = self.arena.recorder.kernel_wall();
        let source_rows = Bits {
            words: work.parallel_range(len.div_ceil(64), |word| {
                (word * 64..((word + 1) * 64).min(len))
                    .filter(|row| {
                        self.restrict.as_ref().is_none_or(|rows| rows.get(*row))
                            && checkable.get(*row, &self.arena).boolean()
                            && comparable.get(*row, &self.arena).boolean()
                    })
                    .fold(0u64, |bits, row| bits | 1 << (row % 64))
            }),
            len,
        };
        let mut translation_rows = source_rows.clone();
        translation_rows.retain(|row| latest.get(row as usize, &self.arena) != Atom::Null);
        const CHUNK: usize = 1 << 16;
        let mut issues = Vec::new();
        for (node, rows) in self
            .program
            .diagnostic_patterns
            .into_iter()
            .zip([source_rows, translation_rows])
        {
            let rows = rows.ones().collect::<Vec<_>>();
            let selection = Selection::new(rows);
            let patterns = self.evaluate(node, &selection)?;
            let rows = selection.rows.iter().collect::<Vec<_>>();
            // (row, code) in row order; a row keeps every code it has, duplicates included.
            let arena = &self.arena;
            let codes = work.parallel_chunks(
                &(0..rows.len().div_ceil(CHUNK)).collect::<Vec<_>>(),
                1,
                |&chunk| -> Result<Vec<(u32, u8)>> {
                    let mut codes = Vec::new();
                    let first = chunk * CHUNK;
                    for (index, row) in rows.iter().enumerate().skip(first).take(CHUNK) {
                        let found = arena.get_path(patterns.get(index, arena), "issues");
                        for issue in arena.elements(found)?.unwrap_or_default() {
                            if let Atom::Str(code) = arena.get_path(*issue, "code") {
                                let code = match arena.text(code) {
                                    "unsupported_culture" => UNSUPPORTED_CULTURE,
                                    "syntax_limit" => SYNTAX_LIMIT,
                                    _ => continue,
                                };
                                codes.push((*row, code));
                            }
                        }
                    }
                    Ok(codes)
                },
            );
            let mut all = Vec::new();
            for chunk in codes {
                all.extend(chunk?);
            }
            issues.push(all);
        }
        // The two passes stay adjacent for each line, preserving duplicate diagnostics. Chunks
        // start at a line's first row, so each line is emitted whole by one worker.
        let parents = checkable.rows.clone();
        let parent = |row: usize| parents.as_ref().map_or(row as u32, |parents| parents[row]);
        let mut starts = vec![0];
        let mut next = CHUNK;
        while next < len {
            while next < len && parent(next) == parent(next - 1) {
                next += 1;
            }
            if next < len {
                starts.push(next);
            }
            next += CHUNK;
        }
        let arena = &self.arena;
        let restrict = self.restrict.as_ref();
        let chunks = work.parallel_chunks(
            &(0..starts.len()).collect::<Vec<_>>(),
            1,
            |&chunk| -> Result<Vec<Diagnostic>> {
                let stop = starts.get(chunk + 1).copied().unwrap_or(len);
                // Each pass's codes from this chunk's first row on, read forward with the rows.
                let mut cursors = issues
                    .iter()
                    .map(|codes| codes.partition_point(|(at, _)| (*at as usize) < starts[chunk]))
                    .collect::<Vec<_>>();
                let mut codes = |pass: usize, row: usize| {
                    let codes = &issues[pass];
                    while cursors[pass] < codes.len() && (codes[cursors[pass]].0 as usize) < row {
                        cursors[pass] += 1;
                    }
                    let from = cursors[pass];
                    while cursors[pass] < codes.len() && codes[cursors[pass]].0 as usize == row {
                        cursors[pass] += 1;
                    }
                    codes[from..cursors[pass]]
                        .iter()
                        .map(|(_, code)| *code)
                        .collect::<Vec<_>>()
                };
                let mut output = Vec::new();
                let mut first = starts[chunk];
                while first < stop {
                    let mut end = first + 1;
                    while end < stop && parent(end) == parent(first) {
                        end += 1;
                    }
                    // An incremental evaluation restricts whole lines.
                    if restrict.is_some_and(|rows| !rows.get(first)) {
                        first = end;
                        continue;
                    }
                    for row in first..end {
                        for reason in arena.elements(reasons.get(row, arena))?.unwrap_or_default() {
                            if let Atom::Str(reason) = reason {
                                output.push(Diagnostic::new(
                                    row,
                                    diagnostic_code(arena.text(*reason))?,
                                )?);
                            }
                        }
                        if reduced.get(row, arena).boolean() {
                            output.push(Diagnostic::new(row, REDUCED_SOURCE_CHECKING)?);
                        }
                    }
                    if checkable.get(first, arena).boolean() {
                        for row in first..end {
                            if !gathered.get(row, arena).boolean() {
                                output.push(Diagnostic::new(row, SOURCE_UNAVAILABLE)?);
                            }
                            let absent = latest.get(row, arena) == Atom::Null;
                            if !comparable.get(row, arena).boolean() {
                                if absent {
                                    output.push(Diagnostic::new(row, TRANSLATION_UNAVAILABLE)?);
                                }
                                continue;
                            }
                            for code in codes(0, row) {
                                output.push(Diagnostic::new(row, code)?);
                            }
                            if absent {
                                output.push(Diagnostic::new(row, TRANSLATION_UNAVAILABLE)?);
                                continue;
                            }
                            for code in codes(1, row) {
                                output.push(Diagnostic::new(row, code)?);
                            }
                        }
                    }
                    first = end;
                }
                Ok(output)
            },
        );
        let mut output = Vec::new();
        for chunk in chunks {
            output.extend(chunk?);
        }
        work.exclude(self.arena.recorder.kernel_wall().saturating_sub(nested));
        self.arena.recorder.kernel("diagnostics", &work, len, 0, 0);
        Ok(output)
    }
    fn scope(&mut self, rule: &CompiledRule, len: usize) -> Result<Selection> {
        let mut selected = self.restrict.clone().unwrap_or_else(|| Bits::all(len));
        // Culture gates precede occurrence masks and every rule expression.
        if rule.rule.subject == Subject::Line {
            let culture = self.prepared.field("sourceCulture")?;
            selected.retain(|row| culture.get(row as usize, &self.arena) != Atom::Null);
        }
        if let Some(scope) = &rule.rule.scope {
            if rule.rule.subject != Subject::UnitSource
                && let Some(cultures) = &scope.cultures
            {
                let field = self.prepared.field(if rule.rule.subject == Subject::Line {
                    "sourceCulture"
                } else {
                    "culture"
                })?;
                let cultures = cultures
                    .iter()
                    .map(|culture| self.arena.string(culture).map(Atom::Str))
                    .collect::<Result<Vec<_>>>()?;
                selected.retain(|row| cultures.contains(&field.get(row as usize, &self.arena)));
            }
            let mut mask = |values: &Option<Vec<String>>, role: bool| -> Result<Option<Bits>> {
                let Some(values) = values else {
                    return Ok(None);
                };
                let mut mask = Bits::new(self.arena.occurrences.len);
                for value in values {
                    let key = self.arena.string(value)?;
                    mask.union(
                        self.kernel
                            .occurrence_mask(&self.arena, key, role)?
                            .as_ref(),
                    );
                }
                Ok(Some(mask))
            };
            let roles = mask(&scope.roles, true)?;
            let paths = mask(&scope.path_prefixes, false)?;
            if roles.is_some() || paths.is_some() {
                selected.retain(|row| {
                    self.prepared
                        .children
                        .members(row as usize)
                        .iter()
                        .any(|occurrence| {
                            roles
                                .as_ref()
                                .is_none_or(|mask| mask.get(*occurrence as usize))
                                && paths
                                    .as_ref()
                                    .is_none_or(|mask| mask.get(*occurrence as usize))
                        })
                });
            }
        }
        Ok(Selection::from_mask(selected))
    }
}
impl Program {
    /// Evaluate a subject's shared DAG over typed columns and ordered selections.
    pub fn evaluate(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
    ) -> Result<Evaluation> {
        self.evaluate_local(relation, collator, false)
            .map(|(evaluation, _, _)| evaluation)
    }
    /// Evaluate in a private arena and convert the findings while it is alive.
    fn evaluate_local(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
        include_diagnostics: bool,
    ) -> Result<(Evaluation, Recorder, Vec<Diagnostic>)> {
        let mut arena = Arena::new(relation.dictionary_len()?)?;
        let evaluated =
            self.evaluate_columns(relation, collator, include_diagnostics, &mut arena, None)?;
        let evaluation = Evaluation {
            findings: evaluated
                .findings
                .iter()
                .map(|finding| finding.emission(&arena))
                .collect(),
            diagnostics: evaluated.diagnostics,
            masks: evaluated.masks,
        };
        Ok((evaluation, evaluated.recorder, evaluated.projection))
    }
    #[cfg(test)]
    pub(crate) fn evaluate_timed(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
    ) -> Result<(Evaluation, super::stages::TestStats)> {
        self.evaluate_local(relation, collator, false)
            .map(|(evaluation, recorder, _)| (evaluation, recorder.node_stats(self)))
    }
    #[cfg(test)]
    pub(crate) fn evaluate_with_diagnostics(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
    ) -> Result<TimedEvaluation> {
        self.evaluate_local(relation, collator, true)
    }
    /// Evaluate in an arena shared across subjects; the findings stay typed in it.
    pub(crate) fn evaluate_shared(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
        arena: &mut Arena,
        delta: Option<&super::incremental::SubjectDelta>,
    ) -> Result<Evaluated> {
        self.evaluate_columns(relation, collator, true, arena, delta)
    }
    fn evaluate_columns(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
        include_diagnostics: bool,
        shared: &mut Arena,
        delta: Option<&super::incremental::SubjectDelta>,
    ) -> Result<Evaluated> {
        let subject = relation.subject();
        let include_diagnostics = include_diagnostics && subject == Subject::LineCulture;
        let len = relation.len();
        let rules = self
            .rules
            .iter()
            .filter(|rule| rule.rule.subject == subject)
            .collect::<Vec<_>>();
        let mut output = Evaluated {
            findings: Vec::new(),
            diagnostics: Vec::new(),
            masks: HashMap::new(),
            projection: Vec::new(),
            recorder: Recorder::default(),
            groups: Some(Vec::new()),
            evaluated: None,
        };
        if rules.is_empty() && !include_diagnostics {
            return Ok(output);
        }
        let mut names = HashSet::new();
        let mut nodes = HashSet::new();
        let mut pending = Vec::new();
        for rule in &rules {
            pending.extend(
                [
                    Some(rule.when),
                    Some(rule.actual),
                    Some(rule.expectation),
                    Some(rule.recovery),
                    rule.each,
                    rule.fix,
                    rule.affected,
                    rule.translation_origin,
                    rule.extra,
                    rule.shadowed,
                ]
                .into_iter()
                .flatten(),
            );
            if subject == Subject::Line {
                names.insert("sourceCulture".to_owned());
            }
            if subject != Subject::UnitSource
                && rule
                    .rule
                    .scope
                    .as_ref()
                    .is_some_and(|scope| scope.cultures.is_some())
            {
                names.insert(
                    if subject == Subject::Line {
                        "sourceCulture"
                    } else {
                        "culture"
                    }
                    .to_owned(),
                );
            }
        }
        if include_diagnostics {
            pending.extend(self.diagnostic_patterns);
            names.extend(
                [
                    "unknownReasons",
                    "reducedSourceChecking",
                    "line.checkable",
                    "line.gathered",
                    "line.comparable",
                    "latest",
                ]
                .into_iter()
                .map(str::to_owned),
            );
        }
        while let Some(id) = pending.pop() {
            if !nodes.insert(id) {
                continue;
            }
            let node = &self.nodes[id];
            pending.extend_from_slice(&node.args);
            if let Op::Field(name) = &node.op {
                names.insert(name.to_string());
            }
        }
        let mut names = names.into_iter().collect::<Vec<_>>();
        names.sort();
        let mut arena = std::mem::replace(shared, Arena::new(0)?);
        for node in &self.nodes {
            if node.op == Op::Get
                && let Some(key) = node.args.get(1).and_then(|arg| match &self.nodes[*arg].op {
                    Op::Lit(Literal::Str(text))
                    | Op::Field(text)
                    | Op::Var(text)
                    | Op::Finding(text) => Some(&**text),
                    _ => None,
                })
            {
                arena
                    .occurrence_fields
                    .insert(key.split('.').next().unwrap_or(key).to_owned());
            }
            if matches!(node.op, Op::MatchesRole | Op::PathHasPrefix) {
                arena.occurrence_fields.insert("location".into());
            }
        }
        if self.rules.iter().any(|rule| {
            rule.rule
                .scope
                .as_ref()
                .is_some_and(|scope| scope.roles.is_some() || scope.path_prefixes.is_some())
        }) {
            arena.occurrence_fields.insert("location".into());
        }

        let prepared = relation.prepare(&names, &mut arena, !rules.is_empty())?;
        prepared.validate(len)?;
        let recorder = arena.recorder.clone();
        let mut evaluator = Evaluator::new(self, arena, prepared, collator, len, subject)?;
        // Every cross-row node's groups, before any rule: the next evaluation's state, and what
        // this one compares with the previous to choose its rows.
        let closure = Measure::start();
        let mut cross = nodes
            .iter()
            .copied()
            .filter(|id| {
                matches!(
                    self.nodes[*id].op,
                    Op::GroupCount
                        | Op::GroupRank
                        | Op::GroupTake
                        | Op::GroupTally
                        | Op::ExistsOther
                        | Op::CorpusCount
                )
            })
            .collect::<Vec<_>>();
        cross.sort_unstable();
        output.groups = evaluator.cross_row_groups(&cross)?;
        if let (Some(delta), Some(groups)) = (delta, &output.groups) {
            evaluator.restrict = super::incremental::closure(len, delta, groups);
            output.evaluated.clone_from(&evaluator.restrict);
        }
        recorder.stage(
            subject_stage(subject, Phase::Closure),
            &closure,
            output.evaluated.as_ref().map_or(len, Bits::count),
        );
        recorder.enter(subject_stage(subject, Phase::Execute));
        let execute = Measure::start();
        let execute_workers = recorder.worker_adjustment();
        let mut emissions = Vec::new();
        // Each rule's phases, summed over rules: what the kernels inside `when` and the evidence
        // cost, and the per-row selection and emission loops no kernel covers.
        let mut rule_phases = <[PhaseTime; 6]>::default();
        for (execution, rule) in rules.into_iter().enumerate() {
            relation.checkpoint()?;
            let rule_measure = Measure::start();
            let span = (Measure::start(), recorder.worker_adjustment());
            let scope = evaluator.scope(rule, len)?;
            span.0
                .into_phase_nested(&mut rule_phases[0], recorder.worker_adjustment() - span.1);
            let span = (Measure::start(), recorder.worker_adjustment());
            let candidates = if let Some(each) = rule.each {
                let items = evaluator.evaluate(each, &scope)?;
                let mut parents = Vec::new();
                let mut elements = Vec::new();
                for (row, subject_row) in scope.rows.iter().enumerate() {
                    if items.failed.get(row) {
                        output
                            .diagnostics
                            .push(Diagnostic::new(subject_row, SYNTAX_LIMIT)?);
                        continue;
                    }
                    if let Some(values) =
                        evaluator.arena.elements(items.get(row, &evaluator.arena))?
                    {
                        for value in values {
                            parents.push(row);
                            elements.push(*value);
                        }
                    }
                }
                let mut candidates = scope.select(&parents, &mut evaluator.arena)?;
                candidates.variables.insert(
                    rule.rule.each_as.as_deref().unwrap_or("item").into(),
                    Column::from_atoms(&elements, &mut evaluator.arena)?,
                );
                candidates
            } else {
                scope
            };
            span.0
                .into_phase_nested(&mut rule_phases[1], recorder.worker_adjustment() - span.1);
            let span = (Measure::start(), recorder.worker_adjustment());
            let when = evaluator.evaluate(rule.when, &candidates)?;
            span.0
                .into_phase_nested(&mut rule_phases[2], recorder.worker_adjustment() - span.1);
            let span = (Measure::start(), recorder.worker_adjustment());
            let selected = if let Some(mask) = candidates.mask() {
                for row in mask.deposit(&when.failed).ones() {
                    output.diagnostics.push(Diagnostic::new(row, SYNTAX_LIMIT)?);
                }
                candidates.select_bits(&when.booleans(&evaluator.arena), &mut evaluator.arena)?
            } else {
                let mut selected = Vec::new();
                for (index, row) in candidates.rows.iter().enumerate() {
                    if when.failed.get(index) {
                        output.diagnostics.push(Diagnostic::new(row, SYNTAX_LIMIT)?);
                    } else if when.get(index, &evaluator.arena).boolean() {
                        selected.push(index);
                    }
                }
                candidates.select(&selected, &mut evaluator.arena)?
            };
            span.0
                .into_phase_nested(&mut rule_phases[3], recorder.worker_adjustment() - span.1);
            let span = (Measure::start(), recorder.worker_adjustment());
            let actual = evaluator.evaluate(rule.actual, &selected)?;
            let expectation = evaluator.evaluate(rule.expectation, &selected)?;
            let mut optional = |node| match node {
                Some(node) => evaluator.evaluate(node, &selected),
                None => Ok(Column::constant(Atom::Null, selected.len())),
            };
            let fix = optional(rule.fix)?;
            let extra = optional(rule.extra)?;
            let origin = optional(rule.translation_origin)?;
            let shadowed = optional(rule.shadowed)?;
            let affected = if let Some(node) = rule.affected {
                evaluator.evaluate(node, &selected)?
            } else {
                let values = selected
                    .rows
                    .iter()
                    .map(|row| evaluator.children(row as usize))
                    .collect::<Result<Vec<_>>>()?;
                Column::from_atoms(&values, &mut evaluator.arena)?
            };
            let recovery = evaluator.evaluate(rule.recovery, &selected)?;
            span.0
                .into_phase_nested(&mut rule_phases[4], recorder.worker_adjustment() - span.1);
            let span = (Measure::start(), recorder.worker_adjustment());
            let mut mask = Bits::new(len);
            for (index, row) in selected.rows.iter().enumerate() {
                if [
                    &actual,
                    &expectation,
                    &fix,
                    &extra,
                    &origin,
                    &shadowed,
                    &affected,
                    &recovery,
                ]
                .iter()
                .any(|column| column.failed.get(index))
                {
                    output.diagnostics.push(Diagnostic::new(row, SYNTAX_LIMIT)?);
                    continue;
                }
                let evidence = Evidence {
                    actual: actual.get(index, &evaluator.arena),
                    expectation: expectation.get(index, &evaluator.arena),
                    fix: fix.get(index, &evaluator.arena),
                    extra: extra.get(index, &evaluator.arena),
                    translation_origin: origin.get(index, &evaluator.arena),
                    shadowed: shadowed.get(index, &evaluator.arena),
                };
                let places = affected.get(index, &evaluator.arena);
                if evaluator.arena.elements(places)?.is_none() {
                    return Err("Finding affected must be an occurrence list.".into());
                }
                let recovery = recovery.get(index, &evaluator.arena);
                if !matches!(recovery, Atom::Str(_)) {
                    return Err("Finding recovery must be a string.".into());
                }
                mask.set(row as usize);
                let saved =
                    evaluator.evidence[rule.ordinal].get_or_insert_with(RuleEvidence::default);
                if saved.rows.last().copied() != Some(row) {
                    saved.rows.push(row);
                    saved.values.push(evidence);
                }
                emissions.push(Pending {
                    rule: rule.ordinal,
                    row,
                    subject,
                    evidence,
                    recovery,
                    affected: places,
                });
            }
            span.0
                .into_phase_nested(&mut rule_phases[5], recorder.worker_adjustment() - span.1);
            // Each rule's own time, and with heap counting its heap peak.
            recorder.sub_stage(
                format!(
                    "{}.{}",
                    subject_stage(subject, Phase::Execute),
                    rule.rule.id
                ),
                &rule_measure,
                len,
            );
            output.masks.insert(rule.ordinal, mask.words.clone());
            evaluator.masks.insert(rule.ordinal, mask);
            recorder.rule_done();
            for (node, last) in evaluator.node_last.iter().enumerate() {
                if *last == execution {
                    evaluator.cheap_columns[node] = None;
                }
            }
            for (cache, last) in evaluator.cache_last.iter().enumerate() {
                if *last == execution {
                    evaluator.cache[cache] = FxHashMap::default();
                    evaluator.dense[cache].clear();
                }
            }
            for (rule, last) in self.rule_last_reader.iter().enumerate() {
                if *last == execution {
                    evaluator.evidence[rule] = None;
                    evaluator.masks.remove(&rule);
                }
            }
        }
        let stage = subject_stage(subject, Phase::Execute);
        for (name, phase) in ["scope", "each", "when", "select", "evidence", "emit"]
            .into_iter()
            .zip(&rule_phases)
        {
            recorder.phase(format!("{stage}.rules.{name}"), phase, len);
        }
        recorder.holders(stage, evaluator.holders());
        recorder.stage_with_kernels(
            subject_stage(subject, Phase::Execute),
            &execute,
            len,
            execute_workers,
        );
        recorder.memory(subject_stage(subject, Phase::Execute), evaluator.memory());
        recorder.enter(subject_stage(subject, Phase::Diagnostics));
        let diagnostics_started = Measure::start();
        let diagnostic_workers = recorder.worker_adjustment();
        let diagnostics = if include_diagnostics {
            evaluator.diagnostics(len)?
        } else {
            Vec::new()
        };
        recorder.stage_with_kernels(
            subject_stage(subject, Phase::Diagnostics),
            &diagnostics_started,
            diagnostics.len(),
            diagnostic_workers,
        );
        recorder.memory(
            subject_stage(subject, Phase::Diagnostics),
            evaluator.memory(),
        );
        recorder.enter(subject_stage(subject, Phase::Emission));
        let mut emission = Measure::start();
        let sets = emissions
            .iter()
            .map(|pending| pending.affected)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let places = relation.affected(&mut evaluator.arena, &sets, &mut emission)?;
        output.findings = emissions
            .into_iter()
            .map(|pending| {
                let Atom::Str(recovery) = pending.recovery else {
                    return Err("Invalid finding recovery.".into());
                };
                Ok(Finding {
                    rule: pending.rule,
                    row: pending.row,
                    subject: pending.subject,
                    evidence: pending.evidence,
                    recovery,
                    affected: Arc::clone(&places[&pending.affected]),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        output
            .findings
            .sort_by_key(|finding| (finding.rule, finding.row));
        recorder.stage(
            subject_stage(subject, Phase::Emission),
            &emission,
            output.findings.len(),
        );
        recorder.memory(subject_stage(subject, Phase::Emission), evaluator.memory());
        *shared = evaluator.arena;
        output.projection = diagnostics;
        output.recorder = recorder;
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule(id: &str, when: Value, actual: Value) -> Value {
        json!({"id":id,"kind":id,"label":id,"subject":"unit_source","family":"source","severity":"normal","when":when,"actual":actual,"expectation":{"object":{"review":{"lit":true}}},"recovery":{"lit":"Review the saved text."}})
    }
    #[test]
    fn evaluates_references_elements_nulls_and_roles_without_a_target() -> Result<()> {
        let mut dependent = rule(
            "dependent",
            json!({"finding":"first"}),
            json!({"object":{"source":{"field":"source"},"missing":{"lit":null},"first":{"findingField":["first","actual.value"]}}}),
        );
        dependent["each"] = json!({"lit":["a","b"]});
        dependent["actual"]["object"]["element"] = json!({"var":"item"});
        let first = rule(
            "first",
            json!({"gt":[{"utf16Length":{"field":"source"}},{"lit":2}]}),
            json!({"object":{"value":{"lit":2}}}),
        );
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[],"rules":[dependent,first]}),
        )?)?;
        let mut relation = Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([(
                "source".into(),
                vec![json!("short"), json!("x"), json!("short")],
            )]),
            occurrences: vec![vec![]; 3],
        };
        let result = program.evaluate(&mut relation, &HostCollator::new("en")?)?;
        assert_eq!(result.findings.len(), 6);
        assert_eq!(result.masks[&0], vec![5]);
        assert_eq!(
            result.findings[0].actual,
            json!({"source":"short","first":2,"element":"a"})
        );
        assert_eq!(result.findings[1].actual["element"], "b");
        assert!(result.diagnostics.is_empty());
        Ok(())
    }
    fn evaluate_one(rule: Value, relation: &mut Relation) -> Result<Evaluation> {
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[],"rules":[rule]}),
        )?)?;
        program.evaluate(relation, &HostCollator::new("en")?)
    }
    fn unit_sources(sources: &[&str], occurrences: Vec<Vec<Value>>) -> Relation {
        Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([
                (
                    "source".into(),
                    sources.iter().map(|source| json!(source)).collect(),
                ),
                (
                    "textUnitId".into(),
                    (0..sources.len())
                        .map(|row| json!(format!("unit{row}")))
                        .collect(),
                ),
            ]),
            occurrences,
        }
    }
    #[test]
    fn group_aggregates_count_rank_take_and_tally_over_every_row() -> Result<()> {
        let initial = json!({"slice":[{"field":"source"},{"lit":0},{"lit":1}]});
        let order = json!({"list":[{"field":"source"}]});
        let groups = rule(
            "groups",
            json!({"eq":[{"groupRank":{"by":initial,"order":order}},{"lit":0}]}),
            json!({"object":{
                "count":{"groupCount":{"by":initial}},
                "take":{"groupTake":{"by":initial,"order":order,"value":{"field":"source"},"n":{"lit":1}}},
                "tally":{"groupTally":{"by":{"lit":"all"},"value":initial,"display":{"field":"source"}}}
            }}),
        );
        let mut relation = unit_sources(&["b2", "a", "b1", "c"], vec![vec![]; 4]);
        let result = evaluate_one(groups, &mut relation)?;
        // The owner of "b" is "b1", the first by order; ties would fall back to row order.
        let rows = result
            .findings
            .iter()
            .map(|finding| finding.row)
            .collect::<Vec<_>>();
        assert_eq!(rows, vec![1, 2, 3]);
        // Equal counts order by the shown text, which is the code-unit-smallest of its rows.
        let tally = json!([
            {"value":"b","count":2,"display":"b1"},
            {"value":"a","count":1,"display":"a"},
            {"value":"c","count":1,"display":"c"}
        ]);
        assert_eq!(
            result.findings[1].actual,
            json!({"count":2,"take":["b1"],"tally":tally})
        );
        assert_eq!(result.findings[0].actual["take"], json!(["a"]));
        Ok(())
    }
    #[test]
    fn exists_other_needs_another_identity_at_another_place() -> Result<()> {
        let duplicate = rule(
            "duplicate",
            json!({"existsOther":{
                "over":{"occurrences":[]},
                "by":{"field":"source"},
                "differing":{"list":[{"field":"textUnitId"},{"get":[{"var":"item"},{"lit":"packageFile"}]}]}
            }}),
            json!({"object":{"source":{"field":"source"}}}),
        );
        let place = |file: &str| vec![json!({"packageFile":file})];
        let mut relation = unit_sources(
            &["x", "x", "x", "y", "y", "z", "z"],
            vec![
                place("p1"),
                place("p1"),
                place("p2"),
                place("p3"),
                place("p4"),
                place("p5"),
                place("p5"),
            ],
        );
        // Rows 3 and 4 share an identity; rows 5 and 6 share a place.
        relation
            .fields
            .get_mut("textUnitId")
            .ok_or("Missing units.")?[4] = json!("unit3");
        let result = evaluate_one(duplicate.clone(), &mut relation)?;
        let rows = result
            .findings
            .iter()
            .map(|finding| finding.row)
            .collect::<Vec<_>>();
        assert_eq!(rows, vec![0, 1, 2]);
        // Random tuples against `DuplicateSources.hasOther` (`gt/duplicate-sources.ts`), with
        // `differing` written three ways: as a list, with a site value that also reads a field
        // (so rows never share a signature), and as an expression that yields a list.
        let site = json!({"get":[{"var":"item"},{"lit":"packageFile"}]});
        let mixed = json!({"concat":[site, {"slice":[{"field":"source"},{"lit":0},{"lit":0}]}]});
        let formulations = [
            json!({"list":[{"field":"textUnitId"}, site]}),
            json!({"list":[{"field":"textUnitId"}, mixed]}),
            json!({"if":[{"lit":true},{"list":[{"field":"textUnitId"}, site]},{"lit":[]}]}),
        ];
        let mut seed = 0x9e37_79b9_7f4a_7c15_u64;
        let mut random = |bound: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % bound) as usize
        };
        for _ in 0..50 {
            let rows = 1 + random(30);
            let sources = (0..rows)
                .map(|_| ["x", "y", "z"][random(3)])
                .collect::<Vec<_>>();
            let identities = (0..rows).map(|_| random(4)).collect::<Vec<_>>();
            let sites = (0..rows)
                .map(|_| (0..random(4)).map(|_| random(4)).collect::<Vec<_>>())
                .collect::<Vec<_>>();
            let occurrences = sites
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|site| json!({"packageFile":format!("p{site}")}))
                        .collect()
                })
                .collect();
            let mut relation = unit_sources(&sources, occurrences);
            relation.fields.insert(
                "textUnitId".into(),
                identities
                    .iter()
                    .map(|identity| json!(format!("i{identity}")))
                    .collect(),
            );
            let tuples = (0..rows)
                .flat_map(|row| sites[row].iter().map(move |site| (row, *site)))
                .collect::<Vec<_>>();
            // `count - identities - places + pairs > 0`, counted over this source's tuples.
            let has_other = |row: usize, site: usize| {
                let count = |test: &dyn Fn(usize, usize) -> bool| {
                    tuples
                        .iter()
                        .filter(|(other, place)| {
                            sources[*other] == sources[row] && test(*other, *place)
                        })
                        .count()
                };
                let identity = |other: usize, _| identities[other] == identities[row];
                let place = |_, other: usize| other == site;
                count(&|_, _| true) + count(&|other, at| identity(other, at) && place(other, at))
                    > count(&identity) + count(&place)
            };
            let expected = (0..rows)
                .filter(|row| sites[*row].iter().any(|site| has_other(*row, *site)))
                .collect::<Vec<_>>();
            for differing in &formulations {
                let mut rule = duplicate.clone();
                rule["when"]["existsOther"]["differing"] = differing.clone();
                let result = evaluate_one(rule, &mut relation)?;
                let actual = result
                    .findings
                    .iter()
                    .map(|finding| finding.row)
                    .collect::<Vec<_>>();
                assert_eq!(
                    actual, expected,
                    "{differing} {sources:?} {identities:?} {sites:?}"
                );
            }
        }
        Ok(())
    }
    #[test]
    fn aggregates_order_numbers_by_value_and_group_equal_values() -> Result<()> {
        // Arithmetic yields floating-point numbers: 10.0 ranks after 2.0, not before it.
        let length = json!({"add":[{"utf16Length":{"field":"source"}},{"lit":0}]});
        // Equal values written differently: member order, and an integer against a float.
        let shape = json!({"if":[
            {"eq":[{"field":"source"},{"lit":"xx"}]},
            {"lit":{"a":1,"b":2}},
            {"object":{"b":{"lit":2.0},"a":{"lit":1}}}
        ]});
        let values = rule(
            "values",
            json!({"lit":true}),
            json!({"object":{
                "rank":{"groupRank":{"by":{"lit":"all"},"order":{"list":[length]}}},
                "first":{"groupTake":{"by":{"lit":"all"},"order":{"list":[length]},"value":{"field":"source"},"n":{"lit":1}}},
                "same":{"groupCount":{"by":shape}}
            }}),
        );
        let mut relation = unit_sources(&["yyyyyyyyyy", "xx"], vec![vec![]; 2]);
        let result = evaluate_one(values, &mut relation)?;
        let actual = result
            .findings
            .iter()
            .map(|finding| finding.actual.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            actual,
            vec![
                json!({"rank":1,"first":["xx"],"same":2}),
                json!({"rank":0,"first":["xx"],"same":2})
            ]
        );
        // -0 ties with 0, so relation order decides.
        let zero = json!({"mul":[{"lit":0},{"if":[{"eq":[{"field":"source"},{"lit":"a"}]},{"lit":1},{"lit":-1}]}]});
        let ranks = rule(
            "ranks",
            json!({"lit":true}),
            json!({"object":{"rank":{"groupRank":{"by":{"lit":"all"},"order":{"list":[zero]}}}}}),
        );
        let mut relation = unit_sources(&["a", "b"], vec![vec![]; 2]);
        let result = evaluate_one(ranks, &mut relation)?;
        let ranks = result
            .findings
            .iter()
            .map(|finding| finding.actual["rank"].clone())
            .collect::<Vec<_>>();
        assert_eq!(ranks, vec![json!(0), json!(1)]);
        Ok(())
    }
    #[test]
    fn exists_other_is_null_when_every_site_has_a_null_key() -> Result<()> {
        let other = rule(
            "other",
            json!({"lit":true}),
            json!({"object":{"other":{"existsOther":{
                "over":{"occurrences":[]},
                "by":{"lit":null},
                "differing":{"list":[{"field":"textUnitId"}]}
            }}}}),
        );
        let mut relation =
            unit_sources(&["x", "x"], vec![vec![json!({"packageFile":"p1"})], vec![]]);
        let result = evaluate_one(other, &mut relation)?;
        let actual = result
            .findings
            .iter()
            .map(|finding| finding.actual.clone())
            .collect::<Vec<_>>();
        // The first row's one site has a null key; the second row has no site, so no other.
        assert_eq!(actual, vec![json!({}), json!({"other":false})]);
        Ok(())
    }
    #[test]
    fn key_ids_agree_with_written_keys() -> Result<()> {
        let mut arena = Arena::new(0)?;
        let mut atoms = [
            json!(null),
            json!(false),
            json!(true),
            json!(0),
            json!(1),
            json!(1.0),
            json!(2.5),
            json!("1"),
            json!("a"),
            json!(""),
            json!([]),
            json!([null]),
            json!([[]]),
            json!({}),
            json!([1, "a"]),
            json!([1.0, "a"]),
            json!(["a", 1]),
            json!({"a": 1, "b": [2]}),
            json!({"b": [2.0], "a": 1}),
            json!({"a": "b"}),
            json!({"b": "a"}),
        ]
        .into_iter()
        .map(|value| arena.intern(ScalarValue::from_json(&value)))
        .collect::<Result<Vec<_>>>()?;
        let one = arena.string("a")?;
        let repeated = arena.object(vec![("a", Atom::Int(1)), ("a", Atom::Int(2))])?;
        let wrapped = Atom::Val(arena.structured(Structured::Scalar(Atom::Str(one)))?);
        atoms.extend([
            Atom::Int(3),
            Atom::Num(3.0f64.to_bits()),
            Atom::Num((-0.0f64).to_bits()),
            Atom::Num(f64::NAN.to_bits()),
            Atom::Num(f64::INFINITY.to_bits()),
            repeated,
            wrapped,
        ]);
        let key = |atom| {
            let mut key = String::new();
            super::super::identity::write_atom(&arena, atom, true, &mut key);
            key
        };
        let mut ids = KeyIds::default();
        for a in &atoms {
            for b in &atoms {
                assert_eq!(
                    ids.of(*a, &arena) == ids.of(*b, &arena),
                    key(*a) == key(*b),
                    "{} {}",
                    key(*a),
                    key(*b)
                );
            }
        }
        Ok(())
    }
    #[test]
    fn corpus_counts_build_one_table_and_read_only_the_corpus_row() -> Result<()> {
        let audience = |name: &str| json!({"get":[{"var":"item"},{"lit":name}]});
        let count = json!({"corpusCount":{
            "relation":{"lit":"corpus_occurrence"},
            "key":audience("audience"),
            "by":audience("audience"),
            "among":{"eq":[audience("unitStatus"),{"lit":"resolved"}]}
        }});
        let census = rule(
            "census",
            json!({"lit":true}),
            json!({"object":{"counts":{"map":[{"occurrences":[]},count]}}}),
        );
        let occurrence =
            |audience: &str, status: &str| json!({"audience":audience,"unitStatus":status});
        let mut relation = unit_sources(
            &["a", "b", "c"],
            vec![
                vec![occurrence("player", "resolved")],
                vec![occurrence("player", "unresolved")],
                vec![
                    occurrence("editor", "resolved"),
                    occurrence("player", "resolved"),
                ],
            ],
        );
        let result = evaluate_one(census, &mut relation)?;
        let counts = result
            .findings
            .iter()
            .map(|finding| finding.actual["counts"].clone())
            .collect::<Vec<_>>();
        assert_eq!(counts, vec![json!([2]), json!([2]), json!([1, 2])]);
        for invalid in [
            json!({"map":[{"occurrences":[]},{"groupCount":{"by":{"field":"source"}}}]}),
            json!({"corpusCount":{"relation":{"lit":"corpus_occurrence"},"key":{"lit":"x"},"by":{"field":"source"}}}),
            json!({"corpusCount":{"relation":{"lit":"line"},"key":{"lit":"x"},"by":{"var":"item"}}}),
            json!({"groupCount":{"by":{"field":"source"},"unknown":{"lit":true}}}),
        ] {
            let program = super::super::compile(&serde_json::to_string(&json!({
                "schemaVersion":4,"roles":[],
                "rules":[rule("invalid",json!({"lit":true}),json!({"object":{"value":invalid}}))]
            }))?);
            assert!(program.is_err(), "{invalid}");
        }
        Ok(())
    }
    #[test]
    fn regex_replace_and_max_of_follow_javascript() -> Result<()> {
        let values = rule(
            "values",
            json!({"lit":true}),
            json!({"object":{
                "indexes":{"regexReplace":[{"lit":"Items[1].Name{2}(\"Key\")"},{"lit":"\\[[^\\]]*\\]|\\{[^}]*\\}|\\(\"[^\"]*\"\\)"},{"lit":""}]},
                "dollars":{"regexReplace":[{"lit":"ab"},{"lit":"b"},{"lit":"[$&$$]"}]},
                "largest":{"maxOf":{"list":[{"lit":3},{"lit":5},{"lit":4}]}},
                "whole":{"maxOf":{"list":[{"add":[{"lit":1},{"lit":1}]},{"lit":1}]}},
                "none":{"maxOf":{"lit":[]}}
            }}),
        );
        let mut relation = unit_sources(&["a"], vec![vec![]]);
        let result = evaluate_one(values, &mut relation)?;
        // `none` is null, so the evidence leaves it out.
        assert_eq!(
            result.findings[0].actual,
            json!({"indexes":"Items.Name","dollars":"a[b$]","largest":5,"whole":2})
        );
        Ok(())
    }
    #[test]
    fn rejects_cycles_unknown_bindings_missing_parameters_and_invalid_types() -> Result<()> {
        for expression in [
            json!({"finding":"a"}),
            json!({"var":"missing"}),
            json!({"param":"missing"}),
            json!({"utf16Length":{"lit":42}}),
        ] {
            let rule = rule("a", expression, json!({"object":{}}));
            assert!(
                super::super::compile(&serde_json::to_string(
                    &json!({"schemaVersion":4,"roles":[],"rules":[rule]})
                )?)
                .is_err()
            );
        }
        Ok(())
    }
    #[test]
    fn source_terminology_preserves_both_boundary_sets_and_utf16_offsets() -> Result<()> {
        let rule = rule(
            "terms",
            json!({"lit":true}),
            json!({"object":{"terms":{"termMatches":[{"field":"source"},{"lit":"bad"},{"lit":false}]},"placeholders":{"termListMatches":[{"field":"source"},{"lit":["bad"]},{"lit":false},{"lit":"lmnu"}]}}}),
        );
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[],"rules":[rule]}),
        )?)?;
        let mut relation = Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([("source".into(), vec![json!("😀 bad_bad BAD bád")])]),
            occurrences: vec![vec![]],
        };
        let result = program.evaluate(&mut relation, &HostCollator::new("en")?)?;
        assert_eq!(
            result.findings[0].actual["terms"],
            json!([{"match":"bad","start":3,"end":6},{"match":"bad","start":7,"end":10},{"match":"BAD","start":11,"end":14}])
        );
        assert_eq!(
            result.findings[0].actual["placeholders"],
            json!([{"match":"BAD","start":11,"end":14}])
        );
        Ok(())
    }
    #[test]
    fn selections_memoize_shared_scalar_inputs_and_gate_evidence() -> Result<()> {
        let mut first = rule(
            "first",
            json!({"gt":[{"utf16Length":{"field":"source"}},{"lit":2}]}),
            json!({"object":{"length":{"utf16Length":{"field":"source"}}}}),
        );
        first["scope"] = json!({"pathPrefixes":["/Game/Allowed"]});
        let second = rule(
            "second",
            json!({"if":[{"eq":[{"field":"source"},{"lit":"bad"}]},{"regexTest":[{"lit":"x"},{"concat":[{"lit":"("}]},{"lit":""}]},{"lit":false}]}),
            json!({"object":{"unreachable":{"regexTest":[{"lit":"x"},{"concat":[{"lit":"("}]},{"lit":""}]}}}),
        );
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[],"rules":[first,second]}),
        )?)?;
        let mut relation = Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([(
                "source".into(),
                vec![json!("shared"), json!("shared"), json!("x")],
            )]),
            occurrences: vec![
                vec![json!({"location":{"objectPath":"/Game/Allowed.One"}})],
                vec![json!({"location":{"objectPath":"/Game/Allowed.Two"}})],
                vec![],
            ],
        };
        let (result, timings) = program.evaluate_timed(&mut relation, &HostCollator::new("en")?)?;
        assert_eq!(result.findings.len(), 2);
        assert_eq!(result.findings[0].actual, json!({"length":6}));
        assert_eq!(
            program
                .nodes
                .iter()
                .zip(&timings.nodes)
                .filter(|(node, _)| node.op == Op::Utf16Length)
                .map(|(_, timing)| timing.tuples)
                .sum::<usize>(),
            1
        );
        assert!(result.diagnostics.is_empty());
        Ok(())
    }
    #[test]
    fn constant_inputs_compute_once_and_repeat_the_per_row_result() -> Result<()> {
        let constant = rule(
            "constant",
            json!({"eq":[{"trim":{"lit":" shared "}},{"lit":"shared"}]}),
            json!({"object":{"trimmed":{"trim":{"lit":" shared "}},"missing":{"trim":{"lit":null}}}}),
        );
        let varying = rule(
            "varying",
            json!({"eq":[{"trim":{"field":"source"}},{"lit":"shared"}]}),
            json!({"object":{"trimmed":{"trim":{"field":"source"}}}}),
        );
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[],"rules":[constant,varying]}),
        )?)?;
        let mut relation = Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([(
                "source".into(),
                vec![json!(" shared "), json!("shared"), json!("x")],
            )]),
            occurrences: vec![vec![], vec![], vec![]],
        };
        let (result, _) = program.evaluate_timed(&mut relation, &HostCollator::new("en")?)?;
        let actual = result
            .findings
            .iter()
            .map(|finding| finding.actual.clone())
            .collect::<Vec<_>>();
        // A null field is omitted from the published object, as on the per-row path.
        assert_eq!(
            actual,
            [
                json!({"trimmed":"shared"}),
                json!({"trimmed":"shared"}),
                json!({"trimmed":"shared"}),
                json!({"trimmed":"shared"}),
                json!({"trimmed":"shared"}),
            ]
        );
        assert!(result.diagnostics.is_empty());
        Ok(())
    }
    #[test]
    fn scope_precedes_when_and_requires_one_matching_occurrence() -> Result<()> {
        let mut scoped = rule(
            "scoped",
            json!({"if":[{"eq":[{"field":"source"},{"lit":"bad"}]},{"regexTest":[{"lit":"x"},{"concat":[{"lit":"("}]},{"lit":""}]},{"lit":true}]}),
            json!({"object":{"checked":{"lit":true}}}),
        );
        scoped["scope"] = json!({"roles":["ui"],"pathPrefixes":["/Game/Other"]});
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[{"id":"ui","scopes":[{"matchers":[{"kind":"property_path","operator":"exact","value":"Label"}]}]}],"rules":[scoped]}),
        )?)?;
        let mut relation = Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([("source".into(), vec![json!("bad"), json!("safe")])]),
            occurrences: vec![
                vec![
                    json!({"location":{"kind":"asset_property","objectPath":"/Game/UI.Menu","propertyPath":"Label"}}),
                    json!({"location":{"kind":"asset_property","objectPath":"/Game/Other.Item","propertyPath":"Different"}}),
                ],
                vec![
                    json!({"location":{"kind":"asset_property","objectPath":"/Game/Other.Item","propertyPath":"Label"}}),
                ],
            ],
        };
        let result = program.evaluate(&mut relation, &HostCollator::new("en")?)?;
        assert_eq!(result.findings.len(), 1);
        assert_eq!(result.findings[0].row, 1);
        assert_eq!(result.masks[&0], vec![2]);
        Ok(())
    }
    #[test]
    fn list_boolean_selections_short_circuit_before_later_elements() -> Result<()> {
        let definition = rule(
            "lists",
            json!({"lit":true}),
            json!({"object":{
                "any":{"any":[{"lit":["stop","later"]},{"if":[{"eq":[{"var":"item"},{"lit":"stop"}]},{"lit":true},{"regexTest":[{"lit":"x"},{"concat":[{"lit":"("}]},{"lit":""}]}]}]},
                "all":{"all":[{"lit":["stop","later"]},{"if":[{"eq":[{"var":"item"},{"lit":"stop"}]},{"lit":false},{"regexTest":[{"lit":"x"},{"concat":[{"lit":"("}]},{"lit":""}]}]}]}
            }}),
        );
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[],"rules":[definition]}),
        )?)?;
        let mut relation = Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([("source".into(), vec![json!("same"), json!("same")])]),
            occurrences: vec![vec![]; 2],
        };
        let result = program.evaluate(&mut relation, &HostCollator::new("en")?)?;
        assert_eq!(result.findings.len(), 2);
        assert_eq!(result.findings[0].actual, json!({"any":true,"all":false}));
        Ok(())
    }
    #[test]
    fn typed_diagnostics_keep_two_pass_order_without_enabled_rules() -> Result<()> {
        struct Rows(Relation);
        impl SubjectRows for Rows {
            fn subject(&self) -> Subject {
                Subject::LineCulture
            }
            fn len(&self) -> usize {
                self.0.len()
            }
            fn field(&mut self, row: usize, name: &str) -> Result<Value> {
                self.0.field(row, name)
            }
            fn occurrences(&mut self, _row: usize) -> Result<Vec<Value>> {
                Ok(Vec::new())
            }
            fn prepare(
                &mut self,
                names: &[String],
                arena: &mut Arena,
                with_children: bool,
            ) -> Result<Prepared> {
                let mut prepared = self.0.prepare(names, arena, with_children)?;
                for (name, field) in &mut prepared.fields {
                    if name.starts_with("line.") {
                        field.rows = Some(Arc::from([0, 1, 1]));
                    }
                }
                Ok(prepared)
            }
        }
        let mut rows = Rows(Relation {
            subject: Some(Subject::LineCulture),
            fields: HashMap::from([
                (
                    "line.checkable".into(),
                    vec![json!(false), json!(true), json!(true)],
                ),
                ("line.comparable".into(), vec![json!(true); 3]),
                ("line.gathered".into(), vec![json!(false); 3]),
                (
                    "line.comparisonSource".into(),
                    vec![
                        json!(""),
                        json!("{Count}|plural(one=x,other=y)"),
                        json!("{Count}|plural(one=x,other=y)"),
                    ],
                ),
                ("culture".into(), vec![json!("zz"); 3]),
                ("latest".into(), vec![Value::Null, Value::Null, json!("")]),
                (
                    "unknownReasons".into(),
                    vec![
                        json!(["unresolved_identity"]),
                        json!(["missing_po"]),
                        json!(["source_unavailable"]),
                    ],
                ),
                (
                    "reducedSourceChecking".into(),
                    vec![json!(true), json!(false), json!(false)],
                ),
            ]),
            occurrences: Vec::new(),
        });
        let program = super::super::compile(r#"{"schemaVersion":4,"roles":[],"rules":[]}"#)?;
        let (result, _, diagnostics) =
            program.evaluate_with_diagnostics(&mut rows, &HostCollator::new("en")?)?;
        assert!(result.findings.is_empty());
        assert_eq!(
            diagnostics
                .into_iter()
                .map(|diagnostic| (diagnostic.row, diagnostic.name()))
                .collect::<Vec<_>>(),
            vec![
                (0, "unresolved_identity"),
                (0, "reduced_source_checking"),
                (1, "missing_po"),
                (2, "source_unavailable"),
                (1, "source_unavailable"),
                (1, "unsupported_culture"),
                (1, "translation_unavailable"),
                (2, "source_unavailable"),
                (2, "unsupported_culture")
            ]
        );
        Ok(())
    }
}
