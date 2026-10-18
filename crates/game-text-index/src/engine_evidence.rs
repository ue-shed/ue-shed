//! Hydrate selected localization evidence in Rust; entry decoding never runs in the host.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_types::MAX_PAGE;
use crate::{Result, require};
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

impl EngineQuery {
    pub fn localization_focus_json(
        &mut self,
        payload: &str,
        cancelled: &AtomicBool,
    ) -> Result<String> {
        let id = crate::json_value::parse(payload)?;
        let id = id
            .as_str()
            .ok_or_else(|| crate::engine_types::invalid("A localization line ID is required."))?;
        let result = match self.find_id("line", id)? {
            Some(row) => self.localization_line(row, cancelled)?,
            None => Value::Null,
        };
        crate::wtf8::view_json(&result)
    }
    fn entry_text(&mut self, name: &str, field: &str, row: usize) -> Result<String> {
        let ids = self.reader.input_column(name, &format!("entry.{field}"))?;
        self.reader
            .string(*ids.get(row).ok_or("Evidence row outside input.")?)
    }
    fn entry_json(&mut self, name: &str, field: &str, row: usize) -> Result<Value> {
        let text = self.entry_text(name, field, row)?;
        if text.is_empty() {
            return Ok(json!({}));
        }
        let value = crate::json_value::parse_stored(&text)?;
        require(
            value.is_object(),
            "Stored evidence extras must be an object.",
        )?;
        Ok(value)
    }
    pub fn evidence_entry(&mut self, name: &str, row: usize) -> Result<Value> {
        let meta = self.reader.input_metadata(name, "file.meta")?;
        let format = meta["format"].as_str().ok_or("Missing evidence format.")?;
        let options = self.reader.input_column(name, "entry.options")?;
        let flags = *options.get(row).ok_or("Evidence row outside options.")?;
        let namespace = self.entry_text(name, "namespace", row)?;
        let key = self.entry_text(name, "key", row)?;
        let source = self.entry_text(name, "source", row)?;
        let path = format!(
            "{}{}",
            if flags & 1024 != 0 {
                meta["pathPrefix"].as_str().unwrap_or("")
            } else {
                ""
            },
            self.entry_text(name, "path", row)?
        );
        let mut result = if format == "po" {
            let extra = self.entry_json(name, "po-extra", row)?;
            let mut msgstr = extra.get("msgstr").cloned().unwrap_or(json!({}));
            require(msgstr.is_object(), "Invalid stored PO translations.")?;
            if flags & 64 != 0 {
                msgstr["0"] = json!(if flags & 128 != 0 {
                    source.clone()
                } else {
                    self.entry_text(name, "translation", row)?
                });
            }
            let mut extracted = extra
                .get("extractedComments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut references = extra
                .get("referenceComments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if flags & 256 != 0 {
                extracted.insert(0, json!(format!("Key: {key}")));
            }
            if flags & 512 != 0 {
                references.insert(0, json!(path));
            }
            let mut result = json!({"msgid":source,"msgstr":msgstr,"translatorComments":extra.get("translatorComments").cloned().unwrap_or(json!([])),"extractedComments":extracted,"referenceComments":references,"flags":extra.get("flags").cloned().unwrap_or(json!([])),"previousMsgidLines":extra.get("previousMsgidLines").cloned().unwrap_or(json!([])),"identity":if flags&16!=0 {Value::Null} else {json!({"namespace":namespace,"key":key})}});
            if flags & 32 != 0 {
                result["msgctxt"] = json!(format!(
                    "{},{}",
                    namespace.replace(',', "\\,"),
                    key.replace(',', "\\,")
                ));
            } else if let Some(context) = extra.get("msgctxt") {
                result["msgctxt"] = context.clone();
            }
            if let Some(plural) = extra.get("msgidPlural") {
                result["msgidPlural"] = plural.clone();
            }
            result
        } else {
            require(
                format == "manifest" || format == "archive",
                "Unknown stored evidence format.",
            )?;
            let mut text = self.entry_json(name, "source-extra", row)?;
            text["Text"] = json!(source);
            let mut result = json!({"namespace":namespace,"key":key,"source":text});
            if format == "manifest" {
                result["path"] = json!(path);
                if flags & 4 != 0 {
                    result["devNotes"] = json!(self.entry_text(name, "notes", row)?);
                }
            } else {
                let mut translation = self.entry_json(name, "translation-extra", row)?;
                translation["Text"] = json!(if flags & 128 != 0 {
                    source
                } else {
                    self.entry_text(name, "translation", row)?
                });
                result["translation"] = translation;
            }
            if flags & 1 != 0 {
                result["optional"] = json!(flags & 2 != 0);
            }
            if flags & 8 != 0 {
                result["metadata"] = self.entry_json(name, "metadata", row)?;
            }
            result
        };
        // Keep the public parser's object shape; PO-only fields never bleed into JSON entries.
        require(result.is_object(), "Invalid evidence object.")?;
        Ok(std::mem::take(&mut result))
    }
    pub fn localization_line(&mut self, row: usize, cancelled: &AtomicBool) -> Result<Value> {
        checkpoint(cancelled)?;
        let p = Projection::open(self, cancelled)?;
        require(row < p.source.len(), "Localization row outside index.")?;
        let mut result = self.preview(row)?;
        result
            .as_object_mut()
            .ok_or("Invalid line preview.")?
            .remove("manifestLocations");
        result
            .as_object_mut()
            .ok_or("Invalid line preview.")?
            .remove("remainingLocationCount");
        let begin = p.manifest_start[row] as usize;
        let end = p.manifest_end[row] as usize;
        let mut manifest = Vec::new();
        if begin != end {
            let name = self.target["outputPaths"]["manifest"]
                .as_str()
                .ok_or("Missing manifest input.")?
                .to_owned();
            for (index, entry) in p.manifest[begin..end].iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                manifest.push(self.evidence_entry(&name, *entry as usize)?);
            }
        }
        result["manifest"] = json!(manifest);
        let mut cultures = Vec::new();
        for ci in 0..self.cultures.len() {
            checkpoint(cancelled)?;
            let mut mark = self.culture_mark(ci, row)?;
            let culture = self.cultures[ci].clone();
            for (field, path_field) in [("archive", "archives"), ("po", "portableObjects")] {
                let entry = self.reader.value(&format!("c{ci}.{field}"), row)?;
                mark[field] = if entry == 0 {
                    Value::Null
                } else {
                    let name = self.target["outputPaths"][path_field][&culture]
                        .as_str()
                        .ok_or("Missing translation input.")?
                        .to_owned();
                    self.evidence_entry(&name, (entry - 1) as usize)?
                };
            }
            mark.as_object_mut()
                .ok_or("Invalid culture mark.")?
                .remove("translation");
            mark["poTranslation"] = if p.cultures[ci].facts[row] & 8 != 0 {
                mark["po"]["msgstr"].get("0").cloned().unwrap_or(json!(""))
            } else {
                Value::Null
            };
            cultures.push(mark);
        }
        result["cultures"] = json!(cultures);
        Ok(result)
    }
    pub fn localization_page(
        &mut self,
        request: &crate::engine_types::SearchRequest,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        require(
            request.localization.is_some(),
            crate::engine_types::invalid("Localization evidence requires a selected target."),
        )?;
        let rows = self.matching(request, cancelled)?;
        let start = if let Some(cursor) = &request.localization_cursor {
            let row = self.find_id("line", cursor)?;
            row.and_then(|row| rows.iter().position(|value| *value as usize == row))
                .map_or(0, |index| index + 1)
        } else {
            0
        };
        let end = rows.len().min(start + request.page_size.min(MAX_PAGE));
        let mut entries = Vec::new();
        for row in &rows[start..end] {
            entries.push(self.localization_line(*row as usize, cancelled)?);
        }
        let mut result = json!({"lines":entries,"total":rows.len()});
        if end < rows.len() {
            result["nextCursor"] = json!(self.packed("line", rows[end - 1] as usize)?);
        }
        Ok(result)
    }
}
