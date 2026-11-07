//! Findings reads over a layer's numbering and orders: review acceptance (`findings_accept`) and
//! `findings_query`, which filters, orders, pages and counts a layer's findings for Quality, the
//! `loc check` report and the status report.
use super::findings_order::{CHANGE, FIXABLE, KEYLESS, NONE, SHADOWED};
use super::findings_read::{compose_line_finding, compose_unit_finding};
use super::findings_sink::reported_finding;
use super::ir::Severity;
use super::replies::{LineDiagnostic, PlaceSet, ReadProfile};
use super::{FindingsLayer, HostCollator, NativeSubjects, Subject, javascript_json};
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::engine_rows::RowSet;
use crate::engine_types::{FindingsSelection, Selection, TextSearch};
use crate::sink::{Format, Sink, SinkSummary, SinkWriter, pretty_json};
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

pub(crate) use crate::engine_types::{FindingsOrder as Order, FindingsView as View};

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

/// Findings by their line, as the Text tab searches lines: each `text` term in the line's source
/// or the finding's culture's translation, and `where` over the line. A finding without a
/// culture reads the request's culture, or every culture. A source finding matches `text` in its
/// unit's source; none matches a `where`, which tests lines.
#[derive(Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "FindingsLineSearch"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LineSearch {
    #[cfg_attr(test, ts(optional))]
    text: Option<String>,
    #[serde(rename = "where")]
    #[cfg_attr(test, ts(optional, type = "Expr"))]
    filter: Option<Value>,
}

impl LineSearch {
    /// A search for text alone.
    pub(super) fn text(text: &str) -> Self {
        Self {
            text: Some(text.to_owned()),
            filter: None,
        }
    }
    /// Blank text and no `where` keep every finding.
    fn searched(&self) -> Option<&str> {
        self.text.as_deref().filter(|text| !text.trim().is_empty())
    }
    fn narrows(&self) -> bool {
        self.searched().is_some() || self.filter.is_some()
    }
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
    #[cfg_attr(test, ts(optional))]
    lines: Option<LineSearch>,
    order: Order,
    #[cfg_attr(test, ts(optional))]
    after: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional, type = "number"))]
    offset: usize,
    /// The page's size; a sink writes every selected finding unless it is given.
    #[cfg_attr(test, ts(optional, type = "number"))]
    limit: Option<usize>,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    counts: bool,
    #[cfg_attr(test, ts(optional))]
    diagnostics: Option<Page>,
    /// Writes the report view's findings as `findingJson` rather than sending them.
    #[cfg_attr(test, ts(optional))]
    sink: Option<Sink>,
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
    /// Findings in the view, the culture selection and the line search that every filter but
    /// `rules` selects, accepted ones left out.
    all: u32,
    /// Each rule's findings that every filter but `rules` selects.
    rules: Vec<RuleTotal>,
    /// Each severity's findings that every filter but `severities` selects.
    #[cfg_attr(test, ts(type = "{ blocking: number, normal: number, low: number }"))]
    severities: BTreeMap<&'static str, u32>,
    /// Findings in the view, the culture selection and the line search the acceptance key hid.
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
    /// The selected findings to compose, in their order.
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    numbers: Vec<u32>,
    /// What the request's sink wrote.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    sink: Option<SinkSummary>,
    /// Findings every filter selects.
    total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    counts: Option<Counts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    diagnostics: Option<Diagnostics>,
    /// Milliseconds per stage: layer, lines, order, select, page, compose (with its parts
    /// `compose_open`, `compose_prefetch` and `compose_rows`, outside the total) and counts.
    #[cfg_attr(test, ts(type = "{ [stage: string]: number }"))]
    stages: BTreeMap<&'static str, f64>,
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

    pub fn findings_query(
        &self,
        request: serde_json::Value,
        cancelled: &AtomicBool,
        reply: &mut dyn crate::engine::Reply,
    ) -> Result<()> {
        let request: QueryRequest = serde_json::from_value(request).map_err(|source| {
            Error::with_source(ErrorCode::InvalidInput, "Invalid findings query.", source)
        })?;
        match &request.sink {
            Some(sink) => require(
                sink.format == Format::FindingJson && request.view == View::Report,
                invalid("A findings sink writes the report view's findings as findingJson."),
            )?,
            None => require(
                request.limit.is_some(),
                invalid("A findings page names its limit."),
            )?,
        }
        require(
            request.limit.is_none_or(|limit| limit <= MAX_LIMIT)
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
        if let Some(sink) = &request.sink {
            return self.write_findings(
                &key,
                &request,
                acceptance.as_deref(),
                sink,
                cancelled,
                reply,
            );
        }
        self.send_page(
            &key,
            request.limit.unwrap_or_default(),
            |query, layer| {
                let mut page = run_query(query, layer, &request, acceptance.as_deref(), cancelled)?;
                compose_page(query, layer, &mut page, cancelled)?;
                Ok(page)
            },
            reply,
        )
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
        selection: &FindingsSelection,
        search: &LineSearch,
        culture: Option<u32>,
        cancelled: &AtomicBool,
    ) -> Result<Self> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("findingsLines");
        let target = query.target["name"]
            .as_str()
            .ok_or("The findings' target has no name.")?
            .to_owned();
        let text = search.searched();
        let findings = search.filter.as_ref().map(|_| FindingsSelection {
            view: None,
            source_only: None,
            ..selection.clone()
        });
        let lines = query.reader.column("line.source")?.len();
        let select = |culture: Option<String>, cultures: Option<Vec<String>>| -> Result<RowSet> {
            let selection = Selection {
                target: Some(target.clone()),
                culture,
                cultures,
                findings: findings.clone(),
                filter: search.filter.clone(),
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
        let sources = match (text, &search.filter) {
            (Some(text), None) => {
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
            _ => None,
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
    let lines = match request.lines.as_ref().filter(|search| search.narrows()) {
        Some(search) => {
            let selection = FindingsSelection {
                key: request.key.clone(),
                acceptance: request.acceptance.clone(),
                source_only: None,
                view: None,
            };
            let lines = LineMatches::open(query, layer, &selection, search, culture, cancelled)?;
            mark(&mut stages, "lines", &mut since);
            Some(lines)
        }
        None => None,
    };
    let searched = |number: u32| {
        lines
            .as_ref()
            .is_none_or(|lines| lines.holds(&columns, number))
    };
    let rule_selected = |number: u32| {
        wanted_rules
            .as_ref()
            .is_none_or(|wanted| wanted[columns.rule[number as usize] as usize])
    };
    let severity_selected = |number: u32| {
        severities
            .as_ref()
            .is_none_or(|wanted| wanted[columns.rule[number as usize] as usize])
    };
    // The filters besides rules and severities, which every count follows.
    let otherwise_selected = |number: u32| {
        let n = number as usize;
        request
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
    // Counts are facets: a rule's count follows every filter but the rules, a severity's every
    // filter but the severities, so a list can show what choosing another one would select.
    let mut matched = Vec::new();
    for number in &sequence {
        let number = *number;
        if !in_culture(number) || !searched(number) {
            continue;
        }
        if accepted(number) {
            if let Some(counts) = &mut counts {
                counts.accepted += 1;
            }
            continue;
        }
        if !otherwise_selected(number) {
            continue;
        }
        let (by_rule, by_severity) = (rule_selected(number), severity_selected(number));
        if let Some(counts) = &mut counts {
            let rule = columns.rule[number as usize] as usize;
            if by_severity {
                counts.all += 1;
                counts.rules[rule].count += 1;
            }
            if by_rule {
                *counts
                    .severities
                    .entry(
                        SEVERITIES
                            .iter()
                            .find(|(s, _)| *s == rules[rule].severity)
                            .map_or("normal", |(_, name)| name),
                    )
                    .or_default() += 1;
            }
        }
        if by_rule && by_severity {
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
        .take(request.limit.unwrap_or(usize::MAX))
        .copied()
        .collect::<Vec<_>>();
    mark(&mut stages, "page", &mut since);

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
        places: Vec::new(),
        total: u32::try_from(matched.len())?,
        findings: Vec::new(),
        numbers: page,
        sink: None,
        counts,
        diagnostics,
        stages,
    })
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

/// Composes a page's findings, timed as its `compose` stage.
fn compose_page(
    query: &EngineQuery,
    layer: &FindingsLayer,
    page: &mut FindingsPage,
    cancelled: &AtomicBool,
) -> Result<()> {
    let started = Instant::now();
    let numbers = std::mem::take(&mut page.numbers);
    let times;
    (page.places, page.findings, times) = compose(query, layer, &numbers, cancelled)?;
    page.timed("compose", started);
    // Parts of `compose`, so they stay out of the total.
    page.stages.insert("compose_open", times.open);
    page.stages.insert("compose_prefetch", times.prefetch);
    page.stages.insert("compose_rows", times.rows);
    if let Some(ms) = times.image {
        page.stages.insert("compose_dictionary_image", ms);
    }
    page.stages
        .insert("compose_prefetch_arena", times.prefetch_parts[0]);
    page.stages
        .insert("compose_prefetch_ids", times.prefetch_parts[1]);
    page.stages
        .insert("compose_prefetch_strings", times.prefetch_parts[2]);
    Ok(())
}

impl FindingsPage {
    fn timed(&mut self, stage: &'static str, started: Instant) {
        self.add_stage(stage, started.elapsed().as_secs_f64() * 1000.0);
    }
    /// Records a stage's milliseconds and adds them to the total.
    pub(super) fn add_stage(&mut self, stage: &'static str, ms: f64) {
        self.stages.insert(stage, ms);
        *self.stages.entry("total").or_default() += ms;
    }
}

impl EngineQuery {
    /// Writes the selected findings through a `findingJson` sink, composing a page of them at a
    /// time, and answers with the page's counts and what the sink wrote.
    fn write_findings(
        &self,
        key: &str,
        request: &QueryRequest,
        acceptance: Option<&Acceptance>,
        sink: &Sink,
        cancelled: &AtomicBool,
        reply: &mut dyn crate::engine::Reply,
    ) -> Result<()> {
        let layer = self.layer(key)?;
        let mut page = run_query(self, &layer, request, acceptance, cancelled)?;
        let numbers = std::mem::take(&mut page.numbers);
        let started = Instant::now();
        let mut writer = SinkWriter::open(sink, reply)?;
        let mut out = Vec::new();
        for chunk in numbers.chunks(MAX_LIMIT) {
            let (places, findings, _) = compose(self, &layer, chunk, cancelled)?;
            let sets = places
                .into_iter()
                .map(|set| (set.id, set.occurrences))
                .collect::<HashMap<_, _>>();
            for finding in findings {
                out.clear();
                if writer.rows() > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(b"\n\t\t");
                pretty_json(&reported_finding(finding, &sets)?, 2, &mut out);
                writer.write(&out)?;
                writer.row();
            }
        }
        let summary = writer.finish()?;
        page.timed("compose", started);
        page.profile = ReadProfile {
            rows_requested: numbers.len(),
            findings_returned: summary.rows as usize,
        };
        page.sink = Some(summary);
        reply.part(javascript_json(&serde_json::to_value(&page)?, false).into_bytes())
    }
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
