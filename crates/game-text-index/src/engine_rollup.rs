//! Library-style reads over matched rows: grouped counts by any stored dimension (`aggregate`),
//! chosen line fields (`localization_lines` with `fields`), and the corpus content fingerprint.
//! Each one answers a question in Rust, so hosts stop exporting the corpus to derive it.
use crate::engine_match::{Kind, Projection, checkpoint};
use crate::engine_places::Places;
use crate::engine_query::{EngineQuery, audience, selected_bits};
use crate::engine_types::*;
use crate::rules::FindingRows;
use crate::sink::{Format, Sink};
use crate::{Result, require};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::AtomicBool;

/// One grouping dimension. Culture-mark dimensions (`state`, `fact`, `unknown_reason`, `review`,
/// `review_status`, `review_flag`) need `culture` before them; a row then counts once for each culture in scope.
/// Multi-valued dimensions (`fact`, `unknown_reason`, `review`, `review_flag`, `origin`,
/// `problem`, `finding`, `asset`) count a row once under each of its values and not at all when
/// it has none.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Dimension {
    Culture,
    State,
    Fact,
    UnknownReason,
    Review,
    ReviewStatus,
    ReviewFlag,
    TranslationKey,
    Source,
    Namespace,
    Audience,
    Origin,
    Problem,
    /// The rules of the search's findings layer with a finding on the row.
    Finding,
    /// The row's facts.
    ReviewSignal,
    Asset,
    Gathered,
}
impl Dimension {
    fn per_culture(self) -> bool {
        matches!(
            self,
            Self::State
                | Self::Fact
                | Self::UnknownReason
                | Self::Review
                | Self::ReviewStatus
                | Self::ReviewFlag
        )
    }
    fn needs_target(self) -> bool {
        self.per_culture() || matches!(self, Self::Culture | Self::TranslationKey | Self::Gathered)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Measure {
    Lines,
    SourceWords,
    LineBreakWords,
}

/// The selection's rows, counted by `by` and measured by `measures`. An aggregate lists every
/// group.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AggregateRequest {
    pub selection: Selection,
    pub by: Vec<Dimension>,
    #[serde(default)]
    pub measures: Vec<Measure>,
}

pub fn parse_aggregate_request(payload: &str) -> Result<AggregateRequest> {
    let AggregateRequest {
        selection,
        by,
        measures,
    } = parse_request(payload, "aggregate")?;
    selection.validate()?;
    require(
        (1..=4).contains(&by.len()),
        invalid("An aggregate groups by one to four dimensions."),
    )?;
    for (index, dimension) in by.iter().enumerate() {
        require(
            !by[..index].contains(dimension),
            invalid("Aggregate dimensions must be distinct."),
        )?;
        require(
            !dimension.needs_target() || selection.localized(),
            invalid("Culture, translation key and gathered dimensions need a localization target."),
        )?;
        require(
            !dimension.per_culture() || by[..index].contains(&Dimension::Culture),
            invalid("A culture-mark dimension needs `culture` before it."),
        )?;
    }
    for (index, measure) in measures.iter().enumerate() {
        require(
            !measures[..index].contains(measure),
            invalid("Aggregate measures must be distinct."),
        )?;
    }
    Ok(AggregateRequest {
        selection,
        by,
        measures,
    })
}

/// A key component: an index into a fixed vocabulary, or a dictionary or label ID.
type Code = u32;
/// A group's key: one component per dimension, at most four; the rest stay zero. A fixed array,
/// so counting a row allocates nothing.
type Key = [Code; 4];
#[derive(Default)]
struct Tally {
    lines: u64,
    source_words: u64,
    line_break_words: u64,
    unknown_words: u64,
}

const LINE_BREAK_UNKNOWN: u32 = u32::MAX;
const NO_KEY: u32 = u32::MAX;

impl EngineQuery {
    /// Unreal's word count of the text it gathers for a line: its first required manifest
    /// entry's source, else the line's saved source. Counted once per text and cached.
    fn line_break_words_of(&self, cache: &mut HashMap<u32, u32>, text: u32) -> Result<u32> {
        if let Some(words) = cache.get(&text) {
            return Ok(*words);
        }
        let value = self.reader.string(text)?;
        let units = crate::wtf8::Wtf8Buf::from_view(&value).to_utf16();
        let words = crate::line_break::line_break_words(&units).unwrap_or(LINE_BREAK_UNKNOWN);
        cache.insert(text, words);
        Ok(words)
    }
    fn gathered_text(&self, projection: &Projection, row: usize) -> Result<u32> {
        let begin = projection.manifest_start[row] as usize;
        let end = projection.manifest_end[row] as usize;
        if begin != end {
            let name = self.target["outputPaths"]["manifest"]
                .as_str()
                .ok_or("Missing manifest input.")?
                .to_owned();
            let options = self.reader.input_column(&name, "entry.options")?;
            let sources = self.reader.input_column(&name, "entry.source")?;
            for entry in &projection.manifest[begin..end] {
                let flags = *options
                    .get(*entry as usize)
                    .ok_or("Manifest flags outside input.")?;
                // An optional entry (Unreal's `Optional: true`) is left out of word counts.
                if flags & 3 != 3 {
                    return Ok(*sources
                        .get(*entry as usize)
                        .ok_or("Manifest source outside input.")?);
                }
            }
        }
        Ok(projection.source[row])
    }
    fn review_flags(&self, projection: &Projection, row: usize, ci: usize) -> Result<Vec<String>> {
        let culture = &projection.cultures[ci];
        if culture.review[row] != 2 {
            return Ok(Vec::new());
        }
        let record = culture.review_record[row]
            .checked_sub(1)
            .ok_or("Invalid review record.")? as usize;
        Ok(self.reader.meta["input"]["review"]["records"]
            .get(record)
            .and_then(|record| record["flags"].as_array())
            .ok_or("Missing review flags.")?
            .iter()
            .filter_map(|flag| flag.as_str().map(str::to_owned))
            .collect())
    }

    /// Grouped counts: the matching lines as a part, then the `groups` part. A key's
    /// components are text: a translation key is its `[namespace, key]` JSON, a flag `true` or
    /// `false`, and no value the empty string.
    pub fn send_aggregate(
        &self,
        request: &AggregateRequest,
        cancelled: &AtomicBool,
        reply: &mut dyn crate::engine::Reply,
    ) -> Result<()> {
        let mut value = self.aggregate_value(request, cancelled)?;
        reply.part(crate::wtf8::view_json(&json!({"lines": value["lines"]}))?.into_bytes())?;
        let mut groups =
            crate::batch::Batches::new(&crate::batch::GROUP, "groups", crate::batch::GROUP.all());
        let Some(Value::Array(rows)) = value.get_mut("groups").map(Value::take) else {
            return Err("An aggregate has no groups.".into());
        };
        for mut group in rows {
            let key = group["key"]
                .as_array()
                .ok_or("An aggregate group has no key.")?
                .iter()
                .map(|component| match component {
                    Value::Null => Ok(Value::String(String::new())),
                    Value::Bool(flag) => Ok(Value::String(flag.to_string())),
                    Value::String(_) => Ok(component.clone()),
                    Value::Array(_) => Ok(Value::String(
                        crate::wtf8::Wtf8Buf::from_utf8(&crate::rules::javascript_json(
                            component, false,
                        ))
                        .into_view(),
                    )),
                    _ => Err("An aggregate key component is not text.".into()),
                })
                .collect::<Result<Vec<_>>>()?;
            group["key"] = Value::Array(key);
            groups.push(&group)?;
            if groups.full() {
                groups.flush(reply)?;
            }
        }
        groups.finish(reply)?;
        Ok(())
    }

    pub fn aggregate_value(
        &self,
        request: &AggregateRequest,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let rows = self.matching(&request.selection, cancelled)?;
        let projection = Projection::open(self, cancelled)?;
        let places = Places::open(self)?;
        let localized = request.selection.localized();
        let kind = if localized { Kind::Line } else { Kind::Raw };
        let scope = if localized {
            self.culture_scope(&request.selection)?
        } else {
            Vec::new()
        };
        let findings = self.request_findings(&request.selection, cancelled)?;
        let problems = if request.by.contains(&Dimension::Problem) {
            self.problem_column(localized, &scope, findings.as_deref(), cancelled)?
        } else {
            std::sync::Arc::from([])
        };
        let cultures: Vec<usize> = match &request.selection.cultures {
            Some(selected) => self
                .cultures
                .iter()
                .enumerate()
                .filter(|(_, culture)| selected.contains(culture))
                .map(|(index, _)| index)
                .collect(),
            None => (0..self.cultures.len()).collect(),
        };
        let words_column = if localized {
            self.reader.column("line.source_words")?
        } else {
            self.column("raw", "words")?
        };
        let wants_line_break = request.measures.contains(&Measure::LineBreakWords);
        // Word counts persist on the reader: its texts never change.
        let mut word_cache = std::mem::take(&mut *self.line_break_words.lock());
        let mut flag_names: Vec<String> = Vec::new();
        let mut identities: Vec<(u32, u32)> = Vec::new();
        let mut identity_codes: HashMap<(u32, u32), u32> = HashMap::new();
        let mut tallies: HashMap<Key, Tally> = HashMap::new();
        let culture_position = request.by.iter().position(|d| *d == Dimension::Culture);
        // Whether the review file reviews this target: the same for every row.
        let reviews_target = self.reader.meta["input"]["review"]["target"] == self.target["name"];
        for (index, row) in rows.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            let source_words = u64::from(*words_column.get(row).ok_or("Invalid word counts.")?);
            let line_break = if wants_line_break {
                let text = if localized {
                    self.gathered_text(&projection, row)?
                } else {
                    *projection
                        .raw
                        .sources(row)
                        .first()
                        .ok_or("Stored unit has no source values.")?
                };
                self.line_break_words_of(&mut word_cache, text)?
            } else {
                0
            };
            // Values of every row-level dimension; mark dimensions are filled per culture.
            let mut values: Vec<Vec<Code>> = Vec::with_capacity(request.by.len());
            for dimension in &request.by {
                let codes = match dimension {
                    Dimension::Culture
                    | Dimension::State
                    | Dimension::Fact
                    | Dimension::UnknownReason
                    | Dimension::Review
                    | Dimension::ReviewStatus
                    | Dimension::ReviewFlag => Vec::new(),
                    Dimension::TranslationKey => {
                        let empty = projection.starts[row] != projection.starts[row + 1]
                            && self.reader.string(projection.key[row])?.is_empty();
                        if empty {
                            vec![NO_KEY]
                        } else {
                            let pair = (projection.namespace[row], projection.key[row]);
                            let next = identities.len() as u32;
                            let code = *identity_codes.entry(pair).or_insert(next);
                            if code == next {
                                identities.push(pair);
                            }
                            vec![code]
                        }
                    }
                    Dimension::Source => vec![if localized {
                        projection.source[row]
                    } else {
                        *projection
                            .raw
                            .sources(row)
                            .first()
                            .ok_or("Stored unit has no source values.")?
                    }],
                    Dimension::Namespace => {
                        vec![projection.namespace(&places, kind, row)?.unwrap_or(0)]
                    }
                    Dimension::Audience => {
                        let value = audience(if localized {
                            projection.audience[row]
                        } else {
                            projection.raw.audience[row]
                        });
                        vec![
                            AUDIENCES
                                .iter()
                                .position(|label| *label == value)
                                .ok_or("Unknown audience.")? as u32,
                        ]
                    }
                    Dimension::Origin => bits(if localized {
                        projection.origins[row]
                    } else {
                        projection.raw.origins[row]
                    }),
                    Dimension::Problem => bits(problems[row]),
                    Dimension::Finding => findings.as_ref().map_or_else(Vec::new, |findings| {
                        findings.of(row).map(|rule| rule as u32).collect()
                    }),
                    Dimension::ReviewSignal => bits(
                        if localized {
                            projection.flags[row]
                        } else {
                            projection.raw.signals[row]
                        } >> FACT_SHIFT,
                    ),
                    Dimension::Asset => {
                        let mut assets = Vec::new();
                        projection.each_file(kind, row, &mut |file| {
                            let (key, _) = places.coordinate(file, false, None, None)?;
                            if !assets.contains(&key) {
                                assets.push(key);
                            }
                            Ok(false)
                        })?;
                        assets
                    }
                    Dimension::Gathered => vec![u32::from(
                        projection.manifest_start[row] != projection.manifest_end[row],
                    )],
                };
                values.push(codes);
            }
            let mut add = |values: &[Vec<Code>]| {
                let mut key: Key = [0; 4];
                each_key(values, 0, &mut key, &mut |key| {
                    let tally = tallies.entry(*key).or_default();
                    tally.lines += 1;
                    tally.source_words += source_words;
                    if line_break == LINE_BREAK_UNKNOWN {
                        tally.unknown_words += 1;
                    } else {
                        tally.line_break_words += u64::from(line_break);
                    }
                });
            };
            match culture_position {
                None => add(&values),
                Some(_) => {
                    for ci in &cultures {
                        let c = &projection.cultures[*ci];
                        // Culture-mark values refill their slots in place: no allocation per
                        // row and culture.
                        for (position, dimension) in request.by.iter().enumerate() {
                            if !dimension.per_culture() && *dimension != Dimension::Culture {
                                continue;
                            }
                            let slot = &mut values[position];
                            slot.clear();
                            match dimension {
                                Dimension::Culture => slot.push(*ci as u32),
                                Dimension::State => slot.push(c.state[row]),
                                Dimension::Fact => push_bits(slot, c.facts[row]),
                                Dimension::UnknownReason => {
                                    push_bits(slot, c.reasons[row] & ((1 << REASONS.len()) - 1))
                                }
                                Dimension::Review => {
                                    if reviews_target {
                                        push_bits(slot, projection.review(self, row, *ci)?)
                                    }
                                }
                                // 1 not reviewed, 2 current, 3 changed since review.
                                Dimension::ReviewStatus => {
                                    if c.review[row] != 0 {
                                        slot.push(c.review[row])
                                    }
                                }
                                Dimension::ReviewFlag => {
                                    for flag in self.review_flags(&projection, row, *ci)? {
                                        let code = match flag_names.iter().position(|v| *v == flag)
                                        {
                                            Some(code) => code,
                                            None => {
                                                flag_names.push(flag);
                                                flag_names.len() - 1
                                            }
                                        } as u32;
                                        if !slot.contains(&code) {
                                            slot.push(code);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        add(&values);
                    }
                }
            }
        }
        self.line_break_words.lock().extend(word_cache);
        // Each key component reads as a string (a translation key as `[namespace, key]`), and
        // the groups list in each dimension's own order, components left to right.
        let mut texts: HashMap<(usize, u32), (String, Value)> = HashMap::new();
        let mut sorted = Vec::with_capacity(tallies.len());
        for (index, (key, tally)) in tallies.into_iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            for (position, code) in key.iter().take(request.by.len()).enumerate() {
                let dimension = request.by[position];
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    texts.entry((position, *code))
                {
                    let (rank, value) = match dimension {
                        Dimension::Culture => (
                            format!("{code:08}"),
                            json!(
                                self.cultures
                                    .get(*code as usize)
                                    .ok_or("Unknown culture.")?
                            ),
                        ),
                        Dimension::State => (format!("{code:08}"), json!(STATES[*code as usize])),
                        Dimension::Fact => (format!("{code:08}"), json!(STATES[*code as usize])),
                        Dimension::UnknownReason => {
                            (format!("{code:08}"), json!(REASONS[*code as usize]))
                        }
                        Dimension::Review => (format!("{code:08}"), json!(REVIEWS[*code as usize])),
                        Dimension::ReviewStatus => (
                            format!("{code:08}"),
                            json!(
                                ["not_reviewed", "current", "changed"]
                                    .get((*code as usize).wrapping_sub(1))
                                    .ok_or("Unknown review status.")?
                            ),
                        ),
                        Dimension::ReviewFlag => {
                            let flag = flag_names[*code as usize].clone();
                            (flag.clone(), json!(flag))
                        }
                        Dimension::Origin => (format!("{code:08}"), json!(ORIGINS[*code as usize])),
                        Dimension::Problem => {
                            (format!("{code:08}"), json!(PROBLEMS[*code as usize]))
                        }
                        Dimension::Finding => (
                            format!("{code:08}"),
                            json!(
                                findings
                                    .as_ref()
                                    .and_then(|findings| findings.rules.get(*code as usize))
                                    .ok_or("Unknown finding rule.")?
                                    .id
                            ),
                        ),
                        Dimension::ReviewSignal => {
                            (format!("{code:08}"), json!(FACTS[*code as usize]))
                        }
                        Dimension::Audience => {
                            (format!("{code:08}"), json!(AUDIENCES[*code as usize]))
                        }
                        Dimension::Gathered => (format!("{code:08}"), json!(*code == 1)),
                        Dimension::TranslationKey => {
                            if *code == NO_KEY {
                                (String::new(), Value::Null)
                            } else {
                                let (namespace, key) = identities[*code as usize];
                                let namespace = self.reader.string(namespace)?;
                                let key = self.reader.string(key)?;
                                (format!("{namespace}\u{0}{key}"), json!([namespace, key]))
                            }
                        }
                        Dimension::Source => {
                            let text = self.reader.string(*code)?;
                            (text.clone(), json!(text))
                        }
                        Dimension::Namespace => {
                            let text = places.labels.text(*code)?;
                            (text.clone(), json!(text))
                        }
                        Dimension::Asset => {
                            let text = places.labels.text(*code)?;
                            (text.clone(), json!(text))
                        }
                    };
                    entry.insert((rank, value));
                }
            }
            sorted.push((key, tally));
        }
        let rank = |key: &Key, position: usize| -> &String { &texts[&(position, key[position])].0 };
        sorted.sort_by(|(left, _), (right, _)| {
            (0..request.by.len())
                .map(|position| crate::join::ordinal(rank(left, position), rank(right, position)))
                .find(|ordering| ordering.is_ne())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut groups = Vec::with_capacity(sorted.len());
        for (index, (key, tally)) in sorted.into_iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let mut group = serde_json::Map::new();
            group.insert(
                "key".into(),
                json!(
                    key.iter()
                        .take(request.by.len())
                        .enumerate()
                        .map(|(position, code)| texts[&(position, *code)].1.clone())
                        .collect::<Vec<_>>()
                ),
            );
            group.insert("lines".into(), json!(tally.lines));
            if request.measures.contains(&Measure::SourceWords) {
                group.insert("sourceWords".into(), json!(tally.source_words));
            }
            if wants_line_break {
                group.insert("lineBreakWords".into(), json!(tally.line_break_words));
                group.insert("unknownWords".into(), json!(tally.unknown_words));
            }
            groups.push(Value::Object(group));
        }
        Ok(json!({"lines":rows.len(),"groups":groups}))
    }
}

fn bits(value: u32) -> Vec<Code> {
    (0..32).filter(|bit| value & (1 << bit) != 0).collect()
}
fn push_bits(codes: &mut Vec<Code>, value: u32) {
    codes.extend((0..32).filter(|bit| value & (1 << bit) != 0));
}
fn each_key(values: &[Vec<Code>], position: usize, key: &mut Key, visit: &mut impl FnMut(&Key)) {
    if position == values.len() {
        visit(key);
        return;
    }
    for code in &values[position] {
        key[position] = *code;
        each_key(values, position + 1, key, visit);
    }
}

/// Fields a localization line export may name. The `LocalizationLine` fields keep their shape;
/// `marks` are the cultures without their archive and PO entries, with the translation that
/// ships; `problems` and `signals` are the line's problems in the request's cultures and its
/// review signals; `places` are the saved places of its units.
const LINE_FIELDS: [&str; 12] = [
    "origin",
    "identity",
    "source",
    "manifest",
    "cultures",
    "keyChange",
    "audience",
    "outOfScope",
    "marks",
    "problems",
    "signals",
    "places",
];

pub fn line_fields(fields: &[String]) -> Result<Vec<&'static str>> {
    let mut chosen = Vec::new();
    for field in fields {
        let known = LINE_FIELDS
            .iter()
            .find(|known| **known == field.as_str())
            .ok_or_else(|| invalid("Unknown localization line field."))?;
        require(
            !chosen.contains(known),
            invalid("Localization line fields must be distinct."),
        )?;
        chosen.push(*known);
    }
    Ok(chosen)
}

impl EngineQuery {
    /// One line with only the chosen fields, plus its ID.
    pub(crate) fn localization_line_fields(
        &self,
        row: usize,
        fields: &[&str],
        scope: &[usize],
        findings: Option<&FindingRows>,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let preview = self.preview(row)?;
        let mut result = serde_json::Map::new();
        result.insert("id".into(), preview["id"].clone());
        for field in fields {
            match *field {
                "manifest" => {
                    let projection = Projection::open(self, cancelled)?;
                    let manifest = self.line_manifest(&projection, row, cancelled)?;
                    result.insert("manifest".into(), json!(manifest));
                }
                "cultures" => {
                    let projection = Projection::open(self, cancelled)?;
                    let cultures = self.line_cultures(&projection, row, cancelled)?;
                    result.insert("cultures".into(), json!(cultures));
                }
                "marks" => {
                    result.insert("marks".into(), preview["cultures"].clone());
                }
                "problems" => {
                    let projection = Projection::open(self, cancelled)?;
                    let finding = findings.is_some_and(|findings| findings.counted.contains(row));
                    let problems = projection.problem(row, scope, finding);
                    result.insert("problems".into(), json!(selected_bits(&PROBLEMS, problems)));
                }
                "signals" => {
                    let projection = Projection::open(self, cancelled)?;
                    result.insert("signals".into(), json!(facts(projection.flags[row])));
                }
                "places" => {
                    let places = self.line_places(row, cancelled)?;
                    result.insert("places".into(), json!(places));
                }
                other => {
                    if let Some(value) = preview.get(other) {
                        result.insert(other.into(), value.clone());
                    }
                }
            }
        }
        Ok(Value::Object(result))
    }

    /// Every saved place of a line's units gathered under its key, in unit ID order and each
    /// unit's occurrence order:
    /// the package file, the object path and the origin of its location.
    fn line_places(&self, row: usize, cancelled: &AtomicBool) -> Result<Vec<Value>> {
        let projection = Projection::open(self, cancelled)?;
        let raws = self.column("slice", "raw")?;
        // A line's slice of a unit holds only the occurrences gathered under the line's key.
        let mut slices = Vec::new();
        for slice in projection.starts[row] as usize..projection.starts[row + 1] as usize {
            let raw = *raws.get(slice).ok_or("Invalid line slices.")? as usize;
            slices.push((self.packed("raw", raw)?, slice));
        }
        slices.sort_by(|(left, _), (right, _)| crate::join::ordinal(left, right));
        slices.dedup_by(|(left, _), (right, _)| left == right);
        let mut places = Vec::new();
        let mut files: BTreeMap<usize, String> = BTreeMap::new();
        for (_, slice) in slices {
            for member in projection.slice.members(slice) {
                checkpoint(cancelled)?;
                let occurrence = *member as usize;
                let (shard, package) = self.package_row(occurrence)?;
                let key = shard << 32 | package;
                let file = match files.get(&key) {
                    Some(file) => file.clone(),
                    None => {
                        let file = self.package_file(shard, package)?;
                        files.insert(key, file.clone());
                        file
                    }
                };
                let object = self.occurrence_value(occurrence, "object")?;
                let origin = match self.occurrence_value(occurrence, "location")? {
                    0 => "asset",
                    1 => "data_table",
                    2 => "string_table",
                    _ => return Err("Invalid stored occurrence location.".into()),
                };
                places.push(json!({"packageFile":file,"objectPath":self.reader.string(object)?,"origin":origin}));
            }
        }
        Ok(places)
    }
}

/// A localization line export: the selection's lines, and optional `fields` naming the line
/// fields to write (every `LocalizationLine` field when absent).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LineExport {
    selection: Selection,
    fields: Option<Vec<String>>,
    /// Encodes the lines in the sink's format instead of sending them as batches.
    sink: Option<crate::sink::Sink>,
}

/// A line export's selection, its fields and its sink.
type ParsedLineExport = (
    Selection,
    Option<Vec<&'static str>>,
    Option<crate::sink::Sink>,
);

pub fn parse_line_export(payload: &str) -> Result<ParsedLineExport> {
    let LineExport {
        selection,
        fields,
        sink,
    } = parse_request(payload, "export")?;
    selection.validate()?;
    require(
        sink.is_none() || fields.is_none(),
        invalid("A sink's format names the fields it writes."),
    )?;
    Ok((
        selection,
        fields.as_deref().map(line_fields).transpose()?,
        sink,
    ))
}

/// A corpus export: the selection's units, or `units` names them by ID (at most 5,000; IDs no
/// unit has are left out). A `corpusCsv` sink writes the selection's units as Browse's CSV.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CorpusExport {
    selection: Selection,
    units: Option<Vec<String>>,
    sink: Option<Sink>,
}

/// A corpus export's selection, its units by ID, and its sink.
pub type ParsedCorpusExport = (Selection, Option<Vec<String>>, Option<Sink>);

pub fn parse_corpus_export(payload: &str) -> Result<ParsedCorpusExport> {
    let CorpusExport {
        selection,
        units,
        sink,
    } = parse_request(payload, "export")?;
    selection.validate()?;
    require(
        sink.as_ref().is_none_or(|sink| {
            units.is_none()
                && match sink.format {
                    Format::CorpusCsv => sink.envelope.is_none(),
                    Format::CorpusJson => sink.envelope.is_some(),
                    _ => false,
                }
        }),
        invalid(
            "A corpus sink writes a selection's units as corpusCsv, or as corpusJson in an envelope.",
        ),
    )?;
    if let Some(units) = &units {
        require(
            !units.is_empty() && units.len() <= 5000,
            invalid("A unit selection names 1 to 5,000 units."),
        )?;
        for unit in units {
            require(
                !unit.is_empty() && crate::join_policy::characters(unit) <= 32767,
                invalid("Invalid unit identity."),
            )?;
        }
    }
    Ok((selection, units, sink))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ErrorCode;

    #[test]
    fn aggregate_requests_need_a_target_for_marks_and_count_every_row() -> Result<()> {
        let localized = r#""selection":{"target":"Game"}"#;
        let request = parse_aggregate_request(&format!(
            r#"{{{localized},"by":["culture","state","fact"],"measures":["lineBreakWords"]}}"#
        ))?;
        assert_eq!(
            request.by,
            [Dimension::Culture, Dimension::State, Dimension::Fact]
        );
        assert_eq!(request.measures, [Measure::LineBreakWords]);
        parse_aggregate_request(r#"{"selection":{},"by":["source","problem"]}"#)?;
        for invalid in [
            format!(r#"{{{localized},"by":[]}}"#),
            format!(r#"{{{localized},"by":["state"]}}"#),
            format!(r#"{{{localized},"by":["state","culture"]}}"#),
            format!(r#"{{{localized},"by":["source","source"]}}"#),
            format!(r#"{{{localized},"by":["culture","state","fact","review","source"]}}"#),
            format!(r#"{{{localized},"by":["source"],"measures":["lines","lines"]}}"#),
            format!(r#"{{{localized},"by":["source"],"parts":{{}}}}"#),
            format!(r#"{{{localized},"by":["sql"]}}"#),
            r#"{"selection":{},"by":["culture"]}"#.into(),
            r#"{"selection":{},"by":["translation_key"]}"#.into(),
            r#"{"selection":{},"by":["source"],"sql":true}"#.into(),
            r#"{"by":["source"]}"#.into(),
        ] {
            assert_eq!(
                parse_aggregate_request(&invalid)
                    .err()
                    .ok_or(invalid.clone())?
                    .code,
                ErrorCode::InvalidInput,
                "{invalid}"
            );
        }
        Ok(())
    }

    #[test]
    fn exports_name_known_fields_and_bounded_units() -> Result<()> {
        let base = r#""selection":{"target":"Game"}"#;
        let (_, fields, _) = parse_line_export(&format!(
            r#"{{{base},"fields":["marks","places","identity"]}}"#
        ))?;
        assert_eq!(fields, Some(vec!["marks", "places", "identity"]));
        assert_eq!(parse_line_export(&format!("{{{base}}}"))?.1, None);
        for invalid in [
            format!(r#"{{{base},"fields":["occurrences"]}}"#),
            format!(r#"{{{base},"fields":["marks","marks"]}}"#),
        ] {
            assert!(parse_line_export(&invalid).is_err(), "{invalid}");
        }
        let units = (0..=5000).map(|n| format!("unit:{n}")).collect::<Vec<_>>();
        assert!(parse_corpus_export(&format!(r#"{{{base},"units":[]}}"#)).is_err());
        assert!(
            parse_corpus_export(&format!(
                r#"{{{base},"units":{}}}"#,
                serde_json::to_string(&units)?
            ))
            .is_err()
        );
        assert_eq!(
            parse_corpus_export(&format!(r#"{{{base},"units":["unit:a"]}}"#))?.1,
            Some(vec!["unit:a".to_owned()])
        );
        Ok(())
    }
}
