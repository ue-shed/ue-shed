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
    // The same decisions by header alone, declared so: sessions may settle them once per layout.
    struct SkipSelectedByHeader;
    impl PropertyDecodeFilter for SkipSelectedByHeader {
        fn decode(&self, package: &Package, record: &PropertyRecord) -> bool {
            SkipSelected.decode(package, record)
                && !matches!(
                    package.resolve_name_str(record.type_name.name),
                    Some("BoolProperty" | "FloatProperty" | "ObjectProperty")
                )
        }

        fn depends_only_on_record_header(&self) -> bool {
            true
        }
    }
    for relative in [
        "fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap",
        "fixtures/unreal-project/Content/Fixture/Scenarios/L_MovementGym.umap",
        "fixtures/parser-coverage/5.7/DA_CoverageBatch.uasset",
    ] {
        compare(relative, None)?;
        compare(relative, Some(&SkipSelected))?;
        compare(relative, Some(&SkipSelectedByHeader))?;
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

fn fixture_packages(
    directory: &Path,
    packages: &mut Vec<std::path::PathBuf>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            fixture_packages(&path, packages)?;
        } else if matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("uasset" | "umap")
        ) {
            packages.push(path);
        }
    }
    Ok(())
}

/// Declines text-free scalars by header and lets the parser omit them.
struct OmitScalars {
    header_only: bool,
}

impl PropertyDecodeFilter for OmitScalars {
    fn decode(&self, package: &Package, record: &PropertyRecord) -> bool {
        !matches!(
            package.resolve_name_str(record.type_name.name),
            Some(
                "BoolProperty"
                    | "FloatProperty"
                    | "DoubleProperty"
                    | "IntProperty"
                    | "ObjectProperty"
                    | "NameProperty"
                    | "ByteProperty"
                    | "EnumProperty"
                    | "StructProperty"
            )
        )
    }

    fn depends_only_on_record_header(&self) -> bool {
        self.header_only
    }

    fn omit_unrequested_records(&self) -> bool {
        true
    }
}

/// Session class facts, summary flags, decoder-name tables and container replays must reach
/// exactly what the stateless decoder does for every fixture export, with and without
/// filters and omission, with the embedded model and an equal custom one.
#[test]
fn sessions_match_stateless_decoding_for_every_fixture() -> Result<(), Box<dyn Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut paths = Vec::new();
    fixture_packages(&root, &mut paths)?;
    paths.sort();
    assert!(!paths.is_empty(), "repository fixtures must be present");
    // A custom provider is not the embedded model, so it takes the unindexed schema paths.
    let custom_model = embedded_source_model().clone();
    let filters: [Option<&dyn PropertyDecodeFilter>; 3] = [
        None,
        Some(&OmitScalars { header_only: true }),
        Some(&OmitScalars { header_only: false }),
    ];
    let mut compared = 0_usize;
    for path in &paths {
        let bytes = fs::read(path)?;
        let Ok(package) = Package::parse(&bytes) else {
            continue;
        };
        for (index, filter) in filters.iter().enumerate() {
            let context = AssetDecodeContext {
                source: &bytes,
                package: &package,
                schemas: if index == 2 {
                    &custom_model
                } else {
                    embedded_source_model()
                },
                property_filter: *filter,
            };
            let mut session = AssetDecodeSession::new(&context);
            for export in &package.exports {
                let expected = decode_export(export, &context);
                let actual = session.decode(export);
                let label = format!("{}: {} ({index})", path.display(), export.object_path);
                match (actual, expected) {
                    (Ok(actual), Ok(expected)) => assert_eq!(actual, expected, "{label}"),
                    (Err(actual), Err(expected)) => {
                        assert_eq!(format!("{actual:?}"), format!("{expected:?}"), "{label}")
                    }
                    (actual, expected) => {
                        panic!("{label}: session={actual:?}, ordinary={expected:?}")
                    }
                }
                compared += 1;
            }
        }
    }
    assert!(compared > 1000, "{compared}");
    Ok(())
}
