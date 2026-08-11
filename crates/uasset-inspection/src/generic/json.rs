use std::cell::RefCell;
use std::io;

use serde::ser::{SerializeSeq, SerializeStruct};
use serde::{Serialize, Serializer};
use uasset_parser::archive::{Guid, NameRef};
use uasset_parser::asset::{
    ANIM_SEQUENCE_CLASS, AssetDecodeContext, DecodedAsset, SKELETON_CLASS, USERDEFINEDENUM_CLASS,
    USERDEFINEDSTRUCT_CLASS, decode_export,
};
use uasset_parser::package::{ObjectPath, Package, PackageIndex, TableLocation};
use uasset_parser::property::{
    MapEntry, PropertyRecord, PropertyStream, PropertyValue, RawReason, TextHistory,
};

use super::{
    DecodeErrorOutput, EmptySchemas, ErrorOutput, SCHEMA_VERSION, asset_error_kind_name,
    data_asset_kind, enum_cpp_form_name, serialize_f32_as_f64,
};

const MAX_INITIAL_JSON_CAPACITY: usize = 32 * 1024 * 1024;

/// Whether a successfully serialized inspection decoded every export.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InspectionJsonStatus {
    Ok,
    Partial,
}

impl InspectionJsonStatus {
    #[must_use]
    pub const fn is_partial(self) -> bool {
        matches!(self, Self::Partial)
    }
}

/// A failure before or during direct generic-inspection serialization.
#[derive(Debug)]
pub enum InspectionJsonError {
    Inspection(Box<ErrorOutput>),
    Serialization(String),
}

impl InspectionJsonError {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Inspection(error) => error.kind,
            Self::Serialization(_) => "internal",
        }
    }

    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::Inspection(error) => &error.message,
            Self::Serialization(message) => message,
        }
    }
}

/// Decodes and serializes one generic inspection without constructing the owned output DTO tree.
///
/// The caller owns the writer and can therefore keep output atomic in a temporary buffer or enforce
/// a hard byte limit. Package failures are returned before serialization begins; serialization
/// failures may leave bytes in the supplied writer.
pub fn write_inspection_json(
    path: &str,
    bytes: &[u8],
    writer: impl io::Write,
) -> Result<InspectionJsonStatus, InspectionJsonError> {
    let package = Package::parse(bytes).map_err(|error| {
        InspectionJsonError::Inspection(Box::new(ErrorOutput::package(path.to_owned(), &error)))
    })?;
    let inspection = StreamingInspection::new(path, bytes, package);
    serde_json::to_writer(writer, &inspection)
        .map_err(|error| InspectionJsonError::Serialization(error.to_string()))?;
    Ok(inspection.status())
}

/// Returns the schema-versioned generic inspection JSON used by compatibility and WASM adapters.
#[must_use]
pub fn inspect_bytes_json(path: &str, bytes: &[u8]) -> String {
    let capacity = bytes.len().saturating_mul(2).min(MAX_INITIAL_JSON_CAPACITY);
    let mut output = Vec::with_capacity(capacity);
    match write_inspection_json(path, bytes, &mut output) {
        Ok(_) => String::from_utf8(output).expect("serde_json writes valid UTF-8"),
        Err(InspectionJsonError::Inspection(error)) => serde_json::to_string(&*error)
            .unwrap_or_else(|error| internal_error_json(path, error.to_string())),
        Err(InspectionJsonError::Serialization(message)) => internal_error_json(path, message),
    }
}

fn internal_error_json(path: &str, message: String) -> String {
    serde_json::json!({
        "schema_version": SCHEMA_VERSION,
        "status": "error",
        "path": path,
        "kind": "internal",
        "message": message
    })
    .to_string()
}

struct StreamingInspection<'a> {
    path: &'a str,
    source: &'a [u8],
    package: Package,
    decode_errors: RefCell<Vec<DecodeErrorOutput>>,
}

impl<'a> StreamingInspection<'a> {
    fn new(path: &'a str, source: &'a [u8], package: Package) -> Self {
        Self {
            path,
            source,
            package,
            decode_errors: RefCell::new(Vec::new()),
        }
    }

    fn status(&self) -> InspectionJsonStatus {
        if self.decode_errors.borrow().is_empty() {
            InspectionJsonStatus::Ok
        } else {
            InspectionJsonStatus::Partial
        }
    }
}

impl Serialize for StreamingInspection<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut output = serializer.serialize_struct("InspectOutput", 6)?;
        output.serialize_field("schema_version", &SCHEMA_VERSION)?;
        output.serialize_field("path", self.path)?;
        output.serialize_field("package", &PackageView(&self.package))?;
        output.serialize_field(
            "assets",
            &StreamingAssetsView {
                package: &self.package,
                source: self.source,
                decode_errors: &self.decode_errors,
            },
        )?;
        let decode_errors = self.decode_errors.borrow();
        output.serialize_field(
            "status",
            if decode_errors.is_empty() {
                "ok"
            } else {
                "partial"
            },
        )?;
        if !decode_errors.is_empty() {
            output.serialize_field("decode_errors", &*decode_errors)?;
        }
        output.end()
    }
}

struct PackageView<'a>(&'a Package);

impl Serialize for PackageView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let package = self.0;
        let summary = &package.summary;
        let mut output = serializer.serialize_struct(
            "PackageOutput",
            if summary.soft_object_paths.is_some() {
                8
            } else {
                7
            },
        )?;
        output.serialize_field("name", summary.package_name.as_str())?;
        output.serialize_field(
            "version",
            &VersionView {
                legacy_file: summary.versions.legacy_file_version,
                legacy_ue3: summary.versions.legacy_ue3,
                ue4: summary.versions.ue4,
                ue5: summary.versions.ue5,
                licensee: summary.versions.licensee,
            },
        )?;
        output.serialize_field("package_flags", &summary.versions.package_flags.bits())?;
        output.serialize_field("summary_size", &summary.span.len())?;
        output.serialize_field("total_header_size", &summary.total_header_size)?;
        output.serialize_field("names", &TableView(summary.names))?;
        if let Some(table) = summary.soft_object_paths {
            output.serialize_field(
                "soft_object_paths",
                &SoftObjectPathsView {
                    count: table.count,
                    offset: table.offset.get(),
                    parsed_count: package.soft_object_paths.len(),
                },
            )?;
        }
        output.serialize_field("imports", &TableView(summary.imports))?;
        output.serialize_field("exports", &TableView(summary.exports))?;
        output.end()
    }
}

#[derive(Serialize)]
struct VersionView {
    legacy_file: i32,
    legacy_ue3: Option<i32>,
    ue4: i32,
    ue5: i32,
    licensee: i32,
}

struct TableView(TableLocation);

impl Serialize for TableView {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut output = serializer.serialize_struct("TableOutput", 2)?;
        output.serialize_field("count", &self.0.count)?;
        output.serialize_field("offset", &self.0.offset.get())?;
        output.end()
    }
}

#[derive(Serialize)]
struct SoftObjectPathsView {
    count: u32,
    offset: u64,
    parsed_count: usize,
}

struct StreamingAssetsView<'a> {
    package: &'a Package,
    source: &'a [u8],
    decode_errors: &'a RefCell<Vec<DecodeErrorOutput>>,
}

impl Serialize for StreamingAssetsView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: self.source,
            package: self.package,
            schemas: &schemas,
        };
        let mut sequence = serializer.serialize_seq(None)?;
        for export in &self.package.exports {
            match decode_export(export, &context) {
                Ok(Some(asset)) => sequence.serialize_element(&AssetView {
                    package: self.package,
                    asset: &asset,
                })?,
                Ok(None) => {}
                Err(error) => self.decode_errors.borrow_mut().push(DecodeErrorOutput {
                    object_path: export.object_path.to_string(),
                    class_path: export.class_path.as_ref().map(ToString::to_string),
                    kind: asset_error_kind_name(error.kind()),
                    message: error.message().to_owned(),
                }),
            }
        }
        sequence.end()
    }
}

struct AssetView<'a> {
    package: &'a Package,
    asset: &'a DecodedAsset,
}

impl Serialize for AssetView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let package = self.package;
        let fields = match self.asset {
            DecodedAsset::DataTable(table) => AssetFields {
                kind: match table.kind {
                    uasset_parser::asset::DataTableKind::Plain => "DataTable",
                    uasset_parser::asset::DataTableKind::Composite => "CompositeDataTable",
                },
                object_path: table.object_path.as_str(),
                class_path: None,
                object_guid: None,
                row_struct: table.row_struct.as_ref().map(ObjectPath::as_str),
                parent_tables: ObjectPathsView(&table.parent_tables),
                string_table_namespace: None,
                string_table_entries: StringTableEntriesView(&[]),
                enum_cpp_form: None,
                enum_entries: EnumEntriesView {
                    package,
                    entries: &[],
                },
                struct_flags: None,
                struct_fields: StructFieldsView {
                    package,
                    fields: &[],
                },
                properties: PropertiesView::empty(package),
                tail_bytes: 0,
                bones: BonesView {
                    package,
                    bones: &[],
                },
                row_count: table.rows.len(),
                curve_rows: CurveRowsView { package, rows: &[] },
                rows: RowsView {
                    package,
                    rows: &table.rows,
                },
            },
            DecodedAsset::CurveTable(table) => AssetFields {
                kind: "CurveTable",
                object_path: table.object_path.as_str(),
                class_path: Some(uasset_parser::asset::CURVETABLE_CLASS),
                object_guid: None,
                row_struct: None,
                parent_tables: ObjectPathsView(&[]),
                string_table_namespace: None,
                string_table_entries: StringTableEntriesView(&[]),
                enum_cpp_form: None,
                enum_entries: EnumEntriesView {
                    package,
                    entries: &[],
                },
                struct_flags: None,
                struct_fields: StructFieldsView {
                    package,
                    fields: &[],
                },
                properties: PropertiesView::new(package, &table.properties),
                tail_bytes: 0,
                bones: BonesView {
                    package,
                    bones: &[],
                },
                row_count: table.rows.len(),
                curve_rows: CurveRowsView {
                    package,
                    rows: &table.rows,
                },
                rows: RowsView { package, rows: &[] },
            },
            DecodedAsset::StringTable(table) => AssetFields {
                kind: "StringTable",
                object_path: table.object_path.as_str(),
                class_path: Some(uasset_parser::asset::STRINGTABLE_CLASS),
                object_guid: None,
                row_struct: None,
                parent_tables: ObjectPathsView(&[]),
                string_table_namespace: Some(table.namespace.as_str()),
                string_table_entries: StringTableEntriesView(&table.entries),
                enum_cpp_form: None,
                enum_entries: EnumEntriesView {
                    package,
                    entries: &[],
                },
                struct_flags: None,
                struct_fields: StructFieldsView {
                    package,
                    fields: &[],
                },
                properties: PropertiesView::empty(package),
                tail_bytes: 0,
                bones: BonesView {
                    package,
                    bones: &[],
                },
                row_count: 0,
                curve_rows: CurveRowsView { package, rows: &[] },
                rows: RowsView { package, rows: &[] },
            },
            DecodedAsset::DataAsset(asset) => AssetFields {
                kind: data_asset_kind(asset.class_path.as_str()),
                object_path: asset.object_path.as_str(),
                class_path: Some(asset.class_path.as_str()),
                object_guid: asset.object_guid.as_ref().map(GuidView),
                row_struct: None,
                parent_tables: ObjectPathsView(&[]),
                string_table_namespace: None,
                string_table_entries: StringTableEntriesView(&[]),
                enum_cpp_form: None,
                enum_entries: EnumEntriesView {
                    package,
                    entries: &[],
                },
                struct_flags: None,
                struct_fields: StructFieldsView {
                    package,
                    fields: &[],
                },
                properties: PropertiesView::new(package, &asset.properties),
                tail_bytes: 0,
                bones: BonesView {
                    package,
                    bones: &[],
                },
                row_count: 0,
                curve_rows: CurveRowsView { package, rows: &[] },
                rows: RowsView { package, rows: &[] },
            },
            DecodedAsset::UObject(object) => AssetFields {
                kind: "UObject",
                object_path: object.object_path.as_str(),
                class_path: Some(object.class_path.as_str()),
                object_guid: object.object_guid.as_ref().map(GuidView),
                row_struct: None,
                parent_tables: ObjectPathsView(&[]),
                string_table_namespace: None,
                string_table_entries: StringTableEntriesView(&[]),
                enum_cpp_form: None,
                enum_entries: EnumEntriesView {
                    package,
                    entries: &[],
                },
                struct_flags: None,
                struct_fields: StructFieldsView {
                    package,
                    fields: &[],
                },
                properties: PropertiesView::new(package, &object.properties),
                tail_bytes: object.tail.len(),
                bones: BonesView {
                    package,
                    bones: &[],
                },
                row_count: 0,
                curve_rows: CurveRowsView { package, rows: &[] },
                rows: RowsView { package, rows: &[] },
            },
            DecodedAsset::AnimSequence(sequence) => AssetFields {
                kind: "UObject",
                object_path: sequence.object_path.as_str(),
                class_path: Some(ANIM_SEQUENCE_CLASS),
                object_guid: sequence.object_guid.as_ref().map(GuidView),
                row_struct: None,
                parent_tables: ObjectPathsView(&[]),
                string_table_namespace: None,
                string_table_entries: StringTableEntriesView(&[]),
                enum_cpp_form: None,
                enum_entries: EnumEntriesView {
                    package,
                    entries: &[],
                },
                struct_flags: None,
                struct_fields: StructFieldsView {
                    package,
                    fields: &[],
                },
                properties: PropertiesView::new(package, &sequence.properties),
                tail_bytes: 0,
                bones: BonesView {
                    package,
                    bones: &[],
                },
                row_count: 0,
                curve_rows: CurveRowsView { package, rows: &[] },
                rows: RowsView { package, rows: &[] },
            },
            DecodedAsset::Skeleton(skeleton) => AssetFields {
                kind: "Skeleton",
                object_path: skeleton.object_path.as_str(),
                class_path: Some(SKELETON_CLASS),
                object_guid: skeleton.object_guid.as_ref().map(GuidView),
                row_struct: None,
                parent_tables: ObjectPathsView(&[]),
                string_table_namespace: None,
                string_table_entries: StringTableEntriesView(&[]),
                enum_cpp_form: None,
                enum_entries: EnumEntriesView {
                    package,
                    entries: &[],
                },
                struct_flags: None,
                struct_fields: StructFieldsView {
                    package,
                    fields: &[],
                },
                properties: PropertiesView::new(package, &skeleton.properties),
                tail_bytes: 0,
                bones: BonesView {
                    package,
                    bones: &skeleton.bones,
                },
                row_count: 0,
                curve_rows: CurveRowsView { package, rows: &[] },
                rows: RowsView { package, rows: &[] },
            },
            DecodedAsset::Enum(decoded) => AssetFields {
                kind: "Enum",
                object_path: decoded.object_path.as_str(),
                class_path: Some(USERDEFINEDENUM_CLASS),
                object_guid: None,
                row_struct: None,
                parent_tables: ObjectPathsView(&[]),
                string_table_namespace: None,
                string_table_entries: StringTableEntriesView(&[]),
                enum_cpp_form: Some(enum_cpp_form_name(decoded.cpp_form)),
                enum_entries: EnumEntriesView {
                    package,
                    entries: &decoded.entries,
                },
                struct_flags: None,
                struct_fields: StructFieldsView {
                    package,
                    fields: &[],
                },
                properties: PropertiesView::empty(package),
                tail_bytes: 0,
                bones: BonesView {
                    package,
                    bones: &[],
                },
                row_count: decoded.entries.len(),
                curve_rows: CurveRowsView { package, rows: &[] },
                rows: RowsView { package, rows: &[] },
            },
            DecodedAsset::Struct(decoded) => AssetFields {
                kind: "Struct",
                object_path: decoded.object_path.as_str(),
                class_path: Some(USERDEFINEDSTRUCT_CLASS),
                object_guid: None,
                row_struct: None,
                parent_tables: ObjectPathsView(&[]),
                string_table_namespace: None,
                string_table_entries: StringTableEntriesView(&[]),
                enum_cpp_form: None,
                enum_entries: EnumEntriesView {
                    package,
                    entries: &[],
                },
                struct_flags: Some(decoded.struct_flags),
                struct_fields: StructFieldsView {
                    package,
                    fields: &decoded.fields,
                },
                properties: PropertiesView::new(package, &decoded.default_values),
                tail_bytes: 0,
                bones: BonesView {
                    package,
                    bones: &[],
                },
                row_count: decoded.fields.len(),
                curve_rows: CurveRowsView { package, rows: &[] },
                rows: RowsView { package, rows: &[] },
            },
        };
        fields.serialize(serializer)
    }
}

#[derive(Serialize)]
struct AssetFields<'a> {
    kind: &'static str,
    object_path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_guid: Option<GuidView<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    row_struct: Option<&'a str>,
    #[serde(skip_serializing_if = "ObjectPathsView::is_empty")]
    parent_tables: ObjectPathsView<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    string_table_namespace: Option<&'a str>,
    #[serde(skip_serializing_if = "StringTableEntriesView::is_empty")]
    string_table_entries: StringTableEntriesView<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enum_cpp_form: Option<&'static str>,
    #[serde(skip_serializing_if = "EnumEntriesView::is_empty")]
    enum_entries: EnumEntriesView<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    struct_flags: Option<u32>,
    #[serde(skip_serializing_if = "StructFieldsView::is_empty")]
    struct_fields: StructFieldsView<'a>,
    properties: PropertiesView<'a>,
    #[serde(skip_serializing_if = "is_zero_u64")]
    tail_bytes: u64,
    #[serde(skip_serializing_if = "BonesView::is_empty")]
    bones: BonesView<'a>,
    row_count: usize,
    #[serde(skip_serializing_if = "CurveRowsView::is_empty")]
    curve_rows: CurveRowsView<'a>,
    rows: RowsView<'a>,
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

#[derive(Clone, Copy)]
struct GuidView<'a>(&'a Guid);

impl Serialize for GuidView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.to_string())
    }
}

struct ObjectPathsView<'a>(&'a [ObjectPath]);

impl ObjectPathsView<'_> {
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for ObjectPathsView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for path in self.0 {
            sequence.serialize_element(path.as_str())?;
        }
        sequence.end()
    }
}

struct StringTableEntriesView<'a>(&'a [uasset_parser::asset::StringTableEntry]);

impl StringTableEntriesView<'_> {
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for StringTableEntriesView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for entry in self.0 {
            sequence.serialize_element(&StringTableEntryView {
                key: &entry.key,
                source: &entry.source,
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct StringTableEntryView<'a> {
    key: &'a str,
    source: &'a str,
}

struct EnumEntriesView<'a> {
    package: &'a Package,
    entries: &'a [uasset_parser::asset::EnumEntry],
}

impl EnumEntriesView<'_> {
    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Serialize for EnumEntriesView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.entries.len()))?;
        for entry in self.entries {
            sequence.serialize_element(&EnumEntryView {
                name: NameView::new(self.package, entry.name),
                value: entry.value,
                display_name: entry.display_name.as_deref(),
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct EnumEntryView<'a> {
    name: NameView<'a>,
    value: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<&'a str>,
}

struct StructFieldsView<'a> {
    package: &'a Package,
    fields: &'a [uasset_parser::asset::StructField],
}

impl StructFieldsView<'_> {
    fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }
}

impl Serialize for StructFieldsView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.fields.len()))?;
        for field in self.fields {
            sequence.serialize_element(&StructFieldView {
                name: NameView::new(self.package, field.name),
                type_name: NameView::new(self.package, field.type_name),
                referenced_path: field.referenced_path.as_ref().map(ObjectPath::as_str),
                display_name: field.display_name.as_deref(),
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct StructFieldView<'a> {
    name: NameView<'a>,
    #[serde(rename = "type")]
    type_name: NameView<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    referenced_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<&'a str>,
}

struct BonesView<'a> {
    package: &'a Package,
    bones: &'a [uasset_parser::asset::SkeletonBone],
}

impl BonesView<'_> {
    fn is_empty(&self) -> bool {
        self.bones.is_empty()
    }
}

impl Serialize for BonesView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.bones.len()))?;
        for bone in self.bones {
            sequence.serialize_element(&BoneView {
                name: NameView::new(self.package, bone.name),
                parent_index: bone.parent_index,
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct BoneView<'a> {
    name: NameView<'a>,
    parent_index: i32,
}

struct CurveRowsView<'a> {
    package: &'a Package,
    rows: &'a [uasset_parser::asset::CurveTableRow],
}

impl CurveRowsView<'_> {
    fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

impl Serialize for CurveRowsView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.rows.len()))?;
        for row in self.rows {
            sequence.serialize_element(&CurveRowView {
                name: NameView::new(self.package, row.name),
                keys: CurveKeysView(&row.keys),
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct CurveRowView<'a> {
    name: NameView<'a>,
    keys: CurveKeysView<'a>,
}

struct CurveKeysView<'a>(&'a [uasset_parser::asset::CurveKey]);

impl Serialize for CurveKeysView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for key in self.0 {
            sequence.serialize_element(&CurveKeyView {
                time: key.time(),
                value: key.value(),
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct CurveKeyView {
    #[serde(serialize_with = "serialize_f32_as_f64")]
    time: f32,
    #[serde(serialize_with = "serialize_f32_as_f64")]
    value: f32,
}

struct RowsView<'a> {
    package: &'a Package,
    rows: &'a [uasset_parser::asset::DataTableRow],
}

impl Serialize for RowsView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.rows.len()))?;
        for row in self.rows {
            sequence.serialize_element(&RowView {
                name: NameView::new(self.package, row.name),
                properties: PropertiesView::new(self.package, &row.properties),
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct RowView<'a> {
    name: NameView<'a>,
    properties: PropertiesView<'a>,
}

struct PropertiesView<'a> {
    package: &'a Package,
    records: &'a [PropertyRecord],
}

impl<'a> PropertiesView<'a> {
    fn new(package: &'a Package, stream: &'a PropertyStream) -> Self {
        Self {
            package,
            records: &stream.records,
        }
    }

    fn empty(package: &'a Package) -> Self {
        Self {
            package,
            records: &[],
        }
    }
}

impl Serialize for PropertiesView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.records.len()))?;
        for record in self.records {
            sequence.serialize_element(&PropertyView::new(self.package, record))?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct PropertyView<'a> {
    name: NameView<'a>,
    #[serde(rename = "type")]
    type_name: NameView<'a>,
    #[serde(flatten)]
    value: PropertyValueView<'a>,
}

impl<'a> PropertyView<'a> {
    fn new(package: &'a Package, record: &'a PropertyRecord) -> Self {
        Self {
            name: NameView::new(package, record.name),
            type_name: NameView::new(package, record.type_name.name),
            value: PropertyValueView::new(package, &record.value, record.payload.len()),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "value_kind", rename_all = "snake_case")]
enum PropertyValueView<'a> {
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
        value: NameView<'a>,
    },
    Enum {
        value: NameView<'a>,
    },
    String {
        value: &'a str,
    },
    Text {
        value: &'a str,
        history: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        namespace: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        key: Option<&'a str>,
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
        table_object_path: ObjectReferenceView<'a>,
        row_name: NameView<'a>,
    },
    ObjectRef {
        value: ObjectReferenceView<'a>,
    },
    Guid {
        value: GuidView<'a>,
    },
    SoftObjectPath {
        value: &'a str,
    },
    Array {
        values: PropertyValuesView<'a>,
    },
    Set {
        values: PropertyValuesView<'a>,
    },
    Map {
        entries: MapEntriesView<'a>,
    },
    Struct {
        properties: PropertiesView<'a>,
    },
    Raw {
        reason: RawReasonView<'a>,
        size: u64,
    },
    #[serde(rename = "raw")]
    OmittedNative {
        reason: &'static str,
        size: u64,
    },
}

impl<'a> PropertyValueView<'a> {
    fn new(package: &'a Package, value: &'a PropertyValue, raw_size: u64) -> Self {
        match value {
            PropertyValue::Bool(value) => Self::Bool { value: *value },
            PropertyValue::Int(value) => Self::Int { value: *value },
            PropertyValue::UInt(value) => Self::Uint { value: *value },
            PropertyValue::Float(value) => Self::Float { value: *value },
            PropertyValue::Double(value) => Self::Double { value: *value },
            PropertyValue::Name(value) => Self::Name {
                value: NameView::new(package, *value),
            },
            PropertyValue::Enum(value) => Self::Enum {
                value: NameView::new(package, *value),
            },
            PropertyValue::String(value) => Self::String { value },
            PropertyValue::Text(text) => match &text.history {
                TextHistory::None => Self::Text {
                    value: &text.source,
                    history: "none",
                    namespace: None,
                    key: None,
                },
                TextHistory::Base { namespace, key } => Self::Text {
                    value: &text.source,
                    history: "base",
                    namespace: Some(namespace),
                    key: Some(key),
                },
            },
            PropertyValue::Vector(value) => Self::Vector {
                x: value.x,
                y: value.y,
                z: value.z,
            },
            PropertyValue::IntPoint(value) => Self::IntPoint {
                x: value.x,
                y: value.y,
            },
            PropertyValue::Rotator(value) => Self::Rotator {
                pitch: value.pitch,
                yaw: value.yaw,
                roll: value.roll,
            },
            PropertyValue::Color(value) => Self::Color {
                r: value.r,
                g: value.g,
                b: value.b,
                a: value.a,
            },
            PropertyValue::LinearColor(value) => Self::LinearColor {
                r: value.r,
                g: value.g,
                b: value.b,
                a: value.a,
            },
            PropertyValue::DataTableRowHandle(value) => Self::DataTableRowHandle {
                table_object_path: ObjectReferenceView::new(package, value.table),
                row_name: NameView::new(package, value.row_name),
            },
            PropertyValue::DateTime(_) => Self::OmittedNative {
                reason: "decoded native date time; omitted from generic schema v8",
                size: raw_size,
            },
            PropertyValue::FrameRange(_) => Self::OmittedNative {
                reason: "decoded native frame range; omitted from generic schema v8",
                size: raw_size,
            },
            PropertyValue::ObjectRef(value) => Self::ObjectRef {
                value: ObjectReferenceView::new(package, *value),
            },
            PropertyValue::Guid(value) => Self::Guid {
                value: GuidView(value),
            },
            PropertyValue::SoftObjectPath(value) => Self::SoftObjectPath { value },
            PropertyValue::Array(values) => Self::Array {
                values: PropertyValuesView { package, values },
            },
            PropertyValue::Set(values) => Self::Set {
                values: PropertyValuesView { package, values },
            },
            PropertyValue::Map(entries) => Self::Map {
                entries: MapEntriesView { package, entries },
            },
            PropertyValue::Struct(stream) => Self::Struct {
                properties: PropertiesView::new(package, stream),
            },
            PropertyValue::Raw { reason } => Self::Raw {
                reason: RawReasonView(reason),
                size: raw_size,
            },
        }
    }
}

struct PropertyValuesView<'a> {
    package: &'a Package,
    values: &'a [PropertyValue],
}

impl Serialize for PropertyValuesView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.values.len()))?;
        for value in self.values {
            sequence.serialize_element(&PropertyValueView::new(self.package, value, 0))?;
        }
        sequence.end()
    }
}

struct MapEntriesView<'a> {
    package: &'a Package,
    entries: &'a [MapEntry],
}

impl Serialize for MapEntriesView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.entries.len()))?;
        for entry in self.entries {
            sequence.serialize_element(&MapEntryView {
                key: PropertyValueView::new(self.package, &entry.key, 0),
                value: PropertyValueView::new(self.package, &entry.value, 0),
            })?;
        }
        sequence.end()
    }
}

#[derive(Serialize)]
struct MapEntryView<'a> {
    key: PropertyValueView<'a>,
    value: PropertyValueView<'a>,
}

#[derive(Clone, Copy)]
struct NameView<'a> {
    package: &'a Package,
    name: NameRef,
}

impl<'a> NameView<'a> {
    fn new(package: &'a Package, name: NameRef) -> Self {
        Self { package, name }
    }
}

impl Serialize for NameView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self.package.resolve_name_cow(self.name) {
            Some(value) => serializer.serialize_str(&value),
            None => serializer.serialize_str("<unresolved>"),
        }
    }
}

#[derive(Clone, Copy)]
struct ObjectReferenceView<'a> {
    package: &'a Package,
    index: PackageIndex,
}

impl<'a> ObjectReferenceView<'a> {
    fn new(package: &'a Package, index: PackageIndex) -> Self {
        Self { package, index }
    }
}

impl Serialize for ObjectReferenceView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if self.index == PackageIndex::Null {
            serializer.serialize_none()
        } else if let Some(path) = self.package.resolve_index_str(self.index) {
            serializer.serialize_some(path)
        } else {
            serializer.serialize_none()
        }
    }
}

struct RawReasonView<'a>(&'a RawReason);

impl Serialize for RawReasonView<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(match self.0 {
            RawReason::UnsupportedType => "unsupported type",
            RawReason::DecoderRejected(detail) => detail,
        })
    }
}
