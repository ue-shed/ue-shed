//! Typed result payloads for the versioned UAsset IO process contract.
//!
//! These models intentionally mirror the JSON wire shapes owned by `@ue-shed/protocol`.
//! They are boundary types, not parser internals: a decoder can accept a result frame without
//! pulling the Effect CLI or a filesystem implementation into the parser crate.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ResultFrame {
    #[serde(rename = "inspect")]
    Inspect { inspection: SavedAssetInspection },
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetInspection {
    pub schema_version: u8,
    pub status: InspectionStatus,
    pub path: String,
    pub package: SavedPackageSummary,
    pub assets: Vec<SavedAsset>,
    #[serde(default)]
    pub decode_errors: Vec<SavedAssetDecodeError>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InspectionStatus {
    Ok,
    Partial,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedPackageSummary {
    pub name: String,
    pub version: SavedPackageVersion,
    pub package_flags: u64,
    pub summary_size: u64,
    pub total_header_size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedPackageVersion {
    pub legacy_file: f64,
    pub legacy_ue3: f64,
    pub ue4: f64,
    pub ue5: f64,
    pub licensee: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SavedAsset {
    #[serde(rename = "StringTable")]
    StringTable {
        object_path: String,
        string_table_namespace: String,
        string_table_entries: Vec<SavedStringTableEntry>,
    },
    #[serde(rename = "UObject")]
    UObject {
        object_path: String,
        class_path: String,
        #[serde(default)]
        properties: Vec<SavedProperty>,
        tail_bytes: Option<u64>,
    },
    #[serde(rename = "DataAsset")]
    DataAsset {
        object_path: String,
        class_path: String,
        object_guid: Option<String>,
        #[serde(default)]
        properties: Vec<SavedProperty>,
    },
    #[serde(rename = "PrimaryDataAsset")]
    PrimaryDataAsset {
        object_path: String,
        class_path: String,
        object_guid: Option<String>,
        #[serde(default)]
        properties: Vec<SavedProperty>,
    },
    #[serde(rename = "CurveTable")]
    CurveTable {
        object_path: String,
        class_path: String,
        #[serde(default)]
        properties: Vec<SavedProperty>,
        row_count: u64,
        curve_rows: Vec<SavedCurveRow>,
    },
    #[serde(rename = "Skeleton")]
    Skeleton {
        object_path: String,
        class_path: String,
        object_guid: Option<String>,
        #[serde(default)]
        properties: Vec<SavedProperty>,
        bones: Vec<SavedBone>,
    },
    #[serde(rename = "Enum")]
    Enum {
        object_path: String,
        class_path: String,
        enum_cpp_form: String,
        enum_entries: Vec<SavedEnumEntry>,
        row_count: u64,
    },
    #[serde(rename = "Struct")]
    Struct {
        object_path: String,
        class_path: String,
        struct_flags: u64,
        struct_fields: Vec<SavedStructField>,
        #[serde(default)]
        properties: Vec<SavedProperty>,
        row_count: u64,
    },
    #[serde(rename = "DataTable")]
    DataTable {
        object_path: String,
        row_struct: Option<String>,
        parent_tables: Option<Vec<String>>,
        row_count: u64,
        rows: Vec<SavedTableRow>,
    },
    #[serde(rename = "CompositeDataTable")]
    CompositeDataTable {
        object_path: String,
        row_struct: Option<String>,
        parent_tables: Option<Vec<String>>,
        row_count: u64,
        rows: Vec<SavedTableRow>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedStringTableEntry {
    pub key: String,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedCurveRow {
    pub name: String,
    pub keys: Vec<SavedCurveKey>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedCurveKey {
    pub time: Option<f64>,
    pub value: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedBone {
    pub name: String,
    pub parent_index: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedEnumEntry {
    pub name: String,
    pub value: i64,
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedStructField {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub referenced_path: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedTableRow {
    pub name: String,
    pub properties: Vec<SavedProperty>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "value_kind", deny_unknown_fields)]
pub enum SavedPropertyValue {
    #[serde(rename = "bool")]
    Bool { value: bool },
    #[serde(rename = "int")]
    Int { value: f64 },
    #[serde(rename = "uint")]
    UInt { value: f64 },
    #[serde(rename = "float")]
    Float { value: Option<f64> },
    #[serde(rename = "double")]
    Double { value: Option<f64> },
    #[serde(rename = "name")]
    Name { value: String },
    #[serde(rename = "enum")]
    EnumValue { value: String },
    #[serde(rename = "string")]
    StringValue { value: String },
    #[serde(rename = "guid")]
    Guid { value: String },
    #[serde(rename = "soft_object_path")]
    SoftObjectPath { value: String },
    #[serde(rename = "text")]
    Text {
        value: String,
        history: TextHistory,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        key: Option<String>,
    },
    #[serde(rename = "object_ref")]
    ObjectRef { value: Option<String> },
    #[serde(rename = "data_table_row_handle")]
    DataTableRowHandle {
        table_object_path: Option<String>,
        row_name: String,
    },
    #[serde(rename = "vector")]
    Vector {
        x: Option<f64>,
        y: Option<f64>,
        z: Option<f64>,
    },
    #[serde(rename = "int_point")]
    IntPoint { x: f64, y: f64 },
    #[serde(rename = "rotator")]
    Rotator {
        pitch: Option<f64>,
        yaw: Option<f64>,
        roll: Option<f64>,
    },
    #[serde(rename = "color")]
    Color { r: f64, g: f64, b: f64, a: f64 },
    #[serde(rename = "linear_color")]
    LinearColor {
        r: Option<f64>,
        g: Option<f64>,
        b: Option<f64>,
        a: Option<f64>,
    },
    #[serde(rename = "array")]
    Array { values: Vec<SavedPropertyValue> },
    #[serde(rename = "set")]
    Set { values: Vec<SavedPropertyValue> },
    #[serde(rename = "map")]
    Map { entries: Vec<SavedPropertyMapEntry> },
    #[serde(rename = "struct")]
    Struct { properties: Vec<SavedProperty> },
    #[serde(rename = "raw")]
    Raw { reason: String, size: u64 },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextHistory {
    None,
    Base,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedPropertyMapEntry {
    pub key: SavedPropertyValue,
    pub value: SavedPropertyValue,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SavedProperty {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(flatten)]
    pub value: SavedPropertyValue,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetDecodeError {
    pub object_path: String,
    pub class_path: Option<String>,
    pub kind: SavedAssetDecodeErrorKind,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavedAssetDecodeErrorKind {
    MalformedData,
    ResourceLimit,
    UnsupportedFormat,
    UnsupportedVersion,
    UnsupportedCapability,
}

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
    #[serde(rename = "inventoryComplete")]
    pub inventory_complete: Option<bool>,
    #[serde(rename = "inventoryFiles")]
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
    pub identity: TextExtractionIdentity,
    pub location: TextExtractionLocation,
    pub edit_capability: EditCapability,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum TextExtractionIdentity {
    #[serde(rename = "resolved")]
    Resolved { namespace: String, key: String },
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
#[serde(rename_all = "lowercase")]
pub enum Completeness {
    Complete,
    Partial,
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
    #[serde(rename = "classPath")]
    pub class_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "packageName")]
    pub package_name: String,
    pub position: SavedWorldPosition,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum SavedWorldPosition {
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
    #[serde(rename = "resolved")]
    Resolved { location: SavedWorldVector },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldVector {
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum AuthoringTableSnapshot {
    V1(AuthoringTableSnapshotV1),
    V2(AuthoringTableSnapshotV2),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringTableSnapshotV1 {
    pub contract: AuthoringContractV1,
    pub authority: AuthoringAuthority,
    pub completeness: Completeness,
    pub table: AuthoringTableV1,
    pub diagnostics: Vec<AuthoringDiagnostic>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringContractV1 {
    pub name: AuthoringContractName,
    pub version: AuthoringContractVersionV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthoringContractName;

impl<'de> Deserialize<'de> for AuthoringContractName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value == "unreal-authoring" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected unreal-authoring"))
        }
    }
}

impl Serialize for AuthoringContractName {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str("unreal-authoring")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringContractVersionV1 {
    pub major: u8,
    pub minor: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AuthoringAuthority {
    #[serde(rename = "project_files")]
    ProjectFiles {
        #[serde(rename = "packageName")]
        package_name: String,
    },
    #[serde(rename = "live_editor")]
    LiveEditor {
        #[serde(rename = "producerId")]
        producer_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringTableV1 {
    pub kind: AuthoringTableKind,
    #[serde(rename = "objectPath")]
    pub object_path: String,
    #[serde(rename = "rowStruct")]
    pub row_struct: String,
    #[serde(rename = "parentTables")]
    pub parent_tables: Vec<String>,
    pub rows: Vec<AuthoringRow>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthoringTableKind {
    DataTable,
    CompositeDataTable,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringRow {
    pub id: String,
    pub name: String,
    pub fields: Vec<AuthoringFieldValue>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringFieldValue {
    pub name: String,
    #[serde(rename = "typeName")]
    pub type_name: String,
    pub value: AuthoringValue,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AuthoringValue {
    #[serde(rename = "bool")]
    Bool { value: bool },
    #[serde(rename = "int")]
    Int { value: String },
    #[serde(rename = "uint")]
    UInt { value: String },
    #[serde(rename = "float")]
    Float { value: AuthoringFloatValue },
    #[serde(rename = "double")]
    Double { value: AuthoringFloatValue },
    #[serde(rename = "name")]
    Name { value: String },
    #[serde(rename = "enum")]
    Enum { value: String },
    #[serde(rename = "string")]
    StringValue { value: String },
    #[serde(rename = "text")]
    Text { value: String },
    #[serde(rename = "guid")]
    Guid { value: String },
    #[serde(rename = "soft_object_path")]
    SoftObjectPath { value: String },
    #[serde(rename = "object_ref")]
    ObjectRef { value: Option<String> },
    #[serde(rename = "row_reference")]
    RowReference {
        #[serde(rename = "tableObjectPath")]
        table_object_path: Option<String>,
        #[serde(rename = "rowName")]
        row_name: String,
    },
    #[serde(rename = "vector")]
    Vector { x: f64, y: f64, z: f64 },
    #[serde(rename = "array")]
    Array { values: Vec<AuthoringValue> },
    #[serde(rename = "set")]
    Set { values: Vec<AuthoringValue> },
    #[serde(rename = "map")]
    Map { entries: Vec<AuthoringMapEntry> },
    #[serde(rename = "struct")]
    Struct { fields: Vec<AuthoringFieldValue> },
    #[serde(rename = "unsupported")]
    Unsupported {
        reason: String,
        #[serde(rename = "byteSize")]
        byte_size: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum AuthoringFloatValue {
    Number(f64),
    Special(AuthoringSpecialFloat),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthoringSpecialFloat {
    Nan,
    #[serde(rename = "infinity")]
    Infinity,
    #[serde(rename = "-infinity")]
    NegativeInfinity,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringMapEntry {
    pub key: AuthoringValue,
    pub value: AuthoringValue,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringDiagnostic {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringTableSnapshotV2 {
    pub contract: AuthoringContractV2,
    pub authority: AuthoringAuthority,
    pub completeness: Completeness,
    pub diagnostics: Vec<AuthoringDiagnostic>,
    pub fingerprint: AuthoringFingerprint,
    pub producer: AuthoringProducer,
    pub table: AuthoringTableV2,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringContractV2 {
    pub name: AuthoringContractName,
    pub version: AuthoringContractVersionV2,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringContractVersionV2 {
    pub major: u8,
    pub minor: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum AuthoringFingerprint {
    #[serde(rename = "available")]
    Available {
        algorithm: AuthoringFingerprintAlgorithm,
        value: String,
        version: u64,
    },
    #[serde(rename = "unavailable")]
    Unavailable { reason: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthoringFingerprintAlgorithm {
    Sha256,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringProducer {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringTableV2 {
    pub kind: AuthoringTableKind,
    #[serde(rename = "objectPath")]
    pub object_path: String,
    #[serde(rename = "rowStruct")]
    pub row_struct: String,
    #[serde(rename = "parentTables")]
    pub parent_tables: Vec<String>,
    pub rows: Vec<AuthoringRow>,
    #[serde(rename = "packageName")]
    pub package_name: String,
    pub schema: AuthoringTableSchema,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum AuthoringTableSchema {
    #[serde(rename = "available")]
    Available {
        fields: Vec<AuthoringFieldDescriptor>,
        source: AuthoringSchemaSource,
    },
    #[serde(rename = "unavailable")]
    Unavailable { reason: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthoringSchemaSource {
    SavedPackage,
    LiveReflection,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringFieldDescriptor {
    pub annotations: AuthoringAnnotations,
    #[serde(rename = "defaultValue")]
    pub default_value: AuthoringDefaultValue,
    pub editability: AuthoringEditability,
    pub id: String,
    pub name: String,
    pub presence: AuthoringPresence,
    #[serde(rename = "type")]
    pub type_descriptor: AuthoringTypeDescriptor,
    #[serde(rename = "typeName")]
    pub type_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringAnnotations {
    #[serde(rename = "clampMax")]
    pub clamp_max: Option<String>,
    #[serde(rename = "clampMin")]
    pub clamp_min: Option<String>,
    pub deprecated: bool,
    pub description: Option<String>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "readOnly")]
    pub read_only: bool,
    #[serde(rename = "rowReference")]
    pub row_reference: Option<AuthoringRowReferenceAnnotation>,
    pub step: Option<String>,
    pub unit: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum AuthoringRowReferenceAnnotation {
    #[serde(rename = "known")]
    Known {
        #[serde(rename = "tableObjectPath")]
        table_object_path: String,
    },
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum AuthoringDefaultValue {
    #[serde(rename = "known")]
    Known { value: AuthoringValue },
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AuthoringEditability {
    #[serde(rename = "editable")]
    Editable,
    #[serde(rename = "read_only")]
    ReadOnly { reason: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthoringPresence {
    Required,
    Optional,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AuthoringTypeDescriptor {
    #[serde(rename = "scalar")]
    Scalar {
        #[serde(rename = "valueKind")]
        value_kind: AuthoringScalarKind,
    },
    #[serde(rename = "enum")]
    Enum {
        #[serde(rename = "enumPath")]
        enum_path: Option<String>,
        options: Vec<AuthoringEnumOption>,
    },
    #[serde(rename = "reference")]
    Reference {
        #[serde(rename = "valueKind")]
        value_kind: AuthoringReferenceKind,
        target: AuthoringReferenceTarget,
    },
    #[serde(rename = "row_reference")]
    RowReference,
    #[serde(rename = "vector")]
    Vector,
    #[serde(rename = "array")]
    Array {
        element: Box<AuthoringTypeDescriptor>,
    },
    #[serde(rename = "set")]
    Set {
        element: Box<AuthoringTypeDescriptor>,
    },
    #[serde(rename = "map")]
    Map {
        key: Box<AuthoringTypeDescriptor>,
        value: Box<AuthoringTypeDescriptor>,
    },
    #[serde(rename = "struct")]
    Struct {
        #[serde(rename = "structPath")]
        struct_path: Option<String>,
        fields: Vec<AuthoringFieldDescriptor>,
    },
    #[serde(rename = "unsupported")]
    Unsupported {
        reason: String,
        #[serde(rename = "typeName")]
        type_name: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthoringEnumOption {
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthoringScalarKind {
    Bool,
    Int,
    UInt,
    Float,
    Double,
    Name,
    String,
    Text,
    Guid,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthoringReferenceKind {
    ObjectRef,
    SoftObjectPath,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum AuthoringReferenceTarget {
    #[serde(rename = "known")]
    Known {
        #[serde(rename = "classPath")]
        class_path: String,
    },
    #[serde(rename = "unknown")]
    Unknown,
}
