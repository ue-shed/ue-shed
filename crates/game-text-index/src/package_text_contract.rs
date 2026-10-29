//! Package snapshot preparation input shared by the reader and its hosts.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct PackageTextAudienceRule {
    pub code: u32,
    pub when: Vec<PackageTextAudienceMatch>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PackageTextAudienceMatch {
    Namespace {
        value: String,
    },
    Folder {
        value: String,
    },
    Object {
        value: String,
        position: PackageTextObjectPosition,
    },
    Module {
        value: String,
        #[serde(default)]
        #[cfg_attr(test, ts(as = "Option<bool>", optional))]
        suffix: bool,
    },
    Property {
        value: String,
        #[serde(default)]
        #[cfg_attr(test, ts(as = "Option<bool>", optional))]
        anywhere: bool,
    },
    Location {
        value: String,
    },
    /// A code place's macro, such as `UI_COMMAND`.
    Macro {
        value: String,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum PackageTextObjectPosition {
    Prefix,
    Suffix,
    Equals,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageTextSnapshotRequest {
    pub shards: Vec<PackageTextShard>,
    pub rules: Vec<PackageTextAudienceRule>,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<Vec<String>>", optional))]
    pub record_files: Vec<String>,
    /// Serialized stored records are boundary input; workers decode directly into typed records.
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<Vec<String>>", optional))]
    pub records: Vec<String>,
    /// The plan file `plan_packages` wrote: the reader reads the shards `groups` names from it,
    /// and reads their selected packages, so the request lists none.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub plan_file: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<Vec<u32>>", optional))]
    pub groups: Vec<u32>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct PackageTextShard {
    pub group: u32,
    pub expected: Vec<PackageTextExpected>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct PackageTextExpected {
    pub path: String,
    pub signature: String,
    pub selected: bool,
}
/// `plan_packages`: the Catalog generation a package-text refresh plans from and how it keys its
/// shards. The reader reads the inventory; the request names no packages.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageTextPlanRequest {
    /// The Project Index cache root, project and generation the Catalog holds.
    pub cache_root: String,
    pub project_id: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub generation: u64,
    /// The shard key prefix: the package-text format, then the audience policy's JSON.
    pub format: String,
    pub policy_json: String,
    /// Only these project-relative files changed; every other package keeps its stored entry.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub changed_files: Option<Vec<String>>,
    /// A new file the reader writes the changed shards' entries to, for staging.
    pub plan_file: String,
}
/// One changed shard of a plan.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageTextPlanShard {
    pub group: u32,
    pub key: String,
    pub packages: u32,
    pub selected: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageTextPlan {
    /// Shards with packages whose key differs from the index's.
    pub changed: Vec<PackageTextPlanShard>,
    /// Shards the index holds that no package falls in any more.
    pub removed: Vec<String>,
    pub packages: u32,
    /// Shard 0's key, the marker an empty inventory publishes.
    pub first_key: String,
}

/// The layer holding a target's code text: places `unreal-code` found in the C++, config and
/// String Table CSV files its `GatherTextFromSource` steps read, in the package shards' format.
#[must_use]
pub fn code_layer(target: &str) -> String {
    format!("{CODE_LAYER_PREFIX}{target}")
}
pub const CODE_LAYER_PREFIX: &str = "code-text:";

/// `publish_code`: the reader scans one target's code and publishes its code layer when the
/// layer's content changed. Without `scan` the layer is removed: the host could not name the
/// engine, so the target's code is not read.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeLayerRequest {
    pub target: String,
    /// The layer key prefix: the package-text format, then the audience policy's JSON.
    pub format: String,
    pub policy_json: String,
    pub rules: Vec<PackageTextAudienceRule>,
    /// A new file the reader stages the layer in.
    pub staging_file: String,
    /// One target, named `target`.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub scan: Option<unreal_code::CodeTextRequest>,
}

/// One file of a point: the path it stands for, and where its bytes are at that point.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointFile {
    /// Relative to the project folder, as the project spells it.
    pub path: String,
    /// The file holding its bytes at this point; none when the point removes it.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub file: Option<String>,
}

/// Reads the text in a set of files at one revision into per-file records keyed by content, and
/// writes the point's manifest. A record already in the cache is reused, not read again.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointRequest {
    /// The point's id, such as `depot@220368` or `shelved:220258`.
    pub point: String,
    /// The point this one changes, by id; none when it changes the project's index as it is.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub base: Option<String>,
    /// The record key prefix: the package-text format, then the saved-text policy's JSON.
    pub format: String,
    pub policy_json: String,
    pub rules: Vec<PackageTextAudienceRule>,
    pub files: Vec<PointFile>,
    /// How the target reads code; without it, code files are `unread`.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub code: Option<PointCode>,
}

/// A point's code: the target's scan and the audience policy its code text is judged by.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointCode {
    pub policy_json: String,
    /// One target, as `publish_code` scans it.
    pub scan: unreal_code::CodeTextRequest,
}

/// A point file's record and how it was read.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointEntry {
    pub path: String,
    /// The record's key; none for a removed file or one no record describes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub record: Option<String>,
    pub status: PointFileStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum PointFileStatus {
    Complete,
    Partial,
    NotGatherable,
    Failed,
    Removed,
    /// Neither a saved package nor a file the point reads code from.
    Unread,
}

/// What reading a point did: its files, how many records were read or reused, and the bytes read.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointOutcome {
    pub point: String,
    /// Records read from their files now.
    pub read: u32,
    /// Records already in the cache.
    pub reused: u32,
    /// Bytes of the files read: every file is hashed; only misses are parsed.
    #[cfg_attr(test, ts(type = "number"))]
    pub bytes: u64,
    pub entries: Vec<PointEntry>,
}

/// Diagnostics a code layer outcome carries at most; the count says how many there were.
pub const CODE_DIAGNOSTIC_SAMPLES: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeLayerOutcome {
    pub name: String,
    /// The active key after the request; none when the layer was removed or never existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub key: Option<String>,
    /// Whether the request changed the active layer.
    pub published: bool,
    /// Code places in the layer, and of those, the ones the target's gather leaves out.
    pub places: u32,
    pub left_out: u32,
    /// Files with at least one place.
    pub files: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub counts: Option<unreal_code::FileCounts>,
    pub diagnostic_count: u32,
    /// The first [`CODE_DIAGNOSTIC_SAMPLES`] diagnostics, in scan order.
    pub diagnostics: Vec<unreal_code::CodeDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub engine_wrappers: Option<unreal_code::EngineWrappers>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub profile: Option<unreal_code::CodeTextProfile>,
}
