//! Persisted finding evidence, identities, and diagnostics for a pinned joined view.
use super::identity::{
    localization_identity_encoded, source_identity_encoded, write_atom, write_ids, write_string,
};
use super::stages::{Measure, Phase, subject_stage};
use super::{HostCollator, NativeSubjects, Subject, compile, javascript_json};
use crate::engine_match::checkpoint;
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
/// One rule's finding columns, encoded as they are published: evidence and place JSON in
/// the stored string view, and the identity hash halves.
#[derive(Default)]
pub(super) struct RuleColumns {
    rows: Vec<u32>,
    cultures: Vec<u32>,
    evidence: Vec<String>,
    places: Vec<String>,
    id0: Vec<u32>,
    id1: Vec<u32>,
}
struct Encoded {
    row: u32,
    culture: u32,
    evidence: String,
    places: String,
    hash: [u32; 2],
}

/// Product evaluation before publication. The read-only retained-index test consumes this exact
/// recording and result; it never writes a findings layer into the retained checkout.
pub(super) struct EvaluatedFindings {
    /// Indexed by rule ordinal.
    rules: Vec<RuleColumns>,
    findings: usize,
    base_diagnostics: Vec<(u32, u32, u8)>,
    regex_diagnostics: Vec<(u32, u32, u8)>,
    lc_lines: Vec<u32>,
    lc_cultures: Vec<u32>,
    unit_rows: Vec<u32>,
    unit_sources: Vec<u32>,
    recorder: super::stages::Recorder,
    pub(super) profile: Value,
    #[cfg(test)]
    pub(super) digest: String,
}
impl EngineQuery {
    /// Evaluation reads raw index columns into its own scope, never the query cache.
    pub(super) fn evaluate_findings(
        &mut self,
        program: &super::Program,
        collator: &HostCollator,
        cancelled: &AtomicBool,
        request: Option<&Measure>,
    ) -> Result<EvaluatedFindings> {
        self.reader.begin_evaluation()?;
        let evaluated = self.evaluate_scoped(program, collator, cancelled, request);
        self.reader.end_evaluation();
        evaluated
    }
    fn evaluate_scoped(
        &mut self,
        program: &super::Program,
        collator: &HostCollator,
        cancelled: &AtomicBool,
        request: Option<&Measure>,
    ) -> Result<EvaluatedFindings> {
        let elapsed = Measure::start();
        #[cfg(test)]
        let mut elapsed = elapsed;
        let mut arena = super::columns::Arena::new(self.reader.dictionary_count()?)?;
        arena.recorder = super::stages::Recorder::at(request.unwrap_or(&elapsed));
        let mut rules = (0..program
            .rules
            .iter()
            .map(|rule| rule.ordinal + 1)
            .max()
            .unwrap_or(0))
            .map(|_| RuleColumns::default())
            .collect::<Vec<_>>();
        let mut findings = 0;
        let mut regex_diagnostics = Vec::new();
        let mut base_diagnostics = Vec::new();
        let recorder = arena.recorder.clone();
        let mut lc_lines = Vec::new();
        let mut lc_cultures = Vec::new();
        let mut unit_rows = Vec::new();
        let mut unit_sources = Vec::new();
        recorder.enter("relation.occurrences");
        let mut occurrences_measure = Measure::start();
        let occurrences =
            super::occurrences::OccurrenceData::build(self, &mut occurrences_measure)?;
        arena.occurrences.data = Some(Arc::clone(&occurrences));
        self.reader.release_evaluation_columns();
        recorder.stage(
            "relation.occurrences",
            &occurrences_measure,
            occurrences.len(),
        );
        recorder.memory("relation.occurrences", arena.memory());
        #[cfg(test)]
        let mut output_digest = <sha2::Sha256 as sha2::Digest>::new();
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
            let mut subjects = NativeSubjects::new_shared(
                self,
                subject,
                collator,
                cancelled,
                Arc::clone(&occurrences),
            )?;
            subjects.query.reader.release_evaluation_columns();
            recorder.stage(subject_stage(subject, Phase::Columns), &setup, 0);
            let evaluated = program.evaluate_shared(&mut subjects, collator, &mut arena)?;
            #[cfg(test)]
            if std::env::var_os("UE_SHED_GAME_TEXT_TIMING_CACHE").is_some() {
                let digest_time = Measure::start();
                super::timing::digest_subject(
                    &mut output_digest,
                    program,
                    &mut subjects,
                    &arena,
                    &evaluated,
                )?;
                elapsed.exclude(digest_time.elapsed());
            }
            // Encode while the arena holds the evidence; only the published bytes outlive it.
            let mut encode = Measure::start();
            let encoded = encode_findings(&mut subjects, program, &arena, &evaluated, &mut encode)?;
            recorder.stage(
                subject_stage(subject, Phase::Emission),
                &encode,
                encoded.len(),
            );
            #[cfg(test)]
            if std::env::var_os("UE_SHED_GAME_TEXT_TIMING_CACHE").is_some() {
                let check_time = Measure::start();
                check_encoding(&mut subjects, program, &arena, &evaluated, &encoded)?;
                elapsed.exclude(check_time.elapsed());
            }
            findings += encoded.len();
            for (finding, encoded) in evaluated.findings.iter().zip(encoded) {
                let columns = &mut rules[finding.rule];
                columns.rows.push(encoded.row);
                if subject != Subject::UnitSource {
                    columns.cultures.push(encoded.culture);
                }
                columns.evidence.push(encoded.evidence);
                columns.places.push(encoded.places);
                columns.id0.push(encoded.hash[0]);
                columns.id1.push(encoded.hash[1]);
            }
            for diagnostic in &evaluated.projection {
                let (line, ci) = subjects.cultures[diagnostic.row as usize];
                base_diagnostics.push((line as u32, ci as u32, diagnostic.code));
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
            for super::Diagnostic { row, code } in &evaluated.diagnostics {
                let row = *row as usize;
                if subject == Subject::LineCulture {
                    let (line, ci) = subjects.cultures[row];
                    regex_diagnostics.push((line as u32, ci as u32, *code));
                } else if subject == Subject::Line {
                    let culture = subjects.line_field(row, "sourceCulture")?;
                    if let Some(ci) = subjects
                        .query
                        .cultures
                        .iter()
                        .position(|value| Some(value.as_str()) == culture.as_str())
                    {
                        regex_diagnostics.push((row as u32, ci as u32, *code));
                    }
                }
            }
        }
        drop(arena);

        let mut profile = recorder.profile(
            program.rules.len(),
            findings,
            base_diagnostics.len() + regex_diagnostics.len(),
        );
        profile["wallMs"] = json!(elapsed.wall().as_secs_f64() * 1000.0);
        Ok(EvaluatedFindings {
            rules,
            findings,
            base_diagnostics,
            regex_diagnostics,
            lc_lines,
            lc_cultures,
            unit_rows,
            unit_sources,
            recorder,
            profile,
            #[cfg(test)]
            digest: format!(
                "{:x}",
                <sha2::Sha256 as sha2::Digest>::finalize(output_digest)
            ),
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
                rules: mut encoded,
                findings,
                base_diagnostics,
                regex_diagnostics,
                lc_lines,
                lc_cultures,
                unit_rows,
                unit_sources,
                recorder,
                profile: evaluation_profile,
                #[cfg(test)]
                    digest: _,
            } = self.evaluate_findings(&program, &collator, cancelled, Some(&elapsed))?;
            let publish = Measure::start();
            let mut ordered = program.rules.iter().collect::<Vec<_>>();
            ordered.sort_by_key(|rule| rule.ordinal);
            let rules = ordered.iter().map(|compiled| json!({"id":compiled.rule.id,"ruleId":compiled.rule.rule_id.as_ref().unwrap_or(&compiled.rule.id),"kind":compiled.rule.kind,"label":compiled.rule.label,"subject":compiled.rule.subject,"family":compiled.rule.family,"severity":compiled.rule.severity,"role":compiled.rule.role})).collect::<Vec<_>>();
            let mut columns: Vec<Column> = vec![
                (
                    "subjects.line_culture.lines".into(),
                    String::new(),
                    lc_lines,
                ),
                (
                    "subjects.line_culture.cultures".into(),
                    String::new(),
                    lc_cultures,
                ),
                (
                    "subjects.unit_source.units".into(),
                    String::new(),
                    unit_rows,
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
                let RuleColumns {
                    rows,
                    cultures,
                    evidence,
                    places,
                    id0,
                    id1,
                } = std::mem::take(&mut encoded[compiled.ordinal]);
                let severity = rules[index]["severity"].as_str().unwrap_or("");
                if compiled.rule.subject == Subject::UnitSource {
                    if !rows.is_empty() {
                        *counts
                            .entry((index, u32::MAX, severity.into()))
                            .or_default() += rows.len() as u32;
                    }
                } else {
                    for ci in &cultures {
                        *counts.entry((index, *ci, severity.into())).or_default() += 1;
                    }
                }
                for (name, domain, values) in [
                    ("rows", "", rows),
                    ("cultures", "", cultures),
                    ("evidence", "findings", store.intern("findings", &evidence)?),
                    (
                        "places",
                        "findings.places",
                        store.intern("findings.places", &places)?,
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
            // Intern each code once, in first-use order, which assigns the same IDs as interning
            // every diagnostic's code.
            let mut used = Vec::new();
            for (_, _, code) in &diagnostics {
                if !used.contains(code) {
                    used.push(*code);
                }
            }
            let ids = store.intern(
                "findings",
                &used
                    .iter()
                    .map(|code| super::DIAGNOSTIC_CODES[*code as usize].to_owned())
                    .collect::<Vec<_>>(),
            )?;
            let mut table = [0; super::DIAGNOSTIC_CODES.len()];
            for (code, id) in used.into_iter().zip(ids) {
                table[code as usize] = id;
            }
            let codes = diagnostics
                .iter()
                .map(|(_, _, code)| table[*code as usize])
                .collect::<Vec<_>>();
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
            recorder.stage("layer.publish", &publish, findings);
            recorder.memory("layer.publish", super::stages::Memory::default());
            profile = evaluation_profile;
            profile["stages"] =
                recorder.profile(program.rules.len(), findings, diagnostics.len())["stages"].take();
            profile["wallMs"] = json!(elapsed.elapsed().as_secs_f64() * 1000.0);
        }
        drop(store);
        let layer = FindingsLayer::open(&self.configuration, &key, &self.reader.joined_key)?;
        let result = javascript_json(&layer.result(&key, &profile), false);
        self.findings.insert(key, layer);
        Ok(result)
    }
}

/// Each finding's published columns, in parallel. Evidence is written straight from the arena.
fn encode_findings(
    subjects: &mut NativeSubjects<'_>,
    program: &super::Program,
    arena: &super::columns::Arena,
    evaluated: &super::evaluator::Evaluated,
    measure: &mut Measure,
) -> Result<Vec<Encoded>> {
    let subject = subjects.subject;
    let lines = finding_lines(subjects, evaluated)?;
    let source_culture = source_cultures(subjects);
    let compiled = rules_by_ordinal(program);
    let cultures = &subjects.query.cultures;
    measure
        .parallel(&evaluated.findings, |finding| -> Result<Encoded> {
            let rule = compiled[finding.rule].ok_or("Missing finding rule.")?;
            let rule_id = rule.rule.rule_id.as_ref().unwrap_or(&rule.rule.id);
            let (line, culture) = match subject {
                Subject::Line => (finding.row as usize, source_culture(finding.row as usize)?),
                Subject::LineCulture => subjects.cultures[finding.row as usize],
                Subject::UnitSource => (subjects.units[finding.row as usize].unit, 0),
            };
            let evidence = finding.evidence;
            let encode = |atom, sorted| {
                let mut out = String::new();
                write_atom(arena, atom, sorted, &mut out);
                out
            };
            let actual = encode(evidence.actual, false);
            let expectation = encode(evidence.expectation, false);
            let identity = &lines[&line];
            let (_, hash) = if subject == Subject::UnitSource {
                source_identity_encoded(
                    rule_id,
                    rule.rule.role.as_deref(),
                    identity,
                    &rule.rule.kind,
                    &actual,
                    &expectation,
                    &finding.affected.ids,
                )
            } else {
                localization_identity_encoded(
                    identity,
                    &cultures[culture],
                    rule_id,
                    &rule.rule.kind,
                    &encode(evidence.actual, true),
                    &encode(evidence.expectation, true),
                )
            };
            let mut json =
                format!("{{\"actual\":{actual},\"expectation\":{expectation},\"recovery\":");
            write_string(arena.text(finding.recovery), &mut json);
            for (name, atom) in [
                ("fix", evidence.fix),
                ("extra", evidence.extra),
                ("translationOrigin", evidence.translation_origin),
            ] {
                if atom != super::columns::Atom::Null {
                    json.push_str(&format!(",\"{name}\":"));
                    write_atom(arena, atom, false, &mut json);
                }
            }
            json.push('}');
            let mut places = String::new();
            write_ids(
                &finding
                    .affected
                    .ids
                    .iter()
                    .map(Option::as_deref)
                    .collect::<Vec<_>>(),
                &mut places,
            );
            Ok(Encoded {
                row: finding.row,
                culture: culture as u32,
                evidence: Wtf8Buf::from_utf8(&json).into_view(),
                places: Wtf8Buf::from_utf8(&places).into_view(),
                hash,
            })
        })
        .into_iter()
        .collect()
}
/// The packed identity of every line or text unit with a finding.
fn finding_lines(
    subjects: &mut NativeSubjects<'_>,
    evaluated: &super::evaluator::Evaluated,
) -> Result<HashMap<usize, String>> {
    let mut lines = HashMap::new();
    for finding in &evaluated.findings {
        let row = finding.row as usize;
        let (kind, line) = match subjects.subject {
            Subject::Line => ("line", row),
            Subject::LineCulture => ("line", subjects.cultures[row].0),
            Subject::UnitSource => ("raw", subjects.units[row].unit),
        };
        if let std::collections::hash_map::Entry::Vacant(entry) = lines.entry(line) {
            entry.insert(subjects.query.packed(kind, line)?);
        }
    }
    Ok(lines)
}
/// A line's source culture: its native-culture translation row if it has one, else its first
/// culture row in collation order.
fn source_cultures<'a>(
    subjects: &'a NativeSubjects<'_>,
) -> impl Fn(usize) -> Result<usize> + Sync + 'a {
    let cultures = &subjects.query.cultures;
    let native = cultures
        .iter()
        .position(|culture| subjects.query.target["nativeCulture"] == *culture);
    let mut order = (0..cultures.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| subjects.collator.compare(&cultures[*a], &cultures[*b]));
    let projection = &subjects.projection;
    move |line| {
        let present = |ci: usize| projection.cultures[ci].state[line] != 8;
        native
            .filter(|ci| present(*ci))
            .or_else(|| order.iter().copied().find(|ci| present(*ci)))
            .ok_or_else(|| "A line finding has no source culture.".into())
    }
}
fn rules_by_ordinal(program: &super::Program) -> Vec<Option<&super::compiler::CompiledRule>> {
    let mut rules = Vec::new();
    for rule in &program.rules {
        if rules.len() <= rule.ordinal {
            rules.resize(rule.ordinal + 1, None);
        }
        rules[rule.ordinal] = Some(rule);
    }
    rules
}
/// The timing test's guard on the direct encoder: every finding must encode exactly as the
/// `serde_json::Value` path and the reference identity formulas do.
#[cfg(test)]
fn check_encoding(
    subjects: &mut NativeSubjects<'_>,
    program: &super::Program,
    arena: &super::columns::Arena,
    evaluated: &super::evaluator::Evaluated,
    encoded: &[Encoded],
) -> Result<()> {
    let lines = finding_lines(subjects, evaluated)?;
    let source_culture = source_cultures(subjects);
    let compiled = rules_by_ordinal(program);
    for (finding, encoded) in evaluated.findings.iter().zip(encoded) {
        let emission = finding.emission(arena);
        let rule = compiled[finding.rule].ok_or("Missing finding rule.")?;
        let rule_id = rule.rule.rule_id.as_ref().unwrap_or(&rule.rule.id);
        let (line, culture) = match subjects.subject {
            Subject::Line => (finding.row as usize, source_culture(finding.row as usize)?),
            Subject::LineCulture => subjects.cultures[finding.row as usize],
            Subject::UnitSource => (subjects.units[finding.row as usize].unit, 0),
        };
        let mut value = json!({"actual":emission.actual,"expectation":emission.expectation,"recovery":emission.recovery});
        for (name, item) in [
            ("fix", &emission.fix),
            ("extra", &emission.extra),
            ("translationOrigin", &emission.translation_origin),
        ] {
            if !item.is_null() {
                value[name] = item.clone();
            }
        }
        let (_, hash) = if subjects.subject == Subject::UnitSource {
            super::source_identity(
                rule_id,
                rule.rule.role.as_deref(),
                &lines[&line],
                &rule.rule.kind,
                &emission.actual,
                &emission.expectation,
                &finding.affected.ids,
            )
        } else {
            super::localization_identity(
                &lines[&line],
                &subjects.query.cultures[culture],
                rule_id,
                &rule.rule.kind,
                &emission.actual,
                &emission.expectation,
            )
        };
        require(
            encoded.evidence == Wtf8Buf::from_utf8(&javascript_json(&value, false)).into_view()
                && encoded.places
                    == Wtf8Buf::from_utf8(&javascript_json(&json!(finding.affected.ids), false))
                        .into_view()
                && encoded.hash == hash
                && encoded.culture == culture as u32,
            format!("Direct finding encoding differs for rule {rule_id}."),
        )?;
    }
    Ok(())
}
