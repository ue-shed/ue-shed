//! Native typed subject projections. Stored texts stay dictionary IDs throughout execution.
use super::columns::{Arena, Atom, Children, Column, FieldColumn, Prepared, StrId};
use super::value::Value;
use super::{NativeSubjects, Subject, SubjectRows};
use crate::engine_match::checkpoint;
use crate::engine_types::{REASONS, STATES};
use crate::join_policy::trim;
use crate::{Result, require};
use std::collections::HashMap;
use std::sync::Arc;

type Ids = Arc<[u32]>;
#[derive(Clone)]
struct InputFile {
    references: Ids,
    options: Ids,
    source: Ids,
    translation: Ids,
    source_extra: Ids,
    translation_extra: Ids,
    po: bool,
}
impl InputFile {
    fn translation(&self, line: usize) -> Atom {
        let entry = self.references[line];
        if entry == 0 {
            return Atom::Null;
        }
        let entry = entry as usize - 1;
        let flags = self.options[entry];
        if self.po && flags & 64 == 0 {
            Atom::Null
        } else {
            Atom::Str(StrId(if flags & 128 != 0 {
                self.source[entry]
            } else {
                self.translation[entry]
            }))
        }
    }
}
struct Manifest {
    source: Ids,
    options: Ids,
    path: Ids,
    notes: Ids,
    metadata: Ids,
    prefix: String,
}
struct Projector<'a, 'q> {
    subjects: &'a mut NativeSubjects<'q>,
    arena: &'a mut Arena,
    fields: HashMap<String, Arc<Column>>,
    manifest: Option<Manifest>,
    files: HashMap<(usize, bool), InputFile>,
    references: Vec<(Ids, Ids)>,
    choices: Vec<Option<usize>>,
    json: HashMap<u32, Value>,
}
impl<'a, 'q> Projector<'a, 'q> {
    fn new(subjects: &'a mut NativeSubjects<'q>, arena: &'a mut Arena) -> Result<Self> {
        let mut references = Vec::new();
        for ci in 0..subjects.query.cultures.len() {
            references.push((
                subjects.query.reader.column(&format!("c{ci}.po"))?,
                subjects.query.reader.column(&format!("c{ci}.archive"))?,
            ));
        }
        let native = subjects.query.target["nativeCulture"]
            .as_str()
            .and_then(|native| {
                subjects
                    .query
                    .cultures
                    .iter()
                    .position(|culture| culture == native)
            });
        let mut order = (0..subjects.query.cultures.len()).collect::<Vec<_>>();
        order.sort_by(|a, b| {
            subjects
                .collator
                .compare(&subjects.query.cultures[*a], &subjects.query.cultures[*b])
        });
        let choices = (0..subjects.projection.source.len())
            .map(|line| {
                native
                    .filter(|ci| subjects.projection.cultures[*ci].state[line] != 8)
                    .or_else(|| {
                        order
                            .iter()
                            .copied()
                            .find(|ci| subjects.projection.cultures[*ci].state[line] != 8)
                    })
            })
            .collect();
        let fields = arena.line_fields.clone();
        Ok(Self {
            subjects,
            arena,
            fields,
            manifest: None,
            files: HashMap::new(),
            references,
            choices,
            json: HashMap::new(),
        })
    }
    fn strings(&mut self, ids: &[u32]) -> Result<()> {
        self.arena
            .load_strings(&mut self.subjects.query.reader, ids)
    }
    fn string(&mut self, value: &str) -> Result<Atom> {
        self.arena.string(value).map(Atom::Str)
    }
    fn column(&mut self, values: &[Atom]) -> Result<Arc<Column>> {
        Column::from_atoms(values, self.arena).map(Arc::new)
    }
    fn text(&self, value: Atom) -> &str {
        if let Atom::Str(id) = value {
            self.arena.text(id)
        } else {
            ""
        }
    }
    fn parsed(&mut self, id: u32) -> Result<Value> {
        if let Some(value) = self.json.get(&id) {
            return Ok(value.clone());
        }
        self.strings(&[id])?;
        let text = self.arena.text(StrId(id));
        let value = if text.is_empty() {
            Value::object(super::value::Object::new())
        } else {
            crate::json_value::parse_stored_as(text)?
        };
        require(
            value.as_object().is_some(),
            "Stored evidence extras must be an object.",
        )?;
        self.json.insert(id, value.clone());
        Ok(value)
    }
    fn input(&mut self, ci: usize, po: bool) -> Result<&InputFile> {
        if !self.files.contains_key(&(ci, po)) {
            let references = if po {
                Arc::clone(&self.references[ci].0)
            } else {
                Arc::clone(&self.references[ci].1)
            };
            let mut file = InputFile {
                references,
                options: Arc::from([]),
                source: Arc::from([]),
                translation: Arc::from([]),
                source_extra: Arc::from([]),
                translation_extra: Arc::from([]),
                po,
            };
            if file.references.iter().any(|entry| *entry != 0) {
                let name = self.subjects.query.target["outputPaths"]
                    [if po { "portableObjects" } else { "archives" }]
                    [&self.subjects.query.cultures[ci]]
                    .as_str()
                    .ok_or("Missing translation input.")?
                    .to_owned();
                file.options = self
                    .subjects
                    .query
                    .reader
                    .input_column(&name, "entry.options")?;
                file.source = self
                    .subjects
                    .query
                    .reader
                    .input_column(&name, "entry.source")?;
                file.translation = self
                    .subjects
                    .query
                    .reader
                    .input_column(&name, "entry.translation")?;
                if !po {
                    file.source_extra = self
                        .subjects
                        .query
                        .reader
                        .input_column(&name, "entry.source-extra")?;
                    file.translation_extra = self
                        .subjects
                        .query
                        .reader
                        .input_column(&name, "entry.translation-extra")?;
                }
                self.strings(&file.source)?;
                self.strings(&file.translation)?;
            }
            self.files.insert((ci, po), file);
        }
        self.files
            .get(&(ci, po))
            .ok_or_else(|| "Missing loaded translation file.".into())
    }
    fn origin(&mut self, line: usize, ci: usize) -> Result<Atom> {
        let mark = &self.subjects.projection.cultures[ci];
        let name = if mark.facts[line] & 8 != 0 || mark.state[line] == 3 {
            "po"
        } else if self.references[ci].1[line] != 0 {
            "archive"
        } else {
            "absent"
        };
        self.string(name)
    }
    fn manifest(&mut self) -> Result<()> {
        if self.manifest.is_some() || self.subjects.projection.manifest.is_empty() {
            return Ok(());
        }
        let name = self.subjects.query.target["outputPaths"]["manifest"]
            .as_str()
            .ok_or("Missing manifest input.")?
            .to_owned();
        let reader = &mut self.subjects.query.reader;
        let metadata = reader.input_metadata(&name, "file.meta")?;
        let manifest = Manifest {
            source: reader.input_column(&name, "entry.source")?,
            options: reader.input_column(&name, "entry.options")?,
            path: reader.input_column(&name, "entry.path")?,
            notes: reader.input_column(&name, "entry.notes")?,
            metadata: reader.input_column(&name, "entry.metadata")?,
            prefix: metadata["pathPrefix"].as_str().unwrap_or("").to_owned(),
        };
        self.strings(&manifest.source)?;
        self.strings(&manifest.path)?;
        self.strings(&manifest.notes)?;
        self.manifest = Some(manifest);
        Ok(())
    }
    fn sorted_strings(&mut self, mut values: Vec<Atom>) -> Result<Atom> {
        values.sort_by(|a, b| super::text::code_unit_compare(self.text(*a), self.text(*b)));
        values.dedup_by(|a, b| self.text(*a) == self.text(*b));
        self.arena.list(values)
    }
    fn line(&mut self, name: &str) -> Result<Arc<Column>> {
        if let Some(column) = self.fields.get(name) {
            return Ok(Arc::clone(column));
        }
        let len = self.subjects.projection.source.len();
        let mut values = Vec::with_capacity(len);
        match name {
            "source" => {
                let ids = Arc::clone(&self.subjects.projection.source);
                self.strings(&ids)?;
                values.extend(ids.iter().map(|id| Atom::Str(StrId(*id))));
            }
            "lineId" => {
                for row in 0..len {
                    checkpoint(self.subjects.cancelled)?;
                    let text = self.subjects.query.packed("line", row)?;
                    values.push(self.string(&text)?);
                }
            }
            "nativeCulture" => {
                let text = self.subjects.query.target["nativeCulture"]
                    .as_str()
                    .map(str::to_owned);
                let value = text
                    .as_ref()
                    .map_or(Ok(Atom::Null), |text| self.string(text))?;
                let column = Arc::new(Column::constant(value, len));
                self.fields.insert(name.into(), Arc::clone(&column));
                return Ok(column);
            }
            "identity" => {
                let keys = Arc::clone(&self.subjects.projection.key);
                let namespaces = Arc::clone(&self.subjects.projection.namespace);
                self.strings(&keys)?;
                self.strings(&namespaces)?;
                for row in 0..len {
                    values.push(
                        if !self.subjects.slices(row).is_empty()
                            && self.arena.text(StrId(keys[row])).is_empty()
                        {
                            Atom::Null
                        } else {
                            self.arena.object(vec![
                                ("namespace", Atom::Str(StrId(namespaces[row]))),
                                ("key", Atom::Str(StrId(keys[row]))),
                            ])?
                        },
                    );
                }
            }
            "sourceCulture" => {
                let cultures = self.subjects.query.cultures.clone();
                let ids = cultures
                    .iter()
                    .map(|culture| self.string(culture))
                    .collect::<Result<Vec<_>>>()?;
                values.extend(
                    self.choices
                        .iter()
                        .map(|choice| choice.map_or(Atom::Null, |ci| ids[ci])),
                );
            }
            "sourceLatestOrigin" => {
                for row in 0..len {
                    values.push(if let Some(ci) = self.choices[row] {
                        self.origin(row, ci)?
                    } else {
                        self.string("absent")?
                    });
                }
            }
            "manifestSource" => {
                self.manifest()?;
                for row in 0..len {
                    values.push(self.subjects.manifest_rows(row).first().map_or(
                        Atom::Null,
                        |entry| {
                            Atom::Str(StrId(
                                self.manifest
                                    .as_ref()
                                    .map_or(0, |file| file.source[*entry as usize]),
                            ))
                        },
                    ));
                }
            }
            "comparisonSource" => {
                let manifest = self.line("manifestSource")?;
                let source = self.line("source")?;
                for row in 0..len {
                    let value = manifest.get(row, self.arena);
                    values.push(if value == Atom::Null {
                        source.get(row, self.arena)
                    } else {
                        value
                    });
                }
            }
            "sourceVariants" => {
                for row in 0..len {
                    if row & 255 == 0 {
                        checkpoint(self.subjects.cancelled)?;
                    }
                    if !self
                        .subjects
                        .projection
                        .cultures
                        .iter()
                        .any(|culture| culture.reasons[row] & (1 << 11) != 0)
                    {
                        values.push(Atom::Null);
                        continue;
                    }
                    let authored = self
                        .subjects
                        .slices(row)
                        .any(|slice| self.subjects.projection.slice.identity[slice] != 1);
                    let mut sources = Vec::new();
                    for slice in self.subjects.slices(row) {
                        if authored && self.subjects.projection.slice.identity[slice] == 1 {
                            continue;
                        }
                        for member in self.subjects.projection.slice.members(slice) {
                            sources.push(
                                self.subjects
                                    .query
                                    .occurrence_value(*member as usize, "source")?,
                            );
                        }
                    }
                    self.strings(&sources)?;
                    let group = self.sorted_strings(
                        sources.into_iter().map(|id| Atom::Str(StrId(id))).collect(),
                    )?;
                    values.push(
                        if self
                            .arena
                            .elements(group)?
                            .is_some_and(|values| values.len() > 1)
                        {
                            group
                        } else {
                            Atom::Null
                        },
                    );
                }
            }
            "comparable" => {
                let variants = self.line("sourceVariants")?;
                let manifest = self.line("manifestSource")?;
                values.extend((0..len).map(|row| {
                    Atom::Bool(
                        variants.get(row, self.arena) == Atom::Null
                            || manifest.get(row, self.arena) != Atom::Null,
                    )
                }));
            }
            "checkable" => {
                let identity = self.line("identity")?;
                let source = self.line("source")?;
                let comparison = self.line("comparisonSource")?;
                values.extend((0..len).map(|row| {
                    Atom::Bool(
                        identity.get(row, self.arena) != Atom::Null
                            && (!trim(self.text(source.get(row, self.arena))).is_empty()
                                || !trim(self.text(comparison.get(row, self.arena))).is_empty()),
                    )
                }));
            }
            "gathered" => values.extend(
                (0..len).map(|row| Atom::Bool(!self.subjects.manifest_rows(row).is_empty())),
            ),
            "originKind" => {
                let evidence = self.string("evidence")?;
                let corpus = self.string("corpus")?;
                values.extend((0..len).map(|row| {
                    if self.subjects.slices(row).is_empty() {
                        evidence
                    } else {
                        corpus
                    }
                }));
            }
            "manifestLocations" | "bytecodeOnly" => {
                self.manifest()?;
                let mut paths = HashMap::<(u32, bool), Atom>::new();
                for row in 0..len {
                    if row & 255 == 0 {
                        checkpoint(self.subjects.cancelled)?;
                    }
                    let entries = self.subjects.manifest_rows(row).to_vec();
                    let mut locations = Vec::new();
                    if let Some(file) = &self.manifest {
                        for entry in entries {
                            let entry = entry as usize;
                            let key = (file.path[entry], file.options[entry] & 1024 != 0);
                            let path = if let Some(path) = paths.get(&key) {
                                *path
                            } else {
                                let value = format!(
                                    "{}{}",
                                    if key.1 { &file.prefix } else { "" },
                                    self.arena.text(StrId(key.0))
                                );
                                let value = Atom::Str(self.arena.string(&value)?);
                                paths.insert(key, value);
                                value
                            };
                            locations.push(path);
                        }
                    }
                    values.push(if name == "bytecodeOnly" {
                        Atom::Bool(
                            !locations.is_empty()
                                && locations
                                    .iter()
                                    .all(|value| self.text(*value).ends_with("[Script Bytecode]")),
                        )
                    } else {
                        self.sorted_strings(locations)?
                    });
                }
            }
            "manifestNotes" => {
                self.manifest()?;
                let mut comments = HashMap::<u32, Atom>::new();
                for row in 0..len {
                    if row & 255 == 0 {
                        checkpoint(self.subjects.cancelled)?;
                    }
                    let entries = self.subjects.manifest_rows(row).to_vec();
                    let mut notes = Vec::new();
                    for entry in entries {
                        let file = self.manifest.as_ref().ok_or("Missing manifest columns.")?;
                        let entry = entry as usize;
                        let flags = file.options[entry];
                        let note = if flags & 4 != 0 {
                            Atom::Str(StrId(file.notes[entry]))
                        } else {
                            Atom::Null
                        };
                        let metadata = file.metadata[entry];
                        let comment = if flags & 8 == 0 {
                            Atom::Null
                        } else if let Some(comment) = comments.get(&metadata) {
                            *comment
                        } else {
                            let parsed = self.parsed(metadata)?;
                            let comment = parsed["Info"]["Comment"]
                                .as_str()
                                .map(str::to_owned)
                                .map_or(Ok(Atom::Null), |value| self.string(&value))?;
                            comments.insert(metadata, comment);
                            comment
                        };
                        if note != Atom::Null && !trim(self.text(note)).is_empty() {
                            notes.push(note);
                        }
                        if comment != Atom::Null
                            && !trim(self.text(comment)).is_empty()
                            && (note == Atom::Null || self.text(note) != self.text(comment))
                        {
                            notes.push(comment);
                        }
                    }
                    values.push(self.arena.list(notes)?);
                }
            }
            "stringTables" => {
                for row in 0..len {
                    let mut tables = Vec::new();
                    for member in self.subjects.line_members(row) {
                        if self
                            .subjects
                            .query
                            .occurrence_value(member as usize, "location")?
                            == 2
                        {
                            tables.push(
                                self.subjects
                                    .query
                                    .occurrence_value(member as usize, "object")?,
                            );
                        }
                    }
                    self.strings(&tables)?;
                    values.push(self.sorted_strings(
                        tables.into_iter().map(|id| Atom::Str(StrId(id))).collect(),
                    )?);
                }
            }
            "__expectedSource" => {
                let manifest = self.line("manifestSource")?;
                let native = self.subjects.query.target["nativeCulture"]
                    .as_str()
                    .and_then(|name| {
                        self.subjects
                            .query
                            .cultures
                            .iter()
                            .position(|culture| culture == name)
                    });
                let native = native
                    .map(|ci| self.input(ci, false).cloned())
                    .transpose()?;
                if let Some(file) = &native {
                    self.strings(&file.source_extra)?;
                    self.strings(&file.translation_extra)?;
                }
                for row in 0..len {
                    let mut source = manifest.get(row, self.arena);
                    if let Some(file) = &native
                        && file.references[row] != 0
                    {
                        let entry = file.references[row] as usize - 1;
                        let translated = file.translation(row);
                        let text_differs =
                            self.arena.text(StrId(file.source[entry])) != self.text(translated);
                        let a = file.source_extra[entry];
                        let b = file.translation_extra[entry];
                        let extras_differ =
                            if a == b || self.arena.text(StrId(a)) == self.arena.text(StrId(b)) {
                                false
                            } else {
                                self.parsed(a)? != self.parsed(b)?
                            };
                        if text_differs || extras_differ {
                            source = translated;
                        }
                    }
                    values.push(source);
                }
            }
            _ => return Err(format!("Unknown native line column {name}.").into()),
        }
        let column = self.column(&values)?;
        self.fields.insert(name.to_owned(), Arc::clone(&column));
        Ok(column)
    }
    fn culture(&mut self, name: &str) -> Result<Arc<Column>> {
        let mut values = Vec::with_capacity(self.subjects.cultures.len());
        let source_culture = if name == "isSourceCulture" {
            Some(self.line("sourceCulture")?)
        } else {
            None
        };
        let manifest = if name == "expectedSource" {
            Some(self.line("manifestSource")?)
        } else {
            None
        };
        let expected = if name == "expectedSource" {
            Some(self.line("__expectedSource")?)
        } else {
            None
        };
        let native = self.subjects.query.target["nativeCulture"]
            .as_str()
            .map(str::to_owned);
        let culture_names = self.subjects.query.cultures.clone();
        let culture_ids = culture_names
            .iter()
            .map(|name| self.string(name))
            .collect::<Result<Vec<_>>>()?;
        if matches!(name, "po" | "archive" | "archiveSource" | "latest") {
            for ci in 0..culture_names.len() {
                self.input(ci, name == "po")?;
                if name == "latest" {
                    self.input(ci, true)?;
                }
            }
        }
        let mut lists = HashMap::<u32, Atom>::new();
        let state_ids = STATES
            .iter()
            .map(|name| self.string(name))
            .collect::<Result<Vec<_>>>()?;
        let reason_ids = REASONS
            .iter()
            .map(|name| self.string(name))
            .collect::<Result<Vec<_>>>()?;
        for row in 0..self.subjects.cultures.len() {
            if row & 8191 == 0 {
                checkpoint(self.subjects.cancelled)?;
            }
            let (line, ci) = self.subjects.cultures[row];
            let mark = &self.subjects.projection.cultures[ci];
            let value = match name {
                "culture" => culture_ids[ci],
                "state" => state_ids[mark.state[line] as usize],
                "facts" | "unknownReasons" => {
                    let mask = if name == "facts" {
                        mark.facts[line]
                    } else {
                        mark.reasons[line]
                    };
                    if let Some(value) = lists.get(&mask) {
                        *value
                    } else {
                        let names = if name == "facts" {
                            &state_ids
                        } else {
                            &reason_ids
                        };
                        let value = self.arena.list(
                            names
                                .iter()
                                .enumerate()
                                .filter_map(|(bit, value)| {
                                    (mask & (1 << bit) != 0).then_some(*value)
                                })
                                .collect(),
                        )?;
                        lists.insert(mask, value);
                        value
                    }
                }
                "reducedSourceChecking" => Atom::Bool(
                    self.subjects.query.reader.meta["reducedSourceChecking"][ci]
                        .as_bool()
                        .unwrap_or(false),
                ),
                "isNative" => Atom::Bool(native.as_deref() == Some(&culture_names[ci])),
                "isSourceCulture" => Atom::Bool(
                    source_culture
                        .as_ref()
                        .ok_or("Missing source cultures.")?
                        .get(line, self.arena)
                        == culture_ids[ci],
                ),
                "latestOrigin" => self.origin(line, ci)?,
                "po" | "archive" => self.files[&(ci, name == "po")].translation(line),
                "archiveSource" => {
                    let file = &self.files[&(ci, false)];
                    let entry = file.references[line];
                    if entry == 0 {
                        Atom::Null
                    } else {
                        Atom::Str(StrId(file.source[entry as usize - 1]))
                    }
                }
                "latest" => {
                    let mark = &self.subjects.projection.cultures[ci];
                    self.files[&(ci, mark.facts[line] & 8 != 0 || mark.state[line] == 3)]
                        .translation(line)
                }
                "expectedSource" => {
                    if native.as_deref() == Some(&culture_names[ci]) {
                        manifest
                            .as_ref()
                            .ok_or("Missing manifest source.")?
                            .get(line, self.arena)
                    } else {
                        expected
                            .as_ref()
                            .ok_or("Missing expected source.")?
                            .get(line, self.arena)
                    }
                }
                _ => return Err(format!("Unknown native culture column {name}.").into()),
            };
            values.push(value);
        }
        self.column(&values)
    }
    fn unit(&mut self, name: &str) -> Result<Arc<Column>> {
        let mut values = Vec::with_capacity(self.subjects.units.len());
        if name == "source" {
            let sources = self
                .subjects
                .units
                .iter()
                .map(|unit| unit.source)
                .collect::<Vec<_>>();
            self.strings(&sources)?;
            values.extend(sources.into_iter().map(|id| Atom::Str(StrId(id))));
        } else if name == "textUnitId" {
            let mut unit_ids = HashMap::new();
            for row in 0..self.subjects.units.len() {
                let unit = self.subjects.units[row].unit;
                let id = if let Some(id) = unit_ids.get(&unit) {
                    *id
                } else {
                    let text = self.subjects.query.packed("raw", unit)?;
                    let id = self.string(&text)?;
                    unit_ids.insert(unit, id);
                    id
                };
                values.push(id);
            }
        } else {
            return Err(format!("Unknown unit_source column {name}.").into());
        }
        self.column(&values)
    }
    fn children(&mut self, parents: Option<Arc<[u32]>>) -> Result<Children> {
        let line = self.subjects.subject != Subject::UnitSource;
        if line && let Some(children) = &self.arena.line_children {
            let mut children = (**children).clone();
            children.rows = parents;
            return Ok(children);
        }
        let groups = if line {
            (0..self.subjects.projection.source.len())
                .map(|row| self.subjects.line_members(row))
                .collect::<Vec<_>>()
        } else {
            self.subjects
                .units
                .iter()
                .map(|unit| unit.members.clone())
                .collect()
        };
        let mut used = if self.arena.occurrences.raw_rows.is_empty() {
            let mut used = groups.iter().flatten().copied().collect::<Vec<_>>();
            used.sort_unstable();
            used.dedup();
            used
        } else {
            self.arena.occurrences.raw_rows.clone()
        };
        let mut local = used
            .iter()
            .enumerate()
            .map(|(index, row)| (*row, index as u32))
            .collect::<HashMap<_, _>>();
        for row in groups.iter().flatten() {
            if !local.contains_key(row) {
                local.insert(*row, used.len() as u32);
                used.push(*row);
            }
        }
        let required = self.arena.occurrence_fields.clone();
        // Native occurrence columns are requested by rule expressions. Evidence is hydrated
        // only for emitted sets, so the default catalogue needs only devNotes here.
        if self.arena.occurrences.raw_rows.is_empty() {
            for name in &required {
                let mut values = Vec::with_capacity(used.len());
                for (index, row) in used.iter().copied().enumerate() {
                    if index & 8191 == 0 {
                        checkpoint(self.subjects.cancelled)?;
                    }
                    let value = match name.as_str() {
                        "source" | "devNotes" => {
                            let id = self.subjects.query.occurrence_value(
                                row as usize,
                                if name == "source" { "source" } else { "notes" },
                            )?;
                            Atom::Str(StrId(id))
                        }
                        "location" => {
                            let value = self.subjects.query.occurrence_location(row as usize)?;
                            self.arena.intern(Value::from_json(&value))?
                        }
                        "unitStatus" => {
                            let value = self.subjects.query.occurrence_identity(row as usize)?;
                            self.arena.intern(Value::from_json(&value["status"]))?
                        }
                        "id" => {
                            let id = self.subjects.query.occurrence_id(row as usize)?;
                            self.string(&id)?
                        }
                        "packageFile" => {
                            let (shard, package) = self.subjects.query.package_row(row as usize)?;
                            let value = self.subjects.query.package_file(shard, package)?;
                            self.string(&value)?
                        }
                        _ => continue,
                    };
                    values.push(value);
                }
                let ids = values
                    .iter()
                    .filter_map(|atom| {
                        if let Atom::Str(id) = atom {
                            Some(id.0)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>();
                self.strings(&ids)?;
                let column = self.column(&values)?;
                self.arena.occurrences.fields.insert(name.clone(), column);
            }
        }
        let ids = if line {
            used.iter()
                .map(|row| self.subjects.query.occurrence_id(*row as usize))
                .collect::<Result<Vec<_>>>()?
        } else {
            Vec::new()
        };
        let mut children = Children {
            offsets: Arc::new(vec![0]),
            members: Arc::default(),
            rows: parents,
        };
        for mut group in groups {
            if line {
                group.sort_by(|a, b| {
                    self.subjects
                        .collator
                        .compare(&ids[local[a] as usize], &ids[local[b] as usize])
                });
            }
            Arc::make_mut(&mut children.members).extend(group.iter().map(|row| local[row]));
            Arc::make_mut(&mut children.offsets).push(children.members.len().try_into()?);
        }
        self.arena.occurrences.len = used.len();
        self.arena.occurrences.raw_rows = used;
        if line {
            let mut shared = children.clone();
            shared.rows = None;
            self.arena.line_children = Some(Arc::new(shared));
        }
        Ok(children)
    }
}
impl NativeSubjects<'_> {
    pub(super) fn prepare_columns(
        &mut self,
        names: &[String],
        arena: &mut Arena,
        with_children: bool,
    ) -> Result<Prepared> {
        let parents: Option<Arc<[u32]>> = if self.subject == Subject::LineCulture {
            Some(
                self.cultures
                    .iter()
                    .map(|(line, _)| *line as u32)
                    .collect::<Vec<_>>()
                    .into(),
            )
        } else {
            None
        };
        let mut projector = Projector::new(self, arena)?;
        let started = super::stages::Measure::start();
        let children = if with_children {
            projector.children(parents.clone())?
        } else {
            Children::default()
        };
        projector.arena.recorder.stage(
            "subjects.occurrences",
            &started,
            projector.arena.occurrences.len,
        );
        let started = super::stages::Measure::start();
        let mut fields = HashMap::new();
        for name in names {
            checkpoint(projector.subjects.cancelled)?;
            let (column, rows) = match projector.subjects.subject {
                Subject::Line => (projector.line(name)?, None),
                Subject::LineCulture => {
                    if let Some(name) = name.strip_prefix("line.") {
                        (projector.line(name)?, parents.clone())
                    } else {
                        (projector.culture(name)?, None)
                    }
                }
                Subject::UnitSource => (projector.unit(name)?, None),
            };
            fields.insert(name.clone(), FieldColumn { column, rows });
        }
        projector
            .arena
            .recorder
            .stage("subjects.columns", &started, projector.subjects.len());
        projector.arena.line_fields = projector.fields.clone();
        Ok(Prepared { fields, children })
    }
}
