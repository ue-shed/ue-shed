//! Replies to the `findings_*` requests, and the evaluation profile they carry. Part of the
//! engine contract: the host reads them as these generated types, without decoding.
//!
//! Finding objects stay JSON until findings cross as typed columns; their fields come from the
//! stored evidence and the pinned subjects.
use super::ir::{Family, Severity, Subject};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[cfg(test)]
use ts_rs::TS;

/// One rule's identity and presentation, in rule ordinal order.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RuleMetadata {
    pub id: String,
    pub rule_id: String,
    pub kind: String,
    pub label: String,
    pub subject: Subject,
    pub family: Family,
    pub severity: Severity,
    pub role: Option<String>,
    /// Whether the rule's findings raise the `finding` problem.
    pub counts: bool,
}
/// Findings per rule, culture and severity. Source rules have no culture.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
pub struct RuleCount {
    /// The rule's position in `rules`.
    pub rule: u32,
    pub culture: Option<String>,
    pub severity: Severity,
    pub count: u32,
}
/// Stored with a findings layer, and read back by every reply.
/// The places a role's scopes match, over the visible units, whether or not a rule's finding does.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RoleTotal {
    pub role: String,
    pub matched_occurrences: u32,
    pub matched_text_units: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LayerMetadata {
    pub version: u32,
    pub joined_key: String,
    pub collation: String,
    pub rules: Vec<RuleMetadata>,
    pub counts: Vec<RuleCount>,
    pub diagnostic_count: u32,
    pub roles: Vec<RoleTotal>,
}

/// `findings_evaluate`'s reply: the layer's key and summary.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct FindingsEvaluation {
    pub key: String,
    pub rules: Vec<RuleMetadata>,
    pub counts: Vec<RuleCount>,
    pub diagnostic_count: u32,
    /// The document's roles, in its order, with the places each matches.
    pub roles: Vec<RoleTotal>,
    pub collation: String,
    pub profile: EvaluationProfile,
}

/// One measured step's time and volume.
#[derive(Clone, Debug, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ProfileSample {
    pub wall_ms: f64,
    pub busy_ms: f64,
    pub rows: usize,
    pub inputs: usize,
    pub memo_hits: usize,
}
/// Process and engine memory when a stage ended.
#[derive(Clone, Debug, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    /// Process counters when the stage ended. In a long-lived engine process the peaks are
    /// lifetime values, so only a fresh process's peak is one evaluation's peak.
    #[cfg_attr(test, ts(type = "number"))]
    pub private_bytes: u64,
    #[cfg_attr(test, ts(type = "number | null"))]
    pub peak_private_bytes: Option<u64>,
    #[cfg_attr(test, ts(type = "number"))]
    pub working_set_bytes: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub peak_working_set_bytes: u64,
    /// With heap counting: live heap at the stage's end, and its peak since the last sample.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub heap_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub heap_peak_bytes: Option<u64>,
    pub arena_bytes: usize,
    pub side_dictionary_bytes: usize,
    pub live_node_columns_bytes: usize,
    pub memos_bytes: usize,
    pub occurrence_relation_bytes: usize,
}
/// A top-level stage: its sample, place on the evaluation's timeline, memory and kernels.
#[derive(Clone, Debug, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct StageSample {
    #[serde(flatten)]
    pub sample: ProfileSample,
    pub start_offset_ms: f64,
    pub end_offset_ms: f64,
    pub memory: Memory,
    pub kernels: BTreeMap<String, ProfileSample>,
}
/// A step inside a stage, with its heap when heap counting is on.
#[derive(Clone, Debug, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct SubStageSample {
    #[serde(flatten)]
    pub sample: ProfileSample,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub heap_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "number"))]
    pub heap_peak_bytes: Option<u64>,
}
/// A measured evaluation.
#[derive(Clone, Debug, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RunProfile {
    pub rules: usize,
    pub findings: usize,
    pub diagnostics: usize,
    pub wall_ms: f64,
    pub stages: BTreeMap<String, StageSample>,
    pub sub_stages: BTreeMap<String, SubStageSample>,
    /// Bytes held by named owners at named points.
    #[cfg_attr(test, ts(type = "{ [point: string]: { [holder: string]: number } }"))]
    pub holders: BTreeMap<String, BTreeMap<String, u64>>,
    pub kernels: BTreeMap<String, ProfileSample>,
}
/// A reused layer has no measurements of its own.
#[derive(Clone, Debug)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(
    test,
    ts(type = "{ readonly cached: true } | ({ readonly cached: false } & RunProfile)")
)]
pub enum EvaluationProfile {
    Cached,
    Run(Box<RunProfile>),
}
impl Serialize for EvaluationProfile {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Cached => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("cached", &true)?;
                map.end()
            }
            Self::Run(profile) => {
                #[derive(Serialize)]
                struct Run<'a> {
                    cached: bool,
                    #[serde(flatten)]
                    profile: &'a RunProfile,
                }
                Run {
                    cached: false,
                    profile,
                }
                .serialize(serializer)
            }
        }
    }
}

/// What a bounded read asked for and returned.
#[derive(Clone, Debug, Default, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ReadProfile {
    pub rows_requested: usize,
    pub findings_returned: usize,
    pub response_bytes: usize,
    pub file_fallback: bool,
}
/// One saved occurrence a finding affects.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    #[cfg_attr(test, ts(type = "{ readonly [key: string]: JsonValue }"))]
    pub location: Value,
    pub package_file: String,
}
/// An interned set of places; findings name it by `id`.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
pub struct PlaceSet {
    pub id: u32,
    pub occurrences: Vec<Place>,
}
/// A culture whose pattern could not be checked on a line.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct LineDiagnostic {
    pub line_id: String,
    pub culture: String,
    pub code: String,
}
/// A read too large for one frame, written to a file the host reads and deletes.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
pub struct SpilledReply {
    pub file: String,
}

/// A bounded read's reply: its findings count and profile.
pub(super) trait Read: Serialize {
    fn findings(&self) -> usize;
    fn profile(&mut self) -> &mut ReadProfile;
}
