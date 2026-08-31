use std::fs;

use uasset_inspection::blueprint::{
    BlueprintGraphProjection, BlueprintNodeKind, project_blueprint_graphs,
};
use uasset_inspection::level_sequence::{
    SequenceReferenceKind, SequenceReferenceScope, SequenceTrackContent, project_level_sequence,
};
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

#[test]
fn level_sequence_projection_joins_timed_localized_text() {
    let (_, package, assets) = decoded_assets(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/unreal-project/Content/Fixture/Sequences/LS_TextTimeline.uasset"
    ));
    let projection = project_level_sequence(&package, &assets).expect("LevelSequence projection");

    assert_eq!(projection.schema_version, 3);
    assert_eq!(
        projection.tick_resolution.expect("tick rate").numerator,
        24_000
    );
    assert_eq!(projection.display_rate.expect("display rate").numerator, 24);
    assert_eq!(
        projection
            .playback_range
            .expect("playback range")
            .upper
            .frame,
        120_000
    );
    assert_eq!(projection.bindings.len(), 1);
    assert_eq!(
        projection.bindings[0].name.as_deref(),
        Some("Localized dialogue")
    );
    assert_eq!(
        projection.bindings[0].tracks[0].content,
        SequenceTrackContent::TimedText
    );
    let keys = &projection.bindings[0].tracks[0].sections[0].text_keys;
    assert_eq!(
        keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
        [0, 48_000, 96_000]
    );
    assert_eq!(
        keys.iter()
            .map(|key| key.source.as_str())
            .collect::<Vec<_>>(),
        ["We made it.", "Something is wrong.", "Run!"]
    );
    assert!(
        projection.references.iter().any(|reference| {
            reference.kind == SequenceReferenceKind::SoftObject
                && reference.scope == SequenceReferenceScope::External
                && reference.property_path == "Possessables[0].PossessedObjectClass"
                && reference.target_path == "/Script/UEShedFixture.UEShedFixtureTextAsset"
        }),
        "references: {:#?}",
        projection.references
    );
    assert!(projection.references.iter().any(|reference| {
        reference.kind == SequenceReferenceKind::Object
            && reference.scope == SequenceReferenceScope::Internal
            && reference.property_path == "MovieScene"
    }));
    assert!(
        projection.reference_coverage_gaps.is_empty(),
        "reference gaps: {:#?}",
        projection.reference_coverage_gaps
    );
    assert!(projection.coverage_gaps.is_empty());
}

#[test]
fn level_sequence_projection_exposes_subsequences_and_cinematic_shots() {
    let (_, package, assets) = decoded_assets(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/unreal-project/Content/Fixture/Sequences/LS_NestedTimeline.uasset"
    ));
    let projection = project_level_sequence(&package, &assets).expect("LevelSequence projection");

    assert_eq!(projection.schema_version, 3);
    assert_eq!(projection.root_tracks.len(), 2);
    let sub_sequence = projection
        .root_tracks
        .iter()
        .find(|track| track.content == SequenceTrackContent::SubSequence)
        .expect("subsequence track");
    let sub_section = &sub_sequence.sections[0];
    assert_eq!(sub_section.range.expect("subsequence range").lower.frame, 0);
    assert_eq!(
        sub_section.range.expect("subsequence range").upper.frame,
        60_000
    );
    assert_eq!(
        sub_section.sequence_path.as_deref(),
        Some("/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline")
    );

    let shot = projection
        .root_tracks
        .iter()
        .find(|track| track.content == SequenceTrackContent::CinematicShot)
        .expect("cinematic shot track");
    let shot_section = &shot.sections[0];
    assert_eq!(shot_section.range.expect("shot range").lower.frame, 60_000);
    assert_eq!(shot_section.range.expect("shot range").upper.frame, 120_000);
    assert_eq!(
        shot_section.sequence_path.as_deref(),
        Some("/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline")
    );
    assert_eq!(
        shot_section.shot_display_name.as_deref(),
        Some("Text timeline reprise")
    );
    let nested_references = projection
        .references
        .iter()
        .filter(|reference| {
            reference.kind == SequenceReferenceKind::Object
                && reference.scope == SequenceReferenceScope::External
                && reference.property_path == "SubSequence"
                && reference.target_path
                    == "/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline"
        })
        .count();
    assert_eq!(nested_references, 2);
    assert!(
        projection.reference_coverage_gaps.is_empty(),
        "reference gaps: {:#?}",
        projection.reference_coverage_gaps
    );
    assert!(projection.coverage_gaps.is_empty());
}

fn blueprint_projection(path: &str) -> BlueprintGraphProjection {
    let bytes = fs::read(path).expect("Blueprint sample package");
    let package = Package::parse(&bytes).expect("Blueprint sample parses");
    let schemas = EmptySchemas;
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: &schemas,
    };
    let assets: Vec<_> = package
        .exports
        .iter()
        .filter_map(|export| {
            decode_export(export, &context)
                .unwrap_or_else(|error| panic!("{}: {error}", export.object_path))
        })
        .collect();
    project_blueprint_graphs(&package, &assets).expect("Blueprint graphs")
}

fn assert_blueprint_topology(projection: &BlueprintGraphProjection) {
    assert_eq!(projection.schema_version, 1);
    assert!(!projection.graphs.is_empty());
    assert!(
        projection
            .graphs
            .iter()
            .any(|graph| !graph.nodes.is_empty())
    );
    assert!(
        projection
            .graphs
            .iter()
            .flat_map(|graph| &graph.nodes)
            .any(|node| !node.pins.is_empty())
    );
    assert!(
        projection
            .graphs
            .iter()
            .any(|graph| !graph.links.is_empty())
    );
    assert!(
        projection.coverage_gaps.is_empty(),
        "sample should be complete enough for graph reconstruction"
    );

    // Exercise the portable JSON boundary as well as the typed Rust projection.
    let json = serde_json::to_value(projection).expect("projection serializes");
    assert_eq!(json["schema_version"], 1);
    assert_eq!(json["coverage_gaps"], serde_json::json!([]));
}

#[test]
fn blueprint_projection_reconstructs_the_ue57_fixture_graph() {
    let projection = blueprint_projection(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/unreal-project/Content/Fixture/Blueprints/BP_GraphFixture.uasset"
    ));
    assert_blueprint_topology(&projection);
    assert_eq!(projection.graphs.len(), 2);
    assert_eq!(
        projection
            .graphs
            .iter()
            .flat_map(|graph| &graph.links)
            .count(),
        1
    );
    assert!(
        projection
            .graphs
            .iter()
            .flat_map(|graph| &graph.nodes)
            .any(|node| node.kind == BlueprintNodeKind::FunctionCall)
    );
}

#[test]
#[ignore = "requires an uncooked UE 5.7 Blueprint; set UASSET_BLUEPRINT_SAMPLE"]
fn blueprint_projection_reconstructs_graph_topology_from_a_real_package() {
    let path = std::env::var("UASSET_BLUEPRINT_SAMPLE").expect("UASSET_BLUEPRINT_SAMPLE");
    let projection = blueprint_projection(&path);
    assert_blueprint_topology(&projection);
}
