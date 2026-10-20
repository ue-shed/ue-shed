#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "fixture assertions"
)]

use std::{fs, path::Path};

use serde::Deserialize;
use uasset_inspection::projection::{TextIdentity, TextLocation, project_text_asset};
use uasset_parser::Package;
use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};

#[path = "support/custom_graph.rs"]
mod support;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    operation: String,
    object_path: String,
    property_path: String,
    namespace: String,
    key: String,
    source: String,
    pin_id: String,
    pin_index: usize,
}

#[test]
fn saved_repaired_pins_match_fresh_unreal_reload_on_all_four_engines() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/graph-pin-text");
    for engine in ["4.27", "5.6", "5.7", "5.8"] {
        let fixture = root.join(engine);
        let bytes = fs::read(fixture.join("BP_Keys.uasset")).unwrap();
        let expected: Vec<Expected> =
            serde_json::from_slice(&fs::read(fixture.join("expected.json")).unwrap()).unwrap();
        assert_eq!(expected.len(), 3);
        let package = Package::parse(&bytes).unwrap();
        let context = AssetDecodeContext {
            source: &bytes,
            package: &package,
            schemas: uasset_parser::schema::embedded_source_model(),
        };
        let nodes: Vec<_> = package
            .exports
            .iter()
            .filter_map(|export| match decode_export(export, &context) {
                Ok(Some(DecodedAsset::BlueprintGraphNode(node))) => Some(node),
                Err(error)
                    if export.class_path.as_ref().is_some_and(|class| {
                        uasset_parser::asset::is_blueprint_graph_node_class(class.as_str())
                    }) =>
                {
                    panic!("UE {engine} {}: {error:?}", export.object_path)
                }
                _ => None,
            })
            .collect();
        for pin in expected {
            let node = nodes
                .iter()
                .find(|node| {
                    pin.object_path
                        .replace(':', ".")
                        .ends_with(node.object_path.as_str())
                })
                .unwrap_or_else(|| {
                    panic!(
                        "UE {engine}: missing {}, decoded {:?}",
                        pin.object_path,
                        nodes
                            .iter()
                            .map(|node| &node.object_path)
                            .collect::<Vec<_>>()
                    )
                });
            assert_eq!(pin.property_path, "DefaultTextValue");
            assert_eq!(
                node.pins[pin.pin_index]
                    .as_ref()
                    .unwrap()
                    .id
                    .to_string()
                    .replace('-', "")
                    .to_uppercase(),
                pin.pin_id
            );
            let projection =
                project_text_asset(&package, &DecodedAsset::BlueprintGraphNode(node.clone()));
            assert!(projection.coverage_gaps.is_empty());
            let occurrence = projection.occurrences.iter().find(|text|
                matches!(&text.location, TextLocation::AssetProperty { object_path, property_path, .. }
                    if object_path == node.object_path.as_str()
                    && property_path == &format!("Pins[{}].DefaultTextValue", pin.pin_index))
            ).unwrap_or_else(|| panic!("UE {engine}: missing {} pin", pin.operation));
            assert_eq!(
                occurrence.source, pin.source,
                "UE {engine}: {}",
                pin.operation
            );
            let TextIdentity::Resolved { namespace, key } = &occurrence.identity else {
                panic!("UE {engine}: unresolved pin");
            };
            assert_eq!(
                uasset_parser::gatherable_text::strip_package_namespace(namespace),
                pin.namespace
            );
            assert_eq!(key, &pin.key);
        }
    }
}

#[test]
fn unknown_graph_revision_has_a_named_pin_coverage_gap() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/graph-pin-text/5.7/BP_Keys.uasset");
    let bytes = fs::read(path).unwrap();
    let mut package = Package::parse(&bytes).unwrap();
    package.summary.versions.ue5 = 1016;
    let export = package
        .exports
        .iter()
        .find(|export| export.object_path.as_str().ends_with("EventGraph.split"))
        .unwrap();
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let error = decode_export(export, &context).unwrap_err();
    let gap = uasset_inspection::projection::text_feature_version_gap(&context, export, &error)
        .expect("unsupported pins must be visible");
    assert_eq!(gap.object_path, export.object_path.as_str());
    assert_eq!(gap.property_path, "Pins");
    assert_eq!(
        gap.reason,
        uasset_inspection::projection::TextCoverageGapReason::FeatureUnavailableForEngineVersion
    );
}

#[test]
fn graph_owned_plugin_nodes_do_not_fall_back_to_an_opaque_uobject() {
    let (bytes, package) = support::custom_graph_fixture("decoded");
    let index = package
        .exports
        .iter()
        .position(|export| export.object_path.as_str().ends_with("EventGraph.split"))
        .unwrap();
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let asset = decode_export(&package.exports[index], &context)
        .unwrap()
        .unwrap();
    assert!(matches!(asset, DecodedAsset::BlueprintGraphNode(_)));
    assert!(
        project_text_asset(&package, &asset)
            .occurrences
            .iter()
            .any(|text| text.source == "Reviewed split source")
    );
    let DecodedAsset::BlueprintGraphNode(mut node) = asset else {
        unreachable!()
    };
    // A subclass's unmodeled native data must not disappear behind the decoded base pins.
    node.tail = uasset_parser::archive::Span::new(0, 1).unwrap();
    let projection = project_text_asset(&package, &DecodedAsset::BlueprintGraphNode(node));
    assert!(
        projection
            .coverage_gaps
            .iter()
            .any(|gap| gap.is_graph_pin_gap())
    );
}

#[test]
fn custom_graph_membership_failures_keep_named_pin_gaps() {
    for damage in ["decoded", "rejected", "unreadable"] {
        let (bytes, package) = support::custom_graph_fixture(damage);
        let context = AssetDecodeContext {
            source: &bytes,
            package: &package,
            schemas: uasset_parser::schema::embedded_source_model(),
        };
        let mut gaps = Vec::new();
        for export in &package.exports {
            match decode_export(export, &context) {
                Ok(Some(asset)) => gaps.extend(project_text_asset(&package, &asset).coverage_gaps),
                Err(error) => gaps.extend(uasset_inspection::projection::text_feature_version_gap(
                    &context, export, &error,
                )),
                Ok(None) => {}
            }
        }
        assert_eq!(
            gaps.iter().any(|gap| gap.property_path == "Pins"),
            damage != "decoded",
            "{damage}: {gaps:?}"
        );
    }
}
