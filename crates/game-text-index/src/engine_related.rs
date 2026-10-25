//! Related lines: a selection's units or lines that share its key, its text, its key's conflicting
//! sources or its key change, each with the evidence a review of them reads, in one request.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_types::{DetailSelection, FocusRequest, LocalizationDetailRequest};
use crate::{Error, ErrorCode, Result, require};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// Members one section lists.
const MAX_MEMBERS: usize = 50;
/// Places one unit member lists, and unit IDs one line member lists.
const MAX_PAGE: usize = 50;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelatedRequest {
    /// The localization target whose lines and translations the sections read.
    target: Option<String>,
    selection: DetailSelection,
    /// Places each unit member lists.
    page_size: usize,
}

pub fn parse_related_request(payload: &str) -> Result<RelatedRequest> {
    let value = crate::json_value::parse(payload).map_err(|source| {
        Error::with_source(
            ErrorCode::InvalidInput,
            "Invalid related lines JSON.",
            source,
        )
    })?;
    let request: RelatedRequest = serde_json::from_value(value).map_err(|source| {
        Error::with_source(
            ErrorCode::InvalidInput,
            "Invalid related lines request.",
            source,
        )
    })?;
    require(
        matches!(request.selection.kind.as_str(), "line" | "unit")
            && !request.selection.id.is_empty()
            && (1..=MAX_PAGE).contains(&request.page_size)
            && (request.selection.kind == "unit" || request.target.is_some()),
        Error::new(
            ErrorCode::InvalidInput,
            "Related lines select a unit, or a line of a target, with 1 to 50 places.",
        ),
    )?;
    Ok(request)
}

/// Units and lines by exact source, built once per reader.
pub(crate) struct RelatedIndex {
    /// Visible resolved units with one consistent source, by that source's string ID.
    units: HashMap<u32, Vec<u32>>,
    /// Lines by their source's string ID.
    lines: HashMap<u32, Vec<u32>>,
}

impl EngineQuery {
    pub fn related_json(&self, payload: &str, cancelled: &AtomicBool) -> Result<String> {
        let request = parse_related_request(payload)?;
        let result = self.related(&request, cancelled)?;
        crate::wtf8::view_json(&result)
    }

    fn related_index(&self, p: &Projection) -> Result<Arc<RelatedIndex>> {
        if let Some(index) = self.related_index.get() {
            return Ok(index);
        }
        let mut units = HashMap::<u32, Vec<u32>>::new();
        // In ID order, so each section lists its members as a search by ID does.
        for raw in p.raw.order.iter() {
            let raw = *raw as usize;
            let sources = p.raw.sources(raw);
            if p.raw.visible[raw] != 0 && sources.len() == 1 && p.raw.resolved(raw) {
                units.entry(sources[0]).or_default().push(raw as u32);
            }
        }
        let mut lines = HashMap::<u32, Vec<u32>>::new();
        for line in p.order.iter() {
            lines
                .entry(p.source[*line as usize])
                .or_default()
                .push(*line);
        }
        Ok(self
            .related_index
            .store(Arc::new(RelatedIndex { units, lines })))
    }

    pub fn related(&self, request: &RelatedRequest, cancelled: &AtomicBool) -> Result<Value> {
        checkpoint(cancelled)?;
        let target = match &request.target {
            Some(target) if self.target["name"] != *target => return Ok(Value::Null),
            target => target.clone(),
        };
        let p = Projection::open(self, cancelled)?;
        let index = self.related_index(&p)?;
        let raws = self.column("slice", "raw")?;
        // A line's visible units, in ID order.
        let line_units = |line: usize| -> Result<Vec<u32>> {
            let mut units = raws
                .get(p.starts[line] as usize..p.starts[line + 1] as usize)
                .ok_or("Invalid line slices.")?
                .iter()
                .copied()
                .filter(|raw| p.raw.visible[*raw as usize] != 0)
                .collect::<Vec<_>>();
            units.sort_unstable();
            units.dedup();
            Ok(units)
        };
        // The selection's unit (none for a line) and its line (none for a unit outside lines).
        let (unit, line) = if request.selection.kind == "unit" {
            let Some(raw) = self.find_id("raw", &request.selection.id)? else {
                return Ok(Value::Null);
            };
            if p.raw.visible[raw] == 0 {
                return Ok(Value::Null);
            }
            let line = self
                .unit_lines(cancelled)?
                .get(raw)
                .copied()
                .filter(|line| *line != u32::MAX)
                .map(|line| line as usize);
            (Some(raw), line)
        } else {
            let Some(line) = self.find_id("line", &request.selection.id)? else {
                return Ok(Value::Null);
            };
            (None, Some(line))
        };
        let this = match unit {
            Some(raw) => self.unit_member(raw, request.page_size, target.as_deref(), cancelled)?,
            None => self.line_member(line.ok_or("Missing line.")?, cancelled)?,
        };
        let take = |rows: Vec<u32>| -> (Vec<u32>, bool) {
            let complete = rows.len() <= MAX_MEMBERS;
            (rows.into_iter().take(MAX_MEMBERS).collect(), complete)
        };
        // Same key: the other units the selection's line holds. A line lists them all itself.
        let same_key = match (unit, line) {
            (Some(raw), Some(line)) => take(
                line_units(line)?
                    .into_iter()
                    .filter(|other| *other as usize != raw)
                    .collect(),
            ),
            _ => (Vec::new(), true),
        };
        // Same text: other units, or lines, whose exact source is the selection's.
        let same_text = match unit {
            Some(raw) => {
                let sources = p.raw.sources(raw);
                let own = line
                    .map(line_units)
                    .transpose()?
                    .unwrap_or_else(|| vec![raw as u32]);
                take(if sources.len() == 1 {
                    index
                        .units
                        .get(&sources[0])
                        .into_iter()
                        .flatten()
                        .copied()
                        .filter(|other| *other as usize != raw && !own.contains(other))
                        .collect()
                } else {
                    Vec::new()
                })
            }
            None => {
                let line = line.ok_or("Missing line.")?;
                take(
                    index
                        .lines
                        .get(&p.source[line])
                        .into_iter()
                        .flatten()
                        .copied()
                        .filter(|other| *other as usize != line)
                        .collect(),
                )
            }
        };
        let mut sectioned = vec![
            ("sameKey", same_key, false),
            ("sameText", same_text, unit.is_none()),
        ];
        if target.is_some() {
            // Conflict: the units of the line's key whose source differs from the line's.
            let conflict = match line {
                Some(line) => take(
                    line_units(line)?
                        .into_iter()
                        .filter(|raw| {
                            p.raw
                                .sources(*raw as usize)
                                .iter()
                                .any(|source| *source != p.source[line])
                        })
                        .collect(),
                ),
                None => (Vec::new(), true),
            };
            // Key change: the line paired with the selection's line.
            let key_change = match line {
                Some(line) => (self.key_change_line(line)?.into_iter().collect(), true),
                None => (Vec::new(), true),
            };
            sectioned.push(("conflict", conflict, false));
            sectioned.push(("keyChange", key_change, true));
        }
        let mut result = json!({"self":this});
        // Each section: its first members, and whether they are all of them.
        for (name, (rows, complete), lines) in sectioned {
            let mut members = Vec::with_capacity(rows.len());
            for row in rows {
                checkpoint(cancelled)?;
                members.push(if lines {
                    self.line_member(row as usize, cancelled)?
                } else {
                    self.unit_member(
                        row as usize,
                        request.page_size,
                        target.as_deref(),
                        cancelled,
                    )?
                });
            }
            result[name] = json!({"members":members,"complete":complete});
        }
        Ok(result)
    }

    /// A unit's search result and first places, as focus gives them, and with a target its line's
    /// translations, as localization detail gives them.
    fn unit_member(
        &self,
        raw: usize,
        page_size: usize,
        target: Option<&str>,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let id = self.packed("raw", raw)?;
        let focus = self.focus(
            &FocusRequest {
                id: id.clone(),
                page_size,
                occurrence_cursor: None,
                localization: None,
                findings: None,
            },
            cancelled,
        )?;
        require(!focus.is_null(), "A related unit has no focus.")?;
        let mut member = json!({"kind":"unit","unit":focus["unit"],"occurrences":focus["occurrences"],"totalOccurrences":focus["totalOccurrences"],"complete":focus.get("nextOccurrenceCursor").is_none_or(Value::is_null)});
        if let Some(target) = target {
            self.add_translations(&mut member, target, "unit", id, cancelled)?;
        }
        Ok(member)
    }

    /// A line's preview, its unit IDs and its translations.
    fn line_member(&self, line: usize, cancelled: &AtomicBool) -> Result<Value> {
        let preview = self.preview(line)?;
        let begin = self.value("line", "starts", line)? as usize;
        let end = *self
            .column("line", "starts")?
            .get(line + 1)
            .ok_or("Invalid line slice range.")? as usize;
        let raws = self.column("slice", "raw")?;
        let mut units = raws.get(begin..end).ok_or("Invalid line slices.")?.to_vec();
        units.sort_unstable();
        units.dedup();
        let mut ids = Vec::new();
        for raw in units.iter().take(MAX_PAGE) {
            ids.push(self.packed("raw", *raw as usize)?);
        }
        ids.sort_by(|left, right| crate::join::ordinal(left, right));
        let mut member = json!({"kind":"line","line":preview,"unitIds":ids,"unitsComplete":units.len() <= MAX_PAGE});
        let target = self.target["name"]
            .as_str()
            .ok_or("Missing target name.")?
            .to_owned();
        let id = self.packed("line", line)?;
        self.add_translations(&mut member, &target, "line", id, cancelled)?;
        Ok(member)
    }

    fn add_translations(
        &self,
        member: &mut Value,
        target: &str,
        kind: &str,
        id: String,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let detail = self.localization_detail(
            &LocalizationDetailRequest {
                target: target.into(),
                selection: DetailSelection {
                    kind: kind.into(),
                    id,
                },
                culture: None,
                cultures: None,
                culture_offset: None,
                location_offset: None,
                po_context_offset: None,
                findings: None,
            },
            cancelled,
        )?;
        // A unit outside the target's lines has no line and no translations.
        if kind == "unit" && !detail.is_null() {
            member["line"] = json!({"id":detail["id"],"identity":detail["identity"]});
        }
        member["translations"] = detail.get("translations").cloned().unwrap_or(json!([]));
        member["translationsComplete"] =
            json!(detail.get("nextCultureOffset").is_none_or(Value::is_null));
        Ok(())
    }

    /// The line a key change pairs with this one, if the pairing names a line of this join.
    fn key_change_line(&self, line: usize) -> Result<Option<u32>> {
        let change = self.reader.value("line.key_change", line)?;
        let Some(pair) = self.reader.meta["pairs"]
            .get(((change >> 1) as usize).wrapping_sub(1))
            .cloned()
        else {
            return Ok(None);
        };
        let other = &pair[if change & 1 != 0 { "to" } else { "from" }];
        let target = self.target["name"].as_str().ok_or("Missing target name.")?;
        let id = format!(
            "{target}:{}",
            crate::wtf8::view_json(&json!([other["namespace"], other["key"]]))?
        );
        Ok(self.find_id("line", &id)?.map(|row| row as u32))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_select_a_unit_or_a_target_line_with_bounded_places() -> Result<()> {
        parse_related_request(r#"{"selection":{"kind":"unit","id":"u"},"pageSize":50}"#)?;
        parse_related_request(
            r#"{"target":"Game","selection":{"kind":"line","id":"l"},"pageSize":1}"#,
        )?;
        for invalid in [
            r#"{"selection":{"kind":"line","id":"l"},"pageSize":1}"#,
            r#"{"selection":{"kind":"unit","id":"u"},"pageSize":0}"#,
            r#"{"selection":{"kind":"unit","id":"u"},"pageSize":51}"#,
            r#"{"selection":{"kind":"place","id":"u"},"pageSize":1}"#,
            r#"{"selection":{"kind":"unit","id":""},"pageSize":1}"#,
            r#"{"selection":{"kind":"unit","id":"u"},"pageSize":1,"extra":1}"#,
        ] {
            assert!(parse_related_request(invalid).is_err(), "{invalid}");
        }
        Ok(())
    }
}
