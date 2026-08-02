use std::fs;

use uasset_inspection::projection::{project_text_asset, project_texture_asset};
use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
use uasset_parser::package::Package;
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};

struct EmptySchemas;

impl SchemaProvider for EmptySchemas {
    fn find_struct(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&StructSchema> {
        None
    }

    fn find_class(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&ClassSchema> {
        None
    }
}

fn decoded_assets(path: &str) -> (Vec<u8>, Package, Vec<DecodedAsset>) {
    let bytes = fs::read(path).expect("fixture package");
    let package = Package::parse(&bytes).expect("fixture parses");
    let schemas = EmptySchemas;
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: &schemas,
    };
    let assets = package
        .exports
        .iter()
        .filter_map(|export| decode_export(export, &context).ok().flatten())
        .collect();
    (bytes, package, assets)
}

#[test]
fn text_projection_is_available_from_the_library_boundary() {
    let (_, package, assets) = decoded_assets(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/unreal-project/Content/Fixture/Text/DA_TextOccurrences.uasset"
    ));
    let projection = assets
        .iter()
        .find_map(|asset| match asset {
            DecodedAsset::DataAsset(_) | DecodedAsset::UObject(_) => {
                Some(project_text_asset(&package, asset))
            }
            _ => None,
        })
        .expect("text fixture has a projectable asset");
    assert!(!projection.occurrences.is_empty());
}

#[test]
fn texture_projection_reports_serialized_evidence() {
    let (_, package, assets) = decoded_assets(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_World_512x256.uasset"
    ));
    let record = assets.iter().find_map(|asset| match asset {
        DecodedAsset::UObject(_) => project_texture_asset(&package, asset, 1),
        _ => None,
    });
    assert!(
        record.is_some(),
        "texture fixture has a projectable Texture2D"
    );
}
