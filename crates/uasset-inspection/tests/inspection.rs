use serde_json::Value;
use uasset_inspection::generic::{inspect_bytes, inspect_bytes_json};

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
