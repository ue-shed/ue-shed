//! Persisted finding evidence, identities, and diagnostics for a pinned joined view.
use super::findings_merge::{
    CULTURE_RULE, LINE_RULE, LayerState, PROJECTION, Previous, StateNode, SubjectMerge,
};
use super::findings_order::{CHANGE, FIXABLE, Facts, KEYLESS, NONE, OrderInput, SHADOWED};
use super::identity::{
    localization_identity_encoded, source_identity_encoded, write_atom, write_string,
};
use super::replies::{
    EvaluationProfile, FindingsEvaluation, LayerMetadata, RuleCount, RuleMetadata, RunProfile,
};
use super::stages::{Measure, Phase, subject_stage};
use super::{HostCollator, NativeSubjects, Subject, compile, findings_merge, javascript_json};
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

pub(super) const VERSION: u32 = 6;
type Column = (String, String, Vec<u32>);
pub(crate) struct FindingsLayer {
    reader: Reader,
    pub(super) dictionary: EngineReader,
    record: Value,
    pub(super) metadata: LayerMetadata,
    columns: crate::cache::Memo<String, Arc<[u32]>>,
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
        let reader = Reader::open(&configuration.directory()?.join(file))?;
        let metadata: LayerMetadata =
            crate::json_value::parse_as(std::str::from_utf8(&section(&reader, "join.meta")?)?)?;
        require(
            metadata.joined_key == joined && metadata.version == VERSION,
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
            columns: Default::default(),
        })
    }
    pub(super) fn column(&self, name: &str) -> Result<Arc<[u32]>> {
        self.columns.get_or_try(name.into(), || {
            let bytes = section(&self.reader, name)?;
            Ok(if self.record["stringColumns"].get(name).is_some() {
                decode_ids(&bytes, self.record["idEncoding"] == "delta32")?
            } else {
                integers(&bytes)?
            }
            .into())
        })
    }
    pub(super) fn json(&self, id: u32) -> Result<Value> {
        crate::json_value::parse_stored(&self.dictionary.string(id)?)
    }
    /// A place set's occurrence IDs, in the order the finding names them.
    pub(super) fn place_set(&self, set: u32) -> Result<Vec<String>> {
        let offsets = self.column("places.offsets")?;
        let members = self.column("places.members")?;
        let (start, end) = (
            *offsets
                .get(set as usize)
                .ok_or("Place set outside layer.")? as usize,
            *offsets
                .get(set as usize + 1)
                .ok_or("Place set outside layer.")? as usize,
        );
        self.dictionary
            .strings_batch(members.get(start..end).ok_or("Invalid place set range.")?)
    }
    /// `findings_evaluate`'s reply for this layer.
    fn result(&self, key: &str, profile: EvaluationProfile) -> Result<String> {
        let reply = FindingsEvaluation {
            key: key.into(),
            rules: self.metadata.rules.clone(),
            counts: self.metadata.counts.clone(),
            diagnostic_count: self.metadata.diagnostic_count,
            roles: self.metadata.roles.clone(),
            collation: self.metadata.collation.clone(),
            profile,
        };
        Ok(javascript_json(&serde_json::to_value(&reply)?, false))
    }
}
/// One rule's finding columns, encoded as they are published: evidence JSON in the stored
/// string view, each finding's place set, and the identity hash halves.
#[derive(Default)]
pub(super) struct RuleColumns {
    rows: Vec<u32>,
    cultures: Vec<u32>,
    evidence: Vec<String>,
    places: Vec<Arc<super::Affected>>,
    id0: Vec<u32>,
    id1: Vec<u32>,
    /// What the layer's orders and flags read of each finding.
    facts: Vec<Facts>,
}
struct Encoded {
    row: u32,
    culture: u32,
    evidence: String,
    places: Arc<super::Affected>,
    hash: [u32; 2],
    /// The line row, or the unit row of a source finding, with `NONE` for the other.
    line: u32,
    unit: u32,
    actual: String,
    flags: u32,
}

/// Product evaluation before publication. The read-only retained-index test consumes this exact
/// recording and result; it never writes a findings layer into the retained checkout.
pub(super) struct EvaluatedFindings {
    /// Indexed by rule ordinal.
    rules: Vec<RuleColumns>,
    roles: Vec<super::replies::RoleTotal>,
    findings: usize,
    /// `(line, culture, code, origin)`.
    base_diagnostics: Vec<(u32, u32, u8, u8)>,
    regex_diagnostics: Vec<(u32, u32, u8, u8)>,
    /// The subjects an incremental evaluation evaluated only some rows of.
    merges: Vec<SubjectMerge>,
    /// Each subject's cross-row groups, for the next evaluation.
    groups: Vec<(Subject, Option<Vec<super::incremental::NodeGroups>>)>,
    lc_lines: Vec<u32>,
    lc_cultures: Vec<u32>,
    unit_rows: Vec<u32>,
    unit_sources: Vec<u32>,
    recorder: super::stages::Recorder,
    pub(super) profile: RunProfile,
    #[cfg(test)]
    pub(super) digest: String,
}
impl EngineQuery {
    /// Evaluation reads raw index columns into its own scope, never the query cache.
    pub(super) fn evaluate_findings(
        &self,
        program: &super::Program,
        collator: &HostCollator,
        cancelled: &AtomicBool,
        request: Option<&Measure>,
        reporter: Option<Arc<dyn crate::engine::Reporter>>,
        previous: Option<&Previous>,
    ) -> Result<EvaluatedFindings> {
        self.reader.begin_evaluation()?;
        let evaluated =
            self.evaluate_scoped(program, collator, cancelled, request, reporter, previous);
        self.reader.end_evaluation();
        evaluated
    }
    fn evaluate_scoped(
        &self,
        program: &super::Program,
        collator: &HostCollator,
        cancelled: &AtomicBool,
        request: Option<&Measure>,
        reporter: Option<Arc<dyn crate::engine::Reporter>>,
        previous: Option<&Previous>,
    ) -> Result<EvaluatedFindings> {
        let elapsed = Measure::start();
        #[cfg(test)]
        let mut elapsed = elapsed;
        let mut arena = super::columns::Arena::new(self.reader.dictionary_count()?)?;
        arena.recorder = super::stages::Recorder::at(request.unwrap_or(&elapsed));
        if let Some(reporter) = reporter {
            arena.recorder.report_to(reporter, program.rules.len());
        }
        let mut rules = (0..program
            .rules
            .iter()
            .map(|rule| rule.ordinal + 1)
            .max()
            .unwrap_or(0))
            .map(|_| RuleColumns::default())
            .collect::<Vec<_>>();
        let mut findings = 0;
        let mut previous_encoded = 0;
        let mut regex_diagnostics = Vec::new();
        let mut base_diagnostics = Vec::new();
        let recorder = arena.recorder.clone();
        let mut lc_lines = Vec::new();
        let mut lc_cultures = Vec::new();
        let mut unit_rows = Vec::new();
        let mut unit_sources = Vec::new();
        let mut merges = Vec::new();
        let mut node_groups = Vec::new();
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
        let roles = role_totals(self, program, &occurrences, &mut arena, cancelled)?;
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
            let delta = match previous {
                Some(previous) => previous.delta(
                    subject,
                    &subjects.cultures.lines,
                    subjects.cultures.cultures(),
                )?,
                None => None,
            };
            let mut evaluated = program.evaluate_shared(
                &mut subjects,
                collator,
                &mut arena,
                delta.as_ref().map(|(delta, _)| delta),
            )?;
            node_groups.push((subject, evaluated.groups.take()));
            if let (Some(rows), Some(previous), Some((_, map))) =
                (&evaluated.evaluated, previous, delta)
            {
                let lines = if subject == Subject::Line {
                    rows.clone()
                } else {
                    let mut lines = super::columns::Bits::new(previous.state.lines as usize);
                    for row in rows.ones() {
                        lines.set(subjects.cultures.lines[row as usize] as usize);
                    }
                    lines
                };
                merges.push(SubjectMerge {
                    subject,
                    evaluated: rows.clone(),
                    lines,
                    rows: map,
                });
            }
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
            let encoded_bytes = encoded
                .iter()
                .map(|encoded| encoded.evidence.capacity() + 16)
                .sum::<usize>();
            let mut keyless = HashMap::<usize, bool>::new();
            for (finding, encoded) in evaluated.findings.iter().zip(encoded) {
                checkpoint(cancelled)?;
                let mut facts = Facts {
                    rule: 0,
                    line: encoded.line,
                    unit: encoded.unit,
                    culture: if subject == Subject::UnitSource {
                        NONE
                    } else {
                        encoded.culture
                    },
                    flags: encoded.flags,
                    actual: encoded.actual,
                    source: String::new(),
                    first_rank: NONE,
                };
                if subject == Subject::UnitSource {
                    let unit = &subjects.units[finding.row as usize];
                    facts.source = subjects.query.reader.string(unit.source)?;
                    if let Some(Some(first)) = finding.affected.ids.first() {
                        facts.first_rank = subjects
                            .projection
                            .raw
                            .members(unit.unit)
                            .iter()
                            .position(|member| {
                                occurrences.id(*member as usize, &arena) == first.as_ref()
                            })
                            .map_or(NONE, |rank| rank as u32);
                    }
                } else {
                    let line = encoded.line as usize;
                    let without = match keyless.get(&line) {
                        Some(without) => *without,
                        None => {
                            let without = subjects.line_field(line, "identity")?.is_null();
                            keyless.insert(line, without);
                            without
                        }
                    };
                    if without {
                        facts.flags |= KEYLESS;
                    } else if facts.flags & CHANGE != 0
                        && let super::columns::Atom::Str(fix) = finding.evidence.fix
                    {
                        // A host accepts a change whose texts are each at most 16,384 UTF-16
                        // units (`BoundedChange`).
                        let bounded = |text: &str| {
                            crate::wtf8::Wtf8Buf::from_view(text).to_utf16().len() <= 16384
                        };
                        let ci = encoded.culture as usize;
                        let source = subjects.line_field(line, "comparisonSource")?;
                        let po = subjects.culture_field(line, ci, "po")?;
                        let previous = if po.is_null() {
                            subjects.culture_field(line, ci, "archive")?
                        } else {
                            po
                        };
                        if bounded(arena.text(fix))
                            && source.as_str().is_some_and(bounded)
                            && previous.as_str().is_none_or(bounded)
                        {
                            facts.flags |= FIXABLE;
                        }
                    }
                }
                let columns = &mut rules[finding.rule];
                columns.rows.push(encoded.row);
                if subject != Subject::UnitSource {
                    columns.cultures.push(encoded.culture);
                }
                columns.evidence.push(encoded.evidence);
                columns.places.push(encoded.places);
                columns.id0.push(encoded.hash[0]);
                columns.id1.push(encoded.hash[1]);
                columns.facts.push(facts);
            }
            let memory = arena.memory();
            let line_fields = arena
                .line_fields
                .values()
                .map(|column| column.bytes())
                .sum::<usize>();
            recorder.holders(
                subject_stage(subject, Phase::Emission),
                BTreeMap::from([
                    (
                        "arena",
                        (memory.arena_bytes + memory.side_dictionary_bytes) as u64,
                    ),
                    ("occurrences", memory.occurrence_relation_bytes as u64),
                    ("lineFields", line_fields as u64),
                    ("cultures", (subjects.cultures.len() * 8) as u64),
                    ("projection", subjects.projection.bytes() as u64),
                    ("reader", subjects.query.reader.cache_bytes() as u64),
                    ("encodedFindings", (encoded_bytes + previous_encoded) as u64),
                ]),
            );
            previous_encoded += encoded_bytes;
            for diagnostic in &evaluated.projection {
                let (line, ci) = subjects.cultures.at(diagnostic.row as usize);
                base_diagnostics.push((line as u32, ci as u32, diagnostic.code, PROJECTION));
            }
            if subject == Subject::LineCulture {
                lc_lines.extend_from_slice(&subjects.cultures.lines);
                lc_cultures.extend_from_slice(subjects.cultures.cultures());
            }
            if subject == Subject::UnitSource {
                for unit in subjects.units.iter() {
                    unit_rows.push(unit.unit as u32);
                    unit_sources.push(unit.source);
                }
            }
            for super::Diagnostic { row, code } in &evaluated.diagnostics {
                let row = *row as usize;
                if subject == Subject::LineCulture {
                    let (line, ci) = subjects.cultures.at(row);
                    regex_diagnostics.push((line as u32, ci as u32, *code, CULTURE_RULE));
                } else if subject == Subject::Line {
                    let culture = subjects.line_field(row, "sourceCulture")?;
                    if let Some(ci) = subjects
                        .query
                        .cultures
                        .iter()
                        .position(|value| Some(value.as_str()) == culture.as_str())
                    {
                        regex_diagnostics.push((row as u32, ci as u32, *code, LINE_RULE));
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
        profile.wall_ms = elapsed.wall().as_secs_f64() * 1000.0;
        Ok(EvaluatedFindings {
            rules,
            roles,
            findings,
            base_diagnostics,
            regex_diagnostics,
            merges,
            groups: node_groups,
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

    /// The layer's orders over its findings' facts, with the join's positions, each unit's rank
    /// in ID order and each line's packed ID.
    fn finding_orders(
        &self,
        facts: &[Facts],
        rules: &[RuleMetadata],
        diagnostic_lines: &[u32],
        collator: &HostCollator,
        cancelled: &AtomicBool,
    ) -> Result<super::findings_order::Orders> {
        let target = self.target["name"]
            .as_str()
            .ok_or("Missing target name.")?
            .to_owned();
        let request = crate::engine_types::Selection::lines(&target);
        let rows = self.matching(&request, cancelled)?;
        let mut join = vec![NONE; self.reader.column("line.source")?.len()];
        for (position, row) in rows.iter().enumerate() {
            *join
                .get_mut(*row as usize)
                .ok_or("Join row outside the lines.")? = u32::try_from(position)?;
        }
        let order = self.column("raw", "order")?;
        let mut unit_ranks = vec![NONE; order.len()];
        for (rank, unit) in order.iter().enumerate() {
            *unit_ranks
                .get_mut(*unit as usize)
                .ok_or("Unit order outside the units.")? = u32::try_from(rank)?;
        }
        let starts = self.identity_starts("line")?;
        let bytes = self.reader.bytes("query.line.id_utf8")?;
        let line_id = |row: u32| -> Result<String> {
            let row = row as usize;
            let begin = *starts.get(row).ok_or("Identity row outside index.")? as usize;
            let end = *starts.get(row + 1).ok_or("Identity end outside index.")? as usize;
            Wtf8Buf::from_bytes(
                bytes
                    .get(begin..end)
                    .ok_or("Invalid identity byte range.")?
                    .to_vec(),
            )
            .map(Wtf8Buf::into_view)
        };
        super::findings_order::orders(&OrderInput {
            facts,
            rules,
            cultures: &self.cultures,
            join: &join,
            unit_ranks: &unit_ranks,
            line_id: &line_id,
            diagnostic_lines,
            collator,
        })
    }

    pub fn findings_evaluate(
        &self,
        text: &str,
        locale: &str,
        cancelled: &AtomicBool,
    ) -> Result<String> {
        self.findings_evaluate_reporting(
            text,
            locale,
            cancelled,
            Arc::new(crate::engine::Unwatched),
        )
    }
    /// Evaluates a rule document, reporting each rule it evaluates to `reporter`.
    ///
    /// When the previous findings layer evaluated the same document over the same joined base,
    /// only the lines that changed since and the rows they share groups with are evaluated
    /// again; `UE_SHED_GAME_TEXT_FULL_EVALUATION` evaluates every row.
    pub fn findings_evaluate_reporting(
        &self,
        text: &str,
        locale: &str,
        cancelled: &AtomicBool,
        reporter: Arc<dyn crate::engine::Reporter>,
    ) -> Result<String> {
        let incremental = std::env::var_os("UE_SHED_GAME_TEXT_FULL_EVALUATION").is_none();
        self.findings_evaluate_with(text, locale, cancelled, reporter, incremental)
    }
    pub(crate) fn findings_evaluate_with(
        &self,
        text: &str,
        locale: &str,
        cancelled: &AtomicBool,
        reporter: Arc<dyn crate::engine::Reporter>,
        incremental: bool,
    ) -> Result<String> {
        let elapsed = Measure::start();
        checkpoint(cancelled)?;
        let program = compile(text)?;
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
            return layer.result(&key, EvaluationProfile::Cached);
        }
        // One evaluation of this reader at a time: it scopes the reader's column loads, and an
        // evaluation that waited here finds the layer another one published.
        let _evaluating = self.evaluation.lock();
        if let Some(layer) = self.findings.get(&key) {
            return layer.result(&key, EvaluationProfile::Cached);
        }
        let mut store = Store::writer(self.configuration.clone())?;
        require(
            store.root["generation"] == self.reader.generation,
            Error::new(
                ErrorCode::StaleGeneration,
                "The dictionary generation changed before rule evaluation.",
            ),
        )?;
        let mut profile = EvaluationProfile::Cached;
        if store.root["layers"].get(&key).is_none() {
            let document = digest(text.as_bytes());
            let reads_join_position = program.nodes.iter().any(|node| {
                matches!(&node.op, super::compiler::Op::Field(name) if name.ends_with("joinPosition"))
            });
            let opening = Measure::start();
            let mut previous = if incremental {
                Previous::open(
                    self,
                    &store.root,
                    &document,
                    locale,
                    &collator.locale,
                    reads_join_position,
                    cancelled,
                )?
            } else {
                None
            };
            let opened = usize::from(previous.is_some());
            let opened_in = opening.elapsed();
            let EvaluatedFindings {
                rules: mut encoded,
                roles,
                findings,
                base_diagnostics,
                regex_diagnostics,
                merges,
                groups: node_groups,
                lc_lines,
                lc_cultures,
                unit_rows,
                unit_sources,
                recorder,
                profile: evaluation_profile,
                #[cfg(test)]
                    digest: _,
            } = self.evaluate_findings(
                &program,
                &collator,
                cancelled,
                Some(&elapsed),
                Some(reporter),
                previous.as_ref(),
            )?;
            recorder.stage_elapsed("layer.previous", &opening, opened_in, opened);
            if merges.is_empty() {
                previous = None;
            }
            let publish = Measure::start();
            let mut ordered = program.rules.iter().collect::<Vec<_>>();
            ordered.sort_by_key(|rule| rule.ordinal);
            let rules = ordered
                .iter()
                .map(|compiled| {
                    let rule = &compiled.rule;
                    RuleMetadata {
                        id: rule.id.clone(),
                        rule_id: rule.rule_id.clone().unwrap_or_else(|| rule.id.clone()),
                        kind: rule.kind.clone(),
                        label: rule.label.clone(),
                        subject: rule.subject,
                        family: rule.family,
                        severity: rule.severity,
                        role: rule.role.clone(),
                        counts: rule.counts.unwrap_or(true),
                    }
                })
                .collect::<Vec<_>>();
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
            // Each occurrence ID is one dictionary string and each distinct place set one range of
            // them: a set can name thousands of occurrences, past one string's size cap.
            let mut id_rows = HashMap::<Arc<str>, usize>::new();
            let mut id_bytes = Vec::new();
            for rule in &encoded {
                for affected in &rule.places {
                    for id in &affected.ids {
                        let id = id.as_ref().ok_or("A finding occurrence has no ID.")?;
                        if !id_rows.contains_key(id) {
                            id_rows.insert(Arc::clone(id), id_bytes.len());
                            id_bytes.push(Wtf8Buf::from_view(id).into_bytes());
                        }
                    }
                }
            }
            let interned = store.intern_bytes("findings.places", &id_bytes)?;
            drop(id_bytes);
            let mut set_offsets = vec![0u32];
            let mut set_members = Vec::new();
            let mut sets = HashMap::<Vec<u32>, u32>::new();
            // Findings share their sets' allocations, so most repeats resolve by address, and kept
            // findings by their previous set.
            let mut shared = HashMap::<(bool, usize), u32>::new();
            let mut place_set = |place: Place<'_>| -> Result<u32> {
                let cached = match place {
                    Place::New(affected) => (false, Arc::as_ptr(affected) as usize),
                    Place::Kept(set) => (true, set as usize),
                };
                if let Some(set) = shared.get(&cached) {
                    return Ok(*set);
                }
                let members = match place {
                    Place::New(affected) => affected
                        .ids
                        .iter()
                        .map(|id| {
                            id.as_ref()
                                .map(|id| interned[id_rows[id]])
                                .ok_or_else(|| "A finding occurrence has no ID.".into())
                        })
                        .collect::<Result<Vec<_>>>()?,
                    Place::Kept(set) => previous
                        .as_ref()
                        .ok_or("A kept finding without a previous layer.")?
                        .place_set(set)?,
                };
                let next = u32::try_from(set_offsets.len() - 1)?;
                let set = *sets.entry(members).or_insert_with_key(|members| {
                    set_members.extend_from_slice(members);
                    next
                });
                if set == next {
                    set_offsets.push(u32::try_from(set_members.len())?);
                }
                shared.insert(cached, set);
                Ok(set)
            };
            let mut counts = BTreeMap::<(usize, u32), u32>::new();
            let mut facts = Vec::with_capacity(findings);
            let merge_started = Measure::start();
            let mut kept_findings = 0;
            // Where each rule's facts start in the previous layer.
            let mut previous_start = 0;
            for (index, compiled) in ordered.iter().enumerate() {
                checkpoint(cancelled)?;
                let RuleColumns {
                    rows,
                    cultures,
                    evidence,
                    places,
                    id0,
                    id1,
                    facts: mut rule_facts,
                } = std::mem::take(&mut encoded[compiled.ordinal]);
                let evidence = store.intern("findings", &evidence)?;
                let kept = match &previous {
                    Some(previous) => {
                        let start = previous_start;
                        previous_start += previous.column(&format!("r{index}.rows"))?.len();
                        merges
                            .iter()
                            .find(|merge| merge.subject == compiled.rule.subject)
                            .map(|merge| previous.kept(index, start, merge))
                            .transpose()?
                    }
                    None => None,
                };
                let kept = kept.unwrap_or_default();
                kept_findings += kept.rows.len();
                // The evaluated and the kept findings, each in row order, on distinct rows.
                let mut order = Vec::with_capacity(rows.len() + kept.rows.len());
                let (mut new, mut old) = (0, 0);
                while new < rows.len() || old < kept.rows.len() {
                    if old == kept.rows.len() || new < rows.len() && rows[new] < kept.rows[old] {
                        order.push(Ok(new));
                        new += 1;
                    } else {
                        order.push(Err(old));
                        old += 1;
                    }
                }
                let mut merged = RuleOutput::default();
                let mut kept_facts = kept.facts;
                for item in order {
                    match item {
                        Ok(at) => {
                            merged.rows.push(rows[at]);
                            if let Some(culture) = cultures.get(at) {
                                merged.cultures.push(*culture);
                            }
                            merged.evidence.push(evidence[at]);
                            merged.places.push(place_set(Place::New(&places[at]))?);
                            merged.id0.push(id0[at]);
                            merged.id1.push(id1[at]);
                            facts.push(std::mem::take(&mut rule_facts[at]));
                        }
                        Err(at) => {
                            merged.rows.push(kept.rows[at]);
                            merged.cultures.push(kept.cultures[at]);
                            merged.evidence.push(kept.evidence[at]);
                            merged.places.push(place_set(Place::Kept(kept.places[at]))?);
                            merged.id0.push(kept.id0[at]);
                            merged.id1.push(kept.id1[at]);
                            facts.push(std::mem::take(&mut kept_facts[at]));
                        }
                    }
                }
                let RuleOutput {
                    rows,
                    cultures,
                    evidence,
                    places,
                    id0,
                    id1,
                } = merged;
                let rule = u32::try_from(index)?;
                let first = facts.len() - rows.len();
                for fact in &mut facts[first..] {
                    fact.rule = rule;
                }
                // A rule has one severity, so rule and culture key its count.
                if compiled.rule.subject == Subject::UnitSource {
                    if !rows.is_empty() {
                        *counts.entry((index, u32::MAX)).or_default() += rows.len() as u32;
                    }
                } else {
                    for ci in &cultures {
                        *counts.entry((index, *ci)).or_default() += 1;
                    }
                }
                for (name, domain, values) in [
                    ("rows", "", rows),
                    ("cultures", "", cultures),
                    ("evidence", "findings", evidence),
                    ("places", "", places),
                    ("id0", "", id0),
                    ("id1", "", id1),
                ] {
                    columns.push((format!("r{index}.{name}"), domain.into(), values));
                }
            }
            recorder.stage("layer.merge", &merge_started, kept_findings);
            columns.push(("places.offsets".into(), String::new(), set_offsets));
            columns.push((
                "places.members".into(),
                "findings.places".into(),
                set_members,
            ));
            // A line's diagnostics come from one evaluation per origin: the previous layer's on
            // lines this one didn't evaluate.
            let mut diagnostics = match &previous {
                Some(previous) => previous.kept_diagnostics(&merges)?,
                None => Vec::new(),
            };
            diagnostics.extend(base_diagnostics);
            diagnostics.extend(regex_diagnostics);
            diagnostics.sort_by_key(|(line, _, _, origin)| (*line, *origin));
            // Intern each code once, in first-use order, which assigns the same IDs as interning
            // every diagnostic's code.
            let mut used = Vec::new();
            for (_, _, code, _) in &diagnostics {
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
                .map(|(_, _, code, _)| table[*code as usize])
                .collect::<Vec<_>>();
            columns.push((
                "diag.rows".into(),
                String::new(),
                diagnostics.iter().map(|(line, _, _, _)| *line).collect(),
            ));
            columns.push((
                "diag.cultures".into(),
                String::new(),
                diagnostics.iter().map(|(_, ci, _, _)| *ci).collect(),
            ));
            columns.push(("diag.codes".into(), "findings".into(), codes));
            columns.push((
                "diag.origin".into(),
                String::new(),
                diagnostics
                    .iter()
                    .map(|(_, _, _, origin)| u32::from(*origin))
                    .collect(),
            ));
            drop(previous);
            let (actual_ends, actual_bytes) =
                findings_merge::pack_strings(facts.iter().map(|fact| fact.actual.as_str()))?;
            let order_started = Measure::start();
            let orders = self.finding_orders(
                &facts,
                &rules,
                &diagnostics
                    .iter()
                    .map(|(line, _, _, _)| *line)
                    .collect::<Vec<_>>(),
                &collator,
                cancelled,
            )?;
            for (name, values) in [
                ("f.rule", facts.iter().map(|fact| fact.rule).collect()),
                ("f.line", facts.iter().map(|fact| fact.line).collect()),
                ("f.unit", facts.iter().map(|fact| fact.unit).collect()),
                ("f.culture", facts.iter().map(|fact| fact.culture).collect()),
                ("f.flags", facts.iter().map(|fact| fact.flags).collect()),
                ("f.actual.ends", actual_ends),
                ("f.actual.bytes", actual_bytes),
                ("order.report", orders.report),
                ("order.line", orders.line),
                ("order.source", orders.source),
                ("diag.order", orders.diagnostics),
            ] {
                columns.push((name.into(), String::new(), values));
            }
            drop(facts);
            recorder.stage("layer.order", &order_started, findings);
            // What the next evaluation compares with: each cross-row node's groups, the lines
            // the joined overlay rewrote, and join membership when a rule reads it.
            let lines = self.reader.column("line.source")?.len();
            let mut state = LayerState {
                base: findings_merge::joined_base(self),
                document,
                locale: locale.to_owned(),
                lines: u32::try_from(lines)?,
                incremental: true,
                nodes: Vec::new(),
                join: reads_join_position,
            };
            for (subject, groups) in node_groups {
                if subject == Subject::UnitSource {
                    continue;
                }
                let Some(groups) = groups else {
                    state.incremental = false;
                    continue;
                };
                for groups in groups {
                    for (name, values) in findings_merge::state_columns(subject, &groups)? {
                        columns.push((name, String::new(), values));
                    }
                    state.nodes.push(StateNode {
                        subject,
                        node: u32::try_from(groups.node)?,
                        corpus: groups.table.is_some(),
                        sited: groups.starts.is_some(),
                    });
                }
            }
            columns.push((
                "state.patch_rows".into(),
                String::new(),
                findings_merge::patch_rows(self)?.to_vec(),
            ));
            if reads_join_position {
                columns.push((
                    "state.join".into(),
                    String::new(),
                    findings_merge::join_membership(self, lines, cancelled)?,
                ));
            }
            let counts = counts
                .into_iter()
                .map(|((rule, culture), count)| {
                    Ok(RuleCount {
                        rule: rule.try_into()?,
                        culture: (culture != u32::MAX)
                            .then(|| self.cultures[culture as usize].clone()),
                        severity: rules[rule].severity,
                        count,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let metadata = LayerMetadata {
                version: VERSION,
                joined_key: self.reader.joined_key.clone(),
                collation: collator.locale.clone(),
                rules,
                counts,
                diagnostic_count: diagnostics.len().try_into()?,
                roles,
                state: Some(state),
            };
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
            let mut run = evaluation_profile;
            run.stages = recorder
                .profile(program.rules.len(), findings, diagnostics.len())
                .stages;
            run.wall_ms = elapsed.elapsed().as_secs_f64() * 1000.0;
            profile = EvaluationProfile::Run(Box::new(run));
        }
        drop(store);
        let layer = FindingsLayer::open(&self.configuration, &key, &self.reader.joined_key)?;
        let result = layer.result(&key, profile)?;
        self.findings.store(key, Arc::new(layer));
        Ok(result)
    }
}

/// Every section of a findings layer, its strings resolved, for comparing layers.
#[cfg(test)]
pub(crate) fn findings_dump(
    configuration: &Configuration,
    key: &str,
    joined: &str,
) -> Result<Value> {
    let layer = FindingsLayer::open(configuration, key, joined)?;
    let mut sections = serde_json::Map::new();
    for entry in &layer.reader.entries {
        let name = entry.name.as_str();
        let value = match name {
            "shared.meta" => continue,
            "join.meta" => serde_json::from_slice(&section(&layer.reader, name)?)?,
            _ if layer.record["stringColumns"].get(name).is_some() => {
                json!(layer.dictionary.strings_batch(&layer.column(name)?)?)
            }
            _ => json!(layer.column(name)?.to_vec()),
        };
        sections.insert(name.to_owned(), value);
    }
    Ok(Value::Object(sections))
}

/// A finding's place set while the layer is built: evaluated, or kept from the previous layer.
#[derive(Clone, Copy)]
enum Place<'a> {
    New(&'a Arc<super::Affected>),
    Kept(u32),
}
/// One rule's published columns.
#[derive(Default)]
struct RuleOutput {
    rows: Vec<u32>,
    cultures: Vec<u32>,
    evidence: Vec<u32>,
    places: Vec<u32>,
    id0: Vec<u32>,
    id1: Vec<u32>,
}

/// Whether a role's scopes match a place: `role_matches` over the occurrence relation's fields.
fn role_matches(
    occurrences: &super::occurrences::OccurrenceData,
    arena: &super::columns::Arena,
    row: usize,
    role: &super::ir::Role,
) -> bool {
    use super::columns::StrId;
    use super::ir::{MatchOperator, MatcherKind};
    let text = |field| arena.text(StrId(occurrences.value(row, field)));
    let kind = match occurrences.value(row, "location") {
        0 => "asset_property",
        1 => "data_table_cell",
        _ => "string_table_entry",
    };
    role.scopes.iter().any(|scope| {
        scope.matchers.iter().all(|matcher| {
            let actual = match matcher.kind {
                MatcherKind::LocationKind => Some(kind),
                MatcherKind::ObjectPath => Some(text("object")),
                MatcherKind::Row if kind == "data_table_cell" => Some(text("row")),
                MatcherKind::PropertyPath if kind != "string_table_entry" => Some(text("property")),
                MatcherKind::StringTableEntry if kind == "string_table_entry" => Some(text("row")),
                MatcherKind::ClassPath if kind == "asset_property" => Some(text("class")),
                _ => None,
            };
            actual.is_some_and(|actual| {
                if matcher.kind == MatcherKind::LocationKind
                    || matcher.operator == Some(MatchOperator::Exact)
                {
                    actual == matcher.value
                } else {
                    actual.starts_with(&matcher.value)
                }
            })
        })
    })
}

/// Each document role's places and units over the visible units, in the document's order.
fn role_totals(
    query: &EngineQuery,
    program: &super::Program,
    occurrences: &super::occurrences::OccurrenceData,
    arena: &mut super::columns::Arena,
    cancelled: &AtomicBool,
) -> Result<Vec<super::replies::RoleTotal>> {
    use super::ir::MatcherKind;
    use rayon::prelude::*;
    if program.document_roles.is_empty() {
        return Ok(Vec::new());
    }
    // The arena resolves only loaded strings: load each field a role's matchers read.
    let mut fields = std::collections::BTreeSet::new();
    for id in &program.document_roles {
        let role = program.roles.get(id).ok_or("A document role is missing.")?;
        for matcher in role.scopes.iter().flat_map(|scope| &scope.matchers) {
            fields.insert(match matcher.kind {
                MatcherKind::LocationKind => continue,
                MatcherKind::ObjectPath => "object",
                MatcherKind::Row | MatcherKind::StringTableEntry => "row",
                MatcherKind::PropertyPath => "property",
                MatcherKind::ClassPath => "class",
            });
        }
    }
    for field in fields {
        let mut ids = occurrences.columns[field].to_vec();
        ids.sort_unstable();
        ids.dedup();
        arena.load_strings(&query.reader, &ids)?;
    }
    let arena = &*arena;
    let projection = crate::engine_match::Projection::open(query, cancelled)?;
    let units = (0..projection.raw.visible.len())
        .filter(|unit| projection.raw.visible[*unit] != 0)
        .collect::<Vec<_>>();
    program
        .document_roles
        .iter()
        .map(|id| {
            checkpoint(cancelled)?;
            let role = program.roles.get(id).ok_or("A document role is missing.")?;
            let (places, matched) = units
                .par_iter()
                .map(|unit| {
                    let places = projection
                        .raw
                        .members(*unit)
                        .iter()
                        .filter(|member| role_matches(occurrences, arena, **member as usize, role))
                        .count();
                    (places, usize::from(places > 0))
                })
                .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
            Ok(super::replies::RoleTotal {
                role: id.clone(),
                matched_occurrences: u32::try_from(places)?,
                matched_text_units: u32::try_from(matched)?,
            })
        })
        .collect()
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
                Subject::LineCulture => subjects.cultures.at(finding.row as usize),
                Subject::UnitSource => (subjects.units[finding.row as usize].unit, 0),
            };
            let evidence = finding.evidence;
            let mut flags = 0;
            if matches!(evidence.fix, super::columns::Atom::Str(_)) {
                flags |= CHANGE;
            }
            if evidence.shadowed.boolean() {
                flags |= SHADOWED;
            }
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
            let (line, unit) = if subject == Subject::UnitSource {
                (NONE, line as u32)
            } else {
                (line as u32, NONE)
            };
            Ok(Encoded {
                row: finding.row,
                culture: culture as u32,
                evidence: Wtf8Buf::from_utf8(&json).into_view(),
                places: Arc::clone(&finding.affected),
                hash,
                line,
                unit,
                actual,
                flags,
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
            Subject::LineCulture => ("line", subjects.cultures.at(row).0),
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
            Subject::LineCulture => subjects.cultures.at(finding.row as usize),
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
                && encoded.places.ids == finding.affected.ids
                && encoded.hash == hash
                && encoded.culture == culture as u32,
            format!("Direct finding encoding differs for rule {rule_id}."),
        )?;
    }
    Ok(())
}
