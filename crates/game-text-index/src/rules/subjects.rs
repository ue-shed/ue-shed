//! Rule subjects read only requested native columns; places and cold evidence stay lazy.
use super::{HostCollator, Subject, SubjectRows};
use crate::Result;
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::{EngineQuery, selected_bits};
use crate::engine_types::{REASONS, STATES};
use crate::join_policy::trim;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, atomic::AtomicBool};

pub struct UnitSource {
    pub unit: usize,
    pub source: u32,
    pub members: Vec<u32>,
}
/// The line-culture rows: each row's line and culture index, sized exactly.
#[derive(Default)]
pub struct CultureRows {
    /// Each row's line, which is also the parent row of every line-culture column.
    pub(crate) lines: Arc<[u32]>,
    cultures: Box<[u32]>,
}
impl CultureRows {
    pub fn len(&self) -> usize {
        self.lines.len()
    }
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
    /// The row's `(line, culture index)`.
    pub fn at(&self, row: usize) -> (usize, usize) {
        (self.lines[row] as usize, self.cultures[row] as usize)
    }
    pub fn get(&self, row: usize) -> Option<(usize, usize)> {
        (row < self.len()).then(|| self.at(row))
    }
    pub fn iter(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        (0..self.len()).map(|row| self.at(row))
    }
    pub fn cultures(&self) -> &[u32] {
        &self.cultures
    }
}
pub struct NativeSubjects<'a> {
    pub query: &'a mut EngineQuery,
    pub(crate) projection: Arc<Projection>,
    pub subject: Subject,
    pub cultures: CultureRows,
    pub units: Vec<UnitSource>,
    pub(super) collator: &'a HostCollator,
    pub(super) cancelled: &'a AtomicBool,
    pub(super) occurrences: Arc<super::occurrences::OccurrenceData>,
    read_arena: Option<super::columns::Arena>,
    /// The strings `places` reads, kept for the rest of this read.
    place_arena: Option<super::columns::Arena>,
}
impl<'a> NativeSubjects<'a> {
    pub fn new(
        query: &'a mut EngineQuery,
        subject: Subject,
        collator: &'a HostCollator,
        cancelled: &'a AtomicBool,
    ) -> Result<Self> {
        let occurrences = match &query.occurrence_data {
            Some(occurrences) => Arc::clone(occurrences),
            None => {
                let occurrences = super::occurrences::OccurrenceData::build(
                    query,
                    &mut super::stages::Measure::start(),
                )?;
                query.occurrence_data = Some(Arc::clone(&occurrences));
                occurrences
            }
        };
        Self::new_shared(query, subject, collator, cancelled, occurrences)
    }
    pub(super) fn new_shared(
        query: &'a mut EngineQuery,
        subject: Subject,
        collator: &'a HostCollator,
        cancelled: &'a AtomicBool,
        occurrences: Arc<super::occurrences::OccurrenceData>,
    ) -> Result<Self> {
        let projection = Projection::open(query, cancelled)?;
        let mut cultures = CultureRows::default();
        let mut units: Vec<UnitSource> = Vec::new();
        if subject == Subject::LineCulture {
            let mut order = (0..query.cultures.len()).collect::<Vec<_>>();
            order.sort_by(|a, b| collator.compare(&query.cultures[*a], &query.cultures[*b]));
            let present =
                |line: usize, culture: usize| projection.cultures[culture].state[line] != 8;
            let count = (0..projection.source.len())
                .map(|line| {
                    order
                        .iter()
                        .filter(|culture| present(line, **culture))
                        .count()
                })
                .sum();
            let mut lines = Vec::with_capacity(count);
            let mut indices = Vec::with_capacity(count);
            for line in 0..projection.source.len() {
                for culture in &order {
                    if present(line, *culture) {
                        lines.push(u32::try_from(line)?);
                        indices.push(u32::try_from(*culture)?);
                    }
                }
            }
            cultures = CultureRows {
                lines: lines.into(),
                cultures: indices.into(),
            };
        }
        if subject == Subject::UnitSource {
            for unit in 0..projection.raw.visible.len() {
                if projection.raw.visible[unit] == 0 {
                    continue;
                }
                let mut groups = HashMap::<u32, usize>::new();
                for member in projection.raw.members(unit) {
                    let source = occurrences.value(*member as usize, "source");
                    if let Some(row) = groups.get(&source) {
                        units[*row].members.push(*member);
                    } else {
                        groups.insert(source, units.len());
                        units.push(UnitSource {
                            unit,
                            source,
                            members: vec![*member],
                        });
                    }
                }
            }
        }
        Ok(Self {
            query,
            projection,
            subject,
            cultures,
            units,
            collator,
            cancelled,
            occurrences,
            read_arena: None,
            place_arena: None,
        })
    }
    pub(super) fn occurrence_text_id(&self, row: u32) -> Result<&str> {
        let arena = self
            .read_arena
            .as_ref()
            .ok_or("Missing read occurrence relation.")?;
        Ok(arena
            .occurrences
            .ids
            .get(row as usize)
            .copied()
            .flatten()
            .map_or("", |id| arena.text(id)))
    }
    pub fn line_row(&self, row: usize) -> Result<usize> {
        if self.subject == Subject::LineCulture {
            self.cultures
                .get(row)
                .map(|(line, _)| line)
                .ok_or_else(|| "Culture subject outside relation.".into())
        } else {
            Ok(row)
        }
    }
    pub(super) fn manifest_rows(&self, line: usize) -> &[u32] {
        &self.projection.manifest[self.projection.manifest_start[line] as usize
            ..self.projection.manifest_end[line] as usize]
    }
    fn manifest_path(&self) -> Result<String> {
        self.query.target["outputPaths"]["manifest"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Missing manifest input.".into())
    }
    pub(super) fn slices(&self, line: usize) -> std::ops::Range<usize> {
        self.projection.starts[line] as usize..self.projection.starts[line + 1] as usize
    }
    pub fn line_members(&self, line: usize) -> Vec<u32> {
        self.slices(line)
            .flat_map(|slice| self.projection.slice.members(slice).iter().copied())
            .collect()
    }
    fn source_culture(&self, line: usize) -> Value {
        let native = self.query.target["nativeCulture"].as_str();
        let mut cultures = self
            .query
            .cultures
            .iter()
            .enumerate()
            .filter(|(index, _)| self.projection.cultures[*index].state[line] != 8)
            .map(|(_, culture)| culture)
            .collect::<Vec<_>>();
        if let Some(culture) = cultures
            .iter()
            .find(|culture| Some(culture.as_str()) == native)
        {
            return json!(culture);
        }
        cultures.sort_by(|a, b| self.collator.compare(a, b));
        cultures
            .first()
            .map_or(Value::Null, |culture| json!(culture))
    }
    fn translation(&mut self, line: usize, ci: usize, stage: &str) -> Result<Value> {
        let entry = self.query.reader.value(&format!("c{ci}.{stage}"), line)?;
        if entry == 0 {
            return Ok(Value::Null);
        }
        let path = self.query.target["outputPaths"][if stage == "po" {
            "portableObjects"
        } else {
            "archives"
        }][&self.query.cultures[ci]]
            .as_str()
            .ok_or("Missing translation input.")?
            .to_owned();
        Ok(self
            .query
            .translation(&path, entry as usize - 1, stage == "po")?
            .map_or(Value::Null, Value::String))
    }
    fn latest_origin(&self, line: usize, ci: usize) -> Result<&'static str> {
        Ok(
            if self.projection.cultures[ci].facts[line] & 8 != 0
                || self.projection.cultures[ci].state[line] == 3
            {
                "po"
            } else if self.query.reader.meta["input"]["target"].is_null() {
                "absent"
            } else {
                "archive"
            },
        )
    }
    pub(super) fn culture_field(&mut self, line: usize, ci: usize, name: &str) -> Result<Value> {
        let mark = &self.projection.cultures[ci];
        Ok(match name {
            "culture" => json!(self.query.cultures[ci]),
            "state" => json!(STATES[mark.state[line] as usize]),
            "facts" => json!(selected_bits(&STATES, mark.facts[line])),
            "unknownReasons" => json!(selected_bits(&REASONS, mark.reasons[line])),
            "reducedSourceChecking" => json!(
                self.query.reader.meta["reducedSourceChecking"][ci]
                    .as_bool()
                    .unwrap_or(false)
            ),
            "isNative" => {
                json!(self.query.target["nativeCulture"].as_str() == Some(&self.query.cultures[ci]))
            }
            "isSourceCulture" => {
                json!(self.source_culture(line).as_str() == Some(&self.query.cultures[ci]))
            }
            "po" | "archive" => self.translation(line, ci, name)?,
            "latest" => {
                let origin = self.latest_origin(line, ci)?;
                if origin == "absent" {
                    Value::Null
                } else {
                    self.translation(line, ci, if origin == "po" { "po" } else { "archive" })?
                }
            }
            "latestOrigin" => {
                let origin = self.latest_origin(line, ci)?;
                let exists = self.query.reader.value(&format!("c{ci}.archive"), line)? != 0;
                json!(if origin == "po" {
                    "po"
                } else if exists {
                    "archive"
                } else {
                    "absent"
                })
            }
            "archiveSource" => {
                let entry = self.query.reader.value(&format!("c{ci}.archive"), line)?;
                if entry == 0 {
                    Value::Null
                } else {
                    let path = self.query.target["outputPaths"]["archives"]
                        [&self.query.cultures[ci]]
                        .as_str()
                        .ok_or("Missing archive input.")?
                        .to_owned();
                    json!(self.query.entry_text(&path, "source", entry as usize - 1)?)
                }
            }
            "expectedSource" => {
                let mut source = self.line_field(line, "manifestSource")?;
                if self.query.target["nativeCulture"].as_str() != Some(&self.query.cultures[ci])
                    && let Some(native) = self.query.cultures.iter().position(|culture| {
                        Some(culture.as_str()) == self.query.target["nativeCulture"].as_str()
                    })
                {
                    let entry = self
                        .query
                        .reader
                        .value(&format!("c{native}.archive"), line)?;
                    if entry != 0 {
                        let path = self.query.target["outputPaths"]["archives"]
                            [&self.query.cultures[native]]
                            .as_str()
                            .ok_or("Missing native archive.")?
                            .to_owned();
                        let archive = self.query.evidence_entry(&path, entry as usize - 1)?;
                        if archive["source"] != archive["translation"] {
                            source = archive["translation"]["Text"].clone();
                        }
                    }
                }
                source
            }
            _ => return Err(format!("Unknown culture field {name}.").into()),
        })
    }
    pub fn line_field(&mut self, line: usize, name: &str) -> Result<Value> {
        let result = match name {
            "lineId" => json!(self.query.packed("line", line)?),
            "source" => json!(self.query.reader.string(self.projection.source[line])?),
            "identity" => {
                let key = self.query.reader.string(self.projection.key[line])?;
                if !self.slices(line).is_empty() && key.is_empty() {
                    Value::Null
                } else {
                    json!({"namespace":self.query.reader.string(self.projection.namespace[line])?,"key":key})
                }
            }
            "manifestSource" => {
                let first = self.manifest_rows(line).first().copied();
                if let Some(first) = first {
                    let path = self.manifest_path()?;
                    json!(self.query.entry_text(&path, "source", first as usize)?)
                } else {
                    Value::Null
                }
            }
            "comparisonSource" => {
                let manifest = self.line_field(line, "manifestSource")?;
                if manifest.is_null() {
                    self.line_field(line, "source")?
                } else {
                    manifest
                }
            }
            "sourceVariants" => {
                let conflicting = self
                    .projection
                    .cultures
                    .iter()
                    .any(|culture| culture.reasons[line] & (1 << 11) != 0);
                if !conflicting {
                    Value::Null
                } else {
                    let mut members = Vec::new();
                    let mut all = Vec::new();
                    for slice in self.slices(line) {
                        for member in self.projection.slice.members(slice) {
                            all.push(*member);
                            if self.projection.slice.identity[slice] != 1 {
                                members.push(*member);
                            }
                        }
                    }
                    let mut sources = Vec::new();
                    for member in if members.is_empty() { all } else { members } {
                        let id = self.occurrences.value(member as usize, "source");
                        let source = self.query.reader.string(id)?;
                        if !sources.contains(&source) {
                            sources.push(source);
                        }
                    }
                    sources.sort_by(|a, b| super::text::code_unit_compare(a, b));
                    if sources.len() < 2 {
                        Value::Null
                    } else {
                        json!(sources)
                    }
                }
            }
            "comparable" => json!(
                self.line_field(line, "sourceVariants")?.is_null()
                    || !self.line_field(line, "manifestSource")?.is_null()
            ),
            "checkable" => json!(
                !self.line_field(line, "identity")?.is_null()
                    && (!trim(self.line_field(line, "source")?.as_str().unwrap_or("")).is_empty()
                        || !trim(
                            self.line_field(line, "comparisonSource")?
                                .as_str()
                                .unwrap_or("")
                        )
                        .is_empty())
            ),
            "sourceCulture" => self.source_culture(line),
            "nativeCulture" => self.query.target["nativeCulture"].clone(),
            "sourceLatestOrigin" => {
                let culture = self.source_culture(line);
                if let Some(ci) = self
                    .query
                    .cultures
                    .iter()
                    .position(|value| Some(value.as_str()) == culture.as_str())
                {
                    self.culture_field(line, ci, "latestOrigin")?
                } else {
                    json!("absent")
                }
            }
            "gathered" => json!(!self.manifest_rows(line).is_empty()),
            "manifestLocations" | "bytecodeOnly" => {
                let entries = self.manifest_rows(line).to_vec();
                let mut paths = Vec::new();
                if !entries.is_empty() {
                    let path = self.manifest_path()?;
                    for entry in entries {
                        let value = self.query.evidence_entry(&path, entry as usize)?;
                        let location = value["path"]
                            .as_str()
                            .ok_or("Missing manifest location.")?
                            .to_owned();
                        if !paths.contains(&location) {
                            paths.push(location);
                        }
                    }
                }
                if name == "bytecodeOnly" {
                    json!(
                        !paths.is_empty()
                            && paths.iter().all(|path| path.ends_with("[Script Bytecode]"))
                    )
                } else {
                    paths.sort_by(|a, b| super::text::code_unit_compare(a, b));
                    json!(paths)
                }
            }
            "manifestNotes" => {
                let entries = self.manifest_rows(line).to_vec();
                let mut notes = Vec::new();
                if !entries.is_empty() {
                    let path = self.manifest_path()?;
                    for entry in entries {
                        let value = self.query.evidence_entry(&path, entry as usize)?;
                        let mut seen = Vec::new();
                        for note in [
                            value["devNotes"].as_str(),
                            value["metadata"]["Info"]["Comment"].as_str(),
                        ]
                        .into_iter()
                        .flatten()
                        {
                            if !trim(note).is_empty() && !seen.contains(&note) {
                                seen.push(note);
                                notes.push(note.to_owned());
                            }
                        }
                    }
                }
                json!(notes)
            }
            "originKind" => json!(if self.slices(line).is_empty() {
                "evidence"
            } else {
                "corpus"
            }),
            "stringTables" => {
                let mut tables = Vec::new();
                for member in self.line_members(line) {
                    if self.occurrences.value(member as usize, "location") == 2 {
                        let id = self.occurrences.value(member as usize, "object");
                        let object = self.query.reader.string(id)?;
                        if !tables.contains(&object) {
                            tables.push(object);
                        }
                    }
                }
                tables.sort_by(|a, b| super::text::code_unit_compare(a, b));
                json!(tables)
            }
            _ => return Err(format!("Unknown line field {name}.").into()),
        };
        Ok(result)
    }
}
/// The occurrence fields a place shows, all store strings.
const PLACE_STRINGS: [&str; 7] = [
    "source", "notes", "object", "property", "class", "row", "key",
];
impl NativeSubjects<'_> {
    /// The arena `occurrences` reads through, with the occurrence children prepared.
    fn take_read_arena(&mut self) -> Result<super::columns::Arena> {
        match self.read_arena.take() {
            Some(arena) => Ok(arena),
            None => {
                let mut arena = super::columns::Arena::new(self.dictionary_len()?)?;
                self.prepare_columns(&[], &mut arena, true)?;
                Ok(arena)
            }
        }
    }
    /// Load what `occurrences` reads for these subject rows in one batch per arena, so that
    /// reading them one at a time afterwards finds every string already loaded. No rows need
    /// nothing, not even the occurrence children.
    pub(super) fn prefetch_occurrences(&mut self, rows: &[u32]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut arena = self.take_read_arena()?;
        let mut members = Vec::new();
        for row in rows {
            if self.subject == Subject::UnitSource {
                members.extend_from_slice(&self.units[*row as usize].members);
            } else {
                members.extend_from_slice(
                    arena
                        .line_children
                        .as_ref()
                        .ok_or("Missing occurrence CSR.")?
                        .members(self.line_row(*row as usize)?),
                );
            }
        }
        members.sort_unstable();
        members.dedup();
        let loaded =
            arena.occurrence_ids(self.query, &members, &mut super::stages::Measure::start());
        self.read_arena = Some(arena);
        loaded?;
        let data = Arc::clone(&self.occurrences);
        let strings = members
            .iter()
            .flat_map(|row| PLACE_STRINGS.map(|field| data.value(*row as usize, field)))
            .collect::<Vec<_>>();
        let mut arena = match self.place_arena.take() {
            Some(arena) => arena,
            None => super::columns::Arena::new(self.query.reader.dictionary_count()?)?,
        };
        let loaded = arena.load_strings(&mut self.query.reader, &strings);
        self.place_arena = Some(arena);
        loaded
    }
    /// Places as reads and evidence show them, built from the index. Their strings load into
    /// one scratch arena that lasts as long as these subjects, so a read loads each string once.
    pub(super) fn places(&mut self, rows: &[u32], ids: &[Option<Arc<str>>]) -> Result<Vec<Value>> {
        use super::columns::{Arena, StrId};
        let data = Arc::clone(&self.occurrences);
        let string_ids = rows
            .iter()
            .flat_map(|row| PLACE_STRINGS.map(|field| data.value(*row as usize, field)))
            .collect::<Vec<_>>();
        let mut arena = match self.place_arena.take() {
            Some(arena) => arena,
            None => Arena::new(self.query.reader.dictionary_count()?)?,
        };
        arena.load_strings(&mut self.query.reader, &string_ids)?;
        let places = rows
            .iter()
            .zip(ids)
            .map(|(row, id)| {
                let row = *row as usize;
                json!({"id":id.as_deref().unwrap_or(""),"packageFile":data.files[data.packages[row] as usize],
                "source":arena.text(StrId(data.value(row,"source"))),
                "devNotes":arena.text(StrId(data.value(row,"notes"))),
                "location":data.location(row,&arena),"unitStatus":data.status(row,&arena)})
            })
            .collect();
        self.place_arena = Some(arena);
        Ok(places)
    }
}
impl SubjectRows for NativeSubjects<'_> {
    fn affected(
        &mut self,
        arena: &mut super::columns::Arena,
        sets: &[super::columns::Atom],
        measure: &mut super::stages::Measure,
    ) -> Result<HashMap<super::columns::Atom, Arc<super::Affected>>> {
        let mut rows = Vec::new();
        let mut lists = Vec::new();
        let mut unique = HashMap::<Vec<u32>, usize>::new();
        let mut set_keys = Vec::new();
        for set in sets {
            let members = super::evaluator::occurrence_rows(arena, *set)?;
            // Sets with the same members share one list, in the order first seen.
            let mut membership = members.clone();
            membership.sort_unstable();
            let next = lists.len();
            let key = *unique.entry(membership).or_insert_with(|| {
                rows.extend_from_slice(&members);
                lists.push(members);
                next
            });
            set_keys.push((*set, key));
        }
        rows.sort_unstable();
        rows.dedup();
        arena.occurrence_ids(self.query, &rows, measure)?;
        let names = &arena.occurrences.ids;
        let built = measure.parallel(&lists, |members| {
            Arc::new(super::Affected {
                ids: members
                    .iter()
                    .map(|row| {
                        Some(
                            names[*row as usize]
                                .map_or(Arc::from(""), |id| Arc::from(arena.text(id))),
                        )
                    })
                    .collect(),
                rows: members.as_slice().into(),
            })
        });
        Ok(set_keys
            .into_iter()
            .map(|(set, key)| (set, Arc::clone(&built[key])))
            .collect())
    }
    fn dictionary_len(&self) -> Result<usize> {
        self.query.reader.dictionary_count()
    }
    fn checkpoint(&self) -> Result<()> {
        checkpoint(self.cancelled)
    }
    fn prepare(
        &mut self,
        names: &[String],
        arena: &mut super::columns::Arena,
        with_children: bool,
    ) -> Result<super::columns::Prepared> {
        self.prepare_columns(names, arena, with_children)
    }

    fn subject(&self) -> Subject {
        self.subject
    }
    fn len(&self) -> usize {
        match self.subject {
            Subject::Line => self.projection.source.len(),
            Subject::LineCulture => self.cultures.len(),
            Subject::UnitSource => self.units.len(),
        }
    }
    fn field(&mut self, row: usize, name: &str) -> Result<Value> {
        checkpoint(self.cancelled)?;
        match self.subject {
            Subject::Line => self.line_field(row, name),
            Subject::LineCulture => {
                let (line, ci) = self.cultures.at(row);
                if let Some(name) = name.strip_prefix("line.") {
                    self.line_field(line, name)
                } else {
                    self.culture_field(line, ci, name)
                }
            }
            Subject::UnitSource => {
                let group = &self.units[row];
                match name {
                    "source" => Ok(json!(self.query.reader.string(group.source)?)),
                    "textUnitId" => Ok(json!(self.query.packed("raw", group.unit)?)),
                    _ => Err("Unknown unit_source field.".into()),
                }
            }
        }
    }
    fn occurrences(&mut self, row: usize) -> Result<Vec<Value>> {
        use super::columns::Atom;
        let mut arena = self.take_read_arena()?;
        let members = if self.subject == Subject::UnitSource {
            self.units[row].members.clone()
        } else {
            arena
                .line_children
                .as_ref()
                .ok_or("Missing occurrence CSR.")?
                .members(self.line_row(row)?)
                .to_vec()
        };
        let atoms = members
            .into_iter()
            .map(|row| arena.occurrence_id(row))
            .collect::<Result<Vec<Atom>>>()?;
        let set = arena.list(atoms)?;
        let affected = self.affected(&mut arena, &[set], &mut super::stages::Measure::start())?;
        self.read_arena = Some(arena);
        let affected = &affected[&set];
        self.places(&affected.rows, &affected.ids)
    }
}
