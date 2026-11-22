#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "fixture tests fail loudly on missing or changed saved packages"
)]

use std::fs;
use std::path::{Path, PathBuf};

use uasset_inspection::blueprint_classes::blueprint_classes;
use uasset_inspection::projection::{TextDecodeFilter, project_text_asset};
use uasset_parser::Package;
use uasset_parser::asset::{
    AssetDecodeContext, AssetDecodeSession, DecodedAsset, PropertyDecodeFilter, decode_export,
};
use uasset_parser::property::PropertyRecord;
use uasset_parser::schema::embedded_source_model;

fn fixture_packages(directory: &Path, packages: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("fixture directory") {
        let entry = entry.expect("fixture entry");
        let path = entry.path();
        if entry.file_type().expect("fixture file type").is_dir() {
            fixture_packages(&path, packages);
        } else if matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("uasset" | "umap")
        ) {
            packages.push(path);
        }
    }
}

#[test]
fn text_filter_preserves_every_fixture_export_text_and_blueprint_classes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut paths = Vec::new();
    fixture_packages(&root, &mut paths);
    paths.sort();
    assert!(!paths.is_empty(), "repository fixtures must be present");
    let mut recovered_exports = 0;
    let mut compared_exports = 0;
    for path in &paths {
        let bytes = fs::read(path).expect("fixture bytes");
        // Separate packages also exercise graph-membership memoization independently.
        let package =
            Package::parse(&bytes).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let filtered_package = Package::parse(&bytes).expect("same fixture parses");
        let context = AssetDecodeContext {
            source: &bytes,
            package: &package,
            schemas: embedded_source_model(),
            property_filter: None,
        };
        let filtered_context = AssetDecodeContext {
            package: &filtered_package,
            property_filter: Some(&TextDecodeFilter),
            ..context
        };
        for (export, filtered_export) in package.exports.iter().zip(&filtered_package.exports) {
            let unfiltered = decode_export(export, &context);
            let filtered = decode_export(filtered_export, &filtered_context);
            let label = format!("{}: {}", path.display(), export.object_path);
            match (unfiltered, filtered) {
                (Ok(Some(asset)), Ok(Some(filtered_asset))) => {
                    compared_exports += 1;
                    let original = project_text_asset(&package, &asset);
                    let filtered = project_text_asset(&filtered_package, &filtered_asset);
                    assert_eq!(
                        original.occurrences, filtered.occurrences,
                        "{label}: occurrences"
                    );
                    assert_eq!(
                        blueprint_classes(&package, &asset),
                        blueprint_classes(&filtered_package, &filtered_asset),
                        "{label}: Blueprint classes"
                    );
                    assert_eq!(
                        original
                            .coverage_gaps
                            .iter()
                            .filter(|gap| gap.may_contain_text)
                            .collect::<Vec<_>>(),
                        filtered
                            .coverage_gaps
                            .iter()
                            .filter(|gap| gap.may_contain_text)
                            .collect::<Vec<_>>(),
                        "{label}: text-capable coverage gaps"
                    );
                    // Decoder-owned reads and native tails may retain text-free
                    // gaps. Only text-free gaps may disappear, and none may be introduced.
                    for gap in filtered
                        .coverage_gaps
                        .iter()
                        .filter(|gap| !gap.may_contain_text)
                    {
                        assert!(
                            original.coverage_gaps.contains(gap),
                            "{label}: new text-free gap {gap:?}"
                        );
                    }
                    let retained: Vec<_> = original
                        .coverage_gaps
                        .iter()
                        .filter(|gap| gap.may_contain_text || filtered.coverage_gaps.contains(gap))
                        .collect();
                    assert_eq!(
                        retained,
                        filtered.coverage_gaps.iter().collect::<Vec<_>>(),
                        "{label}: retained coverage gap order"
                    );
                }
                (Ok(None), Ok(None)) => {}
                (Err(_), Ok(Some(_))) => recovered_exports += 1,
                (Err(original), Err(filtered)) => {
                    assert_eq!(
                        (original.kind(), original.message()),
                        (filtered.kind(), filtered.message()),
                        "{label}: decode failure"
                    )
                }
                (original, filtered) => {
                    panic!("{label}: unexpected decode change: {original:?} -> {filtered:?}")
                }
            }
        }
    }
    println!(
        "Text decode filter: {} fixture packages, {compared_exports} compared exports, {recovered_exports} exports failed unfiltered but succeeded filtered",
        paths.len()
    );
}

/// The text filter's decisions, keeping every declined record as `NotRequested`.
struct CompleteTextFilter;

impl PropertyDecodeFilter for CompleteTextFilter {
    fn decode(&self, package: &Package, record: &PropertyRecord) -> bool {
        TextDecodeFilter.decode(package, record)
    }

    fn depends_only_on_record_header(&self) -> bool {
        TextDecodeFilter.depends_only_on_record_header()
    }
}

/// Omitting declined records must not change any text projection fact: occurrences, every
/// coverage gap in order, Blueprint classes and decode failures, statelessly and in sessions.
#[test]
fn omitting_declined_records_preserves_text_projection_exactly() {
    assert!(TextDecodeFilter.omit_unrequested_records());
    assert!(!CompleteTextFilter.omit_unrequested_records());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut paths = Vec::new();
    fixture_packages(&root, &mut paths);
    paths.sort();
    let mut compared = 0;
    for path in &paths {
        let bytes = fs::read(path).expect("fixture bytes");
        let package =
            Package::parse(&bytes).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let complete = AssetDecodeContext {
            source: &bytes,
            package: &package,
            schemas: embedded_source_model(),
            property_filter: Some(&CompleteTextFilter),
        };
        let omitting = AssetDecodeContext {
            property_filter: Some(&TextDecodeFilter),
            ..complete
        };
        let mut complete_session = AssetDecodeSession::new(&complete);
        let mut omitting_session = AssetDecodeSession::new(&omitting);
        for export in &package.exports {
            let label = format!("{}: {}", path.display(), export.object_path);
            let expected = decode_export(export, &complete);
            for actual in [
                decode_export(export, &omitting),
                omitting_session.decode(export),
            ] {
                match (&expected, actual) {
                    (Ok(Some(expected)), Ok(Some(actual))) => {
                        assert_eq!(
                            project_text_asset(&package, &actual),
                            project_text_asset(&package, expected),
                            "{label}: projection"
                        );
                        assert_eq!(
                            blueprint_classes(&package, &actual),
                            blueprint_classes(&package, expected),
                            "{label}: Blueprint classes"
                        );
                        compared += 1;
                    }
                    (Ok(None), Ok(None)) => {}
                    (Err(expected), Err(actual)) => assert_eq!(
                        format!("{actual:?}"),
                        format!("{expected:?}"),
                        "{label}: decode failure"
                    ),
                    (expected, actual) => {
                        panic!("{label}: omission changed the decode: {expected:?} -> {actual:?}")
                    }
                }
            }
            // The complete filter in a session matches its stateless decode too.
            let session = complete_session.decode(export);
            assert_eq!(
                format!("{session:?}"),
                format!("{expected:?}"),
                "{label}: session"
            );
        }
    }
    assert!(compared > 0);
}

/// The text filter's decisions and omission, building every tag and every pin field.
struct BuildingTextFilter;

impl PropertyDecodeFilter for BuildingTextFilter {
    fn decode(&self, package: &Package, record: &PropertyRecord) -> bool {
        TextDecodeFilter.decode(package, record)
    }

    fn depends_only_on_record_header(&self) -> bool {
        TextDecodeFilter.depends_only_on_record_header()
    }

    fn omit_unrequested_records(&self) -> bool {
        TextDecodeFilter.omit_unrequested_records()
    }
}

/// `asset` as a text-only pin decode leaves it: pin strings and reference arrays empty.
fn without_non_text_pin_fields(mut asset: DecodedAsset) -> DecodedAsset {
    if let DecodedAsset::BlueprintGraphNode(node) = &mut asset {
        for pin in node.pins.iter_mut().flatten() {
            pin.tooltip.clear();
            pin.default_value.clear();
            pin.autogenerated_default_value.clear();
            pin.linked_to.clear();
            pin.sub_pins.clear();
        }
        for pin in &mut node.user_defined_pins {
            pin.default_value.clear();
        }
    }
    asset
}

/// Stepping over tags the filter can never request, and over non-text pin fields, leaves
/// every decoded asset and failure exactly as building them would, statelessly and in sessions
/// (whose replays learn the skipped tags).
#[test]
fn skipping_unrequested_tags_and_pin_fields_preserves_decoded_assets_exactly() {
    assert!(!BuildingTextFilter.omit_non_text_pin_fields());
    assert!(TextDecodeFilter.omit_non_text_pin_fields());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut paths = Vec::new();
    fixture_packages(&root, &mut paths);
    paths.sort();
    let (mut compared, mut graph_nodes) = (0, 0);
    for path in &paths {
        let bytes = fs::read(path).expect("fixture bytes");
        let package =
            Package::parse(&bytes).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let building = AssetDecodeContext {
            source: &bytes,
            package: &package,
            schemas: embedded_source_model(),
            property_filter: Some(&BuildingTextFilter),
        };
        let skipping = AssetDecodeContext {
            property_filter: Some(&TextDecodeFilter),
            ..building
        };
        let mut building_session = AssetDecodeSession::new(&building);
        let mut skipping_session = AssetDecodeSession::new(&skipping);
        for export in &package.exports {
            let label = format!("{}: {}", path.display(), export.object_path);
            let expected = decode_export(export, &building).map(|asset| {
                if matches!(asset, Some(DecodedAsset::BlueprintGraphNode(_))) {
                    graph_nodes += 1;
                }
                asset.map(without_non_text_pin_fields)
            });
            let expected_session = building_session
                .decode(export)
                .map(|asset| asset.map(without_non_text_pin_fields));
            assert_eq!(
                format!("{expected_session:?}"),
                format!("{expected:?}"),
                "{label}: building session"
            );
            for actual in [
                decode_export(export, &skipping),
                skipping_session.decode(export),
            ] {
                assert_eq!(format!("{actual:?}"), format!("{expected:?}"), "{label}");
            }
            compared += 1;
        }
    }
    assert!(compared > 0);
    assert!(graph_nodes > 0, "fixtures must exercise graph pins");
}
