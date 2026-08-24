//! Schema-provider seam for reflected class and struct shapes.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::package::ObjectPath;

pub const SOURCE_MODEL_SCHEMA_VERSION: u8 = 5;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StructSchema {
    pub path: ObjectPath,
    pub cpp_name: String,
    pub super_path: Option<ObjectPath>,
    pub fields: Vec<FieldSchema>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ClassSchema {
    pub path: ObjectPath,
    pub cpp_name: String,
    pub super_path: Option<ObjectPath>,
    pub fields: Vec<FieldSchema>,
    pub serialization: Vec<SerializationOperation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FieldSchema {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldType {
    Bool,
    Int8,
    #[serde(rename = "uint8")]
    UInt8,
    Int16,
    #[serde(rename = "uint16")]
    UInt16,
    Int32,
    #[serde(rename = "uint32")]
    UInt32,
    Int64,
    #[serde(rename = "uint64")]
    UInt64,
    Float,
    Double,
    Name,
    String,
    Text,
    Enum {
        path: ObjectPath,
    },
    Struct {
        path: ObjectPath,
    },
    Class {
        class_path: Option<ObjectPath>,
    },
    Object {
        class_path: Option<ObjectPath>,
    },
    SoftObject {
        class_path: Option<ObjectPath>,
    },
    Array {
        inner: Box<FieldType>,
    },
    Set {
        inner: Box<FieldType>,
    },
    Map {
        key: Box<FieldType>,
        value: Box<FieldType>,
    },
    Unknown {
        cpp_type: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SerializationOperation {
    TaggedProperties,
    ObjectGuid,
    DataTableRows { row_struct_property: String },
    CurveTableRows,
    EnumData,
    StructDefinition,
    StructFlags,
    StructDefaultInstance,
    StringTableData,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceModel {
    pub schema_version: u8,
    pub engine_version: String,
    pub classes: Vec<ClassSchema>,
    pub structs: Vec<StructSchema>,
}

impl SourceModel {
    #[must_use]
    pub fn supports_schema_version(&self) -> bool {
        self.schema_version == SOURCE_MODEL_SCHEMA_VERSION
    }
}

/// Returns the source-derived UE 5.7 model compiled into the portable parser.
///
/// The committed model contains engine declarations only. Project and fixture models remain
/// explicit inputs to conformance or host code and are never silently baked into the parser.
#[must_use]
pub fn embedded_source_model() -> &'static SourceModel {
    static MODEL: Lazy<SourceModel> = Lazy::new(|| {
        serde_json::from_str(include_str!("../source-models/ue57-data-assets.json"))
            .expect("embedded UE 5.7 source model must be valid")
    });
    &MODEL
}

pub trait SchemaProvider {
    fn find_struct(&self, path: &ObjectPath) -> Option<&StructSchema>;
    fn find_class(&self, path: &ObjectPath) -> Option<&ClassSchema>;

    fn class_is_a(&self, path: &ObjectPath, base_path: &str) -> bool {
        let mut current = Some(path.clone());
        for _ in 0..64 {
            let Some(path) = current else {
                return false;
            };
            if path.as_str() == base_path {
                return true;
            }
            current = self
                .find_class(&path)
                .and_then(|schema| schema.super_path.clone());
        }
        false
    }
}

impl SchemaProvider for SourceModel {
    fn find_struct(&self, path: &ObjectPath) -> Option<&StructSchema> {
        self.structs.iter().find(|schema| schema.path == *path)
    }

    fn find_class(&self, path: &ObjectPath) -> Option<&ClassSchema> {
        self.classes.iter().find(|schema| schema.path == *path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_model_is_supported_engine_only_evidence() {
        let model = embedded_source_model();
        assert!(model.supports_schema_version());
        assert_eq!(model.engine_version, "5.7");
        assert!(
            model
                .classes
                .iter()
                .all(|schema| !schema.path.as_str().contains("Fixture"))
        );

        let data_table = model
            .find_class(&ObjectPath::new("/Script/Engine.DataTable"))
            .expect("generated DataTable schema");
        assert_eq!(
            data_table.serialization,
            vec![
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::DataTableRows {
                    row_struct_property: "RowStruct".to_owned()
                }
            ]
        );
        assert!(data_table.fields.iter().any(|field| {
            field.name == "bStripFromClientBuilds" && field.field_type == FieldType::Bool
        }));
        assert!(data_table.fields.iter().any(|field| {
            field.name == "RowStructPathName"
                && field.field_type
                    == FieldType::Struct {
                        path: ObjectPath::new("/Script/CoreUObject.TopLevelAssetPath"),
                    }
        }));
        assert!(model.class_is_a(
            &ObjectPath::new("/Script/Engine.PrimaryDataAsset"),
            "/Script/Engine.DataAsset"
        ));

        let curve_table = model
            .find_class(&ObjectPath::new("/Script/Engine.CurveTable"))
            .expect("generated CurveTable schema");
        assert_eq!(
            curve_table.serialization,
            vec![
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::CurveTableRows,
            ]
        );

        let string_table = model
            .find_class(&ObjectPath::new("/Script/Engine.StringTable"))
            .expect("generated StringTable schema");
        assert_eq!(
            string_table.serialization,
            vec![
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::StringTableData,
            ]
        );

        let user_defined_enum = model
            .find_class(&ObjectPath::new("/Script/Engine.UserDefinedEnum"))
            .expect("generated UserDefinedEnum schema");
        assert_eq!(
            user_defined_enum.serialization,
            vec![
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::EnumData,
            ]
        );

        let user_defined_struct = model
            .find_class(&ObjectPath::new("/Script/CoreUObject.UserDefinedStruct"))
            .expect("generated UserDefinedStruct schema");
        assert_eq!(
            user_defined_struct.serialization,
            vec![
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::StructDefinition,
                SerializationOperation::StructFlags,
                SerializationOperation::StructDefaultInstance,
            ]
        );
    }
}
