//! A package session must preserve the ordinary decoder's complete, owned model.
use std::error::Error;
use std::fs;
use std::path::Path;

use uasset_parser::Package;
use uasset_parser::asset::{
    AssetDecodeContext, AssetDecodeSession, PropertyDecodeFilter, decode_export,
};
use uasset_parser::property::PropertyRecord;
use uasset_parser::schema::embedded_source_model;

#[test]
fn saved_sessions_preserve_rich_values_and_filters_in_both_orders() -> Result<(), Box<dyn Error>> {
    struct SkipSelected;
    impl PropertyDecodeFilter for SkipSelected {
        fn decode(&self, package: &Package, record: &PropertyRecord) -> bool {
            !matches!(
                package.resolve_name_str(record.name),
                Some("OptionalText" | "LandscapeLayers" | "Constraint")
            )
        }
    }
    for relative in [
        "fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap",
        "fixtures/parser-coverage/5.7/DA_CoverageBatch.uasset",
    ] {
        compare(relative, None)?;
        compare(relative, Some(&SkipSelected))?;
    }
    Ok(())
}

fn compare(
    relative: &str,
    filter: Option<&dyn PropertyDecodeFilter>,
) -> Result<(), Box<dyn Error>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative);
    let bytes = fs::read(path)?;
    let package = Package::parse(&bytes)?;
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: embedded_source_model(),
        property_filter: filter,
    };
    let mut session = AssetDecodeSession::new(&context);
    for export in package.exports.iter().chain(package.exports.iter().rev()) {
        let expected = decode_export(export, &context);
        let actual = session.decode(export);
        match (actual, expected) {
            (Ok(actual), Ok(expected)) => assert_eq!(actual, expected, "{}", export.object_path),
            (Err(actual), Err(expected)) => {
                assert_eq!(format!("{actual:?}"), format!("{expected:?}"))
            }
            (actual, expected) => panic!(
                "{}: session={actual:?}, ordinary={expected:?}",
                export.object_path
            ),
        }
    }
    Ok(())
}
