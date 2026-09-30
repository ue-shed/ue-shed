//! Semantic evidence is produced by Unreal loading saved assets in a fresh process.
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use uasset_inspection::generic::{inspect_bytes, inspect_bytes_json};

fn fixture_root() -> PathBuf {
    std::env::var_os("UE_SHED_UASSET_FIXTURE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/unreal-project")
        })
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    fs::read(fixture_root().join(format!("Content/Fixture/ParserNative/{name}.uasset"))).unwrap()
}

fn fixture(name: &str) -> Value {
    let path = format!("Content/Fixture/ParserNative/{name}.uasset");
    let bytes = fixture_bytes(name);
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
        .unwrap_or_else(|| fixture_root().join("FixtureExpected/parser-targets"));
    serde_json::from_slice(&fs::read(path.join("native-coverage.json")).unwrap()).unwrap()
}

#[test]
fn discrete_sequence_matches_loaded_apis_and_retains_absent_fields() {
    use uasset_inspection::level_sequence::{
        SequenceCoverageGapReason, SequenceTrackContent, project_level_sequence,
    };
    use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
    use uasset_parser::property::PropertyValue;
    let bytes = fixture_bytes("LS_Discrete");
    let package = uasset_parser::Package::parse(&bytes).unwrap();
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let mut assets: Vec<_> = package
        .exports
        .iter()
        .filter_map(|export| decode_export(export, &context).unwrap())
        .collect();
    let projection = project_level_sequence(&package, &assets).unwrap();
    assert_eq!(projection.schema_version, 6);
    assert!(projection.reference_coverage_gaps.is_empty());
    assert_eq!(projection.root_tracks.len(), 8);
    assert!(
        projection
            .root_tracks
            .iter()
            .all(|track| track.content == SequenceTrackContent::Discrete)
    );
    assert_eq!(projection.coverage_gaps.len(), 1);
    assert_eq!(
        projection.coverage_gaps[0].reason,
        SequenceCoverageGapReason::MissingChannel
    );
    let oracle = &evidence()["discrete_sequence"];
    for track in &projection.root_tracks {
        let name = track.property_path.as_deref().unwrap();
        let section = &track.sections[0];
        assert_eq!(section.class_path, oracle[name]["section_class"]);
        if name == "Empty" {
            assert!(section.discrete_channels.is_empty());
            assert_eq!(oracle[name]["keys"], json!([]));
            continue;
        }
        let channel = serde_json::to_value(&section.discrete_channels[0]).unwrap();
        if name == "DefaultOnly" {
            assert!(channel["keys"].is_null());
            assert_eq!(oracle[name]["keys"], json!([]));
            assert!(channel["pre_extrapolation"].is_null());
        } else {
            assert_eq!(channel["keys"], oracle[name]["keys"], "{name}");
            assert_eq!(channel["pre_extrapolation"], "RCCE_Cycle");
            assert_eq!(channel["post_extrapolation"], "RCCE_Oscillate");
            assert_eq!(oracle[name]["pre"], 0);
            assert_eq!(oracle[name]["post"], 2);
        }
        assert_eq!(channel["default_value"], oracle[name]["default"], "{name}");
        if matches!(name, "bHidden" | "NoDefault") {
            assert!(
                channel["has_default_value"].is_null(),
                "absence is not false"
            );
        } else {
            assert_eq!(channel["has_default_value"], oracle[name]["has_default"]);
        }
        if name == "Count" {
            assert_eq!(
                channel["interpolate_linear_keys"],
                oracle[name]["interpolate_linear_keys"]
            );
        }
        if name == "Enabled" {
            assert_eq!(channel["externally_inverted"], true);
        }
        if name == "CaptureSource" {
            assert_eq!(channel["enum_path"], oracle[name]["enum_path"]);
        }
    }
    // Real saved arrays are fully decoded in generic inspection too (including bool bytes).
    let inspected = fixture("LS_Discrete");
    assert!(!inspected.to_string().contains("trailing bytes left"));

    // Corrupt decoded evidence independently of serialization: never zip mismatched arrays
    // into a plausible, silently shortened key list.
    for asset in &mut assets {
        if let DecodedAsset::UObject(object) = asset {
            for record in &mut object.properties.records {
                if package.resolve_name_str(record.name) != Some("IntegerCurve") {
                    continue;
                }
                if let PropertyValue::Struct(stream) = &mut record.value {
                    for field in &mut stream.records {
                        if package.resolve_name_str(field.name) == Some("Values")
                            && let PropertyValue::Array(values) = &mut field.value
                        {
                            values.pop();
                        }
                    }
                }
            }
        }
    }
    let malformed = project_level_sequence(&package, &assets).unwrap();
    assert_eq!(
        malformed
            .coverage_gaps
            .iter()
            .filter(|g| g.reason == SequenceCoverageGapReason::MismatchedChannelLengths)
            .count(),
        2
    );
    for track in malformed
        .root_tracks
        .iter()
        .filter(|t| matches!(t.property_path.as_deref(), Some("Count" | "NoDefault")))
    {
        assert!(
            serde_json::to_value(&track.sections[0].discrete_channels[0]).unwrap()["keys"]
                .is_null()
        );
    }
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
    assert_eq!(
        opaque["struct_type"],
        "/Script/UEShedFixture.UEShedOpaqueNative"
    );
    assert_eq!(opaque["size"], 8);
    assert_eq!(opaque["value"]["value_kind"], "raw");
    assert_eq!(opaque["value"]["size"], 8);
    assert!(
        opaque["value"]["reason"]
            .as_str()
            .unwrap()
            .contains("unsupported InstancedStruct")
    );
    equivalent(&output["metadata"], &expected["metadata"], "metadata");
}

fn components(value: &Value, names: &[&str]) -> Value {
    if value.is_array() {
        return value.clone();
    }
    names.iter().map(|name| value[name].clone()).collect()
}

#[test]
fn property_bags_match_unreal_descriptors_values_containers_and_instances() {
    let output = fixture("DA_Native");
    let asset = &output["assets"][0];
    let bag = fields(property(asset, "Parameters"));
    assert_eq!(bag["HasData"], true);
    let expected = evidence();
    let oracle = &expected["property_bag"];
    let mut actual = bag["Value"].clone();
    actual["NestedMessage"] = actual["Nested"]["Value"]["Message"].clone();
    actual.as_object_mut().unwrap().remove("Nested");
    if bag["CustomVersion"] == 5 {
        let values = &property(asset, "Parameters")["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == "Value")
            .unwrap()["value"];
        let lookup = values["properties"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == "Lookup")
            .unwrap();
        actual["Lookup"] = lookup["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    e["key"]["value"].as_str().unwrap().to_owned(),
                    fields(&e["value"]),
                )
            })
            .collect();
    }
    equivalent(&actual, &oracle["values"], "property bag values");
    let descriptors: Vec<Value> = bag["Descriptors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            let mut desc = json!({"name":d["Name"], "id":d["ID"].as_str().unwrap().replace('-', ""),
            "type":d["ValueType"], "type_object":d["ValueTypeObject"].as_str().unwrap_or(""),
            "containers":d["ContainerTypes"], "metadata":{}});
            if let Some(metadata) = d["MetaData"].as_array() {
                desc["metadata"] = metadata
                    .iter()
                    .map(|m| (m["Key"].as_str().unwrap().to_owned(), m["Value"].clone()))
                    .collect();
            }
            if bag["CustomVersion"] == 5 {
                desc["flags"] = json!(d["PropertyFlags"].as_u64().unwrap().to_string());
                desc["key_type"] = d["KeyType"].clone();
                desc["key_type_object"] = json!(d["KeyTypeObject"].as_str().unwrap_or(""));
            }
            desc
        })
        .collect();
    equivalent(
        &json!(descriptors),
        &oracle["descriptors"],
        "property bag descriptors",
    );
    let containers = fields(property(asset, "ParameterBags"));
    assert_eq!(containers[0], bag);
    assert_eq!(containers[1]["HasData"], false);
    assert!(containers[1].get("Value").is_none());
    assert_eq!(fields(&property(asset, "BagInstance")["value"]), bag);
}

#[test]
fn animation_summary_matches_unreal_and_preserves_missing_evidence() {
    use uasset_inspection::animation::{
        AnimationGapReason, inspect_animation_bytes, project_animations,
    };
    use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
    use uasset_parser::property::PropertyValue;
    let bytes = fixture_bytes("A_Native");
    fixture("A_Native");
    let output = inspect_animation_bytes("A_Native.uasset", &bytes).unwrap();
    assert_eq!(output.status, "complete", "{output:#?}");
    assert_eq!(output.animations.len(), 1);
    let a = &output.animations[0];
    let mut tracks: Vec<_> = a.bone_tracks.iter().map(|t| t.name.clone()).collect();
    tracks.sort();
    let mut curves: Vec<_> = a
        .curves
        .iter()
        .map(|c| json!({"name":c.name.to_lowercase(), "keys":c.key_count}))
        .collect();
    curves.sort_by_key(|c| c["name"].as_str().unwrap().to_owned());
    let actual = json!({"skeleton":a.skeleton,"duration":a.duration_seconds,"rate_scale":a.rate_scale,
        "loop":a.looping,"frames":a.frame_count,"numerator":a.frame_rate.as_ref().unwrap().numerator,
        "denominator":a.frame_rate.as_ref().unwrap().denominator,"root_motion":a.root_motion.enabled,
        "force_root_lock":a.root_motion.force_root_lock,"normalized_root_motion":a.root_motion.normalized_scale,
        "tracks":tracks,"curves":curves,"notifies":a.notifies.iter().map(|n| json!({"name":n.name,"time":n.time_seconds,"duration":n.duration_seconds,"track":n.track_index})).collect::<Vec<_>>()});
    let mut expected = evidence()["animation"].clone();
    expected["tracks"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(|t| t.as_str().unwrap().to_owned());
    for c in expected["curves"].as_array_mut().unwrap() {
        c["name"] = json!(c["name"].as_str().unwrap().to_lowercase());
    }
    expected["curves"]
        .as_array_mut()
        .unwrap()
        .sort_by_key(|c| c["name"].as_str().unwrap().to_owned());
    equivalent(&actual, &expected, "animation summary");
    assert_eq!(
        a.root_motion.root_lock.as_deref(),
        Some("ERootMotionRootLock::AnimFirstFrame")
    );

    let package = uasset_parser::Package::parse(&bytes).unwrap();
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let mut assets: Vec<_> = package
        .exports
        .iter()
        .filter_map(|e| decode_export(e, &context).unwrap())
        .collect();
    for asset in &mut assets {
        match asset {
            DecodedAsset::AnimSequence(a) => {
                a.properties
                    .records
                    .retain(|r| package.resolve_name_str(r.name) != Some("RateScale"));
                for r in &mut a.properties.records {
                    if package.resolve_name_str(r.name) == Some("SequenceLength") {
                        r.value = PropertyValue::Float(f32::NAN);
                    }
                }
            }
            DecodedAsset::UObject(o)
                if o.class_path.as_str() == "/Script/MovieScene.MovieScene" =>
            {
                o.properties
                    .records
                    .retain(|r| package.resolve_name_str(r.name) != Some("DisplayRate"));
            }
            _ => {}
        }
    }
    let partial = project_animations(&package, &assets).remove(0);
    assert_eq!(partial.rate_scale, None);
    assert_eq!(partial.duration_seconds, None);
    assert_eq!(partial.frame_rate, None);
    for field in ["RateScale", "SequenceLength", "DisplayRate"] {
        assert!(
            partial
                .coverage_gaps
                .iter()
                .any(|g| g.property_path == field)
        );
    }
    let mut unsupported = assets.clone();
    for asset in &mut unsupported {
        if let DecodedAsset::UObject(o) = asset
            && o.class_path.as_str().contains("DataModel")
        {
            o.class_path =
                uasset_parser::package::ObjectPath::new("/Script/Test.UnknownAnimationModel");
        }
    }
    let unsupported = project_animations(&package, &unsupported).remove(0);
    assert!(
        unsupported
            .coverage_gaps
            .iter()
            .any(|g| g.reason == AnimationGapReason::UnsupportedDataModel)
    );
    assert!(unsupported.bone_tracks.is_empty());
    assets.retain(
        |a| !matches!(a, DecodedAsset::UObject(o) if o.class_path.as_str().contains("DataModel")),
    );
    let missing = project_animations(&package, &assets).remove(0);
    assert!(
        missing
            .coverage_gaps
            .iter()
            .any(|g| g.reason == AnimationGapReason::MissingExport)
    );
    assert!(missing.bone_tracks.is_empty());
    assert_eq!(missing.frame_count, None);
}
fn transform(value: &Value) -> Value {
    json!({"rotation":components(&value["Rotation"], &["X","Y","Z","W"]),
        "translation":components(&value["Translation"], &["X","Y","Z"]),
        "scale":components(&value["Scale3D"], &["X","Y","Z"])})
}

#[test]
fn math_and_tags_match_unreal_in_properties_containers_and_instances() {
    let output = fixture("DA_Native");
    let asset = &output["assets"][0];
    let expected = evidence();
    let read = |name| fields(property(asset, name));
    let math = json!({
        "rotation":components(&read("Rotation"), &["X","Y","Z","W"]),
        "transform":transform(&read("Transform")),
        "position2d":components(&read("Position2D"), &["X","Y"]),
        "box_min":components(&read("Bounds")["Min"], &["X","Y","Z"]),
        "box_max":components(&read("Bounds")["Max"], &["X","Y","Z"]),
        "box_valid":read("Bounds")["IsValid"] == 1,
        "grid":components(&read("Grid"), &["X","Y","Z"])
    });
    equivalent(&math, &expected["math"], "math");
    let mut tags = read("Tags")["GameplayTags"].as_array().unwrap().clone();
    tags.sort_by_key(|tag| tag.as_str().unwrap().to_owned());
    equivalent(&json!(tags), &expected["tags"], "tags");
    assert_eq!(read("TagContainers")[0], read("Tags"));
    assert_eq!(read("TagContainers")[1]["GameplayTags"], json!([]));
    for (array, scalar) in [
        ("Rotations", "Rotation"),
        ("Transforms", "Transform"),
        ("Positions2D", "Position2D"),
        ("Boxes", "Bounds"),
    ] {
        assert_eq!(read(array)[0], read(scalar), "{array}");
        assert_eq!(read(array).as_array().unwrap().len(), 2);
    }
    assert_eq!(read("Boxes")[1]["IsValid"], 0);
    let grids = &property(asset, "Grids")["values"];
    assert!(
        grids
            .as_array()
            .unwrap()
            .iter()
            .any(|grid| fields(grid) == read("Grid"))
    );
    let entries = &property(asset, "NamedTransforms")["entries"];
    assert_eq!(entries[0]["key"]["value"], "origin");
    assert_eq!(fields(&entries[0]["value"]), read("Transform"));
    let instances = &property(asset, "MathInstances")["values"];
    for (index, scalar) in [
        "Rotation",
        "Transform",
        "Position2D",
        "Bounds",
        "Grid",
        "Tags",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(
            fields(&instances[index]["value"]),
            read(scalar),
            "instance {scalar}"
        );
    }
}

fn projected_channel(channel: &uasset_inspection::level_sequence::SequenceNumericChannel) -> Value {
    let keys: Vec<_> = channel.keys.iter().map(|key| json!({"frame":key.frame,"value":key.value,
        "interp":key.interpolation,"tangent_mode":key.tangent_mode,"weight_mode":key.tangent_weight_mode,
        "arrive":key.arrive_tangent,"leave":key.leave_tangent,"arrive_weight":key.arrive_tangent_weight,"leave_weight":key.leave_tangent_weight})).collect();
    json!({"default":channel.default_value,"pre":channel.pre_extrapolation,"post":channel.post_extrapolation,
        "numerator":channel.tick_resolution.numerator,"denominator":channel.tick_resolution.denominator,"keys":keys})
}

#[test]
fn numeric_sequence_projection_matches_unreal_channels_masks_and_reports_gaps() {
    use uasset_inspection::level_sequence::{SequenceTrackContent, project_level_sequence};
    use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
    let bytes = fixture_bytes("LS_Numeric");
    let package = uasset_parser::Package::parse(&bytes).unwrap();
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let mut assets: Vec<_> = package
        .exports
        .iter()
        .filter_map(|export| decode_export(export, &context).unwrap())
        .collect();
    let projection = project_level_sequence(&package, &assets).unwrap();
    assert_eq!(projection.schema_version, 6);
    assert!(
        projection.coverage_gaps.is_empty(),
        "{:?}",
        projection.coverage_gaps
    );
    let expected = evidence();
    let numeric: Vec<_> = projection
        .root_tracks
        .iter()
        .filter(|t| t.content == SequenceTrackContent::Numeric)
        .flat_map(|t| &t.sections)
        .flat_map(|s| &s.numeric_channels)
        .map(projected_channel)
        .collect();
    equivalent(
        &json!(numeric),
        &expected["sequence_channels"],
        "scalar projection",
    );
    let transform = projection
        .root_tracks
        .iter()
        .find(|t| t.content == SequenceTrackContent::Transform)
        .unwrap();
    let channels = &transform.sections[0].numeric_channels;
    let axes: Vec<_> = channels
        .iter()
        .filter(|c| c.property_path != "ManualWeight")
        .collect();
    equivalent(
        &json!(
            axes.iter()
                .map(|c| projected_channel(c))
                .collect::<Vec<_>>()
        ),
        &expected["transform_channels"],
        "transform projection",
    );
    assert_eq!(axes.len(), 9);
    for (i, channel) in axes.iter().enumerate() {
        assert_eq!(
            channel.enabled,
            Some(expected["transform_mask"].as_u64().unwrap() & (1 << i) != 0)
        );
    }
    for asset in &mut assets {
        if let DecodedAsset::UObject(object) = asset {
            if object
                .class_path
                .as_str()
                .ends_with("MovieScene3DTransformSection")
            {
                object.properties.records.retain(|record| {
                    package.resolve_name_str(record.name) != Some("TransformMask")
                });
            }
            if object
                .class_path
                .as_str()
                .ends_with("MovieSceneFloatSection")
            {
                object
                    .properties
                    .records
                    .retain(|record| package.resolve_name_str(record.name) != Some("FloatCurve"));
            }
            if object
                .class_path
                .as_str()
                .ends_with("MovieSceneDoubleSection")
            {
                for record in &mut object.properties.records {
                    if package.resolve_name_str(record.name) == Some("DoubleCurve") {
                        record.value = uasset_parser::property::PropertyValue::Int(3);
                    }
                }
            }
        }
    }
    let partial = project_level_sequence(&package, &assets).unwrap();
    assert!(
        partial
            .coverage_gaps
            .iter()
            .any(|g| g.property_path == "TransformMask")
    );
    assert!(
        partial
            .coverage_gaps
            .iter()
            .any(|g| g.property_path == "FloatCurve")
    );
    assert!(
        partial
            .coverage_gaps
            .iter()
            .any(|g| g.property_path == "DoubleCurve")
    );
}

#[test]
fn malformed_metadata_is_partial_without_hiding_decodable_exports() {
    let mut bytes = fixture_bytes("DA_Native");
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

#[test]
fn saved_sequence_rejects_bad_key_arrays_settings_cut_ids_and_binding_metadata() {
    use uasset_inspection::level_sequence::{
        SequenceCoverageGapReason, SequenceValueChannel, project_level_sequence,
    };
    use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
    use uasset_parser::property::PropertyValue;
    let bytes = fixture_bytes("LS_SavedDetails");
    let package = uasset_parser::Package::parse(&bytes).unwrap();
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let assets: Vec<_> = package
        .exports
        .iter()
        .filter_map(|e| decode_export(e, &context).unwrap())
        .collect();
    let valid = project_level_sequence(&package, &assets).unwrap();
    assert!(valid.coverage_gaps.is_empty(), "{:?}", valid.coverage_gaps);
    let object = valid
        .root_tracks
        .iter()
        .find(|t| t.property_path.as_deref() == Some("Mesh"))
        .unwrap();
    let SequenceValueChannel::Object(channel) = &object.sections[0].value_channels[0] else {
        panic!()
    };
    assert_eq!(
        channel.keys.as_ref().unwrap()[1].value.soft_path.as_deref(),
        Some("")
    );
    assert_eq!(channel.keys.as_ref().unwrap()[1].value.hard_path, None);
    let default = valid
        .root_tracks
        .iter()
        .find(|t| t.property_path.as_deref() == Some("DefaultOnly"))
        .unwrap();
    let SequenceValueChannel::String(channel) = &default.sections[0].value_channels[0] else {
        panic!()
    };
    assert_eq!(channel.keys, None);
    for field in ["Times", "Values"] {
        let mut corrupt = assets.clone();
        for asset in &mut corrupt {
            if let DecodedAsset::UObject(object) = asset {
                for record in &mut object.properties.records {
                    if package.resolve_name_str(record.name) == Some("StringCurve")
                        && let PropertyValue::Struct(stream) = &mut record.value
                    {
                        for record in &mut stream.records {
                            if package.resolve_name_str(record.name) == Some(field)
                                && let PropertyValue::Array(values) = &mut record.value
                            {
                                values.pop();
                            }
                        }
                    }
                }
            }
        }
        let partial = project_level_sequence(&package, &corrupt).unwrap();
        assert!(
            partial
                .coverage_gaps
                .iter()
                .any(|g| g.reason == SequenceCoverageGapReason::MismatchedChannelLengths)
        );
        assert!(partial.root_tracks.iter().flat_map(|t| &t.sections).flat_map(|s| &s.value_channels).any(|c| matches!(c, SequenceValueChannel::String(c) if c.default_value.as_deref() == Some("default label") && c.keys.is_none())));
    }
    let mut corrupt = assets.clone();
    for asset in &mut corrupt {
        if let DecodedAsset::UObject(object) = asset {
            for record in &mut object.properties.records {
                if matches!(
                    package.resolve_name_str(record.name),
                    Some("RowIndex" | "CameraBindingID" | "Spawnables")
                ) {
                    record.value = PropertyValue::Bool(false);
                }
            }
        }
    }
    let partial = project_level_sequence(&package, &corrupt).unwrap();
    for field in ["RowIndex", "CameraBindingID", "Spawnables"] {
        assert!(
            partial
                .coverage_gaps
                .iter()
                .any(|g| g.property_path == field)
        );
    }
    // Invalid object indices remain explicit missing references, not a null key.
    let mut corrupt = assets;
    for asset in &mut corrupt {
        if let DecodedAsset::UObject(object) = asset {
            for record in &mut object.properties.records {
                if package.resolve_name_str(record.name) == Some("ObjectChannel")
                    && let PropertyValue::Struct(stream) = &mut record.value
                {
                    for r in &mut stream.records {
                        if package.resolve_name_str(r.name) == Some("PropertyClass") {
                            r.value = PropertyValue::ObjectRef(
                                uasset_parser::package::PackageIndex::Export(u32::MAX),
                            );
                        }
                    }
                }
            }
        }
    }
    assert!(
        project_level_sequence(&package, &corrupt)
            .unwrap()
            .coverage_gaps
            .iter()
            .any(|g| g.property_path == "ObjectChannel.PropertyClass"
                && g.reason == SequenceCoverageGapReason::MissingReference)
    );
}

#[test]
fn blueprint_definition_reports_unavailable_defaults_templates_bad_variables_and_cycles() {
    use uasset_inspection::blueprint::{BlueprintGraphCoverageGapReason, project_blueprint_graphs};
    use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
    use uasset_parser::property::PropertyValue;
    let bytes = fs::read(fixture_root().join("Content/Fixture/Blueprints/BP_ReviewFixture.uasset"))
        .unwrap();
    let package = uasset_parser::Package::parse(&bytes).unwrap();
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let assets: Vec<_> = package
        .exports
        .iter()
        .filter_map(|e| decode_export(e, &context).unwrap())
        .collect();
    let valid = project_blueprint_graphs(&package, &assets).unwrap();
    assert_eq!(valid.definition.variables.as_ref().unwrap().len(), 6);
    let scs = valid.definition.construction_script.as_ref().unwrap();
    assert_eq!(scs.nodes.len(), 3);
    assert!(
        scs.nodes
            .iter()
            .any(|n| n.parent_is_native == Some(true) && n.parent_component_name.is_some())
    );
    let mut corrupt = assets.clone();
    for asset in &mut corrupt {
        if let DecodedAsset::UObject(object) = asset {
            let self_index = package
                .exports
                .iter()
                .position(|e| e.object_path == object.object_path)
                .unwrap() as u32;
            for record in &mut object.properties.records {
                match package.resolve_name_str(record.name) {
                    Some("NewVariables") => record.value = PropertyValue::Int(9),
                    Some("ChildNodes") => {
                        record.value = PropertyValue::Array(vec![PropertyValue::ObjectRef(
                            uasset_parser::package::PackageIndex::Export(self_index),
                        )])
                    }
                    Some("ComponentTemplate") => {
                        record.value = PropertyValue::ObjectRef(
                            uasset_parser::package::PackageIndex::Export(u32::MAX),
                        )
                    }
                    _ => {}
                }
            }
        }
    }
    let partial = project_blueprint_graphs(&package, &corrupt).unwrap();
    assert!(partial.definition.variables.is_none());
    assert!(!partial.graphs.is_empty());
    for detail in ["NewVariables", "cycle", "unresolved reference"] {
        assert!(
            partial.coverage_gaps.iter().any(|g| g.reason
                == BlueprintGraphCoverageGapReason::IncompleteDefinition
                && g.detail.contains(detail)),
            "{:?}",
            partial.coverage_gaps
        );
    }
    let mut unavailable = assets;
    let default = valid
        .definition
        .default_object
        .as_ref()
        .unwrap()
        .object_path
        .as_str();
    unavailable
        .retain(|a| !matches!(a, DecodedAsset::UObject(o) if o.object_path.as_str() == default));
    let partial = project_blueprint_graphs(&package, &unavailable).unwrap();
    assert!(partial.definition.default_object.is_none());
    assert!(
        partial
            .coverage_gaps
            .iter()
            .any(|g| g.detail.contains("default object was not decoded"))
    );
}

#[test]
fn saved_actor_component_native_data_matches_independent_loaded_apis() {
    let inspected = fixture("LS_SavedDetails");
    let oracle = evidence();
    for object in oracle["saved_sequence"]["native_objects"]
        .as_array()
        .unwrap()
    {
        let path = object["path"].as_str().unwrap().replace(':', ".");
        let asset = inspected["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|asset| asset["object_path"] == path)
            .unwrap();
        assert_eq!(asset["class_path"], object["class"]);
        assert!(asset.get("tail_bytes").is_none(), "{path}");
        let native = fields(&asset["native_data"]);
        if let Some(members) = object.get("modified_members") {
            let mut actual: Vec<_> = native["UCSModifiedProperties"]
                .as_array()
                .unwrap()
                .iter()
                .map(|member| {
                    assert_eq!(member["MemberGuid"], "00000000-00000000-00000000-00000000");
                    json!({"name": member["MemberName"], "owner": member["MemberParent"]})
                })
                .collect();
            actual.sort_by_key(|value| value.to_string());
            let mut expected = members.as_array().unwrap().clone();
            expected.sort_by_key(|value| value.to_string());
            assert_eq!(actual, expected, "{path}");
            if object["compute_static_bounds"] == true {
                assert_eq!(native["StaticBoundsIsCooked"], false);
            } else {
                assert!(native.get("StaticBoundsIsCooked").is_none());
            }
        } else {
            assert_eq!(native["ActorLabelIsCooked"], false);
        }
    }
    let bytes = fixture_bytes("LS_SavedDetails");
    let package = uasset_parser::Package::parse(&bytes).unwrap();
    let context = uasset_parser::asset::AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let assets: Vec<_> = package
        .exports
        .iter()
        .filter_map(|export| uasset_parser::asset::decode_export(export, &context).unwrap())
        .collect();
    let sequence =
        uasset_inspection::level_sequence::project_level_sequence(&package, &assets).unwrap();
    assert!(
        sequence.reference_coverage_gaps.is_empty(),
        "{:?}",
        sequence.reference_coverage_gaps
    );
    let members: Vec<_> = sequence
        .references
        .iter()
        .filter(|reference| {
            reference
                .property_path
                .starts_with("$native_data.UCSModifiedProperties")
        })
        .collect();
    assert_eq!(members.len(), 2);
    assert!(
        members
            .iter()
            .all(|reference| reference.target_path == "/Script/Engine.CameraComponent")
    );
}
