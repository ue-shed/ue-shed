//! Bounded native search responses, including counts, localization and facets.
use crate::batch::{BROWSE_LINE, BROWSE_UNIT, Batches};
use crate::engine::Reply;
use crate::engine_match::{Projection, checkpoint};
use crate::engine_places::Places;
use crate::engine_query::{EngineQuery, selected_bits};
use crate::engine_types::*;
use crate::engine_where::{Facet, Field};
use crate::rules::FindingRows;
use crate::{Result, require};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

const COUNT_LABELS: [&str; 6] = [
    "all",
    "unresolved",
    "conflicting",
    "editable",
    "readOnly",
    "withoutNotes",
];
/// The `signals` bits of the counted facts, `unresolved` and `conflicting`.
const COUNTED_FACTS: [u32; 2] = [1 << FACT_SHIFT, 1 << (FACT_SHIFT + 1)];
/// The rule IDs one row lists; `findingsOmitted` counts the rest.
const MAX_ROW_FINDINGS: usize = 32;
fn record(labels: &[&str], values: &[usize]) -> Value {
    Value::Object(
        labels
            .iter()
            .zip(values)
            .map(|(label, value)| (label.to_string(), json!(value)))
            .collect(),
    )
}

/// The rule IDs with a finding on a row, the first `MAX_ROW_FINDINGS` in program order, and how
/// many more there are.
pub(crate) fn list_findings(value: &mut Value, findings: &FindingRows, row: usize) {
    let rules = findings.of(row).collect::<Vec<_>>();
    value["findings"] = json!(
        rules
            .iter()
            .take(MAX_ROW_FINDINGS)
            .map(|rule| findings.rules[*rule].id.as_str())
            .collect::<Vec<_>>()
    );
    value["findingsOmitted"] = json!(rules.len().saturating_sub(MAX_ROW_FINDINGS));
}

impl EngineQuery {
    /// The counts' tabs. With a target they count the matching lines, and origins the lines the
    /// \`kinds\` marks don't narrow. Without one each tab counts the units its own marks don't
    /// narrow: editing without \`capability\`, notes without \`withoutNotes\`, origins without
    /// \`kinds\`.
    pub(crate) fn search_counts(
        &self,
        selection: &Selection,
        matched: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let p = Projection::open(self, cancelled)?;
        // Accumulate numeric columns directly. Constructing JSON numbers and looking up map
        // keys for every row made counts proportional to millions of JSON allocations.
        let mut counts = [0usize; COUNT_LABELS.len()];
        let mut origins = [0usize; ORIGINS.len()];
        let localized = selection.localized();
        let (flags, editing, notes, row_origins) = if localized {
            (&p.flags[..], &p.editing[..], &p.notes[..], &p.origins[..])
        } else {
            (
                &p.raw.signals[..],
                &p.raw.editing[..],
                &p.raw.notes[..],
                &p.raw.origins[..],
            )
        };
        counts[0] = matched.len();
        for (index, row) in matched.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            for (fact, count) in COUNTED_FACTS.iter().zip(counts[1..3].iter_mut()) {
                if flags[row] & fact != 0 {
                    *count += 1;
                }
            }
        }
        let tab = |facet: Facet| -> Result<std::sync::Arc<[u32]>> {
            if localized {
                Ok(std::sync::Arc::from(matched))
            } else {
                self.matching(&selection.without(facet), cancelled)
            }
        };
        for (index, row) in tab(Facet::Capability)?.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            counts[3] += usize::from(editing[row] & 1 != 0);
            counts[4] += usize::from(editing[row] & 2 != 0);
        }
        for (index, row) in tab(Facet::WithoutNotes)?.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            counts[5] += usize::from(notes[*row as usize] == 0);
        }
        let rows = self.matching(&selection.without(Facet::Kinds), cancelled)?;
        for (index, row) in rows.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            for (bit, count) in origins.iter_mut().enumerate() {
                if row_origins[*row as usize] & (1 << bit) != 0 {
                    *count += 1;
                }
            }
        }
        let mut result = record(&COUNT_LABELS, &counts);
        result["origins"] = record(&ORIGINS, &origins);
        Ok(result)
    }
    fn localization_counts(
        &self,
        selection: &Selection,
        matched: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let p = Projection::open(self, cancelled)?;
        let scope = self.culture_scope(selection)?;
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
        // Keep each culture's columns hot, and visit set reason bits instead of testing
        // every possible reason for every culture/row on every new search term.
        for (ti, ci) in indices.iter().enumerate() {
            let c = &p.cultures[*ci];
            for (index, row) in matched.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let row = *row as usize;
                let state = c.state[row] as usize;
                lines[ti][state] += 1;
                word_counts[ti][state] += u64::from(words[row]);
                let mut bits = c.reasons[row] & ((1 << REASONS.len()) - 1);
                while bits != 0 {
                    reasons[ti][bits.trailing_zeros() as usize] += 1;
                    bits &= bits - 1;
                }
            }
        }
        for (index, row) in matched.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
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
        // A key-changed test keeps its count, even at zero, so it can be cleared.
        if key_changed != 0
            || selection
                .plan()?
                .is_some_and(|plan| plan.mentions(Field::KeyChanged))
        {
            result["keyChanged"] = json!(key_changed);
        }
        Ok(result)
    }
    fn culture_facets(
        &self,
        selection: &Selection,
        matched: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let mut base = selection.clone();
        base.cultures = None;
        let rows = if selection.cultures.is_some() {
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
    /// The rows with each fact, over every atom but the `fact` clauses.
    fn fact_counts(&self, selection: &Selection, cancelled: &AtomicBool) -> Result<Value> {
        let rows = self.matching(&selection.without(Facet::Fact), cancelled)?;
        let p = Projection::open(self, cancelled)?;
        let localized = selection.localized();
        let mut counts = [0usize; FACTS.len()];
        for (index, row) in rows.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            let signals = if localized {
                p.flags[row]
            } else {
                p.raw.signals[row]
            } >> FACT_SHIFT;
            for (bit, count) in counts.iter_mut().enumerate() {
                if signals & (1 << bit) != 0 {
                    *count += 1;
                }
            }
        }
        Ok(record(&FACTS, &counts))
    }
    /// Problem counts over every atom but the `problem` clauses, with the request's findings.
    fn problem_counts(&self, selection: &Selection, cancelled: &AtomicBool) -> Result<Value> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("searchProblemCounts");
        let selection = selection.without(Facet::Problem);
        let localized = selection.localized();
        let scope = self.culture_scope(&selection)?;
        let findings = self.request_findings(&selection, cancelled)?;
        let scope = if localized { scope } else { Vec::new() };
        let column = self.problem_column(localized, &scope, findings.as_deref(), cancelled)?;
        let rows = self.matching(&selection, cancelled)?;
        let mut problems = [0usize; PROBLEMS.len()];
        for (index, row) in rows.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let mask = column[*row as usize];
            for (bit, count) in problems.iter_mut().enumerate() {
                if mask & (1 << bit) != 0 {
                    *count += 1;
                }
            }
        }
        Ok(record(&PROBLEMS, &problems))
    }
    /// The answer's aggregates, as its parts ask for them.
    fn search_metadata(
        &self,
        request: &Query,
        matched: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<QueryAnswer> {
        let selection = &request.selection;
        let parts = &request.parts;
        let localized = selection.localized();
        let mut result = QueryAnswer::default();
        let counts = parts.counts == Some(true);
        if counts {
            #[cfg(feature = "benchmark-timings")]
            let _span = crate::benchmark_timings::Span::new("searchCounts");
            result.counts = Some(self.search_counts(selection, matched, cancelled)?);
            result.total = Some(u32::try_from(matched.len())?);
            result.problems = Some(self.problem_counts(selection, cancelled)?);
        }
        if let Some(groups) = &parts.groups {
            #[cfg(feature = "benchmark-timings")]
            let _span = crate::benchmark_timings::Span::new("searchGroups");
            let minimum = groups.min_size.unwrap_or(1) as usize;
            let mut value = if groups.by == GroupBy::Finding {
                match self.request_findings(selection, cancelled)? {
                    Some(findings) => self.finding_groups(
                        matched,
                        selection,
                        &findings,
                        Some(minimum),
                        cancelled,
                    )?,
                    None => json!({"entries":[],"more":0}),
                }
            } else {
                self.aggregate(matched, selection, groups.by, Some(minimum), "", cancelled)?
            };
            value["by"] = serde_json::to_value(groups.by)?;
            result.groups = Some(value);
        }
        if let Some(facets) = &parts.facets {
            #[cfg(feature = "benchmark-timings")]
            let _span = crate::benchmark_timings::Span::new("searchFacets");
            let mut values = json!({});
            if let Some(under) = &facets.folder {
                let rows = self.matching(&selection.without(Facet::Folder), cancelled)?;
                let mut folders =
                    self.aggregate(&rows, selection, GroupBy::Folder, None, under, cancelled)?;
                folders["under"] = json!(under);
                values["folders"] = folders;
            }
            for (enabled, facet, by, name) in [
                (facets.assets, Facet::Asset, GroupBy::Asset, "assets"),
                (facets.origins, Facet::Origin, GroupBy::Origin, "origins"),
                (
                    facets.audiences,
                    Facet::Audience,
                    GroupBy::Audience,
                    "audiences",
                ),
                (
                    facets.asset_types,
                    Facet::AssetType,
                    GroupBy::AssetType,
                    "assetTypes",
                ),
            ] {
                if enabled == Some(true) {
                    let rows = self.matching(&selection.without(facet), cancelled)?;
                    values[name] = self.aggregate(&rows, selection, by, None, "", cancelled)?;
                }
            }
            if facets.cultures == Some(true) && localized {
                values["cultures"] = self.culture_facets(selection, matched, cancelled)?;
            }
            if facets.findings == Some(true) {
                values["findings"] = match self.request_findings(selection, cancelled)? {
                    Some(findings) => {
                        let rows = self.matching(&selection.without(Facet::Finding), cancelled)?;
                        self.finding_groups(&rows, selection, &findings, None, cancelled)?
                    }
                    None => json!({"entries":[],"more":0}),
                };
            }
            if facets.facts == Some(true) {
                values["facts"] = self.fact_counts(selection, cancelled)?;
            }
            result.facets = Some(values);
        }
        if counts {
            if let Some(files) = &parts.file_scope {
                result.file_scope = Some(self.file_scope(matched, selection, files, cancelled)?);
            }
            if localized {
                #[cfg(feature = "benchmark-timings")]
                let _span = crate::benchmark_timings::Span::new("searchLocalizationCounts");
                result.localization =
                    Some(self.localization_counts(selection, matched, cancelled)?);
            }
        }
        checkpoint(cancelled)?;
        Ok(result)
    }

    /// Sends the rows' presentations as batches: with a target, each line's preview to
    /// \`lines\` and the first visible saved unit of it to \`units\`; without one, each unit's to
    /// \`units\`. Each lists its problems and, with a findings layer, the rules with a finding on
    /// it. Open groups' rows name their group's position as \`parent\`.
    #[allow(clippy::too_many_arguments)]
    fn send_rows(
        &self,
        selection: &Selection,
        rows: &[u32],
        parent: Option<u32>,
        units: &mut Batches,
        lines: &mut Batches,
        reply: &mut dyn Reply,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("searchRowsPresent");
        let findings = self.request_findings(selection, cancelled)?;
        let explain = |row: &mut Value, problems: u32, at: usize| {
            row["problems"] = json!(selected_bits(&PROBLEMS, problems));
            if let Some(findings) = &findings {
                list_findings(row, findings, at);
            }
        };
        let finding = |row: usize| {
            findings
                .as_ref()
                .is_some_and(|findings| findings.counted.contains(row))
        };
        let push = |batches: &mut Batches, row: &Value, reply: &mut dyn Reply| -> Result<()> {
            match parent {
                Some(parent) => batches.push_child(parent, row)?,
                None => batches.push(row)?,
            }
            if batches.full() {
                batches.flush(reply)?;
            }
            Ok(())
        };
        let p = Projection::open(self, cancelled)?;
        if selection.localized() {
            let scope = self.culture_scope(selection)?;
            for row in rows {
                checkpoint(cancelled)?;
                let row = *row as usize;
                let mut preview = {
                    #[cfg(feature = "benchmark-timings")]
                    let _span = crate::benchmark_timings::Span::new("rowPreview");
                    self.preview(row)?
                };
                explain(&mut preview, p.problem(row, &scope, finding(row)), row);
                for sr in p.starts[row] as usize..p.starts[row + 1] as usize {
                    if p.slice.visible[sr] != 0 {
                        #[cfg(feature = "benchmark-timings")]
                        let _span = crate::benchmark_timings::Span::new("rowPresentation");
                        let mut unit = self.presentation("slice", sr)?;
                        unit["localization"] = preview["cultures"].clone();
                        for field in ["problems", "findings", "findingsOmitted"] {
                            if let Some(value) = preview.get(field) {
                                unit[field] = value.clone();
                            }
                        }
                        push(units, &unit, reply)?;
                        break;
                    }
                }
                push(lines, &preview, reply)?;
            }
        } else {
            for row in rows {
                checkpoint(cancelled)?;
                let row = *row as usize;
                #[cfg(feature = "benchmark-timings")]
                let _span = crate::benchmark_timings::Span::new("rowPresentation");
                let mut unit = self.presentation("raw", row)?;
                explain(&mut unit, p.row_problem(false, row, &[], finding(row)), row);
                push(units, &unit, reply)?;
            }
        }
        Ok(())
    }

    /// Each open group's first rows in display order, in the order the request names them, sent
    /// as batches naming the group's position. Past the row budget a group, and every one after
    /// it, lists none.
    fn send_open_groups(
        &self,
        selection: &Selection,
        open: &OpenGroupsPart,
        matched: &[u32],
        reply: &mut dyn Reply,
        cancelled: &AtomicBool,
    ) -> Result<Vec<OpenGroupAnswer>> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("searchOpenGroups");
        let (by, keys) = (open.by, &open.keys);
        let first = open.first_rows as usize;
        let localized = selection.localized();
        let kind = if localized { "line" } else { "raw" };
        let p = Projection::open(self, cancelled)?;
        let places = Places::open(self)?;
        let scope = if localized {
            self.culture_scope(selection)?
        } else {
            Vec::new()
        };
        let findings = self.request_findings(selection, cancelled)?;
        let problems = self.problem_column(localized, &scope, findings.as_deref(), cancelled)?;
        let mut ids = Vec::with_capacity(keys.len());
        let mut found: HashMap<u32, Vec<u32>> = HashMap::new();
        for key in keys {
            // A finding group is its rule's position in the layer.
            let id = if by == GroupBy::Finding {
                findings
                    .as_deref()
                    .and_then(|findings| findings.rule(key))
                    .map(|rule| rule as u32)
            } else {
                self.group_id(by, key, &places)?
            };
            if let Some(id) = id {
                found.insert(id, Vec::new());
            }
            ids.push(id);
        }
        // One walk fills every group with its first rows, and one more to know a page follows.
        let mut open = found.len();
        for (index, row) in matched.iter().enumerate() {
            if open == 0 {
                break;
            }
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let mut fill = |id: u32| {
                if let Some(rows) = found.get_mut(&id)
                    && rows.len() <= first
                {
                    rows.push(*row);
                    if rows.len() == first + 1 {
                        open -= 1;
                    }
                }
            };
            match &findings {
                Some(findings) if by == GroupBy::Finding => {
                    for rule in findings.of(*row as usize) {
                        fill(rule as u32);
                    }
                }
                _ => fill(p.group_key(&places, localized, *row as usize, &problems, by)?),
            }
        }
        let mut units = Batches::new(&BROWSE_UNIT, "groupUnits", BROWSE_UNIT.all());
        let mut lines = Batches::new(&BROWSE_LINE, "groupLines", BROWSE_LINE.all());
        let mut budget = MAX_OPEN_GROUP_ROWS;
        let mut groups = Vec::with_capacity(keys.len());
        for (position, (key, id)) in keys.iter().zip(ids).enumerate() {
            let rows = id
                .and_then(|id| found.get(&id))
                .map_or(&[][..], Vec::as_slice);
            let shown = &rows[..rows.len().min(first)];
            let mut group = OpenGroupAnswer {
                key: key.clone(),
                next_cursor: None,
                rows_omitted: None,
            };
            if shown.len() > budget {
                budget = 0;
                group.rows_omitted = Some(true);
                groups.push(group);
                continue;
            }
            budget -= shown.len();
            if rows.len() > first
                && let Some(last) = shown.last()
            {
                group.next_cursor = Some(self.packed(kind, *last as usize)?);
            }
            self.send_rows(
                selection,
                shown,
                Some(u32::try_from(position)?),
                &mut units,
                &mut lines,
                reply,
                cancelled,
            )?;
            groups.push(group);
        }
        units.finish(reply)?;
        lines.finish(reply)?;
        Ok(groups)
    }

    /// A query's answer: the part holds its aggregates, the rows part's cursor and the open
    /// groups; rows follow as \`units\` and \`lines\` batches, open groups' rows as
    /// \`groupUnits\` and \`groupLines\`.
    pub fn query(
        &self,
        request: &Query,
        cancelled: &AtomicBool,
        reply: &mut dyn Reply,
    ) -> Result<()> {
        let selection = &request.selection;
        let matched = self.matching(selection, cancelled)?;
        let mut result = self.search_metadata(request, &matched, cancelled)?;
        if let Some(open) = &request.parts.open_groups {
            result.open_groups =
                Some(self.send_open_groups(selection, open, &matched, reply, cancelled)?);
        }
        if let Some(part) = &request.parts.rows {
            let listed =
                self.listed_rows(selection, part, std::sync::Arc::clone(&matched), cancelled)?;
            let kind = if selection.localized() { "line" } else { "raw" };
            let after = self.after_cursor(kind, &listed, part.after.as_ref(), cancelled)?;
            let end = listed.len().min(after.saturating_add(part.limit as usize));
            let page = &listed[after..end];
            if end < listed.len()
                && let Some(last) = page.last()
            {
                result.next_cursor = Some(self.packed(kind, *last as usize)?);
            }
            let mut units = Batches::new(&BROWSE_UNIT, "units", BROWSE_UNIT.without_parent());
            let mut lines = Batches::new(&BROWSE_LINE, "lines", BROWSE_LINE.without_parent());
            self.send_rows(
                selection, page, None, &mut units, &mut lines, reply, cancelled,
            )?;
            units.finish(reply)?;
            lines.finish(reply)?;
        }
        checkpoint(cancelled)?;
        reply.part(crate::wtf8::view_json(&serde_json::to_value(&result)?)?.into_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
impl EngineQuery {
    /// A query's answer as one page, the shape the host assembles: the rows part's units in
    /// `units`, its lines in `localization.lines`, and each open group's rows in its `page`.
    pub(crate) fn query_page(&self, request: Value, cancelled: &AtomicBool) -> Result<Value> {
        let request = parse_query(&request.to_string())?;
        let mut gathered = crate::engine::Gathered::default();
        self.query(&request, cancelled, &mut gathered)?;
        let mut page = crate::json_value::parse(std::str::from_utf8(
            gathered.parts.first().ok_or("A query has no part.")?,
        )?)?;
        let mut rows = (Vec::new(), Vec::new());
        let mut groups: HashMap<u64, (Vec<Value>, Vec<Value>)> = HashMap::new();
        for body in &gathered.batches {
            let (part, batch) = crate::batch::read(body)?;
            for mut row in batch {
                let mut group = || -> Result<u64> {
                    row.as_object_mut()
                        .and_then(|row| row.remove("parent"))
                        .and_then(|parent| parent.as_u64())
                        .ok_or_else(|| "An open group's row has no group.".into())
                };
                match part.as_str() {
                    "units" => rows.0.push(row),
                    "lines" => rows.1.push(row),
                    "groupUnits" => {
                        let group = group()?;
                        groups.entry(group).or_default().0.push(row);
                    }
                    "groupLines" => {
                        let group = group()?;
                        groups.entry(group).or_default().1.push(row);
                    }
                    _ => return Err(format!("Unexpected query part {part}.").into()),
                }
            }
        }
        let target = request.selection.target.clone();
        let assemble = |page: &mut Value, (units, lines): (Vec<Value>, Vec<Value>)| {
            let next = page
                .as_object_mut()
                .and_then(|page| page.remove("nextCursor"));
            if let Some(target) = &target {
                let localization = &mut page["localization"];
                if localization.get("target").is_none() {
                    localization["target"] = json!(target);
                }
                localization["lines"] = json!(lines);
                if let Some(next) = next {
                    localization["nextCursor"] = next;
                }
            } else if let Some(next) = next {
                page["nextCursor"] = next;
            }
            page["units"] = json!(units);
        };
        if request.parts.rows.is_some() {
            assemble(&mut page, rows);
        }
        if let Some(open) = page.get_mut("openGroups").and_then(Value::as_array_mut) {
            for (position, group) in open.iter_mut().enumerate() {
                if group.get("rowsOmitted").is_some() {
                    continue;
                }
                let mut listed = json!({});
                if let Some(next) = group
                    .as_object_mut()
                    .and_then(|group| group.remove("nextCursor"))
                {
                    listed["nextCursor"] = next;
                }
                assemble(
                    &mut listed,
                    groups.remove(&(position as u64)).unwrap_or_default(),
                );
                group["page"] = listed;
            }
        }
        Ok(page)
    }
}
