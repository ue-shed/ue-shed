//! String Tables declared in code: `LOCTABLE_NEW`, `LOCTABLE_FROMFILE_*`, `LOCTABLE_SETSTRING`,
//! `LOCTABLE_SETNOTESTRING` and `LOCTABLE_SETMETA`.
//!
//! The scanner records each call as an operation in file order; the tables are built by applying
//! them, per file on 5.x and across the whole project on 4.27. The first registration, entry and
//! metadata value win; a repeated entry with the same text keeps editor-only only if both were.
//! Table and metadata IDs are `FName`s and entry keys `FString` map keys, so all compare without
//! case.

use std::collections::HashMap;

use crate::csv;
use crate::literal::replace_escaped_char_with_char;
use crate::wide::{Wide, equals_ignore_case, narrow, wide};
use crate::{CodeDiagnostic, CodePlace, DiagnosticCode, EngineLine, MetadataField};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContentRoot {
    Game,
    Engine,
}

#[derive(Clone, Debug)]
pub(crate) enum TableOp {
    Register {
        table: Wide,
        namespace: Wide,
    },
    RegisterFromFile {
        table: Wide,
        namespace: Wide,
        path: Wide,
        root: ContentRoot,
        macro_name: Wide,
    },
    Entry {
        table: Wide,
        key: Wide,
        source: Wide,
        dev_notes: Wide,
        macro_name: Wide,
    },
    Meta {
        table: Wide,
        key: Wide,
        id: Wide,
        value: Wide,
    },
}

/// One operation, where it was and what the file's state was at the time.
#[derive(Clone, Debug)]
pub(crate) struct TableCall {
    pub(crate) op: TableOp,
    pub(crate) file: String,
    pub(crate) line: u32,
    pub(crate) editor_only: bool,
    pub(crate) platform: Option<String>,
}

#[derive(Clone)]
struct Location {
    file: String,
    line: Option<u32>,
}

impl Location {
    fn label(&self, engine: EngineLine) -> String {
        match (self.line, engine) {
            (Some(line), EngineLine::Ue4_27) => format!("{}:{line}", self.file),
            (Some(line), _) => format!("{}({line})", self.file),
            (None, _) => self.file.clone(),
        }
    }
}

struct Entry {
    key: Wide,
    source: Wide,
    dev_notes: Wide,
    location: Location,
    platform: Option<String>,
    editor_only: bool,
    macro_name: Wide,
}

struct Meta {
    id: Wide,
    value: Wide,
    location: Location,
    editor_only: bool,
}

struct Table {
    id: Wide,
    namespace: Wide,
    registered: Option<Location>,
    entries: Vec<Entry>,
    metadata: Vec<(Wide, Vec<Meta>)>,
}

/// Reads a String Table CSV given its path under a content root; `None` when it cannot be read.
pub(crate) trait CsvSource {
    fn read_csv(&self, root: ContentRoot, path: &str) -> Option<Wide>;
}

fn fold(text: &[u16]) -> Wide {
    text.iter()
        .map(|&unit| {
            if (65..=90).contains(&unit) {
                unit + 32
            } else {
                unit
            }
        })
        .collect()
}

/// `FName::IsNone`: empty, or `None` in any case.
pub(crate) fn is_none_name(text: &[u16]) -> bool {
    text.is_empty() || equals_ignore_case(text, &wide("None"))
}

#[derive(Default)]
pub(crate) struct Tables {
    tables: Vec<Table>,
    index: HashMap<Wide, usize>,
}

struct CsvEntry {
    key: Wide,
    source: Wide,
    dev_notes: Wide,
    metadata: Vec<(Wide, Wide)>,
}

/// `FStringTable::ImportStrings` (5.7 and earlier) and `ImportStringsFromCSVFile` (5.8).
fn import_csv(text: &[u16], engine: EngineLine) -> Option<Vec<CsvEntry>> {
    let rows = csv::parse(text);
    if rows.len() <= 1 {
        return None;
    }
    let mut key_column = None;
    let mut source_column = None;
    let mut notes_column = None;
    let mut meta_columns: Vec<(Wide, usize)> = Vec::new();
    for (column, cell) in rows[0].iter().enumerate() {
        if equals_ignore_case(cell, &wide("Key")) && key_column.is_none() {
            key_column = Some(column);
        } else if equals_ignore_case(cell, &wide("SourceString")) && source_column.is_none() {
            source_column = Some(column);
        } else if engine == EngineLine::Ue5_8
            && equals_ignore_case(cell, &wide("DevNotes"))
            && notes_column.is_none()
        {
            notes_column = Some(column);
        } else if !is_none_name(cell) {
            match meta_columns
                .iter_mut()
                .find(|(name, _)| equals_ignore_case(name, cell))
            {
                Some(existing) => existing.1 = column,
                None => meta_columns.push((cell.clone(), column)),
            }
        }
    }
    let (key_column, source_column) = (key_column?, source_column?);
    let mut entries: Vec<CsvEntry> = Vec::new();
    let mut by_key: HashMap<Wide, usize> = HashMap::new();
    for row in &rows[1..] {
        let (Some(key), Some(source)) = (row.get(key_column), row.get(source_column)) else {
            continue;
        };
        let key = replace_escaped_char_with_char(key);
        let source = replace_escaped_char_with_char(source);
        let dev_notes = notes_column
            .and_then(|column| row.get(column))
            .map(|notes| replace_escaped_char_with_char(notes))
            .unwrap_or_default();
        let mut metadata = Vec::new();
        for (name, column) in &meta_columns {
            if let Some(value) = row.get(*column) {
                let value = replace_escaped_char_with_char(value);
                if !value.is_empty() {
                    metadata.push((name.clone(), value));
                }
            }
        }
        // A repeated key replaces the entry in place and keeps adding metadata.
        match by_key.get(&fold(&key)) {
            Some(&at) => {
                let entry = &mut entries[at];
                entry.key = key;
                entry.source = source;
                entry.dev_notes = dev_notes;
                for (name, value) in metadata {
                    match entry
                        .metadata
                        .iter_mut()
                        .find(|(existing, _)| equals_ignore_case(existing, &name))
                    {
                        Some(existing) => existing.1 = value,
                        None => entry.metadata.push((name, value)),
                    }
                }
            }
            None => {
                by_key.insert(fold(&key), entries.len());
                entries.push(CsvEntry {
                    key,
                    source,
                    dev_notes,
                    metadata,
                });
            }
        }
    }
    Some(entries)
}

impl Tables {
    fn table(&mut self, id: &[u16]) -> &mut Table {
        let folded = fold(id);
        let at = match self.index.get(&folded) {
            Some(&at) => at,
            None => {
                self.index.insert(folded, self.tables.len());
                self.tables.push(Table {
                    id: id.to_vec(),
                    namespace: Wide::new(),
                    registered: None,
                    entries: Vec::new(),
                    metadata: Vec::new(),
                });
                self.tables.len() - 1
            }
        };
        &mut self.tables[at]
    }

    fn register(
        &mut self,
        call: &TableCall,
        table: &[u16],
        namespace: &[u16],
        diagnostics: &mut Vec<CodeDiagnostic>,
        engine: EngineLine,
    ) -> bool {
        let location = Location {
            file: call.file.clone(),
            line: Some(call.line),
        };
        let entry = self.table(table);
        if let Some(existing) = &entry.registered {
            diagnostics.push(CodeDiagnostic::new(
                &call.file,
                Some(call.line),
                DiagnosticCode::TableRedefined,
                format!(
                    "String Table '{}' is already registered at {}; this one is ignored.",
                    narrow(table),
                    existing.label(engine)
                ),
            ));
            return false;
        }
        entry.namespace = namespace.to_vec();
        entry.registered = Some(location);
        true
    }

    fn add_entry(
        &mut self,
        table: &[u16],
        new: Entry,
        diagnostics: &mut Vec<CodeDiagnostic>,
        engine: EngineLine,
    ) {
        let at_file = new.location.file.clone();
        let at_line = new.location.line;
        let table_entry = self.table(table);
        if let Some(existing) = table_entry
            .entries
            .iter_mut()
            .find(|entry| equals_ignore_case(&entry.key, &new.key))
        {
            if existing.source == new.source {
                existing.editor_only &= new.editor_only;
            } else {
                diagnostics.push(CodeDiagnostic::new(
					&at_file,
					at_line,
					DiagnosticCode::TableEntryRedefined,
					format!(
						"String Table '{}' entry '{}' is already defined at {}; this one is ignored.",
						narrow(table),
						narrow(&new.key),
						existing.location.label(engine)
					),
				));
            }
            return;
        }
        table_entry.entries.push(new);
    }

    fn add_meta(
        &mut self,
        table: &[u16],
        key: &[u16],
        new: Meta,
        diagnostics: &mut Vec<CodeDiagnostic>,
        engine: EngineLine,
    ) {
        let at_file = new.location.file.clone();
        let at_line = new.location.line;
        let table_entry = self.table(table);
        let position = match table_entry
            .metadata
            .iter()
            .position(|(existing, _)| equals_ignore_case(existing, key))
        {
            Some(position) => position,
            None => {
                table_entry.metadata.push((key.to_vec(), Vec::new()));
                table_entry.metadata.len() - 1
            }
        };
        let values = &mut table_entry.metadata[position].1;
        if let Some(existing) = values
            .iter_mut()
            .find(|meta| equals_ignore_case(&meta.id, &new.id))
        {
            if existing.value == new.value {
                existing.editor_only &= new.editor_only;
            } else {
                diagnostics.push(CodeDiagnostic::new(
					&at_file,
					at_line,
					DiagnosticCode::TableMetadataRedefined,
					format!(
						"String Table '{}' entry '{}' metadata '{}' is already defined at {}; this one is ignored.",
						narrow(table),
						narrow(key),
						narrow(&new.id),
						existing.location.label(engine)
					),
				));
            }
            return;
        }
        values.push(new);
    }

    pub(crate) fn apply(
        &mut self,
        call: &TableCall,
        engine: EngineLine,
        csv_source: &dyn CsvSource,
        split_platform: &dyn Fn(&str) -> Option<String>,
        diagnostics: &mut Vec<CodeDiagnostic>,
    ) {
        let here = Location {
            file: call.file.clone(),
            line: Some(call.line),
        };
        match &call.op {
            TableOp::Register { table, namespace } => {
                self.register(call, table, namespace, diagnostics, engine);
            }
            TableOp::RegisterFromFile {
                table,
                namespace,
                path,
                root,
                macro_name,
            } => {
                if !self.register(call, table, namespace, diagnostics, engine) {
                    return;
                }
                let path_text = narrow(path);
                let imported = csv_source
                    .read_csv(*root, &path_text)
                    .and_then(|text| import_csv(&text, engine));
                let Some(rows) = imported else {
                    diagnostics.push(CodeDiagnostic::new(
                        &call.file,
                        Some(call.line),
                        DiagnosticCode::TableImportFailed,
                        format!(
                            "String Table '{}' could not import '{path_text}'.",
                            narrow(table)
                        ),
                    ));
                    return;
                };
                let location = Location {
                    file: path_text.clone(),
                    line: None,
                };
                let platform = split_platform(&path_text);
                for row in rows {
                    self.add_entry(
                        table,
                        Entry {
                            key: row.key.clone(),
                            source: row.source,
                            dev_notes: row.dev_notes,
                            location: location.clone(),
                            platform: platform.clone(),
                            editor_only: call.editor_only,
                            macro_name: macro_name.clone(),
                        },
                        diagnostics,
                        engine,
                    );
                    for (id, value) in row.metadata {
                        self.add_meta(
                            table,
                            &row.key,
                            Meta {
                                id,
                                value,
                                location: location.clone(),
                                editor_only: call.editor_only,
                            },
                            diagnostics,
                            engine,
                        );
                    }
                }
            }
            TableOp::Entry {
                table,
                key,
                source,
                dev_notes,
                macro_name,
            } => {
                self.add_entry(
                    table,
                    Entry {
                        key: key.clone(),
                        source: source.clone(),
                        dev_notes: dev_notes.clone(),
                        location: here,
                        platform: call.platform.clone(),
                        editor_only: call.editor_only,
                        macro_name: macro_name.clone(),
                    },
                    diagnostics,
                    engine,
                );
            }
            TableOp::Meta {
                table,
                key,
                id,
                value,
            } => {
                self.add_meta(
                    table,
                    key,
                    Meta {
                        id: id.clone(),
                        value: value.clone(),
                        location: here,
                        editor_only: call.editor_only,
                    },
                    diagnostics,
                    engine,
                );
            }
        }
    }

    /// The registered tables' entries as places; unregistered tables become diagnostics.
    pub(crate) fn places(
        self,
        engine: EngineLine,
        gather_editor_only: bool,
        places: &mut Vec<CodePlace>,
        diagnostics: &mut Vec<CodeDiagnostic>,
        unregistered_file: &str,
    ) {
        for table in self.tables {
            if table.registered.is_none() {
                if !table.entries.is_empty() || !table.metadata.is_empty() {
                    let (code, message) = if engine == EngineLine::Ue4_27 {
                        (
                            DiagnosticCode::CrashesUnreal427,
                            format!(
                                "String Table '{}' has {} entries but is never registered. UE 4.27's gather crashes on this.",
                                narrow(&table.id),
                                table.entries.len()
                            ),
                        )
                    } else {
                        (
                            DiagnosticCode::TableNotRegistered,
                            format!(
                                "String Table '{}' has {} entries but is never registered; they are not gathered.",
                                narrow(&table.id),
                                table.entries.len()
                            ),
                        )
                    };
                    let file = table
                        .entries
                        .first()
                        .map_or(unregistered_file, |entry| entry.location.file.as_str());
                    let line = table.entries.first().and_then(|entry| entry.location.line);
                    diagnostics.push(CodeDiagnostic::new(file, line, code, message));
                }
                continue;
            }
            for entry in table.entries {
                let metadata = table
                    .metadata
                    .iter()
                    .find(|(key, _)| equals_ignore_case(key, &entry.key))
                    .map(|(_, values)| {
                        values
                            .iter()
                            .filter(|meta| !meta.editor_only || gather_editor_only)
                            .map(|meta| MetadataField {
                                name: narrow(&meta.id),
                                value: narrow(&meta.value),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                places.push(CodePlace {
                    file: entry.location.file,
                    line: entry.location.line,
                    macro_name: narrow(&entry.macro_name),
                    wrapper: None,
                    namespace: narrow(&table.namespace),
                    key: narrow(&entry.key),
                    source: narrow(&entry.source),
                    dev_notes: (!entry.dev_notes.is_empty()).then(|| narrow(&entry.dev_notes)),
                    metadata,
                    editor_only: entry.editor_only,
                    gathered: !entry.editor_only || gather_editor_only,
                    platform: entry.platform,
                    table: Some(narrow(&table.id)),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_a_csv_with_extra_columns_and_repeated_keys() {
        let text = wide(
            "Key,SourceString,Comment,DevNotes\nLamp,Lamp oil,Fuel,For the lamp\nlamp,Lamp oil again,,\n",
        );
        let rows = import_csv(&text, EngineLine::Ue5_8).unwrap_or_default();
        assert_eq!(rows.len(), 1);
        assert_eq!(narrow(&rows[0].key), "lamp");
        assert_eq!(narrow(&rows[0].source), "Lamp oil again");
        assert_eq!(rows[0].metadata.len(), 1);
        let older = import_csv(&text, EngineLine::Ue5_7).unwrap_or_default();
        assert_eq!(older[0].metadata.len(), 2);
    }
}
