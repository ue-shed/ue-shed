//! A package session must preserve the ordinary decoder's complete, owned model.
use std::fs;
use std::path::Path;

use uasset_parser::Package;
use uasset_parser::asset::{AssetDecodeContext, AssetDecodeSession, decode_export};
use uasset_parser::schema::embedded_source_model;

#[test]
fn level_session_matches_individual_exports_in_both_orders() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap");
    let bytes = fs::read(path).unwrap();
    let package = Package::parse(&bytes).unwrap();
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: embedded_source_model(),
        property_filter: None,
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
}
