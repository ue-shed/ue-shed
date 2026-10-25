//! The all-languages CSV (`cultureLinesCsv`): a row per matching line and, for the native culture
//! first and then the target's culture order, the translation that ships next and its state.
use crate::Result;
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::engine_types::{ORIGINS, Selection};
use crate::sink::{Cell, SinkWriter, Spreadsheet};
use serde_json::Value;
use std::sync::atomic::AtomicBool;

/// The line fields the CSV reads.
const FIELDS: [&str; 7] = [
    "origin", "identity", "source", "manifest", "audience", "marks", "places",
];

const ORIGIN_LABELS: [&str; 5] = ["String table", "Data table", "Asset", "C++", "Other source"];

fn origin_label(origin: &str) -> &'static str {
    ORIGINS
        .iter()
        .position(|value| *value == origin)
        .map_or("", |index| ORIGIN_LABELS[index])
}

fn audience_label(audience: &str) -> &'static str {
    match audience {
        "player" => "Player text",
        "editor" => "Editor text",
        _ => "Unknown",
    }
}

fn state_label(state: &str) -> &'static str {
    match state {
        "translated" => "Translated",
        "not_translated" => "Not translated",
        "needs_update" => "Needs update",
        "not_synced" => "Not synced",
        "not_gathered" => "Not gathered yet",
        "changed_since_gather" => "Changed since gather",
        "not_found" => "Not found in the project",
        "gathered_only" => "Gathered only",
        "outside_target" => "Outside this target",
        _ => "Unknown",
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// The distinct values, in first-seen order.
fn distinct<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

impl EngineQuery {
    /// Writes the selection's lines as the all-languages CSV. The selection's culture, or its
    /// cultures, limit the columns to the native culture and those.
    pub(crate) fn write_culture_lines(
        &self,
        selection: &Selection,
        sink: &mut SinkWriter,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let rows = self.matching(selection, cancelled)?;
        // Only the sort keys are held: each line's fields are read again as its row is written,
        // so the engine never holds the selection's lines. Code-unit order is the same on every
        // machine, unlike locale collation; a line without an identity sorts after every
        // namespace.
        let mut keyed = Vec::with_capacity(rows.len());
        for row in rows.iter() {
            checkpoint(cancelled)?;
            let line = self.localization_line_fields(
                *row as usize,
                &["identity", "source"],
                &[],
                None,
                cancelled,
            )?;
            let (namespace, key) = match line["identity"].as_object() {
                Some(identity) => (
                    text(&identity["namespace"]).to_owned(),
                    text(&identity["key"]).to_owned(),
                ),
                None => ("\u{ffff}".into(), String::new()),
            };
            keyed.push((namespace, key, text(&line["source"]).to_owned(), *row));
        }
        keyed.sort_by(|(a_ns, a_key, a_source, _), (b_ns, b_key, b_source, _)| {
            crate::join::ordinal(a_ns, b_ns)
                .then_with(|| crate::join::ordinal(a_key, b_key))
                .then_with(|| crate::join::ordinal(a_source, b_source))
        });
        let picked = selection
            .cultures
            .clone()
            .or_else(|| selection.culture.clone().map(|culture| vec![culture]))
            .filter(|picked| !picked.is_empty());
        let native = self.target["nativeCulture"].as_str();
        let cultures = self
            .cultures
            .iter()
            .filter(|culture| Some(culture.as_str()) == native)
            .chain(self.cultures.iter().filter(|culture| {
                Some(culture.as_str()) != native
                    && picked
                        .as_ref()
                        .is_none_or(|picked| picked.contains(culture))
            }))
            .cloned()
            .collect::<Vec<_>>();
        let mut out = Spreadsheet::BOM.to_vec();
        let states = cultures
            .iter()
            .map(|culture| format!("{culture} state"))
            .collect::<Vec<_>>();
        let mut header = ["Namespace", "Key", "Source", "Where", "Kind", "Audience"]
            .map(Cell::Text)
            .into_iter()
            .collect::<Vec<_>>();
        for (culture, state) in cultures.iter().zip(&states) {
            header.push(Cell::Text(culture));
            header.push(Cell::Text(state));
        }
        Spreadsheet::row(&mut out, &header);
        sink.write(&out)?;
        for (_, _, _, row) in keyed {
            checkpoint(cancelled)?;
            let line =
                self.localization_line_fields(row as usize, &FIELDS, &[], None, cancelled)?;
            let manifest = line["manifest"].as_array().map_or(&[][..], Vec::as_slice);
            let places = line["places"].as_array().map_or(&[][..], Vec::as_slice);
            let paths = if manifest.is_empty() {
                distinct(places.iter().map(|place| text(&place["objectPath"])))
            } else {
                distinct(manifest.iter().map(|entry| text(&entry["path"])))
            };
            let place = match paths.as_slice() {
                [] => String::new(),
                [only] => (*only).to_owned(),
                [first, rest @ ..] => format!("{first} (+{})", rest.len()),
            };
            let kinds = if line["origin"]["kind"] == "corpus" {
                distinct(places.iter().map(|place| text(&place["origin"])))
                    .into_iter()
                    .map(origin_label)
                    .collect::<Vec<_>>()
            } else {
                distinct(manifest.iter().map(|entry| {
                    ORIGINS[crate::join_policy::origin(text(&entry["path"])) as usize]
                }))
                .into_iter()
                .map(origin_label)
                .collect()
            }
            .join(", ");
            let source = manifest
                .first()
                .and_then(|entry| entry["source"]["Text"].as_str())
                .unwrap_or_else(|| text(&line["source"]));
            let identity = line["identity"].as_object();
            let field = |name: &str| identity.map_or("", |identity| text(&identity[name]));
            let marks = line["marks"].as_array().map_or(&[][..], Vec::as_slice);
            let mut cells = vec![
                Cell::Text(field("namespace")),
                Cell::Text(field("key")),
                Cell::Text(source),
                Cell::Text(&place),
                Cell::Text(&kinds),
                Cell::Text(audience_label(text(&line["audience"]))),
            ];
            for culture in &cultures {
                match marks.iter().find(|mark| text(&mark["culture"]) == culture) {
                    Some(mark) => {
                        cells.push(Cell::Text(text(&mark["translation"])));
                        cells.push(Cell::Text(state_label(text(&mark["state"]))));
                    }
                    None => cells.extend([Cell::Text(""), Cell::Text("")]),
                }
            }
            out.clear();
            Spreadsheet::row(&mut out, &cells);
            sink.write(&out)?;
            sink.row();
        }
        Ok(())
    }
}
