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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetTextOccurrence {
    pub source: String,
    #[serde(default)]
    pub dev_notes: String,
    pub identity: TextExtractionIdentity,
    pub location: TextExtractionLocation,
    pub edit_capability: EditCapability,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum TextExtractionIdentity {
    #[serde(rename = "resolved")]
    Resolved { namespace: String, key: String },
    #[serde(rename = "string_table")]
    StringTable { table_id: String, key: String },
    #[serde(rename = "unresolved")]
    Unresolved { reason: TextUnresolvedReason },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextUnresolvedReason {
    CultureInvariant,
    MissingKey,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum TextExtractionLocation {
    #[serde(rename = "data_table_cell")]
    DataTableCell {
        object_path: String,
        row: String,
        property_path: String,
    },
    #[serde(rename = "string_table_entry")]
    StringTableEntry {
        object_path: String,
        entry_key: String,
    },
    #[serde(rename = "asset_property")]
    AssetProperty {
        object_path: String,
        class_path: String,
        property_path: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditCapability {
    SourceEditable,
    ReadOnly,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetTextCoverageGap {
    pub object_path: String,
    pub property_path: String,
    pub reason: TextCoverageGapReason,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextCoverageGapReason {
    UnsupportedTextHistory,
}

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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetTextureRecord {
    pub object_path: String,
    pub package_file_bytes: TextureEvidence<u64>,
    pub dimensions: TextureEvidence<TextureDimensions>,
    pub source_format: TextureEvidence<String>,
    pub source_mips: TextureEvidence<u64>,
    pub compression: TextureEvidence<String>,
    pub s_rgb: TextureEvidence<bool>,
    pub texture_group: TextureEvidence<String>,
    pub mip_generation: TextureEvidence<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum TextureEvidence<T> {
    #[serde(rename = "available")]
    Available {
        source: TextureEvidenceSource,
        value: T,
    },
    #[serde(rename = "unavailable")]
    Unavailable { reason: TextureUnavailableReason },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextureEvidenceSource {
    Serialized,
    File,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextureUnavailableReason {
    NotSerialized,
    WrongValueKind,
    MissingSource,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TextureDimensions {
    pub width: u64,
    pub height: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorld {
    pub authority: SavedWorldAuthority,
    pub completeness: Completeness,
    pub contract: SavedWorldContract,
    pub diagnostics: Vec<SavedWorldDiagnostic>,
    #[serde(
        default,
        rename = "externalActorRoot",
        skip_serializing_if = "Option::is_none"
    )]
    pub external_actor_root: Option<String>,
    #[serde(rename = "mapPath")]
    pub map_path: String,
    #[serde(rename = "sourceKind")]
    pub source_kind: SavedWorldSourceKind,
    pub actors: Vec<SavedWorldActor>,
    pub summary: SavedWorldSummary,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldAuthority {
    pub kind: ProjectFilesKind,
    #[serde(rename = "mapPackage")]
    pub map_package: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectFilesKind;

impl<'de> Deserialize<'de> for ProjectFilesKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value == "project_files" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected project_files"))
        }
    }
}

impl Serialize for ProjectFilesKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str("project_files")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldContract {
    pub name: SavedWorldContractName,
    pub version: SavedWorldContractVersion,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedWorldContractName;

impl<'de> Deserialize<'de> for SavedWorldContractName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value == "unreal-saved-world" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected unreal-saved-world"))
        }
    }
}

impl Serialize for SavedWorldContractName {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str("unreal-saved-world")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldContractVersion {
    pub major: u8,
    pub minor: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(rename = "retrySafe")]
    pub retry_safe: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavedWorldSourceKind {
    Level,
    WorldPartition,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldActor {
    #[serde(default, rename = "actorGuid", skip_serializing_if = "Option::is_none")]
    pub actor_guid: Option<String>,
    #[serde(rename = "actorPath")]
    pub actor_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<SavedWorldAttachment>,
    #[serde(rename = "classPath")]
    pub class_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "packageName")]
    pub package_name: String,
    pub transform: SavedWorldTransform,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum SavedWorldTransform {
    #[serde(rename = "missing_root_component")]
    MissingRootComponent,
    #[serde(rename = "missing_attachment_parent")]
    MissingAttachmentParent {
        #[serde(rename = "parentPath")]
        parent_path: String,
    },
    #[serde(rename = "attachment_cycle")]
    AttachmentCycle {
        #[serde(rename = "componentPath")]
        component_path: String,
    },
    #[serde(rename = "ambiguous_component_path")]
    AmbiguousComponentPath {
        #[serde(rename = "componentPath")]
        component_path: String,
    },
    #[serde(rename = "unsupported_absolute_transform")]
    UnsupportedAbsoluteTransform {
        #[serde(rename = "componentPath")]
        component_path: String,
    },
    #[serde(rename = "non_finite_transform")]
    NonFiniteTransform {
        #[serde(rename = "componentPath")]
        component_path: String,
    },
    #[serde(rename = "resolved")]
    Resolved {
        location: SavedWorldVector,
        rotation: SavedWorldQuaternion,
        scale: SavedWorldVector,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldAttachment {
    #[serde(rename = "componentPath")]
    pub component_path: String,
    #[serde(rename = "parentComponentPath")]
    pub parent_component_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldVector {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldQuaternion {
    pub w: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldSummary {
    #[serde(rename = "failedPackages")]
    pub failed_packages: u64,
    #[serde(rename = "partialPackages")]
    pub partial_packages: u64,
    #[serde(rename = "resolvedActors")]
    pub resolved_actors: u64,
    #[serde(rename = "scannedPackages")]
    pub scanned_packages: u64,
}

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
