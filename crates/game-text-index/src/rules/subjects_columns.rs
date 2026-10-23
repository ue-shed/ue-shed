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
    work: super::stages::Measure,
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
            work: super::stages::Measure::start(),
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
                let data = Arc::clone(&self.subjects.occurrences);
                self.strings(&data.columns["source"])?;
                let p = &self.subjects.projection;
                let arena = &self.arena;
                let lists = self.work.parallel(&(0..len).collect::<Vec<_>>(), |row| {
                    let row = *row;
                    if !p
                        .cultures
                        .iter()
                        .any(|culture| culture.reasons[row] & (1 << 11) != 0)
                    {
                        return None;
                    }
                    let slices = p.starts[row] as usize..p.starts[row + 1] as usize;
                    let authored = slices.clone().any(|slice| p.slice.identity[slice] != 1);
                    let mut sources = slices
                        .filter(|slice| !authored || p.slice.identity[*slice] != 1)
                        .flat_map(|slice| p.slice.members(slice).iter())
                        .map(|member| data.value(*member as usize, "source"))
                        .collect::<Vec<_>>();
                    sources.sort_by(|a, b| {
                        super::text::code_unit_compare(arena.text(StrId(*a)), arena.text(StrId(*b)))
                    });
                    sources.dedup_by(|a, b| arena.text(StrId(*a)) == arena.text(StrId(*b)));
                    (sources.len() > 1).then_some(sources)
                });
                for list in lists {
                    values.push(if let Some(list) = list {
                        self.arena
                            .list(list.into_iter().map(|id| Atom::Str(StrId(id))).collect())?
                    } else {
                        Atom::Null
                    });
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
                if let Some(file) = &self.manifest {
                    for entry in self.subjects.projection.manifest.iter() {
                        let entry = *entry as usize;
                        let key = (file.path[entry], file.options[entry] & 1024 != 0);
                        if let std::collections::hash_map::Entry::Vacant(entry) = paths.entry(key) {
                            let path = format!(
                                "{}{}",
                                if key.1 { &file.prefix } else { "" },
                                self.arena.text(StrId(key.0))
                            );
                            entry.insert(Atom::Str(self.arena.string(&path)?));
                        }
                    }
                }
                let subjects = &self.subjects;
                let file = &self.manifest;
                let arena = &self.arena;
                let lists = self.work.parallel(&(0..len).collect::<Vec<_>>(), |row| {
                    let mut list = Vec::new();
                    if let Some(file) = file {
                        for entry in subjects.manifest_rows(*row) {
                            let entry = *entry as usize;
                            list.push(paths[&(file.path[entry], file.options[entry] & 1024 != 0)]);
                        }
                    }
                    if name != "bytecodeOnly" {
                        list.sort_by(|a, b| {
                            super::text::code_unit_compare(
                                if let Atom::Str(id) = a {
                                    arena.text(*id)
                                } else {
                                    ""
                                },
                                if let Atom::Str(id) = b {
                                    arena.text(*id)
                                } else {
                                    ""
                                },
                            )
                        });
                        list.dedup();
                    }
                    list
                });
                for list in lists {
                    values.push(if name == "bytecodeOnly" {
                        Atom::Bool(
                            !list.is_empty()
                                && list
                                    .iter()
                                    .all(|value| self.text(*value).ends_with("[Script Bytecode]")),
                        )
                    } else {
                        self.arena.list(list)?
                    });
                }
            }
            "manifestNotes" => {
                self.manifest()?;
                let mut comments = HashMap::<u32, Atom>::new();
                if let Some(file) = &self.manifest {
                    let ids = self
                        .subjects
                        .projection
                        .manifest
                        .iter()
                        .filter(|entry| file.options[**entry as usize] & 8 != 0)
                        .map(|entry| file.metadata[*entry as usize])
                        .collect::<std::collections::HashSet<_>>();
                    for id in ids {
                        let parsed = self.parsed(id)?;
                        let comment = parsed["Info"]["Comment"].as_str().map(str::to_owned);
                        comments.insert(
                            id,
                            comment.map_or(Ok(Atom::Null), |text| self.string(&text))?,
                        );
                    }
                }
                let subjects = &self.subjects;
                let file = &self.manifest;
                let arena = &self.arena;
                let lists = self.work.parallel(&(0..len).collect::<Vec<_>>(), |row| {
                    let mut notes = Vec::new();
                    if let Some(file) = file {
                        for entry in subjects.manifest_rows(*row) {
                            let entry = *entry as usize;
                            let flags = file.options[entry];
                            let note = if flags & 4 != 0 {
                                Atom::Str(StrId(file.notes[entry]))
                            } else {
                                Atom::Null
                            };
                            let comment = if flags & 8 != 0 {
                                comments
                                    .get(&file.metadata[entry])
                                    .copied()
                                    .unwrap_or_default()
                            } else {
                                Atom::Null
                            };
                            let text = |atom| {
                                if let Atom::Str(id) = atom {
                                    arena.text(id)
                                } else {
                                    ""
                                }
                            };
                            if note != Atom::Null && !trim(text(note)).is_empty() {
                                notes.push(note);
                            }
                            if comment != Atom::Null
                                && !trim(text(comment)).is_empty()
                                && (note == Atom::Null || text(note) != text(comment))
                            {
                                notes.push(comment);
                            }
                        }
                    }
                    notes
                });
                for list in lists {
                    values.push(self.arena.list(list)?);
                }
            }
            "stringTables" => {
                let data = Arc::clone(&self.subjects.occurrences);
                self.strings(&data.columns["object"])?;
                let p = &self.subjects.projection;
                let arena = &self.arena;
                let lists = self.work.parallel(&(0..len).collect::<Vec<_>>(), |row| {
                    let mut tables = (p.starts[*row] as usize..p.starts[*row + 1] as usize)
                        .flat_map(|slice| p.slice.members(slice).iter())
                        .filter(|member| data.value(**member as usize, "location") == 2)
                        .map(|member| data.value(*member as usize, "object"))
                        .collect::<Vec<_>>();
                    tables.sort_by(|a, b| {
                        super::text::code_unit_compare(arena.text(StrId(*a)), arena.text(StrId(*b)))
                    });
                    tables.dedup_by(|a, b| arena.text(StrId(*a)) == arena.text(StrId(*b)));
                    tables
                        .into_iter()
                        .map(|id| Atom::Str(StrId(id)))
                        .collect::<Vec<_>>()
                });
                for list in lists {
                    values.push(self.arena.list(list)?);
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
        let state_ids = STATES
            .iter()
            .map(|name| self.string(name))
            .collect::<Result<Vec<_>>>()?;
        let reason_ids = REASONS
            .iter()
            .map(|name| self.string(name))
            .collect::<Result<Vec<_>>>()?;
        let rows = &self.subjects.cultures;
        let marks = &self.subjects.projection.cultures;
        // Interning happens here, in first-row order; the parallel fill below only reads.
        let mut lists = HashMap::<u32, Atom>::new();
        if matches!(name, "facts" | "unknownReasons") {
            let names = if name == "facts" {
                &state_ids
            } else {
                &reason_ids
            };
            for (line, ci) in rows.iter() {
                let mask = if name == "facts" {
                    marks[ci].facts[line]
                } else {
                    marks[ci].reasons[line]
                };
                if let std::collections::hash_map::Entry::Vacant(entry) = lists.entry(mask) {
                    entry.insert(
                        self.arena.list(
                            names
                                .iter()
                                .enumerate()
                                .filter_map(|(bit, value)| {
                                    (mask & (1 << bit) != 0).then_some(*value)
                                })
                                .collect(),
                        )?,
                    );
                }
            }
        }
        let origins = if name == "latestOrigin" {
            [
                self.string("po")?,
                self.string("archive")?,
                self.string("absent")?,
            ]
        } else {
            [Atom::Null; 3]
        };
        let reduced = (0..culture_names.len())
            .map(|ci| {
                self.subjects.query.reader.meta["reducedSourceChecking"][ci]
                    .as_bool()
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        let known = matches!(
            name,
            "culture"
                | "state"
                | "facts"
                | "unknownReasons"
                | "reducedSourceChecking"
                | "isNative"
                | "isSourceCulture"
                | "latestOrigin"
                | "po"
                | "archive"
                | "archiveSource"
                | "latest"
                | "expectedSource"
        );
        if !known {
            return Err(format!("Unknown native culture column {name}.").into());
        }
        let rows = &self.subjects.cultures;
        let marks = &self.subjects.projection.cultures;
        let references = &self.references;
        let files = &self.files;
        let arena = &*self.arena;
        let value = |row: usize| -> Atom {
            let (line, ci) = rows.at(row);
            let mark = &marks[ci];
            match name {
                "culture" => culture_ids[ci],
                "state" => state_ids[mark.state[line] as usize],
                "facts" => lists[&mark.facts[line]],
                "unknownReasons" => lists[&mark.reasons[line]],
                "reducedSourceChecking" => Atom::Bool(reduced[ci]),
                "isNative" => Atom::Bool(native.as_deref() == Some(&culture_names[ci])),
                "isSourceCulture" => Atom::Bool(
                    source_culture
                        .as_ref()
                        .is_some_and(|column| column.get(line, arena) == culture_ids[ci]),
                ),
                "latestOrigin" => {
                    if mark.facts[line] & 8 != 0 || mark.state[line] == 3 {
                        origins[0]
                    } else if references[ci].1[line] != 0 {
                        origins[1]
                    } else {
                        origins[2]
                    }
                }
                "po" | "archive" => files[&(ci, name == "po")].translation(line),
                "archiveSource" => {
                    let file = &files[&(ci, false)];
                    let entry = file.references[line];
                    if entry == 0 {
                        Atom::Null
                    } else {
                        Atom::Str(StrId(file.source[entry as usize - 1]))
                    }
                }
                "latest" => files[&(ci, mark.facts[line] & 8 != 0 || mark.state[line] == 3)]
                    .translation(line),
                _ => {
                    let column = if native.as_deref() == Some(&culture_names[ci]) {
                        &manifest
                    } else {
                        &expected
                    };
                    column
                        .as_ref()
                        .map_or(Atom::Null, |column| column.get(line, arena))
                }
            }
        };
        checkpoint(self.subjects.cancelled)?;
        let values = self
            .work
            .fill(rows.len(), 1 << 14, |start, slots: &mut [Atom]| {
                for (offset, slot) in slots.iter_mut().enumerate() {
                    *slot = value(start + offset);
                }
            });
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
        let data = Arc::clone(&self.subjects.occurrences);
        self.arena.occurrences.data = Some(Arc::clone(&data));
        self.arena.occurrences.len = data.len();
        if self.arena.occurrences.raw_rows.is_empty() {
            self.arena.occurrences.raw_rows = (0..data.len() as u32).collect();
        }
        let required = self.arena.occurrence_fields.clone();
        for name in &required {
            if self.arena.occurrences.fields.contains_key(name) {
                continue;
            }
            let step = super::stages::Measure::start();
            let values = match name.as_str() {
                "source" | "devNotes" => {
                    let ids = &data.columns[if name == "source" { "source" } else { "notes" }];
                    self.strings(ids)?;
                    ids.iter()
                        .map(|id| Atom::Str(StrId(*id)))
                        .collect::<Vec<_>>()
                }
                "location" => {
                    for field in ["object", "property", "class", "row"] {
                        self.strings(&data.columns[field])?;
                    }
                    for (index, kind) in ["asset_property", "data_table_cell", "string_table_entry"]
                        .iter()
                        .enumerate()
                    {
                        self.arena.occurrences.location_kinds[index] = self.string(kind)?;
                    }
                    (0..data.len())
                        .map(|row| self.arena.occurrence_location(u32::try_from(row)?))
                        .collect::<Result<Vec<_>>>()?
                }
                "unitStatus" => {
                    self.strings(&data.columns["key"])?;
                    let resolved = self.string("resolved")?;
                    let table = self.string("string_table")?;
                    let unresolved = self.string("unresolved")?;
                    (0..data.len())
                        .map(|row| match data.status(row, self.arena) {
                            "resolved" => resolved,
                            "string_table" => table,
                            _ => unresolved,
                        })
                        .collect()
                }
                "id" => {
                    let rows = (0..data.len() as u32).collect::<Vec<_>>();
                    self.arena
                        .occurrence_ids(self.subjects.query, &rows, &mut self.work)?;
                    self.arena
                        .occurrences
                        .ids
                        .iter()
                        .map(|id| id.map_or(Atom::Null, Atom::Str))
                        .collect()
                }
                "packageFile" => {
                    if self.arena.occurrences.files.is_empty() {
                        self.arena.occurrences.files = data
                            .files
                            .iter()
                            .map(|file| self.arena.string(file))
                            .collect::<Result<_>>()?;
                    }
                    data.packages
                        .iter()
                        .map(|package| Atom::Str(self.arena.occurrences.files[*package as usize]))
                        .collect()
                }
                _ => continue,
            };
            let column = self.column(&values)?;
            self.arena.occurrences.fields.insert(name.clone(), column);
            self.arena
                .recorder
                .sub_stage(format!("occurrences.{name}"), &step, data.len());
        }
        if line && let Some(children) = &self.arena.line_children {
            let mut children = (**children).clone();
            children.rows = parents;
            return Ok(children);
        }
        let mut groups = if line {
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
        let step = super::stages::Measure::start();
        if line {
            let rows = groups
                .iter()
                .filter(|group| group.len() > 1)
                .flatten()
                .copied()
                .collect::<Vec<_>>();
            self.arena
                .occurrence_ids(self.subjects.query, &rows, &mut self.work)?;
            let arena = &self.arena;
            let collator = self.subjects.collator;
            groups = self.work.parallel(&groups, |group| {
                let mut group = group.clone();
                if group.len() > 1 {
                    group.sort_by(|a, b| {
                        collator.compare(
                            arena.text(arena.occurrences.ids[*a as usize].unwrap_or(StrId(0))),
                            arena.text(arena.occurrences.ids[*b as usize].unwrap_or(StrId(0))),
                        )
                    });
                }
                group
            });
        }
        let mut children = Children {
            offsets: Arc::new(vec![0]),
            members: Arc::default(),
            rows: parents,
        };
        let offsets = Arc::make_mut(&mut children.offsets);
        let members = Arc::make_mut(&mut children.members);
        for group in groups {
            members.extend(group);
            offsets.push(members.len().try_into()?);
        }
        if line {
            let mut shared = children.clone();
            shared.rows = None;
            self.arena.line_children = Some(Arc::new(shared));
        }
        self.arena.recorder.sub_stage(
            "occurrences.groups".into(),
            &step,
            children.offsets.len() - 1,
        );
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
            Some(Arc::clone(&self.cultures.lines))
        } else {
            None
        };
        use super::stages::{Phase, subject_stage};
        let (children_stage, columns_stage) = (
            subject_stage(self.subject, Phase::Children),
            subject_stage(self.subject, Phase::Columns),
        );
        let mut projector = Projector::new(self, arena)?;
        projector.arena.recorder.enter(children_stage);
        let mut started = super::stages::Measure::start();
        let children = if with_children {
            projector.children(parents.clone())?
        } else {
            Children::default()
        };
        started.include(&projector.work);
        projector.work = super::stages::Measure::start();
        projector
            .arena
            .recorder
            .stage(children_stage, &started, projector.arena.occurrences.len);
        projector
            .arena
            .recorder
            .memory(children_stage, projector.arena.memory());
        projector.arena.recorder.enter(columns_stage);
        let mut started = super::stages::Measure::start();
        let mut fields = HashMap::new();
        for name in names {
            checkpoint(projector.subjects.cancelled)?;
            let mut field = super::stages::Measure::start();
            let work = std::mem::replace(&mut projector.work, super::stages::Measure::start());
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
            field.include(&projector.work);
            projector.arena.recorder.sub_stage(
                format!("{columns_stage}.{name}"),
                &field,
                projector.subjects.len(),
            );
            started.include(&projector.work);
            projector.work = work;
        }
        started.include(&projector.work);
        projector
            .arena
            .recorder
            .stage(columns_stage, &started, projector.subjects.len());
        projector
            .arena
            .recorder
            .memory(columns_stage, projector.arena.memory());
        projector.arena.line_fields = projector.fields.clone();
        // The subject's columns are built: its raw index columns are no longer needed.
        self.query.reader.release_evaluation_columns();
        Ok(Prepared { fields, children })
    }
}
