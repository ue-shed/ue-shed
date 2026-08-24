use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use uasset_inspection::generic::{inspect_bytes, inspect_bytes_json, inspect_bytes_with_schemas};
use uasset_parser::package::ObjectPath;
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};

struct EmptySchemas;

impl SchemaProvider for EmptySchemas {
    fn find_struct(&self, _path: &ObjectPath) -> Option<&StructSchema> {
        None
    }

    fn find_class(&self, _path: &ObjectPath) -> Option<&ClassSchema> {
        None
    }
}

const STRING_TABLE: &[u8] =
    include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset");
const DATA_TABLE: &[u8] =
    include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Text.uasset");
const PARITY_FIXTURES: &[(&str, &[u8])] = &[
    (
        "Content/Fixture/Authoring/DT_Scalars.uasset",
        include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
        ),
    ),
    (
        "Content/Fixture/Authoring/DT_LargeScalars.uasset",
        include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_LargeScalars.uasset"
        ),
    ),
    (
        "Content/Fixture/Input/IMC_Fixture.uasset",
        include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Input/IMC_Fixture.uasset"),
    ),
    (
        "Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset",
        include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset"
        ),
    ),
    (
        "Content/Fixture/Animation/A_FixtureMotion.uasset",
        include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Animation/A_FixtureMotion.uasset"
        ),
    ),
    (
        "Content/Fixture/Sequences/LS_TextTimeline.uasset",
        include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Sequences/LS_TextTimeline.uasset"
        ),
    ),
    (
        "Content/Fixture/Sequences/LS_NestedTimeline.uasset",
        include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Sequences/LS_NestedTimeline.uasset"
        ),
    ),
    (
        "Content/Fixture/Text/ST_Game.uasset",
        include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset"),
    ),
    (
        "Content/Fixture/Cameras/L_CameraLoad.umap",
        include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap"
        ),
    ),
];

#[test]
fn generic_inspection_owns_the_shared_saved_asset_shape() {
    let output = inspect_bytes_json("Content/Fixture/Text/ST_Game.uasset", STRING_TABLE);
    let value: Value = serde_json::from_str(&output).expect("inspection is JSON");
    assert_eq!(value["schema_version"], 8);
    assert_eq!(value["status"], "ok");
    assert_eq!(value["assets"][0]["kind"], "StringTable");
    assert_eq!(
        value["assets"][0]["string_table_entries"][0]["key"],
        "PromptContinue"
    );
}

#[test]
fn typed_inspection_exposes_decoded_values_before_serialization() {
    let inspection = inspect_bytes("Content/Fixture/Text/ST_Game.uasset", STRING_TABLE)
        .expect("fixture inspection succeeds");
    assert_eq!(inspection.schema_version, 8);
    assert_eq!(inspection.status, "ok");
    assert_eq!(inspection.package.name, "/Game/Fixture/Text/ST_Game");
    assert_eq!(inspection.assets[0].kind, "StringTable");
    assert_eq!(
        inspection.assets[0].string_table_entries[0].key,
        "PromptContinue"
    );
}

#[test]
fn real_anim_sequence_consumes_its_native_trailer() {
    const ANIMATION: &[u8] = include_bytes!(
        "../../../fixtures/unreal-project/Content/Fixture/Animation/A_FixtureMotion.uasset"
    );
    let inspection = inspect_bytes(
        "Content/Fixture/Animation/A_FixtureMotion.uasset",
        ANIMATION,
    )
    .expect("animation fixture inspection succeeds");
    let sequence = inspection
        .assets
        .iter()
        .find(|asset| asset.class_path.as_deref() == Some("/Script/Engine.AnimSequence"))
        .expect("AnimSequence export");

    assert_eq!(inspection.status, "ok");
    assert_eq!(sequence.kind, "UObject");
    assert_eq!(sequence.tail_bytes, 0);
    assert!(sequence.properties.iter().any(|property| {
        property.name == "SequenceLength"
            && matches!(
                &property.value,
                uasset_inspection::generic::PropertyValueOutput::Float { value }
                    if *value == 2.0
            )
    }));
    assert!(sequence.properties.iter().any(|property| {
        property.name == "DataModelInterface"
            && matches!(
                &property.value,
                uasset_inspection::generic::PropertyValueOutput::ObjectRef { value: Some(value) }
                    if value.ends_with(".AnimationSequencerDataModel")
            )
    }));
}

#[test]
fn malformed_package_is_reported_without_panicking() {
    let output = inspect_bytes_json("broken.uasset", &[]);
    let value: Value = serde_json::from_str(&output).expect("error inspection is JSON");
    assert_eq!(value["status"], "error");
    assert_eq!(value["path"], "broken.uasset");
}

#[test]
fn inspection_is_deterministic_for_the_same_bytes() {
    let first = inspect_bytes_json("Content/Fixture/Authoring/DT_Text.uasset", DATA_TABLE);
    let second = inspect_bytes_json("Content/Fixture/Authoring/DT_Text.uasset", DATA_TABLE);
    assert_eq!(first, second);
}

#[test]
fn direct_json_matches_the_typed_projection_for_real_fixtures() {
    for (path, bytes) in PARITY_FIXTURES {
        let typed = inspect_bytes(path, bytes).expect("fixture inspection succeeds");
        let expected = serde_json::to_value(typed).expect("typed inspection serializes");
        let direct: Value = serde_json::from_str(&inspect_bytes_json(path, bytes))
            .expect("direct inspection serializes");
        if !json_values_equal(&direct, &expected) {
            panic!(
                "direct JSON differs for {path}: {}",
                first_json_difference(&direct, &expected, "$"),
            );
        }
    }
}

#[test]
fn generated_and_legacy_public_datatable_inspections_are_identical() {
    let authoring = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/unreal-project/Content/Fixture/Authoring");
    let mut fixtures = fs::read_dir(authoring)
        .expect("authoring fixture directory")
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

    for fixture in fixtures {
        let path = fixture.to_string_lossy();
        let bytes = fs::read(&fixture).expect("fixture bytes");
        let generated = serde_json::to_value(
            inspect_bytes(&path, &bytes).expect("generated inspection succeeds"),
        )
        .expect("generated inspection serializes");
        let legacy = serde_json::to_value(
            inspect_bytes_with_schemas(&path, &bytes, &EmptySchemas)
                .expect("legacy inspection succeeds"),
        )
        .expect("legacy inspection serializes");
        assert_eq!(generated, legacy, "{} public parity", fixture.display());
    }
}

fn first_json_difference(actual: &Value, expected: &Value, path: &str) -> String {
    match (actual, expected) {
        (Value::Array(actual), Value::Array(expected)) => {
            if actual.len() != expected.len() {
                return format!(
                    "{path} length is {}, expected {}",
                    actual.len(),
                    expected.len()
                );
            }
            for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                if !json_values_equal(actual, expected) {
                    return first_json_difference(actual, expected, &format!("{path}[{index}]"));
                }
            }
        }
        (Value::Object(actual), Value::Object(expected)) => {
            for (key, expected) in expected {
                let Some(actual) = actual.get(key) else {
                    return format!("{path}.{key} is missing");
                };
                if !json_values_equal(actual, expected) {
                    return first_json_difference(actual, expected, &format!("{path}.{key}"));
                }
            }
            if let Some(key) = actual.keys().find(|key| !expected.contains_key(*key)) {
                return format!("{path}.{key} is unexpected");
            }
        }
        _ => return format!("{path} is {actual}, expected {expected}"),
    }
    format!("{path} differs")
}

fn json_values_equal(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(actual), Value::Number(expected)) => {
            match (actual.as_f64(), expected.as_f64()) {
                (Some(actual), Some(expected)) => {
                    (actual - expected).abs()
                        <= f64::EPSILON * actual.abs().max(expected.abs()).max(1.0)
                }
                _ => actual == expected,
            }
        }
        (Value::Array(actual), Value::Array(expected)) => {
            actual.len() == expected.len()
                && actual
                    .iter()
                    .zip(expected)
                    .all(|(actual, expected)| json_values_equal(actual, expected))
        }
        (Value::Object(actual), Value::Object(expected)) => {
            actual.len() == expected.len()
                && expected.iter().all(|(key, expected)| {
                    actual
                        .get(key)
                        .is_some_and(|actual| json_values_equal(actual, expected))
                })
        }
        _ => actual == expected,
    }
}
