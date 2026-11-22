//! Package-text local columns, matching packages/game-text/src/package-text-columns.ts.
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default)]
struct FnvHasher(u64);
impl Hasher for FnvHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut h = if self.0 == 0 {
            0xcbf2_9ce4_8422_2325
        } else {
            self.0
        };
        for &b in bytes {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        self.0 = h;
    }
}
type FastHashMap<K, V> = HashMap<K, V, BuildHasherDefault<FnvHasher>>;

const S_PACKAGE_PATH: usize = 0;
const S_PACKAGE_SIGNATURE: usize = 1;
const S_PACKAGE_ERROR: usize = 2;
const S_OCCURRENCE_SOURCE: usize = 3;
const S_OCCURRENCE_NOTES: usize = 4;
const S_OCCURRENCE_NAMESPACE: usize = 5;
const S_OCCURRENCE_KEY: usize = 6;
const S_OCCURRENCE_OBJECT: usize = 7;
const S_OCCURRENCE_PROPERTY: usize = 8;
const S_OCCURRENCE_CLASS: usize = 9;
const S_OCCURRENCE_ROW: usize = 10;
const S_GAP_OBJECT: usize = 11;
const S_GAP_PROPERTY: usize = 12;
const S_MISSING_NAMESPACE: usize = 13;
const S_MISSING_KEY: usize = 14;
const S_MISSING_SOURCE: usize = 15;
const S_MISSING_SITE: usize = 16;
const S_COPY_OBJECT: usize = 17;
const S_COPY_SOURCE: usize = 18;
const S_COPY_CLASS: usize = 19;
const S_PACKAGE_BLUEPRINTS: usize = 20;
const S_PACKAGE_NAME: usize = 21;
const S_PACKAGE_ASSET_CLASS: usize = 22;

const N_PACKAGE_STATUS: usize = 0;
const N_PACKAGE_BYTES_LOW: usize = 1;
const N_PACKAGE_BYTES_HIGH: usize = 2;
const N_PACKAGE_DECODE_ERRORS: usize = 3;
const N_PACKAGE_OCCURRENCE_START: usize = 4;
const N_PACKAGE_GAP_START: usize = 5;
const N_PACKAGE_GAP0: usize = 6;
const N_PACKAGE_GAP1: usize = 7;
const N_PACKAGE_GAP2: usize = 8;
const N_PACKAGE_GAP3: usize = 9;
const N_PACKAGE_GATHER: usize = 10;
const N_PACKAGE_GATHER_SITES: usize = 11;
const N_PACKAGE_GATHER_MISSING: usize = 12;
const N_PACKAGE_MISSING_START: usize = 13;
const N_OCCURRENCE_IDENTITY: usize = 14;
const N_OCCURRENCE_LOCATION: usize = 15;
const N_OCCURRENCE_EDITABLE: usize = 16;
const N_OCCURRENCE_GATHER: usize = 17;
const N_OCCURRENCE_AUDIENCE: usize = 18;
const N_OCCURRENCE_COPIES: usize = 19;
const N_COPY_KIND: usize = 20;
const N_GAP_REASON: usize = 21;

use game_text_index::snapshot::{self, Writer};
use game_text_index::wtf8::{self, Wtf8Buf};
use game_text_index::{Result, require};
use serde::{Deserialize, Serialize};

use crate::protocol_result::{
    EditCapability, ProjectionStatus, SavedAssetPackageTextRecord, SavedAssetTextOccurrence,
    TextCoverageGapReason, TextExtractionIdentity, TextExtractionLocation, TextUnresolvedReason,
};

mod audience;
mod copies;
mod mounting;
pub mod shards;
pub use audience::AudienceRule;
pub use mounting::native_stored;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Occurrence {
    pub source: String,
    #[serde(default)]
    pub dev_notes: String,
    pub identity: TextExtractionIdentity,
    pub location: TextExtractionLocation,
    pub edit_capability: EditCapability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gather_editor_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub copies: Vec<RepresentationCopy>,
    /// Code text the target's gather leaves out: editor-only text in a target that does not
    /// gather editor-only data. Its `gather_editor_only` is `Some(true)`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub left_out: bool,
}
impl From<SavedAssetTextOccurrence> for Occurrence {
    fn from(value: SavedAssetTextOccurrence) -> Self {
        Self {
            source: value.source,
            dev_notes: value.dev_notes,
            identity: value.identity,
            location: value.location,
            edit_capability: value.edit_capability,
            gather_editor_only: value.gather_editor_only,
            copies: Vec::new(),
            left_out: false,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CopyKind {
    GeneratedClass,
    ClassDefault,
    Skeleton,
    Instance,
}
impl CopyKind {
    fn code(self) -> u32 {
        match self {
            Self::GeneratedClass => 0,
            Self::ClassDefault => 1,
            Self::Skeleton => 2,
            Self::Instance => 3,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RepresentationCopy {
    pub object_path: String,
    pub kind: CopyKind,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gather_editor_only: Option<bool>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", deny_unknown_fields)]
pub enum Evidence {
    #[serde(rename = "text_package_record")]
    Package {
        #[serde(flatten)]
        record: Box<SavedAssetPackageTextRecord<Occurrence>>,
        #[serde(skip)]
        blueprint_json: Option<String>,
    },
    #[serde(rename = "not_gatherable")]
    NotGatherable { path: String },
    #[serde(rename = "error")]
    Error {
        code: String,
        message: String,
        path: String,
        #[serde(rename = "retrySafe")]
        retry_safe: bool,
        #[serde(skip)]
        json: Option<String>,
    },
}
// The two persisted JSON-valued cells retain member order at this input boundary.
#[derive(Deserialize)]
#[serde(tag = "event", deny_unknown_fields)]
enum EvidenceInput {
    #[serde(rename = "text_package_record")]
    Package {
        #[serde(flatten)]
        record: Box<SavedAssetPackageTextRecord<Occurrence>>,
    },
    #[serde(rename = "not_gatherable")]
    NotGatherable { path: String },
    #[serde(rename = "error")]
    Error {
        code: String,
        message: String,
        path: String,
        #[serde(rename = "retrySafe")]
        retry_safe: bool,
    },
}
impl<'de> Deserialize<'de> for Evidence {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        use serde::de::Error;
        let value = serde_json::Value::deserialize(decoder)?;
        let cell = |value: &serde_json::Value| {
            wtf8::view_json(value)
                .map(|json| Wtf8Buf::from_utf8(&json).into_view())
                .map_err(D::Error::custom)
        };
        let error_json = if value.get("event").and_then(serde_json::Value::as_str) == Some("error")
        {
            Some(cell(&value)?)
        } else {
            None
        };
        let blueprint_json = value.get("blueprintClasses").map(cell).transpose()?;
        Ok(
            match serde_json::from_value(value).map_err(D::Error::custom)? {
                EvidenceInput::Package { record } => Self::Package {
                    record,
                    blueprint_json,
                },
                EvidenceInput::NotGatherable { path } => Self::NotGatherable { path },
                EvidenceInput::Error {
                    code,
                    message,
                    path,
                    retry_safe,
                } => Self::Error {
                    code,
                    message,
                    path,
                    retry_safe,
                    json: error_json,
                },
            },
        )
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Stored {
    pub signature: String,
    pub path: String,
    pub evidence: Evidence,
}

#[cfg(test)]
pub use game_text_index::package_text_contract::PackageTextShard as Shard;
pub use game_text_index::package_text_contract::{
    PackageTextExpected as Expected, PackageTextSnapshotRequest as SnapshotRequest,
};

const DOMAINS: [&str; 3] = ["source", "identity", "paths"];
const STRINGS: [(&str, usize); 23] = [
    ("package.path", 2),
    ("package.signature", 1),
    ("package.error", 2),
    ("occurrence.source", 0),
    ("occurrence.notes", 0),
    ("occurrence.namespace", 1),
    ("occurrence.key", 1),
    ("occurrence.object", 2),
    ("occurrence.property", 2),
    ("occurrence.class", 2),
    ("occurrence.row", 2),
    ("gap.object", 2),
    ("gap.property", 2),
    ("missing.namespace", 1),
    ("missing.key", 1),
    ("missing.source", 0),
    ("missing.site", 2),
    ("copy.object", 2),
    ("copy.source", 0),
    ("copy.class", 2),
    ("package.blueprints", 2),
    ("package.name", 2),
    ("package.asset_class", 2),
];
const NUMBERS: [&str; 22] = [
    "package.status",
    "package.bytes_low",
    "package.bytes_high",
    "package.decode_errors",
    "package.occurrence_start",
    "package.gap_start",
    "package.gap0",
    "package.gap1",
    "package.gap2",
    "package.gap3",
    "package.gather",
    "package.gather_sites",
    "package.gather_missing",
    "package.missing_start",
    "occurrence.identity",
    "occurrence.location",
    "occurrence.editable",
    "occurrence.gather",
    "occurrence.audience",
    "occurrence.copies",
    "copy.kind",
    "gap.reason",
];

#[derive(Default)]
struct Table {
    values: Vec<String>,
    ids: FastHashMap<String, u32>,
}
impl Table {
    #[inline]
    fn wtf8_len(value: &str) -> usize {
        if !value.as_bytes().contains(&0xf3) {
            value.len()
        } else {
            Wtf8Buf::from_view(value).as_bytes().len()
        }
    }
    fn intern(&mut self, value: &str) -> Result<u32> {
        if let Some(id) = self.ids.get(value) {
            return Ok(*id);
        }
        require(Self::wtf8_len(value) <= 1024 * 1024, "string exceeds 1 MiB")?;
        require(self.values.len() < 64_000_000, "string count exceeds cap")?;
        let id = self.values.len() as u32;
        self.values.push(value.to_owned());
        self.ids.insert(value.to_owned(), id);
        Ok(id)
    }
}

pub struct Columns {
    tables: [Table; 3],
    string_cols: [Vec<u32>; 23],
    number_cols: [Vec<u32>; 22],
    occurrences: u32,
    gaps: u32,
    missing: u32,
}
impl Columns {
    pub fn resident_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .tables
                .iter()
                .map(|t| {
                    t.values.capacity() * std::mem::size_of::<String>()
                        + t.values.iter().map(String::capacity).sum::<usize>()
                        + t.ids.capacity() * (std::mem::size_of::<String>() + 4)
                        + t.ids.keys().map(String::capacity).sum::<usize>()
                })
                .sum::<usize>()
            + self
                .string_cols
                .iter()
                .chain(self.number_cols.iter())
                .map(|v| v.capacity() * 4)
                .sum::<usize>()
    }
    /// Merge package-local tables in sorted package order to preserve first-insertion IDs.
    pub fn append(&mut self, other: Self) -> Result<()> {
        let mut maps: [Vec<u32>; 3] = std::array::from_fn(|_| Vec::new());
        for (domain, table) in other.tables.into_iter().enumerate() {
            maps[domain].reserve(table.values.len());
            for text in table.values {
                maps[domain].push(self.tables[domain].intern(&text)?);
            }
        }
        for (idx, values) in other.string_cols.into_iter().enumerate() {
            let map = &maps[STRINGS[idx].1];
            let dst = &mut self.string_cols[idx];
            dst.reserve(values.len());
            for value in values {
                dst.push(*map.get(value as usize).ok_or("invalid local string ID")?);
            }
        }
        for (idx, values) in other.number_cols.into_iter().enumerate() {
            let offset = match idx {
                N_PACKAGE_OCCURRENCE_START => self.occurrences,
                N_PACKAGE_GAP_START => self.gaps,
                N_PACKAGE_MISSING_START => self.missing,
                _ => 0,
            };
            let dst = &mut self.number_cols[idx];
            dst.reserve(values.len());
            if offset == 0 {
                dst.extend(values);
            } else {
                dst.extend(values.into_iter().map(|v| v + offset));
            }
        }
        self.occurrences += other.occurrences;
        self.gaps += other.gaps;
        self.missing += other.missing;
        Ok(())
    }
    pub fn new() -> Result<Self> {
        let mut tables = std::array::from_fn(|_| Table::default());
        for table in &mut tables {
            table.intern("")?;
        }
        Ok(Self {
            tables,
            string_cols: std::array::from_fn(|_| Vec::new()),
            number_cols: std::array::from_fn(|_| Vec::new()),
            occurrences: 0,
            gaps: 0,
            missing: 0,
        })
    }
    #[inline]
    fn number(&mut self, col: usize, value: u32) {
        self.number_cols[col].push(value);
    }
    #[inline]
    fn string(&mut self, col: usize, value: &str) -> Result<()> {
        let domain = STRINGS[col].1;
        let id = if value.is_empty() {
            0
        } else {
            self.tables[domain].intern(value)?
        };
        self.string_cols[col].push(id);
        Ok(())
    }
    /// Direct fast path for `Evidence::NotGatherable` entries (typically 98%+ of a project).
    pub fn feed_not_gatherable(&mut self, path: &str, signature: &str) -> Result<()> {
        let _span = game_text_index::scan_timings::Span::new("extract.columns");
        self.string(S_PACKAGE_PATH, path)?;
        self.string(S_PACKAGE_SIGNATURE, signature)?;
        self.string_cols[S_PACKAGE_ERROR].push(0);
        self.string_cols[S_PACKAGE_NAME].push(0);
        self.string_cols[S_PACKAGE_ASSET_CLASS].push(0);
        self.string_cols[S_PACKAGE_BLUEPRINTS].push(0);
        self.number_cols[N_PACKAGE_STATUS].push(2);
        self.number_cols[N_PACKAGE_BYTES_LOW].push(0);
        self.number_cols[N_PACKAGE_BYTES_HIGH].push(0);
        self.number_cols[N_PACKAGE_DECODE_ERRORS].push(0);
        self.number_cols[N_PACKAGE_OCCURRENCE_START].push(self.occurrences);
        self.number_cols[N_PACKAGE_GAP_START].push(self.gaps);
        self.number_cols[N_PACKAGE_MISSING_START].push(self.missing);
        self.number_cols[N_PACKAGE_GATHER].push(0);
        self.number_cols[N_PACKAGE_GATHER_SITES].push(0);
        self.number_cols[N_PACKAGE_GATHER_MISSING].push(0);
        self.number_cols[N_PACKAGE_GAP0].push(0);
        self.number_cols[N_PACKAGE_GAP1].push(0);
        self.number_cols[N_PACKAGE_GAP2].push(0);
        self.number_cols[N_PACKAGE_GAP3].push(0);
        Ok(())
    }
    pub fn feed(&mut self, stored: Stored, rules: &[AudienceRule]) -> Result<()> {
        let _span = game_text_index::scan_timings::Span::new("extract.columns");
        let mut evidence = stored.evidence;
        if let Evidence::Package { record, .. } = &mut evidence {
            copies::fold(record)?;
        }
        self.string(S_PACKAGE_PATH, &stored.path)?;
        self.string(S_PACKAGE_SIGNATURE, &stored.signature)?;
        self.string(
            S_PACKAGE_ERROR,
            &if let Evidence::Error {
                json: Some(json), ..
            } = &evidence
            {
                json.clone()
            } else if matches!(evidence, Evidence::Error { .. }) {
                Wtf8Buf::from_utf8(&wtf8::view_json(&serde_json::to_value(&evidence)?)?).into_view()
            } else {
                String::new()
            },
        )?;
        let record = if let Evidence::Package { record, .. } = &evidence {
            Some(record)
        } else {
            None
        };
        self.string(
            S_PACKAGE_NAME,
            record.and_then(|r| r.package_name.as_deref()).unwrap_or(""),
        )?;
        self.string(
            S_PACKAGE_ASSET_CLASS,
            record.and_then(|r| r.asset_class.as_deref()).unwrap_or(""),
        )?;
        self.number(
            N_PACKAGE_STATUS,
            match &evidence {
                Evidence::Package { record, .. } => {
                    u32::from(record.status == ProjectionStatus::Partial)
                }
                Evidence::NotGatherable { .. } => 2,
                Evidence::Error { .. } => 3,
            },
        );
        let bytes = record.map_or(0, |r| r.file_bytes);
        self.number(N_PACKAGE_BYTES_LOW, bytes as u32);
        self.number(N_PACKAGE_BYTES_HIGH, (bytes >> 32) as u32);
        self.number(
            N_PACKAGE_DECODE_ERRORS,
            record.map_or(0, |r| r.decode_errors as u32),
        );
        self.number(N_PACKAGE_OCCURRENCE_START, self.occurrences);
        self.number(N_PACKAGE_GAP_START, self.gaps);
        self.number(N_PACKAGE_MISSING_START, self.missing);
        self.string(
            S_PACKAGE_BLUEPRINTS,
            &match record {
                Some(r) if !r.blueprint_classes.is_empty() => {
                    if let Evidence::Package {
                        blueprint_json: Some(json),
                        ..
                    } = &evidence
                    {
                        json.clone()
                    } else {
                        Wtf8Buf::from_utf8(&wtf8::view_json(&serde_json::to_value(
                            &r.blueprint_classes,
                        )?)?)
                        .into_view()
                    }
                }
                _ => String::new(),
            },
        )?;
        let gather = record.and_then(|r| r.gather_coverage.as_ref());
        self.number(N_PACKAGE_GATHER, u32::from(gather.is_some()));
        self.number(
            N_PACKAGE_GATHER_SITES,
            gather.map_or(0, |g| g.runtime_sites as u32),
        );
        self.number(
            N_PACKAGE_GATHER_MISSING,
            gather.map_or(0, |g| g.missing as u32),
        );
        let counts = record.map(|r| &r.gap_counts);
        self.number(
            N_PACKAGE_GAP0,
            counts.map_or(0, |c| c.unsupported_text_history) as u32,
        );
        self.number(
            N_PACKAGE_GAP1,
            counts.map_or(0, |c| c.legacy_container_element_without_type_information) as u32,
        );
        self.number(
            N_PACKAGE_GAP2,
            counts.map_or(0, |c| c.feature_unavailable_for_engine_version) as u32,
        );
        self.number(
            N_PACKAGE_GAP3,
            counts.map_or(0, |c| c.property_decoder_rejected) as u32,
        );
        let Some(record) = record else {
            return Ok(());
        };
        for occurrence in &record.occurrences {
            let (namespace, key, identity) = match &occurrence.identity {
                TextExtractionIdentity::Resolved { namespace, key } => {
                    (namespace.as_str(), key.as_str(), 0)
                }
                TextExtractionIdentity::StringTable { table_id, key } => {
                    (table_id.as_str(), key.as_str(), 1)
                }
                TextExtractionIdentity::Unresolved { reason } => (
                    "",
                    "",
                    match reason {
                        TextUnresolvedReason::CultureInvariant => 2,
                        TextUnresolvedReason::MissingKey => 3,
                    },
                ),
            };
            let (object, property, class, row, location) = location(&occurrence.location);
            let line = match &occurrence.location {
                TextExtractionLocation::CodePlace {
                    line: Some(line), ..
                } => line.to_string(),
                _ => String::new(),
            };
            let row = if location == 3 { line.as_str() } else { row };
            self.string(S_OCCURRENCE_SOURCE, occurrence.source.as_str())?;
            self.string(S_OCCURRENCE_NOTES, occurrence.dev_notes.as_str())?;
            self.string(S_OCCURRENCE_NAMESPACE, namespace)?;
            self.string(S_OCCURRENCE_KEY, key)?;
            self.string(S_OCCURRENCE_OBJECT, object)?;
            self.string(S_OCCURRENCE_PROPERTY, property)?;
            self.string(S_OCCURRENCE_CLASS, class)?;
            self.string(S_OCCURRENCE_ROW, row)?;
            self.number(N_OCCURRENCE_IDENTITY, identity);
            self.number(N_OCCURRENCE_LOCATION, location);
            self.number(
                N_OCCURRENCE_EDITABLE,
                u32::from(occurrence.edit_capability == EditCapability::SourceEditable),
            );
            // 3 marks code text the target leaves out; the join rates it outside the target.
            self.number(
                N_OCCURRENCE_GATHER,
                if occurrence.left_out {
                    3
                } else {
                    occurrence
                        .gather_editor_only
                        .map_or(0, |v| if v { 2 } else { 1 })
                },
            );
            self.number(
                N_OCCURRENCE_AUDIENCE,
                audience::classify_folded(occurrence, rules),
            );
            // package-text-columns.ts:118-133, 300-323: copies share source/class IDs and are sparse.
            let differs = occurrence
                .copies
                .iter()
                .any(|c| c.source != occurrence.source && c.kind != CopyKind::Skeleton);
            self.number(
                N_OCCURRENCE_COPIES,
                if occurrence.copies.is_empty() {
                    0
                } else {
                    (occurrence.copies.len() as u32).wrapping_shl(2)
                        | 1
                        | if differs { 2 } else { 0 }
                },
            );
            for copy in &occurrence.copies {
                let same_source = copy.source == occurrence.source;
                let same_class = location == 0 && copy.class_path.as_deref() == Some(class);
                self.string(S_COPY_OBJECT, &copy.object_path)?;
                self.string(S_COPY_SOURCE, if same_source { "" } else { &copy.source })?;
                self.string(
                    S_COPY_CLASS,
                    if same_class {
                        ""
                    } else {
                        copy.class_path.as_deref().unwrap_or("")
                    },
                )?;
                self.number(
                    N_COPY_KIND,
                    copy.kind.code()
                        | if same_source { 4 } else { 0 }
                        | copy
                            .gather_editor_only
                            .map_or(0, |v| if v { 16 } else { 8 })
                        | if same_class { 32 } else { 0 },
                );
            }
            self.occurrences += 1;
        }
        for gap in &record.gap_samples {
            self.string(S_GAP_OBJECT, &gap.object_path)?;
            self.string(S_GAP_PROPERTY, &gap.property_path)?;
            self.number(
                N_GAP_REASON,
                match gap.reason {
                    TextCoverageGapReason::UnsupportedTextHistory => 0,
                    TextCoverageGapReason::LegacyContainerElementWithoutTypeInformation => 1,
                    TextCoverageGapReason::FeatureUnavailableForEngineVersion => 2,
                    TextCoverageGapReason::PropertyDecoderRejected => 3,
                },
            );
            self.gaps += 1;
        }
        if let Some(gather) = gather {
            for sample in &gather.missing_samples {
                self.string(S_MISSING_NAMESPACE, &sample.namespace)?;
                self.string(S_MISSING_KEY, &sample.key)?;
                self.string(S_MISSING_SOURCE, &sample.source)?;
                self.string(S_MISSING_SITE, &sample.site)?;
                self.missing += 1;
            }
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<Vec<Column>> {
        self.number(N_PACKAGE_OCCURRENCE_START, self.occurrences);
        self.number(N_PACKAGE_GAP_START, self.gaps);
        self.number(N_PACKAGE_MISSING_START, self.missing);
        let counts = self.tables.each_ref().map(|t| t.values.len() as u32);
        let mut columns = Vec::with_capacity(64);
        for (domain, table) in DOMAINS.into_iter().zip(self.tables) {
            let mut start = 0;
            let mut starts = Vec::new();
            while start < table.values.len() {
                let mut end = start;
                let mut bytes = 8;
                while end < table.values.len() {
                    let next = Table::wtf8_len(&table.values[end]) + 4;
                    if end > start && bytes + next > snapshot::BLOCK_BYTES {
                        break;
                    }
                    bytes += next;
                    end += 1;
                }
                starts.push(start as u32);
                columns.push(Column {
                    name: format!("{domain}.b{}", starts.len() - 1),
                    kind: 4,
                    domain: domain.into(),
                    strings: table.values.len() as u32,
                    bytes: snapshot::string_block_bytes(
                        &table.values[start..end]
                            .iter()
                            .map(|s| {
                                if !s.as_bytes().contains(&0xf3) {
                                    s.as_bytes().to_vec()
                                } else {
                                    Wtf8Buf::from_view(s).into_bytes()
                                }
                            })
                            .collect::<Vec<_>>(),
                    )?,
                });
                start = end;
            }
            columns.push(Column {
                name: format!("{domain}.starts"),
                kind: 2,
                domain: String::new(),
                strings: 0,
                bytes: snapshot::u32_bytes(&starts),
            });
        }
        for ((name, domain), values) in STRINGS.iter().zip(self.string_cols) {
            columns.push(Column {
                name: (*name).into(),
                kind: 3,
                domain: DOMAINS[*domain].into(),
                strings: counts[*domain],
                bytes: snapshot::u32_bytes(&values),
            });
        }
        for (name, values) in NUMBERS.iter().zip(self.number_cols) {
            columns.push(Column {
                name: (*name).into(),
                kind: 2,
                domain: String::new(),
                strings: 0,
                bytes: snapshot::u32_bytes(&values),
            });
        }
        Ok(columns)
    }
}
pub struct Column {
    pub name: String,
    pub kind: u32,
    pub domain: String,
    pub strings: u32,
    pub bytes: Vec<u8>,
}
pub fn write_staged(path: &std::path::Path, columns: &[Column]) -> Result<u64> {
    let mut writer = Writer::new(&path.with_extension("payload"))?;
    let mut order = Vec::new();
    for column in columns {
        order.push(writer.add_staged(
            &column.name,
            column.kind,
            &column.domain,
            &column.bytes,
            column.strings,
        )?);
    }
    writer.finish_staged(path, &order)
}

pub fn location(location: &TextExtractionLocation) -> (&str, &str, &str, &str, u32) {
    match location {
        TextExtractionLocation::AssetProperty {
            object_path,
            property_path,
            class_path,
        } => (object_path, property_path, class_path, "", 0),
        TextExtractionLocation::DataTableCell {
            object_path,
            property_path,
            row,
        } => (object_path, property_path, "", row, 1),
        TextExtractionLocation::StringTableEntry {
            object_path,
            entry_key,
        } => (object_path, "", "", entry_key, 2),
        // The line is a number; `Columns::feed` writes it to the row column itself. A String
        // Table entry has no wrapper, so its table ID takes the class column.
        TextExtractionLocation::CodePlace {
            file,
            macro_name,
            wrapper,
            table,
            ..
        } => (
            file,
            macro_name,
            wrapper.as_deref().or(table.as_deref()).unwrap_or(""),
            "",
            3,
        ),
    }
}
