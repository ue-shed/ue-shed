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
