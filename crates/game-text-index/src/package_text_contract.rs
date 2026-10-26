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
