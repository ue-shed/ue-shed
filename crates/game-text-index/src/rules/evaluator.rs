//! Column-at-a-time DAG evaluation with selection short circuiting and tuple memoization.
use super::HostCollator;
use super::columns::{
    Arena, Atom, Bits, Children, Column, FieldColumn, Occurrences, Prepared, StrId,
};
use super::compiler::{CompiledRule, Literal, NodeId, Op, Program, Subject};
use super::kernel::Kernel;
use super::selection::Selection;
use super::stages::{Measure, Phase, Recorder, subject_stage};
use super::text;
use super::tuple::{Key as TupleKey, Packer};
use super::value::Value as ScalarValue;
use crate::engine_types::REASONS;
use crate::{Error, ErrorCode, Result};
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
const OCCURRENCE_FIELDS: [&str; 6] = [
    "id",
    "packageFile",
    "source",
    "devNotes",
    "location",
    "unitStatus",
];
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
                && let super::columns::Structured::Occurrence(row) = arena.values[id.0 as usize]
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
                for name in OCCURRENCE_FIELDS {
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
    groups: Vec<usize>,
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
) -> Option<(Vec<Vec<Atom>>, Vec<usize>)> {
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
        return Some((vec![suffix(0)], vec![0; len]));
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
            .unwrap_or_default()
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
    let output = measure.parallel_range(len, |row| match slot(row) {
        Some(Slot::Value(value)) => value,
        _ => Atom::Null,
    });
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
    len: usize,
}
impl<'a> Evaluator<'a> {
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
            && selection.rows.iter().eq(0..self.len as u32)
        {
            let column = self.node(id, selection)?;
            self.cheap_columns[id] = Some((column.clone(), Bits::all(self.len)));
            return Ok(column);
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
            _ => self.scalar(id, selection),
        }
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
        let mut output = vec![Atom::Null; selection.len()];
        let mut failed = condition.failed.clone();
        for (branch, condition_value) in [(1, true), (2, false)] {
            let indices = (0..selection.len())
                .filter(|row| {
                    !condition.failed.get(*row)
                        && condition.get(*row, &self.arena).boolean() == condition_value
                })
                .collect::<Vec<_>>();
            let narrowed = selection.select(&indices, &mut self.arena)?;
            let values = self.evaluate(node.args[branch], &narrowed)?;
            for (index, destination) in indices.into_iter().enumerate() {
                output[destination] = values.get(index, &self.arena);
                if values.failed.get(index) {
                    failed.set(destination);
                }
            }
        }
        let mut column = Column::from_atoms(&output, &mut self.arena)?;
        column.failed = failed;
        Ok(column)
    }
    fn scalar(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        let cache = self.cache_ids[id];
        let columns = node
            .args
            .iter()
            .map(|arg| self.evaluate(*arg, selection))
            .collect::<Result<Vec<_>>>()?;
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
        // Keys and memo hits in parallel, a bounded chunk of rows at a time. Hits go straight to
        // the output; misses are deduplicated in row order, so interning order is unchanged.
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
        let mut tuple = vec![Atom::Null; arity];
        const CHUNK: usize = 1 << 16;
        for chunk in (0..len).step_by(CHUNK) {
            let probes = {
                let arena = &self.arena;
                let packer = &self.packer;
                let memo = &self.cache[cache];
                started.fill(
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
        }
        drop(missing);
        let task_tuple = |task: usize| &atoms[task * arity..(task + 1) * arity];
        let nested = self.arena.recorder.kernel_wall();
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
        let distinct_inputs = keys.len();
        // Bound temporary structured results while keeping interning order stable.
        let mut results = Vec::with_capacity(keys.len());
        for batch in (0..keys.len()).collect::<Vec<_>>().chunks(4096) {
            let arena = &self.arena;
            let kernel = &self.kernel;
            let computed = started
                .parallel(batch, |task| {
                    let tuple = task_tuple(*task);
                    if node.op == Op::List {
                        return Ok(Computed::List(tuple.to_vec()));
                    }
                    match kernel.run(arena, &node.op, tuple) {
                        Ok(value) => Ok(arena
                            .find(&value)
                            .map_or(Computed::Out(value), Computed::Found)),
                        Err(error) if error.code == ErrorCode::LimitExceeded => Ok(Computed::Limit),
                        Err(error) => Err(error),
                    }
                })
                .into_iter()
                .collect::<Result<Vec<_>>>()?;
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
        }
        for (row, task) in misses {
            match results[task as usize] {
                Slot::Value(value) => output[row as usize] = value,
                Slot::Limit => limited.push(row),
            }
        }
        // A row over its limit is null and failed.
        for row in limited {
            failures.set(row as usize);
        }
        let mut column = Column::from_atoms(&output, &mut self.arena)?;
        column.failed = failures;
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
        if pattern {
            if self.parsed.len() < self.arena.string_count() {
                self.parsed.resize(self.arena.string_count(), None);
            }
            let parsed = &self.parsed;
            let mut missing = started.parallel_range(selection.len(), |row| {
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
            let parses = started.parallel(&missing, |text| {
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
        let row_keys = started.parallel_range(selection.len(), |row| {
            if failures.get(row) {
                return None;
            }
            let Atom::Str(text) = columns[0].get(row, &self.arena) else {
                return None;
            };
            let independent = pattern
                && parsed[text.0 as usize]
                    .as_ref()
                    .is_some_and(|parse| !parse.culture_dependent);
            Some((
                text,
                cache_groups[if independent {
                    suffixes.len()
                } else {
                    groups[row]
                }],
            ))
        });
        let mut tasks = Vec::new();
        for (text, group) in row_keys.iter().flatten() {
            if self.dense[cache][*group].1.claim(text.0 as usize) {
                tasks.push((*text, *group));
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
        for batch in tasks.chunks(4096) {
            let computed = started.parallel(
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
            for ((text, group), value) in batch.iter().zip(computed) {
                let value = match value {
                    Ok(Ok(value)) => Slot::Value(value),
                    Ok(Err(value)) => Slot::Value(self.arena.build(value)?),
                    Err(error) if error.code == ErrorCode::LimitExceeded => Slot::Limit,
                    Err(error) => return Err(error),
                };
                self.dense[cache][*group].1.insert(text.0 as usize, value);
            }
        }
        let output = gather(&mut started, &mut failures, |row| {
            row_keys[row].and_then(|(text, group)| self.dense[cache][group].1.get(text.0 as usize))
        });
        let mut output = Column::from_atoms(&output, &mut self.arena)?;
        output.failed = failures;
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
        let source_rows = (0..len)
            .filter(|row| {
                checkable.get(*row, &self.arena).boolean()
                    && comparable.get(*row, &self.arena).boolean()
            })
            .map(|row| row as u32)
            .collect::<Vec<_>>();
        let translation_rows = source_rows
            .iter()
            .copied()
            .filter(|row| latest.get(*row as usize, &self.arena) != Atom::Null)
            .collect::<Vec<_>>();
        let mut issues = Vec::new();
        for (node, rows) in self
            .program
            .diagnostic_patterns
            .into_iter()
            .zip([source_rows, translation_rows])
        {
            let selection = Selection::new(rows);
            let patterns = self.evaluate(node, &selection)?;
            let mut codes = HashMap::<u32, Vec<u8>>::new();
            for (index, row) in selection.rows.iter().enumerate() {
                let found = self
                    .arena
                    .get_path(patterns.get(index, &self.arena), "issues");
                for issue in self.arena.elements(found)?.unwrap_or_default() {
                    let code = self.arena.get_path(*issue, "code");
                    if let Atom::Str(code) = code {
                        let code = match self.arena.text(code) {
                            "unsupported_culture" => UNSUPPORTED_CULTURE,
                            "syntax_limit" => SYNTAX_LIMIT,
                            _ => continue,
                        };
                        codes.entry(row).or_default().push(code);
                    }
                }
            }
            issues.push(codes);
        }
        // The two passes stay adjacent for each line, preserving duplicate diagnostics.
        let parents = checkable.rows.clone();
        let parent = |row: usize| parents.as_ref().map_or(row as u32, |parents| parents[row]);
        let mut output = Vec::new();
        let mut first = 0;
        while first < len {
            let mut end = first + 1;
            while end < len && parent(end) == parent(first) {
                end += 1;
            }
            for row in first..end {
                for reason in self
                    .arena
                    .elements(reasons.get(row, &self.arena))?
                    .unwrap_or_default()
                {
                    if let Atom::Str(reason) = reason {
                        output.push(Diagnostic::new(
                            row,
                            diagnostic_code(self.arena.text(*reason))?,
                        )?);
                    }
                }
                if reduced.get(row, &self.arena).boolean() {
                    output.push(Diagnostic::new(row, REDUCED_SOURCE_CHECKING)?);
                }
            }
            if checkable.get(first, &self.arena).boolean() {
                for row in first..end {
                    if !gathered.get(row, &self.arena).boolean() {
                        output.push(Diagnostic::new(row, SOURCE_UNAVAILABLE)?);
                    }
                    let absent = latest.get(row, &self.arena) == Atom::Null;
                    if !comparable.get(row, &self.arena).boolean() {
                        if absent {
                            output.push(Diagnostic::new(row, TRANSLATION_UNAVAILABLE)?);
                        }
                        continue;
                    }
                    for code in issues[0].get(&(row as u32)).into_iter().flatten() {
                        output.push(Diagnostic::new(row, *code)?);
                    }
                    if absent {
                        output.push(Diagnostic::new(row, TRANSLATION_UNAVAILABLE)?);
                        continue;
                    }
                    for code in issues[1].get(&(row as u32)).into_iter().flatten() {
                        output.push(Diagnostic::new(row, *code)?);
                    }
                }
            }
            first = end;
        }
        Ok(output)
    }
    fn scope(&mut self, rule: &CompiledRule, len: usize) -> Result<Selection> {
        let mut selected = Bits::all(len);
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
            self.evaluate_columns(relation, collator, include_diagnostics, &mut arena)?;
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
    ) -> Result<Evaluated> {
        self.evaluate_columns(relation, collator, true, arena)
    }
    fn evaluate_columns(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
        include_diagnostics: bool,
        shared: &mut Arena,
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
        recorder.enter(subject_stage(subject, Phase::Execute));
        let execute = Measure::start();
        let execute_workers = recorder.worker_adjustment();
        let mut emissions = Vec::new();
        for (execution, rule) in rules.into_iter().enumerate() {
            relation.checkpoint()?;
            let rule_measure = Measure::start();
            let scope = evaluator.scope(rule, len)?;
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
            let when = evaluator.evaluate(rule.when, &candidates)?;
            let mut selected = Vec::new();
            for (index, row) in candidates.rows.iter().enumerate() {
                if when.failed.get(index) {
                    output.diagnostics.push(Diagnostic::new(row, SYNTAX_LIMIT)?);
                } else if when.get(index, &evaluator.arena).boolean() {
                    selected.push(index);
                }
            }
            let selected = candidates.select(&selected, &mut evaluator.arena)?;
            let actual = evaluator.evaluate(rule.actual, &selected)?;
            let expectation = evaluator.evaluate(rule.expectation, &selected)?;
            let mut optional = |node| match node {
                Some(node) => evaluator.evaluate(node, &selected),
                None => Ok(Column::constant(Atom::Null, selected.len())),
            };
            let fix = optional(rule.fix)?;
            let extra = optional(rule.extra)?;
            let origin = optional(rule.translation_origin)?;
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
            let mut mask = Bits::new(len);
            for (index, row) in selected.rows.iter().enumerate() {
                if [
                    &actual,
                    &expectation,
                    &fix,
                    &extra,
                    &origin,
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
            json!({"if":[{"eq":[{"field":"source"},{"lit":"bad"}]},{"regexTest":[{"lit":"x"},{"lit":"("},{"lit":""}]},{"lit":false}]}),
            json!({"object":{"unreachable":{"regexTest":[{"lit":"x"},{"lit":"("},{"lit":""}]}}}),
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
    fn scope_precedes_when_and_requires_one_matching_occurrence() -> Result<()> {
        let mut scoped = rule(
            "scoped",
            json!({"if":[{"eq":[{"field":"source"},{"lit":"bad"}]},{"regexTest":[{"lit":"x"},{"lit":"("},{"lit":""}]},{"lit":true}]}),
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
                "any":{"any":[{"lit":["stop","later"]},{"if":[{"eq":[{"var":"item"},{"lit":"stop"}]},{"lit":true},{"regexTest":[{"lit":"x"},{"lit":"("},{"lit":""}]}]}]},
                "all":{"all":[{"lit":["stop","later"]},{"if":[{"eq":[{"var":"item"},{"lit":"stop"}]},{"lit":false},{"regexTest":[{"lit":"x"},{"lit":"("},{"lit":""}]}]}]}
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
