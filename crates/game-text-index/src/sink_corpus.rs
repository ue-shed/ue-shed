//! `corpusCsv` (Phase 4 §8): Browse's CSV, a row per saved place of each selected unit with
//! searchable source, byte-identical to the host's `gameTextCsv`.
use crate::Result;
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::engine_types::Selection;
use crate::join_policy::{characters, trim, words};
use crate::sink::{Cell, Envelope, JsonArray, SinkWriter, Spreadsheet};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn signal_label(signal: &str) -> &'static str {
    match signal {
        "unresolved" => "not localizable",
        "conflicting" => "key has different text",
        "evidence_only" => "read only",
        "compiled_copy_differs" => "Blueprint not compiled since edit",
        _ => "",
    }
}

fn audience_label(audience: &str) -> &'static str {
    match audience {
        "player" => "Player text",
        "editor" => "Editor text",
        _ => "Unknown",
    }
}

fn location_label(kind: &str) -> &'static str {
    match kind {
        "data_table_cell" => "Data table cell",
        "string_table_entry" => "String table entry",
        "code_place" => "Code",
        _ => "Asset property",
    }
}

/// The Content Browser's name for an object path: its leaf's last dotted part.
fn asset_name(object_path: &str) -> &str {
    let leaf = object_path.rsplit('/').next().unwrap_or(object_path);
    leaf.rsplit('.').next().unwrap_or(leaf)
}

/// Empty text is implementation noise, not searchable game text.
fn searchable(unit: &Value) -> bool {
    let source = &unit["source"];
    match source["status"].as_str() {
        Some("consistent") => !trim(text(&source["value"])).is_empty(),
        _ => source["values"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| !trim(text(value)).is_empty())),
    }
}

/// A value with the members its schema names, in their order; absent ones stay absent.
fn shaped(value: &Value, members: &[&str]) -> Value {
    let mut out = Map::new();
    for member in members {
        if let Some(item) = value.get(*member) {
            out.insert((*member).into(), item.clone());
        }
    }
    Value::Object(out)
}

/// A text identity in `TextIdentity`'s order for its status.
fn identity(value: &Value) -> Value {
    shaped(
        value,
        match value["status"].as_str() {
            Some("resolved") => &["status", "namespace", "key"],
            Some("string_table") => &["status", "tableId", "key"],
            _ => &["status", "reason"],
        },
    )
}

/// A saved place's occurrence in `TextOccurrence`'s order, its identity, location and copies
/// in theirs.
fn occurrence(value: &Value) -> Value {
    let mut out = shaped(
        value,
        &[
            "devNotes",
            "id",
            "packageFile",
            "source",
            "identity",
            "location",
            "editCapability",
            "audience",
            "audienceReason",
            "audienceRule",
            "copies",
        ],
    );
    out["identity"] = identity(&value["identity"]);
    out["location"] = shaped(
        &value["location"],
        match value["location"]["kind"].as_str() {
            Some("data_table_cell") => &["kind", "objectPath", "row", "propertyPath"],
            Some("string_table_entry") => &["kind", "objectPath", "entryKey"],
            Some("code_place") => &["kind", "file", "line", "macro", "wrapper", "table"],
            _ => &["kind", "objectPath", "classPath", "propertyPath"],
        },
    );
    if let Some(copies) = value["copies"].as_array() {
        out["copies"] = Value::Array(
            copies
                .iter()
                .map(|copy| shaped(copy, &["objectPath", "kind", "source"]))
                .collect(),
        );
    }
    out
}

impl EngineQuery {
    /// Writes the selection's units in a corpus report's envelope, each in `TextUnit`'s order
    /// with its occurrences.
    pub(crate) fn write_corpus_json(
        &self,
        request: &Selection,
        envelope: &Envelope,
        sink: &mut SinkWriter,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let (p, chosen) = self.chosen_units(request, false, None, cancelled)?;
        let mut array = JsonArray::open(sink, envelope)?;
        for (index, row) in p.raw.order.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            if !chosen[row] {
                continue;
            }
            let unit = self.presentation("raw", row)?;
            let mut out = shaped(&unit, &["id", "source", "identity"]);
            out["source"] = shaped(
                &unit["source"],
                match unit["source"]["status"].as_str() {
                    Some("consistent") => &["status", "value"],
                    _ => &["status", "values"],
                },
            );
            out["identity"] = identity(&unit["identity"]);
            out["occurrences"] = Value::Array(
                p.raw
                    .members(row)
                    .iter()
                    .map(|member| Ok(occurrence(&self.occurrence(*member as usize, cancelled)?)))
                    .collect::<Result<_>>()?,
            );
            array.push(&out)?;
        }
        array.close()
    }

    /// Writes the selection's units as Browse's CSV. With a findings layer, a Findings column
    /// lists each unit's rules by label, as many as a listed row shows.
    pub(crate) fn write_corpus_csv(
        &self,
        request: &Selection,
        sink: &mut SinkWriter,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let (p, chosen) = self.chosen_units(request, false, None, cancelled)?;
        let findings = self.export_findings(request, cancelled)?;
        let labels = findings.as_ref().map(|findings| {
            findings
                .rules
                .iter()
                .map(|rule| (rule.id.as_str(), rule.label.as_str()))
                .collect::<HashMap<_, _>>()
        });
        let mut out = Spreadsheet::BOM.to_vec();
        let mut header = vec![
            "Source",
            "Translator notes",
            "Key",
            "Namespace / string table",
            "Localization",
            "Location type",
            "Asset",
            "Row / entry",
            "Property",
            "Editable",
            "Characters",
            "Words",
            "Review signals",
        ];
        if findings.is_some() {
            header.push("Findings");
        }
        header.extend(["Audience", "Text unit ID", "Package file"]);
        Spreadsheet::row(
            &mut out,
            &header.into_iter().map(Cell::Text).collect::<Vec<_>>(),
        );
        sink.write(&out)?;
        for (index, row) in p.raw.order.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            if !chosen[row] {
                continue;
            }
            let mut unit = self.presentation("raw", row)?;
            if !searchable(&unit) {
                continue;
            }
            let signals = unit["reviewSignals"]
                .as_array()
                .ok_or("An exported unit has no review signals.")?
                .iter()
                .map(text)
                .filter(|signal| *signal != "evidence_only")
                .map(signal_label)
                .collect::<Vec<_>>()
                .join("; ");
            let rules = match (&findings, &labels) {
                (Some(findings), Some(labels)) => {
                    crate::engine_search::list_findings(&mut unit, findings, row);
                    Some(
                        unit["findings"]
                            .as_array()
                            .map(|rules| {
                                rules
                                    .iter()
                                    .map(|rule| {
                                        let rule = text(rule);
                                        labels.get(rule).copied().unwrap_or(rule)
                                    })
                                    .collect::<Vec<_>>()
                                    .join("; ")
                            })
                            .unwrap_or_default(),
                    )
                }
                _ => None,
            };
            let id = text(&unit["id"]);
            for member in p.raw.members(row) {
                let occurrence = self.occurrence(*member as usize, cancelled)?;
                let source = text(&occurrence["source"]);
                let identity = &occurrence["identity"];
                let (key, scope) = match identity["status"].as_str() {
                    Some("resolved") => (
                        text(&identity["key"]),
                        match text(&identity["namespace"]) {
                            "" => "global",
                            namespace => namespace,
                        },
                    ),
                    Some("string_table") => (text(&identity["key"]), text(&identity["tableId"])),
                    _ => ("", ""),
                };
                let localization = match (identity["status"].as_str(), text(&identity["reason"])) {
                    (Some("unresolved"), "culture_invariant") => {
                        "Not localized (culture invariant)"
                    }
                    (Some("unresolved"), _) => "Missing localization key",
                    _ => "Localizable",
                };
                let location = &occurrence["location"];
                let kind = text(&location["kind"]);
                // A code place's file names its asset column, its line the entry, its macro the
                // property.
                let line = location["line"]
                    .as_u64()
                    .map_or_else(String::new, |line| line.to_string());
                let entry = match kind {
                    "data_table_cell" => text(&location["row"]),
                    "string_table_entry" => text(&location["entryKey"]),
                    "code_place" => &line,
                    _ => "",
                };
                let property = match kind {
                    "string_table_entry" => "",
                    "code_place" => text(&location["macro"]),
                    _ => text(&location["propertyPath"]),
                };
                let object = if kind == "code_place" {
                    let file = text(&location["file"]);
                    file.rsplit(['/', '\\']).next().unwrap_or(file)
                } else {
                    asset_name(text(&location["objectPath"]))
                };
                let length = characters(source).to_string();
                let count = words(source).to_string();
                let mut cells = vec![
                    Cell::Text(source),
                    Cell::Text(text(&occurrence["devNotes"])),
                    Cell::Text(key),
                    Cell::Text(scope),
                    Cell::Text(localization),
                    Cell::Text(location_label(kind)),
                    Cell::Text(object),
                    Cell::Text(entry),
                    Cell::Text(property),
                    Cell::Text(
                        if text(&occurrence["editCapability"]) == "source_editable" {
                            "Yes"
                        } else {
                            "No"
                        },
                    ),
                    Cell::Text(&length),
                    Cell::Text(&count),
                    Cell::Text(&signals),
                ];
                if let Some(rules) = &rules {
                    cells.push(Cell::Text(rules));
                }
                cells.extend([
                    Cell::Text(audience_label(text(&occurrence["audience"]))),
                    Cell::Text(id),
                    Cell::Text(text(&occurrence["packageFile"])),
                ]);
                out.clear();
                Spreadsheet::row(&mut out, &cells);
                sink.write(&out)?;
                sink.row();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_and_searchable_sources_follow_the_host() {
        assert_eq!(asset_name("/Game/UI/W_Shop.W_Shop:WidgetTree.Name"), "Name");
        assert_eq!(asset_name("Plain"), "Plain");
        assert!(searchable(
            &serde_json::json!({"source": {"status": "consistent", "value": " a"}})
        ));
        assert!(!searchable(
            &serde_json::json!({"source": {"status": "consistent", "value": " \u{a0}"}})
        ));
        assert!(searchable(
            &serde_json::json!({"source": {"status": "variants", "values": ["", "b"]}})
        ));
    }
}
