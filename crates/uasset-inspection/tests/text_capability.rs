#![allow(clippy::unwrap_used, reason = "synthetic fixture assertions")]
use uasset_inspection::projection::project_text_asset;
use uasset_parser::archive::{Guid, Reader, Span};
use uasset_parser::asset::{DecodedAsset, DecodedUObject};
use uasset_parser::package::{ObjectPath, Package};
use uasset_parser::property::{
    PropertyRecord, PropertyStream, PropertyTagFlags, PropertyTypeName, PropertyValue, RawReason,
};

fn name(package: &mut Package, value: &str) -> uasset_parser::archive::NameRef {
    let index = package.names.len() as i32;
    package.names.push(value.into());
    let bytes = [index.to_le_bytes(), 0_i32.to_le_bytes()].concat();
    Reader::new(&bytes).read_name_ref("Fixture.Name").unwrap()
}

fn ty(package: &mut Package, value: &str, parameters: Vec<PropertyTypeName>) -> PropertyTypeName {
    PropertyTypeName {
        name: name(package, value),
        parameters,
    }
}

#[test]
fn gaps_keep_type_evidence_through_containers_and_unknown_types_remain_text_capable() {
    let mut package = Package::parse(include_bytes!(
        "../../../fixtures/graph-pin-text/4.27/BP_Keys.uasset"
    ))
    .unwrap();
    let mut records = Vec::new();
    for (property_type, struct_name, container, expected) in [
        ("NameProperty", "", "", false),
        ("SoftObjectProperty", "", "ArrayProperty", false),
        ("TextProperty", "", "ArrayProperty", true),
        ("StructProperty", "SoftObjectPath", "", false),
        ("StructProperty", "Guid", "", false),
        ("StructProperty", "UnknownStruct", "", true),
        ("UnknownProperty", "", "", true),
    ] {
        let parameters = if struct_name.is_empty() {
            vec![]
        } else {
            vec![ty(&mut package, struct_name, vec![])]
        };
        let mut type_name = ty(&mut package, property_type, parameters);
        let mut value = PropertyValue::Raw {
            reason: RawReason::DecoderRejected("synthetic truncated value".into()),
        };
        if !container.is_empty() {
            type_name = ty(&mut package, container, vec![type_name]);
            value = PropertyValue::Array(vec![value]);
        }
        records.push((
            PropertyRecord {
                name: name(&mut package, "Value"),
                type_name,
                array_index: 0,
                flags: PropertyTagFlags::default(),
                property_guid: None,
                struct_guid: None,
                extensions: None,
                payload: Span::default(),
                value,
            },
            expected,
        ));
    }
    // A project struct sharing Guid's short name must remain text-capable.
    let mut collision = records[4].0.clone();
    collision.struct_guid = Some(Guid {
        a: 1,
        b: 0,
        c: 0,
        d: 0,
    });
    records.push((collision, true));
    for (record, expected) in records {
        let object = DecodedUObject {
            native_data: None,
            object_path: ObjectPath::new("Fixture.Asset"),
            class_path: ObjectPath::new("/Script/Fixture.Asset"),
            object_guid: None,
            properties: PropertyStream {
                class_extensions: None,
                records: vec![record],
                terminator: Span::default(),
            },
            tail: Span::default(),
        };
        let projection = project_text_asset(&package, &DecodedAsset::UObject(object));
        assert_eq!(projection.coverage_gaps.len(), 1);
        assert_eq!(projection.coverage_gaps[0].may_contain_text, expected);
    }
}

#[test]
fn legacy_mesh_component_native_gaps_stay_reported_but_unknown_subclasses_can_hold_text() {
    let package = Package::parse(include_bytes!(
        "../../../fixtures/graph-pin-text/4.27/BP_Keys.uasset"
    ))
    .unwrap();
    for (class, expected) in [
        ("/Script/Engine.StaticMeshComponent", false),
        ("/Script/Engine.World", false),
        ("/Script/Fixture.StaticMeshComponent", true),
    ] {
        let object = DecodedUObject {
            native_data: None,
            object_path: ObjectPath::new("Fixture.Component"),
            class_path: ObjectPath::new(class),
            object_guid: None,
            properties: PropertyStream {
                class_extensions: None,
                records: vec![],
                terminator: Span::default(),
            },
            tail: Span::new(0, 1).unwrap(),
        };
        let projection = project_text_asset(&package, &DecodedAsset::UObject(object));
        assert_eq!(projection.coverage_gaps.len(), 1);
        assert_eq!(projection.coverage_gaps[0].may_contain_text, expected);
    }
}

#[test]
fn saved_blueprint_native_ancestry_does_not_hide_unknown_native_subclass_tails() {
    use uasset_parser::package::PackageIndex;
    let mut package = Package::parse(include_bytes!(
        "../../../fixtures/graph-pin-text/4.27/BP_Keys.uasset"
    ))
    .unwrap();
    let mut generated = package.exports[0].clone();
    generated.object_path = ObjectPath::new("Fixture.Component_C");
    generated.class_path = Some(ObjectPath::new("/Script/Engine.BlueprintGeneratedClass"));
    generated.super_index = PackageIndex::Import(0);
    package.exports[0] = generated;
    let mut component = package.exports[0].clone();
    component.object_path = ObjectPath::new("Fixture.Component");
    component.class_path = Some(ObjectPath::new("Fixture.Component_C"));
    component.class_index = PackageIndex::Export(0);
    package.exports.push(component.clone());
    for (base, expected) in [
        ("/Script/Engine.StaticMeshComponent", false),
        ("/Script/Fixture.MeshComponent", true),
    ] {
        package.imports[0].object_path = ObjectPath::new(base);
        let object = DecodedUObject {
            native_data: None,
            object_path: component.object_path.clone(),
            class_path: component.class_path.clone().unwrap(),
            object_guid: None,
            properties: PropertyStream {
                class_extensions: None,
                records: vec![],
                terminator: Span::default(),
            },
            tail: Span::new(0, 4).unwrap(),
        };
        let projection = project_text_asset(&package, &DecodedAsset::UObject(object));
        assert_eq!(projection.coverage_gaps.len(), 1);
        assert_eq!(projection.coverage_gaps[0].may_contain_text, expected);
    }
}

#[test]
fn decoded_native_records_keep_text_and_unknown_values_in_the_projection() {
    use uasset_parser::property::{NativeProperty, TextHistory, TextValue};
    let package = Package::parse(include_bytes!(
        "../../../fixtures/graph-pin-text/4.27/BP_Keys.uasset"
    ))
    .unwrap();
    let object = DecodedUObject {
        native_data: Some(Box::new(PropertyValue::NativeStruct {
            fields: vec![
                NativeProperty {
                    name: "Label".into(),
                    value: PropertyValue::Text(TextValue {
                        source: "Native label".into(),
                        history: TextHistory::None,
                    }),
                },
                NativeProperty {
                    name: "Unknown".into(),
                    value: PropertyValue::Raw {
                        reason: RawReason::UnsupportedType,
                    },
                },
            ],
        })),
        object_path: ObjectPath::new("Fixture.Asset"),
        class_path: ObjectPath::new("/Script/Fixture.Asset"),
        object_guid: None,
        properties: PropertyStream {
            class_extensions: None,
            records: vec![],
            terminator: Span::default(),
        },
        tail: Span::default(),
    };
    let projection = project_text_asset(&package, &DecodedAsset::UObject(object));
    assert_eq!(projection.occurrences.len(), 1);
    assert_eq!(projection.occurrences[0].source, "Native label");
    assert_eq!(projection.coverage_gaps.len(), 1);
    assert!(projection.coverage_gaps[0].may_contain_text);
}
