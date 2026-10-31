//! Compact error storage preserves diagnostics and public error-chain types.
use std::error::Error;

use uasset_parser::Reader;
use uasset_parser::archive::ArchiveError;
use uasset_parser::asset::AssetError;
use uasset_parser::package::PackageError;
use uasset_parser::property::PropertyError;

const ARCHIVE_DISPLAY: &str =
    "OutOfBounds at byte 0 while reading Value: requested 4 bytes with only 0 remaining";
const ARCHIVE_DEBUG: &str = concat!(
    "ArchiveError { kind: OutOfBounds, offset: 0, path: \"Value\", ",
    "detail: \"requested 4 bytes with only 0 remaining\" }"
);

fn archive_error() -> ArchiveError {
    match Reader::new(&[]).read_u32("Value") {
        Err(error) => error,
        Ok(_) => panic!("an empty reader cannot contain a u32"),
    }
}

#[test]
fn error_storage_preserves_the_established_debug_and_display_shapes() {
    let archive = archive_error();
    assert_eq!(archive.to_string(), ARCHIVE_DISPLAY);
    assert_eq!(format!("{archive:?}"), ARCHIVE_DEBUG);
    assert_eq!(archive, archive.clone());

    let package = PackageError::from(archive_error());
    assert_eq!(
        format!("{package:?}"),
        format!(
            concat!(
                "PackageError {{ kind: MalformedData, offset: Some(0), path: \"Value\", ",
                "detail: \"requested 4 bytes with only 0 remaining\", source: Some({}) }}"
            ),
            ARCHIVE_DEBUG
        )
    );
    let property = PropertyError::from(archive_error());
    assert_eq!(
        format!("{property:?}"),
        format!(
            concat!(
                "PropertyError {{ kind: MalformedData, offset: Some(0), path: \"Value\", ",
                "detail: \"requested 4 bytes with only 0 remaining\", source: Some({}), ",
                "raw_reason: None }}"
            ),
            ARCHIVE_DEBUG
        )
    );
    let asset = AssetError::from(archive_error());
    assert_eq!(
        format!("{asset:?}"),
        format!(
            concat!(
                "AssetError {{ kind: MalformedData, message: {:?}, offset: Some(0), ",
                "field: Some(\"Value\"), source: Some({}) }}"
            ),
            ARCHIVE_DISPLAY, ARCHIVE_DEBUG
        )
    );
}

#[test]
fn error_sources_retain_the_public_types_and_original_context() {
    let asset = AssetError::from(PropertyError::from(archive_error()));
    let property = asset
        .source()
        .unwrap()
        .downcast_ref::<PropertyError>()
        .unwrap();
    let archive = property
        .source()
        .unwrap()
        .downcast_ref::<ArchiveError>()
        .unwrap();
    assert_eq!(archive.to_string(), ARCHIVE_DISPLAY);
    assert_eq!(property.path(), "Value");
    assert_eq!(asset.field(), Some("Value"));
    assert_eq!(asset.offset(), Some(0));

    let package = PackageError::from(archive_error());
    assert_eq!(
        package
            .source()
            .unwrap()
            .downcast_ref::<ArchiveError>()
            .unwrap(),
        &archive_error()
    );
}
