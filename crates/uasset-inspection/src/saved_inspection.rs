//! Portable typed saved-package inspection, shared by native IO and domain projections.

use serde::{Deserialize, Serialize};

use uasset_parser::Package;
use uasset_parser::archive::NameRef;
use uasset_parser::asset::{
    ANIM_SEQUENCE_CLASS, AssetDecodeContext, AssetErrorKind, DATA_ASSET_CLASS, DecodedAsset,
    EnumCppForm, PRIMARY_DATA_ASSET_CLASS, SKELETON_CLASS, USERDEFINEDENUM_CLASS,
    USERDEFINEDSTRUCT_CLASS, decode_export,
};
use uasset_parser::package::{ObjectPath, PackageErrorKind, PackageIndex};
use uasset_parser::property::{
    PropertyRecord, PropertyStream, PropertyValue, TextHistory as ParserTextHistory,
};
use uasset_parser::schema::embedded_source_model;

use crate::generic::SCHEMA_VERSION;

pub fn inspect_bytes_with_checkpoint(
    path: &str,
    bytes: &[u8],
    checkpoint: &impl Fn(&'static str) -> Result<(), InspectionError>,
) -> Result<(SavedAssetInspection, bool), InspectionError> {
    checkpoint("parsing")?;
    let package = Package::parse(bytes).map_err(|error| InspectionError {
        code: package_error_kind(error.kind()).to_owned(),
        message: error.detail().to_owned(),
        retry_safe: false,
    })?;
    checkpoint("parsing")?;

    let version = &package.summary.versions;
    let legacy_ue3 = version.legacy_ue3.ok_or_else(|| {
        InspectionError::new(
            "contract",
            "inspection package version is missing legacy_ue3",
            false,
        )
    })?;
    let mut assets = Vec::with_capacity(package.exports.len());
    let mut decode_errors = Vec::new();
    let context = AssetDecodeContext {
        source: bytes,
        package: &package,
        schemas: embedded_source_model(),
    };
    for export in &package.exports {
        match decode_export(export, &context) {
            Ok(Some(decoded)) => assets.push(saved_asset(&package, decoded)),
            Ok(None) => {}
            Err(error) => decode_errors.push(SavedAssetDecodeError {
                object_path: export.object_path.to_string(),
                class_path: export.class_path.as_ref().map(ToString::to_string),
                kind: asset_error_kind(error.kind()),
                message: error.message().to_owned(),
            }),
        }
    }
    checkpoint("inspection")?;

    let metadata = match package.read_metadata(bytes) {
        Ok(metadata) => metadata.filter(|data| !data.root.is_empty() || !data.objects.is_empty()),
        Err(error) => {
            decode_errors.push(SavedAssetDecodeError {
                object_path: package.summary.package_name.clone(),
                class_path: None,
                kind: asset_error_kind(match error.kind() {
                    uasset_parser::package::PackageErrorKind::ResourceLimit => {
                        uasset_parser::asset::AssetErrorKind::ResourceLimit
                    }
                    uasset_parser::package::PackageErrorKind::MalformedData => {
                        uasset_parser::asset::AssetErrorKind::MalformedData
                    }
                    _ => uasset_parser::asset::AssetErrorKind::UnsupportedCapability,
                }),
                message: error.to_string(),
            });
            None
        }
    };
    let partial = !decode_errors.is_empty();
    Ok((
        SavedAssetInspection {
            schema_version: SCHEMA_VERSION,
            status: if partial {
                InspectionStatus::Partial
            } else {
                InspectionStatus::Ok
            },
            path: path.to_owned(),
            package: SavedPackageSummary {
                name: package.summary.package_name.clone(),
                version: SavedPackageVersion {
                    legacy_file: f64::from(version.legacy_file_version),
                    legacy_ue3: f64::from(legacy_ue3),
                    ue4: f64::from(version.ue4),
                    ue5: f64::from(version.ue5),
                    licensee: f64::from(version.licensee),
                },
                package_flags: u64::from(version.package_flags.bits()),
                summary_size: package.summary.span.len(),
                total_header_size: u64::from(package.summary.total_header_size),
            },
            assets,
            metadata,
            decode_errors,
        },
        partial,
    ))
}

fn saved_asset(package: &Package, decoded: DecodedAsset) -> SavedAsset {
    match decoded {
        DecodedAsset::DataTable(table) => {
            let row_count = count(table.rows.len());
            let parent_tables = (!table.parent_tables.is_empty()).then(|| {
                table
                    .parent_tables
                    .into_iter()
                    .map(ObjectPath::into_string)
                    .collect()
            });
            let rows = table
                .rows
                .into_iter()
                .map(|row| SavedTableRow {
                    name: resolve_name(package, row.name),
                    properties: saved_properties(package, row.properties),
                })
                .collect();
            let fields = (
                table.object_path.into_string(),
                table.row_struct.map(ObjectPath::into_string),
                parent_tables,
                row_count,
                rows,
            );
            match table.kind {
                uasset_parser::asset::DataTableKind::Plain => SavedAsset::DataTable {
                    object_path: fields.0,
                    row_struct: fields.1,
                    parent_tables: fields.2,
                    row_count: fields.3,
                    rows: fields.4,
                },
                uasset_parser::asset::DataTableKind::Composite => SavedAsset::CompositeDataTable {
                    object_path: fields.0,
                    row_struct: fields.1,
                    parent_tables: fields.2,
                    row_count: fields.3,
                    rows: fields.4,
                },
            }
        }
        DecodedAsset::CurveTable(table) => SavedAsset::CurveTable {
            object_path: table.object_path.into_string(),
            class_path: uasset_parser::asset::CURVETABLE_CLASS.to_owned(),
            properties: saved_properties(package, table.properties),
            row_count: count(table.rows.len()),
            curve_rows: table
                .rows
                .into_iter()
                .map(|row| SavedCurveRow {
                    name: resolve_name(package, row.name),
                    keys: row
                        .keys
                        .into_iter()
                        .map(|key| SavedCurveKey {
                            time: f32_to_wire(key.time()),
                            value: f32_to_wire(key.value()),
                        })
                        .collect(),
                })
                .collect(),
        },
        DecodedAsset::StringTable(table) => SavedAsset::StringTable {
            object_path: table.object_path.into_string(),
            string_table_namespace: table.namespace,
            string_table_metadata: table.metadata,
            string_table_entries: table
                .entries
                .into_iter()
                .map(|entry| SavedStringTableEntry {
                    key: entry.key,
                    source: entry.source,
                    dev_notes: entry.dev_notes,
                })
                .collect(),
        },
        DecodedAsset::DataAsset(asset) => {
            let primary = asset.class_path.as_str() == PRIMARY_DATA_ASSET_CLASS;
            let fields = (
                asset.object_path.into_string(),
                asset.class_path.into_string(),
                asset.object_guid.map(|guid| guid.to_string()),
                saved_properties(package, asset.properties),
            );
            if primary {
                SavedAsset::PrimaryDataAsset {
                    object_path: fields.0,
                    class_path: fields.1,
                    object_guid: fields.2,
                    properties: fields.3,
                }
            } else {
                debug_assert!(fields.1 == DATA_ASSET_CLASS || fields.1.ends_with("DataAsset"));
                SavedAsset::DataAsset {
                    object_path: fields.0,
                    class_path: fields.1,
                    object_guid: fields.2,
                    properties: fields.3,
                }
            }
        }
        DecodedAsset::UObject(object) => SavedAsset::UObject {
            object_guid: object.object_guid.map(|guid| guid.to_string()),
            native_data: object
                .native_data
                .map(|value| Box::new(saved_value(package, *value))),
            object_path: object.object_path.into_string(),
            class_path: object.class_path.into_string(),
            properties: saved_properties(package, object.properties),
            tail_bytes: (!object.tail.is_empty()).then_some(object.tail.len()),
        },
        DecodedAsset::BlueprintGraphNode(node) => SavedAsset::UObject {
            object_guid: node.object_guid.map(|guid| guid.to_string()),
            native_data: None,
            object_path: node.object_path.into_string(),
            class_path: node.class_path.into_string(),
            properties: saved_properties(package, node.properties),
            tail_bytes: (!node.tail.is_empty()).then_some(node.tail.len()),
        },
        DecodedAsset::AnimSequence(sequence) => SavedAsset::UObject {
            object_guid: sequence.object_guid.map(|guid| guid.to_string()),
            native_data: None,
            object_path: sequence.object_path.into_string(),
            class_path: ANIM_SEQUENCE_CLASS.to_owned(),
            properties: saved_properties(package, sequence.properties),
            tail_bytes: None,
        },
        DecodedAsset::Skeleton(skeleton) => SavedAsset::Skeleton {
            object_path: skeleton.object_path.into_string(),
            class_path: SKELETON_CLASS.to_owned(),
            object_guid: skeleton.object_guid.map(|guid| guid.to_string()),
            properties: saved_properties(package, skeleton.properties),
            reference_pose: skeleton
                .reference_pose
                .map(|value| saved_value(package, value)),
            tail_bytes: (!skeleton.tail.is_empty()).then_some(skeleton.tail.len()),
            bones: skeleton
                .bones
                .into_iter()
                .map(|bone| SavedBone {
                    name: resolve_name(package, bone.name),
                    parent_index: i64::from(bone.parent_index),
                })
                .collect(),
        },
        DecodedAsset::Enum(decoded) => SavedAsset::Enum {
            object_path: decoded.object_path.into_string(),
            class_path: USERDEFINEDENUM_CLASS.to_owned(),
            enum_cpp_form: enum_cpp_form(decoded.cpp_form).to_owned(),
            row_count: count(decoded.entries.len()),
            enum_entries: decoded
                .entries
                .into_iter()
                .map(|entry| SavedEnumEntry {
                    name: resolve_name(package, entry.name),
                    value: entry.value,
                    display_name: entry.display_name,
                })
                .collect(),
        },
        DecodedAsset::Struct(decoded) => SavedAsset::Struct {
            object_path: decoded.object_path.into_string(),
            class_path: USERDEFINEDSTRUCT_CLASS.to_owned(),
            struct_flags: u64::from(decoded.struct_flags),
            row_count: count(decoded.fields.len()),
            struct_fields: decoded
                .fields
                .into_iter()
                .map(|field| SavedStructField {
                    name: resolve_name(package, field.name),
                    type_name: resolve_name(package, field.type_name),
                    referenced_path: field.referenced_path.map(ObjectPath::into_string),
                    display_name: field.display_name,
                })
                .collect(),
            properties: saved_properties(package, decoded.default_values),
        },
    }
}

fn saved_properties(package: &Package, stream: PropertyStream) -> Vec<SavedProperty> {
    stream
        .records
        .into_iter()
        .map(|record| saved_property(package, record))
        .collect()
}

fn saved_property(package: &Package, record: PropertyRecord) -> SavedProperty {
    let raw_size = record.payload.len();
    let mut value = saved_value(package, record.value);
    if let SavedPropertyValue::Raw { size, .. } = &mut value {
        *size = raw_size;
    }
    SavedProperty {
        name: resolve_name(package, record.name),
        type_name: resolve_name(package, record.type_name.name),
        value,
    }
}

fn saved_value(package: &Package, value: PropertyValue) -> SavedPropertyValue {
    match value {
        PropertyValue::Bool(value) => SavedPropertyValue::Bool { value },
        PropertyValue::Int(value) => SavedPropertyValue::Int {
            value: value as f64,
        },
        PropertyValue::UInt(value) => SavedPropertyValue::UInt {
            value: value as f64,
        },
        PropertyValue::Float(value) => SavedPropertyValue::Float {
            value: f32_to_wire(value),
        },
        PropertyValue::Double(value) => SavedPropertyValue::Double {
            value: finite_f64(value),
        },
        PropertyValue::Name(value) => SavedPropertyValue::Name {
            value: resolve_name(package, value),
        },
        PropertyValue::Enum(value) => SavedPropertyValue::EnumValue {
            value: resolve_name(package, value),
        },
        PropertyValue::String(value) => SavedPropertyValue::StringValue { value },
        PropertyValue::Text(text) => {
            let dev_notes = text.dev_notes().map(str::to_owned);
            match text.history {
                ParserTextHistory::None => SavedPropertyValue::Text {
                    value: text.source,
                    dev_notes,
                    history: TextHistory::None,
                    namespace: None,
                    table_id: None,
                    key: None,
                },
                ParserTextHistory::Base { namespace, key, .. } => SavedPropertyValue::Text {
                    value: text.source,
                    dev_notes,
                    history: TextHistory::Base,
                    namespace: Some(namespace),
                    table_id: None,
                    key: Some(key),
                },
                ParserTextHistory::StringTableEntry { table_id, key } => SavedPropertyValue::Text {
                    value: text.source,
                    dev_notes,
                    history: TextHistory::StringTableEntry,
                    namespace: None,
                    table_id: Some(table_id),
                    key: Some(key),
                },
                ParserTextHistory::NamedFormat { format, .. } => {
                    let (history, namespace, table_id, key) = text_identity_parts(*format);
                    SavedPropertyValue::Text {
                        value: text.source,
                        dev_notes,
                        history,
                        namespace,
                        table_id,
                        key,
                    }
                }
            }
        }
        PropertyValue::Vector(value) => SavedPropertyValue::Vector {
            x: finite_f64(value.x),
            y: finite_f64(value.y),
            z: finite_f64(value.z),
        },
        PropertyValue::IntPoint(value) => SavedPropertyValue::IntPoint {
            x: f64::from(value.x),
            y: f64::from(value.y),
        },
        PropertyValue::Rotator(value) => SavedPropertyValue::Rotator {
            pitch: finite_f64(value.pitch),
            yaw: finite_f64(value.yaw),
            roll: finite_f64(value.roll),
        },
        PropertyValue::Color(value) => SavedPropertyValue::Color {
            r: f64::from(value.r),
            g: f64::from(value.g),
            b: f64::from(value.b),
            a: f64::from(value.a),
        },
        PropertyValue::LinearColor(value) => SavedPropertyValue::LinearColor {
            r: f32_to_wire(value.r),
            g: f32_to_wire(value.g),
            b: f32_to_wire(value.b),
            a: f32_to_wire(value.a),
        },
        PropertyValue::DataTableRowHandle(value) => SavedPropertyValue::DataTableRowHandle {
            table_object_path: resolve_object(package, value.table),
            row_name: resolve_name(package, value.row_name),
        },
        PropertyValue::DateTime(_) => SavedPropertyValue::Raw {
            reason: "decoded native date time; omitted from generic schema v8".to_owned(),
            size: 0,
        },
        PropertyValue::FrameRange(_) => SavedPropertyValue::Raw {
            reason: "decoded native frame range; omitted from generic schema v8".to_owned(),
            size: 0,
        },
        PropertyValue::ObjectRef(value) => SavedPropertyValue::ObjectRef {
            value: resolve_object(package, value),
        },
        PropertyValue::Guid(value) => SavedPropertyValue::Guid {
            value: value.to_string(),
        },
        PropertyValue::SoftObjectPath(value) => SavedPropertyValue::SoftObjectPath { value },
        PropertyValue::Array(values) => SavedPropertyValue::Array {
            values: values
                .into_iter()
                .map(|value| saved_value(package, value))
                .collect(),
        },
        PropertyValue::Set(values) => SavedPropertyValue::Set {
            values: values
                .into_iter()
                .map(|value| saved_value(package, value))
                .collect(),
        },
        PropertyValue::Map(entries) => SavedPropertyValue::Map {
            entries: entries
                .into_iter()
                .map(|entry| SavedPropertyMapEntry {
                    key: saved_value(package, entry.key),
                    value: saved_value(package, entry.value),
                })
                .collect(),
        },
        PropertyValue::NativeStruct { fields } => SavedPropertyValue::NativeStruct {
            fields: fields
                .into_iter()
                .map(|field| SavedNativeField {
                    name: field.name,
                    value: saved_value(package, field.value),
                })
                .collect(),
        },
        PropertyValue::InstancedStruct {
            struct_type,
            payload,
            value,
        } => SavedPropertyValue::InstancedStruct {
            struct_type: resolve_object(package, struct_type),
            size: payload.len(),
            value: value.map(|value| {
                let mut output = saved_value(package, *value);
                if let SavedPropertyValue::Raw { size, .. } = &mut output {
                    *size = payload.len();
                }
                Box::new(output)
            }),
        },
        PropertyValue::Struct(properties) => SavedPropertyValue::Struct {
            properties: saved_properties(package, properties),
        },
        PropertyValue::Raw { reason } => SavedPropertyValue::Raw {
            reason: reason.detail().into_owned(),
            size: 0,
        },
    }
}

fn text_identity_parts(
    text: uasset_parser::property::TextValue,
) -> (TextHistory, Option<String>, Option<String>, Option<String>) {
    match text.history {
        ParserTextHistory::None => (TextHistory::None, None, None, None),
        ParserTextHistory::StringTableEntry { table_id, key } => (
            TextHistory::StringTableEntry,
            None,
            Some(table_id),
            Some(key),
        ),
        ParserTextHistory::Base { namespace, key, .. } => {
            (TextHistory::Base, Some(namespace), None, Some(key))
        }
        ParserTextHistory::NamedFormat { format, .. } => text_identity_parts(*format),
    }
}

fn resolve_name(package: &Package, name: NameRef) -> String {
    package
        .resolve_name_cow(name)
        .map_or_else(|| "<unresolved>".to_owned(), |value| value.into_owned())
}

fn resolve_object(package: &Package, index: PackageIndex) -> Option<String> {
    if index == PackageIndex::Null {
        None
    } else {
        package.resolve_index_str(index).map(str::to_owned)
    }
}

fn finite_f64(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

fn f32_to_wire(value: f32) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    Some(
        value
            .to_string()
            .parse()
            .expect("a finite f32 must have a valid f64 representation"),
    )
}

fn count(value: usize) -> u64 {
    u64::try_from(value).expect("decoded collection length fits in u64")
}

fn package_error_kind(kind: PackageErrorKind) -> &'static str {
    match kind {
        PackageErrorKind::MalformedData => "malformed_data",
        PackageErrorKind::ResourceLimit => "resource_limit",
        PackageErrorKind::UnsupportedFormat => "unsupported_format",
        PackageErrorKind::UnsupportedVersion => "unsupported_version",
        PackageErrorKind::UnsupportedCapability => "unsupported_capability",
    }
}

fn asset_error_kind(kind: AssetErrorKind) -> SavedAssetDecodeErrorKind {
    match kind {
        AssetErrorKind::MalformedData => SavedAssetDecodeErrorKind::MalformedData,
        AssetErrorKind::ResourceLimit => SavedAssetDecodeErrorKind::ResourceLimit,
        AssetErrorKind::UnsupportedFormat => SavedAssetDecodeErrorKind::UnsupportedFormat,
        AssetErrorKind::UnsupportedVersion => SavedAssetDecodeErrorKind::UnsupportedVersion,
        AssetErrorKind::UnsupportedCapability => SavedAssetDecodeErrorKind::UnsupportedCapability,
    }
}

fn enum_cpp_form(value: EnumCppForm) -> &'static str {
    match value {
        EnumCppForm::Regular => "Regular",
        EnumCppForm::Namespaced => "Namespaced",
        EnumCppForm::EnumClass => "EnumClass",
    }
}

/// Portable failure; IO owns cancellation tokens and filesystem recovery policy.
#[derive(Debug, Default)]
pub struct InspectionError {
    pub code: String,
    pub message: String,
    pub retry_safe: bool,
}

impl InspectionError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retry_safe: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retry_safe,
        }
    }
}

pub fn inspect_bytes(
    path: &str,
    bytes: &[u8],
) -> Result<(SavedAssetInspection, bool), InspectionError> {
    inspect_bytes_with_checkpoint(path, bytes, &|_| Ok(()))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetInspection {
    pub schema_version: u8,
    pub status: InspectionStatus,
    pub path: String,
    pub package: SavedPackageSummary,
    pub assets: Vec<SavedAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<uasset_parser::metadata::PackageMetadata>,
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
        #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
        string_table_metadata:
            std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    },
    #[serde(rename = "UObject")]
    UObject {
        object_path: String,
        class_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        object_guid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        native_data: Option<Box<SavedPropertyValue>>,
        #[serde(default)]
        properties: Vec<SavedProperty>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tail_bytes: Option<u64>,
    },
    #[serde(rename = "DataAsset")]
    DataAsset {
        object_path: String,
        class_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        object_guid: Option<String>,
        #[serde(default)]
        properties: Vec<SavedProperty>,
    },
    #[serde(rename = "PrimaryDataAsset")]
    PrimaryDataAsset {
        object_path: String,
        class_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
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
        #[serde(skip_serializing_if = "Option::is_none")]
        object_guid: Option<String>,
        #[serde(default)]
        properties: Vec<SavedProperty>,
        bones: Vec<SavedBone>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reference_pose: Option<SavedPropertyValue>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tail_bytes: Option<u64>,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        row_struct: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_tables: Option<Vec<String>>,
        row_count: u64,
        rows: Vec<SavedTableRow>,
    },
    #[serde(rename = "CompositeDataTable")]
    CompositeDataTable {
        object_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        row_struct: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(default)]
    pub dev_notes: String,
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
    #[serde(rename = "native_struct")]
    NativeStruct { fields: Vec<SavedNativeField> },
    #[serde(rename = "instanced_struct")]
    InstancedStruct {
        struct_type: Option<String>,
        size: u64,
        value: Option<Box<SavedPropertyValue>>,
    },
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        table_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dev_notes: Option<String>,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedNativeField {
    pub name: String,
    pub value: SavedPropertyValue,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextHistory {
    None,
    Base,
    #[serde(rename = "string_table")]
    StringTableEntry,
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
    #[serde(skip_serializing_if = "Option::is_none")]
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

#[cfg(test)]
mod tests {
    use super::{SavedPropertyValue, TextHistory};

    #[test]
    fn text_history_serialization_matches_the_shared_inspection_contract() {
        for (text, expected) in [
            (
                SavedPropertyValue::Text {
                    value: "Generic label".to_owned(),
                    history: TextHistory::None,
                    dev_notes: None,
                    table_id: None,
                    namespace: None,
                    key: None,
                },
                serde_json::json!({
                    "value_kind": "text", "value": "Generic label", "history": "none"
                }),
            ),
            (
                SavedPropertyValue::Text {
                    value: "Generic label".to_owned(),
                    history: TextHistory::Base,
                    dev_notes: Some("Translator note".into()),
                    table_id: None,
                    namespace: Some("Fixture".to_owned()),
                    key: Some("Label".to_owned()),
                },
                serde_json::json!({
                    "value_kind": "text", "value": "Generic label", "history": "base",
                    "namespace": "Fixture", "key": "Label", "dev_notes": "Translator note"
                }),
            ),
        ] {
            let actual = serde_json::to_value(&text).expect("serialize text");
            assert_eq!(actual, expected);
            assert_eq!(
                serde_json::from_value::<SavedPropertyValue>(actual).expect("decode text"),
                text
            );
        }
    }
}
