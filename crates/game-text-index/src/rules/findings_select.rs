//! Finding rows (Plan 059 Phase 7 §4): a findings layer's findings as a query's rows. A `where`
//! tests a finding's own fields and, through `row`, its text row with the Text tab's grammar: a
//! line finding's line in its culture's scope, a source finding's unit. Counts are facets over
//! any finding field, or over the text row's fields with a finding counted under its row.
use super::findings_order::{CHANGE, FIXABLE, KEYLESS, NONE, SHADOWED};
use super::findings_query::{
    Acceptance, CodeCount, Columns, ComposeTimes, Diagnostics, LineMatches, MAX_LIMIT, SEVERITIES,
    columns, compose, id_lanes,
};
use super::findings_read::send_findings;
use super::findings_sink::reported_finding;
use super::replies::{LineDiagnostic, PlaceSet, ReadProfile, RuleMetadata};
use super::{Subject, javascript_json};
use crate::engine::Reply;
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_rows::RowSet;
use crate::engine_types::{
    FacetPart, FindingsOrder, FindingsSelection, FindingsView, MAX_GROUPS, PROBLEMS, Query,
    QueryAnswer, Selection, invalid,
};
use crate::engine_where::{Field, Node};
use crate::sink::{SinkWriter, pretty_json};
use crate::{Result, require};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

/// A finding's text row passes: by culture index the lines of `line_culture` findings, `any`
/// for the other line findings, and `units` for source findings.
struct RowTest {
    cultures: Vec<RowSet>,
    any: RowSet,
    units: Option<RowSet>,
}

/// A compiled finding test.
enum Test {
    Const(bool),
    And(Vec<Test>),
    Or(Vec<Test>),
    Not(Box<Test>),
    /// By rule index: its ID, severity or subject is one of the values.
    Rules(Vec<bool>),
    /// By culture index; a finding without a culture has none of them.
    Cultures(Vec<bool>),
    /// Whether a flag is clear or set is one of the values.
    Flag(u32, [bool; 2]),
    /// Finding IDs, as their lanes.
    Ids(HashSet<(bool, u32, u32)>),
    Row(Box<RowTest>),
}

/// What compiling and testing findings reads.
struct Context<'a> {
    query: &'a EngineQuery,
    columns: &'a Columns,
    rules: &'a [RuleMetadata],
    selection: &'a Selection,
    findings: &'a FindingsSelection,
    /// Each rule's subject rows, for source rules; empty for the others.
    source_rows: Vec<Arc<[u32]>>,
    /// Each `unit_source` subject row's unit.
    units: Arc<[u32]>,
    cancelled: &'a AtomicBool,
}

fn severity_name(rule: &RuleMetadata) -> &'static str {
    SEVERITIES
        .iter()
        .find(|(severity, _)| *severity == rule.severity)
        .map_or("normal", |(_, name)| name)
}

fn subject_name(subject: Subject) -> &'static str {
    match subject {
        Subject::Line => "line",
        Subject::LineCulture => "line_culture",
        Subject::UnitSource => "unit_source",
    }
}

/// A finding's ID, as hosts name it.
fn finding_id(columns: &Columns, number: u32) -> String {
    let (first, second) = columns.lanes(number);
    if columns.line[number as usize] == NONE {
        format!(
            "quality-finding:{:x}",
            (u64::from(first) << 32) | u64::from(second)
        )
    } else {
        format!("localization-finding:{first:08x}{second:08x}")
    }
}

impl Context<'_> {
    /// A source finding's unit.
    fn unit(&self, number: u32) -> Option<u32> {
        let rule = self.columns.rule[number as usize] as usize;
        let position = (number - self.columns.bases[rule]) as usize;
        let row = *self.source_rows.get(rule)?.get(position)?;
        self.units.get(row as usize).copied()
    }

    fn compile(&self, node: &Node, dropped: &[Field]) -> Result<Test> {
        let each = |nodes: &[Node]| {
            nodes
                .iter()
                .map(|node| self.compile(node, dropped))
                .collect::<Result<Vec<_>>>()
        };
        Ok(match node {
            Node::Const(value) => Test::Const(*value),
            Node::And(nodes) => Test::And(each(nodes)?),
            Node::Or(nodes) => Test::Or(each(nodes)?),
            Node::Not(node) => Test::Not(Box::new(self.compile(node, dropped)?)),
            Node::Facet(_, node) => self.compile(node, dropped)?,
            Node::Row(_, body) => Test::Row(Box::new(self.row(body, dropped)?)),
            Node::Is(field, values) => {
                let named = |name: &str| values.iter().any(|value| value.as_str() == Some(name));
                let rules = |of: &dyn Fn(&RuleMetadata) -> bool| {
                    Test::Rules(self.rules.iter().map(of).collect())
                };
                let flag = |bit: u32| {
                    let wanted = |value: bool| values.contains(&Value::Bool(value));
                    Test::Flag(bit, [wanted(false), wanted(true)])
                };
                match field {
                    Field::Rule => rules(&|rule| named(&rule.rule_id)),
                    Field::Severity => rules(&|rule| named(severity_name(rule))),
                    Field::Subject => rules(&|rule| named(subject_name(rule.subject))),
                    Field::Culture => {
                        Test::Cultures(self.query.cultures.iter().map(|c| named(c)).collect())
                    }
                    Field::Fixable => flag(FIXABLE),
                    Field::Change => flag(CHANGE),
                    Field::Id => Test::Ids(
                        values
                            .iter()
                            .filter_map(|value| value.as_str().and_then(id_lanes))
                            .collect(),
                    ),
                    _ => unreachable!("the parser keeps a finding's other tests in row"),
                }
            }
            Node::Under(_) | Node::AnyCulture(_) | Node::EveryCulture(_) | Node::AnyPlace(_) => {
                unreachable!("the parser keeps a row's tests in row")
            }
        })
    }

    /// A `row` body over the text rows: the Text tab's selection of it, in each culture scope
    /// a finding can read, and over units for source findings.
    fn row(&self, body: &Value, dropped: &[Field]) -> Result<RowTest> {
        // Without a target there are no lines, only source findings' units.
        if self.selection.target.is_none() {
            return Ok(RowTest {
                cultures: Vec::new(),
                any: RowSet::from_rows(0, &[])?,
                units: self.units_row(body, dropped)?,
            });
        }
        let parsed = Node::parse(body, true)?;
        let reads_findings = parsed.reads_findings();
        // A test that reads no culture scope keeps the same lines in every culture.
        let per_culture = parsed.reads_scope() || reads_findings;
        let lines = self.query.reader.column("line.source")?.len();
        let select = |culture: Option<String>, cultures: Option<Vec<String>>, narrowed: bool| {
            let selection = Selection {
                target: self.selection.target.clone(),
                culture,
                cultures,
                findings: reads_findings.then(|| FindingsSelection {
                    view: None,
                    source_only: None,
                    ..self.findings.clone()
                }),
                filter: Some(body.clone()),
                dropped: dropped.to_vec(),
                narrowed,
                ..Selection::default()
            };
            RowSet::from_rows(lines, &self.query.matching(&selection, self.cancelled)?)
        };
        let (any, cultures) = match &self.selection.culture {
            // Every finding the culture keeps is the culture's or has none.
            Some(culture) => (select(Some(culture.clone()), None, false)?, Vec::new()),
            None if !per_culture => (
                select(None, self.selection.cultures.clone(), false)?,
                Vec::new(),
            ),
            None => (
                select(None, self.selection.cultures.clone(), false)?,
                self.query
                    .cultures
                    .iter()
                    .map(|culture| select(Some(culture.clone()), None, true))
                    .collect::<Result<_>>()?,
            ),
        };
        Ok(RowTest {
            cultures,
            any,
            units: self.units_row(body, dropped)?,
        })
    }

    /// A `row` body over the units of source findings, if the layer has source rules.
    fn units_row(&self, body: &Value, dropped: &[Field]) -> Result<Option<RowSet>> {
        let reads_findings = Node::parse_for_units(body)?.reads_findings();
        Ok(if self.source_rows.iter().any(|rows| !rows.is_empty()) {
            let selection = Selection {
                findings: reads_findings.then(|| FindingsSelection {
                    view: None,
                    source_only: Some(true),
                    ..self.findings.clone()
                }),
                filter: Some(body.clone()),
                dropped: dropped.to_vec(),
                lenient: true,
                ..Selection::default()
            };
            let len = Projection::open(self.query, self.cancelled)?
                .raw
                .visible
                .len();
            Some(RowSet::from_rows(
                len,
                &self.query.matching(&selection, self.cancelled)?,
            )?)
        } else {
            None
        })
    }

    fn holds(&self, test: &Test, number: u32) -> bool {
        let n = number as usize;
        let columns = self.columns;
        match test {
            Test::Const(value) => *value,
            Test::And(tests) => tests.iter().all(|test| self.holds(test, number)),
            Test::Or(tests) => tests.iter().any(|test| self.holds(test, number)),
            Test::Not(test) => !self.holds(test, number),
            Test::Rules(wanted) => wanted[columns.rule[n] as usize],
            Test::Cultures(wanted) => wanted
                .get(columns.culture[n] as usize)
                .copied()
                .unwrap_or(false),
            Test::Flag(bit, wanted) => wanted[usize::from(columns.flags[n] & bit != 0)],
            Test::Ids(ids) => ids.contains(&{
                let (first, second) = columns.lanes(number);
                (columns.line[n] != NONE, first, second)
            }),
            Test::Row(row) => {
                let line = columns.line[n];
                if line == NONE {
                    return row.units.as_ref().is_some_and(|units| {
                        self.unit(number)
                            .is_some_and(|unit| units.contains(unit as usize))
                    });
                }
                row.cultures
                    .get(columns.culture[n] as usize)
                    .unwrap_or(&row.any)
                    .contains(line as usize)
            }
        }
    }
}

/// One facet's tallies while selecting.
struct Tally<'a> {
    part: &'a FacetPart,
    test: Test,
    /// Finding-field counts by value index.
    counts: Vec<u32>,
    /// A row field's lines and units, one entry per finding.
    lines: Vec<u32>,
    units: Vec<u32>,
}

/// Each value a finding field counts by, in its order, with a finding's value index.
fn finding_values(context: &Context<'_>, field: Field) -> Vec<(String, String)> {
    let pairs = |values: &[&str]| {
        values
            .iter()
            .map(|value| ((*value).to_owned(), (*value).to_owned()))
            .collect()
    };
    match field {
        Field::Rule => {
            let mut seen = HashSet::new();
            context
                .rules
                .iter()
                .filter(|rule| seen.insert(rule.rule_id.clone()))
                .map(|rule| (rule.rule_id.clone(), rule.label.clone()))
                .collect()
        }
        Field::Severity => pairs(&["blocking", "normal", "low"]),
        Field::Subject => pairs(&["line", "line_culture", "unit_source"]),
        Field::Culture => context
            .query
            .cultures
            .iter()
            .map(|culture| (culture.clone(), culture.clone()))
            .collect(),
        Field::Fixable | Field::Change => pairs(&["true", "false"]),
        _ => Vec::new(),
    }
}

/// A finding's value index under a finding field, if it has one.
fn value_index(context: &Context<'_>, field: Field, number: u32, rules: &[usize]) -> Option<usize> {
    let n = number as usize;
    let columns = context.columns;
    let rule = &context.rules[columns.rule[n] as usize];
    let flag = |bit: u32| Some(usize::from(columns.flags[n] & bit == 0));
    match field {
        Field::Rule => Some(rules[columns.rule[n] as usize]),
        Field::Severity => SEVERITIES
            .iter()
            .position(|(severity, _)| *severity == rule.severity),
        Field::Subject => Some(match rule.subject {
            Subject::Line => 0,
            Subject::LineCulture => 1,
            Subject::UnitSource => 2,
        }),
        Field::Culture => (columns.culture[n] != NONE).then_some(columns.culture[n] as usize),
        Field::Fixable => flag(FIXABLE),
        Field::Change => flag(CHANGE),
        _ => None,
    }
}

/// Two counts of one field, over lines and over units, as one: entries with the same key add,
/// and the units' other keys follow the lines' while there is room.
fn merged(mut lines: Value, units: Value) -> Value {
    let rank = |worst: &Value| {
        worst
            .as_str()
            .and_then(|worst| PROBLEMS.iter().position(|problem| *problem == worst))
            .unwrap_or(PROBLEMS.len())
    };
    let mut more = lines["more"].as_u64().unwrap_or(0) + units["more"].as_u64().unwrap_or(0);
    let Some(entries) = lines["entries"].as_array_mut() else {
        return units;
    };
    for entry in units["entries"].as_array().into_iter().flatten() {
        match entries.iter().position(|line| line["key"] == entry["key"]) {
            Some(index) => {
                let line = &mut entries[index];
                for count in ["count", "needWork"] {
                    let sum =
                        line[count].as_u64().unwrap_or(0) + entry[count].as_u64().unwrap_or(0);
                    line[count] = json!(sum);
                }
                if rank(&entry["worst"]) < rank(&line["worst"]) {
                    line["worst"] = entry["worst"].clone();
                }
            }
            None if entries.len() < MAX_GROUPS => entries.push(entry.clone()),
            None => more += 1,
        }
    }
    lines["more"] = json!(more);
    lines
}

impl EngineQuery {
    /// A query over finding rows: its part, then a page's place sets and findings as batches, or
    /// with a write, what the write's sink wrote.
    pub(crate) fn query_findings(
        &self,
        request: &Query,
        cancelled: &AtomicBool,
        reply: &mut dyn Reply,
    ) -> Result<()> {
        let selection = &request.selection;
        let parts = &request.parts;
        let findings = selection
            .findings
            .as_ref()
            .ok_or("Finding rows need a findings layer.")?;
        let view = findings.view.ok_or("Finding rows need a view.")?;
        let mut stages = BTreeMap::<&'static str, f64>::new();
        let mut since = Instant::now();
        let mut lap = |stages: &mut BTreeMap<&'static str, f64>, stage| {
            stages.insert(stage, since.elapsed().as_secs_f64() * 1000.0);
            since = Instant::now();
        };
        let layer = self.layer(&findings.key)?;
        lap(&mut stages, "layer");
        let acceptance: Option<Arc<Acceptance>> = match &findings.acceptance {
            Some(name) => {
                let acceptance = self
                    .acceptances
                    .get(name)
                    .ok_or_else(|| invalid("The acceptance is not open."))?;
                require(
                    acceptance.layer == findings.key,
                    invalid("The acceptance belongs to other findings."),
                )?;
                Some(acceptance)
            }
            None => None,
        };
        let rules = layer.metadata.rules.clone();
        let columns = columns(&layer)?;
        let source_rows = rules
            .iter()
            .enumerate()
            .map(|(index, rule)| {
                if rule.subject == Subject::UnitSource {
                    layer.column(&format!("r{index}.rows"))
                } else {
                    Ok(Arc::from([]))
                }
            })
            .collect::<Result<Vec<_>>>()?;
        let context = Context {
            query: self,
            columns: &columns,
            rules: &rules,
            selection,
            findings,
            source_rows,
            units: layer.column("subjects.unit_source.units")?,
            cancelled,
        };
        let culture = match &selection.culture {
            Some(culture) => Some(u32::try_from(
                self.cultures
                    .iter()
                    .position(|value| value == culture)
                    .ok_or_else(|| invalid("The culture is not in the target."))?,
            )?),
            None => None,
        };
        let text = match selection
            .text
            .as_ref()
            .filter(|text| !text.query.trim().is_empty())
        {
            Some(text) => Some(LineMatches::open(
                self,
                &layer,
                &text.query,
                culture,
                cancelled,
            )?),
            None => None,
        };
        lap(&mut stages, "lines");
        let parsed = selection
            .filter
            .as_ref()
            .map(Node::parse_findings)
            .transpose()?;
        let compiled = |dropped: &[Field]| -> Result<Test> {
            match &parsed {
                Some(node) => context.compile(&node.without(dropped), dropped),
                None => Ok(Test::Const(true)),
            }
        };
        let test = compiled(&selection.dropped)?;
        let facets = parts.facets.as_deref().unwrap_or_default();
        let mut tallies = facets
            .iter()
            .map(|part| {
                let mut dropped = selection.dropped.clone();
                dropped.push(part.by);
                Ok(Tally {
                    part,
                    test: compiled(&dropped)?,
                    counts: vec![0; finding_values(&context, part.by).len()],
                    lines: Vec::new(),
                    units: Vec::new(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        lap(&mut stages, "where");

        // Accepted findings: (line, culture) by rule, through each rule's ID.
        let accepted_rules = acceptance.as_ref().map(|acceptance| {
            let mut by_rule = vec![HashSet::new(); rules.len()];
            for (line, ci, check) in &acceptance.entries {
                for (index, rule) in rules.iter().enumerate() {
                    if &rule.rule_id == check {
                        by_rule[index].insert((*line, *ci));
                    }
                }
            }
            by_rule
        });
        let accepted = |number: u32| {
            let n = number as usize;
            accepted_rules.as_ref().is_some_and(|by_rule| {
                columns.flags[n] & KEYLESS == 0
                    && columns.line[n] != NONE
                    && by_rule[columns.rule[n] as usize]
                        .contains(&(columns.line[n], columns.culture[n]))
            })
        };
        let shadow = view == FindingsView::Workspace
            && rules.iter().any(|rule| rule.subject == Subject::UnitSource);
        let in_culture = |number: u32| {
            let n = number as usize;
            culture.is_none_or(|ci| columns.culture[n] == NONE || columns.culture[n] == ci)
                && !(shadow && columns.flags[n] & SHADOWED != 0)
        };

        // The view's findings in the order asked for.
        let order = parts
            .rows
            .as_ref()
            .and_then(|rows| rows.order)
            .unwrap_or(match view {
                FindingsView::Workspace => FindingsOrder::Severity,
                FindingsView::Report => FindingsOrder::Report,
            });
        let report = layer.column("order.report")?;
        let source = if view == FindingsView::Workspace || order == FindingsOrder::Source {
            layer.column("order.source")?
        } else {
            Arc::from([])
        };
        let sequence: Vec<u32> = match order {
            FindingsOrder::Report => report.to_vec(),
            FindingsOrder::Line => layer.column("order.line")?.to_vec(),
            FindingsOrder::Source => source.to_vec(),
            FindingsOrder::Severity => {
                let mut sequence = Vec::with_capacity(report.len() + source.len());
                for (severity, _) in SEVERITIES {
                    let of = |number: &&u32| {
                        rules[columns.rule[**number as usize] as usize].severity == severity
                    };
                    sequence.extend(source.iter().filter(of));
                    sequence.extend(report.iter().filter(of));
                }
                sequence
            }
        };
        lap(&mut stages, "order");
        checkpoint(cancelled)?;

        // Rules sharing an ID count once, under the first of them.
        let mut first_of = HashMap::new();
        let rule_values = rules
            .iter()
            .map(|rule| {
                let next = first_of.len();
                *first_of.entry(rule.rule_id.clone()).or_insert(next)
            })
            .collect::<Vec<_>>();
        let counting = parts.counts == Some(true);
        let (mut accepted_count, mut fixable) = (0u32, 0u32);
        let mut matched = Vec::new();
        for (index, number) in sequence.iter().enumerate() {
            if index & 4095 == 0 {
                checkpoint(cancelled)?;
            }
            let number = *number;
            if !in_culture(number)
                || text
                    .as_ref()
                    .is_some_and(|text| !text.holds(&columns, number))
            {
                continue;
            }
            let selected = context.holds(&test, number);
            if accepted(number) {
                accepted_count += u32::from(selected);
                continue;
            }
            if selected {
                matched.push(number);
                fixable += u32::from(columns.flags[number as usize] & FIXABLE != 0);
            }
            for tally in &mut tallies {
                if !context.holds(&tally.test, number) {
                    continue;
                }
                if tally.part.by.of_finding() {
                    if let Some(value) = value_index(&context, tally.part.by, number, &rule_values)
                    {
                        tally.counts[value] += 1;
                    }
                } else if columns.line[number as usize] != NONE {
                    tally.lines.push(columns.line[number as usize]);
                } else if let Some(unit) = context.unit(number) {
                    tally.units.push(unit);
                }
            }
        }
        lap(&mut stages, "select");

        let mut answer = QueryAnswer {
            total: Some(u32::try_from(matched.len())?),
            ..QueryAnswer::default()
        };
        if !tallies.is_empty() {
            let mut values = serde_json::Map::new();
            let lines_selection = Selection {
                target: selection.target.clone(),
                culture: selection.culture.clone(),
                cultures: selection.cultures.clone(),
                ..Selection::default()
            };
            let units_selection = Selection::default();
            for tally in tallies {
                let by = tally.part.by;
                let value = if by.of_finding() {
                    let entries = finding_values(&context, by)
                        .into_iter()
                        .zip(tally.counts)
                        .map(|((key, label), count)| json!({"key": key, "label": label, "count": count}))
                        .collect::<Vec<_>>();
                    json!({"entries": entries, "more": 0})
                } else {
                    let under = tally.part.under.as_deref().unwrap_or("");
                    let lines =
                        self.aggregate(&tally.lines, &lines_selection, by, None, under, cancelled)?;
                    let mut value = if tally.units.is_empty() {
                        lines
                    } else {
                        merged(
                            lines,
                            self.aggregate(
                                &tally.units,
                                &units_selection,
                                by,
                                None,
                                under,
                                cancelled,
                            )?,
                        )
                    };
                    if by == Field::Paths {
                        value["under"] = json!(under);
                    }
                    value
                };
                values.insert(by.name().to_owned(), value);
            }
            answer.facets = Some(Value::Object(values));
            lap(&mut stages, "facets");
        }

        // A page: after the selected finding with the cursor's ID, then past the offset.
        let page = match &parts.rows {
            Some(rows) => {
                let mut start = 0;
                if let Some(after) = &rows.after
                    && let Some((line, first, second)) = id_lanes(after)
                    && let Some(position) = matched.iter().position(|number| {
                        (columns.line[*number as usize] != NONE) == line
                            && columns.lanes(*number) == (first, second)
                    })
                {
                    start = position + 1;
                }
                let start = start + rows.offset.unwrap_or(0) as usize;
                let limit = rows.limit as usize;
                let page = matched
                    .iter()
                    .skip(start)
                    .take(limit)
                    .copied()
                    .collect::<Vec<_>>();
                if start + page.len() < matched.len()
                    && let Some(last) = page.last()
                {
                    answer.next_cursor = Some(finding_id(&columns, *last));
                }
                page
            }
            None => Vec::new(),
        };
        lap(&mut stages, "page");

        let diagnostic_rows = |culture: Option<u32>| -> Result<Vec<usize>> {
            let cultures = layer.column("diag.cultures")?;
            Ok(layer
                .column("diag.order")?
                .iter()
                .map(|index| *index as usize)
                .filter(|index| culture.is_none_or(|ci| cultures[*index] == ci))
                .collect())
        };
        if counting {
            let codes = layer.column("diag.codes")?;
            let mut seen = Vec::<(u32, u32)>::new();
            for index in diagnostic_rows(culture)? {
                match seen.iter_mut().find(|(code, _)| *code == codes[index]) {
                    Some(entry) => entry.1 += 1,
                    None => seen.push((codes[index], 1)),
                }
            }
            let limits = seen
                .into_iter()
                .map(|(code, count)| {
                    Ok(CodeCount {
                        code: layer.dictionary.string(code)?.to_owned(),
                        count,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            answer.counts =
                Some(json!({"accepted": accepted_count, "fixable": fixable, "limits": limits}));
        }
        if let Some(part) = &parts.diagnostics {
            let rows = layer.column("diag.rows")?;
            let cultures = layer.column("diag.cultures")?;
            let codes = layer.column("diag.codes")?;
            let selected = diagnostic_rows(culture)?;
            let listed = selected
                .iter()
                .skip(part.offset.unwrap_or(0) as usize)
                .take(part.limit as usize)
                .map(|index| {
                    Ok(LineDiagnostic {
                        line_id: self.packed("line", rows[*index] as usize)?,
                        culture: self
                            .cultures
                            .get(cultures[*index] as usize)
                            .ok_or("Diagnostic culture outside target.")?
                            .clone(),
                        code: layer.dictionary.string(codes[*index])?.to_owned(),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            answer.diagnostics = Some(serde_json::to_value(Diagnostics {
                total: u32::try_from(selected.len())?,
                rows: listed,
            })?);
        }
        lap(&mut stages, "counts");

        if let Some(sink) = &parts.write {
            let started = Instant::now();
            let mut writer = SinkWriter::open(sink, reply)?;
            let mut out = Vec::new();
            for chunk in matched.chunks(MAX_LIMIT) {
                let (places, composed, _) = compose(self, &layer, chunk, cancelled)?;
                let sets = places
                    .into_iter()
                    .map(|set| (set.id, set.occurrences))
                    .collect::<HashMap<_, _>>();
                for finding in composed {
                    out.clear();
                    if writer.rows() > 0 {
                        out.push(b',');
                    }
                    out.extend_from_slice(b"\n\t\t");
                    pretty_json(&reported_finding(finding, &sets)?, 2, &mut out);
                    writer.write(&out)?;
                    writer.row();
                }
            }
            let summary = writer.finish()?;
            stages.insert("compose", started.elapsed().as_secs_f64() * 1000.0);
            answer.profile = Some(serde_json::to_value(ReadProfile {
                rows_requested: matched.len(),
                findings_returned: summary.rows as usize,
            })?);
            answer.sink = Some(serde_json::to_value(summary)?);
            answer.stages = Some(with_total(stages));
            return reply
                .part(javascript_json(&serde_json::to_value(&answer)?, false).into_bytes());
        }

        let (places, composed, times): (Vec<PlaceSet>, Vec<Value>, ComposeTimes) =
            if page.is_empty() {
                (Vec::new(), Vec::new(), ComposeTimes::default())
            } else {
                compose(self, &layer, &page, cancelled)?
            };
        lap(&mut stages, "compose");
        let mut stages = with_total(stages);
        // Parts of `compose`, so they stay out of the total.
        stages.insert("compose_open", times.open);
        stages.insert("compose_prefetch", times.prefetch);
        stages.insert("compose_rows", times.rows);
        if let Some(ms) = times.image {
            stages.insert("compose_dictionary_image", ms);
        }
        answer.profile = Some(serde_json::to_value(ReadProfile {
            rows_requested: parts.rows.as_ref().map_or(0, |rows| rows.limit as usize),
            findings_returned: composed.len(),
        })?);
        answer.stages = Some(stages);
        reply.part(javascript_json(&serde_json::to_value(&answer)?, false).into_bytes())?;
        send_findings(places, composed, reply)
    }
}

/// The stages with their `total`.
fn with_total(mut stages: BTreeMap<&'static str, f64>) -> BTreeMap<&'static str, f64> {
    let total = stages.values().sum();
    stages.insert("total", total);
    stages
}

#[cfg(test)]
impl EngineQuery {
    /// A finding rows query as one value: its part, with its place sets and findings gathered
    /// from their batches.
    pub(crate) fn finding_rows_page(
        &self,
        request: Value,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let request = crate::engine_types::parse_query(&request.to_string())?;
        let mut gathered = crate::engine::Gathered::default();
        self.query(&request, cancelled, &mut gathered)?;
        let mut page = crate::json_value::parse(std::str::from_utf8(
            gathered.parts.first().ok_or("A query has no part.")?,
        )?)?;
        let mut places: Vec<Value> = Vec::new();
        let mut findings = Vec::new();
        for body in &gathered.batches {
            let (part, rows) = crate::batch::read(body)?;
            for mut row in rows {
                if part == "findings" {
                    findings.push(row["finding"].take());
                    continue;
                }
                let set = row
                    .as_object_mut()
                    .and_then(|row| row.remove("parent"))
                    .ok_or("A place has no set.")?;
                match places.last_mut() {
                    Some(last) if last["id"] == set => last["occurrences"]
                        .as_array_mut()
                        .ok_or("A place set has no places.")?
                        .push(row),
                    _ => places.push(json!({"id": set, "occurrences": [row]})),
                }
            }
        }
        page["places"] = Value::Array(places);
        page["findings"] = Value::Array(findings);
        Ok(page)
    }
}

/// A findings request as hosts sent them before finding rows (`key`, `view`, `order`, `rules`,
/// `severities`, `fixable`, `change`, `line`, `id`, `lines`, `limit` …), as finding rows. Tests
/// written against that shape read finding rows through it.
#[cfg(test)]
pub(crate) fn as_finding_rows(query: &EngineQuery, old: &Value) -> Result<Value> {
    let marked = |field: &str, test: Value| json!({"facet": [field, test]});
    let one_of = |field: &str, values: &Value| json!({"in": [{"field": field}, {"lit": values}]});
    let mut tests = Vec::new();
    if let Some(rules) = old.get("rules") {
        tests.push(marked("rule", one_of("rule", rules)));
    }
    if let Some(severities) = old.get("severities") {
        tests.push(marked("severity", one_of("severity", severities)));
    }
    for flag in ["fixable", "change"] {
        if let Some(value) = old.get(flag) {
            tests.push(marked(flag, one_of(flag, &json!([value]))));
        }
    }
    if let Some(line) = old.get("line") {
        tests.push(json!({"row": one_of("id", &json!([line]))}));
    }
    if let Some(id) = old.get("id") {
        tests.push(one_of("id", &json!([id])));
    }
    // The source order lists only source findings; finding rows say so.
    if old["order"] == json!("source") {
        tests.push(one_of("subject", &json!(["unit_source"])));
    }
    if let Some(filter) = old.pointer("/lines/where") {
        tests.push(json!({"row": filter}));
    }
    let mut findings = json!({"key": old["key"], "view": old["view"]});
    if let Some(acceptance) = old.get("acceptance") {
        findings["acceptance"] = acceptance.clone();
    }
    let mut selection = json!({
        "target": query.target["name"],
        "rows": "findings",
        "findings": findings,
    });
    if let Some(culture) = old.get("culture") {
        selection["culture"] = culture.clone();
    }
    if let Some(text) = old.pointer("/lines/text") {
        selection["text"] = json!({"query": text, "translations": true});
    }
    if !tests.is_empty() {
        selection["where"] = json!({"and": tests});
    }
    let mut parts = json!({});
    let limit = old["limit"].as_u64();
    if let Some(sink) = old.get("sink") {
        parts["write"] = sink.clone();
    } else if limit.is_some_and(|limit| limit > 0) {
        let mut rows = json!({"limit": limit, "order": old["order"]});
        if let Some(offset) = old.get("offset") {
            rows["offset"] = offset.clone();
        }
        if let Some(after) = old.get("after") {
            rows["after"] = after.clone();
        }
        parts["rows"] = rows;
    }
    if old["counts"] == json!(true) {
        parts["counts"] = json!(true);
        parts["facets"] = json!([{"by": "rule"}, {"by": "severity"}]);
    }
    if let Some(diagnostics) = old.get("diagnostics") {
        parts["diagnostics"] = diagnostics.clone();
    }
    Ok(json!({"selection": selection, "parts": parts}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::join_fact_tests::{Fixture, example_document};

    /// Four lines in three cultures, with line, culture and source findings, evaluated.
    fn fixture_findings() -> Result<(EngineQuery, String)> {
        let mut fixture = Fixture::new()?;
        fixture.target["cultures"] = json!(["en", "de", "fr"]);
        fixture.target["outputPaths"]["archives"]["fr"] = json!("fr.archive");
        fixture.target["outputPaths"]["portableObjects"]["fr"] = json!("fr.po");
        let line = |key: &str, source: &str, path: &str| json!({"namespace":"UI","key":key,"source":source,"path":path});
        fixture.file(
            "Game.manifest",
            "manifest",
            &[
                line("A", "Take {Count}", "/Game/Text/Example.Example.A"),
                line("B", " Spaced source", "/Game/Text/UI/Menu.Menu.B"),
                line("C", "a bad word here", "/Game/Text/Other.Other.C"),
                line("D", "OK", "/Game/Text/UI/Menu.Menu.D"),
            ],
        )?;
        let archive = |translations: [&str; 4]| {
            ["A", "B", "C", "D"]
                .iter()
                .zip(["Take {Count}", " Spaced source", "a bad word here", "OK"])
                .zip(translations)
                .map(|((key, source), translation)| {
                    json!({"namespace":"UI","key":key,"source":source,"translation":translation})
                })
                .collect::<Vec<_>>()
        };
        fixture.file(
            "en.archive",
            "archive",
            &archive(["Take {Count}", " Spaced source", "a bad word here", "OK"]),
        )?;
        fixture.file(
            "de.archive",
            "archive",
            &archive(["Nimm {Anzahl}", "", "ein schlechtes Wort", "OK"]),
        )?;
        fixture.file(
            "fr.archive",
            "archive",
            &archive(["Prends {Count} ", " Espace", "un mot", "OK"]),
        )?;
        for culture in ["en", "de", "fr"] {
            fixture.file(&format!("{culture}.po"), "po", &[])?;
        }
        let place = |key: &str, source: &str, object: &str, property: &str| json!({"namespace":"UI","key":key,"source":source,"object":object,"property":property});
        fixture.packages(&[
            place("A", "Take {Count}", "/Game/Text/Example.Example", "A"),
            place("B", " Spaced source", "/Game/Text/UI/Menu.Menu", "B"),
            place("C", "a bad word here", "/Game/Text/Other.Other", "C"),
            place("C", "a bad word here", "/Game/Text/UI/Menu.Menu", "C2"),
            place("D", "OK", "/Game/Text/UI/Menu.Menu", "D"),
        ])?;
        fixture.lines()?;
        let role = json!({"id":"all","scopes":[{"matchers":[{"kind":"object_path","operator":"prefix","value":"/Game/"}]}]});
        let checks = [
            "format_arguments",
            "whitespace",
            "empty_translation",
            "format_argument_renamed",
            "source_whitespace",
            "placeholder_text",
        ];
        let mut rules = checks
            .iter()
            .map(|kind| json!({"kind": kind}))
            .collect::<Vec<_>>();
        rules.push(json!({"id":"budget","kind":"character_budget","role":"all","maximumCharacters":8,"recovery":"Shorten it."}));
        rules.push(json!({"id":"terms","kind":"terminology","role":"all","caseSensitive":false,"terms":[{"kind":"forbidden","term":"bad"}],"recovery":"Replace it."}));
        let document = example_document(
            &checks,
            Some(json!({"schemaVersion":1,"roles":[role],"rules":rules})),
        )?;
        let configuration = fixture.configuration.clone();
        drop(fixture);
        let query = EngineQuery::open(&configuration, None)?;
        let cancelled = AtomicBool::new(false);
        let evaluated =
            crate::json_value::parse(&query.findings_evaluate(&document, "en", &cancelled)?)?;
        let key = evaluated["key"].as_str().ok_or("Missing findings key.")?;
        Ok((query, key.to_owned()))
    }

    /// The requests the workspace, the source report and `loc check` send agree with each other:
    /// pages are slices of the whole list, counts add up, and a write lists what a page lists.
    #[test]
    fn finding_rows_pages_counts_and_writes_agree() -> Result<()> {
        let (query, key) = fixture_findings()?;
        let key = key.as_str();
        let cancelled = AtomicBool::new(false);
        let layer = query.layer(key)?;
        let source_rules = layer
            .metadata
            .rules
            .iter()
            .filter(|rule| rule.subject == Subject::UnitSource)
            .map(|rule| rule.rule_id.clone())
            .collect::<Vec<_>>();
        require(source_rules.len() == 2, "The fixture has two source rules.")?;
        let renamed = layer
            .metadata
            .rules
            .iter()
            .find(|rule| rule.kind == "format_argument_renamed")
            .map(|rule| rule.rule_id.clone())
            .ok_or("Missing the renamed-argument rule.")?;
        let source = "Take {Count}";
        let accepted = crate::json_value::parse(&query.findings_accept(
            json!({"key": key, "accepted": [{"check": renamed, "namespace": "UI", "key": "A", "culture": "de",
                "fingerprint": super::super::findings_query::review_fingerprint(source, Some("Nimm {Anzahl}"))}]}),
            &cancelled,
        )?)?;
        let acceptance = accepted["acceptance"].clone();
        let page = |request: Value| query.findings_page(request, &cancelled);
        let workspace = |fields: Value| {
            let mut request =
                json!({"key":key,"view":"workspace","order":"severity","limit":5000,"counts":true});
            for (name, value) in fields.as_object().into_iter().flatten() {
                request[name] = value.clone();
            }
            request
        };
        let ids = |page: &Value| -> Vec<Value> {
            page["findings"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|finding| finding["id"].clone())
                .collect()
        };
        let entries = |page: &Value, field: &str| -> Vec<(String, u64)> {
            page["facets"][field]["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|entry| {
                    (
                        entry["key"].as_str().unwrap_or_default().to_owned(),
                        entry["count"].as_u64().unwrap_or(0),
                    )
                })
                .collect()
        };
        let sum = |entries: &[(String, u64)]| entries.iter().map(|(_, count)| count).sum::<u64>();

        let all = page(workspace(json!({})))?;
        let every = ids(&all);
        require(
            every.len() >= 6,
            format!("The fixture has findings of each kind: {all}"),
        )?;
        assert_eq!(all["total"], json!(every.len()));
        // Unfiltered, the rule and severity counts each add up to the list.
        assert_eq!(sum(&entries(&all, "rule")), every.len() as u64);
        assert_eq!(sum(&entries(&all, "severity")), every.len() as u64);
        // Blocking findings first, then normal, then low.
        let rank = |severity: &str| {
            ["blocking", "normal", "low"]
                .iter()
                .position(|s| *s == severity)
        };
        let severities = all["findings"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|finding| rank(finding["severity"].as_str().unwrap_or_default()))
            .collect::<Vec<_>>();
        assert!(severities.is_sorted(), "{severities:?}");

        // Offsets and cursors read slices of the list; an ID reads its finding.
        assert_eq!(
            ids(&page(workspace(json!({"offset": 2, "limit": 2})))?),
            every[2..4]
        );
        assert_eq!(
            ids(&page(workspace(json!({"after": every[0], "limit": 3})))?),
            every[1..4]
        );
        let found =
            page(json!({"key":key,"view":"workspace","order":"severity","id":every[3],"limit":1}))?;
        assert_eq!(ids(&found), vec![every[3].clone()]);

        // A severity filter leaves the severity counts and narrows the rule counts to it.
        let blocking = page(workspace(json!({"severities": ["blocking"]})))?;
        assert_eq!(entries(&blocking, "severity"), entries(&all, "severity"));
        let blocking_count = entries(&all, "severity")
            .iter()
            .find(|(key, _)| key == "blocking")
            .map_or(0, |(_, count)| *count);
        assert_eq!(blocking["total"], json!(blocking_count));
        assert_eq!(sum(&entries(&blocking, "rule")), blocking_count);
        // A rule filter leaves the rule counts.
        let sources = page(workspace(json!({"rules": source_rules})))?;
        assert_eq!(entries(&sources, "rule"), entries(&all, "rule"));
        // The source order lists the source rules' findings, which are the source findings.
        let ordered = page(
            json!({"key":key,"view":"workspace","order":"source","rules":source_rules,"limit":5000}),
        )?;
        assert_eq!(ordered["total"], sources["total"]);
        assert!(
            ordered["findings"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|finding| finding.get("lineId").is_none())
        );

        // The acceptance hides what it accepted, in every culture selection.
        for culture in [None, Some("de")] {
            let mut fields = json!({});
            if let Some(culture) = culture {
                fields["culture"] = json!(culture);
            }
            let open = page(workspace(fields.clone()))?;
            fields["acceptance"] = acceptance.clone();
            let reviewed = page(workspace(fields))?;
            assert_eq!(reviewed["counts"]["accepted"], json!(1));
            assert_eq!(
                reviewed["total"].as_u64().unwrap_or(0) + 1,
                open["total"].as_u64().unwrap_or(0)
            );
        }
        // A text search keeps the findings whose line or source holds every word.
        let take = page(workspace(json!({"lines": {"text": "take"}})))?;
        assert!(take["total"].as_u64().unwrap_or(0) > 0);
        assert_eq!(
            page(workspace(json!({"lines": {"text": "zzz"}})))?["total"],
            json!(0)
        );

        // `loc check`: the report's rule counts add up to what the write lists.
        let report = |fields: Value| {
            let mut request = json!({"key":key,"view":"report","culture":"de","order":"report"});
            for (name, value) in fields.as_object().into_iter().flatten() {
                request[name] = value.clone();
            }
            request
        };
        let counted = page(report(
            json!({"limit":0,"diagnostics":{"offset":0,"limit":100},"counts":true}),
        ))?;
        let listed = page(report(json!({"limit": 5000})))?;
        assert_eq!(counted["total"], json!(ids(&listed).len()));
        assert_eq!(sum(&entries(&counted, "rule")), ids(&listed).len() as u64);
        let mut written = crate::engine::Gathered::default();
        let request = as_finding_rows(&query, &report(json!({"sink":{"format":"findingJson"}})))?;
        query.query(
            &crate::engine_types::parse_query(&request.to_string())?,
            &cancelled,
            &mut written,
        )?;
        let head = crate::json_value::parse(std::str::from_utf8(
            written.parts.first().ok_or("A write has no part.")?,
        )?)?;
        assert_eq!(head["sink"]["rows"], json!(ids(&listed).len()));
        // The suggested changes `loc check` collects.
        let changes = page(report(
            json!({"order":"line","rules":[renamed],"change":true,"offset":0,"limit":100}),
        ))?;
        assert!(
            changes["findings"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|finding| finding.get("suggestedChange").is_some())
        );
        Ok(())
    }

    /// Finding rows test their text row with the Text tab's grammar: a culture's finding in that
    /// culture's scope, a source finding through its unit; and count by its fields.
    #[test]
    fn finding_rows_test_their_text_rows_as_the_text_tab_does() -> Result<()> {
        let (query, key) = fixture_findings()?;
        let cancelled = AtomicBool::new(false);
        let target = query.target["name"].clone();
        let rows = |filter: Value, parts: Value| {
            query.finding_rows_page(
                json!({"selection":{"target":target,"rows":"findings",
                    "findings":{"key":key,"view":"workspace"},"where":filter},"parts":parts}),
                &cancelled,
            )
        };
        let ids = |page: &Value| -> Vec<Value> {
            page["findings"]
                .as_array()
                .map(|findings| {
                    findings
                        .iter()
                        .map(|finding| finding["id"].clone())
                        .collect()
                })
                .unwrap_or_default()
        };
        let every = query.finding_rows_page(
            json!({"selection":{"target":target,"rows":"findings","findings":{"key":key,"view":"workspace"}},
                "parts":{"rows":{"limit":5000}}}),
            &cancelled,
        )?;
        let findings = every["findings"]
            .as_array()
            .ok_or("Missing findings.")?
            .clone();
        // The Text tab's matching lines in a culture scope, and its matching units.
        let text_tab = |filter: &Value, culture: Option<&str>| -> Result<HashSet<String>> {
            let mut selection = json!({"target":target,"where":filter});
            if let Some(culture) = culture {
                selection["culture"] = json!(culture);
            }
            let page = query.query_page(
                json!({"selection":selection,"parts":{"rows":{"limit":5000}}}),
                &cancelled,
            )?;
            Ok(page["localization"]["lines"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|line| line["id"].as_str().map(str::to_owned))
                .collect())
        };
        let units = |filter: &Value| -> Result<HashSet<String>> {
            let page = query.query_page(
                json!({"selection":{"where":filter},"parts":{"rows":{"limit":5000}}}),
                &cancelled,
            )?;
            Ok(page["units"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|unit| unit["id"].as_str().map(str::to_owned))
                .collect())
        };
        // What a row test should keep, from the Text tab's answers.
        let expected = |filter: &Value, for_units: Option<&Value>| -> Result<Vec<Value>> {
            let scope = text_tab(filter, None)?;
            let mut by_culture = HashMap::new();
            for culture in query.cultures.clone() {
                by_culture.insert(culture.clone(), text_tab(filter, Some(&culture))?);
            }
            let source = match for_units {
                Some(filter) => units(filter)?,
                None => HashSet::new(),
            };
            Ok(findings
                .iter()
                .filter(|finding| match finding["lineId"].as_str() {
                    Some(line) => match finding["culture"].as_str() {
                        Some(culture) => by_culture[culture].contains(line),
                        None => scope.contains(line),
                    },
                    None => finding["textUnitId"]
                        .as_str()
                        .is_some_and(|unit| source.contains(unit)),
                })
                .map(|finding| finding["id"].clone())
                .collect())
        };

        // A culture test reads the finding's own culture.
        for state in crate::engine_types::STATES {
            let filter = json!({"anyCulture":{"in":[{"field":"state"},{"lit":[state]}]}});
            let page = rows(json!({"row": filter}), json!({"rows":{"limit":5000}}))?;
            assert_eq!(ids(&page), expected(&filter, None)?, "{state}");
        }
        // A source finding is tested through its unit; a line's test it can't read is false.
        let under = json!({"facet":["paths",{"any":[{"field":"paths"},{"pathHasPrefix":[{"var":"item"},{"lit":"/Game/Text/UI"}]}]}]});
        let page = rows(
            json!({"row": under}),
            json!({"rows":{"limit":5000},"counts":true,
            "facets":[{"by":"paths","under":"/Game/Text"},{"by":"files"},{"by":"subject"}]}),
        )?;
        let kept = ids(&page);
        assert_eq!(kept, expected(&under, Some(&under))?);
        assert!(
            page["findings"].as_array().is_some_and(|findings| findings
                .iter()
                .any(|finding| finding.get("textUnitId").is_some())),
            "A source finding is kept through its unit: {page}"
        );
        let changed = json!({"eq":[{"field":"keyChanged"},{"lit":true}]});
        let none = rows(json!({"row": changed}), json!({"rows":{"limit":5000}}))?;
        assert!(ids(&none).iter().all(|id| {
            id.as_str()
                .is_some_and(|id| id.starts_with("localization-finding:"))
        }));
        let not_changed = rows(
            json!({"row":{"not": changed}}),
            json!({"rows":{"limit":5000}}),
        )?;
        assert!(ids(&not_changed).iter().any(|id| {
            id.as_str()
                .is_some_and(|id| id.starts_with("quality-finding:"))
        }));
        // Counting by a row field keeps the other fields' tests, and counts each finding under
        // its row's values: every place here is in one package.
        let files = page["facets"]["files"]["entries"]
            .as_array()
            .ok_or("Missing files.")?;
        assert_eq!(files.len(), 1, "{page}");
        assert_eq!(files[0]["count"], json!(kept.len()));
        assert_eq!(page["facets"]["paths"]["under"], "/Game/Text");
        let subjects = page["facets"]["subject"]["entries"]
            .as_array()
            .ok_or("Missing subjects.")?;
        let counted = subjects
            .iter()
            .map(|entry| entry["count"].as_u64().unwrap_or(0))
            .sum::<u64>();
        assert_eq!(counted, kept.len() as u64);
        Ok(())
    }
}
