use serde_json::Value;
use uasset_inspection::generic::{inspect_bytes, inspect_bytes_json};

const STRING_TABLE: &[u8] =
    include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset");
const DATA_TABLE: &[u8] =
    include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Text.uasset");

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
