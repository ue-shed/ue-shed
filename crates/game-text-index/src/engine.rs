//! Scoped native engine handles. Queries own pinned read-only views, independent of writer leases.
use crate::cache::Lock;
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::engine_types::{Selection, invalid};
use crate::store::{Configuration, token};
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;
#[cfg(test)]
use ts_rs::TS;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnginePolicy {
    /// The identities belonging to persisted occurrence audience codes, in producer order.
    /// These are caller policy data, never native hard-coded classification constraints.
    pub audience_rules: Vec<String>,
}
impl EnginePolicy {
    pub fn validate(&self) -> Result<()> {
        require(
            self.audience_rules.len() <= 255,
            invalid("Too many audience rule identities."),
        )?;
        let mut seen = std::collections::HashSet::new();
        for rule in &self.audience_rules {
            require(
                !rule.is_empty() && rule.len() <= 1024 && seen.insert(rule),
                invalid("Audience rule identities must be bounded and unique."),
            )?;
        }
        Ok(())
    }
}

/// Readers one session holds open. A host pins each snapshot it reads, and an incremental update
/// keeps the previous generation pinned while callers still read it.
const MAX_READERS: usize = 32;

/// Diagnostics and incomplete packages a report header previews: `MAX_CORPUS_REPORT_ITEMS`.
const REPORT_PREVIEW_ITEMS: usize = 200;

/// One request, the JSON body of a `request` frame. The session reads the body WTF-8-aware, so
/// nested strings arrive as reversible views and lone UTF-16 units survive. Requests typed
/// `unknown` keep the host's domain schema until `query` and `line` replace them.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum EngineRequest {
    Capabilities,
    Open {
        configuration: Configuration,
        #[serde(rename = "expectedGeneration")]
        expected_generation: String,
        #[serde(rename = "expectedJoined")]
        expected_joined: String,
        policy: EnginePolicy,
    },
    Close {
        reader: String,
    },
    Summary {
        reader: String,
    },
    /// A selection's rows and the parts of the answer about them (Phase 4 §6).
    Query {
        reader: String,
        #[cfg_attr(test, ts(type = "Query"))]
        request: Value,
    },
    Corpus {
        reader: String,
    },
    /// The corpus without its units.
    CorpusHeader {
        reader: String,
    },
    /// The corpus content fingerprint.
    CorpusFingerprint {
        reader: String,
    },
    /// The corpus header as a report shows it: counts and bounded previews.
    CorpusReportHeader {
        reader: String,
    },
    /// Grouped counts of the matching rows.
    Aggregate {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
    },
    LocalizationCorpus {
        reader: String,
    },
    Export {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
    },
    /// A selected row and the sections of it a host shows (Phase 4 §6).
    Line {
        reader: String,
        #[cfg_attr(test, ts(type = "LineRequest"))]
        request: Value,
    },
    LocalizationExport {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
    },
    FindingsEvaluate {
        reader: String,
        /// The v4 rule document.
        #[cfg_attr(test, ts(type = "RuleDocumentV4"))]
        rules: Value,
        #[serde(rename = "collationLocale")]
        collation_locale: String,
    },
    /// A review's accepted findings for a findings layer; returns an acceptance key.
    FindingsAccept {
        reader: String,
        #[cfg_attr(test, ts(type = "FindingsAcceptRequest"))]
        request: Value,
    },
    /// Filters, orders, pages and counts a findings layer's findings.
    FindingsQuery {
        reader: String,
        #[cfg_attr(test, ts(type = "FindingsQueryRequest"))]
        request: Value,
    },
    /// Compiles a v4 rule document and returns its first problem; needs no reader.
    RulesCheck {
        /// The v4 rule document.
        #[cfg_attr(test, ts(type = "RuleDocumentV4"))]
        rules: Value,
    },
}
impl EngineRequest {
    pub fn validate(&self) -> Result<()> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("requestValidate");
        match self {
            Self::Capabilities | Self::RulesCheck { .. } => {}
            Self::Open {
                configuration,
                expected_generation,
                expected_joined,
                policy,
            } => {
                configuration.identity()?;
                policy.validate()?;
                for identity in [expected_generation, expected_joined] {
                    require(
                        !identity.is_empty() && identity.len() <= 1024,
                        invalid("Invalid expected snapshot identity."),
                    )?;
                }
            }
            Self::Close { reader }
            | Self::Summary { reader }
            | Self::Query { reader, .. }
            | Self::Corpus { reader }
            | Self::CorpusHeader { reader }
            | Self::CorpusFingerprint { reader }
            | Self::CorpusReportHeader { reader }
            | Self::Aggregate { reader, .. }
            | Self::LocalizationCorpus { reader }
            | Self::Export { reader, .. }
            | Self::Line { reader, .. }
            | Self::LocalizationExport { reader, .. }
            | Self::FindingsEvaluate { reader, .. }
            | Self::FindingsAccept { reader, .. }
            | Self::FindingsQuery { reader, .. } => {
                require(
                    !reader.is_empty() && reader.len() <= 128,
                    invalid("Invalid native reader handle."),
                )?;
            }
        }
        if let Self::FindingsEvaluate {
            collation_locale, ..
        } = self
        {
            require(
                !collation_locale.is_empty() && collation_locale.len() <= 128,
                invalid("Invalid findings collation locale."),
            )?;
        }
        Ok(())
    }
}

/// `open`'s reply: the reader's handle and the snapshot it pinned.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenReply {
    pub reader: String,
    pub generation: String,
    pub joined_key: String,
}

/// What a request cost, sent with its terminal frame.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "EngineProfile"))]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub io: crate::snapshot::IoMetrics,
    pub stage_seconds: BTreeMap<String, f64>,
    /// Batches the request sent, and their bytes.
    pub batches: u32,
    #[cfg_attr(test, ts(type = "number"))]
    pub batch_bytes: u64,
    /// How long the request waited for the host to consume its batches.
    pub credit_stall_ms: f64,
}
impl Profile {
    /// A profile with no stages, for a request that failed.
    pub fn now() -> Self {
        Self {
            io: crate::snapshot::io_metrics(),
            stage_seconds: BTreeMap::new(),
            batches: 0,
            batch_bytes: 0,
            credit_stall_ms: 0.0,
        }
    }
}

/// How far a request is: the stage it is in, and its count in that stage's unit.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "EngineProgress"))]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: &'static str,
    pub completed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub total: Option<u32>,
    /// What `completed` and `total` count: `stages` or `rules`.
    pub unit: &'static str,
}

/// Where a request reports its progress. Threads of one request share it; the session sends at
/// most one report each 100 ms, and every stage boundary.
pub trait Reporter: Send + Sync {
    fn report(&self, progress: &Progress, boundary: bool);
}
/// A reporter for answers no host watches.
pub struct Unwatched;
impl Reporter for Unwatched {
    fn report(&self, _: &Progress, _: bool) {}
}

/// Where a request's answer goes while the engine produces it.
pub trait Reply {
    /// Where the request reports its progress.
    fn reporter(&self) -> Arc<dyn Reporter> {
        Arc::new(Unwatched)
    }
    /// One JSON part of the answer.
    fn part(&mut self, body: Vec<u8>) -> Result<()>;
    /// One column batch. It waits while the host holds as many unconsumed batches as flow
    /// control allows, and fails when the request is cancelled meanwhile.
    fn batch(&mut self, body: Vec<u8>) -> Result<()>;
    /// Sends rows a sink encoded for the stream.
    fn text(&mut self, body: Vec<u8>) -> Result<()>;
}

/// A request's whole answer: its first part, as JSON text, its batches and its profile.
#[derive(Debug)]
pub struct EngineAnswer {
    pub part: Option<String>,
    pub batches: Vec<Vec<u8>>,
    pub profile: Profile,
}

/// An answer gathered in memory.
#[derive(Default)]
pub(crate) struct Gathered {
    pub(crate) parts: Vec<Vec<u8>>,
    pub(crate) batches: Vec<Vec<u8>>,
    pub(crate) texts: Vec<Vec<u8>>,
}
impl Reply for Gathered {
    fn part(&mut self, body: Vec<u8>) -> Result<()> {
        self.parts.push(body);
        Ok(())
    }
    fn batch(&mut self, body: Vec<u8>) -> Result<()> {
        self.batches.push(body);
        Ok(())
    }
    fn text(&mut self, body: Vec<u8>) -> Result<()> {
        self.texts.push(body);
        Ok(())
    }
}

/// The JSON text of a request value, for the readers that still parse text.
fn text(value: &Value) -> Result<String> {
    crate::wtf8::view_json(value)
}

#[derive(Default)]
pub struct EngineSession {
    /// Open readers by handle. Requests share a reader; closing one drops the handle, and the
    /// reader is released when the requests still reading it end.
    readers: Lock<HashMap<String, Arc<EngineQuery>>>,
}
impl EngineSession {
    /// Answers a request in memory.
    pub fn execute(&self, request: &EngineRequest, cancelled: &AtomicBool) -> Result<EngineAnswer> {
        let mut gathered = Gathered::default();
        let profile = self.answer(request, cancelled, &mut gathered)?;
        let part = match gathered.parts.into_iter().next() {
            Some(part) => Some(String::from_utf8(part).map_err(|_| "A part is not UTF-8.")?),
            None => None,
        };
        Ok(EngineAnswer {
            part,
            batches: gathered.batches,
            profile,
        })
    }

    /// Answers a request into `reply` as it runs, and returns what it cost.
    pub fn answer(
        &self,
        request: &EngineRequest,
        cancelled: &AtomicBool,
        reply: &mut dyn Reply,
    ) -> Result<Profile> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("engineTotal");
        request.validate()?;
        checkpoint(cancelled)?;
        let started = Instant::now();
        let mut stage_seconds = BTreeMap::new();
        let (action, part) = match request {
            EngineRequest::Capabilities => (
                "capabilities",
                Some(serde_json::to_string(&crate::contract::identity())?),
            ),
            EngineRequest::RulesCheck { rules } => (
                "rules_check",
                Some(serde_json::to_string(&crate::rules::check(&text(rules)?))?),
            ),
            EngineRequest::Open {
                configuration,
                expected_generation,
                expected_joined,
                policy,
            } => {
                require(
                    self.readers.lock().len() < MAX_READERS,
                    Error::new(
                        ErrorCode::LimitExceeded,
                        "Close a pinned reader before opening another native Game Text snapshot.",
                    ),
                )?;
                let query =
                    EngineQuery::open_with_policy(configuration, Some(expected_joined), policy)?;
                require(
                    query.reader.generation == *expected_generation,
                    Error::new(
                        ErrorCode::StaleGeneration,
                        "Game Text dictionary changed before the reader opened.",
                    ),
                )?;
                let reporter = reply.reporter();
                let stage = |stage, completed| {
                    reporter.report(
                        &Progress {
                            stage,
                            completed,
                            total: Some(3),
                            unit: "stages",
                        },
                        true,
                    );
                };
                // Load the persisted text-search arena before exposing a ready reader. This
                // is measured as preparation, so the first typed term pays only matching work.
                stage("sourceSearch", 0);
                let source_started = Instant::now();
                query.prepare_source_search(cancelled)?;
                stage_seconds.insert(
                    "source_search_prepare".into(),
                    source_started.elapsed().as_secs_f64(),
                );
                // Summary counters no longer load the numeric query projection as a side effect.
                // Keep that required preparation in opening instead of deferring it to page one.
                stage("projection", 1);
                let projection_started = Instant::now();
                crate::engine_match::Projection::open(&query, cancelled)?;
                stage_seconds.insert(
                    "query_projection_prepare".into(),
                    projection_started.elapsed().as_secs_f64(),
                );
                // Focus, cursors, picked lines and line details look rows up by ID; index the
                // packed IDs and each unit's line once so none of them scans every row.
                stage("ids", 2);
                let index_started = Instant::now();
                let (_, raw) = query.id_index_with_timings("raw")?;
                let (_, line) = query.id_index_with_timings("line")?;
                let (_, unit_lines) = query.unit_lines_with_timings(cancelled)?;
                stage_seconds.insert(
                    "id_index_prepare".into(),
                    index_started.elapsed().as_secs_f64(),
                );
                for (key, duration) in [
                    ("id_index_raw_load", raw.load),
                    ("id_index_raw_build", raw.build),
                    ("id_index_line_load", line.load),
                    ("id_index_line_build", line.build),
                    ("id_index_unit_lines_load", unit_lines.load),
                    ("id_index_unit_lines_build", unit_lines.build),
                ] {
                    stage_seconds.insert(key.into(), duration.as_secs_f64());
                }
                let reader = token();
                let reply = OpenReply {
                    reader: reader.clone(),
                    generation: query.reader.generation.clone(),
                    joined_key: query.reader.joined_key.clone(),
                };
                checkpoint(cancelled)?;
                let mut readers = self.readers.lock();
                require(
                    readers.len() < MAX_READERS,
                    Error::new(
                        ErrorCode::LimitExceeded,
                        "Close a pinned reader before opening another native Game Text snapshot.",
                    ),
                )?;
                readers.insert(reader, Arc::new(query));
                drop(readers);
                ("open", Some(serde_json::to_string(&reply)?))
            }
            EngineRequest::Close { reader } => {
                self.readers.lock().remove(reader);
                ("close", None)
            }
            EngineRequest::Summary { reader }
            | EngineRequest::Query { reader, .. }
            | EngineRequest::Corpus { reader }
            | EngineRequest::CorpusHeader { reader }
            | EngineRequest::CorpusFingerprint { reader }
            | EngineRequest::CorpusReportHeader { reader }
            | EngineRequest::Aggregate { reader, .. }
            | EngineRequest::LocalizationCorpus { reader }
            | EngineRequest::Export { reader, .. }
            | EngineRequest::Line { reader, .. }
            | EngineRequest::LocalizationExport { reader, .. }
            | EngineRequest::FindingsEvaluate { reader, .. }
            | EngineRequest::FindingsAccept { reader, .. }
            | EngineRequest::FindingsQuery { reader, .. } => {
                let query=self.readers.lock().get(reader).cloned().ok_or_else(|| Error::new(ErrorCode::NotFound,"The native Game Text reader is closed or belongs to another session; reopen its snapshot."))?;
                // Every corpus line, whether or not it is visible.
                let everything = || Ok::<_, Error>(Selection::default());
                let (action, part) = match request {
                    EngineRequest::FindingsEvaluate {
                        rules,
                        collation_locale,
                        ..
                    } => (
                        "findings_evaluate",
                        Some(query.findings_evaluate_reporting(
                            &text(rules)?,
                            collation_locale,
                            cancelled,
                            reply.reporter(),
                        )?),
                    ),
                    EngineRequest::FindingsAccept { request, .. } => (
                        "findings_accept",
                        Some(query.findings_accept(request.clone(), cancelled)?),
                    ),
                    EngineRequest::FindingsQuery { request, .. } => {
                        query.findings_query(request.clone(), cancelled, reply)?;
                        ("findings_query", None)
                    }
                    EngineRequest::Summary { .. } => (
                        "summary",
                        Some(crate::wtf8::view_json(&query.summary(cancelled)?)?),
                    ),
                    EngineRequest::Query { request, .. } => {
                        let request = crate::engine_types::parse_query(&text(request)?)?;
                        query.query(&request, cancelled, reply)?;
                        ("query", None)
                    }
                    EngineRequest::Corpus { .. } => {
                        query.send_corpus(&everything()?, true, None, cancelled, reply)?;
                        ("corpus", None)
                    }
                    EngineRequest::CorpusHeader { .. } => {
                        query.send_corpus_header(cancelled, reply)?;
                        ("corpus_header", None)
                    }
                    EngineRequest::CorpusReportHeader { .. } => (
                        "corpus_report_header",
                        Some(crate::wtf8::view_json(
                            &query.corpus_report_header(REPORT_PREVIEW_ITEMS, cancelled)?,
                        )?),
                    ),
                    EngineRequest::CorpusFingerprint { .. } => (
                        "corpus_fingerprint",
                        Some(serde_json::to_string(
                            &serde_json::json!({"sha256":query.corpus_fingerprint(cancelled)?}),
                        )?),
                    ),
                    EngineRequest::Aggregate { request, .. } => {
                        let request =
                            crate::engine_rollup::parse_aggregate_request(&text(request)?)?;
                        query.send_aggregate(&request, cancelled, reply)?;
                        ("aggregate", None)
                    }
                    EngineRequest::Export { request, .. } => {
                        let (request, units, sink) =
                            crate::engine_rollup::parse_corpus_export(&text(request)?)?;
                        match sink {
                            Some(sink) => {
                                let mut writer = crate::sink::SinkWriter::open(&sink, reply)?;
                                query.write_corpus_csv(&request, &mut writer, cancelled)?;
                                let summary = writer.finish()?;
                                reply.part(serde_json::to_vec(&summary)?)?;
                            }
                            None => query.send_corpus(
                                &request,
                                false,
                                units.as_deref(),
                                cancelled,
                                reply,
                            )?,
                        }
                        ("export", None)
                    }
                    EngineRequest::Line { request, .. } => {
                        let request: crate::engine_types::LineRequest =
                            crate::engine_types::parse_request(&text(request)?, "line")?;
                        query.line(&request, cancelled, reply)?;
                        ("line", None)
                    }
                    EngineRequest::LocalizationExport { request, .. } => {
                        let (request, fields, sink) =
                            crate::engine_rollup::parse_line_export(&text(request)?)?;
                        match sink {
                            Some(sink) => {
                                let mut writer = crate::sink::SinkWriter::open(&sink, reply)?;
                                query.write_culture_lines(&request, &mut writer, cancelled)?;
                                let summary = writer.finish()?;
                                reply.part(serde_json::to_vec(&summary)?)?;
                            }
                            None => query.send_localization_lines(
                                &request,
                                false,
                                fields.as_deref(),
                                cancelled,
                                reply,
                            )?,
                        }
                        ("localization_export", None)
                    }
                    EngineRequest::LocalizationCorpus { .. } => {
                        query.send_localization_lines(
                            &everything()?,
                            true,
                            None,
                            cancelled,
                            reply,
                        )?;
                        ("localization_corpus", None)
                    }
                    _ => return Err("Invalid engine dispatch.".into()),
                };
                if let Some(part) = &part {
                    require(
                        part.len() <= crate::session::MAX_BODY,
                        Error::new(
                            ErrorCode::LimitExceeded,
                            "Native Game Text response exceeds its byte bound; request a smaller evidence page.",
                        ),
                    )?;
                }
                (action, part)
            }
        };
        if let Some(part) = part {
            reply.part(part.into_bytes())?;
        }
        checkpoint(cancelled)?;
        stage_seconds.insert(action.into(), started.elapsed().as_secs_f64());
        Ok(Profile {
            stage_seconds,
            ..Profile::now()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    #[test]
    fn requests_carry_their_values_inline_not_as_text() -> Result<()> {
        for action in ["findings_query", "findings_accept", "query"] {
            let request: EngineRequest = serde_json::from_value(
                json!({"action":action,"reader":"reader","request":{"key":"findings-v1:test"}}),
            )?;
            request.validate()?;
            // The JSON text payloads are gone.
            assert!(
                serde_json::from_value::<EngineRequest>(
                    json!({"action":action,"reader":"reader","payload":"{}"})
                )
                .is_err()
            );
        }
        // The page reads the scans used are gone with them.
        for action in ["findings_lines", "findings_units", "rows"] {
            assert!(
                serde_json::from_value::<EngineRequest>(
                    json!({"action":action,"reader":"reader","key":"findings-v1:test","rows":[0]})
                )
                .is_err()
            );
        }
        let request: EngineRequest = serde_json::from_value(
            json!({"action":"findings_evaluate","reader":"reader","rules":{"schemaVersion":4},"collationLocale":"sv"}),
        )?;
        request.validate()?;
        Ok(())
    }

    #[test]
    fn retired_row_reads_are_rejected_and_one_line_request_reads_a_row() -> Result<()> {
        for action in [
            "localization_focus",
            "localization_page",
            "localization_focus_export",
            "localization_detail",
            "focus",
            "related",
            "search",
        ] {
            assert!(
                serde_json::from_value::<EngineRequest>(json!({
                    "action": action, "reader": "reader", "line": "line", "request": {}
                }))
                .is_err(),
                "{action}"
            );
        }
        let line: EngineRequest = serde_json::from_value(json!({
            "action": "line", "reader": "reader",
            "request": {"selection": {"kind": "line", "id": "line"}, "line": true}
        }))?;
        line.validate()?;
        Ok(())
    }

    fn snapshot() -> Result<(Configuration, String)> {
        let configuration = Configuration {
            cache_root: crate::test_directory("engine-session"),
            project_key: "fixture".into(),
            target_key: "Game".into(),
            shared_project: false,
            view_prefix: None,
        };
        let mut store = Store::writer(configuration.clone())?;
        let generation = store.root["generation"]
            .as_str()
            .ok_or("generation")?
            .to_owned();
        let metadata = json!({"version":3,"generation":generation,"count":0,"dependencies":{},"input":{"target":{"name":"Game","cultures":[]}},"packageNames":[],"packageStarts":[0]});
        let mut columns = Vec::new();
        for kind in ["raw", "slice"] {
            for field in [
                "visible",
                "signals",
                "origins",
                "editing",
                "notes",
                "audience",
                "identity",
                "namespace",
                "member_start",
                "member_end",
                "members",
                "source_start",
                "source_end",
                "sources",
                "file_start",
                "file_end",
                "files",
                "order",
                "representative",
                "raw",
                "line",
            ] {
                columns.push((format!("query.{kind}.{field}"), String::new(), vec![]));
            }
        }
        for field in [
            "source",
            "order",
            "source_visible",
            "notes",
            "origins",
            "editing",
            "audience",
            "key_change",
            "key",
            "namespace",
            "file_start",
            "file_end",
            "manifest_start",
            "manifest_end",
        ] {
            columns.push((format!("line.{field}"), String::new(), vec![]));
        }
        columns.push(("query.line.starts".into(), String::new(), vec![0]));
        for kind in ["raw", "line"] {
            columns.push((format!("query.{kind}.id_starts"), String::new(), vec![0]));
            columns.push((format!("query.{kind}.id_utf8"), String::new(), vec![]));
        }
        columns.push(("query.line.order".into(), String::new(), vec![]));
        columns.push(("facet.files".into(), String::new(), vec![]));
        columns.push(("manifest.rows".into(), String::new(), vec![]));
        store.publish_global(
            "joined",
            "joined-native-v2:fixture",
            &columns,
            &serde_json::to_vec(&metadata)?,
            &BTreeMap::new(),
            &[],
        )?;
        Ok((configuration, generation))
    }
    #[test]
    fn handles_are_session_owned_and_closed_reads_never_take_a_writer_lease() -> Result<()> {
        let (configuration, generation) = snapshot()?;
        let session = EngineSession::default();
        let cancelled = AtomicBool::new(false);
        let request = EngineRequest::Open {
            configuration: configuration.clone(),
            expected_generation: generation,
            expected_joined: "joined-native-v2:fixture".into(),
            policy: EnginePolicy::default(),
        };
        let opened = session.execute(&request, &cancelled)?;
        let stage_seconds = &opened.profile.stage_seconds;
        let mut detailed_seconds = 0.0;
        for key in [
            "id_index_raw_load",
            "id_index_raw_build",
            "id_index_line_load",
            "id_index_line_build",
            "id_index_unit_lines_load",
            "id_index_unit_lines_build",
        ] {
            let seconds = *stage_seconds.get(key).ok_or("Missing ID stage")?;
            assert!(seconds.is_finite() && seconds >= 0.0, "{key}: {seconds}");
            detailed_seconds += seconds;
        }
        let total = *stage_seconds
            .get("id_index_prepare")
            .ok_or("Missing ID preparation total")?;
        assert!(total.is_finite() && total >= 0.0);
        assert!(detailed_seconds <= total + 1e-6);
        let reply: serde_json::Value = serde_json::from_str(&opened.part.ok_or("reply")?)?;
        let reader = reply["reader"].as_str().ok_or("reader")?.to_owned();
        let writer = Store::writer(configuration.clone())?;
        let other = EngineSession::default();
        assert_eq!(
            other
                .execute(
                    &EngineRequest::Summary {
                        reader: reader.clone()
                    },
                    &cancelled
                )
                .err()
                .ok_or("foreign reader")?
                .code,
            ErrorCode::NotFound
        );
        session.execute(
            &EngineRequest::Close {
                reader: reader.clone(),
            },
            &cancelled,
        )?;
        session.execute(
            &EngineRequest::Close {
                reader: reader.clone(),
            },
            &cancelled,
        )?;
        assert_eq!(
            session
                .execute(&EngineRequest::Summary { reader }, &cancelled)
                .err()
                .ok_or("closed reader")?
                .code,
            ErrorCode::NotFound
        );
        assert!(session.readers.lock().is_empty());
        drop(writer);
        drop(session);
        std::fs::remove_dir_all(configuration.cache_root)?;
        Ok(())
    }
    #[test]
    fn cancellation_and_bad_queries_are_typed_without_poisoning_the_session() -> Result<()> {
        let (configuration, generation) = snapshot()?;
        let session = EngineSession::default();
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            session
                .execute(&EngineRequest::Capabilities, &cancelled)
                .err()
                .ok_or("cancelled")?
                .code,
            ErrorCode::Cancelled
        );
        cancelled.store(false, Ordering::Relaxed);
        let opened = session.execute(
            &EngineRequest::Open {
                configuration: configuration.clone(),
                expected_generation: generation,
                expected_joined: "joined-native-v2:fixture".into(),
                policy: EnginePolicy::default(),
            },
            &cancelled,
        )?;
        let reply: serde_json::Value = serde_json::from_str(&opened.part.ok_or("reply")?)?;
        let reader = reply["reader"].as_str().ok_or("reader")?;
        for request in [
            r#"{"selection":{},"parts":{"rows":{"limit":0}}}"#,
            r#"{"selection":{"where":null},"parts":{}}"#,
            r#"{"selection":{},"parts":{},"unknown":true}"#,
            r#"{"selection":{"where":{"utf16Length":[{"field":"source"}]}},"parts":{}}"#,
        ] {
            assert_eq!(
                session
                    .execute(
                        &EngineRequest::Query {
                            reader: reader.into(),
                            request: serde_json::from_str(request)?
                        },
                        &cancelled
                    )
                    .err()
                    .ok_or("invalid request")?
                    .code,
                ErrorCode::InvalidInput
            );
        }
        assert!(
            session
                .execute(&EngineRequest::Capabilities, &cancelled)?
                .part
                .is_some()
        );
        session.execute(
            &EngineRequest::Close {
                reader: reader.into(),
            },
            &cancelled,
        )?;
        assert!(session.readers.lock().is_empty());
        drop(session);
        std::fs::remove_dir_all(configuration.cache_root)?;
        Ok(())
    }
    #[test]
    fn stale_snapshot_open_does_not_consume_a_reader_slot() -> Result<()> {
        let (configuration, _) = snapshot()?;
        let session = EngineSession::default();
        let cancelled = AtomicBool::new(false);
        let request = EngineRequest::Open {
            configuration: configuration.clone(),
            expected_generation: "retired".into(),
            expected_joined: "joined-native-v2:fixture".into(),
            policy: EnginePolicy::default(),
        };
        assert_eq!(
            session
                .execute(&request, &cancelled)
                .err()
                .ok_or("stale generation")?
                .code,
            ErrorCode::StaleGeneration
        );
        assert!(session.readers.lock().is_empty());
        std::fs::remove_dir_all(configuration.cache_root)?;
        Ok(())
    }
}
