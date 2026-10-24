use super::ir::Family;
use super::replies::{
    FindingLine, FindingLines, FindingUnits, LineDiagnostic, Place, PlaceSet, Read, ReadProfile,
    SpilledReply, UnitFindings,
};
use super::{FindingsLayer, HostCollator, NativeSubjects, Subject, SubjectRows, javascript_json};
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::{Error, ErrorCode, Result, require};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

fn public_place(occurrence: &Value) -> Result<Place> {
    Ok(Place {
        id: occurrence["id"]
            .as_str()
            .ok_or("A saved occurrence has no ID.")?
            .into(),
        location: occurrence["location"].clone(),
        package_file: occurrence["packageFile"]
            .as_str()
            .ok_or("A saved occurrence has no package file.")?
            .into(),
    })
}
fn place_set(id: u32, affected: &[Value]) -> Result<PlaceSet> {
    Ok(PlaceSet {
        id,
        occurrences: affected.iter().map(public_place).collect::<Result<_>>()?,
    })
}
fn ordered_places(ids: &Value, occurrences: &[Value]) -> Result<Vec<Value>> {
    ids.as_array()
        .ok_or("Invalid interned occurrence list.")?
        .iter()
        .map(|id| {
            occurrences
                .iter()
                .find(|occurrence| occurrence["id"] == *id)
                .cloned()
                .ok_or_else(|| "A finding occurrence is absent from its pinned subject.".into())
        })
        .collect()
}

/// Sparse finding rows are sorted; locate only the requested subjects before decoding evidence.
fn selected_positions(
    recorded: &[u32],
    parents: Option<&[u32]>,
    selected: &[u32],
) -> Result<Vec<usize>> {
    require(
        parents.is_none_or(|parents| {
            recorded
                .last()
                .is_none_or(|row| (*row as usize) < parents.len())
        }),
        "Finding row outside subject mapping.",
    )?;
    let parent = |row: &u32| parents.map_or(*row, |parents| parents[*row as usize]);
    let mut positions = Vec::new();
    for selected in selected {
        let first = recorded.partition_point(|row| parent(row) < *selected);
        let end = first + recorded[first..].partition_point(|row| parent(row) == *selected);
        positions.extend(first..end);
    }
    positions.sort_unstable();
    positions.dedup();
    Ok(positions)
}

impl EngineQuery {
    fn with_findings<T: Read>(
        &mut self,
        key: &str,
        requested: usize,
        read: impl FnOnce(&mut Self, &mut FindingsLayer) -> Result<T>,
    ) -> Result<String> {
        let mut layer = if let Some(layer) = self.findings.remove(key) {
            layer
        } else {
            FindingsLayer::open(&self.configuration, key, &self.reader.joined_key)?
        };
        require(
            layer.metadata.joined_key == self.reader.joined_key,
            Error::new(
                ErrorCode::StaleGeneration,
                "The findings belong to a different joined view.",
            ),
        )?;
        let result = read(self, &mut layer);
        self.findings.insert(key.into(), layer);
        let mut reply = result?;
        *reply.profile() = ReadProfile {
            rows_requested: requested,
            findings_returned: reply.findings(),
            response_bytes: 0,
            file_fallback: false,
        };
        let mut value = serde_json::to_value(&reply)?;
        drop(reply);
        let mut result = javascript_json(&value, false);
        // The reply states its own length, digits included. Its profile is encoded with a zero
        // count and no fallback, so the final length follows from this one; a mismatch falls
        // back to iterating.
        let base = result.len() - "0".len() - "false".len();
        let mut bytes = result.len();
        for _ in 0..4 {
            let fallback = bytes > 16 * 1024 * 1024;
            bytes = base + bytes.to_string().len() + if fallback { "true" } else { "false" }.len();
        }
        let placeholder = format!("\"profile\":{}", javascript_json(&value["profile"], false));
        value["profile"]["responseBytes"] = json!(bytes);
        value["profile"]["fileFallback"] = json!(bytes > 16 * 1024 * 1024);
        // The profile holds numbers and a flag beside top-level arrays, so its text is the
        // reply's first member or its last: replace it there rather than encode the reply again.
        let profile = format!("\"profile\":{}", javascript_json(&value["profile"], false));
        let at = [1, result.len().saturating_sub(placeholder.len() + 1)]
            .into_iter()
            .find(|at| result.get(*at..at + placeholder.len()) == Some(placeholder.as_str()));
        match at {
            Some(at) => result.replace_range(at..at + placeholder.len(), &profile),
            None => result = javascript_json(&value, false),
        }
        // A reply at the threshold can have no consistent count: one byte over it when it says
        // no fallback, one byte under when it says fallback. It settles as a fallback reply.
        let mut rounds = 0;
        while value["profile"]["responseBytes"] != json!(result.len()) {
            rounds += 1;
            value["profile"]["responseBytes"] = json!(result.len());
            value["profile"]["fileFallback"] = json!(result.len() > 16 * 1024 * 1024 || rounds > 4);
            result = javascript_json(&value, false);
        }
        if value["profile"]["fileFallback"] == json!(false) {
            return Ok(result);
        }
        let path = self
            .configuration
            .cache_root
            .join(format!("native-findings-{}.json", crate::store::token()));
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        if let Err(cause) = file.write_all(result.as_bytes()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(cause.into());
        }
        self.finding_files.0.retain(|file| file.exists());
        self.finding_files.0.push(path.clone());
        let file = path
            .to_str()
            .ok_or("The findings file path is not Unicode.")?
            .to_owned();
        Ok(javascript_json(
            &serde_json::to_value(SpilledReply { file })?,
            false,
        ))
    }
    pub fn findings_lines(
        &mut self,
        key: &str,
        rows: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<String> {
        require(
            rows.len() <= 5000,
            Error::new(
                ErrorCode::InvalidInput,
                "At most 5000 finding line rows may be read.",
            ),
        )?;
        self.with_findings(key, rows.len(), |query, layer| {
            read_lines(query, layer, rows, cancelled)
        })
    }
    pub fn findings_units(
        &mut self,
        key: &str,
        units: &[u32],
        cancelled: &AtomicBool,
    ) -> Result<String> {
        require(
            units.len() <= 5000,
            Error::new(
                ErrorCode::InvalidInput,
                "At most 5000 finding unit rows may be read.",
            ),
        )?;
        self.with_findings(key, units.len(), |query, layer| {
            read_units(query, layer, units, cancelled)
        })
    }
}

fn read_lines(
    query: &mut EngineQuery,
    layer: &mut FindingsLayer,
    rows: &[u32],
    cancelled: &AtomicBool,
) -> Result<FindingLines> {
    let collator = HostCollator::new(&layer.metadata.collation)?;
    let rules = layer.metadata.rules.clone();
    let mut subjects = NativeSubjects::new(query, Subject::Line, &collator, cancelled)?;
    require(
        rows.iter().all(|row| (*row as usize) < subjects.len()),
        Error::new(
            ErrorCode::InvalidInput,
            "A finding line row is outside the subject relation.",
        ),
    )?;
    let lc_lines = layer.column("subjects.line_culture.lines")?;
    // Only lines with findings show places. Nearly every requested line has some: load their
    // places' strings in one batch rather than line by line.
    let mut hydrated = Vec::new();
    for (rule_index, rule) in rules.iter().enumerate() {
        if rule.subject == Subject::UnitSource {
            continue;
        }
        let recorded = layer.column(&format!("r{rule_index}.rows"))?;
        let culture = rule.subject == Subject::LineCulture;
        for position in selected_positions(&recorded, culture.then_some(&lc_lines[..]), rows)? {
            let row = recorded[position];
            hydrated.push(if culture {
                *lc_lines
                    .get(row as usize)
                    .ok_or("Finding culture row outside relation.")?
            } else {
                row
            });
        }
    }
    hydrated.sort_unstable();
    hydrated.dedup();
    subjects.prefetch_occurrences(&hydrated)?;
    let mut lines = rows
        .iter()
        .map(|row| FindingLine {
            row: *row,
            ..FindingLine::default()
        })
        .collect::<Vec<_>>();
    let mut places = Vec::new();
    let mut place_ids = HashSet::new();
    // A line's places are the same for each of its findings: build them once per read.
    let mut line_places = HashMap::<u32, Vec<Value>>::new();
    for (rule_index, rule) in rules.iter().enumerate() {
        if rule.subject == Subject::UnitSource {
            continue;
        }
        let recorded = layer.column(&format!("r{rule_index}.rows"))?;
        let cultures = layer.column(&format!("r{rule_index}.cultures"))?;
        let evidence = layer.column(&format!("r{rule_index}.evidence"))?;
        let saved_places = layer.column(&format!("r{rule_index}.places"))?;
        let id0 = layer.column(&format!("r{rule_index}.id0"))?;
        let id1 = layer.column(&format!("r{rule_index}.id1"))?;
        require(
            [
                cultures.len(),
                evidence.len(),
                saved_places.len(),
                id0.len(),
                id1.len(),
            ]
            .into_iter()
            .all(|len| len == recorded.len()),
            "Invalid finding column lengths.",
        )?;
        for position in selected_positions(
            &recorded,
            if rule.subject == Subject::LineCulture {
                Some(&lc_lines)
            } else {
                None
            },
            rows,
        )? {
            let subject_row = &recorded[position];
            let line = if rule.subject == Subject::LineCulture {
                *lc_lines
                    .get(*subject_row as usize)
                    .ok_or("Finding culture row outside relation.")?
            } else {
                *subject_row
            };
            if !rows.contains(&line) {
                continue;
            }
            checkpoint(cancelled)?;
            let ci = cultures[position] as usize;
            let stored = layer.json(evidence[position])?;
            let ids = layer.json(saved_places[position])?;
            if let std::collections::hash_map::Entry::Vacant(slot) = line_places.entry(line) {
                slot.insert(subjects.occurrences(line as usize)?);
            }
            let affected = ordered_places(&ids, &line_places[&line])?;
            if place_ids.insert(saved_places[position]) {
                places.push(place_set(saved_places[position], &affected)?);
            }
            let mut finding = json!({"lineId":subjects.query.packed("line",line as usize)?,"target":subjects.query.target["name"],"culture":subjects.query.cultures.get(ci).ok_or("Finding culture outside target.")?,"identity":subjects.line_field(line as usize,"identity")?,"ruleId":rule.rule_id,"kind":rule.kind,"severity":rule.severity,"recovery":stored["recovery"],"actual":stored["actual"],"expectation":stored["expectation"],"manifestLocations":subjects.line_field(line as usize,"manifestLocations")?,"places":saved_places[position],"id":format!("localization-finding:{:08x}{:08x}",id0[position],id1[position])});
            finding["translationOrigin"] = if !stored["translationOrigin"].is_null() {
                stored["translationOrigin"].clone()
            } else {
                subjects.culture_field(line as usize, ci, "latestOrigin")?
            };
            if let Some(role) = &rule.role {
                finding["role"] = json!(role);
            }
            let variants = subjects.line_field(line as usize, "sourceVariants")?;
            if !variants.is_null() && rule.family == Family::Builtin {
                finding["sourceVariants"] = variants;
            }
            if let Some(extra) = stored["extra"].as_object() {
                for (name, value) in extra {
                    finding[name] = value.clone();
                }
            }
            if let Some(replacement) = stored["fix"].as_str() {
                let source = subjects.line_field(line as usize, "comparisonSource")?;
                let po = subjects.culture_field(line as usize, ci, "po")?;
                let previous = if po.is_null() {
                    subjects.culture_field(line as usize, ci, "archive")?
                } else {
                    po
                };
                finding["suggestedChange"] = json!({"target":finding["target"],"culture":finding["culture"],"namespace":finding["identity"]["namespace"],"key":finding["identity"]["key"],"source":source,"previousTranslation":previous,"translation":replacement});
            }
            for (destination, row) in rows.iter().enumerate() {
                if *row == line {
                    let line = &mut lines[destination];
                    match rule.family {
                        Family::Builtin => &mut line.built_ins,
                        Family::Policy => &mut line.policy,
                        Family::Custom => &mut line.custom,
                        Family::Source => return Err("Invalid line finding family.".into()),
                    }
                    .push(finding.clone());
                }
            }
        }
    }
    let diag_rows = layer.column("diag.rows")?;
    let diag_cultures = layer.column("diag.cultures")?;
    let diag_codes = layer.column("diag.codes")?;
    require(
        diag_rows.len() == diag_cultures.len() && diag_rows.len() == diag_codes.len(),
        "Invalid diagnostic column lengths.",
    )?;
    for position in selected_positions(&diag_rows, None, rows)? {
        let row = &diag_rows[position];
        if rows.contains(row) {
            let diagnostic = LineDiagnostic {
                line_id: subjects.query.packed("line", *row as usize)?,
                culture: subjects
                    .query
                    .cultures
                    .get(diag_cultures[position] as usize)
                    .ok_or("Diagnostic culture outside target.")?
                    .clone(),
                code: layer.dictionary.string(diag_codes[position])?,
            };
            for (destination, selected) in rows.iter().enumerate() {
                if selected == row {
                    lines[destination].diagnostics.push(diagnostic.clone());
                }
            }
        }
    }
    Ok(FindingLines {
        profile: ReadProfile::default(),
        places,
        lines,
    })
}

fn read_units(
    query: &mut EngineQuery,
    layer: &mut FindingsLayer,
    units: &[u32],
    cancelled: &AtomicBool,
) -> Result<FindingUnits> {
    let collator = HostCollator::new(&layer.metadata.collation)?;
    let rules = layer.metadata.rules.clone();
    let unit_rows = layer.column("subjects.unit_source.units")?;
    let sources = layer.column("subjects.unit_source.sources")?;
    let mut subjects = NativeSubjects::new(query, Subject::UnitSource, &collator, cancelled)?;
    require(
        units
            .iter()
            .all(|unit| (*unit as usize) < subjects.projection.raw.visible.len()),
        Error::new(
            ErrorCode::InvalidInput,
            "A finding unit row is outside the subject relation.",
        ),
    )?;
    let mut results = units
        .iter()
        .map(|unit| UnitFindings {
            unit: *unit,
            findings: Vec::new(),
        })
        .collect::<Vec<_>>();
    let mut places = Vec::new();
    let mut place_ids = HashSet::new();
    for (rule_index, rule) in rules.iter().enumerate() {
        if rule.subject != Subject::UnitSource {
            continue;
        }
        let recorded = layer.column(&format!("r{rule_index}.rows"))?;
        let evidence = layer.column(&format!("r{rule_index}.evidence"))?;
        let saved_places = layer.column(&format!("r{rule_index}.places"))?;
        let id0 = layer.column(&format!("r{rule_index}.id0"))?;
        let id1 = layer.column(&format!("r{rule_index}.id1"))?;
        require(
            [evidence.len(), saved_places.len(), id0.len(), id1.len()]
                .into_iter()
                .all(|len| len == recorded.len()),
            "Invalid source finding column lengths.",
        )?;
        let mut selected = Vec::new();
        for position in selected_positions(&recorded, Some(&unit_rows), units)? {
            let row = &recorded[position];
            let unit = *unit_rows
                .get(*row as usize)
                .ok_or("Source finding row outside relation.")?;
            if !units.contains(&unit) {
                continue;
            }
            checkpoint(cancelled)?;
            let ids = layer.json(saved_places[position])?;
            let occurrences = subjects.occurrences(*row as usize)?;
            let mut affected = ordered_places(&ids, &occurrences)?;
            let first = affected
                .first()
                .and_then(|place| place["id"].as_str())
                .unwrap_or("");
            let mut first_rank = usize::MAX;
            for (rank, member) in subjects
                .projection
                .raw
                .members(unit as usize)
                .iter()
                .enumerate()
            {
                if subjects.occurrence_text_id(*member)? == first {
                    first_rank = rank;
                    break;
                }
            }
            affected.sort_by(|a, b| {
                collator.compare(
                    a["id"].as_str().unwrap_or(""),
                    b["id"].as_str().unwrap_or(""),
                )
            });
            if place_ids.insert(saved_places[position]) {
                places.push(place_set(saved_places[position], &affected)?);
            }
            let stored = layer.json(evidence[position])?;
            let hash = (u64::from(id0[position]) << 32) | u64::from(id1[position]);
            let finding = json!({"textUnitId":subjects.query.packed("raw",unit as usize)?,"ruleId":rule.rule_id,"role":rule.role,"kind":rule.kind,"recovery":stored["recovery"],"actual":stored["actual"],"expectation":stored["expectation"],"places":saved_places[position],"id":format!("quality-finding:{hash:x}")});
            let source = layer.dictionary.string(
                *sources
                    .get(*row as usize)
                    .ok_or("Missing source group value.")?,
            )?;
            selected.push((unit, source, first_rank, finding));
        }
        selected.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| collator.compare(&a.1, &b.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        for (unit, _, _, finding) in selected {
            for (destination, selected) in units.iter().enumerate() {
                if *selected == unit {
                    results[destination].findings.push(finding.clone());
                }
            }
        }
    }
    Ok(FindingUnits {
        profile: ReadProfile::default(),
        places,
        units: results,
    })
}
