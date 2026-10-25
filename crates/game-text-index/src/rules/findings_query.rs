//! Findings reads over a layer's numbering and orders: review acceptance (`findings_accept`) and
//! `findings_query`, which filters, orders, pages and counts a layer's findings for Quality, the
//! `loc check` report and the status report.
use super::findings_order::{CHANGE, FIXABLE, KEYLESS, NONE, SHADOWED};
use super::findings_read::{compose_line_finding, compose_unit_finding};
use super::ir::Severity;
use super::replies::{LineDiagnostic, PlaceSet, ReadProfile};
use super::{FindingsLayer, HostCollator, NativeSubjects, Subject, javascript_json};
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::store::digest;
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;
#[cfg(test)]
use ts_rs::TS;

/// Accepted findings one `findings_accept` call takes; larger review files are sent in chunks.
const MAX_ACCEPTED: usize = 5000;
/// Findings one `findings_query` page returns.
const MAX_LIMIT: usize = 5000;

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

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "FindingsView"))]
#[serde(rename_all = "snake_case")]
pub(crate) enum View {
    /// Source and line findings, as the Quality workspace lists them.
    Workspace,
    /// Line findings, as `loc check` reports them.
    Report,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "FindingsOrder"))]
#[serde(rename_all = "snake_case")]
pub(crate) enum Order {
    Severity,
    Report,
    Line,
    /// Source findings in `order.source`, as the source report lists them.
    Source,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "FindingsPageRequest"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Page {
    #[serde(default)]
    #[cfg_attr(test, ts(optional, type = "number"))]
    offset: usize,
    #[cfg_attr(test, ts(type = "number"))]
    limit: usize,
}

/// `findings_query`: a view's findings, filtered, in an order, paged and counted.
#[derive(Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "FindingsQueryRequest"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QueryRequest {
    key: String,
    view: View,
    #[cfg_attr(test, ts(optional))]
    culture: Option<String>,
    #[cfg_attr(test, ts(optional))]
    rules: Option<Vec<String>>,
    #[cfg_attr(test, ts(optional))]
    severities: Option<Vec<Severity>>,
    #[cfg_attr(test, ts(optional))]
    fixable: Option<bool>,
    #[cfg_attr(test, ts(optional))]
    change: Option<bool>,
    #[cfg_attr(test, ts(optional))]
    acceptance: Option<String>,
    #[cfg_attr(test, ts(optional))]
    line: Option<String>,
    #[cfg_attr(test, ts(optional))]
    id: Option<String>,
    order: Order,
    #[cfg_attr(test, ts(optional))]
    after: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional, type = "number"))]
    offset: usize,
    #[cfg_attr(test, ts(type = "number"))]
    limit: usize,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    counts: bool,
    #[cfg_attr(test, ts(optional))]
    diagnostics: Option<Page>,
}

#[derive(Serialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuleTotal {
    rule_id: String,
    count: u32,
}

#[derive(Serialize, Default)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "FindingCounts"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct Counts {
    /// Findings in the view and the culture selection, accepted ones left out.
    all: u32,
    rules: Vec<RuleTotal>,
    #[cfg_attr(test, ts(type = "{ blocking: number, normal: number, low: number }"))]
    severities: BTreeMap<&'static str, u32>,
    /// Findings in the view and the culture selection the acceptance key hid.
    accepted: u32,
    /// Findings every filter selects, and those of them with an acceptable change.
    total: u32,
    fixable: u32,
    /// Diagnostics in the culture selection by code, in first-seen order.
    limits: Vec<CodeCount>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
pub(crate) struct CodeCount {
    code: String,
    count: u32,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "FindingDiagnostics"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct Diagnostics {
    total: u32,
    rows: Vec<LineDiagnostic>,
}

/// A `findings_query` reply's part. Its place sets follow as the `places` part and its findings
/// as the `findings` part, both batches. Line findings are the host's shape with
/// `manifestSource`, `lineSource`, `shippedTranslation` and `family`; source findings add
/// `sourceKey`.
#[derive(Serialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct FindingsPage {
    pub(super) profile: ReadProfile,
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub(super) places: Vec<PlaceSet>,
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub(super) findings: Vec<Value>,
    /// Findings every filter selects.
    total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    counts: Option<Counts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    diagnostics: Option<Diagnostics>,
    /// Milliseconds per stage: select, order, page, compose and counts.
    #[cfg_attr(test, ts(type = "{ [stage: string]: number }"))]
    stages: BTreeMap<&'static str, f64>,
}
const SEVERITIES: [(Severity, &str); 3] = [
    (Severity::Blocking, "blocking"),
    (Severity::Normal, "normal"),
    (Severity::Low, "low"),
];

/// A finding ID's identity lanes, for a line finding or a source finding.
fn id_lanes(id: &str) -> Option<(bool, u32, u32)> {
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

    pub fn findings_query(
        &self,
        request: serde_json::Value,
        cancelled: &AtomicBool,
        reply: &mut dyn crate::engine::Reply,
    ) -> Result<()> {
        let request: QueryRequest = serde_json::from_value(request).map_err(|source| {
            Error::with_source(ErrorCode::InvalidInput, "Invalid findings query.", source)
        })?;
        require(
            request.limit <= MAX_LIMIT
                && request
                    .diagnostics
                    .as_ref()
                    .is_none_or(|page| page.limit <= MAX_LIMIT),
            invalid("A findings page holds at most 5000 rows."),
        )?;
        let key = request.key.clone();
        let acceptance = match &request.acceptance {
            Some(name) => {
                let acceptance = self
                    .acceptances
                    .get(name)
                    .ok_or_else(|| invalid("The acceptance is not open."))?;
                require(
                    acceptance.layer == key,
                    invalid("The acceptance belongs to other findings."),
                )?;
                Some(acceptance)
            }
            None => None,
        };
        self.send_page(
            &key,
            request.limit,
            |query, layer| run_query(query, layer, &request, acceptance.as_deref(), cancelled),
            reply,
        )
    }
}

/// `localizationReviewFingerprint`: SHA-256 of the source, a NUL, and the translation or a
/// marker for none, over the UTF-8 a host's `TextEncoder` writes.
fn review_fingerprint(source: &str, translation: Option<&str>) -> String {
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
struct Columns {
    rule: Arc<[u32]>,
    line: Arc<[u32]>,
    culture: Arc<[u32]>,
    flags: Arc<[u32]>,
    /// Each rule's first finding number, then the count.
    bases: Vec<u32>,
    id0: Vec<Arc<[u32]>>,
    id1: Vec<Arc<[u32]>>,
}

fn columns(layer: &FindingsLayer) -> Result<Columns> {
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
    fn lanes(&self, number: u32) -> (u32, u32) {
        let rule = self.rule[number as usize] as usize;
        let position = (number - self.bases[rule]) as usize;
        (self.id0[rule][position], self.id1[rule][position])
    }
}

fn run_query(
    query: &EngineQuery,
    layer: &FindingsLayer,
    request: &QueryRequest,
    acceptance: Option<&Acceptance>,
    cancelled: &AtomicBool,
) -> Result<FindingsPage> {
    let mut stages = BTreeMap::new();
    let started = Instant::now();
    let mark = |stages: &mut BTreeMap<&'static str, f64>, name, since: &mut Instant| {
        stages.insert(name, since.elapsed().as_secs_f64() * 1000.0);
        *since = Instant::now();
    };
    let mut since = started;
    let rules = layer.metadata.rules.clone();
    let columns = columns(layer)?;
    let culture = match &request.culture {
        Some(culture) => Some(u32::try_from(
            query
                .cultures
                .iter()
                .position(|value| value == culture)
                .ok_or_else(|| invalid("The culture is not in the target."))?,
        )?),
        None => None,
    };
    let wanted_rules = request.rules.as_ref().map(|ids| {
        rules
            .iter()
            .map(|rule| ids.contains(&rule.rule_id))
            .collect::<Vec<_>>()
    });
    let severities = request.severities.as_ref().map(|severities| {
        rules
            .iter()
            .map(|rule| severities.contains(&rule.severity))
            .collect::<Vec<_>>()
    });
    // Accepted findings: (line, culture, rule) through each rule's ID.
    let accepted_rules = acceptance.map(|acceptance| {
        let mut by_rule = vec![HashSet::new(); rules.len()];
        for (line, ci, check) in &acceptance.entries {
            for (index, rule) in rules.iter().enumerate() {
                if &rule.rule_id == check {
                    by_rule[index].insert((*line, *ci));
                }
            }
        }
        by_rule
    });
    let accepted = |number: u32| {
        let n = number as usize;
        accepted_rules.as_ref().is_some_and(|by_rule| {
            columns.flags[n] & KEYLESS == 0
                && columns.line[n] != NONE
                && by_rule[columns.rule[n] as usize]
                    .contains(&(columns.line[n], columns.culture[n]))
        })
    };
    let has_source_rules = rules.iter().any(|rule| rule.subject == Subject::UnitSource);
    let shadow = request.view == View::Workspace && has_source_rules;
    let in_culture = |number: u32| {
        let n = number as usize;
        culture.is_none_or(|ci| columns.culture[n] == NONE || columns.culture[n] == ci)
            && !(shadow && columns.flags[n] & SHADOWED != 0)
    };
    let line_row = match &request.line {
        Some(id) => Some(query.find_id("line", id)?.map_or(NONE, |row| row as u32)),
        None => None,
    };
    let id = request.id.as_deref().map(id_lanes);
    let selected = |number: u32| {
        let n = number as usize;
        let rule = columns.rule[n] as usize;
        wanted_rules.as_ref().is_none_or(|wanted| wanted[rule])
            && severities.as_ref().is_none_or(|wanted| wanted[rule])
            && request
                .fixable
                .is_none_or(|wanted| (columns.flags[n] & FIXABLE != 0) == wanted)
            && request
                .change
                .is_none_or(|wanted| (columns.flags[n] & CHANGE != 0) == wanted)
            && line_row.is_none_or(|row| columns.line[n] == row)
            && id.is_none_or(|lanes| {
                lanes.is_some_and(|(line, first, second)| {
                    (columns.line[n] != NONE) == line && columns.lanes(number) == (first, second)
                })
            })
    };

    // The view's findings in the request's order.
    let report = layer.column("order.report")?;
    let source = if request.view == View::Workspace || request.order == Order::Source {
        layer.column("order.source")?
    } else {
        Arc::from([])
    };
    let sequence: Vec<u32> = match request.order {
        Order::Report => report.to_vec(),
        Order::Line => layer.column("order.line")?.to_vec(),
        Order::Source => source.to_vec(),
        Order::Severity => {
            let mut sequence = Vec::with_capacity(report.len() + source.len());
            for (severity, _) in SEVERITIES {
                let of = |number: &&u32| {
                    rules[columns.rule[**number as usize] as usize].severity == severity
                };
                sequence.extend(source.iter().filter(of));
                sequence.extend(report.iter().filter(of));
            }
            sequence
        }
    };
    mark(&mut stages, "order", &mut since);
    checkpoint(cancelled)?;

    let mut counts = request.counts.then(|| Counts {
        rules: rules
            .iter()
            .map(|rule| RuleTotal {
                rule_id: rule.rule_id.clone(),
                count: 0,
            })
            .collect(),
        severities: SEVERITIES.iter().map(|(_, name)| (*name, 0)).collect(),
        ..Counts::default()
    });
    let mut matched = Vec::new();
    for number in &sequence {
        let number = *number;
        if !in_culture(number) {
            continue;
        }
        if accepted(number) {
            if let Some(counts) = &mut counts {
                counts.accepted += 1;
            }
            continue;
        }
        if let Some(counts) = &mut counts {
            let rule = &rules[columns.rule[number as usize] as usize];
            counts.all += 1;
            counts.rules[columns.rule[number as usize] as usize].count += 1;
            *counts
                .severities
                .entry(
                    SEVERITIES
                        .iter()
                        .find(|(s, _)| *s == rule.severity)
                        .map_or("normal", |(_, name)| name),
                )
                .or_default() += 1;
        }
        if selected(number) {
            matched.push(number);
            if let Some(counts) = &mut counts {
                counts.total += 1;
                if columns.flags[number as usize] & FIXABLE != 0 {
                    counts.fixable += 1;
                }
            }
        }
    }
    mark(&mut stages, "select", &mut since);
    // Rules sharing an ID count once, under the first of them.
    if let Some(counts) = &mut counts {
        let mut seen = HashMap::<String, usize>::new();
        let mut merged = Vec::new();
        for total in std::mem::take(&mut counts.rules) {
            if let Some(index) = seen.get(&total.rule_id) {
                let entry: &mut RuleTotal = &mut merged[*index];
                entry.count += total.count;
            } else {
                seen.insert(total.rule_id.clone(), merged.len());
                merged.push(total);
            }
        }
        counts.rules = merged;
    }

    // The cursor starts after the first selected finding with its ID.
    let mut start = 0;
    if let Some(after) = &request.after
        && let Some(Some((line, first, second))) = Some(id_lanes(after))
        && let Some(position) = matched.iter().position(|number| {
            (columns.line[*number as usize] != NONE) == line
                && columns.lanes(*number) == (first, second)
        })
    {
        start = position + 1;
    }
    let page = matched
        .iter()
        .skip(start)
        .skip(request.offset)
        .take(request.limit)
        .copied()
        .collect::<Vec<_>>();
    mark(&mut stages, "page", &mut since);

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
        let mut lines = line_findings
            .iter()
            .map(|number| columns.line[*number as usize])
            .collect::<Vec<_>>();
        lines.sort_unstable();
        lines.dedup();
        subjects.prefetch_occurrences(&lines)?;
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
        let unit_lines = query.unit_lines(cancelled)?;
        let mut subjects = NativeSubjects::new(query, Subject::UnitSource, &collator, cancelled)?;
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
    for number in &page {
        findings.push(
            composed
                .remove(number)
                .ok_or("A paged finding was not composed.")?,
        );
    }
    mark(&mut stages, "compose", &mut since);

    if let Some(counts) = &mut counts {
        let rows = layer.column("diag.rows")?;
        let cultures = layer.column("diag.cultures")?;
        let codes = layer.column("diag.codes")?;
        let mut seen = Vec::<(u32, u32)>::new();
        for index in layer.column("diag.order")?.iter() {
            let index = *index as usize;
            if culture.is_some_and(|ci| cultures[index] != ci) {
                continue;
            }
            let _ = rows[index];
            match seen.iter_mut().find(|(code, _)| *code == codes[index]) {
                Some(entry) => entry.1 += 1,
                None => seen.push((codes[index], 1)),
            }
        }
        counts.limits = seen
            .into_iter()
            .map(|(code, count)| {
                Ok(CodeCount {
                    code: layer.dictionary.string(code)?,
                    count,
                })
            })
            .collect::<Result<_>>()?;
    }
    let diagnostics = match &request.diagnostics {
        Some(page) => {
            let rows = layer.column("diag.rows")?;
            let cultures = layer.column("diag.cultures")?;
            let codes = layer.column("diag.codes")?;
            let order = layer.column("diag.order")?;
            let selection = order
                .iter()
                .map(|index| *index as usize)
                .filter(|index| culture.is_none_or(|ci| cultures[*index] == ci))
                .collect::<Vec<_>>();
            let mut result = Vec::new();
            for index in selection.iter().skip(page.offset).take(page.limit) {
                result.push(LineDiagnostic {
                    line_id: query.packed("line", rows[*index] as usize)?,
                    culture: query
                        .cultures
                        .get(cultures[*index] as usize)
                        .ok_or("Diagnostic culture outside target.")?
                        .clone(),
                    code: layer.dictionary.string(codes[*index])?,
                });
            }
            Some(Diagnostics {
                total: u32::try_from(selection.len())?,
                rows: result,
            })
        }
        None => None,
    };
    mark(&mut stages, "counts", &mut since);
    stages.insert("total", started.elapsed().as_secs_f64() * 1000.0);
    Ok(FindingsPage {
        profile: ReadProfile::default(),
        places,
        total: u32::try_from(matched.len())?,
        findings,
        counts,
        diagnostics,
        stages,
    })
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
