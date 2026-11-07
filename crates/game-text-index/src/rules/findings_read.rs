use super::ir::Family;
use super::replies::{Place, PlaceSet};
use super::{FindingsLayer, HostCollator, NativeSubjects, Subject, SubjectRows};
use crate::batch::{Batches, FINDING, PLACE};
use crate::engine::Reply;
#[cfg(test)]
use crate::engine_query::EngineQuery;
use crate::{Result, require};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

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
/// A set's places in its own order, each the first of its subject's occurrences with that ID.
fn ordered_places(ids: &[String], occurrences: &[Value]) -> Result<Vec<Value>> {
    let mut by_id = HashMap::new();
    for occurrence in occurrences {
        if let Some(id) = occurrence["id"].as_str() {
            by_id.entry(id).or_insert(occurrence);
        }
    }
    ids.iter()
        .map(|id| {
            by_id
                .get(id.as_str())
                .map(|occurrence| (*occurrence).clone())
                .ok_or_else(|| "A finding occurrence is absent from its pinned subject.".into())
        })
        .collect()
}

/// A page's place sets and findings as batches, the sets first because the findings name them.
pub(super) fn send_findings(
    places: Vec<PlaceSet>,
    findings: Vec<Value>,
    reply: &mut dyn Reply,
) -> Result<()> {
    let mut sets = Batches::new(
        &PLACE,
        "places",
        PLACE.select(&["parent", "id", "location", "packageFile"])?,
    );
    for set in places {
        for place in set.occurrences {
            sets.push_child(set.id, &serde_json::to_value(place)?)?;
            if sets.full() {
                sets.flush(reply)?;
            }
        }
    }
    sets.finish(reply)?;
    let mut rows = Batches::new(&FINDING, "findings", FINDING.all());
    for finding in findings {
        rows.push(&json!({ "finding": finding }))?;
        if rows.full() {
            rows.flush(reply)?;
        }
    }
    rows.finish(reply)?;
    Ok(())
}

#[cfg(test)]
impl EngineQuery {
    /// A page of findings as one value, asked for as the hosts asked before finding rows (`key`,
    /// `view`, `order`, `rules`, `severities`, `limit` …) and read as finding rows.
    pub(crate) fn findings_page(
        &self,
        request: Value,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Value> {
        let request = super::findings_select::as_finding_rows(self, &request)?;
        self.finding_rows_page(request, cancelled)
    }
}

/// One line finding in the host's shape, by its rule and position. Its place set is added to
/// `places` the first time a read names it; `line_places` keeps each line's occurrences.
#[expect(
    clippy::too_many_arguments,
    reason = "one read's shared state, threaded through"
)]
pub(super) fn compose_line_finding(
    subjects: &mut NativeSubjects<'_>,
    layer: &FindingsLayer,
    rule_index: usize,
    rule: &super::replies::RuleMetadata,
    position: usize,
    places: &mut Vec<PlaceSet>,
    place_ids: &mut HashSet<u32>,
    line_places: &mut HashMap<u32, Vec<Value>>,
) -> Result<Value> {
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
        .all(|len| len == recorded.len())
            && position < recorded.len(),
        "Invalid finding column lengths.",
    )?;
    let line = if rule.subject == Subject::LineCulture {
        *layer
            .column("subjects.line_culture.lines")?
            .get(recorded[position] as usize)
            .ok_or("Finding culture row outside relation.")?
    } else {
        recorded[position]
    };
    let ci = cultures[position] as usize;
    let stored = layer.json(evidence[position])?;
    let ids = layer.place_set(saved_places[position])?;
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
    Ok(finding)
}

/// One source finding in the host's shape, with its unit and its first place's rank among the
/// unit's places, which orders a unit's findings for one rule.
#[expect(
    clippy::too_many_arguments,
    reason = "one read's shared state, threaded through"
)]
pub(super) fn compose_unit_finding(
    subjects: &mut NativeSubjects<'_>,
    layer: &FindingsLayer,
    collator: &HostCollator,
    rule: &super::replies::RuleMetadata,
    rule_index: usize,
    position: usize,
    places: &mut Vec<PlaceSet>,
    place_ids: &mut HashSet<u32>,
) -> Result<(u32, Value)> {
    let unit_rows = layer.column("subjects.unit_source.units")?;
    let recorded = layer.column(&format!("r{rule_index}.rows"))?;
    let evidence = layer.column(&format!("r{rule_index}.evidence"))?;
    let saved_places = layer.column(&format!("r{rule_index}.places"))?;
    let id0 = layer.column(&format!("r{rule_index}.id0"))?;
    let id1 = layer.column(&format!("r{rule_index}.id1"))?;
    require(
        [evidence.len(), saved_places.len(), id0.len(), id1.len()]
            .into_iter()
            .all(|len| len == recorded.len())
            && position < recorded.len(),
        "Invalid source finding column lengths.",
    )?;
    let row = recorded[position];
    let unit = *unit_rows
        .get(row as usize)
        .ok_or("Source finding row outside relation.")?;
    let ids = layer.place_set(saved_places[position])?;
    let occurrences = subjects.occurrences(row as usize)?;
    let mut affected = ordered_places(&ids, &occurrences)?;
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
    Ok((
        unit,
        json!({"textUnitId":subjects.query.packed("raw",unit as usize)?,"ruleId":rule.rule_id,"role":rule.role,"kind":rule.kind,"recovery":stored["recovery"],"actual":stored["actual"],"expectation":stored["expectation"],"places":saved_places[position],"id":format!("quality-finding:{hash:x}")}),
    ))
}
