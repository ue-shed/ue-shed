use std::fs;
use std::path::{Path, PathBuf};

use uasset_parser::asset::{
    AssetDecodeContext, DecodedAsset, decode_export, decode_modeled_export,
};
use uasset_parser::package::{ObjectPath, Package};
use uasset_parser::property::{PropertyStream, PropertyValue, TextHistory};
use uasset_parser::schema::{ClassSchema, FieldType, SchemaProvider, SourceModel, StructSchema};

const DATA_ASSET_CLASS: &str = "/Script/UEShedFixture.UEShedFixtureTextAsset";
const STRING_TABLE_ID: &str = "/Game/Fixture/Text/ST_Game.ST_Game";
const TEXTURE2D_CLASS: &str = "/Script/Engine.Texture2D";

fn workspace_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

fn source_model() -> SourceModel {
    let path = workspace_path("fixtures/unreal-project/FixtureExpected/parser-source-model.json");
    let json = fs::read_to_string(path).expect("generated source model");
    serde_json::from_str(&json).expect("valid generated source model")
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

fn decoded_assets_with(
    path: &Path,
    schemas: &dyn SchemaProvider,
    source_only: bool,
) -> (Package, Vec<DecodedAsset>) {
    let bytes = fs::read(path).expect("fixture bytes");
    let package = Package::parse(&bytes).expect("fixture package parses");
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas,
    };
    let assets = package
        .exports
        .iter()
        .filter_map(|export| {
            if source_only {
                decode_modeled_export(export, &context).transpose()
            } else {
                decode_export(export, &context).transpose()
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .expect("fixture exports decode");
    (package, assets)
}

fn decoded_assets(path: &Path, model: &SourceModel) -> (Package, Vec<DecodedAsset>) {
    decoded_assets_with(path, model, true)
}

fn assert_stream_has_no_raw(stream: &PropertyStream, path: &str) {
    for property in &stream.records {
        assert_value_has_no_raw(&property.value, path);
    }
}

fn assert_value_has_no_raw(value: &PropertyValue, path: &str) {
    match value {
        PropertyValue::Array(values) | PropertyValue::Set(values) => {
            for value in values {
                assert_value_has_no_raw(value, path);
            }
        }
        PropertyValue::Map(entries) => {
            for entry in entries {
                assert_value_has_no_raw(&entry.key, path);
                assert_value_has_no_raw(&entry.value, path);
            }
        }
        PropertyValue::Struct(stream) => assert_stream_has_no_raw(stream, path),
        PropertyValue::Raw { reason } => panic!("{path} contains raw value: {reason:?}"),
        _ => {}
    }
}

fn assert_value_matches_schema(
    value: &PropertyValue,
    field_type: &FieldType,
    package: &Package,
    model: &SourceModel,
    path: &str,
) {
    let matches = matches!(
        (value, field_type),
        (PropertyValue::Bool(_), FieldType::Bool)
            | (
                PropertyValue::Int(_),
                FieldType::Int8 | FieldType::Int16 | FieldType::Int32 | FieldType::Int64
            )
            | (
                PropertyValue::UInt(_),
                FieldType::UInt8 | FieldType::UInt16 | FieldType::UInt32 | FieldType::UInt64
            )
            | (PropertyValue::Float(_), FieldType::Float)
            | (PropertyValue::Double(_), FieldType::Double)
            | (PropertyValue::Name(_), FieldType::Name)
            | (PropertyValue::String(_), FieldType::String)
            | (PropertyValue::Text(_), FieldType::Text)
            | (PropertyValue::Enum(_), FieldType::Enum { .. })
            | (
                PropertyValue::ObjectRef(_),
                FieldType::Class { .. } | FieldType::Object { .. }
            )
            | (
                PropertyValue::SoftObjectPath(_),
                FieldType::SoftObject { .. }
            )
    );
    if matches {
        return;
    }

    match (value, field_type) {
        (PropertyValue::Vector(_), FieldType::Struct { path: struct_path })
            if struct_path.as_str() == "/Script/CoreUObject.Vector" => {}
        (PropertyValue::IntPoint(_), FieldType::Struct { path: struct_path })
            if struct_path.as_str() == "/Script/CoreUObject.IntPoint" => {}
        (PropertyValue::DataTableRowHandle(_), FieldType::Struct { path: struct_path })
            if struct_path.as_str() == "/Script/Engine.DataTableRowHandle" => {}
        (PropertyValue::Struct(stream), FieldType::Struct { path: struct_path }) => {
            assert_stream_matches_schema(stream, struct_path, package, model, path);
        }
        (PropertyValue::Array(values), FieldType::Array { inner })
        | (PropertyValue::Set(values), FieldType::Set { inner }) => {
            for (index, value) in values.iter().enumerate() {
                assert_value_matches_schema(
                    value,
                    inner,
                    package,
                    model,
                    &format!("{path}[{index}]"),
                );
            }
        }
        (PropertyValue::Map(entries), FieldType::Map { key, value }) => {
            for (index, entry) in entries.iter().enumerate() {
                assert_value_matches_schema(
                    &entry.key,
                    key,
                    package,
                    model,
                    &format!("{path}{{{index}}}.key"),
                );
                assert_value_matches_schema(
                    &entry.value,
                    value,
                    package,
                    model,
                    &format!("{path}{{{index}}}.value"),
                );
            }
        }
        _ => panic!("{path} decoded as {value:?}, expected source type {field_type:?}"),
    }
}

fn assert_stream_matches_schema(
    stream: &PropertyStream,
    struct_path: &ObjectPath,
    package: &Package,
    model: &SourceModel,
    path: &str,
) {
    let schema = model
        .find_struct(struct_path)
        .unwrap_or_else(|| panic!("missing generated schema for {struct_path}"));
    for field in &schema.fields {
        let property = stream
            .records
            .iter()
            .find(|record| package.resolve_name_str(record.name) == Some(field.name.as_str()))
            .unwrap_or_else(|| panic!("{path} is missing generated field {}", field.name));
        assert_value_matches_schema(
            &property.value,
            &field.field_type,
            package,
            model,
            &format!("{path}.{}", field.name),
        );
    }
    for property in &stream.records {
        let name = package.resolve_name(property.name).expect("property name");
        assert!(
            schema.fields.iter().any(|field| field.name == name),
            "{path}.{name} is absent from generated schema {struct_path}"
        );
    }
}

#[test]
fn generated_model_fully_decodes_every_fixture_data_table() {
    let model = source_model();
    assert!(model.supports_schema_version());
    let authoring = workspace_path("fixtures/unreal-project/Content/Fixture/Authoring");
    let mut fixtures = fs::read_dir(authoring)
        .expect("authoring fixtures")
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("uasset")
                && path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(|stem| stem.starts_with("DT_") || stem.starts_with("CDT_"))
        })
        .collect::<Vec<_>>();
    fixtures.sort();
    assert_eq!(fixtures.len(), 12, "fixture inventory changed");

    let mut decoded_rows = 0;
    for fixture in fixtures {
        let fixture_name = fixture.file_name().expect("fixture name").to_string_lossy();
        let (package, assets) = decoded_assets(&fixture, &model);
        let tables = assets
            .iter()
            .filter_map(|asset| match asset {
                DecodedAsset::DataTable(table) => Some(table),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(tables.len(), 1, "{fixture_name} data-table exports");
        let table = tables[0];
        assert_stream_has_no_raw(&table.properties, &fixture_name);
        let row_struct = table
            .row_struct
            .as_ref()
            .unwrap_or_else(|| panic!("{fixture_name} has no row struct"));
        for row in &table.rows {
            let row_name = package.resolve_name(row.name).expect("row name");
            assert_stream_has_no_raw(&row.properties, &format!("{fixture_name}:{row_name}"));
            assert_stream_matches_schema(
                &row.properties,
                row_struct,
                &package,
                &model,
                &format!("{fixture_name}:{row_name}"),
            );
            decoded_rows += 1;
        }
    }

    assert_eq!(decoded_rows, 10_022);
}

#[test]
fn generated_and_legacy_data_table_semantics_are_identical() {
    let model = source_model();
    let legacy = EmptySchemas;
    let authoring = workspace_path("fixtures/unreal-project/Content/Fixture/Authoring");
    let mut fixtures = fs::read_dir(authoring)
        .expect("authoring fixtures")
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("uasset")
                && path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(|stem| stem.starts_with("DT_") || stem.starts_with("CDT_"))
        })
        .collect::<Vec<_>>();
    fixtures.sort();

    for fixture in fixtures {
        let fixture_name = fixture.file_name().expect("fixture name").to_string_lossy();
        let (_, generated) = decoded_assets(&fixture, &model);
        let (_, handwritten) = decoded_assets_with(&fixture, &legacy, false);
        let generated = generated
            .into_iter()
            .find_map(|asset| match asset {
                DecodedAsset::DataTable(table) => Some(table),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{fixture_name} generated DataTable"));
        let handwritten = handwritten
            .into_iter()
            .find_map(|asset| match asset {
                DecodedAsset::DataTable(table) => Some(table),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{fixture_name} handwritten DataTable"));
        assert_eq!(generated, handwritten, "{fixture_name} semantic parity");
    }
}

#[test]
fn generated_model_fully_decodes_fixture_data_asset() {
    let model = source_model();
    let fixture =
        workspace_path("fixtures/unreal-project/Content/Fixture/Text/DA_TextOccurrences.uasset");
    let (package, assets) = decoded_assets(&fixture, &model);
    let data_asset = assets
        .iter()
        .find_map(|asset| match asset {
            DecodedAsset::DataAsset(data_asset)
                if data_asset.class_path.as_str() == DATA_ASSET_CLASS =>
            {
                Some(data_asset)
            }
            _ => None,
        })
        .expect("generated inheritance classifies the native subclass as a DataAsset");
    assert_stream_has_no_raw(&data_asset.properties, "DA_TextOccurrences");

    let class_schema = model
        .find_class(&ObjectPath::new(DATA_ASSET_CLASS))
        .expect("generated data-asset class schema");
    assert_eq!(class_schema.fields.len(), 5);
    assert_eq!(data_asset.properties.records.len(), 5);
    for field in &class_schema.fields {
        let property = data_asset
            .properties
            .records
            .iter()
            .find(|record| package.resolve_name_str(record.name) == Some(field.name.as_str()))
            .unwrap_or_else(|| panic!("missing generated DA field {}", field.name));
        assert_value_matches_schema(
            &property.value,
            &field.field_type,
            &package,
            &model,
            &format!("DA_TextOccurrences.{}", field.name),
        );
    }

    let string_table_reference = data_asset
        .properties
        .records
        .iter()
        .find(|record| package.resolve_name_str(record.name) == Some("StringTableReference"))
        .expect("string-table property");
    assert!(matches!(
        &string_table_reference.value,
        PropertyValue::Text(text)
            if matches!(
                &text.history,
                TextHistory::StringTableEntry { table_id, key }
                    if table_id == STRING_TABLE_ID && key == "PromptContinue"
            )
    ));
}

#[test]
fn generated_data_asset_preserves_the_legacy_uobject_semantics() {
    let model = source_model();
    let fixture =
        workspace_path("fixtures/unreal-project/Content/Fixture/Text/DA_TextOccurrences.uasset");
    let (_, generated) = decoded_assets(&fixture, &model);
    let (_, handwritten) = decoded_assets_with(&fixture, &EmptySchemas, false);

    let generated = generated
        .into_iter()
        .find_map(|asset| match asset {
            DecodedAsset::DataAsset(asset) if asset.class_path.as_str() == DATA_ASSET_CLASS => {
                Some(asset)
            }
            _ => None,
        })
        .expect("source-derived DataAsset");
    let handwritten = handwritten
        .into_iter()
        .find_map(|asset| match asset {
            DecodedAsset::UObject(asset) if asset.class_path.as_str() == DATA_ASSET_CLASS => {
                Some(asset)
            }
            _ => None,
        })
        .expect("legacy generic UObject fallback");

    assert_eq!(generated.object_path, handwritten.object_path);
    assert_eq!(generated.class_path, handwritten.class_path);
    assert_eq!(generated.object_guid, handwritten.object_guid);
    assert_eq!(generated.properties, handwritten.properties);
    assert_eq!(handwritten.tail.len(), 0);
}

#[test]
fn generated_and_legacy_string_table_semantics_are_identical() {
    let model = source_model();
    let fixture = workspace_path("fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset");
    let (_, generated) = decoded_assets(&fixture, &model);
    let (_, handwritten) = decoded_assets_with(&fixture, &EmptySchemas, false);

    let generated = generated
        .into_iter()
        .find_map(|asset| match asset {
            DecodedAsset::StringTable(table) => Some(table),
            _ => None,
        })
        .expect("source-derived StringTable");
    let handwritten = handwritten
        .into_iter()
        .find_map(|asset| match asset {
            DecodedAsset::StringTable(table) => Some(table),
            _ => None,
        })
        .expect("handwritten StringTable");

    assert_eq!(generated, handwritten);
    assert_eq!(generated.namespace, "Fixture.StringTable");
    assert_eq!(generated.entries.len(), 3);
}

#[test]
fn generated_and_legacy_generic_texture_semantics_are_identical() {
    let model = source_model();
    let legacy = EmptySchemas;
    let textures = workspace_path("fixtures/unreal-project/Content/Fixture/Audits/Textures");
    let mut fixtures = fs::read_dir(textures)
        .expect("texture fixture directory")
        .map(|entry| entry.expect("texture fixture entry").path())
        .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("uasset"))
        .collect::<Vec<_>>();
    fixtures.sort();
    assert_eq!(fixtures.len(), 17, "texture fixture inventory changed");

    for fixture in fixtures {
        let fixture_name = fixture.file_name().expect("fixture name").to_string_lossy();
        let (_, generated) = decoded_assets(&fixture, &model);
        let (_, handwritten) = decoded_assets_with(&fixture, &legacy, false);
        let generated = generated
            .into_iter()
            .find_map(|asset| match asset {
                DecodedAsset::UObject(object) if object.class_path.as_str() == TEXTURE2D_CLASS => {
                    Some(object)
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("{fixture_name} source-modeled Texture2D"));
        let handwritten = handwritten
            .into_iter()
            .find_map(|asset| match asset {
                DecodedAsset::UObject(object) if object.class_path.as_str() == TEXTURE2D_CLASS => {
                    Some(object)
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("{fixture_name} handwritten Texture2D"));

        assert_eq!(generated, handwritten, "{fixture_name} semantic parity");
        assert!(
            !generated.tail.is_empty(),
            "{fixture_name} native tail evidence"
        );
    }
}
