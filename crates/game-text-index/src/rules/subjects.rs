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
pub struct NativeSubjects<'a> {
    pub query: &'a mut EngineQuery,
    pub(crate) projection: Arc<Projection>,
    pub subject: Subject,
    pub cultures: Vec<(usize, usize)>,
    pub units: Vec<UnitSource>,
    collator: &'a HostCollator,
    cancelled: &'a AtomicBool,
    parent_fields: HashMap<(usize, String), Value>,
    place_cache: HashMap<usize, Vec<Value>>,
}
impl<'a> NativeSubjects<'a> {
    pub fn new(
        query: &'a mut EngineQuery,
        subject: Subject,
        collator: &'a HostCollator,
        cancelled: &'a AtomicBool,
    ) -> Result<Self> {
        let projection = Projection::open(query, cancelled)?;
        let mut cultures = Vec::new();
        let mut units: Vec<UnitSource> = Vec::new();
        if subject == Subject::LineCulture {
            let mut order = (0..query.cultures.len()).collect::<Vec<_>>();
            order.sort_by(|a, b| collator.compare(&query.cultures[*a], &query.cultures[*b]));
            for line in 0..projection.source.len() {
                for culture in &order {
                    if projection.cultures[*culture].state[line] != 8 {
                        cultures.push((line, *culture));
                    }
                }
            }
        }
        if subject == Subject::UnitSource {
            for unit in 0..projection.raw.visible.len() {
                if projection.raw.visible[unit] == 0 {
                    continue;
                }
                let mut groups = HashMap::<u32, usize>::new();
                for member in projection.raw.members(unit) {
                    let source = query.occurrence_value(*member as usize, "source")?;
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
            parent_fields: HashMap::new(),
            place_cache: HashMap::new(),
        })
    }
    pub fn line_row(&self, row: usize) -> Result<usize> {
        if self.subject == Subject::LineCulture {
            self.cultures
                .get(row)
                .map(|(line, _)| *line)
                .ok_or_else(|| "Culture subject outside relation.".into())
        } else {
            Ok(row)
        }
    }
    fn manifest_rows(&self, line: usize) -> &[u32] {
        &self.projection.manifest[self.projection.manifest_start[line] as usize
            ..self.projection.manifest_end[line] as usize]
    }
    fn manifest_path(&self) -> Result<String> {
        self.query.target["outputPaths"]["manifest"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Missing manifest input.".into())
    }
    fn slices(&self, line: usize) -> std::ops::Range<usize> {
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
        if let Some(value) = self.parent_fields.get(&(line, name.into())) {
            return Ok(value.clone());
        }
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
                        let id = self.query.occurrence_value(member as usize, "source")?;
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
                    if self.query.occurrence_value(member as usize, "location")? == 2 {
                        let id = self.query.occurrence_value(member as usize, "object")?;
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
        self.parent_fields
            .insert((line, name.into()), result.clone());
        Ok(result)
    }
    fn place(&mut self, member: u32, unit_status: &Value) -> Result<Value> {
        let member = member as usize;
        let (shard, package) = self.query.package_row(member)?;
        let source = self.query.occurrence_value(member, "source")?;
        let notes = self.query.occurrence_value(member, "notes")?;
        Ok(
            json!({"id":self.query.occurrence_id(member)?,"packageFile":self.query.package_file(shard,package)?,"source":self.query.reader.string(source)?,"devNotes":self.query.reader.string(notes)?,"location":self.query.occurrence_location(member)?,"unitStatus":unit_status}),
        )
    }
}
impl SubjectRows for NativeSubjects<'_> {
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
                let (line, ci) = self.cultures[row];
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
        checkpoint(self.cancelled)?;
        let line = self.line_row(row)?;
        let cache_key = if self.subject == Subject::UnitSource {
            row
        } else {
            line
        };
        if let Some(places) = self.place_cache.get(&cache_key) {
            return Ok(places.clone());
        }
        let mut result = Vec::new();
        if self.subject == Subject::UnitSource {
            let members = self.units[row].members.clone();
            let representative =
                self.query
                    .value("raw", "representative", self.units[row].unit)? as usize;
            let status = self.query.occurrence_identity(representative)?["status"].clone();
            for member in members {
                result.push(self.place(member, &status)?);
            }
        } else {
            for slice in self.slices(line) {
                let representative = self.query.value("slice", "representative", slice)? as usize;
                let status = self.query.occurrence_identity(representative)?["status"].clone();
                let members = self.projection.slice.members(slice).to_vec();
                for member in members {
                    result.push(self.place(member, &status)?);
                }
            }
            result.sort_by(|a, b| {
                self.collator.compare(
                    a["id"].as_str().unwrap_or(""),
                    b["id"].as_str().unwrap_or(""),
                )
            });
        }
        self.place_cache.insert(cache_key, result.clone());
        Ok(result)
    }
}
