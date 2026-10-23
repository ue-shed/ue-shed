//! Scoped native engine handles. Queries own pinned read-only views, independent of writer leases.
use crate::engine_match::checkpoint;
use crate::engine_query::EngineQuery;
use crate::engine_types::{invalid, parse_search_request};
use crate::store::{Configuration, token};
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
        payload: String,
    },
    Focus {
        reader: String,
        payload: String,
    },
    Rows {
        reader: String,
        payload: String,
        output: std::path::PathBuf,
    },
    Corpus {
        reader: String,
        output: std::path::PathBuf,
    },
    /// The corpus without its units.
    CorpusHeader {
        reader: String,
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
        payload: String,
        output: std::path::PathBuf,
    },
    LocalizationCorpus {
        reader: String,
        output: std::path::PathBuf,
    },
    Export {
        reader: String,
        payload: String,
        output: std::path::PathBuf,
    },
    LocalizationDetail {
        reader: String,
        payload: String,
    },
    LocalizationExport {
        reader: String,
        payload: String,
        output: std::path::PathBuf,
    },
    LocalizationFocusExport {
        reader: String,
        payload: String,
        output: std::path::PathBuf,
    },
    FindingsEvaluate {
        reader: String,
        /// The v4 rule document's JSON text, read by the WTF-8-aware reader.
        rules: String,
        #[serde(rename = "collationLocale")]
        collation_locale: String,
    },
    FindingsLines {
        reader: String,
        key: String,
        rows: Vec<u32>,
    },
    FindingsUnits {
        reader: String,
        key: String,
        units: Vec<u32>,
    },
}
impl EngineRequest {
    pub fn requires_findings(&self) -> bool {
        matches!(
            self,
            Self::FindingsEvaluate { .. } | Self::FindingsLines { .. } | Self::FindingsUnits { .. }
        )
    }
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Capabilities => {}
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
            | Self::Rows { reader, .. }
            | Self::LocalizationDetail { reader, .. }
            | Self::LocalizationExport { reader, .. }
            | Self::LocalizationFocusExport { reader, .. }
            | Self::FindingsEvaluate { reader, .. }
            | Self::FindingsLines { reader, .. }
            | Self::FindingsUnits { reader, .. } => {
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
            Self::FindingsLines { key, rows, .. }
            | Self::FindingsUnits {
                key, units: rows, ..
            } => {
                require(
                    !key.is_empty() && key.len() <= 1024 && rows.len() <= 5000,
                    invalid("Invalid findings key or row selection."),
                )?;
            }
            Self::Export { payload, .. } => {
                require(
                    payload.len() <= 512 * 1024,
                    invalid("Native query payload exceeds its bound."),
                )?;
                crate::engine_rollup::parse_corpus_export(payload)?;
            }
            Self::Search { payload, .. }
            | Self::Focus { payload, .. }
            | Self::Rows { payload, .. }
            | Self::LocalizationFocusExport { payload, .. } => {
                require(
                    payload.len() <= 512 * 1024,
                    invalid("Native query payload exceeds its bound."),
                )?;
                if matches!(self, Self::LocalizationFocusExport { .. }) {
                    let id = crate::json_value::parse(payload).map_err(|source| {
                        Error::with_source(
                            ErrorCode::InvalidInput,
                            "Invalid localization focus JSON.",
                            source,
                        )
                    })?;
                    require(
                        id.as_str().is_some_and(|id| {
                            !id.is_empty() && crate::join_policy::characters(id) <= 32767
                        }),
                        invalid("Invalid localization line identity."),
                    )?;
                } else if matches!(self, Self::Focus { .. }) {
                    crate::engine_types::parse_focus_request(payload)?;
                } else {
                    parse_search_request(payload)?;
                }
            }
            Self::LocalizationDetail { payload, .. } => {
                require(
                    payload.len() <= 512 * 1024,
                    invalid("Native query payload exceeds its bound."),
                )?;
                crate::engine_types::parse_detail_request(payload)?;
            }
            Self::LocalizationExport { payload, .. } => {
                require(
                    payload.len() <= 512 * 1024,
                    invalid("Native query payload exceeds its bound."),
                )?;
                crate::engine_rollup::parse_line_export(payload)?;
            }
            Self::Aggregate { payload, .. } => {
                require(
                    payload.len() <= 512 * 1024,
                    invalid("Native query payload exceeds its bound."),
                )?;
                crate::engine_rollup::parse_aggregate_request(payload)?;
            }
            _ => {}
        }
        if let Self::Corpus { output, .. }
        | Self::CorpusHeader { output, .. }
        | Self::Aggregate { output, .. }
        | Self::LocalizationCorpus { output, .. }
        | Self::Export { output, .. }
        | Self::Rows { output, .. }
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
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineOutcome {
    pub action: String,
    pub capabilities: Vec<String>,
    pub reader: Option<String>,
    pub generation: Option<String>,
    pub joined_key: Option<String>,
    /// Bounded domain JSON text, preserving lone JavaScript UTF-16 code units exactly.
    pub payload: Option<String>,
    pub io: crate::snapshot::IoMetrics,
    pub stage_seconds: BTreeMap<String, f64>,
    /// `capabilities` reports the engine's build and contract, for the host's one handshake.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<crate::contract::ContractIdentity>,
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
    ) -> Result<EngineOutcome> {
        request.validate()?;
        checkpoint(cancelled)?;
        let started = Instant::now();
        let mut outcome = EngineOutcome {
            action: String::new(),
            capabilities: vec!["game_text_engine_v1".into()],
            reader: None,
            generation: None,
            joined_key: None,
            payload: None,
            io: crate::snapshot::io_metrics(),
            stage_seconds: BTreeMap::new(),
            contract: None,
        };
        match request {
            EngineRequest::Capabilities => {
                outcome.action = "capabilities".into();
                outcome.contract = Some(crate::contract::identity());
            }
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
                outcome.stage_seconds.insert(
                    "source_search_prepare".into(),
                    source_started.elapsed().as_secs_f64(),
                );
                // Summary counters no longer load the numeric query projection as a side effect.
                // Keep that required preparation in opening instead of deferring it to page one.
                let projection_started = Instant::now();
                crate::engine_match::Projection::open(&mut query, cancelled)?;
                outcome.stage_seconds.insert(
                    "query_projection_prepare".into(),
                    projection_started.elapsed().as_secs_f64(),
                );
                // Focus, cursors, picked lines and line details look rows up by ID; index the
                // packed IDs and each unit's line once so none of them scans every row.
                let index_started = Instant::now();
                let (_, raw) = query.id_index_with_timings("raw")?;
                let (_, line) = query.id_index_with_timings("line")?;
                let (_, unit_lines) = query.unit_lines_with_timings(cancelled)?;
                outcome.stage_seconds.insert(
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
                    outcome
                        .stage_seconds
                        .insert(key.into(), duration.as_secs_f64());
                }
                let reader = token();
                outcome.action = "open".into();
                outcome.reader = Some(reader.clone());
                outcome.generation = Some(query.reader.generation.clone());
                outcome.joined_key = Some(query.reader.joined_key.clone());
                checkpoint(cancelled)?;
                self.readers.insert(reader, query);
            }
            EngineRequest::Close { reader } => {
                self.readers.remove(reader);
                outcome.action = "close".into();
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
            | EngineRequest::Rows { reader, .. }
            | EngineRequest::LocalizationDetail { reader, .. }
            | EngineRequest::LocalizationExport { reader, .. }
            | EngineRequest::LocalizationFocusExport { reader, .. }
            | EngineRequest::FindingsEvaluate { reader, .. }
            | EngineRequest::FindingsLines { reader, .. }
            | EngineRequest::FindingsUnits { reader, .. } => {
                let query=self.readers.get_mut(reader).ok_or_else(|| Error::new(ErrorCode::NotFound,"The native Game Text reader is closed or belongs to another session; reopen its snapshot."))?;
                let (action, payload) = match request {
                    EngineRequest::FindingsEvaluate {
                        rules,
                        collation_locale,
                        ..
                    } => (
                        "findings_evaluate",
                        query.findings_evaluate(rules, collation_locale, cancelled)?,
                    ),
                    EngineRequest::FindingsLines { key, rows, .. } => (
                        "findings_lines",
                        query.findings_lines(key, rows, cancelled)?,
                    ),
                    EngineRequest::FindingsUnits { key, units, .. } => (
                        "findings_units",
                        query.findings_units(key, units, cancelled)?,
                    ),
                    EngineRequest::Summary { .. } => (
                        "summary",
                        crate::wtf8::view_json(&query.summary(cancelled)?)?,
                    ),
                    EngineRequest::Search { payload, .. } => {
                        ("search", query.search_json(payload, cancelled)?)
                    }
                    EngineRequest::Rows {
                        payload, output, ..
                    } => {
                        let request = parse_search_request(payload)?;
                        require(
                            request.localization.is_some(),
                            invalid("Localization rows require a selected target."),
                        )?;
                        let rows = query.matching(&request, cancelled)?;
                        use std::io::Write;
                        let file = std::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(output)?;
                        let mut writer = std::io::BufWriter::new(file);
                        let result = (|| -> Result<()> {
                            for (index, row) in rows.iter().enumerate() {
                                if index & 255 == 0 {
                                    checkpoint(cancelled)?;
                                }
                                writer.write_all(&row.to_le_bytes())?;
                            }
                            writer.flush()?;
                            Ok(())
                        })();
                        drop(writer);
                        if result.is_err() {
                            let _ = std::fs::remove_file(output);
                        }
                        result?;
                        (
                            "rows",
                            serde_json::to_string(&serde_json::json!({"count":rows.len()}))?,
                        )
                    }
                    EngineRequest::Corpus { output, .. } => {
                        let request = parse_search_request(
                            r#"{"query":"","capability":"all","pageSize":50}"#,
                        )?;
                        let bytes =
                            query.export_to_path(&request, output, true, None, cancelled)?;
                        (
                            "corpus",
                            serde_json::to_string(&serde_json::json!({"bytes":bytes}))?,
                        )
                    }
                    EngineRequest::CorpusHeader { output, .. } => {
                        let bytes = query.export_corpus_header_to_path(output, cancelled)?;
                        (
                            "corpus_header",
                            serde_json::to_string(&serde_json::json!({"bytes":bytes}))?,
                        )
                    }
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
                        payload, output, ..
                    } => {
                        let request = crate::engine_rollup::parse_aggregate_request(payload)?;
                        let bytes = query.aggregate_to_path(&request, output, cancelled)?;
                        (
                            "aggregate",
                            serde_json::to_string(&serde_json::json!({"bytes":bytes}))?,
                        )
                    }
                    EngineRequest::Export {
                        payload, output, ..
                    } => {
                        let (request, units) = crate::engine_rollup::parse_corpus_export(payload)?;
                        let bytes = query.export_to_path(
                            &request,
                            output,
                            false,
                            units.as_deref(),
                            cancelled,
                        )?;
                        (
                            "export",
                            serde_json::to_string(&serde_json::json!({"bytes":bytes}))?,
                        )
                    }
                    EngineRequest::Focus { payload, .. } => {
                        ("focus", query.focus_json(payload, cancelled)?)
                    }
                    EngineRequest::LocalizationDetail { payload, .. } => (
                        "localization_detail",
                        query.localization_detail_json(payload, cancelled)?,
                    ),
                    EngineRequest::LocalizationExport {
                        payload, output, ..
                    } => {
                        let (request, fields) = crate::engine_rollup::parse_line_export(payload)?;
                        let bytes = query.export_localization_to_path(
                            &request,
                            output,
                            false,
                            fields.as_deref(),
                            cancelled,
                        )?;
                        (
                            "localization_export",
                            serde_json::to_string(&serde_json::json!({"bytes":bytes}))?,
                        )
                    }
                    EngineRequest::LocalizationFocusExport {
                        payload, output, ..
                    } => {
                        let bytes =
                            query.export_localization_focus_to_path(payload, output, cancelled)?;
                        (
                            "localization_focus_export",
                            serde_json::to_string(&serde_json::json!({"bytes":bytes}))?,
                        )
                    }
                    EngineRequest::LocalizationCorpus { output, .. } => {
                        let request = parse_search_request(
                            r#"{"query":"","capability":"all","pageSize":50}"#,
                        )?;
                        let bytes = query
                            .export_localization_to_path(&request, output, true, None, cancelled)?;
                        (
                            "localization_corpus",
                            serde_json::to_string(&serde_json::json!({"bytes":bytes}))?,
                        )
                    }
                    _ => return Err("Invalid engine dispatch.".into()),
                };
                require(
                    payload.len() <= 16 * 1024 * 1024,
                    Error::new(
                        ErrorCode::LimitExceeded,
                        "Native Game Text response exceeds its byte bound; request a smaller evidence page.",
                    ),
                )?;
                outcome.action = action.into();
                outcome.payload = Some(payload);
            }
        }
        checkpoint(cancelled)?;
        outcome.io = crate::snapshot::io_metrics();
        outcome
            .stage_seconds
            .insert(outcome.action.clone(), started.elapsed().as_secs_f64());
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    #[test]
    fn findings_requests_are_bounded_and_require_the_new_contract() -> Result<()> {
        for action in ["findings_lines", "findings_units"] {
            let field = if action == "findings_lines" {
                "rows"
            } else {
                "units"
            };
            let mut value = json!({"action":action,"reader":"reader","key":"findings-v1:test"});
            value[field] = json!([0, u32::MAX]);
            let request: EngineRequest = serde_json::from_value(value.clone())?;
            assert!(request.requires_findings());
            request.validate()?;
            value[field] = json!(vec![0; 5001]);
            let request: EngineRequest = serde_json::from_value(value.clone())?;
            assert!(request.validate().is_err());
            value[field] = json!([-1]);
            assert!(serde_json::from_value::<EngineRequest>(value).is_err());
        }
        let request: EngineRequest = serde_json::from_value(
            json!({"action":"findings_evaluate","reader":"reader","rules":"{}","collationLocale":"sv"}),
        )?;
        assert!(request.requires_findings());
        request.validate()?;
        Ok(())
    }

    #[test]
    fn retired_inline_localization_actions_are_rejected() -> Result<()> {
        for action in ["localization_focus", "localization_page"] {
            assert!(
                serde_json::from_value::<EngineRequest>(json!({
                    "action": action, "reader": "reader", "payload": "\"line\""
                }))
                .is_err()
            );
        }
        let export: EngineRequest = serde_json::from_value(json!({
            "action": "localization_focus_export", "reader": "reader",
            "payload": "\"line\"", "output": crate::test_directory("focus-export").join("line.json")
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
        let mut detailed_seconds = 0.0;
        for key in [
            "id_index_raw_load",
            "id_index_raw_build",
            "id_index_line_load",
            "id_index_line_build",
            "id_index_unit_lines_load",
            "id_index_unit_lines_build",
        ] {
            let seconds = *opened.stage_seconds.get(key).ok_or("Missing ID stage")?;
            assert!(seconds.is_finite() && seconds >= 0.0, "{key}: {seconds}");
            detailed_seconds += seconds;
        }
        let total = *opened
            .stage_seconds
            .get("id_index_prepare")
            .ok_or("Missing ID preparation total")?;
        assert!(total.is_finite() && total >= 0.0);
        assert!(detailed_seconds <= total + 1e-6);
        let reader = opened.reader.ok_or("reader")?;
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
        for payload in [
            r#"{"query":"","capability":"all","pageSize":51}"#,
            r#"{"query":"","capability":"all","pageSize":1,"where":null}"#,
            r#"{"query":"","capability":"all","pageSize":1,"unknown":true}"#,
        ] {
            assert_eq!(
                session
                    .execute(
                        &EngineRequest::Search {
                            reader: "not-opened".into(),
                            payload: payload.into()
                        },
                        &cancelled
                    )
                    .err()
                    .ok_or("invalid request")?
                    .code,
                ErrorCode::InvalidInput
            );
        }
        assert_eq!(
            session
                .execute(&EngineRequest::Capabilities, &cancelled)?
                .capabilities,
            ["game_text_engine_v1"]
        );
        assert!(session.readers.is_empty());
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
