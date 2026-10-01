//! Portable DataTable authoring projection. Its serde models preserve the native wire contract.

use serde::{Deserialize, Serialize};

use crate::saved_inspection::{
    InspectionError, SavedAsset, SavedAssetInspection, SavedPropertyValue,
};

pub fn inspect_authoring_bytes(
    path: &str,
    bytes: &[u8],
) -> Result<(AuthoringTableSnapshot, bool), InspectionError> {
    let (inspection, partial) = crate::saved_inspection::inspect_bytes(path, bytes)?;
    project_authoring_table(inspection, partial, &|_| Ok(()))
}

pub fn project_authoring_table(
    inspection: SavedAssetInspection,
    inspection_partial: bool,
    checkpoint: &impl Fn(&'static str) -> Result<(), InspectionError>,
) -> Result<(AuthoringTableSnapshot, bool), InspectionError> {
    checkpoint("inspection")?;
    let mut tables = inspection.assets.iter().filter_map(|asset| match asset {
        SavedAsset::DataTable {
            object_path,
            row_struct,
            parent_tables,
            rows,
            ..
        } => Some((
            AuthoringTableKind::DataTable,
            object_path,
            row_struct,
            parent_tables,
            rows,
        )),
        SavedAsset::CompositeDataTable {
            object_path,
            row_struct,
            parent_tables,
            rows,
            ..
        } => Some((
            AuthoringTableKind::CompositeDataTable,
            object_path,
            row_struct,
            parent_tables,
            rows,
        )),
        _ => None,
    });
    let Some((kind, object_path, row_struct, parent_tables, rows)) = tables.next() else {
        return Err(InspectionError {
            code: "unsupported".to_owned(),
            message: "package contains no supported DataTable export".to_owned(),
            retry_safe: false,
        });
    };
    if tables.next().is_some() {
        return Err(InspectionError {
            code: "unsupported".to_owned(),
            message: "package contains more than one DataTable export".to_owned(),
            retry_safe: false,
        });
    }

    let mut partial = inspection_partial;
    checkpoint("inspection")?;
    let authoring_rows = rows
        .iter()
        .map(|row| {
            let fields = row
                .properties
                .iter()
                .map(|property| {
                    let (value, value_partial) = authoring_value(&property.value);
                    partial |= value_partial;
                    AuthoringFieldValue {
                        name: property.name.clone(),
                        type_name: property.type_name.clone(),
                        value,
                    }
                })
                .collect();
            AuthoringRow {
                id: format!("row:{}", row.name),
                name: row.name.clone(),
                fields,
            }
        })
        .collect();
    checkpoint("inspection")?;
    let diagnostics = inspection
        .decode_errors
        .iter()
        .map(|error| AuthoringDiagnostic {
            code: authoring_error_code(&error.kind).to_owned(),
            message: error.message.clone(),
            path: Some(error.object_path.clone()),
        })
        .collect();
    checkpoint("inspection")?;
    let snapshot = AuthoringTableSnapshot::V2(AuthoringTableSnapshotV2 {
        contract: AuthoringContractV2 {
            name: AuthoringContractName,
            version: AuthoringContractVersionV2 { major: 2, minor: 1 },
        },
        authority: AuthoringAuthority::ProjectFiles {
            package_name: inspection.package.name.clone(),
        },
        completeness: if partial {
            Completeness::Partial
        } else {
            Completeness::Complete
        },
        diagnostics,
        fingerprint: AuthoringFingerprint::Unavailable {
            reason: "not_available".to_owned(),
        },
        producer: AuthoringProducer {
            name: "uasset-parser".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        },
        table: AuthoringTableV2 {
            kind,
            object_path: object_path.clone(),
            row_struct: row_struct.clone().unwrap_or_default(),
            parent_tables: parent_tables.clone().unwrap_or_default(),
            rows: authoring_rows,
            package_name: inspection.package.name,
            schema: AuthoringTableSchema::Unavailable {
                reason: "not_available".to_owned(),
            },
        },
    });
    checkpoint("inspection")?;
    Ok((snapshot, partial))
}

fn authoring_error_code(kind: &crate::saved_inspection::SavedAssetDecodeErrorKind) -> &'static str {
    match kind {
        crate::saved_inspection::SavedAssetDecodeErrorKind::MalformedData => "malformed_data",
        crate::saved_inspection::SavedAssetDecodeErrorKind::ResourceLimit => "resource_limit",
        crate::saved_inspection::SavedAssetDecodeErrorKind::UnsupportedFormat => {
            "unsupported_format"
        }
        crate::saved_inspection::SavedAssetDecodeErrorKind::UnsupportedVersion => {
            "unsupported_version"
        }
        crate::saved_inspection::SavedAssetDecodeErrorKind::UnsupportedCapability => {
            "unsupported_capability"
        }
    }
}

fn authoring_value(value: &SavedPropertyValue) -> (AuthoringValue, bool) {
    match value {
        SavedPropertyValue::Bool { value } => (AuthoringValue::Bool { value: *value }, false),
        SavedPropertyValue::Int { value } => (
            AuthoringValue::Int {
                value: value.to_string(),
            },
            false,
        ),
        SavedPropertyValue::UInt { value } => (
            AuthoringValue::UInt {
                value: value.to_string(),
            },
            false,
        ),
        SavedPropertyValue::Float { value } => authoring_float(value, false),
        SavedPropertyValue::Double { value } => authoring_float(value, true),
        SavedPropertyValue::Name { value } => (
            AuthoringValue::Name {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::EnumValue { value } => (
            AuthoringValue::Enum {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::StringValue { value } => (
            AuthoringValue::StringValue {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::Text { value, .. } => (
            AuthoringValue::Text {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::Guid { value } => (
            AuthoringValue::Guid {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::SoftObjectPath { value } => (
            AuthoringValue::SoftObjectPath {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::ObjectRef { value } => (
            AuthoringValue::ObjectRef {
                value: value.clone(),
            },
            false,
        ),
        SavedPropertyValue::DataTableRowHandle {
            table_object_path,
            row_name,
        } => (
            AuthoringValue::RowReference {
                table_object_path: table_object_path.clone(),
                row_name: row_name.clone(),
            },
            false,
        ),
        SavedPropertyValue::Vector { x, y, z } => (
            AuthoringValue::Vector {
                x: x.unwrap_or_default(),
                y: y.unwrap_or_default(),
                z: z.unwrap_or_default(),
            },
            x.is_none() || y.is_none() || z.is_none(),
        ),
        SavedPropertyValue::Array { values } => {
            let (values, partial) = authoring_values(values);
            (AuthoringValue::Array { values }, partial)
        }
        SavedPropertyValue::Set { values } => {
            let (values, partial) = authoring_values(values);
            (AuthoringValue::Set { values }, partial)
        }
        SavedPropertyValue::Map { entries } => {
            let mut partial = false;
            let values = entries
                .iter()
                .map(|entry| {
                    let (key, key_partial) = authoring_value(&entry.key);
                    let (value, value_partial) = authoring_value(&entry.value);
                    partial |= key_partial || value_partial;
                    AuthoringMapEntry { key, value }
                })
                .collect();
            (AuthoringValue::Map { entries: values }, partial)
        }
        SavedPropertyValue::Struct { properties } => {
            let mut partial = false;
            let fields = properties
                .iter()
                .map(|property| {
                    let (value, value_partial) = authoring_value(&property.value);
                    partial |= value_partial;
                    AuthoringFieldValue {
                        name: property.name.clone(),
                        type_name: property.type_name.clone(),
                        value,
                    }
                })
                .collect();
            (AuthoringValue::Struct { fields }, partial)
        }
        SavedPropertyValue::IntPoint { x, y } => (
            AuthoringValue::Struct {
                fields: vec![
                    authoring_field(
                        "X",
                        "IntProperty",
                        AuthoringValue::Int {
                            value: x.to_string(),
                        },
                    ),
                    authoring_field(
                        "Y",
                        "IntProperty",
                        AuthoringValue::Int {
                            value: y.to_string(),
                        },
                    ),
                ],
            },
            false,
        ),
        SavedPropertyValue::Rotator { pitch, yaw, roll } => {
            let (pitch, pitch_partial) = authoring_float(pitch, true);
            let (yaw, yaw_partial) = authoring_float(yaw, true);
            let (roll, roll_partial) = authoring_float(roll, true);
            (
                AuthoringValue::Struct {
                    fields: vec![
                        authoring_field("Pitch", "DoubleProperty", pitch),
                        authoring_field("Yaw", "DoubleProperty", yaw),
                        authoring_field("Roll", "DoubleProperty", roll),
                    ],
                },
                pitch_partial || yaw_partial || roll_partial,
            )
        }
        SavedPropertyValue::Color { r, g, b, a } => (
            AuthoringValue::Struct {
                fields: [("R", *r), ("G", *g), ("B", *b), ("A", *a)]
                    .into_iter()
                    .map(|(name, value)| {
                        authoring_field(
                            name,
                            "IntProperty",
                            AuthoringValue::Int {
                                value: value.to_string(),
                            },
                        )
                    })
                    .collect(),
            },
            false,
        ),
        SavedPropertyValue::LinearColor { r, g, b, a } => {
            let (r, r_partial) = authoring_float(r, false);
            let (g, g_partial) = authoring_float(g, false);
            let (b, b_partial) = authoring_float(b, false);
            let (a, a_partial) = authoring_float(a, false);
            (
                AuthoringValue::Struct {
                    fields: vec![
                        authoring_field("R", "FloatProperty", r),
                        authoring_field("G", "FloatProperty", g),
                        authoring_field("B", "FloatProperty", b),
                        authoring_field("A", "FloatProperty", a),
                    ],
                },
                r_partial || g_partial || b_partial || a_partial,
            )
        }
        SavedPropertyValue::NativeStruct { .. } | SavedPropertyValue::InstancedStruct { .. } => (
            AuthoringValue::Unsupported { reason: "saved native value is available in inspection; authoring projection is not defined".into(), byte_size: 0 }, true
        ),
        SavedPropertyValue::Raw { reason, size } => (
            AuthoringValue::Unsupported {
                reason: reason.clone(),
                byte_size: *size,
            },
            true,
        ),
    }
}

fn authoring_float(value: &Option<f64>, is_double: bool) -> (AuthoringValue, bool) {
    let value = match value {
        Some(value) if value.is_finite() => AuthoringFloatValue::Number(*value),
        Some(value) if value.is_nan() => AuthoringFloatValue::Special(AuthoringSpecialFloat::Nan),
        Some(value) if *value == f64::INFINITY => {
            AuthoringFloatValue::Special(AuthoringSpecialFloat::Infinity)
        }
        Some(_) => AuthoringFloatValue::Special(AuthoringSpecialFloat::NegativeInfinity),
        None => {
            return (
                AuthoringValue::Unsupported {
                    reason: "non-finite floating-point value".to_owned(),
                    byte_size: 0,
                },
                true,
            );
        }
    };
    if is_double {
        (AuthoringValue::Double { value }, false)
    } else {
        (AuthoringValue::Float { value }, false)
    }
}

fn authoring_values(values: &[SavedPropertyValue]) -> (Vec<AuthoringValue>, bool) {
    let mut partial = false;
    let values = values
        .iter()
        .map(|value| {
            let (value, value_partial) = authoring_value(value);
            partial |= value_partial;
            value
        })
        .collect();
    (values, partial)
}

fn authoring_field(name: &str, type_name: &str, value: AuthoringValue) -> AuthoringFieldValue {
    AuthoringFieldValue {
        name: name.to_owned(),
        type_name: type_name.to_owned(),
        value,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Completeness {
    Complete,
    Partial,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::saved_inspection::{
        SavedAssetDecodeError, SavedAssetDecodeErrorKind, SavedProperty,
    };

    const SCALARS: &[u8] = include_bytes!(
        "../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
    );

    #[test]
    fn partial_values_and_diagnostics_remain_visible() {
        let (mut inspection, _) = crate::saved_inspection::inspect_bytes("DT.uasset", SCALARS)
            .expect("fixture inspection");
        let table = inspection
            .assets
            .iter_mut()
            .find_map(|asset| match asset {
                SavedAsset::DataTable { rows, .. } => Some(rows),
                _ => None,
            })
            .expect("fixture table");
        table[0].properties.push(SavedProperty {
            name: "Opaque".to_owned(),
            type_name: "StructProperty".to_owned(),
            value: SavedPropertyValue::Array {
                values: vec![SavedPropertyValue::Raw {
                    reason: "unknown".to_owned(),
                    size: 4,
                }],
            },
        });
        inspection.decode_errors.push(SavedAssetDecodeError {
            object_path: "/Game/Fixture/DT.DT".to_owned(),
            class_path: None,
            kind: SavedAssetDecodeErrorKind::UnsupportedCapability,
            message: "Unsupported saved evidence".to_owned(),
        });
        let (snapshot, partial) =
            project_authoring_table(inspection, true, &|_| Ok(())).expect("partial snapshot");
        assert!(partial);
        let json = serde_json::to_value(snapshot).expect("snapshot JSON");
        assert_eq!(json["completeness"], "partial");
        assert_eq!(json["diagnostics"][0]["code"], "unsupported_capability");
        assert_eq!(json["diagnostics"][0]["path"], "/Game/Fixture/DT.DT");
        let fields = json["table"]["rows"][0]["fields"]
            .as_array()
            .expect("row fields");
        let opaque = fields
            .iter()
            .find(|field| field["name"] == "Opaque")
            .expect("opaque field");
        assert_eq!(opaque["value"]["values"][0]["byteSize"], 4);
    }

    #[test]
    fn rejects_missing_and_ambiguous_tables() {
        let (inspection, partial) = crate::saved_inspection::inspect_bytes("DT.uasset", SCALARS)
            .expect("fixture inspection");
        let mut missing = inspection.clone();
        missing.assets.clear();
        assert_eq!(
            project_authoring_table(missing, partial, &|_| Ok(()))
                .expect_err("no table")
                .code,
            "unsupported",
        );
        let mut ambiguous = inspection.clone();
        ambiguous.assets.extend(inspection.assets);
        assert!(
            project_authoring_table(ambiguous, partial, &|_| Ok(()))
                .expect_err("ambiguous table")
                .message
                .contains("more than one"),
        );
    }

    #[test]
    fn special_float_and_missing_value_behavior_is_preserved() {
        for (value, expected) in [
            (f64::NAN, "nan"),
            (f64::INFINITY, "infinity"),
            (f64::NEG_INFINITY, "-infinity"),
        ] {
            let (value, partial) = authoring_float(&Some(value), false);
            assert!(!partial);
            assert_eq!(
                serde_json::to_value(value).expect("float JSON")["value"],
                expected
            );
        }
        let (value, partial) = authoring_float(&None, true);
        assert!(partial);
        assert!(matches!(value, AuthoringValue::Unsupported { .. }));
    }
}
