//! Scoped native engine handles. Queries own pinned read-only views, independent of writer leases.
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::engine_types::{invalid, parse_search_request};
use crate::store::{Configuration, token};
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
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
    Search {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
    },
    Focus {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
    },
    Corpus {
        reader: String,
        #[cfg_attr(test, ts(type = "string"))]
        output: std::path::PathBuf,
    },
    /// The corpus without its units.
    CorpusHeader {
        reader: String,
        #[cfg_attr(test, ts(type = "string"))]
        output: std::path::PathBuf,
    },
    /// The corpus content fingerprint.
    CorpusFingerprint {
        reader: String,
    },
    /// The corpus header as a report shows it: counts and bounded previews.
    CorpusReportHeader {
        reader: String,
    },
    /// Grouped counts of the matching rows, written to `output`.
    Aggregate {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
        #[cfg_attr(test, ts(type = "string"))]
        output: std::path::PathBuf,
    },
    LocalizationCorpus {
        reader: String,
        #[cfg_attr(test, ts(type = "string"))]
        output: std::path::PathBuf,
    },
    Export {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
        #[cfg_attr(test, ts(type = "string"))]
        output: std::path::PathBuf,
    },
    LocalizationDetail {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
    },
    /// A selection's related units and lines: same key, same text, conflict and key change.
    Related {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
    },
    LocalizationExport {
        reader: String,
        #[cfg_attr(test, ts(type = "unknown"))]
        request: Value,
        #[cfg_attr(test, ts(type = "string"))]
        output: std::path::PathBuf,
    },
    LocalizationFocusExport {
        reader: String,
        /// The line's identity.
        line: String,
        #[cfg_attr(test, ts(type = "string"))]
        output: std::path::PathBuf,
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
            | Self::Search { reader, .. }
            | Self::Focus { reader, .. }
            | Self::Corpus { reader, .. }
            | Self::CorpusHeader { reader, .. }
            | Self::CorpusFingerprint { reader }
            | Self::CorpusReportHeader { reader }
            | Self::Aggregate { reader, .. }
            | Self::LocalizationCorpus { reader, .. }
            | Self::Export { reader, .. }
            | Self::LocalizationDetail { reader, .. }
            | Self::Related { reader, .. }
            | Self::LocalizationExport { reader, .. }
            | Self::LocalizationFocusExport { reader, .. }
            | Self::FindingsEvaluate { reader, .. }
            | Self::FindingsAccept { reader, .. }
            | Self::FindingsQuery { reader, .. } => {
                require(
                    !reader.is_empty() && reader.len() <= 128,
                    invalid("Invalid native reader handle."),
                )?;
            }
        }
        match self {
            Self::FindingsEvaluate {
                collation_locale, ..
            } => {
                require(
                    !collation_locale.is_empty() && collation_locale.len() <= 128,
                    invalid("Invalid findings collation locale."),
                )?;
            }
            Self::LocalizationFocusExport { line, .. } => {
                require(
                    !line.is_empty() && crate::join_policy::characters(line) <= 32767,
                    invalid("Invalid localization line identity."),
                )?;
            }
            _ => {}
        }
        if let Self::Corpus { output, .. }
        | Self::CorpusHeader { output, .. }
        | Self::Aggregate { output, .. }
        | Self::LocalizationCorpus { output, .. }
        | Self::Export { output, .. }
        | Self::LocalizationExport { output, .. }
        | Self::LocalizationFocusExport { output, .. } = self
        {
            require(
                output
                    .to_str()
                    .is_some_and(|path| !path.is_empty() && path.len() <= 32767),
                invalid("Invalid native export output path."),
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
}
impl Profile {
    /// A profile with no stages, for a request that failed.
    pub fn now() -> Self {
        Self {
            io: crate::snapshot::io_metrics(),
            stage_seconds: BTreeMap::new(),
        }
    }
}

/// A request's answer: its reply part, as JSON text, and its profile.
#[derive(Debug)]
pub struct EngineAnswer {
    pub part: Option<String>,
    pub profile: Profile,
}

/// The JSON text of a request value, for the readers that still parse text.
fn text(value: &Value) -> Result<String> {
    crate::wtf8::view_json(value)
}

#[derive(Default)]
pub struct EngineSession {
    readers: HashMap<String, EngineQuery>,
}
impl EngineSession {
    pub fn execute(
        &mut self,
        request: &EngineRequest,
        cancelled: &AtomicBool,
    ) -> Result<EngineAnswer> {
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
                    self.readers.len() < 8,
                    Error::new(
                        ErrorCode::LimitExceeded,
                        "Close a pinned reader before opening another native Game Text snapshot.",
                    ),
                )?;
                let mut query =
                    EngineQuery::open_with_policy(configuration, Some(expected_joined), policy)?;
                require(
                    query.reader.generation == *expected_generation,
                    Error::new(
                        ErrorCode::StaleGeneration,
                        "Game Text dictionary changed before the reader opened.",
                    ),
                )?;
                // Load the persisted text-search arena before exposing a ready reader. This
                // is measured as preparation, so the first typed term pays only matching work.
                let source_started = Instant::now();
                query.prepare_source_search(cancelled)?;
                stage_seconds.insert(
                    "source_search_prepare".into(),
                    source_started.elapsed().as_secs_f64(),
                );
                // Summary counters no longer load the numeric query projection as a side effect.
                // Keep that required preparation in opening instead of deferring it to page one.
                let projection_started = Instant::now();
                crate::engine_match::Projection::open(&mut query, cancelled)?;
                stage_seconds.insert(
                    "query_projection_prepare".into(),
                    projection_started.elapsed().as_secs_f64(),
                );
                // Focus, cursors, picked lines and line details look rows up by ID; index the
                // packed IDs and each unit's line once so none of them scans every row.
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
                self.readers.insert(reader, query);
                ("open", Some(serde_json::to_string(&reply)?))
            }
            EngineRequest::Close { reader } => {
                self.readers.remove(reader);
                ("close", None)
            }
            EngineRequest::Summary { reader }
            | EngineRequest::Search { reader, .. }
            | EngineRequest::Focus { reader, .. }
            | EngineRequest::Corpus { reader, .. }
            | EngineRequest::CorpusHeader { reader, .. }
            | EngineRequest::CorpusFingerprint { reader }
            | EngineRequest::CorpusReportHeader { reader }
            | EngineRequest::Aggregate { reader, .. }
            | EngineRequest::LocalizationCorpus { reader, .. }
            | EngineRequest::Export { reader, .. }
            | EngineRequest::LocalizationDetail { reader, .. }
            | EngineRequest::Related { reader, .. }
            | EngineRequest::LocalizationExport { reader, .. }
            | EngineRequest::LocalizationFocusExport { reader, .. }
            | EngineRequest::FindingsEvaluate { reader, .. }
            | EngineRequest::FindingsAccept { reader, .. }
            | EngineRequest::FindingsQuery { reader, .. } => {
                let query=self.readers.get_mut(reader).ok_or_else(|| Error::new(ErrorCode::NotFound,"The native Game Text reader is closed or belongs to another session; reopen its snapshot."))?;
                // A file read replies with the bytes it wrote.
                let bytes =
                    |bytes: u64| serde_json::to_string(&serde_json::json!({ "bytes": bytes }));
                let (action, part) = match request {
                    EngineRequest::FindingsEvaluate {
                        rules,
                        collation_locale,
                        ..
                    } => (
                        "findings_evaluate",
                        query.findings_evaluate(&text(rules)?, collation_locale, cancelled)?,
                    ),
                    EngineRequest::FindingsAccept { request, .. } => (
                        "findings_accept",
                        query.findings_accept(request.clone(), cancelled)?,
                    ),
                    EngineRequest::FindingsQuery { request, .. } => (
                        "findings_query",
                        query.findings_query(request.clone(), cancelled)?,
                    ),
                    EngineRequest::Summary { .. } => (
                        "summary",
                        crate::wtf8::view_json(&query.summary(cancelled)?)?,
                    ),
                    EngineRequest::Search { request, .. } => {
                        ("search", query.search_json(&text(request)?, cancelled)?)
                    }
                    EngineRequest::Related { request, .. } => {
                        ("related", query.related_json(&text(request)?, cancelled)?)
                    }
                    EngineRequest::Corpus { output, .. } => {
                        let request = parse_search_request(
                            r#"{"query":"","capability":"all","pageSize":50}"#,
                        )?;
                        let written =
                            query.export_to_path(&request, output, true, None, cancelled)?;
                        ("corpus", bytes(written)?)
                    }
                    EngineRequest::CorpusHeader { output, .. } => (
                        "corpus_header",
                        bytes(query.export_corpus_header_to_path(output, cancelled)?)?,
                    ),
                    EngineRequest::CorpusReportHeader { .. } => (
                        "corpus_report_header",
                        crate::wtf8::view_json(
                            &query.corpus_report_header(REPORT_PREVIEW_ITEMS, cancelled)?,
                        )?,
                    ),
                    EngineRequest::CorpusFingerprint { .. } => (
                        "corpus_fingerprint",
                        serde_json::to_string(
                            &serde_json::json!({"sha256":query.corpus_fingerprint(cancelled)?}),
                        )?,
                    ),
                    EngineRequest::Aggregate {
                        request, output, ..
                    } => {
                        let request =
                            crate::engine_rollup::parse_aggregate_request(&text(request)?)?;
                        (
                            "aggregate",
                            bytes(query.aggregate_to_path(&request, output, cancelled)?)?,
                        )
                    }
                    EngineRequest::Export {
                        request, output, ..
                    } => {
                        let (request, units) =
                            crate::engine_rollup::parse_corpus_export(&text(request)?)?;
                        let written = query.export_to_path(
                            &request,
                            output,
                            false,
                            units.as_deref(),
                            cancelled,
                        )?;
                        ("export", bytes(written)?)
                    }
                    EngineRequest::Focus { request, .. } => {
                        ("focus", query.focus_json(&text(request)?, cancelled)?)
                    }
                    EngineRequest::LocalizationDetail { request, .. } => (
                        "localization_detail",
                        query.localization_detail_json(&text(request)?, cancelled)?,
                    ),
                    EngineRequest::LocalizationExport {
                        request, output, ..
                    } => {
                        let (request, fields) =
                            crate::engine_rollup::parse_line_export(&text(request)?)?;
                        let written = query.export_localization_to_path(
                            &request,
                            output,
                            false,
                            fields.as_deref(),
                            cancelled,
                        )?;
                        ("localization_export", bytes(written)?)
                    }
                    EngineRequest::LocalizationFocusExport { line, output, .. } => (
                        "localization_focus_export",
                        bytes(query.export_localization_focus_to_path(
                            &text(&Value::String(line.clone()))?,
                            output,
                            cancelled,
                        )?)?,
                    ),
                    EngineRequest::LocalizationCorpus { output, .. } => {
                        let request = parse_search_request(
                            r#"{"query":"","capability":"all","pageSize":50}"#,
                        )?;
                        let written = query
                            .export_localization_to_path(&request, output, true, None, cancelled)?;
                        ("localization_corpus", bytes(written)?)
                    }
                    _ => return Err("Invalid engine dispatch.".into()),
                };
                require(
                    part.len() <= crate::session::MAX_BODY,
                    Error::new(
                        ErrorCode::LimitExceeded,
                        "Native Game Text response exceeds its byte bound; request a smaller evidence page.",
                    ),
                )?;
                (action, Some(part))
            }
        };
        checkpoint(cancelled)?;
        stage_seconds.insert(action.into(), started.elapsed().as_secs_f64());
        Ok(EngineAnswer {
            part,
            profile: Profile {
                io: crate::snapshot::io_metrics(),
                stage_seconds,
            },
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
        for action in ["findings_query", "findings_accept", "search"] {
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
    fn retired_inline_localization_actions_are_rejected() -> Result<()> {
        for action in ["localization_focus", "localization_page"] {
            assert!(
                serde_json::from_value::<EngineRequest>(json!({
                    "action": action, "reader": "reader", "line": "line"
                }))
                .is_err()
            );
        }
        let export: EngineRequest = serde_json::from_value(json!({
            "action": "localization_focus_export", "reader": "reader",
            "line": "line", "output": crate::test_directory("focus-export").join("line.json")
        }))?;
        export.validate()?;
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
        let mut session = EngineSession::default();
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
        let mut other = EngineSession::default();
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
        assert!(session.readers.is_empty());
        drop(writer);
        drop(session);
        std::fs::remove_dir_all(configuration.cache_root)?;
        Ok(())
    }
    #[test]
    fn cancellation_and_bad_queries_are_typed_without_poisoning_the_session() -> Result<()> {
        let (configuration, generation) = snapshot()?;
        let mut session = EngineSession::default();
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
            r#"{"query":"","capability":"all","pageSize":51}"#,
            r#"{"query":"","capability":"all","pageSize":1,"where":null}"#,
            r#"{"query":"","capability":"all","pageSize":1,"unknown":true}"#,
        ] {
            assert_eq!(
                session
                    .execute(
                        &EngineRequest::Search {
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
        assert!(session.readers.is_empty());
        drop(session);
        std::fs::remove_dir_all(configuration.cache_root)?;
        Ok(())
    }
    #[test]
    fn stale_snapshot_open_does_not_consume_a_reader_slot() -> Result<()> {
        let (configuration, _) = snapshot()?;
        let mut session = EngineSession::default();
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
        assert!(session.readers.is_empty());
        std::fs::remove_dir_all(configuration.cache_root)?;
        Ok(())
    }
}
