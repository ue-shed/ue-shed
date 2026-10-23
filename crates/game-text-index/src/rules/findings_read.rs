use super::{FindingsLayer, HostCollator, NativeSubjects, Subject, SubjectRows, javascript_json};
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::{Error, ErrorCode, Result, require};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;

fn public_place(occurrence: &Value) -> Value {
    json!({"id":occurrence["id"],"location":occurrence["location"],"packageFile":occurrence["packageFile"]})
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

impl EngineQuery {
    fn with_findings(
        &mut self,
        key: &str,
        read: impl FnOnce(&mut Self, &mut FindingsLayer) -> Result<Value>,
    ) -> Result<String> {
        let mut layer = if let Some(layer) = self.findings.remove(key) {
            layer
        } else {
            FindingsLayer::open(&self.configuration, key, &self.reader.joined_key)?
        };
        require(
            layer.metadata["joinedKey"] == self.reader.joined_key,
            Error::new(
                ErrorCode::StaleGeneration,
                "The findings belong to a different joined view.",
            ),
        )?;
        let result = read(self, &mut layer);
        self.findings.insert(key.into(), layer);
        let result = javascript_json(&result?, false);
        if result.len() <= 16 * 1024 * 1024 {
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
        Ok(javascript_json(&json!({"file":path}), false))
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
        self.with_findings(key,|query,layer| {
            let collator = HostCollator::new(layer.metadata["collation"].as_str().unwrap_or("und"))?;
            let rules = layer.metadata["rules"].as_array().ok_or("Missing findings rules.")?.clone();
            let mut subjects = NativeSubjects::new(query,Subject::Line,&collator,cancelled)?;
            require(rows.iter().all(|row| (*row as usize) < subjects.len()),Error::new(ErrorCode::InvalidInput,"A finding line row is outside the subject relation."))?;
            let lc_lines = layer.column("subjects.line_culture.lines")?;
            let mut lines = rows.iter().map(|row| json!({"row":row,"builtIns":[],"policy":[],"custom":[],"diagnostics":[]})).collect::<Vec<_>>();
            let mut places = Vec::new(); let mut place_ids = HashSet::new();
            for (rule_index,rule) in rules.iter().enumerate() {
                if rule["subject"] == "unit_source" { continue; }
                let recorded = layer.column(&format!("r{rule_index}.rows"))?; let cultures = layer.column(&format!("r{rule_index}.cultures"))?; let evidence = layer.column(&format!("r{rule_index}.evidence"))?; let saved_places = layer.column(&format!("r{rule_index}.places"))?; let id0 = layer.column(&format!("r{rule_index}.id0"))?; let id1 = layer.column(&format!("r{rule_index}.id1"))?;
                require([cultures.len(),evidence.len(),saved_places.len(),id0.len(),id1.len()].into_iter().all(|len| len == recorded.len()),"Invalid finding column lengths.")?;
                for (position,subject_row) in recorded.iter().enumerate() {
                    let line = if rule["subject"] == "line_culture" { *lc_lines.get(*subject_row as usize).ok_or("Finding culture row outside relation.")? } else { *subject_row };
                    if !rows.contains(&line) { continue; } checkpoint(cancelled)?;
                    let ci = cultures[position] as usize; let stored = layer.json(evidence[position])?; let ids = layer.json(saved_places[position])?;
                    let occurrences = subjects.occurrences(line as usize)?; let affected = ordered_places(&ids,&occurrences)?;
                    if place_ids.insert(saved_places[position]) { places.push(json!({"id":saved_places[position],"occurrences":affected.iter().map(public_place).collect::<Vec<_>>()})); }
                    let mut finding = json!({"lineId":subjects.query.packed("line",line as usize)?,"target":subjects.query.target["name"],"culture":subjects.query.cultures.get(ci).ok_or("Finding culture outside target.")?,"identity":subjects.line_field(line as usize,"identity")?,"ruleId":rule["ruleId"],"kind":rule["kind"],"severity":rule["severity"],"recovery":stored["recovery"],"actual":stored["actual"],"expectation":stored["expectation"],"manifestLocations":subjects.line_field(line as usize,"manifestLocations")?,"places":saved_places[position],"id":format!("localization-finding:{:08x}{:08x}",id0[position],id1[position])});
                    finding["translationOrigin"] = if !stored["translationOrigin"].is_null() { stored["translationOrigin"].clone() } else { subjects.culture_field(line as usize,ci,"latestOrigin")? };
                    if !rule["role"].is_null() { finding["role"] = rule["role"].clone(); }
                    let variants = subjects.line_field(line as usize,"sourceVariants")?; if !variants.is_null() && rule["family"] == "builtin" { finding["sourceVariants"] = variants; }
                    if let Some(extra) = stored["extra"].as_object() { for (name,value) in extra { finding[name] = value.clone(); } }
                    if let Some(replacement) = stored["fix"].as_str() {
                        let source = subjects.line_field(line as usize,"comparisonSource")?;
                        let po = subjects.culture_field(line as usize,ci,"po")?; let previous = if po.is_null() { subjects.culture_field(line as usize,ci,"archive")? } else { po };
                        finding["suggestedChange"] = json!({"target":finding["target"],"culture":finding["culture"],"namespace":finding["identity"]["namespace"],"key":finding["identity"]["key"],"source":source,"previousTranslation":previous,"translation":replacement});
                    }
                    let family = match rule["family"].as_str() { Some("builtin") => "builtIns",Some("policy") => "policy",Some("custom") => "custom",_ => return Err("Invalid line finding family.".into()) };
                    for (destination,row) in rows.iter().enumerate() { if *row == line { lines[destination][family].as_array_mut().ok_or("Invalid finding family list.")?.push(finding.clone()); } }
                }
            }
            let diag_rows = layer.column("diag.rows")?; let diag_cultures = layer.column("diag.cultures")?; let diag_codes = layer.column("diag.codes")?;
            require(diag_rows.len() == diag_cultures.len() && diag_rows.len() == diag_codes.len(),"Invalid diagnostic column lengths.")?;
            for (position,row) in diag_rows.iter().enumerate() { if rows.contains(row) { let diagnostic = json!({"lineId":subjects.query.packed("line",*row as usize)?,"culture":subjects.query.cultures.get(diag_cultures[position] as usize).ok_or("Diagnostic culture outside target.")?,"code":layer.dictionary.string(diag_codes[position])?}); for (destination,selected) in rows.iter().enumerate() { if selected == row { lines[destination]["diagnostics"].as_array_mut().ok_or("Invalid diagnostic list.")?.push(diagnostic.clone()); } } } }
            Ok(json!({"places":places,"lines":lines}))
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
        self.with_findings(key,|query,layer| {
            let collator = HostCollator::new(layer.metadata["collation"].as_str().unwrap_or("und"))?;
            let rules = layer.metadata["rules"].as_array().ok_or("Missing findings rules.")?.clone();
            let unit_rows = layer.column("subjects.unit_source.units")?; let sources = layer.column("subjects.unit_source.sources")?;
            let mut subjects = NativeSubjects::new(query,Subject::UnitSource,&collator,cancelled)?;
            require(units.iter().all(|unit| (*unit as usize) < subjects.projection.raw.visible.len()),Error::new(ErrorCode::InvalidInput,"A finding unit row is outside the subject relation."))?;
            let mut results = units.iter().map(|unit| json!({"unit":unit,"findings":[]})).collect::<Vec<_>>(); let mut places = Vec::new(); let mut place_ids = HashSet::new();
            for (rule_index,rule) in rules.iter().enumerate() {
                if rule["subject"] != "unit_source" { continue; }
                let recorded = layer.column(&format!("r{rule_index}.rows"))?; let evidence = layer.column(&format!("r{rule_index}.evidence"))?; let saved_places = layer.column(&format!("r{rule_index}.places"))?; let id0 = layer.column(&format!("r{rule_index}.id0"))?; let id1 = layer.column(&format!("r{rule_index}.id1"))?;
                require([evidence.len(),saved_places.len(),id0.len(),id1.len()].into_iter().all(|len| len == recorded.len()),"Invalid source finding column lengths.")?;
                let mut selected = Vec::new();
                for (position,row) in recorded.iter().enumerate() {
                    let unit = *unit_rows.get(*row as usize).ok_or("Source finding row outside relation.")?;
                    if !units.contains(&unit) { continue; } checkpoint(cancelled)?;
                    let ids = layer.json(saved_places[position])?; let occurrences = subjects.occurrences(*row as usize)?; let mut affected = ordered_places(&ids,&occurrences)?;
                    let first = affected.first().and_then(|place| place["id"].as_str()).unwrap_or("");
                    let mut first_rank = usize::MAX; for (rank,member) in subjects.projection.raw.members(unit as usize).iter().enumerate() { if subjects.query.occurrence_id(*member as usize)? == first { first_rank = rank; break; } }
                    affected.sort_by(|a,b| collator.compare(a["id"].as_str().unwrap_or(""),b["id"].as_str().unwrap_or("")));
                    if place_ids.insert(saved_places[position]) { places.push(json!({"id":saved_places[position],"occurrences":affected.iter().map(public_place).collect::<Vec<_>>()})); }
                    let stored = layer.json(evidence[position])?; let hash = (u64::from(id0[position]) << 32) | u64::from(id1[position]);
                    let finding = json!({"textUnitId":subjects.query.packed("raw",unit as usize)?,"ruleId":rule["ruleId"],"role":rule["role"],"kind":rule["kind"],"recovery":stored["recovery"],"actual":stored["actual"],"expectation":stored["expectation"],"places":saved_places[position],"id":format!("quality-finding:{hash:x}")});
                    let source = layer.dictionary.string(*sources.get(*row as usize).ok_or("Missing source group value.")?)?;
                    selected.push((unit,source,first_rank,finding));
                }
                selected.sort_by(|a,b| a.0.cmp(&b.0).then_with(|| collator.compare(&a.1,&b.1)).then_with(|| a.2.cmp(&b.2)));
                for (unit,_,_,finding) in selected { for (destination,selected) in units.iter().enumerate() { if *selected == unit { results[destination]["findings"].as_array_mut().ok_or("Invalid source finding list.")?.push(finding.clone()); } } }
            }
            Ok(json!({"places":places,"units":results}))
        })
    }
}
