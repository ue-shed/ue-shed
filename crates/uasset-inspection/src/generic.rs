use serde::{Serialize, Serializer};
use serde_json::Value;
use uasset_parser::asset::{
    ANIM_SEQUENCE_CLASS, DATA_ASSET_CLASS, PRIMARY_DATA_ASSET_CLASS, SKELETON_CLASS,
    USERDEFINEDENUM_CLASS, USERDEFINEDSTRUCT_CLASS,
};
use uasset_parser::asset::{
    AssetDecodeContext, AssetErrorKind, DecodedAsset, EnumCppForm, decode_export,
};
use uasset_parser::package::{
    ObjectPath, PackageError, PackageErrorKind, PackageIndex, TableLocation,
};
use uasset_parser::property::{PropertyRecord, PropertyValue, RawReason};
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};
use uasset_parser::{Package, PackageSummary};

mod json;

pub use json::{
    InspectionJsonError, InspectionJsonStatus, inspect_bytes_json, write_inspection_json,
};

pub const SCHEMA_VERSION: u8 = 8;

fn serialize_f32_as_f64<S>(value: &f32, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_f64(f64::from(*value))
}

/// Decodes one package into the typed generic inspection projection.
///
/// This is the native ownership boundary for package inspection. Serialization is kept in
/// [`inspect_bytes_json`] and [`inspect_bytes_value`] for the WASM and compatibility adapters;
/// callers that already have a Rust protocol boundary should consume this result directly.
pub fn inspect_bytes(path: &str, bytes: &[u8]) -> Result<InspectOutput, Box<ErrorOutput>> {
    match Package::parse(bytes) {
        Ok(package) => Ok(InspectOutput::from_package(
            path.to_owned(),
            bytes,
            &package,
        )),
        Err(error) => Err(Box::new(ErrorOutput::package(path.to_owned(), &error))),
    }
}

/// Returns the generic inspection projection as a JSON value without an intermediate UTF-8
/// string. Native protocol execution should use [`inspect_bytes`] instead of converting this
/// value back into Rust structs.
pub fn inspect_bytes_value(path: &str, bytes: &[u8]) -> Value {
    let serialized = match inspect_bytes(path, bytes) {
        Ok(output) => serde_json::to_value(output),
        Err(error) => serde_json::to_value(*error),
    };
    serialized.unwrap_or_else(|error| {
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "status": "error",
            "path": path,
            "kind": "internal",
            "message": error.to_string()
        })
    })
}

#[derive(Serialize)]
pub struct InspectOutput {
    pub schema_version: u8,
    pub status: &'static str,
    pub path: String,
    pub package: PackageOutput,
    pub assets: Vec<AssetOutput>,
    /// Exports that failed to decode. Non-empty implies `status: "partial"`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub decode_errors: Vec<DecodeErrorOutput>,
}

#[derive(Debug, Serialize)]
pub struct DecodeErrorOutput {
    pub object_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_path: Option<String>,
    pub kind: &'static str,
    pub message: String,
}

impl InspectOutput {
    fn from_summary(path: String, summary: &PackageSummary) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            status: "ok",
            path,
            package: PackageOutput {
                name: summary.package_name.clone(),
                version: VersionOutput {
                    legacy_file: summary.versions.legacy_file_version,
                    legacy_ue3: summary.versions.legacy_ue3,
                    ue4: summary.versions.ue4,
                    ue5: summary.versions.ue5,
                    licensee: summary.versions.licensee,
                },
                package_flags: summary.versions.package_flags.bits(),
                summary_size: summary.span.len(),
                total_header_size: summary.total_header_size,
                names: TableOutput::from(summary.names),
                soft_object_paths: summary
                    .soft_object_paths
                    .map(|table| SoftObjectPathsOutput {
                        count: table.count,
                        offset: table.offset.get(),
                        parsed_count: 0,
                    }),
                imports: TableOutput::from(summary.imports),
                exports: TableOutput::from(summary.exports),
            },
            assets: Vec::new(),
            decode_errors: Vec::new(),
        }
    }

    /// Decodes every export, collecting per-export failures instead of aborting.
    /// A single unsupported or malformed export no longer blanks the whole file;
    /// callers report `status: "partial"` when `decode_errors` is non-empty.
    fn from_package(path: String, source: &[u8], package: &Package) -> Self {
        let mut output = Self::from_summary(path, &package.summary);
        if let Some(table) = &mut output.package.soft_object_paths {
            table.parsed_count = package.soft_object_paths.len();
        }
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source,
            package,
            schemas: &schemas,
        };
        for export in &package.exports {
            match decode_export(export, &context) {
                Ok(Some(decoded)) => {
                    output
                        .assets
                        .push(asset_output_from_decoded(package, decoded));
                }
                Ok(None) => {}
                Err(error) => {
                    output.decode_errors.push(DecodeErrorOutput {
                        object_path: export.object_path.to_string(),
                        class_path: export.class_path.as_ref().map(ToString::to_string),
                        kind: asset_error_kind_name(error.kind()),
                        message: error.message().to_owned(),
                    });
                }
            }
        }
        if !output.decode_errors.is_empty() {
            output.status = "partial";
        }
        output
    }
}

fn asset_error_kind_name(kind: AssetErrorKind) -> &'static str {
    match kind {
        AssetErrorKind::MalformedData => "malformed_data",
        AssetErrorKind::ResourceLimit => "resource_limit",
        AssetErrorKind::UnsupportedFormat => "unsupported_format",
        AssetErrorKind::UnsupportedVersion => "unsupported_version",
        AssetErrorKind::UnsupportedCapability => "unsupported_capability",
    }
}

fn asset_output_from_decoded(package: &Package, decoded: DecodedAsset) -> AssetOutput {
    match decoded {
        DecodedAsset::DataTable(datatable) => {
            let row_count = datatable.rows.len();
            AssetOutput {
                tail_bytes: 0,
                bones: Vec::new(),
                kind: match datatable.kind {
                    uasset_parser::asset::DataTableKind::Plain => "DataTable",
                    uasset_parser::asset::DataTableKind::Composite => "CompositeDataTable",
                },
                object_path: datatable.object_path.into_string(),
                class_path: None,
                object_guid: None,
                row_struct: datatable.row_struct.map(ObjectPath::into_string),
                parent_tables: datatable
                    .parent_tables
                    .into_iter()
                    .map(ObjectPath::into_string)
                    .collect(),
                string_table_namespace: None,
                string_table_entries: Vec::new(),
                enum_cpp_form: None,
                enum_entries: Vec::new(),
                struct_flags: None,
                struct_fields: Vec::new(),
                properties: Vec::new(),
                row_count,
                curve_rows: Vec::new(),
                rows: datatable
                    .rows
                    .into_iter()
                    .map(|row| RowOutput {
                        name: resolve_name_or_placeholder(package, row.name),
                        properties: property_outputs(package, row.properties),
                    })
                    .collect(),
            }
        }
        DecodedAsset::CurveTable(curve_table) => {
            let row_count = curve_table.rows.len();
            AssetOutput {
                tail_bytes: 0,
                bones: Vec::new(),
                kind: "CurveTable",
                object_path: curve_table.object_path.into_string(),
                class_path: Some(uasset_parser::asset::CURVETABLE_CLASS.to_owned()),
                object_guid: None,
                row_struct: None,
                parent_tables: Vec::new(),
                string_table_namespace: None,
                string_table_entries: Vec::new(),
                enum_cpp_form: None,
                enum_entries: Vec::new(),
                struct_flags: None,
                struct_fields: Vec::new(),
                properties: property_outputs(package, curve_table.properties),
                row_count,
                curve_rows: curve_table
                    .rows
                    .into_iter()
                    .map(|row| CurveRowOutput {
                        name: resolve_name_or_placeholder(package, row.name),
                        keys: row
                            .keys
                            .into_iter()
                            .map(|key| CurveKeyOutput {
                                time: key.time(),
                                value: key.value(),
                            })
                            .collect(),
                    })
                    .collect(),
                rows: Vec::new(),
            }
        }
        DecodedAsset::StringTable(string_table) => AssetOutput {
            tail_bytes: 0,
            bones: Vec::new(),
            kind: "StringTable",
            object_path: string_table.object_path.into_string(),
            class_path: Some(uasset_parser::asset::STRINGTABLE_CLASS.to_owned()),
            object_guid: None,
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: Some(string_table.namespace),
            string_table_entries: string_table
                .entries
                .into_iter()
                .map(|entry| StringTableEntryOutput {
                    key: entry.key,
                    source: entry.source,
                })
                .collect(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: Vec::new(),
            row_count: 0,
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::DataAsset(data_asset) => {
            let kind = data_asset_kind(data_asset.class_path.as_str());
            AssetOutput {
                tail_bytes: 0,
                bones: Vec::new(),
                kind,
                object_path: data_asset.object_path.into_string(),
                class_path: Some(data_asset.class_path.into_string()),
                object_guid: data_asset.object_guid.map(|guid| guid.to_string()),
                row_struct: None,
                parent_tables: Vec::new(),
                string_table_namespace: None,
                string_table_entries: Vec::new(),
                enum_cpp_form: None,
                enum_entries: Vec::new(),
                struct_flags: None,
                struct_fields: Vec::new(),
                properties: property_outputs(package, data_asset.properties),
                row_count: 0,
                curve_rows: Vec::new(),
                rows: Vec::new(),
            }
        }
        DecodedAsset::UObject(object) => AssetOutput {
            kind: "UObject",
            object_path: object.object_path.into_string(),
            class_path: Some(object.class_path.into_string()),
            object_guid: object.object_guid.map(|guid| guid.to_string()),
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: property_outputs(package, object.properties),
            tail_bytes: object.tail.len(),
            bones: Vec::new(),
            row_count: 0,
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::AnimSequence(sequence) => AssetOutput {
            kind: "UObject",
            object_path: sequence.object_path.into_string(),
            class_path: Some(ANIM_SEQUENCE_CLASS.to_owned()),
            object_guid: sequence.object_guid.map(|guid| guid.to_string()),
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: property_outputs(package, sequence.properties),
            tail_bytes: 0,
            bones: Vec::new(),
            row_count: 0,
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::Skeleton(skeleton) => AssetOutput {
            kind: "Skeleton",
            object_path: skeleton.object_path.into_string(),
            class_path: Some(SKELETON_CLASS.to_owned()),
            object_guid: skeleton.object_guid.map(|guid| guid.to_string()),
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: property_outputs(package, skeleton.properties),
            tail_bytes: 0,
            bones: skeleton
                .bones
                .into_iter()
                .map(|bone| BoneOutput {
                    name: resolve_name_or_placeholder(package, bone.name),
                    parent_index: bone.parent_index,
                })
                .collect(),
            row_count: 0,
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::Enum(decoded_enum) => {
            let row_count = decoded_enum.entries.len();
            AssetOutput {
                tail_bytes: 0,
                bones: Vec::new(),
                kind: "Enum",
                object_path: decoded_enum.object_path.into_string(),
                class_path: Some(USERDEFINEDENUM_CLASS.to_owned()),
                object_guid: None,
                row_struct: None,
                parent_tables: Vec::new(),
                string_table_namespace: None,
                string_table_entries: Vec::new(),
                enum_cpp_form: Some(enum_cpp_form_name(decoded_enum.cpp_form)),
                enum_entries: decoded_enum
                    .entries
                    .into_iter()
                    .map(|entry| EnumEntryOutput {
                        name: resolve_name_or_placeholder(package, entry.name),
                        value: entry.value,
                        display_name: entry.display_name,
                    })
                    .collect(),
                struct_flags: None,
                struct_fields: Vec::new(),
                properties: Vec::new(),
                row_count,
                curve_rows: Vec::new(),
                rows: Vec::new(),
            }
        }
        DecodedAsset::Struct(decoded_struct) => {
            let row_count = decoded_struct.fields.len();
            AssetOutput {
                tail_bytes: 0,
                bones: Vec::new(),
                kind: "Struct",
                object_path: decoded_struct.object_path.into_string(),
                class_path: Some(USERDEFINEDSTRUCT_CLASS.to_owned()),
                object_guid: None,
                row_struct: None,
                parent_tables: Vec::new(),
                string_table_namespace: None,
                string_table_entries: Vec::new(),
                enum_cpp_form: None,
                enum_entries: Vec::new(),
                struct_flags: Some(decoded_struct.struct_flags),
                struct_fields: decoded_struct
                    .fields
                    .into_iter()
                    .map(|field| StructFieldOutput {
                        name: resolve_name_or_placeholder(package, field.name),
                        type_name: resolve_name_or_placeholder(package, field.type_name),
                        referenced_path: field.referenced_path.map(ObjectPath::into_string),
                        display_name: field.display_name,
                    })
                    .collect(),
                properties: property_outputs(package, decoded_struct.default_values),
                row_count,
                curve_rows: Vec::new(),
                rows: Vec::new(),
            }
        }
    }
}

fn enum_cpp_form_name(cpp_form: EnumCppForm) -> &'static str {
    match cpp_form {
        EnumCppForm::Regular => "Regular",
        EnumCppForm::Namespaced => "Namespaced",
        EnumCppForm::EnumClass => "EnumClass",
    }
}

fn property_outputs(
    package: &Package,
    stream: uasset_parser::property::PropertyStream,
) -> Vec<PropertyOutput> {
    stream
        .records
        .into_iter()
        .map(|record| PropertyOutput::from_record(record, package))
        .collect()
}

fn data_asset_kind(class_path: &str) -> &'static str {
    match class_path {
        PRIMARY_DATA_ASSET_CLASS => "PrimaryDataAsset",
        DATA_ASSET_CLASS => "DataAsset",
        _ => "DataAsset",
    }
}

struct EmptySchemas;

impl SchemaProvider for EmptySchemas {
    fn find_struct(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&StructSchema> {
        None
    }

    fn find_class(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&ClassSchema> {
        None
    }
}

#[derive(Serialize)]
pub struct PackageOutput {
    pub name: String,
    pub version: VersionOutput,
    pub package_flags: u32,
    pub summary_size: u64,
    pub total_header_size: u32,
    pub names: TableOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_object_paths: Option<SoftObjectPathsOutput>,
    pub imports: TableOutput,
    pub exports: TableOutput,
}

#[derive(Serialize)]
pub struct SoftObjectPathsOutput {
    pub count: u32,
    pub offset: u64,
    pub parsed_count: usize,
}

#[derive(Serialize)]
pub struct AssetOutput {
    pub kind: &'static str,
    pub object_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_struct: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parent_tables: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub string_table_namespace: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub string_table_entries: Vec<StringTableEntryOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_cpp_form: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub enum_entries: Vec<EnumEntryOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub struct_flags: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub struct_fields: Vec<StructFieldOutput>,
    pub properties: Vec<PropertyOutput>,
    /// Count of unparsed class-specific bytes retained after the property stream
    /// (e.g. a `StaticMesh`/`Texture2D` binary tail). Omitted when zero.
    #[serde(skip_serializing_if = "is_zero_u64")]
    pub tail_bytes: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bones: Vec<BoneOutput>,
    pub row_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub curve_rows: Vec<CurveRowOutput>,
    pub rows: Vec<RowOutput>,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

#[derive(Serialize)]
pub struct BoneOutput {
    pub name: String,
    pub parent_index: i32,
}

#[derive(Serialize)]
pub struct EnumEntryOutput {
    pub name: String,
    pub value: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct StructFieldOutput {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referenced_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct RowOutput {
    pub name: String,
    pub properties: Vec<PropertyOutput>,
}

#[derive(Serialize)]
pub struct CurveRowOutput {
    pub name: String,
    pub keys: Vec<CurveKeyOutput>,
}

#[derive(Serialize)]
pub struct CurveKeyOutput {
    #[serde(serialize_with = "serialize_f32_as_f64")]
    pub time: f32,
    #[serde(serialize_with = "serialize_f32_as_f64")]
    pub value: f32,
}

#[derive(Serialize)]
pub struct StringTableEntryOutput {
    pub key: String,
    pub source: String,
}

#[derive(Serialize)]
pub struct PropertyOutput {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(flatten)]
    pub value: PropertyValueOutput,
}

impl PropertyOutput {
    fn from_record(record: PropertyRecord, package: &Package) -> Self {
        // `value_output` is the single `PropertyValue -> PropertyValueOutput`
        // seam, so a new value kind is added in exactly one place. Only the
        // top-level `Raw` size is record-specific: nested raw values inside
        // arrays/maps/structs have no owning payload span and report 0.
        let mut value = value_output(package, record.value);
        if let PropertyValueOutput::Raw { size, .. } = &mut value {
            *size = record.payload.len();
        }
        Self {
            name: resolve_name_or_placeholder(package, record.name),
            type_name: resolve_name_or_placeholder(package, record.type_name.name),
            value,
        }
    }
}

#[derive(Serialize)]
pub struct MapEntryOutput {
    pub key: PropertyValueOutput,
    pub value: PropertyValueOutput,
}

#[derive(Serialize)]
#[serde(tag = "value_kind", rename_all = "snake_case")]
pub enum PropertyValueOutput {
    Bool {
        value: bool,
    },
    Int {
        value: i64,
    },
    Uint {
        value: u64,
    },
    Float {
        #[serde(serialize_with = "serialize_f32_as_f64")]
        value: f32,
    },
    Double {
        value: f64,
    },
    Name {
        value: String,
    },
    Enum {
        value: String,
    },
    String {
        value: String,
    },
    Text {
        value: String,
        history: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    Vector {
        x: f64,
        y: f64,
        z: f64,
    },
    IntPoint {
        x: i32,
        y: i32,
    },
    Rotator {
        pitch: f64,
        yaw: f64,
        roll: f64,
    },
    Color {
        r: u8,
        g: u8,
        b: u8,
        a: u8,
    },
    LinearColor {
        #[serde(serialize_with = "serialize_f32_as_f64")]
        r: f32,
        #[serde(serialize_with = "serialize_f32_as_f64")]
        g: f32,
        #[serde(serialize_with = "serialize_f32_as_f64")]
        b: f32,
        #[serde(serialize_with = "serialize_f32_as_f64")]
        a: f32,
    },
    DataTableRowHandle {
        table_object_path: Option<String>,
        row_name: String,
    },
    ObjectRef {
        value: Option<String>,
    },
    Guid {
        value: String,
    },
    SoftObjectPath {
        value: String,
    },
    Array {
        values: Vec<PropertyValueOutput>,
    },
    Set {
        values: Vec<PropertyValueOutput>,
    },
    Map {
        entries: Vec<MapEntryOutput>,
    },
    Struct {
        properties: Vec<PropertyOutput>,
    },
    Raw {
        reason: String,
        size: u64,
    },
}

fn value_output(package: &Package, value: PropertyValue) -> PropertyValueOutput {
    match value {
        PropertyValue::Bool(value) => PropertyValueOutput::Bool { value },
        PropertyValue::Int(value) => PropertyValueOutput::Int { value },
        PropertyValue::UInt(value) => PropertyValueOutput::Uint { value },
        PropertyValue::Float(value) => PropertyValueOutput::Float { value },
        PropertyValue::Double(value) => PropertyValueOutput::Double { value },
        PropertyValue::Name(name) => PropertyValueOutput::Name {
            value: resolve_name_or_placeholder(package, name),
        },
        PropertyValue::Enum(name) => PropertyValueOutput::Enum {
            value: resolve_name_or_placeholder(package, name),
        },
        PropertyValue::String(value) => PropertyValueOutput::String { value },
        PropertyValue::Text(text) => text_value_output(text),
        PropertyValue::Vector(vector) => PropertyValueOutput::Vector {
            x: vector.x,
            y: vector.y,
            z: vector.z,
        },
        PropertyValue::IntPoint(point) => PropertyValueOutput::IntPoint {
            x: point.x,
            y: point.y,
        },
        PropertyValue::Rotator(rotator) => PropertyValueOutput::Rotator {
            pitch: rotator.pitch,
            yaw: rotator.yaw,
            roll: rotator.roll,
        },
        PropertyValue::Color(color) => PropertyValueOutput::Color {
            r: color.r,
            g: color.g,
            b: color.b,
            a: color.a,
        },
        PropertyValue::LinearColor(color) => PropertyValueOutput::LinearColor {
            r: color.r,
            g: color.g,
            b: color.b,
            a: color.a,
        },
        PropertyValue::DataTableRowHandle(handle) => PropertyValueOutput::DataTableRowHandle {
            table_object_path: resolve_object_ref(package, handle.table),
            row_name: resolve_name_or_placeholder(package, handle.row_name),
        },
        PropertyValue::ObjectRef(index) => PropertyValueOutput::ObjectRef {
            value: resolve_object_ref(package, index),
        },
        PropertyValue::Guid(guid) => PropertyValueOutput::Guid {
            value: guid.to_string(),
        },
        PropertyValue::SoftObjectPath(path) => PropertyValueOutput::SoftObjectPath { value: path },
        PropertyValue::Array(values) => PropertyValueOutput::Array {
            values: values
                .into_iter()
                .map(|value| value_output(package, value))
                .collect(),
        },
        PropertyValue::Set(values) => PropertyValueOutput::Set {
            values: values
                .into_iter()
                .map(|value| value_output(package, value))
                .collect(),
        },
        PropertyValue::Map(entries) => PropertyValueOutput::Map {
            entries: entries
                .into_iter()
                .map(|entry| MapEntryOutput {
                    key: value_output(package, entry.key),
                    value: value_output(package, entry.value),
                })
                .collect(),
        },
        PropertyValue::Struct(stream) => PropertyValueOutput::Struct {
            properties: property_outputs(package, stream),
        },
        PropertyValue::Raw { reason } => PropertyValueOutput::Raw {
            reason: render_raw_reason(reason),
            size: 0,
        },
    }
}

fn text_value_output(text: uasset_parser::property::TextValue) -> PropertyValueOutput {
    use uasset_parser::property::TextHistory;

    match text.history {
        TextHistory::None => PropertyValueOutput::Text {
            value: text.source,
            history: "none",
            namespace: None,
            key: None,
        },
        TextHistory::Base { namespace, key } => PropertyValueOutput::Text {
            value: text.source,
            history: "base",
            namespace: Some(namespace),
            key: Some(key),
        },
    }
}

fn resolve_name_or_placeholder(package: &Package, name: uasset_parser::archive::NameRef) -> String {
    package
        .resolve_name(name)
        .unwrap_or_else(|| "<unresolved>".to_owned())
}

fn resolve_object_ref(package: &Package, index: PackageIndex) -> Option<String> {
    if index == PackageIndex::Null {
        None
    } else {
        package.resolve_index_str(index).map(str::to_owned)
    }
}

fn render_raw_reason(reason: RawReason) -> String {
    match reason {
        RawReason::UnsupportedType => "unsupported type".to_owned(),
        RawReason::DecoderRejected(detail) => detail,
    }
}

#[derive(Serialize)]
pub struct VersionOutput {
    pub legacy_file: i32,
    pub legacy_ue3: Option<i32>,
    pub ue4: i32,
    pub ue5: i32,
    pub licensee: i32,
}

#[derive(Serialize)]
pub struct TableOutput {
    pub count: u32,
    pub offset: u64,
}

impl From<TableLocation> for TableOutput {
    fn from(table: TableLocation) -> Self {
        Self {
            count: table.count,
            offset: table.offset.get(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorOutput {
    pub schema_version: u8,
    pub status: &'static str,
    pub path: String,
    pub kind: &'static str,
    pub message: String,
    pub field: Option<String>,
    pub offset: Option<u64>,
}

impl ErrorOutput {
    fn package(path: String, error: &PackageError) -> Self {
        let kind = match error.kind() {
            PackageErrorKind::MalformedData => "malformed_data",
            PackageErrorKind::ResourceLimit => "resource_limit",
            PackageErrorKind::UnsupportedFormat => "unsupported_format",
            PackageErrorKind::UnsupportedVersion => "unsupported_version",
            PackageErrorKind::UnsupportedCapability => "unsupported_capability",
        };
        Self {
            schema_version: SCHEMA_VERSION,
            status: "error",
            path,
            kind,
            message: error.detail().to_owned(),
            field: Some(error.path().to_owned()),
            offset: error.offset(),
        }
    }
}
