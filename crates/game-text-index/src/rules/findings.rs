//! Persisted finding evidence, identities, and diagnostics for a pinned joined view.
use super::{
    Emission, HostCollator, NativeSubjects, Subject, SubjectRows, compile, javascript_json,
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

const VERSION: u32 = 1;
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
    fn result(&self, key: &str) -> Value {
        json!({"key":key,"rules":self.metadata["rules"],"counts":self.metadata["counts"],"diagnosticCount":self.metadata["diagnosticCount"],"collation":self.metadata["collation"]})
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
fn diagnostics(
    query: &mut EngineQuery,
    collator: &HostCollator,
    cancelled: &AtomicBool,
) -> Result<Vec<(u32, u32, String)>> {
    let mut rows = NativeSubjects::new(query, Subject::LineCulture, collator, cancelled)?;
    let mut by_line = BTreeMap::<usize, Vec<(usize, usize)>>::new();
    for (row, (line, ci)) in rows.cultures.iter().copied().enumerate() {
        by_line.entry(line).or_default().push((row, ci));
    }
    let mut output = Vec::new();
    for (line, cultures) in by_line {
        checkpoint(cancelled)?;
        for (row, ci) in &cultures {
            for code in rows
                .field(*row, "unknownReasons")?
                .as_array()
                .ok_or("Missing unknown reasons.")?
            {
                output.push((
                    line as u32,
                    *ci as u32,
                    code.as_str().ok_or("Invalid unknown reason.")?.into(),
                ));
            }
            if rows.field(*row, "reducedSourceChecking")?.as_bool() == Some(true) {
                output.push((line as u32, *ci as u32, "reduced_source_checking".into()));
            }
        }
        if rows.line_field(line, "checkable")?.as_bool() != Some(true) {
            continue;
        }
        for (row, ci) in cultures {
            let culture = rows.field(row, "culture")?;
            let culture = culture.as_str().ok_or("Missing culture.")?;
            if rows.line_field(line, "gathered")?.as_bool() != Some(true) {
                output.push((line as u32, ci as u32, "source_unavailable".into()));
            }
            let latest = rows.field(row, "latest")?;
            if rows.line_field(line, "comparable")?.as_bool() != Some(true) {
                if latest.is_null() {
                    output.push((line as u32, ci as u32, "translation_unavailable".into()));
                }
                continue;
            }
            let source = rows.line_field(line, "comparisonSource")?;
            for issue in super::grammar::format_pattern(
                source.as_str().ok_or("Missing comparison source.")?,
                culture,
            )
            .issues
            {
                if matches!(issue.code.as_str(), "unsupported_culture" | "syntax_limit") {
                    output.push((line as u32, ci as u32, issue.code));
                }
            }
            if latest.is_null() {
                output.push((line as u32, ci as u32, "translation_unavailable".into()));
                continue;
            }
            for issue in super::grammar::format_pattern(
                latest.as_str().ok_or("Invalid latest translation.")?,
                culture,
            )
            .issues
            {
                if matches!(issue.code.as_str(), "unsupported_culture" | "syntax_limit") {
                    output.push((line as u32, ci as u32, issue.code));
                }
            }
        }
    }
    Ok(output)
}

impl EngineQuery {
    pub fn findings_evaluate(
        &mut self,
        rules_file: &std::path::Path,
        locale: &str,
        cancelled: &AtomicBool,
    ) -> Result<String> {
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
            return Ok(javascript_json(&layer.result(&key), false));
        }
        let mut store = Store::writer(self.configuration.clone())?;
        require(
            store.root["generation"] == self.reader.generation,
            Error::new(
                ErrorCode::StaleGeneration,
                "The dictionary generation changed before rule evaluation.",
            ),
        )?;
        if store.root["layers"].get(&key).is_none() {
            let mut all = Vec::<Emission>::new();
            let mut regex_diagnostics = Vec::new();
            let mut lc_lines = Vec::new();
            let mut lc_cultures = Vec::new();
            let mut unit_rows = Vec::new();
            let mut unit_sources = Vec::new();
            for subject in [Subject::Line, Subject::LineCulture, Subject::UnitSource] {
                let mut subjects = NativeSubjects::new(self, subject, &collator, cancelled)?;
                let evaluation = program.evaluate(&mut subjects, &collator)?;
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
                for finding in findings {
                    let (line, ci) = match finding.subject {
                        Subject::Line => (finding.row, source_cultures[finding.row] as usize),
                        Subject::LineCulture => (
                            lc_lines[finding.row] as usize,
                            lc_cultures[finding.row] as usize,
                        ),
                        Subject::UnitSource => (unit_rows[finding.row] as usize, 0),
                    };
                    let rule = metadata["ruleId"]
                        .as_str()
                        .ok_or("Missing finding rule ID.")?;
                    let kind = metadata["kind"].as_str().ok_or("Missing finding kind.")?;
                    let (_, hash) = if finding.subject == Subject::UnitSource {
                        source_identity(
                            rule,
                            metadata["role"].as_str(),
                            &self.packed("raw", line)?,
                            kind,
                            &finding.actual,
                            &finding.expectation,
                            &finding.affected,
                        )
                    } else {
                        localization_identity(
                            &self.packed("line", line)?,
                            &self.cultures[ci],
                            rule,
                            kind,
                            &finding.actual,
                            &finding.expectation,
                        )
                    };
                    rows.push(finding.row as u32);
                    if finding.subject != Subject::UnitSource {
                        cultures.push(ci as u32);
                    }
                    // Recovery may be an expression, so its observed text travels with sparse evidence.
                    let mut value = json!({"actual":finding.actual,"expectation":finding.expectation,"recovery":finding.recovery});
                    for (name, item) in [
                        ("fix", &finding.fix),
                        ("extra", &finding.extra),
                        ("translationOrigin", &finding.translation_origin),
                    ] {
                        if !item.is_null() {
                            value[name] = item.clone();
                        }
                    }
                    evidence.push(value);
                    places.push(json!(
                        finding
                            .affected
                            .iter()
                            .map(|occurrence| occurrence["id"].clone())
                            .collect::<Vec<_>>()
                    ));
                    id0.push(hash[0]);
                    id1.push(hash[1]);
                    *counts
                        .entry((
                            index,
                            if finding.subject == Subject::UnitSource {
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
            let mut diagnostics = diagnostics(self, &collator, cancelled)?;
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
        }
        drop(store);
        let layer = FindingsLayer::open(&self.configuration, &key, &self.reader.joined_key)?;
        let result = javascript_json(&layer.result(&key), false);
        self.findings.insert(key, layer);
        Ok(result)
    }
}
