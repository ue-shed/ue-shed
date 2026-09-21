//! Semantic evidence is produced by Unreal loading the committed assets in a fresh process.
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use uasset_inspection::generic::{inspect_bytes, inspect_bytes_json};

fn fixture(name: &str) -> Value {
    let path = format!("Content/Fixture/ParserNative/{name}.uasset");
    let bytes = fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/unreal-project")
            .join(&path),
    )
    .unwrap();
    let typed = inspect_bytes(&path, &bytes).unwrap();
    assert_eq!(typed.status, "ok", "{name}: {:?}", typed.decode_errors);
    let streamed: Value = serde_json::from_str(&inspect_bytes_json(&path, &bytes)).unwrap();
    let serialized: Value = serde_json::from_str(&serde_json::to_string(&typed).unwrap()).unwrap();
    assert_eq!(serialized, streamed, "typed/streaming parity for {name}");
    serde_json::to_value(typed).unwrap()
}
fn evidence() -> Value {
    let path = std::env::var_os("UE_SHED_NATIVE_EVIDENCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures/unreal-project/FixtureExpected/parser-targets")
        });
    serde_json::from_slice(&fs::read(path.join("native-coverage.json")).unwrap()).unwrap()
}
fn fields(value: &Value) -> Value {
    match value["value_kind"]
        .as_str()
        .unwrap_or_else(|| panic!("missing kind: {value}"))
    {
        "native_struct" => value["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| {
                (
                    field["name"].as_str().unwrap().to_owned(),
                    fields(&field["value"]),
                )
            })
            .collect(),
        "map" => Value::Null,
        "struct" => properties(&value["properties"]),
        "array" => value["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(fields)
            .collect(),
        "vector" => json!([value["x"], value["y"], value["z"]]),
        "object" => value["path"].clone(),
        _ => value["value"].clone(),
    }
}
fn properties(values: &Value) -> Value {
    values
        .as_array()
        .unwrap()
        .iter()
        .map(|field| (field["name"].as_str().unwrap().to_owned(), fields(field)))
        .collect()
}
fn property<'a>(asset: &'a Value, name: &str) -> &'a Value {
    asset["properties"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["name"] == name)
        .unwrap()
}
fn key(value: &Value) -> Value {
    json!({"value":value["Value"], "interp":value["InterpMode"], "tangent_mode":value["TangentMode"], "weight_mode":value["TangentWeightMode"], "arrive":value["ArriveTangent"], "leave":value["LeaveTangent"], "arrive_weight":value["ArriveTangentWeight"], "leave_weight":value["LeaveTangentWeight"]})
}
fn curve(value: &Value) -> Value {
    let value = fields(value);
    let keys: Vec<_> = value["Keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            let mut result = key(value);
            result["time"] = value["Time"].clone();
            result
        })
        .collect();
    let extrapolation = |name: &Value| match name.as_str().unwrap() {
        "RCCE_Cycle" => 0,
        "RCCE_Linear" => 3,
        other => panic!("unexpected fixture extrapolation {other}"),
    };
    json!({"default":value["DefaultValue"], "pre":extrapolation(&value["PreInfinityExtrap"]), "post":extrapolation(&value["PostInfinityExtrap"]), "keys":keys})
}
fn channel(value: &Value) -> Value {
    let value = fields(value);
    let keys: Vec<_> = value["Values"]
        .as_array()
        .unwrap()
        .iter()
        .zip(value["Times"].as_array().unwrap())
        .map(|(value, time)| {
            let mut result = key(value);
            result["frame"] = time.clone();
            result
        })
        .collect();
    json!({"default":if value["HasDefaultValue"] == true { value["DefaultValue"].clone() } else { Value::Null }, "pre":value["PreInfinityExtrap"], "post":value["PostInfinityExtrap"], "numerator":value["TickNumerator"], "denominator":value["TickDenominator"], "keys":keys})
}
fn equivalent(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!(
                (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1.0),
                "{path}: {a} != {b}"
            );
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                equivalent(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (key, b) in b {
                equivalent(
                    a.get(key).unwrap_or_else(|| panic!("{path}.{key} missing")),
                    b,
                    &format!("{path}.{key}"),
                );
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}
#[test]
fn rich_curves_match_loaded_unreal_keys_and_tangents() {
    let expected = evidence();
    for (name, kind, property_name) in [
        ("CF_Native", "float", "FloatCurve"),
        ("CV_Native", "vector", "FloatCurves"),
        ("CC_Native", "color", "FloatCurves"),
    ] {
        let output = fixture(name);
        let curves: Vec<_> = output["assets"][0]["properties"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|field| field["name"] == property_name)
            .map(curve)
            .collect();
        let actual = if kind == "float" {
            curves[0].clone()
        } else {
            json!(curves)
        };
        equivalent(&actual, &expected["curves"][kind], name);
    }
}
#[test]
fn skeleton_pose_and_lookup_match_loaded_unreal() {
    let output = fixture("SK_Native");
    let asset = output["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["kind"] == "Skeleton")
        .unwrap();
    assert!(!asset["reference_pose"].is_null(), "{asset}");
    let expected = evidence();
    let pose = fields(&asset["reference_pose"]);
    let bones: Vec<_> = asset["bones"].as_array().unwrap().iter().zip(pose["Poses"].as_array().unwrap()).map(|(bone,pose)| {
        let vector = |v: &Value| json!([v["X"],v["Y"],v["Z"]]);
        json!({"name":bone["name"],"parent":bone["parent_index"],"rotation":[pose["Rotation"]["X"],pose["Rotation"]["Y"],pose["Rotation"]["Z"],pose["Rotation"]["W"]],"translation":vector(&pose["Translation"]),"scale":vector(&pose["Scale3D"])})
    }).collect();
    equivalent(&json!(bones), &expected["bones"], "bones");
    let lookup = &asset["reference_pose"]["fields"][1]["value"]["entries"];
    let lookup: Value = lookup
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["key"]["value"].as_str().unwrap().to_owned(),
                entry["value"]["value"].clone(),
            )
        })
        .collect();
    equivalent(&lookup, &expected["bone_indices"], "bone_indices");
    assert!(
        asset["tail_bytes"].as_u64().unwrap() > 0,
        "later skeleton data stays explicit"
    );
}
#[test]
fn numeric_channels_match_unreal_in_properties_and_real_sequence_sections() {
    let expected = evidence();
    let output = fixture("DA_Native");
    let asset = &output["assets"][0];
    for (name, expected_name) in [
        ("FloatChannel", "float_channel"),
        ("DoubleChannel", "double_channel"),
        ("EmptyChannel", "empty_channel"),
    ] {
        equivalent(
            &channel(property(asset, name)),
            &expected[expected_name],
            name,
        );
    }
    let double = channel(property(asset, "DoubleChannel"));
    assert_eq!(
        double["keys"][3]["value"].as_f64().unwrap(),
        123456789.12345679
    );
    let sequence = fixture("LS_Numeric");
    let mut channel_properties: Vec<_> = sequence["assets"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|asset| asset["properties"].as_array().unwrap())
        .filter(|field| matches!(field["name"].as_str(), Some("FloatCurve" | "DoubleCurve")))
        .collect();
    // Export-table order is not track order. Match the oracle's float/double track order.
    channel_properties.sort_by_key(|field| field["name"] == "DoubleCurve");
    let channels: Vec<_> = channel_properties.into_iter().map(channel).collect();
    equivalent(
        &json!(channels),
        &expected["sequence_channels"],
        "sequence_channels",
    );
}
#[test]
fn instanced_values_and_package_annotations_match_unreal() {
    let expected = evidence();
    let output = fixture("DA_Native");
    let asset = &output["assets"][0];
    let instance = property(asset, "Value");
    let value = fields(&instance["value"]);
    equivalent(
        &json!({"type":instance["struct_type"],"count":value["Count"],"label":value["Label"],"reference":value["Reference"],"offset":value["Offset"]}),
        &expected["instance"],
        "instance",
    );
    assert!(instance["size"].as_u64().unwrap() > 0);
    equivalent(
        &fields(&property(asset, "NativeValue")["value"]),
        &expected["native_instance"],
        "native_instance",
    );
    let values = &property(asset, "Values")["values"];
    let mut standalone = instance.clone();
    standalone.as_object_mut().unwrap().remove("name");
    standalone.as_object_mut().unwrap().remove("type");
    assert_eq!(values[0], standalone);
    assert_eq!(
        values[1],
        json!({"value_kind":"instanced_struct","struct_type":null,"size":0,"value":null})
    );
    let mut standalone = property(asset, "NativeValue").clone();
    standalone.as_object_mut().unwrap().remove("name");
    standalone.as_object_mut().unwrap().remove("type");
    assert_eq!(values[2], standalone);
    let opaque = property(asset, "OpaqueValue");
    assert_eq!(opaque["struct_type"], "/Script/CoreUObject.Quat");
    assert_eq!(opaque["size"], 32);
    assert_eq!(opaque["value"]["value_kind"], "raw");
    assert_eq!(opaque["value"]["size"], 32);
    assert!(
        opaque["value"]["reason"]
            .as_str()
            .unwrap()
            .contains("unsupported InstancedStruct")
    );
    equivalent(&output["metadata"], &expected["metadata"], "metadata");
}

#[test]
fn malformed_metadata_is_partial_without_hiding_decodable_exports() {
    let mut bytes = include_bytes!(
        "../../../fixtures/unreal-project/Content/Fixture/ParserNative/DA_Native.uasset"
    )
    .to_vec();
    let package = uasset_parser::Package::parse(&bytes).unwrap();
    let offset = package.summary.metadata_offset.unwrap().get() as usize;
    bytes[offset..offset + 4].copy_from_slice(&(-1_i32).to_le_bytes());
    let typed = inspect_bytes("malformed.uasset", &bytes).unwrap();
    assert_eq!(typed.status, "partial");
    assert!(!typed.assets.is_empty());
    assert!(typed.metadata.is_none());
    assert_eq!(typed.decode_errors.len(), 1);
    assert_eq!(typed.decode_errors[0].kind, "malformed_data");
    let streamed: Value =
        serde_json::from_str(&inspect_bytes_json("malformed.uasset", &bytes)).unwrap();
    let serialized: Value = serde_json::from_str(&serde_json::to_string(&typed).unwrap()).unwrap();
    assert_eq!(serialized, streamed);
}
