//! Interactive localization detail: select and page evidence before crossing the process boundary.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_query::selected_bits;
use crate::engine_types::{
    FocusRequest, LocalizationDetailRequest, LocalizationScope, MAX_PAGE, PROBLEMS,
};
use crate::{Result, require};
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

impl EngineQuery {
    pub fn localization_detail_json(
        &self,
        payload: &str,
        cancelled: &AtomicBool,
    ) -> Result<String> {
        let request = crate::engine_types::parse_detail_request(payload)?;
        let result = self.localization_detail(&request, cancelled)?;
        crate::wtf8::view_json(&result)
    }

    pub fn localization_detail(
        &self,
        request: &LocalizationDetailRequest,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        checkpoint(cancelled)?;
        if self.target["name"] != request.target {
            return Ok(Value::Null);
        }
        let id = if request.selection.kind == "unit" {
            let focus = self.focus(
                &FocusRequest {
                    id: request.selection.id.clone(),
                    page_size: 1,
                    occurrence_cursor: None,
                    localization: None,
                    findings: None,
                },
                cancelled,
            )?;
            match focus["localization"]["id"].as_str() {
                Some(id) => id.to_owned(),
                None => return Ok(Value::Null),
            }
        } else {
            request.selection.id.clone()
        };
        let Some(row) = self.find_id("line", &id)? else {
            return Ok(Value::Null);
        };
        let p = Projection::open(self, cancelled)?;
        let preview = self.preview(row)?;
        let mut result = json!({"id":preview["id"],"origin":preview["origin"],"identity":preview["identity"],"source":preview["source"]});
        // The line's problems and findings in the list's culture scope, as the list's row
        // computes them.
        let scope = self.culture_scope(Some(&LocalizationScope {
            target: request.target.clone(),
            culture: request.culture.clone(),
            cultures: request.cultures.clone(),
            state: None,
            review: None,
            key_changed: None,
            search_translations: None,
        }))?;
        let findings = match &request.findings {
            Some(selection) => Some(self.finding_rows(selection, true, &scope, cancelled)?),
            None => None,
        };
        let finding = findings
            .as_ref()
            .is_some_and(|findings| findings.counted.contains(row));
        result["problems"] = json!(selected_bits(&PROBLEMS, p.problem(row, &scope, finding)));
        if let Some(findings) = &findings {
            crate::engine_search::list_findings(&mut result, findings, row);
        }
        if let Some(change) = preview.get("keyChange") {
            result["keyChange"] = change.clone();
        }
        let begin = p.manifest_start[row] as usize;
        let end = p.manifest_end[row] as usize;
        let location_offset = request.location_offset.unwrap_or(0).min(end - begin);
        let location_end = end.min(begin + location_offset + MAX_PAGE);
        let mut locations = Vec::new();
        let mut notes = Vec::new();
        let mut source = preview["source"].clone();
        if begin < end {
            let name = self.target["outputPaths"]["manifest"]
                .as_str()
                .ok_or("Missing manifest input.")?
                .to_owned();
            source =
                self.evidence_entry(&name, p.manifest[begin] as usize)?["source"]["Text"].clone();
            for index in begin + location_offset..location_end {
                checkpoint(cancelled)?;
                let entry = self.evidence_entry(&name, p.manifest[index] as usize)?;
                locations.push(entry["path"].clone());
                let dev = entry["devNotes"].as_str().unwrap_or("");
                let comment = entry["metadata"]["Info"]["Comment"].as_str().unwrap_or("");
                for (index, note) in [dev, comment].into_iter().enumerate() {
                    if notes.len() < MAX_PAGE
                        && !crate::join_policy::trim(note).is_empty()
                        && !(index == 1 && note == dev)
                    {
                        notes.push(json!(note));
                    }
                }
            }
        }
        result["locations"] = json!(locations);
        result["translatorNotes"] = json!(notes);
        result["totalLocations"] = json!(end - begin);
        if location_end < end {
            result["nextLocationOffset"] = json!(location_end - begin);
        }
        let native = self.target["nativeCulture"].as_str();
        let mut cultures = (0..self.cultures.len()).collect::<Vec<_>>();
        cultures.sort_by_key(|ci| Some(self.cultures[*ci].as_str()) != native);
        let offset = request.culture_offset.unwrap_or(0).min(cultures.len());
        let culture_end = cultures.len().min(offset + MAX_PAGE);
        let context = request.po_context_offset.unwrap_or(0);
        let mut translations = Vec::new();
        for ci in &cultures[offset..culture_end] {
            checkpoint(cancelled)?;
            let ci = *ci;
            let mut mark = self.culture_mark(ci, row)?;
            let mut evidence = [Value::Null, Value::Null];
            for (index, (field, paths)) in [("archive", "archives"), ("po", "portableObjects")]
                .iter()
                .enumerate()
            {
                let entry = self.reader.value(&format!("c{ci}.{field}"), row)?;
                if entry != 0 {
                    let name = self.target["outputPaths"][paths][&self.cultures[ci]]
                        .as_str()
                        .ok_or("Missing culture evidence.")?
                        .to_owned();
                    evidence[index] = self.evidence_entry(&name, (entry - 1) as usize)?;
                }
            }
            let [archive, po] = evidence;
            let state = mark["state"]
                .as_str()
                .ok_or("Missing culture state.")?
                .to_owned();
            let facts = mark["facts"].as_array().ok_or("Missing culture facts.")?;
            let fact = |state: &str| facts.iter().any(|value| value == state);
            let (game, kind) =
                if state == "needs_update" || (state == "not_synced" && fact("needs_update")) {
                    (source.clone(), "source_outdated")
                } else if state == "not_translated"
                    || (state == "not_synced"
                        && archive["translation"]["Text"]
                            .as_str()
                            .unwrap_or("")
                            .is_empty())
                {
                    (source.clone(), "source_untranslated")
                } else if state == "translated" || state == "not_synced" {
                    (archive["translation"]["Text"].clone(), "translation")
                } else {
                    (Value::Null, "unavailable")
                };
            let culture_state = [
                "unknown",
                "not_synced",
                "needs_update",
                "not_translated",
                "translated",
            ]
            .into_iter()
            .find(|state| fact(state));
            let po_text = po["msgstr"]["0"].as_str().unwrap_or("");
            let po_translation = if fact("not_synced")
                && !po_text.is_empty()
                && po_text != archive["translation"]["Text"].as_str().unwrap_or("")
            {
                json!(po_text)
            } else {
                Value::Null
            };
            mark.as_object_mut()
                .ok_or("Invalid culture mark.")?
                .remove("translation");
            mark["gameTranslation"] = game;
            mark["gameTextKind"] = json!(kind);
            mark["archiveTranslation"] = archive["translation"]["Text"].clone();
            mark["translationSource"] = archive["source"]["Text"].clone();
            mark["cultureState"] = json!(culture_state);
            mark["poTranslation"] = po_translation;
            let mut maximum = 0;
            for (field, remaining) in [
                ("translatorComments", "remainingComments"),
                ("flags", "remainingFlags"),
            ] {
                let values = po[field].as_array().map(Vec::as_slice).unwrap_or(&[]);
                maximum = maximum.max(values.len());
                mark[field] = json!(
                    &values[context.min(values.len())
                        ..values.len().min(context.saturating_add(MAX_PAGE))]
                );
                mark[remaining] = json!(
                    values
                        .len()
                        .saturating_sub(context.saturating_add(MAX_PAGE))
                );
            }
            if maximum > context.saturating_add(MAX_PAGE) {
                mark["nextContextOffset"] = json!(context + MAX_PAGE);
            }
            translations.push(mark);
        }
        result["translations"] = json!(translations);
        result["totalCultures"] = json!(cultures.len());
        if culture_end < cultures.len() {
            result["nextCultureOffset"] = json!(culture_end);
        }
        if let Some(first) = preview["cultures"]
            .as_array()
            .and_then(|values| values.first())
        {
            let state = first["state"].as_str().ok_or("Missing culture state.")?;
            if preview["cultures"]
                .as_array()
                .ok_or("Missing cultures.")?
                .iter()
                .all(|mark| mark["state"] == state)
            {
                let target = &request.target;
                let message = match state {
                    "outside_target" => Some(format!("Not part of {target}: its asset is excluded by the target's gather settings.")),
                    "not_gathered" => Some(format!("Not gathered yet: this line is inside {target}, but is missing from its gathered text.")),
                    "changed_since_gather" => Some(format!("Changed since gather: the project's source text differs from the text gathered for {target}.")),
                    "not_found" => Some("Not found in the project: its saved asset was fully read, but this key was not found.".into()),
                    "gathered_only" => Some("Gathered only: this line comes from source code or another file the asset scan does not read.".into()),
                    _ => None,
                };
                if let Some(message) = message {
                    result["scopeSummary"] = json!({"state":state,"message":message});
                }
            }
        }
        require(result.is_object(), "Invalid localization detail.")?;
        Ok(result)
    }
}
