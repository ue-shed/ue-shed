//! Package-text local columns, matching packages/game-text/src/package-text-columns.ts.
use std::collections::HashMap;

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
    ids: HashMap<String, u32>,
}
impl Table {
    fn intern(&mut self, value: &str) -> Result<u32> {
        if let Some(id) = self.ids.get(value) {
            return Ok(*id);
        }
        require(
            Wtf8Buf::from_view(value).as_bytes().len() <= 1024 * 1024,
            "string exceeds 1 MiB",
        )?;
        require(self.values.len() < 64_000_000, "string count exceeds cap")?;
        let id = self.values.len() as u32;
        self.values.push(value.to_owned());
        self.ids.insert(value.to_owned(), id);
        Ok(id)
    }
}

pub struct Columns {
    tables: [Table; 3],
    values: HashMap<&'static str, Vec<u32>>,
    occurrences: u32,
    gaps: u32,
    missing: u32,
}
impl Columns {
    pub fn resident_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.values.capacity()
                * (std::mem::size_of::<&str>() + std::mem::size_of::<Vec<u32>>())
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
                .values
                .values()
                .map(|v| v.capacity() * 4)
                .sum::<usize>()
    }
    /// Merge package-local tables in sorted package order to preserve first-insertion IDs.
    pub fn append(&mut self, other: Self) -> Result<()> {
        let mut maps: [Vec<u32>; 3] = std::array::from_fn(|_| Vec::new());
        for (domain, table) in other.tables.into_iter().enumerate() {
            for text in table.values {
                maps[domain].push(self.tables[domain].intern(&text)?);
            }
        }
        for (name, values) in other.values {
            let domain = STRINGS
                .iter()
                .find(|(field, _)| *field == name)
                .map(|(_, d)| *d);
            let offset = match name {
                "package.occurrence_start" => self.occurrences,
                "package.gap_start" => self.gaps,
                "package.missing_start" => self.missing,
                _ => 0,
            };
            for value in values {
                self.number(
                    name,
                    match domain {
                        Some(d) => *maps[d]
                            .get(value as usize)
                            .ok_or("invalid local string ID")?,
                        None => value + offset,
                    },
                );
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
            values: STRINGS
                .iter()
                .map(|(name, _)| *name)
                .chain(NUMBERS)
                .filter(|n| !n.is_empty())
                .map(|name| (name, Vec::new()))
                .collect(),
            occurrences: 0,
            gaps: 0,
            missing: 0,
        })
    }
    #[expect(
        clippy::expect_used,
        reason = "only constant fields in STRINGS and NUMBERS are written"
    )]
    fn number(&mut self, field: &'static str, value: u32) {
        self.values
            .get_mut(field)
            .expect("known column")
            .push(value);
    }
    #[expect(
        clippy::expect_used,
        reason = "only constant fields in STRINGS are interned"
    )]
    fn string(&mut self, field: &'static str, value: &str) -> Result<()> {
        let domain = STRINGS
            .iter()
            .find(|(name, _)| *name == field)
            .expect("known string field")
            .1;
        let id = self.tables[domain].intern(value)?;
        self.number(field, id);
        Ok(())
    }
    pub fn feed(&mut self, stored: Stored, rules: &[AudienceRule]) -> Result<()> {
        let _span = game_text_index::scan_timings::Span::new("extract.columns");
        let mut evidence = stored.evidence;
        if let Evidence::Package { record, .. } = &mut evidence {
            copies::fold(record)?;
        }
        self.string("package.path", &stored.path)?;
        self.string("package.signature", &stored.signature)?;
        self.string(
            "package.error",
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
            "package.name",
            record.and_then(|r| r.package_name.as_deref()).unwrap_or(""),
        )?;
        self.string(
            "package.asset_class",
            record.and_then(|r| r.asset_class.as_deref()).unwrap_or(""),
        )?;
        self.number(
            "package.status",
            match &evidence {
                Evidence::Package { record, .. } => {
                    u32::from(record.status == ProjectionStatus::Partial)
                }
                Evidence::NotGatherable { .. } => 2,
                Evidence::Error { .. } => 3,
            },
        );
        let bytes = record.map_or(0, |r| r.file_bytes);
        self.number("package.bytes_low", bytes as u32);
        self.number("package.bytes_high", (bytes >> 32) as u32);
        self.number(
            "package.decode_errors",
            record.map_or(0, |r| r.decode_errors as u32),
        );
        self.number("package.occurrence_start", self.occurrences);
        self.number("package.gap_start", self.gaps);
        self.number("package.missing_start", self.missing);
        self.string(
            "package.blueprints",
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
        self.number("package.gather", u32::from(gather.is_some()));
        self.number(
            "package.gather_sites",
            gather.map_or(0, |g| g.runtime_sites as u32),
        );
        self.number(
            "package.gather_missing",
            gather.map_or(0, |g| g.missing as u32),
        );
        let counts = record.map(|r| &r.gap_counts);
        for (field, count) in [
            (
                "package.gap0",
                counts.map_or(0, |c| c.unsupported_text_history),
            ),
            (
                "package.gap1",
                counts.map_or(0, |c| c.legacy_container_element_without_type_information),
            ),
            (
                "package.gap2",
                counts.map_or(0, |c| c.feature_unavailable_for_engine_version),
            ),
            (
                "package.gap3",
                counts.map_or(0, |c| c.property_decoder_rejected),
            ),
        ] {
            self.number(field, count as u32);
        }
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
            for (field, text) in [
                ("occurrence.source", occurrence.source.as_str()),
                ("occurrence.notes", occurrence.dev_notes.as_str()),
                ("occurrence.namespace", namespace),
                ("occurrence.key", key),
                ("occurrence.object", object),
                ("occurrence.property", property),
                ("occurrence.class", class),
                ("occurrence.row", row),
            ] {
                self.string(field, text)?;
            }
            self.number("occurrence.identity", identity);
            self.number("occurrence.location", location);
            self.number(
                "occurrence.editable",
                u32::from(occurrence.edit_capability == EditCapability::SourceEditable),
            );
            self.number(
                "occurrence.gather",
                occurrence
                    .gather_editor_only
                    .map_or(0, |v| if v { 2 } else { 1 }),
            );
            self.number(
                "occurrence.audience",
                audience::classify_folded(occurrence, rules),
            );
            // package-text-columns.ts:118-133, 300-323: copies share source/class IDs and are sparse.
            let differs = occurrence
                .copies
                .iter()
                .any(|c| c.source != occurrence.source && c.kind != CopyKind::Skeleton);
            self.number(
                "occurrence.copies",
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
                self.string("copy.object", &copy.object_path)?;
                self.string("copy.source", if same_source { "" } else { &copy.source })?;
                self.string(
                    "copy.class",
                    if same_class {
                        ""
                    } else {
                        copy.class_path.as_deref().unwrap_or("")
                    },
                )?;
                self.number(
                    "copy.kind",
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
            self.string("gap.object", &gap.object_path)?;
            self.string("gap.property", &gap.property_path)?;
            self.number(
                "gap.reason",
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
                for (field, text) in [
                    ("missing.namespace", &sample.namespace),
                    ("missing.key", &sample.key),
                    ("missing.source", &sample.source),
                    ("missing.site", &sample.site),
                ] {
                    self.string(field, text)?;
                }
                self.missing += 1;
            }
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<Vec<Column>> {
        self.number("package.occurrence_start", self.occurrences);
        self.number("package.gap_start", self.gaps);
        self.number("package.missing_start", self.missing);
        let counts = self.tables.each_ref().map(|t| t.values.len() as u32);
        let mut columns = Vec::new();
        for (domain, table) in DOMAINS.into_iter().zip(self.tables) {
            let mut start = 0;
            let mut starts = Vec::new();
            while start < table.values.len() {
                let mut end = start;
                let mut bytes = 8;
                while end < table.values.len() {
                    let next = Wtf8Buf::from_view(&table.values[end]).as_bytes().len() + 4;
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
                            .map(|s| Wtf8Buf::from_view(s).into_bytes())
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
        for name in STRINGS
            .iter()
            .map(|(name, _)| *name)
            .chain(NUMBERS)
            .filter(|n| !n.is_empty())
        {
            let domain = STRINGS
                .iter()
                .find(|(field, _)| *field == name)
                .map(|(_, d)| *d);
            columns.push(Column {
                name: name.into(),
                kind: if domain.is_some() { 3 } else { 2 },
                domain: domain.map_or("", |d| DOMAINS[d]).into(),
                strings: domain.map_or(0, |d| counts[d]),
                bytes: snapshot::u32_bytes(self.values.get(name).ok_or("missing column")?),
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

#[cfg(test)]
mod tests;
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
    }
}
