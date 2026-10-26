//! An incremental evaluation's inputs from the previous findings layer of the same document, and
//! the state every evaluation leaves for the next one.
use super::Subject;
use super::columns::Bits;
use super::findings_order::{Facts, NONE};
use super::incremental::{NO_GROUP, NodeGroups, SubjectDelta};
use crate::engine_query::EngineQuery;
use crate::snapshot::{Reader, integers};
use crate::store::{decode_ids, section};
use crate::{Result, require};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// What the findings layer records for the next evaluation, beside its findings.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LayerState {
    /// The joined base the evaluation read; another base means a full evaluation.
    pub base: String,
    /// The rule document's digest and the requested locale.
    pub document: String,
    pub locale: String,
    pub lines: u32,
    /// Whether every cross-row node's groups are recorded.
    pub incremental: bool,
    /// The recorded nodes, each with its subject and whether it has a corpus table.
    pub nodes: Vec<StateNode>,
    /// Whether `state.join` records each line's join membership (a rule reads `joinPosition`).
    pub join: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StateNode {
    pub subject: Subject,
    pub node: u32,
    pub corpus: bool,
    /// Whether rows have several groups (`state.*.starts`).
    pub sited: bool,
}

/// The state's column names for one node.
pub(super) fn node_prefix(subject: Subject, node: u32) -> String {
    let subject = match subject {
        Subject::Line => "line",
        Subject::LineCulture => "line_culture",
        Subject::UnitSource => "unit_source",
    };
    format!("state.{subject}.n{node}")
}

/// A node's groups as state columns.
pub(super) fn state_columns(
    subject: Subject,
    groups: &NodeGroups,
) -> Result<Vec<(String, Vec<u32>)>> {
    let prefix = node_prefix(subject, u32::try_from(groups.node)?);
    let low = |values: &mut dyn Iterator<Item = u64>| values.map(|v| v as u32).collect();
    let high = |values: &mut dyn Iterator<Item = u64>| values.map(|v| (v >> 32) as u32).collect();
    let mut columns = vec![
        (format!("{prefix}.rows"), groups.groups.clone()),
        (
            format!("{prefix}.h0"),
            low(&mut groups.hashes.iter().copied()),
        ),
        (
            format!("{prefix}.h1"),
            high(&mut groups.hashes.iter().copied()),
        ),
    ];
    if let Some(starts) = &groups.starts {
        columns.push((format!("{prefix}.starts"), starts.clone()));
    }
    if let Some(table) = &groups.table {
        columns.push((
            format!("{prefix}.t0"),
            low(&mut table.iter().map(|(key, _)| *key)),
        ));
        columns.push((
            format!("{prefix}.t1"),
            high(&mut table.iter().map(|(key, _)| *key)),
        ));
        columns.push((
            format!("{prefix}.tc"),
            table
                .iter()
                .map(|(_, count)| u32::try_from(*count).unwrap_or(u32::MAX))
                .collect(),
        ));
    }
    Ok(columns)
}

/// The previous findings layer, read through the current dictionary.
pub(super) struct Previous {
    reader: Reader,
    record: Value,
    pub state: LayerState,
    /// The lines whose joined values changed since that evaluation.
    pub changed: Bits,
    columns: crate::cache::Memo<String, Arc<[u32]>>,
    /// Its `line_culture` rows' lines and cultures.
    culture_lines: Arc<[u32]>,
    culture_indices: Arc<[u32]>,
    /// Each diagnostic's code, as an index into `DIAGNOSTIC_CODES`.
    diagnostic_codes: Vec<u8>,
}

/// What an incremental evaluation of one subject evaluated, for the merge with the previous
/// layer's findings and diagnostics.
pub(super) struct SubjectMerge {
    pub subject: Subject,
    /// The rows it evaluated, and their lines.
    pub evaluated: Bits,
    pub lines: Bits,
    /// `line_culture`: each previous row's current row.
    pub rows: Option<Vec<u32>>,
}

/// The previous layer's findings of one rule that an incremental evaluation keeps.
#[derive(Default)]
pub(super) struct Kept {
    pub rows: Vec<u32>,
    pub cultures: Vec<u32>,
    pub evidence: Vec<u32>,
    /// Each finding's previous place set.
    pub places: Vec<u32>,
    pub id0: Vec<u32>,
    pub id1: Vec<u32>,
    pub facts: Vec<Facts>,
}
impl Previous {
    /// The previous layer when it can seed an incremental evaluation of `document` in `locale`:
    /// same format, document, locale, collation and joined base, every node recorded, and no
    /// change to a changed line's join membership when a rule reads it.
    pub fn open(
        query: &EngineQuery,
        root: &Value,
        document: &str,
        locale: &str,
        collation: &str,
        reads_join_position: bool,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Option<Self>> {
        let Some(key) = root["active"]["findings"].as_str() else {
            return Ok(None);
        };
        let Some(record) = root["layers"].get(key) else {
            return Ok(None);
        };
        if record["storeGeneration"] != query.reader.generation {
            return Ok(None);
        }
        let Some(file) = record["file"].as_str() else {
            return Ok(None);
        };
        require(
            std::path::Path::new(file).components().count() == 1,
            "Invalid findings snapshot filename.",
        )?;
        let reader = Reader::open(&query.configuration.directory()?.join(file))?;
        let Ok(metadata) = crate::json_value::parse_as::<super::replies::LayerMetadata>(
            std::str::from_utf8(&section(&reader, "join.meta")?)?,
        ) else {
            return Ok(None);
        };
        let Some(state) = metadata.state.clone() else {
            return Ok(None);
        };
        let lines = query.reader.column("line.source")?.len();
        if metadata.version != super::findings::VERSION
            || !state.incremental
            || state.document != document
            || state.locale != locale
            || metadata.collation != collation
            || state.base != joined_base(query)
            || state.lines as usize != lines
            || state.join != reads_join_position
        {
            return Ok(None);
        }
        let mut previous = Self {
            reader,
            record: record.clone(),
            state,
            changed: Bits::new(lines),
            columns: Default::default(),
            culture_lines: Arc::from([]),
            culture_indices: Arc::from([]),
            diagnostic_codes: Vec::new(),
        };
        for row in previous
            .column("state.patch_rows")?
            .iter()
            .chain(patch_rows(query)?.iter())
        {
            require(
                (*row as usize) < lines,
                "A patched row is outside the lines.",
            )?;
            previous.changed.set(*row as usize);
        }
        if previous.state.join {
            let before = previous.column("state.join")?;
            let now = join_membership(query, lines, cancelled)?;
            if previous
                .changed
                .ones()
                .any(|line| bit(&before, line as usize) != bit(&now, line as usize))
            {
                return Ok(None);
            }
        }
        previous.culture_lines = previous.column("subjects.line_culture.lines")?;
        previous.culture_indices = previous.column("subjects.line_culture.cultures")?;
        // The few distinct code strings, read through this evaluation's dictionary.
        let mut codes = HashMap::<u32, u8>::new();
        for id in previous.column("diag.codes")?.iter() {
            if !codes.contains_key(id) {
                let Ok(text) = query.reader.string(*id) else {
                    return Ok(None);
                };
                let Some(code) = super::DIAGNOSTIC_CODES
                    .iter()
                    .position(|code| *code == text)
                else {
                    return Ok(None);
                };
                codes.insert(*id, u8::try_from(code)?);
            }
            previous.diagnostic_codes.push(codes[id]);
        }
        Ok(Some(previous))
    }
    pub fn column(&self, name: &str) -> Result<Arc<[u32]>> {
        self.columns.get_or_try(name.into(), || {
            let bytes = section(&self.reader, name)?;
            Ok(if self.record["stringColumns"].get(name).is_some() {
                decode_ids(&bytes, self.record["idEncoding"] == "delta32")?
            } else {
                integers(&bytes)?
            }
            .into())
        })
    }
    /// The previous `line_culture` rows renumbered to this evaluation's relation, given as each
    /// row's line and culture: `NO_GROUP` for a previous row with no current one.
    pub fn culture_rows(&self, lines: &[u32], cultures: &[u32]) -> Vec<u32> {
        let mut first = vec![0u32; self.state.lines as usize + 1];
        for line in lines {
            first[*line as usize + 1] += 1;
        }
        for line in 0..self.state.lines as usize {
            first[line + 1] += first[line];
        }
        self.culture_lines
            .iter()
            .zip(self.culture_indices.iter())
            .map(|(line, culture)| {
                let line = *line as usize;
                (first[line]..first[line + 1])
                    .find(|row| cultures[*row as usize] == *culture)
                    .unwrap_or(NO_GROUP)
            })
            .collect()
    }
    /// The previous evaluation's groups of a node, numbered by the previous rows.
    fn groups(&self, subject: Subject, state: &StateNode) -> Result<NodeGroups> {
        let StateNode {
            node,
            corpus,
            sited,
            ..
        } = *state;
        let prefix = node_prefix(subject, node);
        let wide = |low: &[u32], high: &[u32]| {
            low.iter()
                .zip(high)
                .map(|(low, high)| u64::from(*low) | u64::from(*high) << 32)
                .collect::<Vec<_>>()
        };
        let starts = if sited {
            Some(self.column(&format!("{prefix}.starts"))?.to_vec())
        } else {
            None
        };
        let groups = NodeGroups {
            node: node as usize,
            starts,
            groups: self.column(&format!("{prefix}.rows"))?.to_vec(),
            keyed: true,
            hashes: wide(
                &self.column(&format!("{prefix}.h0"))?,
                &self.column(&format!("{prefix}.h1"))?,
            ),
            table: if corpus {
                let keys = wide(
                    &self.column(&format!("{prefix}.t0"))?,
                    &self.column(&format!("{prefix}.t1"))?,
                );
                let counts = self.column(&format!("{prefix}.tc"))?;
                Some(
                    keys.into_iter()
                        .zip(counts.iter().map(|count| i64::from(*count)))
                        .collect(),
                )
            } else {
                None
            },
        };
        Ok(groups)
    }
    /// One subject's delta: the rows of the changed lines and the previous groups, renumbered,
    /// with `line_culture`'s map from previous rows to current rows. `lines` and `cultures` are
    /// this evaluation's `line_culture` relation. `None` evaluates every row: `unit_source`, or
    /// an unchanged line whose cultures differ.
    pub fn delta(
        &self,
        subject: Subject,
        lines: &Arc<[u32]>,
        cultures: &[u32],
    ) -> Result<Option<(SubjectDelta, Option<Vec<u32>>)>> {
        let line_count = self.state.lines as usize;
        let (len, rows, row_lines) = match subject {
            Subject::Line => (line_count, None, None),
            Subject::LineCulture => (
                lines.len(),
                Some(self.culture_rows(lines, cultures)),
                Some(Arc::clone(lines)),
            ),
            Subject::UnitSource => return Ok(None),
        };
        let mut changed = Bits::new(len);
        match &row_lines {
            Some(row_lines) => {
                for (row, line) in row_lines.iter().enumerate() {
                    if self.changed.get(*line as usize) {
                        changed.set(row);
                    }
                }
            }
            None => changed.clone_from(&self.changed),
        }
        // Each current row's previous row, and the previous rows a changed line no longer has.
        let mut back = None;
        let mut gone = Vec::new();
        if let (Some(rows), Some(row_lines)) = (&rows, &row_lines) {
            let mut map = vec![NO_GROUP; len];
            for (old, new) in rows.iter().enumerate() {
                let line = self.culture_lines[old] as usize;
                if *new == NO_GROUP {
                    if !self.changed.get(line) {
                        return Ok(None);
                    }
                    gone.push(old);
                } else {
                    map[*new as usize] = u32::try_from(old)?;
                }
            }
            if row_lines
                .iter()
                .zip(&map)
                .any(|(line, old)| *old == NO_GROUP && !self.changed.get(*line as usize))
            {
                return Ok(None);
            }
            back = Some(map);
        }
        let mut previous = HashMap::new();
        let mut removed = HashMap::new();
        for node in self
            .state
            .nodes
            .iter()
            .filter(|node| node.subject == subject)
        {
            let groups = self.groups(subject, node)?;
            // A removed row leaves its groups: their other members are evaluated again.
            removed.insert(
                node.node as usize,
                gone.iter()
                    .flat_map(|old| groups.keys(*old))
                    .collect::<Vec<_>>(),
            );
            previous.insert(
                node.node as usize,
                match &back {
                    Some(map) => groups.renumbered(map),
                    None => groups,
                },
            );
        }
        Ok(Some((
            SubjectDelta {
                changed,
                previous,
                removed,
                lines: row_lines,
                // Above a quarter of the rows a full evaluation is as quick. The fuzzer lifts the
                // limit to compare small corpora's incremental evaluations with full ones.
                limit: if std::env::var_os("UE_SHED_GAME_TEXT_UNLIMITED_CLOSURE").is_some() {
                    len
                } else {
                    len / 4
                },
            },
            rows,
        )))
    }
    /// The previous findings of rule `index`, whose facts start at `start`, on the rows `merge`
    /// didn't evaluate: renumbered to the current rows, in row order.
    pub fn kept(&self, index: usize, start: usize, merge: &SubjectMerge) -> Result<Kept> {
        let column = |name: &str| self.column(&format!("r{index}.{name}"));
        let rows = column("rows")?;
        let cultures = column("cultures")?;
        let (evidence, places, id0, id1) = (
            column("evidence")?,
            column("places")?,
            column("id0")?,
            column("id1")?,
        );
        let fact = |name: &str| self.column(&format!("f.{name}"));
        let (lines, units, fact_cultures, flags) = (
            fact("line")?,
            fact("unit")?,
            fact("culture")?,
            fact("flags")?,
        );
        let actual = Packed {
            ends: self.column("f.actual.ends")?,
            words: self.column("f.actual.bytes")?,
        };
        require(
            start + rows.len() <= lines.len(),
            "The previous findings' facts are short.",
        )?;
        let mut order = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            let row = match &merge.rows {
                Some(map) => map[*row as usize],
                None => *row,
            };
            if row != NO_GROUP && !merge.evaluated.get(row as usize) {
                order.push((row, index));
            }
        }
        order.sort_by_key(|(row, _)| *row);
        let mut kept = Kept::default();
        for (row, index) in order {
            let at = start + index;
            kept.rows.push(row);
            if let Some(culture) = cultures.get(index) {
                kept.cultures.push(*culture);
            }
            kept.evidence.push(evidence[index]);
            kept.places.push(places[index]);
            kept.id0.push(id0[index]);
            kept.id1.push(id1[index]);
            kept.facts.push(Facts {
                rule: 0,
                line: lines[at],
                unit: units[at],
                culture: fact_cultures[at],
                flags: flags[at],
                actual: actual.get(at)?,
                source: String::new(),
                first_rank: NONE,
            });
        }
        Ok(kept)
    }
    /// A previous place set's member IDs.
    pub fn place_set(&self, set: u32) -> Result<Vec<u32>> {
        let offsets = self.column("places.offsets")?;
        let members = self.column("places.members")?;
        let start = *offsets
            .get(set as usize)
            .ok_or("Place set outside layer.")? as usize;
        let end = *offsets
            .get(set as usize + 1)
            .ok_or("Place set outside layer.")? as usize;
        Ok(members
            .get(start..end)
            .ok_or("Invalid place set range.")?
            .to_vec())
    }
    /// The previous diagnostics on lines that `merges` didn't evaluate, as `(line, culture,
    /// code, origin)`: a subject evaluated in full keeps none of its own.
    pub fn kept_diagnostics(&self, merges: &[SubjectMerge]) -> Result<Vec<(u32, u32, u8, u8)>> {
        let lines = self.column("diag.rows")?;
        let cultures = self.column("diag.cultures")?;
        let origins = self.column("diag.origin")?;
        let merge = |subject| merges.iter().find(|merge| merge.subject == subject);
        let (line_merge, culture_merge) = (merge(Subject::Line), merge(Subject::LineCulture));
        let mut kept = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            let origin = u8::try_from(origins[index])?;
            let merge = if origin == LINE_RULE {
                line_merge
            } else {
                culture_merge
            };
            if merge.is_some_and(|merge| !merge.lines.get(*line as usize)) {
                kept.push((*line, cultures[index], self.diagnostic_codes[index], origin));
            }
        }
        Ok(kept)
    }
}

/// A diagnostic's origin, which orders a line's diagnostics: the line-culture projection's,
/// then line rules', then line-culture rules'.
pub(super) const PROJECTION: u8 = 0;
pub(super) const LINE_RULE: u8 = 1;
pub(super) const CULTURE_RULE: u8 = 2;

/// Strings stored as two integer columns: each string's end in bytes, and the bytes packed in
/// little-endian words. They stay out of the dictionary, which would intern each one.
pub(super) fn pack_strings<'a>(
    values: impl Iterator<Item = &'a str>,
) -> Result<(Vec<u32>, Vec<u32>)> {
    let mut ends = Vec::new();
    let mut bytes = Vec::new();
    for value in values {
        bytes.extend_from_slice(value.as_bytes());
        ends.push(u32::try_from(bytes.len())?);
    }
    let words = bytes
        .chunks(4)
        .map(|chunk| {
            let mut word = [0u8; 4];
            word[..chunk.len()].copy_from_slice(chunk);
            u32::from_le_bytes(word)
        })
        .collect();
    Ok((ends, words))
}
struct Packed {
    ends: Arc<[u32]>,
    words: Arc<[u32]>,
}
impl Packed {
    fn get(&self, index: usize) -> Result<String> {
        let start = if index == 0 {
            0
        } else {
            self.ends[index - 1] as usize
        };
        let end = *self
            .ends
            .get(index)
            .ok_or("Packed string outside column.")? as usize;
        require(
            start <= end && end <= self.words.len() * 4,
            "Invalid packed string range.",
        )?;
        let bytes = (start..end)
            .map(|at| self.words[at / 4].to_le_bytes()[at % 4])
            .collect::<Vec<_>>();
        Ok(String::from_utf8(bytes)?)
    }
}

/// The joined layer's base: the layer an overlay patches, or the layer itself.
pub(super) fn joined_base(query: &EngineQuery) -> String {
    query.reader.meta["base"]
        .as_str()
        .unwrap_or(&query.reader.joined_key)
        .to_owned()
}

/// The lines the joined overlay rewrote since its base.
pub(super) fn patch_rows(query: &EngineQuery) -> Result<Arc<[u32]>> {
    if query.reader.meta["patches"]
        .as_object()
        .is_none_or(serde_json::Map::is_empty)
    {
        return Ok(Arc::from([]));
    }
    query
        .reader
        .layer_column(&query.reader.joined_key, "patch.rows")
}

/// Each line's join membership, one bit per line in 32-bit words.
pub(super) fn join_membership(
    query: &EngineQuery,
    lines: usize,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<u32>> {
    let target = query.target["name"]
        .as_str()
        .ok_or("Missing target name.")?
        .to_owned();
    let rows = query.matching(&crate::engine_types::Selection::lines(&target), cancelled)?;
    let mut words = vec![0u32; lines.div_ceil(32)];
    for row in rows.iter() {
        let row = *row as usize;
        require(row < lines, "Join row outside the lines.")?;
        words[row / 32] |= 1 << (row % 32);
    }
    Ok(words)
}
fn bit(words: &[u32], row: usize) -> bool {
    words
        .get(row / 32)
        .is_some_and(|word| word >> (row % 32) & 1 != 0)
}
