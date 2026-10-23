//! Persisted finding evidence, identities, and diagnostics for a pinned joined view.
use super::stages::{Measure, subject_stage};
use super::{
    Emission, HostCollator, NativeSubjects, Subject, compile, javascript_json,
    localization_identity, source_identity,
};
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_reader::EngineReader;
use crate::snapshot::{Reader, integers};
use crate::store::{Configuration, Store, decode_ids, digest, open_root, section};
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result, require};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, atomic::AtomicBool};

const VERSION: u32 = 2;
type Column = (String, String, Vec<u32>);
pub(crate) struct FindingsLayer {
    reader: Reader,
    pub(super) dictionary: EngineReader,
    record: Value,
    pub(super) metadata: Value,
    columns: HashMap<String, Arc<[u32]>>,
}
impl FindingsLayer {
    pub(super) fn open(configuration: &Configuration, key: &str, joined: &str) -> Result<Self> {
        let dictionary = EngineReader::open(configuration, Some(joined))?;
        let (_, root) = open_root(configuration)?;
        require(
            root["generation"] == dictionary.generation,
            Error::new(
                ErrorCode::StaleGeneration,
                "The findings dictionary changed while pinning it.",
            ),
        )?;
        let record = root["layers"]
            .get(key)
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::StaleGeneration,
                    "The findings layer is no longer published.",
                )
            })?
            .clone();
        require(
            record["storeGeneration"] == dictionary.generation,
            Error::new(
                ErrorCode::StaleGeneration,
                "The findings dictionary generation is stale.",
            ),
        )?;
        let file = record["file"]
            .as_str()
            .ok_or("Missing findings snapshot filename.")?;
        require(
            std::path::Path::new(file).components().count() == 1,
            "Invalid findings snapshot filename.",
        )?;
        let mut reader = Reader::open(&configuration.directory()?.join(file))?;
        let metadata =
            crate::json_value::parse(std::str::from_utf8(&section(&mut reader, "join.meta")?)?)?;
        require(
            metadata["joinedKey"] == joined && metadata["version"] == VERSION,
            Error::new(
                ErrorCode::StaleGeneration,
                "The findings layer does not belong to the pinned joined view.",
            ),
        )?;
        Ok(Self {
            reader,
            dictionary,
            record,
            metadata,
            columns: HashMap::new(),
        })
    }
    pub(super) fn column(&mut self, name: &str) -> Result<Arc<[u32]>> {
        if let Some(value) = self.columns.get(name) {
            return Ok(Arc::clone(value));
        }
        let bytes = section(&mut self.reader, name)?;
        let value: Arc<[u32]> = if self.record["stringColumns"].get(name).is_some() {
            decode_ids(&bytes, self.record["idEncoding"] == "delta32")?
        } else {
            integers(&bytes)?
        }
        .into();
        self.columns.insert(name.into(), Arc::clone(&value));
        Ok(value)
    }
    pub(super) fn json(&mut self, id: u32) -> Result<Value> {
        crate::json_value::parse_stored(&self.dictionary.string(id)?)
    }
    fn result(&self, key: &str, profile: &Value) -> Value {
        json!({"key":key,"rules":self.metadata["rules"],"counts":self.metadata["counts"],"diagnosticCount":self.metadata["diagnosticCount"],"collation":self.metadata["collation"],"profile":profile})
    }
}
fn intern_json(store: &mut Store, domain: &str, values: &[Value]) -> Result<Vec<u32>> {
    store.intern(
        domain,
        &values
            .iter()
            .map(|value| Wtf8Buf::from_utf8(&javascript_json(value, false)).into_view())
            .collect::<Vec<_>>(),
    )
}

/// Product evaluation before publication. The read-only retained-index test consumes this exact
/// recording and result; it never writes a findings layer into the retained checkout.
pub(super) struct EvaluatedFindings {
    all: Vec<Emission>,
    base_diagnostics: Vec<(u32, u32, String)>,
    regex_diagnostics: Vec<(u32, u32, String)>,
    lc_lines: Vec<u32>,
    lc_cultures: Vec<u32>,
    unit_rows: Vec<u32>,
    unit_sources: Vec<u32>,
    recorder: super::stages::Recorder,
    pub(super) profile: Value,
}
impl EngineQuery {
    pub(super) fn evaluate_findings(
        &mut self,
        program: &super::Program,
        collator: &HostCollator,
        cancelled: &AtomicBool,
    ) -> Result<EvaluatedFindings> {
        let elapsed = Measure::start();
        let mut arena = super::columns::Arena::new(self.reader.dictionary_count()?)?;
        let mut all = Vec::<Emission>::new();
        let mut regex_diagnostics = Vec::new();
        let mut base_diagnostics = Vec::new();
        let recorder = arena.recorder.clone();
        let mut lc_lines = Vec::new();
        let mut lc_cultures = Vec::new();
        let mut unit_rows = Vec::new();
        let mut unit_sources = Vec::new();
        for subject in [Subject::Line, Subject::LineCulture, Subject::UnitSource] {
            if subject != Subject::LineCulture
                && !program
                    .rules
                    .iter()
                    .any(|rule| rule.rule.subject == subject)
            {
                continue;
            }
            let setup = Measure::start();
            let mut subjects = NativeSubjects::new(self, subject, collator, cancelled)?;
            recorder.stage("subjects.columns", &setup, 0);
            let (evaluation, _, diagnostics) =
                program.evaluate_shared(&mut subjects, collator, &mut arena)?;
            for (_, row, code) in diagnostics {
                let (line, ci) = subjects.cultures[row];
                base_diagnostics.push((line as u32, ci as u32, code));
            }
            if subject == Subject::LineCulture {
                for (line, ci) in &subjects.cultures {
                    lc_lines.push(*line as u32);
                    lc_cultures.push(*ci as u32);
                }
            }
            if subject == Subject::UnitSource {
                for unit in &subjects.units {
                    unit_rows.push(unit.unit as u32);
                    unit_sources.push(unit.source);
                }
            }
            for (subject, row, code) in evaluation.diagnostics {
                if subject == Subject::LineCulture {
                    let (line, ci) = subjects.cultures[row];
                    regex_diagnostics.push((line as u32, ci as u32, code));
                } else if subject == Subject::Line {
                    let culture = subjects.line_field(row, "sourceCulture")?;
                    if let Some(ci) = subjects
                        .query
                        .cultures
                        .iter()
                        .position(|value| Some(value.as_str()) == culture.as_str())
                    {
                        regex_diagnostics.push((row as u32, ci as u32, code));
                    }
                }
            }
            all.extend(evaluation.findings);
        }
        drop(arena);

        let mut profile = recorder.profile(
            program.rules.len(),
            all.len(),
            base_diagnostics.len() + regex_diagnostics.len(),
        );
        profile["wallMs"] = json!(elapsed.elapsed().as_secs_f64() * 1000.0);
        Ok(EvaluatedFindings {
            all,
            base_diagnostics,
            regex_diagnostics,
            lc_lines,
            lc_cultures,
            unit_rows,
            unit_sources,
            recorder,
            profile,
        })
    }

    pub fn findings_evaluate(
        &mut self,
        rules_file: &std::path::Path,
        locale: &str,
        cancelled: &AtomicBool,
    ) -> Result<String> {
        let elapsed = Measure::start();
        checkpoint(cancelled)?;
        let text = std::fs::read_to_string(rules_file)?;
        let program = compile(&text)?;
        let collator = HostCollator::new(locale)?;
        let key = format!(
            "findings-v1:{}",
            digest(
                javascript_json(
                    &json!([
                        "findings-v1",
                        self.reader.joined_key,
                        digest(text.as_bytes()),
                        digest(b"{}"),
                        VERSION,
                        locale,
                        collator.locale
                    ]),
                    false
                )
                .as_bytes()
            )
        );
        if let Some(layer) = self.findings.get(&key) {
            return Ok(javascript_json(
                &layer.result(&key, &json!({"cached":true})),
                false,
            ));
        }
        let mut store = Store::writer(self.configuration.clone())?;
        require(
            store.root["generation"] == self.reader.generation,
            Error::new(
                ErrorCode::StaleGeneration,
                "The dictionary generation changed before rule evaluation.",
            ),
        )?;
        let mut profile = json!({"cached":true});
        if store.root["layers"].get(&key).is_none() {
            let EvaluatedFindings {
                all,
                base_diagnostics,
                regex_diagnostics,
                lc_lines,
                lc_cultures,
                unit_rows,
                unit_sources,
                recorder,
                profile: evaluation_profile,
            } = self.evaluate_findings(&program, &collator, cancelled)?;
            let mut publish = Measure::start();
            let line_count = Projection::open(self, cancelled)?.source.len();
            let mut source_cultures = vec![u32::MAX; line_count];
            for (line, ci) in lc_lines.iter().zip(&lc_cultures) {
                if source_cultures[*line as usize] == u32::MAX
                    || self.target["nativeCulture"] == self.cultures[*ci as usize]
                {
                    source_cultures[*line as usize] = *ci;
                }
            }
            let mut ordered = program.rules.iter().collect::<Vec<_>>();
            ordered.sort_by_key(|rule| rule.ordinal);
            let rules = ordered.iter().map(|compiled| json!({"id":compiled.rule.id,"ruleId":compiled.rule.rule_id.as_ref().unwrap_or(&compiled.rule.id),"kind":compiled.rule.kind,"label":compiled.rule.label,"subject":compiled.rule.subject,"family":compiled.rule.family,"severity":compiled.rule.severity,"role":compiled.rule.role})).collect::<Vec<_>>();
            let mut columns: Vec<Column> = vec![
                (
                    "subjects.line_culture.lines".into(),
                    String::new(),
                    lc_lines.clone(),
                ),
                (
                    "subjects.line_culture.cultures".into(),
                    String::new(),
                    lc_cultures.clone(),
                ),
                (
                    "subjects.unit_source.units".into(),
                    String::new(),
                    unit_rows.clone(),
                ),
                (
                    "subjects.unit_source.sources".into(),
                    "source".into(),
                    unit_sources,
                ),
            ];
            let mut counts = BTreeMap::<(usize, u32, String), u32>::new();
            for (index, compiled) in ordered.iter().enumerate() {
                checkpoint(cancelled)?;
                let metadata = &rules[index];
                let mut findings = all
                    .iter()
                    .filter(|finding| finding.rule == compiled.ordinal)
                    .collect::<Vec<_>>();
                findings.sort_by_key(|finding| finding.row);
                let mut rows = Vec::new();
                let mut cultures = Vec::new();
                let mut evidence = Vec::new();
                let mut places = Vec::new();
                let mut id0 = Vec::new();
                let mut id1 = Vec::new();
                let mut emission = Measure::start();
                let mut identities = HashMap::new();
                for finding in &findings {
                    let row = match finding.subject {
                        Subject::Line => finding.row,
                        Subject::LineCulture => lc_lines[finding.row] as usize,
                        Subject::UnitSource => unit_rows[finding.row] as usize,
                    };
                    if let std::collections::hash_map::Entry::Vacant(entry) = identities.entry(row)
                    {
                        entry.insert(self.packed(
                            if finding.subject == Subject::UnitSource {
                                "raw"
                            } else {
                                "line"
                            },
                            row,
                        )?);
                    }
                }
                let encoded = emission.parallel(&findings, |finding| -> Result<_> {
                    let (line, ci) = match finding.subject {
                        Subject::Line => (finding.row, source_cultures[finding.row] as usize),
                        Subject::LineCulture => (lc_lines[finding.row] as usize, lc_cultures[finding.row] as usize),
                        Subject::UnitSource => (unit_rows[finding.row] as usize, 0)
                    };
                    let rule = metadata["ruleId"].as_str().ok_or("Missing finding rule ID.")?;
                    let kind = metadata["kind"].as_str().ok_or("Missing finding kind.")?;
                    let (_, hash) = if finding.subject == Subject::UnitSource {
                        source_identity(rule, metadata["role"].as_str(), &identities[&line], kind, &finding.actual, &finding.expectation, &finding.affected)
                    } else {
                        localization_identity(&identities[&line], &self.cultures[ci], rule, kind, &finding.actual, &finding.expectation)
                    };
                    let mut value = json!({"actual":finding.actual,"expectation":finding.expectation,"recovery":finding.recovery});
                    for (name, item) in [("fix", &finding.fix), ("extra", &finding.extra), ("translationOrigin", &finding.translation_origin)] {
                        if !item.is_null() { value[name] = item.clone(); }
                    }
                    let places = json!(finding.affected.iter().map(|occurrence| occurrence["id"].clone()).collect::<Vec<_>>());
                    Ok((finding.row as u32, ci, finding.subject, value, places, hash))
                });
                publish.exclude(emission.elapsed());
                recorder.stage(
                    subject_stage(compiled.rule.subject, "emission"),
                    &emission,
                    encoded.len(),
                );
                for result in encoded {
                    let (row, ci, subject, value, saved_places, hash) = result?;
                    rows.push(row);
                    if subject != Subject::UnitSource {
                        cultures.push(ci as u32);
                    }
                    evidence.push(value);
                    places.push(saved_places);
                    id0.push(hash[0]);
                    id1.push(hash[1]);
                    *counts
                        .entry((
                            index,
                            if subject == Subject::UnitSource {
                                u32::MAX
                            } else {
                                ci as u32
                            },
                            metadata["severity"].as_str().unwrap_or("").into(),
                        ))
                        .or_default() += 1;
                }
                for (name, domain, values) in [
                    ("rows", "", rows),
                    ("cultures", "", cultures),
                    (
                        "evidence",
                        "findings",
                        intern_json(&mut store, "findings", &evidence)?,
                    ),
                    (
                        "places",
                        "findings.places",
                        intern_json(&mut store, "findings.places", &places)?,
                    ),
                    ("id0", "", id0),
                    ("id1", "", id1),
                ] {
                    columns.push((format!("r{index}.{name}"), domain.into(), values));
                }
            }
            let mut diagnostics = base_diagnostics;
            diagnostics.extend(regex_diagnostics);
            diagnostics.sort_by_key(|(line, _, _)| *line);
            let codes = store.intern(
                "findings",
                &diagnostics
                    .iter()
                    .map(|(_, _, code)| code.clone())
                    .collect::<Vec<_>>(),
            )?;
            columns.push((
                "diag.rows".into(),
                String::new(),
                diagnostics.iter().map(|(line, _, _)| *line).collect(),
            ));
            columns.push((
                "diag.cultures".into(),
                String::new(),
                diagnostics.iter().map(|(_, ci, _)| *ci).collect(),
            ));
            columns.push(("diag.codes".into(), "findings".into(), codes));
            let counts = counts.into_iter().map(|((rule,culture,severity),count)| json!({"rule":rule,"culture":if culture == u32::MAX { Value::Null } else { json!(self.cultures[culture as usize]) },"severity":severity,"count":count})).collect::<Vec<_>>();
            let metadata = json!({"version":VERSION,"joinedKey":self.reader.joined_key,"collation":collator.locale,"rules":rules,"counts":counts,"diagnosticCount":diagnostics.len()});
            store.publish_global(
                "findings",
                &key,
                &columns,
                &serde_json::to_vec(&metadata)?,
                &BTreeMap::new(),
                &[],
            )?;
            recorder.stage("layer.publish", &publish, all.len());
            profile = evaluation_profile;
            profile["stages"] = recorder.profile(program.rules.len(), all.len(), diagnostics.len())
                ["stages"]
                .take();
            profile["wallMs"] = json!(elapsed.elapsed().as_secs_f64() * 1000.0);
        }
        drop(store);
        let layer = FindingsLayer::open(&self.configuration, &key, &self.reader.joined_key)?;
        let result = javascript_json(&layer.result(&key, &profile), false);
        self.findings.insert(key, layer);
        Ok(result)
    }
}
