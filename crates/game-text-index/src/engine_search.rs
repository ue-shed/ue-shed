//! Bounded native search responses, including counts, localization and facets.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_places::Places;
use crate::engine_query::{EngineQuery, mask};
use crate::engine_types::*;
use crate::{Result, require};
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

fn counts() -> Value {
    json!({"all":0,"shared":0,"duplicate_source":0,"long":0,"unresolved":0,"conflicting":0,"editable":0,"readOnly":0,"withoutNotes":0,"origins":ORIGINS.iter().map(|label| (label.to_string(),json!(0))).collect::<serde_json::Map<_,_>>()})
}
fn increment(record: &mut Value, key: &str, amount: usize) -> Result<()> {
    let value = record[key].as_u64().ok_or("Missing count field.")?;
    record[key] = json!(value.checked_add(amount as u64).ok_or("Count overflow.")?);
    Ok(())
}
fn record(labels: &[&str], values: &[usize]) -> Value {
    Value::Object(
        labels
            .iter()
            .zip(values)
            .map(|(label, value)| (label.to_string(), json!(value)))
            .collect(),
    )
}

impl EngineQuery {
    pub(crate) fn search_counts(
        &mut self,
        request: &SearchRequest,
        matched: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let p = Projection::open(self, cancelled)?;
        let mut counts = counts();
        if request.localization.is_some() {
            counts["all"] = json!(matched.len());
            for (index, row) in matched.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let row = *row as usize;
                for (bit, label) in SIGNALS[..5].iter().enumerate() {
                    if p.flags[row] & (1 << bit) != 0 {
                        increment(&mut counts, label, 1)?;
                    }
                }
                if p.editing[row] & 1 != 0 {
                    increment(&mut counts, "editable", 1)?;
                }
                if p.editing[row] & 2 != 0 {
                    increment(&mut counts, "readOnly", 1)?;
                }
                if p.notes[row] == 0 {
                    increment(&mut counts, "withoutNotes", 1)?;
                }
            }
            let mut origin_request = request.clone();
            if let Some(location) = &mut origin_request.location {
                location.kinds = None;
            }
            let rows = self.matching(&origin_request, cancelled)?;
            for row in rows.iter().copied() {
                for (bit, label) in ORIGINS.iter().enumerate() {
                    if p.origins[row as usize] & (1 << bit) != 0 {
                        increment(&mut counts["origins"], label, 1)?;
                    }
                }
            }
        } else {
            let mut base = request.clone();
            base.capability = Capability::All;
            base.lens = None;
            base.without_notes = None;
            if let Some(location) = &mut base.location {
                location.kinds = None;
            }
            let rows = self.matching(&base, cancelled)?;
            for (index, row) in rows.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let row = *row as usize;
                let flags = p.raw.signals[row];
                let editing = p.raw.editing[row];
                let no_notes = p.raw.notes[row] == 0;
                let lens = request.lens.as_ref().is_none_or(|lens| {
                    lens == "all"
                        || SIGNALS
                            .iter()
                            .position(|value| value == lens)
                            .is_some_and(|bit| flags & (1 << bit) != 0)
                });
                let kinds = request
                    .location
                    .as_ref()
                    .and_then(|location| location.kinds.as_ref())
                    .is_none_or(|values| p.raw.origins[row] & mask(&ORIGINS, values) != 0);
                let capability = request.capability == Capability::All
                    || editing
                        & (if request.capability == Capability::SourceEditable {
                            1
                        } else {
                            2
                        })
                        != 0;
                let notes = request.without_notes != Some(true) || no_notes;
                if lens && notes && kinds {
                    if editing & 1 != 0 {
                        increment(&mut counts, "editable", 1)?;
                    }
                    if editing & 2 != 0 {
                        increment(&mut counts, "readOnly", 1)?;
                    }
                }
                if lens && capability && kinds && no_notes {
                    increment(&mut counts, "withoutNotes", 1)?;
                }
                if lens && capability && notes {
                    for (bit, label) in ORIGINS.iter().enumerate() {
                        if p.raw.origins[row] & (1 << bit) != 0 {
                            increment(&mut counts["origins"], label, 1)?;
                        }
                    }
                }
                if lens && capability && notes && kinds {
                    increment(&mut counts, "all", 1)?;
                    for (bit, label) in SIGNALS[..5].iter().enumerate() {
                        if flags & (1 << bit) != 0 {
                            increment(&mut counts, label, 1)?;
                        }
                    }
                }
            }
        }
        Ok(counts)
    }
    fn localization_counts(
        &mut self,
        request: &SearchRequest,
        matched: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let selection = request
            .localization
            .as_ref()
            .ok_or("Missing localization scope.")?;
        let p = Projection::open(self, cancelled)?;
        let scope = self.culture_scope(Some(selection))?;
        let cultures = selection.cultures.as_ref().unwrap_or(&self.cultures);
        let indices = cultures
            .iter()
            .map(|culture| {
                self.cultures
                    .iter()
                    .position(|value| value == culture)
                    .ok_or("Unknown culture.")
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let words = self.reader.column("line.source_words")?;
        require(words.len() == p.source.len(), "Invalid source word counts.")?;
        let mut lines = vec![[0usize; STATES.len()]; cultures.len()];
        let mut word_counts = vec![[0u64; STATES.len()]; cultures.len()];
        let mut reasons = vec![[0usize; REASONS.len()]; cultures.len()];
        let mut states = [0usize; STATES.len()];
        let mut reviews = [0usize; REVIEWS.len()];
        let mut not_synced = 0;
        let mut key_changed = 0;
        let mut reviewed = false;
        let tracks_review = self.reader.meta["input"]["review"]["target"] == self.target["name"];
        for (index, row) in matched.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            for (ti, ci) in indices.iter().enumerate() {
                let c = &p.cultures[*ci];
                let state = c.state[row] as usize;
                lines[ti][state] += 1;
                word_counts[ti][state] += u64::from(words[row]);
                for (bit, count) in reasons[ti].iter_mut().enumerate() {
                    if c.reasons[row] & (1 << bit) != 0 {
                        *count += 1;
                    }
                }
            }
            let mut state_bits = 0;
            let mut review_bits = 0;
            for ci in &scope {
                let c = &p.cultures[*ci];
                let state = c.state[row];
                if state != 3 {
                    state_bits |= 1 << state;
                }
                if c.facts[row] & 8 != 0 {
                    state_bits |= 8;
                    not_synced += 1;
                }
                if tracks_review {
                    review_bits |= p.review(self, row, *ci)?;
                }
            }
            for (bit, count) in states.iter_mut().enumerate() {
                if state_bits & (1 << bit) != 0 {
                    *count += 1;
                }
            }
            if p.key_change[row] > 0 && p.key_change[row] & 1 == 0 {
                key_changed += 1;
            }
            if tracks_review {
                reviewed |= p.cultures.iter().any(|c| c.review[row] != 0);
                for (bit, count) in reviews.iter_mut().enumerate() {
                    if review_bits & (1 << bit) != 0 {
                        *count += 1;
                    }
                }
            }
        }
        let tallies=cultures.iter().enumerate().map(|(ti,culture)| {
            let states=STATES.iter().enumerate().map(|(bit,state)| (state.to_string(),json!({"lines":lines[ti][bit],"sourceWords":word_counts[ti][bit]}))).collect::<serde_json::Map<_,_>>();
            json!({"culture":culture,"states":states,"unknownReasons":record(&REASONS,&reasons[ti]),"reducedSourceChecking":if self.reader.meta["reducedSourceChecking"][indices[ti]].as_bool()==Some(true) {matched.len()} else {0}})
        }).collect::<Vec<_>>();
        let mut result = json!({"target":self.target["name"],"counts":tallies,"stateCounts":record(&STATES,&states),"notSynced":not_synced});
        if reviewed {
            result["reviewCounts"] = record(&REVIEWS, &reviews);
        }
        if key_changed != 0 || selection.key_changed == Some(true) {
            result["keyChanged"] = json!(key_changed);
        }
        Ok(result)
    }
    fn culture_facets(
        &mut self,
        request: &SearchRequest,
        matched: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let mut base = request.clone();
        if let Some(scope) = &mut base.localization {
            scope.cultures = None;
        }
        let rows = if request
            .localization
            .as_ref()
            .is_some_and(|scope| scope.cultures.is_some())
        {
            self.matching(&base, cancelled)?
        } else {
            std::sync::Arc::from(matched)
        };
        let p = Projection::open(self, cancelled)?;
        let mut facets = Vec::new();
        for (ci, culture) in self.cultures.iter().enumerate() {
            let mut states = [0usize; STATES.len()];
            let mut not_synced = 0;
            for (index, row) in rows.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let row = *row as usize;
                let c = &p.cultures[ci];
                states[c.state[row] as usize] += 1;
                if c.state[row] == 3 || c.facts[row] & 8 != 0 {
                    not_synced += 1;
                }
            }
            facets.push((states[1]+states[2],culture.clone(),json!({"culture":culture,"lines":rows.len(),"shipped":states[0],"missing":states[1],"toUpdate":states[2],"notSynced":not_synced})));
        }
        facets.sort_by(|(a_count, a, _), (b_count, b, _)| {
            b_count
                .cmp(a_count)
                .then_with(|| crate::join::ordinal(a, b))
        });
        Ok(Value::Array(
            facets.into_iter().map(|(_, _, value)| value).collect(),
        ))
    }
    pub fn search(&mut self, request: &SearchRequest, cancelled: &AtomicBool) -> Result<Value> {
        let matched = self.matching(request, cancelled)?;
        let p = Projection::open(self, cancelled)?;
        let places = Places::open(self)?;
        let localized = request.localization.is_some();
        let scope = self.culture_scope(request.localization.as_ref())?;
        let mut listed = Vec::new();
        let opened = if let (Some(by), Some(opened)) = (request.group, request.open_group.as_ref())
        {
            Some(match by {
                GroupBy::Problem => PROBLEMS
                    .iter()
                    .position(|value| value == opened)
                    .map(|id| id as u32),
                GroupBy::Origin => {
                    if opened.is_empty() {
                        Some(0)
                    } else {
                        ORIGINS
                            .iter()
                            .position(|value| value == opened)
                            .map(|id| id as u32 + 1)
                    }
                }
                GroupBy::Audience => AUDIENCES
                    .iter()
                    .position(|value| value == opened)
                    .map(|id| id as u32),
                _ => places
                    .labels(std::slice::from_ref(opened), false)
                    .iter()
                    .next()
                    .copied(),
            })
        } else {
            None
        };
        for (index, row) in matched.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            if let Some(opened) = opened
                && opened
                    != Some(p.group_key(
                        &places,
                        localized,
                        *row as usize,
                        &scope,
                        request.group.ok_or("Missing group.")?,
                    )?)
            {
                continue;
            }
            listed.push(*row);
        }
        let kind = if localized { "line" } else { "raw" };
        let cursor = if localized {
            request.localization_cursor.as_ref()
        } else {
            request.cursor.as_ref()
        };
        let after = if let Some(cursor) = cursor {
            let row = self.find_id(kind, cursor)?;
            row.and_then(|row| listed.iter().position(|value| *value as usize == row))
                .map_or(0, |index| index + 1)
        } else {
            0
        };
        let page = &listed[after..listed.len().min(after + request.page_size)];
        let next = if after + page.len() < listed.len() {
            page.last()
                .map(|row| self.packed(kind, *row as usize))
                .transpose()?
        } else {
            None
        };
        let mut result =
            json!({"counts":self.search_counts(request,&matched,cancelled)?,"total":matched.len()});
        let problem_rows =
            self.matching(&request.without_filter(FilterField::Problem), cancelled)?;
        let mut problems = [0usize; PROBLEMS.len()];
        for (index, row) in problem_rows.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let mask = p.row_problem(localized, *row as usize, &scope);
            for (bit, count) in problems.iter_mut().enumerate() {
                if mask & (1 << bit) != 0 {
                    *count += 1;
                }
            }
        }
        result["problems"] = record(&PROBLEMS, &problems);
        if let Some(group) = request.group {
            let mut groups = self.aggregate(&matched, request, group, false, "", cancelled)?;
            groups["by"] = serde_json::to_value(group)?;
            result["groups"] = groups;
        }
        if let Some(facets) = &request.facets {
            let mut values = json!({});
            if let Some(under) = &facets.folder {
                let rows =
                    self.matching(&request.without_filter(FilterField::Folder), cancelled)?;
                let mut folders =
                    self.aggregate(&rows, request, GroupBy::Folder, true, under, cancelled)?;
                folders["under"] = json!(under);
                values["folders"] = folders;
            }
            for (enabled, field, by, name) in [
                (facets.assets, FilterField::Asset, GroupBy::Asset, "assets"),
                (
                    facets.origins,
                    FilterField::Origin,
                    GroupBy::Origin,
                    "origins",
                ),
                (
                    facets.audiences,
                    FilterField::Audience,
                    GroupBy::Audience,
                    "audiences",
                ),
            ] {
                if enabled == Some(true) {
                    let rows = self.matching(&request.without_filter(field), cancelled)?;
                    values[name] = self.aggregate(&rows, request, by, true, "", cancelled)?;
                }
            }
            if facets.cultures == Some(true) && localized {
                values["cultures"] = self.culture_facets(request, &matched, cancelled)?;
            }
            result["facets"] = values;
        }
        if let Some(files) = self.file_scope(&matched, request, cancelled)? {
            result["fileScope"] = files;
        }
        let mut units = Vec::new();
        if localized {
            let mut localization = self.localization_counts(request, &matched, cancelled)?;
            let mut lines = Vec::new();
            for row in page {
                checkpoint(cancelled)?;
                let row = *row as usize;
                let preview = self.preview(row)?;
                for sr in p.starts[row] as usize..p.starts[row + 1] as usize {
                    if p.slice.visible[sr] != 0 {
                        let mut unit = self.presentation("slice", sr)?;
                        unit["localization"] = preview["cultures"].clone();
                        units.push(unit);
                        break;
                    }
                }
                lines.push(preview);
            }
            localization["lines"] = json!(lines);
            if let Some(next) = next {
                localization["nextCursor"] = json!(next);
            }
            result["localization"] = localization;
        } else {
            for row in page {
                checkpoint(cancelled)?;
                units.push(self.presentation("raw", *row as usize)?);
            }
            if let Some(next) = next {
                result["nextCursor"] = json!(next);
            }
        }
        result["units"] = json!(units);
        checkpoint(cancelled)?;
        Ok(result)
    }
}
