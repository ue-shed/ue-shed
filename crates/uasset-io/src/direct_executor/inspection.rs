use uasset_inspection::generic::SCHEMA_VERSION;
use uasset_parser::Package;
use uasset_parser::archive::NameRef;
use uasset_parser::asset::{
    ANIM_SEQUENCE_CLASS, AssetDecodeContext, AssetErrorKind, DATA_ASSET_CLASS, DecodedAsset,
    EnumCppForm, PRIMARY_DATA_ASSET_CLASS, SKELETON_CLASS, USERDEFINEDENUM_CLASS,
    USERDEFINEDSTRUCT_CLASS, decode_export,
};
use uasset_parser::package::{ObjectPath, PackageErrorKind, PackageIndex};
use uasset_parser::property::{
    PropertyRecord, PropertyStream, PropertyValue, RawReason, TextHistory as ParserTextHistory,
};
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};

use super::{Failure, checkpoint};
use crate::cancellation::CancellationToken;
use crate::protocol_result::{
    InspectionStatus, SavedAsset, SavedAssetDecodeError, SavedAssetDecodeErrorKind,
    SavedAssetInspection, SavedBone, SavedCurveKey, SavedCurveRow, SavedEnumEntry,
    SavedPackageSummary, SavedPackageVersion, SavedProperty, SavedPropertyMapEntry,
    SavedPropertyValue, SavedStringTableEntry, SavedStructField, SavedTableRow, TextHistory,
};

pub(super) fn inspect_bytes(
    path: &str,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<(SavedAssetInspection, bool), Failure> {
    checkpoint(cancellation, "parsing")?;
    let package = Package::parse(bytes).map_err(|error| Failure {
        code: package_error_kind(error.kind()).to_owned(),
        message: error.detail().to_owned(),
        retry_safe: false,
        ..Default::default()
    })?;
    checkpoint(cancellation, "parsing")?;

    let version = &package.summary.versions;
    let legacy_ue3 = version.legacy_ue3.ok_or_else(|| {
        Failure::new(
            "contract",
            "inspection package version is missing legacy_ue3",
            false,
        )
    })?;
    let mut assets = Vec::with_capacity(package.exports.len());
    let mut decode_errors = Vec::new();
    let schemas = EmptySchemas;
    let context = AssetDecodeContext {
        source: bytes,
        package: &package,
        schemas: &schemas,
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
    checkpoint(cancellation, "inspection")?;

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
            string_table_entries: table
                .entries
                .into_iter()
                .map(|entry| SavedStringTableEntry {
                    key: entry.key,
                    source: entry.source,
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
            object_path: object.object_path.into_string(),
            class_path: object.class_path.into_string(),
            properties: saved_properties(package, object.properties),
            tail_bytes: (!object.tail.is_empty()).then_some(object.tail.len()),
        },
        DecodedAsset::AnimSequence(sequence) => SavedAsset::UObject {
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
        PropertyValue::Text(text) => match text.history {
            ParserTextHistory::None => SavedPropertyValue::Text {
                value: text.source,
                history: TextHistory::None,
                namespace: None,
                key: None,
            },
            ParserTextHistory::Base { namespace, key } => SavedPropertyValue::Text {
                value: text.source,
                history: TextHistory::Base,
                namespace: Some(namespace),
                key: Some(key),
            },
        },
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
        PropertyValue::Struct(properties) => SavedPropertyValue::Struct {
            properties: saved_properties(package, properties),
        },
        PropertyValue::Raw { reason } => SavedPropertyValue::Raw {
            reason: match reason {
                RawReason::UnsupportedType => "unsupported type".to_owned(),
                RawReason::DecoderRejected(detail) => detail,
            },
            size: 0,
        },
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

struct EmptySchemas;

impl SchemaProvider for EmptySchemas {
    fn find_struct(&self, _path: &ObjectPath) -> Option<&StructSchema> {
        None
    }

    fn find_class(&self, _path: &ObjectPath) -> Option<&ClassSchema> {
        None
    }
}

#[cfg(test)]
mod tests {
    use uasset_inspection::generic::inspect_bytes as inspect_generic_bytes;

    use super::inspect_bytes;
    use crate::cancellation::CancellationToken;
    use crate::protocol_adapter::adapt_inspection;

    const PARITY_FIXTURES: &[(&str, &[u8])] = &[
        (
            "Content/Fixture/Authoring/DT_Scalars.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
            ),
        ),
        (
            "Content/Fixture/Authoring/DT_LargeScalars.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_LargeScalars.uasset"
            ),
        ),
        (
            "Content/Fixture/Input/IMC_Fixture.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Input/IMC_Fixture.uasset"
            ),
        ),
        (
            "Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset"
            ),
        ),
        (
            "Content/Fixture/Text/ST_Game.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset"
            ),
        ),
        (
            "Content/Fixture/Cameras/L_CameraLoad.umap",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap"
            ),
        ),
    ];

    #[test]
    fn direct_protocol_projection_matches_the_previous_generic_adapter() {
        for (path, bytes) in PARITY_FIXTURES {
            let generic = inspect_generic_bytes(path, bytes).expect("generic inspection succeeds");
            let expected = adapt_inspection(generic).expect("generic inspection adapts");
            let (actual, partial) = inspect_bytes(path, bytes, &CancellationToken::new())
                .expect("direct protocol inspection succeeds");

            assert_eq!(actual, expected, "protocol projection differs for {path}");
            assert_eq!(
                partial,
                actual.status == crate::protocol_result::InspectionStatus::Partial
            );
        }
    }
}
