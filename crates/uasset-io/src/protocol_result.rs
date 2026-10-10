//! Typed result payloads for the versioned UAsset IO process contract.
//!
//! These models intentionally mirror the JSON wire shapes owned by `@ue-shed/protocol`.
//! They are boundary types, not parser internals: a decoder can accept a result frame without
//! pulling the Effect CLI or a filesystem implementation into the parser crate.

use serde::{Deserialize, Serialize};

mod project_index_dictionary;
pub use project_index_dictionary::{ProjectIndexDictionaryItem, ProjectIndexDictionaryPage};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ResultFrame {
    #[serde(rename = "project_index_count")]
    ProjectIndexCount { result: ProjectIndexCountResult },
    #[serde(rename = "inspect")]
    Inspect { inspection: SavedAssetInspection },
    #[serde(rename = "blueprint")]
    Blueprint {
        blueprint: uasset_inspection::BlueprintGraphProjection,
    },
    #[serde(rename = "level_sequence")]
    LevelSequence {
        sequence: uasset_inspection::level_sequence::LevelSequenceProjection,
    },
    #[serde(rename = "authoring")]
    Authoring { snapshot: AuthoringTableSnapshot },
    #[serde(rename = "scan_asset")]
    ScanAsset { entry: SavedAssetScanEntry },
    #[serde(rename = "scan_inventory")]
    ScanInventory { entry: SavedAssetManifestEntry },
    #[serde(rename = "scan_summary")]
    ScanSummary { summary: SavedAssetScanSummary },
    #[serde(rename = "extract_text")]
    ExtractText {
        event: SavedAssetTextExtractionEvent,
    },
    #[serde(rename = "extract_text_packages")]
    ExtractTextPackages { event: SavedAssetPackageTextEvent },
    #[serde(rename = "extract_texture")]
    ExtractTexture {
        event: SavedAssetTextureExtractionEvent,
    },
    #[serde(rename = "saved_world")]
    SavedWorld { world: SavedWorld },
    #[serde(rename = "project_index_status")]
    ProjectIndexStatus { status: ProjectIndexStatusPayload },
    #[serde(rename = "project_index_summary")]
    ProjectIndexSummary { summary: ProjectIndexSummary },
    #[serde(rename = "project_index_page")]
    ProjectIndexPage { page: ProjectIndexPage },
    #[serde(rename = "project_index_dictionary_page")]
    ProjectIndexDictionaryPage { page: ProjectIndexDictionaryPage },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectIndexCountResult {
    pub project_id: String,
    pub generation: u64,
    pub count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProjectIndexDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(rename = "retrySafe")]
    pub retry_safe: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProjectIndexSummary {
    #[serde(rename = "changedPackages")]
    pub changed_packages: u64,
    pub completeness: ProjectIndexCompleteness,
    pub diagnostics: Vec<ProjectIndexDiagnostic>,
    pub generation: u64,
    #[serde(rename = "mapCount")]
    pub map_count: u64,
    #[serde(rename = "packageCount")]
    pub package_count: u64,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "removedPackages")]
    pub removed_packages: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectIndexCompleteness {
    Complete,
    Partial,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum ProjectIndexStatusPayload {
    #[serde(rename = "absent")]
    Absent,
    #[serde(rename = "ready")]
    Ready { summary: ProjectIndexSummary },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ProjectIndexItem {
    #[serde(rename = "map")]
    Map {
        #[serde(rename = "mapPath")]
        map_path: String,
        #[serde(rename = "packageName")]
        package_name: String,
    },
    #[serde(rename = "header")]
    Header {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "headerData"
        )]
        header_data: Option<uasset_inspection::package_header::PackageHeaderData>,
        classes: Vec<String>,
        #[serde(rename = "packageName")]
        package_name: String,
        #[serde(rename = "packagePath")]
        package_path: String,
        #[serde(rename = "serializedNames")]
        serialized_names: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProjectIndexPage {
    pub generation: u64,
    pub items: Vec<ProjectIndexItem>,
    #[serde(
        default,
        rename = "nextCursor",
        skip_serializing_if = "Option::is_none"
    )]
    pub next_cursor: Option<String>,
    #[serde(rename = "projectId")]
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetManifestEntry {
    pub kind: ManifestEntryKind,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: f64,
    pub path: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManifestEntryKind {
    Package,
    Sidecar,
}

pub use uasset_inspection::saved_inspection::{
    InspectionStatus, SavedAsset, SavedAssetDecodeError, SavedAssetDecodeErrorKind,
    SavedAssetInspection, SavedBone, SavedCurveKey, SavedCurveRow, SavedEnumEntry,
    SavedNativeField, SavedPackageSummary, SavedPackageVersion, SavedProperty,
    SavedPropertyMapEntry, SavedPropertyValue, SavedStringTableEntry, SavedStructField,
    SavedTableRow, TextHistory,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetHeader {
    #[serde(default)]
    pub exports: Vec<SavedAssetHeaderExport>,
    pub matched_names: Option<Vec<String>>,
    pub package: SavedAssetHeaderPackage,
    pub path: String,
    pub schema_version: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetHeaderExport {
    pub class_name: Option<String>,
    pub class_path: Option<String>,
    pub object_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetHeaderPackage {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_data: Option<uasset_inspection::package_header::PackageHeaderData>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "depth", deny_unknown_fields)]
pub enum SavedAssetScanEntry {
    #[serde(rename = "full")]
    Full {
        #[serde(rename = "fileBytes")]
        file_bytes: u64,
        inspection: SavedAssetInspection,
    },
    #[serde(rename = "header")]
    Header {
        #[serde(rename = "fileBytes")]
        file_bytes: u64,
        header: SavedAssetHeader,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetScanFailure {
    pub code: String,
    pub message: String,
    pub path: String,
    #[serde(rename = "retrySafe")]
    pub retry_safe: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetScanSummary {
    #[serde(rename = "cacheHits")]
    pub cache_hits: u64,
    pub depth: ScanSummaryDepth,
    pub diagnostics: Vec<SavedAssetScanDiagnostic>,
    #[serde(rename = "emittedAssets")]
    pub emitted_assets: u64,
    #[serde(rename = "failedAssets")]
    pub failed_assets: u64,
    #[serde(rename = "inventoryComplete", skip_serializing_if = "Option::is_none")]
    pub inventory_complete: Option<bool>,
    #[serde(rename = "inventoryFiles", skip_serializing_if = "Option::is_none")]
    pub inventory_files: Option<u64>,
    #[serde(rename = "partialAssets")]
    pub partial_assets: u64,
    #[serde(rename = "projectRoot")]
    pub project_root: String,
    pub roots: Vec<String>,
    #[serde(rename = "scannedAssets")]
    pub scanned_assets: u64,
    pub schema_version: u8,
    #[serde(rename = "skippedAssets")]
    pub skipped_assets: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScanSummaryDepth {
    Header,
    Full,
    Text,
    Texture,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetScanDiagnostic {
    pub code: String,
    pub message: String,
    pub path: String,
    #[serde(rename = "retrySafe")]
    pub retry_safe: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "event", deny_unknown_fields)]
pub enum SavedAssetTextExtractionEvent {
    #[serde(rename = "text_occurrence")]
    TextOccurrence {
        schema_version: u8,
        path: String,
        #[serde(rename = "fileBytes")]
        file_bytes: u64,
        occurrence: SavedAssetTextOccurrence,
    },
    #[serde(rename = "text_coverage_gap")]
    TextCoverageGap {
        schema_version: u8,
        path: String,
        coverage_gap: SavedAssetTextCoverageGap,
    },
    #[serde(rename = "text_package")]
    TextPackage {
        #[serde(rename = "fileBytes")]
        file_bytes: u64,
        path: String,
        schema_version: u8,
        status: ProjectionStatus,
        diagnostics: Vec<SavedAssetProjectionDiagnostic>,
        occurrences: u64,
        coverage_gaps: u64,
    },
    #[serde(rename = "text_summary")]
    TextSummary {
        #[serde(flatten)]
        summary: SavedAssetScanSummary,
    },
    #[serde(rename = "error")]
    Error {
        code: String,
        message: String,
        path: String,
        #[serde(rename = "retrySafe")]
        retry_safe: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectionStatus {
    Complete,
    Partial,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TextGapCounts {
    pub unsupported_text_history: u64,
    pub legacy_container_element_without_type_information: u64,
    pub feature_unavailable_for_engine_version: u64,
    pub property_decoder_rejected: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedAssetPackageTextRecord {
    pub file_bytes: u64,
    pub path: String,
    #[serde(rename = "schema_version")]
    pub schema_version: u8,
    pub status: ProjectionStatus,
    pub decode_errors: u64,
    pub occurrences: Vec<SavedAssetTextOccurrence>,
    pub gap_counts: TextGapCounts,
    pub gap_samples: Vec<SavedAssetTextCoverageGap>,
}

impl SavedAssetPackageTextRecord {
    pub fn push_gap(&mut self, gap: SavedAssetTextCoverageGap) {
        match gap.reason {
            TextCoverageGapReason::UnsupportedTextHistory => {
                self.gap_counts.unsupported_text_history += 1
            }
            TextCoverageGapReason::LegacyContainerElementWithoutTypeInformation => {
                self.gap_counts
                    .legacy_container_element_without_type_information += 1
            }
            TextCoverageGapReason::FeatureUnavailableForEngineVersion => {
                self.gap_counts.feature_unavailable_for_engine_version += 1
            }
            TextCoverageGapReason::PropertyDecoderRejected => {
                self.gap_counts.property_decoder_rejected += 1
            }
        }
        if self.gap_samples.len() < 3 {
            self.gap_samples.push(gap);
        } else if gap.reason == TextCoverageGapReason::UnsupportedTextHistory
            && let Some(index) = self
                .gap_samples
                .iter()
                .enumerate()
                .position(|(index, sample)| {
                    index > 0 && sample.reason != TextCoverageGapReason::UnsupportedTextHistory
                })
        {
            self.gap_samples[index] = gap;
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "event", deny_unknown_fields)]
pub enum SavedAssetPackageTextEvent {
    #[serde(rename = "text_package_record")]
    Package {
        #[serde(flatten)]
        record: SavedAssetPackageTextRecord,
    },
    #[serde(rename = "text_summary")]
    Summary {
        #[serde(flatten)]
        summary: SavedAssetScanSummary,
    },
    #[serde(rename = "error")]
    Error {
        code: String,
        message: String,
        path: String,
        #[serde(rename = "retrySafe")]
        retry_safe: bool,
    },
}

pub use uasset_inspection::text_wire::{
    EditCapability, SavedAssetTextCoverageGap, SavedAssetTextOccurrence, TextCoverageGapReason,
    TextExtractionIdentity, TextExtractionLocation, TextUnresolvedReason,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetProjectionDiagnostic {
    pub object_path: String,
    pub class_path: Option<String>,
    pub code: SavedAssetDecodeErrorKind,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "event", deny_unknown_fields)]
pub enum SavedAssetTextureExtractionEvent {
    #[serde(rename = "texture_record")]
    TextureRecord {
        schema_version: u8,
        path: String,
        record: SavedAssetTextureRecord,
    },
    #[serde(rename = "texture_package")]
    TexturePackage {
        #[serde(rename = "fileBytes")]
        file_bytes: u64,
        path: String,
        schema_version: u8,
        status: ProjectionStatus,
        diagnostics: Vec<SavedAssetProjectionDiagnostic>,
        records: u64,
    },
    #[serde(rename = "texture_summary")]
    TextureSummary {
        #[serde(flatten)]
        summary: SavedAssetScanSummary,
    },
    #[serde(rename = "error")]
    Error {
        code: String,
        message: String,
        path: String,
        #[serde(rename = "retrySafe")]
        retry_safe: bool,
    },
}

pub use uasset_inspection::texture_wire::{
    SavedAssetTextureRecord, TextureDimensions, TextureEvidence, TextureEvidenceSource,
    TextureUnavailableReason,
};

pub use uasset_inspection::saved_world_wire::{
    ProjectFilesKind, SavedWorld, SavedWorldActor, SavedWorldAttachment, SavedWorldAuthority,
    SavedWorldContract, SavedWorldContractName, SavedWorldContractVersion, SavedWorldDiagnostic,
    SavedWorldQuaternion, SavedWorldSourceKind, SavedWorldSummary, SavedWorldTransform,
    SavedWorldVector,
};

pub use uasset_inspection::authoring::{
    AuthoringAnnotations, AuthoringAuthority, AuthoringContractName, AuthoringContractV1,
    AuthoringContractV2, AuthoringContractVersionV1, AuthoringContractVersionV2,
    AuthoringDefaultValue, AuthoringDiagnostic, AuthoringEditability, AuthoringEnumOption,
    AuthoringFieldDescriptor, AuthoringFieldValue, AuthoringFingerprint,
    AuthoringFingerprintAlgorithm, AuthoringFloatValue, AuthoringMapEntry, AuthoringPresence,
    AuthoringProducer, AuthoringReferenceKind, AuthoringReferenceTarget, AuthoringRow,
    AuthoringRowReferenceAnnotation, AuthoringScalarKind, AuthoringSchemaSource,
    AuthoringSpecialFloat, AuthoringTableKind, AuthoringTableSchema, AuthoringTableSnapshot,
    AuthoringTableSnapshotV1, AuthoringTableSnapshotV2, AuthoringTableV1, AuthoringTableV2,
    AuthoringTypeDescriptor, AuthoringValue, Completeness,
};

#[cfg(test)]
mod package_text_tests {
    use super::*;

    #[test]
    fn counts_every_gap_but_keeps_first_and_two_preferred_history_samples() {
        let mut record = SavedAssetPackageTextRecord {
            file_bytes: 0,
            path: "Fixture.uasset".into(),
            schema_version: 1,
            status: ProjectionStatus::Partial,
            decode_errors: 0,
            occurrences: Vec::new(),
            gap_counts: TextGapCounts::default(),
            gap_samples: Vec::new(),
        };
        for (index, reason) in [
            TextCoverageGapReason::PropertyDecoderRejected,
            TextCoverageGapReason::FeatureUnavailableForEngineVersion,
            TextCoverageGapReason::LegacyContainerElementWithoutTypeInformation,
            TextCoverageGapReason::UnsupportedTextHistory,
            TextCoverageGapReason::UnsupportedTextHistory,
            TextCoverageGapReason::UnsupportedTextHistory,
        ]
        .into_iter()
        .enumerate()
        {
            record.push_gap(SavedAssetTextCoverageGap {
                object_path: "Fixture".into(),
                property_path: index.to_string(),
                reason,
            });
        }
        assert_eq!(
            record
                .gap_samples
                .iter()
                .map(|gap| gap.property_path.as_str())
                .collect::<Vec<_>>(),
            vec!["0", "3", "4"]
        );
        assert_eq!(
            record.gap_counts,
            TextGapCounts {
                property_decoder_rejected: 1,
                feature_unavailable_for_engine_version: 1,
                legacy_container_element_without_type_information: 1,
                unsupported_text_history: 3,
            }
        );
    }
}
