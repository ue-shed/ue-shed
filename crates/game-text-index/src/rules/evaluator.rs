//! Column-at-a-time DAG evaluation with selection short circuiting and tuple memoization.
use super::HostCollator;
use super::columns::{Arena, Atom, Bits, Children, Column, FieldColumn, Occurrences, Prepared};
use super::compiler::{CompiledRule, NodeId, Program, Subject};
use super::kernel::Kernel;
use super::selection::Selection;
use super::text;
use super::value::Value as ScalarValue;
use crate::{Error, ErrorCode, Result};
use rayon::prelude::*;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
            offsets: vec![0],
            ..Children::default()
        };
        let mut count = 0;
        for row in 0..len {
            for occurrence in self.occurrences(row)? {
                let occurrence = ScalarValue::from_json(&occurrence);
                for name in [
                    "id",
                    "packageFile",
                    "source",
                    "devNotes",
                    "location",
                    "unitStatus",
                ] {
                    values
                        .entry(name.into())
                        .or_default()
                        .push(arena.intern(occurrence[name].clone())?);
                }
                children.members.push(count);
                count += 1;
            }
            children.offsets.push(count);
        }
        arena.occurrences = Occurrences {
            len: count as usize,
            fields: values
                .into_iter()
                .map(|(name, values)| Ok((name, Arc::new(Column::from_atoms(&values, arena)?))))
                .collect::<Result<_>>()?,
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
    pub affected: Vec<Value>,
}
pub struct Evaluation {
    pub findings: Vec<Emission>,
    pub diagnostics: Vec<(Subject, usize, String)>,
    pub masks: HashMap<usize, Vec<u64>>,
}
#[derive(Clone, Copy)]
enum Slot {
    Value(Atom),
    Limit,
}
enum Computed {
    Atom(Atom),
    List(Vec<Atom>),
    Value(ScalarValue),
    Limit,
}
#[derive(Default)]
pub(crate) struct NodeTiming {
    pub elapsed: Duration,
    pub scalar: Duration,
    pub rows: usize,
    pub tuples: usize,
}
#[derive(Default)]
pub(crate) struct EvaluationTimings {
    pub prepare: Duration,
    pub execute: Duration,
    pub emission: Duration,
    pub diagnostics: Duration,
    pub nodes: Vec<NodeTiming>,
    pub projections: Vec<(String, Duration)>,
}
#[derive(Clone, Copy)]
struct Evidence {
    actual: Atom,
    expectation: Atom,
    fix: Atom,
    extra: Atom,
    translation_origin: Atom,
}
struct Pending {
    rule: usize,
    row: u32,
    subject: Subject,
    evidence: Evidence,
    recovery: Atom,
    affected: Atom,
}
type Diagnostics = Vec<(Subject, usize, String)>;
type TimedEvaluation = (Evaluation, EvaluationTimings, Diagnostics);
struct Evaluator<'a> {
    program: &'a Program,
    arena: Arena,
    prepared: Prepared,
    kernel: Kernel<'a>,
    literals: Vec<Option<Atom>>,
    extras: Vec<ScalarValue>,
    cache: Vec<HashMap<Vec<Atom>, Slot>>,
    cache_ids: Vec<usize>,
    references: HashMap<String, usize>,
    masks: HashMap<usize, Bits>,
    evidence: HashMap<(usize, u32), Evidence>,
    children: HashMap<usize, Atom>,
    timings: Vec<NodeTiming>,
}
impl<'a> Evaluator<'a> {
    fn new(
        program: &'a Program,
        arena: Arena,
        prepared: Prepared,
        collator: &'a HostCollator,
    ) -> Result<Self> {
        let mut value = Self {
            program,
            arena,
            prepared,
            kernel: Kernel::new(collator, &program.roles),
            literals: vec![None; program.nodes.len()],
            extras: program
                .nodes
                .iter()
                .map(|node| ScalarValue::from_json(&node.value))
                .collect(),
            cache: Vec::new(),
            cache_ids: Vec::new(),
            references: program
                .rules
                .iter()
                .map(|rule| (rule.rule.id.clone(), rule.ordinal))
                .collect(),
            masks: HashMap::new(),
            evidence: HashMap::new(),
            children: HashMap::new(),
            timings: (0..program.nodes.len())
                .map(|_| NodeTiming::default())
                .collect(),
        };
        let mut groups = HashMap::new();
        for (id, node) in program.nodes.iter().enumerate() {
            let metadata = value.arena.intern(value.extras[id].clone())?;
            let next = groups.len();
            let cache = *groups.entry((node.op.clone(), metadata)).or_insert(next);
            value.cache_ids.push(cache);
            if node.op == "lit" {
                value.literals[id] = Some(value.arena.intern(value.extras[id].clone())?);
            }
        }
        value.cache = (0..groups.len()).map(|_| HashMap::new()).collect();
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
        if selection.len() == 0 {
            return Ok(Column::constant(Atom::Null, 0));
        }
        let started = Instant::now();
        let column = self.node(id, selection)?;
        self.timings[id].elapsed += started.elapsed();
        self.timings[id].rows += selection.len();
        Ok(column)
    }
    fn node(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        match node.op.as_str() {
            "lit" => Ok(Column::constant(
                self.literals[id].ok_or("Missing compiled literal.")?,
                selection.len(),
            )),
            "field" => {
                let name = node.value.as_str().ok_or("Invalid field name.")?;
                let field = self.prepared.field(name)?;
                let values = selection
                    .rows
                    .iter()
                    .map(|row| field.get(*row as usize, &self.arena))
                    .collect::<Vec<_>>();
                Column::from_atoms(&values, &mut self.arena)
            }
            "var" => selection
                .variables
                .get(node.value.as_str().unwrap_or(""))
                .cloned()
                .ok_or_else(|| "Missing element binding column.".into()),
            "occurrences" => {
                let values = selection
                    .rows
                    .iter()
                    .map(|row| self.children(*row as usize))
                    .collect::<Result<Vec<_>>>()?;
                Column::from_atoms(&values, &mut self.arena)
            }
            "finding" | "findingField" => {
                let name = if node.op == "finding" {
                    node.value.as_str()
                } else {
                    node.value[0].as_str()
                }
                .unwrap_or("");
                let reference = self.references.get(name).copied();
                let mut values = Vec::with_capacity(selection.len());
                for row in &selection.rows {
                    if node.op == "finding" {
                        values.push(Atom::Bool(
                            reference
                                .and_then(|id| self.masks.get(&id))
                                .is_some_and(|mask| mask.get(*row as usize)),
                        ));
                    } else {
                        let path = node.value[1].as_str().unwrap_or("");
                        let value = reference
                            .and_then(|id| self.evidence.get(&(id, *row)))
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
            "and" | "or" | "coalesce" => self.short_circuit(id, selection),
            "if" => self.conditional(id, selection),
            "filter" | "map" | "flatMap" | "any" | "all" | "sortCodeUnit" | "sortLocale" => {
                self.list_operator(id, selection)
            }
            _ => self.scalar(id, selection),
        }
    }
    fn short_circuit(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        let mut output = vec![
            if node.op == "coalesce" {
                Atom::Null
            } else {
                Atom::Bool(node.op == "and")
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
                } else if node.op == "coalesce" {
                    if value == Atom::Null {
                        later.push(destination);
                    } else {
                        output[destination] = value;
                    }
                } else if value.boolean() == (node.op == "or") {
                    output[destination] = Atom::Bool(node.op == "or");
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
        let started = Instant::now();
        let mut failures = Bits::new(selection.len());
        for column in &columns {
            failures.union(&column.failed);
        }
        let mut tuples = Vec::new();
        let mut missing = HashMap::<Vec<Atom>, usize>::new();
        let mut slots = Vec::with_capacity(selection.len());
        for row in 0..selection.len() {
            if failures.get(row) {
                slots.push((None, None));
                continue;
            }
            let tuple = columns
                .iter()
                .map(|column| column.get(row, &self.arena))
                .collect::<Vec<_>>();
            if let Some(value) = self.cache[cache].get(&tuple) {
                slots.push((Some(*value), None));
            } else {
                let next = tuples.len();
                let slot = *missing.entry(tuple.clone()).or_insert_with(|| {
                    tuples.push(tuple);
                    next
                });
                slots.push((None, Some(slot)));
            }
        }
        if matches!(node.op.as_str(), "matchesRole" | "pathHasPrefix") {
            // Prepare each shared occurrence bitset before tuple workers start, avoiding
            // competing first-use builds of the same role or prefix in the Rayon pool.
            let keys = tuples
                .iter()
                .filter_map(|tuple| match tuple.as_slice() {
                    [Atom::Val(_), Atom::Str(key)] => Some(*key),
                    _ => None,
                })
                .collect::<HashSet<_>>();
            for key in keys {
                self.kernel
                    .occurrence_mask(&self.arena, key, node.op == "matchesRole")?;
            }
        }
        self.timings[id].tuples += tuples.len();
        // Bound temporary structured results while keeping tuple slots and interning order stable.
        // A catalogue node may have millions of distinct tuples on a persisted project.
        drop(missing);
        let mut results = Vec::with_capacity(tuples.len());
        let mut pending = tuples.into_iter();
        loop {
            let batch = pending.by_ref().take(4096).collect::<Vec<_>>();
            if batch.is_empty() {
                break;
            }
            let arena = &self.arena;
            let kernel = &self.kernel;
            let extra = &self.extras[id];
            let computed = batch
                .par_iter()
                .map(|tuple| {
                    if node.op == "list" {
                        return Ok(Computed::List(tuple.clone()));
                    }
                    if node.op == "get"
                        && let [value, Atom::Str(path)] = tuple.as_slice()
                    {
                        return Ok(Computed::Atom(arena.get_path(*value, arena.text(*path))));
                    }
                    if node.op == "first" {
                        return Ok(Computed::Atom(
                            arena
                                .elements(tuple[0])?
                                .and_then(|values| values.first())
                                .copied()
                                .unwrap_or_default(),
                        ));
                    }
                    if matches!(node.op.as_str(), "formatIssues" | "formatCompiled") {
                        return Ok(Computed::Atom(arena.get_path(
                            tuple[0],
                            if node.op == "formatIssues" {
                                "issues"
                            } else {
                                "compiled"
                            },
                        )));
                    }
                    match kernel.run(arena, &node.op, extra, tuple) {
                        Ok(value) => Ok(Computed::Value(value)),
                        Err(error) if error.code == ErrorCode::LimitExceeded => Ok(Computed::Limit),
                        Err(error) => Err(error),
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            for (tuple, value) in batch.into_iter().zip(computed) {
                let result = match value {
                    Computed::Atom(value) => Slot::Value(value),
                    Computed::List(values) => Slot::Value(self.arena.list(values)?),
                    Computed::Value(value) => Slot::Value(self.arena.intern(value)?),
                    Computed::Limit => Slot::Limit,
                };
                self.cache[cache].insert(tuple, result);
                results.push(result);
            }
        }
        let mut output = Vec::with_capacity(selection.len());
        for (row, (cached, slot)) in slots.into_iter().enumerate() {
            match cached.or_else(|| slot.map(|slot| results[slot])) {
                Some(Slot::Value(value)) => output.push(value),
                Some(Slot::Limit) => {
                    output.push(Atom::Null);
                    failures.set(row);
                }
                None => output.push(Atom::Null),
            }
        }
        let mut column = Column::from_atoms(&output, &mut self.arena)?;
        column.failed = failures;
        self.timings[id].scalar += started.elapsed();
        Ok(column)
    }
    fn list_operator(&mut self, id: NodeId, selection: &Selection) -> Result<Column> {
        let node = &self.program.nodes[id];
        let input = self.evaluate(node.args[0], selection)?;
        if node.op == "any" || node.op == "all" {
            return self.list_boolean(id, selection, &input);
        }
        // Lists are small. Expansion/grouping is parallel by row chunk, with scalar bodies
        // evaluated over the element relation through the same distinct-tuple memo.
        let groups = (0..selection.len())
            .into_par_iter()
            .map(|row| {
                if input.failed.get(row) {
                    return Ok(None);
                }
                Ok(self
                    .arena
                    .elements(input.get(row, &self.arena))?
                    .map(<[Atom]>::to_vec))
            })
            .collect::<Result<Vec<_>>>()?;
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
        let variable = node.value.as_str().unwrap_or("item").to_owned();
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
                match node.op.as_str() {
                    "filter" if evaluated.boolean() => values.push(elements[index]),
                    "map" => values.push(evaluated),
                    "flatMap" => {
                        if let Some(elements) = self.arena.elements(evaluated)? {
                            values.extend_from_slice(elements);
                        }
                    }
                    "sortCodeUnit" | "sortLocale" => sorted.push((elements[index], evaluated)),
                    _ => {}
                }
            }
            if matches!(node.op.as_str(), "sortCodeUnit" | "sortLocale") {
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
                    if node.op == "sortLocale" {
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
        let all = node.op == "all";
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
        let variable = node.value.as_str().unwrap_or("item").to_owned();
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
    fn diagnostics(&mut self, len: usize) -> Result<Vec<(Subject, usize, String)>> {
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
            let mut codes = HashMap::<u32, Vec<String>>::new();
            for (index, row) in selection.rows.iter().copied().enumerate() {
                let found = self
                    .arena
                    .get_path(patterns.get(index, &self.arena), "issues");
                for issue in self.arena.elements(found)?.unwrap_or_default() {
                    let code = self.arena.get_path(*issue, "code");
                    if let Atom::Str(code) = code {
                        let code = self.arena.text(code);
                        if matches!(code, "unsupported_culture" | "syntax_limit") {
                            codes.entry(row).or_default().push(code.into());
                        }
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
                        output.push((Subject::LineCulture, row, self.arena.text(*reason).into()));
                    }
                }
                if reduced.get(row, &self.arena).boolean() {
                    output.push((Subject::LineCulture, row, "reduced_source_checking".into()));
                }
            }
            if checkable.get(first, &self.arena).boolean() {
                for row in first..end {
                    if !gathered.get(row, &self.arena).boolean() {
                        output.push((Subject::LineCulture, row, "source_unavailable".into()));
                    }
                    let absent = latest.get(row, &self.arena) == Atom::Null;
                    if !comparable.get(row, &self.arena).boolean() {
                        if absent {
                            output.push((
                                Subject::LineCulture,
                                row,
                                "translation_unavailable".into(),
                            ));
                        }
                        continue;
                    }
                    if let Some(codes) = issues[0].get(&(row as u32)) {
                        output.extend(
                            codes
                                .iter()
                                .map(|code| (Subject::LineCulture, row, code.clone())),
                        );
                    }
                    if absent {
                        output.push((Subject::LineCulture, row, "translation_unavailable".into()));
                        continue;
                    }
                    if let Some(codes) = issues[1].get(&(row as u32)) {
                        output.extend(
                            codes
                                .iter()
                                .map(|code| (Subject::LineCulture, row, code.clone())),
                        );
                    }
                }
            }
            first = end;
        }
        Ok(output)
    }
    fn scope(&mut self, rule: &CompiledRule, len: usize) -> Result<Selection> {
        let mut selected = (0..len as u32).collect::<Vec<_>>();
        // Culture gates precede occurrence masks and every rule expression.
        if rule.rule.subject == Subject::Line {
            let culture = self.prepared.field("sourceCulture")?;
            selected.retain(|row| culture.get(*row as usize, &self.arena) != Atom::Null);
        }
        if let Some(scope) = &rule.rule.scope {
            if rule.rule.subject != Subject::UnitSource
                && let Some(cultures) = scope["cultures"].as_array()
            {
                let field = self.prepared.field(if rule.rule.subject == Subject::Line {
                    "sourceCulture"
                } else {
                    "culture"
                })?;
                let cultures = cultures
                    .iter()
                    .map(|culture| self.arena.intern(ScalarValue::from_json(culture)))
                    .collect::<Result<Vec<_>>>()?;
                selected.retain(|row| cultures.contains(&field.get(*row as usize, &self.arena)));
            }
            let mut mask = |name: &str, role: bool| -> Result<Option<Bits>> {
                let Some(values) = scope[name].as_array() else {
                    return Ok(None);
                };
                let mut mask = Bits::new(self.arena.occurrences.len);
                for value in values {
                    let key = self
                        .arena
                        .string(value.as_str().ok_or("Invalid occurrence scope.")?)?;
                    mask.union(
                        self.kernel
                            .occurrence_mask(&self.arena, key, role)?
                            .as_ref(),
                    );
                }
                Ok(Some(mask))
            };
            let roles = mask("roles", true)?;
            let paths = mask("pathPrefixes", false)?;
            if roles.is_some() || paths.is_some() {
                selected.retain(|row| {
                    self.prepared
                        .children
                        .members(*row as usize)
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
        Ok(Selection::new(selected))
    }
}
impl Program {
    /// Evaluate a subject's shared DAG over typed columns and ordered selections.
    pub fn evaluate(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
    ) -> Result<Evaluation> {
        self.evaluate_timed(relation, collator)
            .map(|(evaluation, _)| evaluation)
    }
    pub(crate) fn evaluate_timed(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
    ) -> Result<(Evaluation, EvaluationTimings)> {
        self.evaluate_columns(relation, collator, false)
            .map(|(evaluation, timings, _)| (evaluation, timings))
    }
    pub(crate) fn evaluate_with_diagnostics(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
    ) -> Result<TimedEvaluation> {
        self.evaluate_columns(relation, collator, true)
    }
    fn evaluate_columns(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
        include_diagnostics: bool,
    ) -> Result<TimedEvaluation> {
        let started = Instant::now();
        let subject = relation.subject();
        let include_diagnostics = include_diagnostics && subject == Subject::LineCulture;
        let len = relation.len();
        let rules = self
            .rules
            .iter()
            .filter(|rule| rule.rule.subject == subject)
            .collect::<Vec<_>>();
        let mut output = Evaluation {
            findings: Vec::new(),
            diagnostics: Vec::new(),
            masks: HashMap::new(),
        };
        if rules.is_empty() && !include_diagnostics {
            return Ok((output, EvaluationTimings::default(), Vec::new()));
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
                    .is_some_and(|scope| scope["cultures"].is_array())
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
            if node.op == "field" {
                names.insert(
                    node.value
                        .as_str()
                        .ok_or("Invalid subject field.")?
                        .to_owned(),
                );
            }
        }
        let mut names = names.into_iter().collect::<Vec<_>>();
        names.sort();
        let mut arena = Arena::new(relation.dictionary_len()?)?;
        let prepared = relation.prepare(&names, &mut arena, !rules.is_empty())?;
        prepared.validate(len)?;
        let projections = prepared.timings.clone();
        let mut evaluator = Evaluator::new(self, arena, prepared, collator)?;
        let prepare = started.elapsed();
        let execute = Instant::now();
        let mut emissions = Vec::new();
        for rule in rules {
            relation.checkpoint()?;
            let scope = evaluator.scope(rule, len)?;
            let candidates = if let Some(each) = rule.each {
                let items = evaluator.evaluate(each, &scope)?;
                let mut parents = Vec::new();
                let mut elements = Vec::new();
                for (row, subject_row) in scope.rows.iter().enumerate() {
                    if items.failed.get(row) {
                        output.diagnostics.push((
                            subject,
                            *subject_row as usize,
                            "syntax_limit".into(),
                        ));
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
                    output
                        .diagnostics
                        .push((subject, *row as usize, "syntax_limit".into()));
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
                    .map(|row| evaluator.children(*row as usize))
                    .collect::<Result<Vec<_>>>()?;
                Column::from_atoms(&values, &mut evaluator.arena)?
            };
            let recovery = evaluator.evaluate(rule.recovery, &selected)?;
            let mut mask = Bits::new(len);
            for (index, row) in selected.rows.iter().copied().enumerate() {
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
                    output
                        .diagnostics
                        .push((subject, row as usize, "syntax_limit".into()));
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
                evaluator
                    .evidence
                    .entry((rule.ordinal, row))
                    .or_insert(evidence);
                emissions.push(Pending {
                    rule: rule.ordinal,
                    row,
                    subject,
                    evidence,
                    recovery,
                    affected: places,
                });
            }
            evaluator.masks.insert(rule.ordinal, mask);
        }
        let execute = execute.elapsed();
        let diagnostics_started = Instant::now();
        let diagnostics = if include_diagnostics {
            evaluator.diagnostics(len)?
        } else {
            Vec::new()
        };
        let diagnostics_elapsed = diagnostics_started.elapsed();
        let emission = Instant::now();
        let mut places = HashMap::<Atom, Vec<Value>>::new();
        for pending in emissions {
            let affected = if let Some(places) = places.get(&pending.affected) {
                places.clone()
            } else {
                let value = evaluator.arena.value(pending.affected).json();
                let value = value
                    .as_array()
                    .ok_or("Finding places are not a list.")?
                    .clone();
                places.insert(pending.affected, value.clone());
                value
            };
            let evidence = pending.evidence;
            let recovery = if let Atom::Str(id) = pending.recovery {
                evaluator.arena.text(id).to_owned()
            } else {
                return Err("Invalid finding recovery.".into());
            };
            output.findings.push(Emission {
                rule: pending.rule,
                row: pending.row as usize,
                subject: pending.subject,
                actual: evaluator.arena.value(evidence.actual).json(),
                expectation: evaluator.arena.value(evidence.expectation).json(),
                fix: evaluator.arena.value(evidence.fix).json(),
                extra: evaluator.arena.value(evidence.extra).json(),
                translation_origin: evaluator.arena.value(evidence.translation_origin).json(),
                recovery,
                affected,
            });
        }
        output
            .findings
            .sort_by_key(|finding| (finding.rule, finding.row));
        output.masks = evaluator
            .masks
            .into_iter()
            .map(|(rule, mask)| (rule, mask.words))
            .collect();
        let timings = EvaluationTimings {
            prepare,
            execute,
            emission: emission.elapsed(),
            diagnostics: diagnostics_elapsed,
            nodes: evaluator.timings,
            projections,
        };
        Ok((output, timings, diagnostics))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule(id: &str, when: Value, actual: Value) -> Value {
        json!({"id":id,"kind":id,"label":id,"subject":"unit_source","family":"source","severity":"normal","when":when,"actual":actual,"expectation":{"object":{"review":true}},"recovery":"Review the saved text."})
    }
    #[test]
    fn evaluates_references_elements_nulls_and_roles_without_a_target() -> Result<()> {
        let mut dependent = rule(
            "dependent",
            json!({"finding":"first"}),
            json!({"object":{"source":{"field":"source"},"missing":null,"first":{"findingField":["first","actual.value"]}}}),
        );
        dependent["each"] = json!({"lit":["a","b"]});
        dependent["actual"]["object"]["element"] = json!({"var":"item"});
        let first = rule(
            "first",
            json!({"gt":[{"utf16Length":{"field":"source"}},2]}),
            json!({"object":{"value":2}}),
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
            json!({"utf16Length":42}),
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
            json!(true),
            json!({"object":{"terms":{"termMatches":[{"field":"source"},"bad",false]},"placeholders":{"termListMatches":[{"field":"source"},{"lit":["bad"]},false,"lmnu"]}}}),
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
            json!({"gt":[{"utf16Length":{"field":"source"}},2]}),
            json!({"object":{"length":{"utf16Length":{"field":"source"}}}}),
        );
        first["scope"] = json!({"pathPrefixes":["/Game/Allowed"]});
        let second = rule(
            "second",
            json!({"if":[{"eq":[{"field":"source"},"bad"]},{"regexTest":["x","(",""]},false]}),
            json!({"object":{"unreachable":{"regexTest":["x","(",""]}}}),
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
                .filter(|(node, _)| node.op == "utf16Length")
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
            json!({"if":[{"eq":[{"field":"source"},"bad"]},{"regexTest":["x","(",""]},true]}),
            json!({"object":{"checked":true}}),
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
            json!(true),
            json!({"object":{
                "any":{"any":[{"lit":["stop","later"]},{"if":[{"eq":[{"var":"item"},"stop"]},true,{"regexTest":["x","(",""]}]}]},
                "all":{"all":[{"lit":["stop","later"]},{"if":[{"eq":[{"var":"item"},"stop"]},false,{"regexTest":["x","(",""]}]}]}
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
                        json!(["incomplete_coverage"]),
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
                .map(|(_, row, code)| (row, code))
                .collect::<Vec<_>>(),
            vec![
                (0, "unresolved_identity".into()),
                (0, "reduced_source_checking".into()),
                (1, "incomplete_coverage".into()),
                (2, "source_unavailable".into()),
                (1, "source_unavailable".into()),
                (1, "unsupported_culture".into()),
                (1, "translation_unavailable".into()),
                (2, "source_unavailable".into()),
                (2, "unsupported_culture".into())
            ]
        );
        Ok(())
    }
}
