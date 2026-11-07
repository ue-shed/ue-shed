//! What finding rows read of a layer: review acceptance (`findings_accept`), the layer's
//! columns, which findings a text search keeps, and findings composed in the host's shape.
use super::findings_order::NONE;
use super::findings_read::{compose_line_finding, compose_unit_finding};
use super::ir::Severity;
use super::replies::{LineDiagnostic, PlaceSet};
use super::{FindingsLayer, HostCollator, NativeSubjects, Subject, javascript_json};
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::engine_rows::RowSet;
use crate::engine_types::{Selection, TextSearch};
use crate::store::digest;
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;
#[cfg(test)]
use ts_rs::TS;

/// Accepted findings one `findings_accept` call takes; larger review files are sent in chunks.
const MAX_ACCEPTED: usize = 5000;
/// Findings one page of finding rows returns, and one composed batch of a write.
pub(super) const MAX_LIMIT: usize = 5000;

fn invalid(message: &str) -> Error {
    Error::new(ErrorCode::InvalidInput, message)
}

/// One accepted finding from a review file.
#[derive(Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AcceptedFinding {
    check: String,
    #[cfg_attr(test, ts(optional))]
    culture: Option<String>,
    namespace: String,
    key: String,
    fingerprint: String,
}

/// `findings_accept`: up to 5,000 of a review's accepted findings, added to `previous`'s.
#[derive(Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FindingsAcceptRequest {
    key: String,
    #[cfg_attr(test, ts(optional))]
    previous: Option<String>,
    accepted: Vec<AcceptedFinding>,
}

/// The findings a review accepted, as (line row, culture index, rule ID): each entry whose line
/// and culture exist and whose fingerprint is the line's current one for that culture.
pub(crate) struct Acceptance {
    pub(super) layer: String,
    pub(super) entries: HashSet<(u32, u32, String)>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
pub(crate) struct CodeCount {
    pub(super) code: String,
    pub(super) count: u32,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "FindingDiagnostics"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct Diagnostics {
    pub(super) total: u32,
    pub(super) rows: Vec<LineDiagnostic>,
}

pub(super) const SEVERITIES: [(Severity, &str); 3] = [
    (Severity::Blocking, "blocking"),
    (Severity::Normal, "normal"),
    (Severity::Low, "low"),
];

/// A finding ID's identity lanes, for a line finding or a source finding.
pub(super) fn id_lanes(id: &str) -> Option<(bool, u32, u32)> {
    if let Some(hex) = id.strip_prefix("localization-finding:") {
        if hex.len() != 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        return Some((
            true,
            u32::from_str_radix(&hex[..8], 16).ok()?,
            u32::from_str_radix(&hex[8..], 16).ok()?,
        ));
    }
    let hex = id.strip_prefix("quality-finding:")?;
    let hash = u64::from_str_radix(hex, 16).ok()?;
    // Source IDs print the hash without leading zeros.
    (format!("{hash:x}") == hex).then_some((false, (hash >> 32) as u32, hash as u32))
}

impl EngineQuery {
    /// Each line's rows by (namespace, key) string IDs, built once per reader.
    fn identity_lines(&self) -> Result<crate::engine_query::IdentityLines> {
        if let Some(lines) = self.identity_lines.get() {
            return Ok(lines);
        }
        let namespaces = self.reader.column("line.namespace")?;
        let keys = self.reader.column("line.key")?;
        let mut lines = HashMap::<(u32, u32), Vec<u32>>::new();
        for (row, (namespace, key)) in namespaces.iter().zip(keys.iter()).enumerate() {
            lines
                .entry((*namespace, *key))
                .or_default()
                .push(u32::try_from(row)?);
        }
        Ok(self.identity_lines.store(Arc::new(lines)))
    }

    pub fn findings_accept(
        &self,
        request: serde_json::Value,
        cancelled: &AtomicBool,
    ) -> Result<String> {
        let request: FindingsAcceptRequest = serde_json::from_value(request).map_err(|source| {
            Error::with_source(ErrorCode::InvalidInput, "Invalid acceptance.", source)
        })?;
        require(
            request.accepted.len() <= MAX_ACCEPTED,
            invalid("At most 5000 accepted findings may be sent at once."),
        )?;
        let collation = self.layer(&request.key)?.metadata.collation.clone();
        let mut entries = match &request.previous {
            Some(previous) => {
                let previous = self
                    .acceptances
                    .get(previous)
                    .ok_or_else(|| invalid("The previous acceptance is not open."))?;
                require(
                    previous.layer == request.key,
                    invalid("The previous acceptance belongs to other findings."),
                )?;
                previous.entries.clone()
            }
            None => HashSet::new(),
        };
        let lines = self.identity_lines()?;
        let collator = HostCollator::new(&collation)?;
        let cultures = self.cultures.clone();
        let mut subjects = NativeSubjects::new(self, Subject::Line, &collator, cancelled)?;
        for entry in &request.accepted {
            checkpoint(cancelled)?;
            let Some(ci) = entry
                .culture
                .as_ref()
                .and_then(|culture| cultures.iter().position(|value| value == culture))
            else {
                continue;
            };
            let (Some(namespace), Some(key)) = (
                subjects.query.reader.find_string(&entry.namespace)?,
                subjects.query.reader.find_string(&entry.key)?,
            ) else {
                continue;
            };
            for line in lines.get(&(namespace, key)).into_iter().flatten() {
                let line = *line as usize;
                // Accepting needs the culture to have a mark on the line.
                if subjects.projection.cultures[ci].state[line] == 8 {
                    continue;
                }
                let manifest = subjects.line_field(line, "manifestSource")?;
                let source = if manifest.is_null() {
                    subjects.line_field(line, "source")?
                } else {
                    manifest
                };
                let origin = subjects.culture_field(line, ci, "latestOrigin")?;
                let translation = subjects.culture_field(
                    line,
                    ci,
                    if origin == "po" { "po" } else { "archive" },
                )?;
                let fingerprint =
                    review_fingerprint(source.as_str().unwrap_or(""), translation.as_str());
                if fingerprint == entry.fingerprint {
                    entries.insert((
                        u32::try_from(line)?,
                        u32::try_from(ci)?,
                        entry.check.clone(),
                    ));
                }
            }
        }
        drop(subjects);
        let key = format!(
            "acceptance-v1:{}",
            digest(
                javascript_json(
                    &json!([
                        "acceptance-v1",
                        request.key,
                        request.previous,
                        digest(serde_json::to_string(&request.accepted)?.as_bytes())
                    ]),
                    false
                )
                .as_bytes()
            )
        );
        self.acceptances.store(
            key.clone(),
            Arc::new(Acceptance {
                layer: request.key,
                entries,
            }),
        );
        Ok(javascript_json(&json!({ "acceptance": key }), false))
    }
}

/// `localizationReviewFingerprint`: SHA-256 of the source, a NUL, and the translation or a
/// marker for none, over the UTF-8 a host's `TextEncoder` writes.
pub(super) fn review_fingerprint(source: &str, translation: Option<&str>) -> String {
    let utf8 =
        |view: &str| String::from_utf16_lossy(&crate::wtf8::Wtf8Buf::from_view(view).to_utf16());
    digest(
        format!(
            "{}\0{}",
            utf8(source),
            translation.map_or_else(|| "\0absent".to_owned(), utf8)
        )
        .as_bytes(),
    )
}

/// The layer's columns a query reads.
pub(super) struct Columns {
    pub(super) rule: Arc<[u32]>,
    pub(super) line: Arc<[u32]>,
    pub(super) culture: Arc<[u32]>,
    pub(super) flags: Arc<[u32]>,
    /// Each rule's first finding number, then the count.
    pub(super) bases: Vec<u32>,
    id0: Vec<Arc<[u32]>>,
    id1: Vec<Arc<[u32]>>,
}

pub(super) fn columns(layer: &FindingsLayer) -> Result<Columns> {
    let mut bases = vec![0u32];
    let mut id0 = Vec::new();
    let mut id1 = Vec::new();
    for rule in 0..layer.metadata.rules.len() {
        let lanes = (
            layer.column(&format!("r{rule}.id0"))?,
            layer.column(&format!("r{rule}.id1"))?,
        );
        bases.push(
            bases[rule]
                .checked_add(u32::try_from(lanes.0.len())?)
                .ok_or("Too many findings.")?,
        );
        id0.push(lanes.0);
        id1.push(lanes.1);
    }
    let result = Columns {
        rule: layer.column("f.rule")?,
        line: layer.column("f.line")?,
        culture: layer.column("f.culture")?,
        flags: layer.column("f.flags")?,
        bases,
        id0,
        id1,
    };
    let count = *result.bases.last().unwrap_or(&0) as usize;
    require(
        [
            result.rule.len(),
            result.line.len(),
            result.culture.len(),
            result.flags.len(),
        ]
        .into_iter()
        .all(|len| len == count),
        "Invalid finding column lengths.",
    )?;
    Ok(result)
}

impl Columns {
    pub(super) fn lanes(&self, number: u32) -> (u32, u32) {
        let rule = self.rule[number as usize] as usize;
        let position = (number - self.bases[rule]) as usize;
        (self.id0[rule][position], self.id1[rule][position])
    }
}

/// The rows a line search keeps: by culture index, the line rows for findings of that culture;
/// `any`, for findings without one; `sources`, how source findings match.
pub(super) struct LineMatches {
    cultures: Vec<RowSet>,
    any: RowSet,
    sources: Option<SourceMatches>,
}

/// A source finding's own source text against each search term. A unit can hold several
/// conflicting sources, each its own finding subject, so a finding matches only when every term
/// is in its own source, not in the unit's sources together.
struct SourceMatches {
    /// Each term's match by string ID, as the Text tab's source search reads it.
    terms: Vec<Arc<[u8]>>,
    /// Each source rule's finding subject rows; empty for other rules.
    rows: Vec<Arc<[u32]>>,
    /// Each `unit_source` subject row's source string.
    sources: Arc<[u32]>,
}

impl LineMatches {
    /// Each set is the Text tab's `matching` for the search in one culture scope, so its atoms
    /// are cached with the Text tab's.
    pub(super) fn open(
        query: &EngineQuery,
        layer: &FindingsLayer,
        text: &str,
        culture: Option<u32>,
        cancelled: &AtomicBool,
    ) -> Result<Self> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("findingsLines");
        let target = query.target["name"]
            .as_str()
            .ok_or("The findings' target has no name.")?
            .to_owned();
        // Blank text keeps every finding.
        let text = Some(text).filter(|text| !text.trim().is_empty());
        let lines = query.reader.column("line.source")?.len();
        let select = |culture: Option<String>, cultures: Option<Vec<String>>| -> Result<RowSet> {
            let selection = Selection {
                target: Some(target.clone()),
                culture,
                cultures,
                text: text.map(|query| TextSearch {
                    query: query.to_owned(),
                    translations: Some(true),
                }),
                ..Selection::default()
            };
            selection.validate()?;
            RowSet::from_rows(lines, &query.matching(&selection, cancelled)?)
        };
        let names = query.cultures.clone();
        let (any, cultures) = match culture {
            // Every finding the culture selection keeps is the culture's or has none.
            Some(ci) => (select(Some(names[ci as usize].clone()), None)?, Vec::new()),
            None => (
                select(None, Some(names.clone()))?,
                names
                    .iter()
                    .map(|name| select(Some(name.clone()), None))
                    .collect::<Result<_>>()?,
            ),
        };
        let sources = match text {
            Some(text) => {
                // Terms split as the Text tab splits them.
                let lowered = text.to_lowercase();
                let terms = lowered
                    .split(crate::join_policy::js_space)
                    .filter(|term| !term.is_empty())
                    .map(|term| query.source_matches(term, cancelled))
                    .collect::<Result<_>>()?;
                let rows = layer
                    .metadata
                    .rules
                    .iter()
                    .enumerate()
                    .map(|(index, rule)| {
                        if rule.subject == Subject::UnitSource {
                            layer.column(&format!("r{index}.rows"))
                        } else {
                            Ok(Arc::from([]))
                        }
                    })
                    .collect::<Result<_>>()?;
                Some(SourceMatches {
                    terms,
                    rows,
                    sources: layer.column("subjects.unit_source.sources")?,
                })
            }
            None => None,
        };
        Ok(Self {
            cultures,
            any,
            sources,
        })
    }

    pub(super) fn holds(&self, columns: &Columns, number: u32) -> bool {
        let n = number as usize;
        let line = columns.line[n];
        if line == NONE {
            return self.sources.as_ref().is_some_and(|matches| {
                let rule = columns.rule[n] as usize;
                let position = (number - columns.bases[rule]) as usize;
                matches
                    .rows
                    .get(rule)
                    .and_then(|rows| rows.get(position))
                    .and_then(|row| matches.sources.get(*row as usize))
                    .is_some_and(|source| {
                        matches
                            .terms
                            .iter()
                            .all(|term| term.get(*source as usize) == Some(&1))
                    })
            });
        }
        self.cultures
            .get(columns.culture[n] as usize)
            .unwrap_or(&self.any)
            .contains(line as usize)
    }
}

/// Where composing a page's findings spends its time, in milliseconds: opening the line and source
/// subjects, prefetching the lines' occurrences, and composing the rows.
#[derive(Default)]
pub(super) struct ComposeTimes {
    pub(super) open: f64,
    pub(super) prefetch: f64,
    pub(super) rows: f64,
    /// Imaging the string dictionary, when this compose was the first to read a string.
    pub(super) image: Option<f64>,
    /// The line prefetch's parts: its read arena, occurrence IDs and place strings.
    pub(super) prefetch_parts: [f64; 3],
}

/// Composes findings in the given order, with the place sets they name.
pub(super) fn compose(
    query: &EngineQuery,
    layer: &FindingsLayer,
    page: &[u32],
    cancelled: &AtomicBool,
) -> Result<(Vec<PlaceSet>, Vec<Value>, ComposeTimes)> {
    let mut times = ComposeTimes::default();
    let imaged = query.reader.imaged_ms().is_some();
    let mut since = Instant::now();
    let mut lap = |slot: &mut f64| {
        *slot += since.elapsed().as_secs_f64() * 1000.0;
        since = Instant::now();
    };
    let rules = &layer.metadata.rules;
    let columns = columns(layer)?;
    let collator = HostCollator::new(&layer.metadata.collation)?;
    let mut places = Vec::new();
    let mut findings = Vec::with_capacity(page.len());
    let line_findings = page
        .iter()
        .filter(|number| columns.line[**number as usize] != NONE)
        .copied()
        .collect::<Vec<_>>();
    let mut composed = HashMap::new();
    if !line_findings.is_empty() {
        let mut subjects = NativeSubjects::new(query, Subject::Line, &collator, cancelled)?;
        lap(&mut times.open);
        let mut lines = line_findings
            .iter()
            .map(|number| columns.line[*number as usize])
            .collect::<Vec<_>>();
        lines.sort_unstable();
        lines.dedup();
        subjects.prefetch_occurrences(&lines)?;
        lap(&mut times.prefetch);
        times.prefetch_parts = subjects.prefetch_ms;
        let mut place_ids = HashSet::new();
        let mut line_places = HashMap::new();
        for number in &line_findings {
            checkpoint(cancelled)?;
            let rule = columns.rule[*number as usize] as usize;
            let position = (*number - columns.bases[rule]) as usize;
            let mut finding = compose_line_finding(
                &mut subjects,
                layer,
                rule,
                &rules[rule],
                position,
                &mut places,
                &mut place_ids,
                &mut line_places,
            )?;
            let line = columns.line[*number as usize] as usize;
            finding["manifestSource"] = subjects.line_field(line, "manifestSource")?;
            finding["lineSource"] = subjects.line_field(line, "source")?;
            finding["shippedTranslation"] = subjects.culture_field(
                line,
                columns.culture[*number as usize] as usize,
                "latest",
            )?;
            finding["family"] = json!(rules[rule].family);
            composed.insert(*number, finding);
        }
    }
    let unit_findings = page
        .iter()
        .filter(|number| columns.line[**number as usize] == NONE)
        .copied()
        .collect::<Vec<_>>();
    if !unit_findings.is_empty() {
        lap(&mut times.rows);
        let unit_lines = query.unit_lines(cancelled)?;
        let mut subjects = NativeSubjects::new(query, Subject::UnitSource, &collator, cancelled)?;
        lap(&mut times.open);
        let mut place_ids = places.iter().map(|set| set.id).collect::<HashSet<_>>();
        for number in &unit_findings {
            checkpoint(cancelled)?;
            let rule = columns.rule[*number as usize] as usize;
            let position = (*number - columns.bases[rule]) as usize;
            let (unit, mut finding) = compose_unit_finding(
                &mut subjects,
                layer,
                &collator,
                &rules[rule],
                rule,
                position,
                &mut places,
                &mut place_ids,
            )?;
            let line = unit_lines.get(unit as usize).copied().unwrap_or(NONE);
            finding["sourceKey"] = if line == NONE {
                Value::Null
            } else {
                let key = subjects.query.reader.value("line.key", line as usize)?;
                let key = subjects.query.reader.string(key)?;
                if key.is_empty() {
                    Value::Null
                } else {
                    json!(key)
                }
            };
            composed.insert(*number, finding);
        }
    }
    for number in page {
        findings.push(
            composed
                .remove(number)
                .ok_or("A paged finding was not composed.")?,
        );
    }
    lap(&mut times.rows);
    if !imaged {
        times.image = query.reader.imaged_ms();
    }
    Ok((places, findings, times))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finding_ids_parse_to_their_lanes() {
        assert_eq!(
            id_lanes("localization-finding:0000000a000000ff"),
            Some((true, 10, 255))
        );
        assert_eq!(
            id_lanes("quality-finding:1000000002"),
            Some((false, 0x10, 2))
        );
        assert_eq!(id_lanes("quality-finding:0a"), None);
        assert_eq!(id_lanes("localization-finding:0a"), None);
        assert_eq!(id_lanes("other"), None);
    }

    #[test]
    fn review_fingerprints_match_the_host_formula() {
        // sha256("Hello\0Bonjour") and sha256("Hello\0\0absent").
        assert_eq!(
            review_fingerprint("Hello", Some("Bonjour")),
            digest("Hello\0Bonjour".as_bytes())
        );
        assert_eq!(
            review_fingerprint("Hello", None),
            digest("Hello\0\0absent".as_bytes())
        );
    }
}
