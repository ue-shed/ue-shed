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

/// A custom `SchemaProvider` that switches class schemas mid-session must not receive stale
/// cached dispatch or serialization-validation answers from earlier exports.
#[test]
fn warmed_session_observes_switching_schema_provider() -> Result<(), Box<dyn Error>> {
    use std::cell::Cell;
    use uasset_parser::native::NativeLayout;
    use uasset_parser::package::ObjectPath;
    use uasset_parser::schema::{
        ClassSchema, SchemaProvider, SerializationOperation, SourceModel, StructSchema,
    };

    struct SwitchingSchemas {
        use_alternate: Cell<bool>,
        primary: SourceModel,
        alternate: SourceModel,
    }
    impl SwitchingSchemas {
        fn current(&self) -> &SourceModel {
            if self.use_alternate.get() {
                &self.alternate
            } else {
                &self.primary
            }
        }
    }
    impl SchemaProvider for SwitchingSchemas {
        fn find_struct(&self, path: &ObjectPath) -> Option<&StructSchema> {
            self.current().find_struct(path)
        }
        fn find_class(&self, path: &ObjectPath) -> Option<&ClassSchema> {
            self.current().find_class(path)
        }
        fn native_layout(&self, cpp_name: &str) -> Option<&NativeLayout> {
            self.current().native_layout(cpp_name)
        }
    }

    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap");
    let bytes = fs::read(path)?;
    let package = Package::parse(&bytes)?;
    let primary = embedded_source_model().clone();
    let mut alternate = embedded_source_model().clone();
    let scene_component = alternate
        .classes
        .iter_mut()
        .find(|schema| schema.path.as_str() == "/Script/Engine.SceneComponent")
        .expect("SceneComponent schema in embedded model");
    scene_component.serialization = vec![SerializationOperation::StringTableData];
    let schemas = SwitchingSchemas {
        use_alternate: Cell::new(false),
        primary,
        alternate,
    };
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: &schemas,
        property_filter: None,
    };
    let mut session = AssetDecodeSession::new(&context);
    let scene_exports: Vec<_> = package
        .exports
        .iter()
        .filter(|export| {
            export
                .class_path
                .as_ref()
                .is_some_and(|class| class.as_str() == "/Script/Engine.SceneComponent")
        })
        .collect();
    assert!(!scene_exports.is_empty());
    // Warm the session with the valid embedded schema.
    for export in &scene_exports {
        assert_eq!(
            session.decode(export)?,
            decode_export(export, &context)?,
            "warmed decode mismatch for {}",
            export.object_path
        );
    }
    // Flip the provider to the unsupported SceneComponent serialization plan and verify the
    // warmed session rejects it identically to stateless `decode_export`.
    schemas.use_alternate.set(true);
    for export in &scene_exports {
        let expected = decode_export(export, &context);
        let actual = session.decode(export);
        assert!(
            expected.is_err(),
            "stateless decode must reject unsupported plan"
        );
        assert_eq!(
            format!("{actual:?}"),
            format!("{expected:?}"),
            "warmed session diverged after schema switch for {}",
            export.object_path
        );
    }
    Ok(())
}

/// Changing `omit_unrequested_records()` between exports on a warmed session must take effect
/// immediately even on replayed streams whose `decode` predicate depends only on record headers.
#[test]
fn warmed_session_respects_changing_omit_unrequested_permission() -> Result<(), Box<dyn Error>> {
    use std::sync::atomic::{AtomicBool, Ordering};

    struct ToggleOmitFilter {
        omit: AtomicBool,
    }
    impl PropertyDecodeFilter for ToggleOmitFilter {
        fn decode(&self, package: &Package, record: &PropertyRecord) -> bool {
            !matches!(
                package.resolve_name_str(record.type_name.name),
                Some("BoolProperty" | "FloatProperty" | "ObjectProperty" | "StructProperty")
            )
        }
        fn depends_only_on_record_header(&self) -> bool {
            true
        }
        fn omit_unrequested_records(&self) -> bool {
            self.omit.load(Ordering::Relaxed)
        }
    }

    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap");
    let bytes = fs::read(path)?;
    let package = Package::parse(&bytes)?;
    let filter = ToggleOmitFilter {
        omit: AtomicBool::new(true),
    };
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: embedded_source_model(),
        property_filter: Some(&filter),
    };
    let mut session = AssetDecodeSession::new(&context);
    // Warm every class replay with omission enabled.
    for export in &package.exports {
        assert_eq!(
            session.decode(export)?,
            decode_export(export, &context)?,
            "omit=true mismatch for {}",
            export.object_path
        );
    }
    // Disable omission and decode again on the warmed session; declined records must be retained
    // as `NotRequested`, matching stateless `decode_export`.
    filter.omit.store(false, Ordering::Relaxed);
    for export in &package.exports {
        assert_eq!(
            session.decode(export)?,
            decode_export(export, &context)?,
            "omit=false mismatch for {}",
            export.object_path
        );
    }
    Ok(())
}
