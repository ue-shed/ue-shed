//! Native material connections and saved constants, without evaluating a material graph.
use super::saved_structs::named;
use super::*;

pub(in crate::codec) fn applies(ty: &PropertyTypeName, package: &Package) -> bool {
    let Some(identity) = ty.parameters.first() else {
        return false;
    };
    let Some(name) = package.resolve_name_str(identity.name) else {
        return false;
    };
    if !matches!(
        name,
        "ExpressionInput"
            | "MaterialAttributesInput"
            | "ColorMaterialInput"
            | "ScalarMaterialInput"
            | "VectorMaterialInput"
            | "Vector2MaterialInput"
            | "ShadingModelMaterialInput"
            | "SubstrateMaterialInput"
    ) {
        return false;
    }
    let versions = &package.summary.versions;
    if versions.ue4 != crate::version::VersionContext::LATEST_SUPPORTED_UE4
        || !matches!(versions.ue5, 0 | 1000..=1018)
        || versions
            .package_flags
            .contains(crate::version::PackageFlags::FILTER_EDITOR_ONLY)
        || versions
            .package_flags
            .contains(crate::version::PackageFlags::COOKED)
        || (versions.ue5 == 0 && name == "SubstrateMaterialInput")
    {
        return false;
    }
    let module = identity
        .parameters
        .first()
        .and_then(|module| package.resolve_name_str(module.name));
    if module != Some("/Script/Engine")
        && !(module.is_none() && versions.uses_legacy_property_tags())
    {
        return false;
    }
    // CoreObjectVersion.h / DevObjectVersion.cpp, UE 4.27 / 5.7 / 5.8.
    matches!(
        custom_version(package, [0x375EC13C, 0x06E448FB, 0xB50084F0, 0x262A717E]),
        Some(1..)
    )
}

pub(super) fn optional(
    ty: &PropertyTypeName,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
) -> Option<PropertyValue> {
    if !applies(ty, package) {
        return None;
    }
    let name = package.resolve_name_str(ty.parameters.first()?.name)?;
    let mut probe = reader.clone();
    // MaterialShared.cpp SerializeExpressionInput, all three reference engines.
    // UE4 editor-filtered saves omit Expression and append ExpressionName. Those
    // saves are deliberately excluded above; the uncooked editor prefix is shared.
    let expression = PackageIndex::from_raw(probe.read_i32(path).ok()?);
    if expression != PackageIndex::Null {
        package.resolve_index(expression)?;
    }
    let mut fields = vec![
        named("Expression", PropertyValue::ObjectRef(expression)),
        named(
            "OutputIndex",
            PropertyValue::Int(probe.read_i32(path).ok()?.into()),
        ),
    ];
    let input_name = if custom_version(package, [0xCFFC743F, 0x43B04480, 0x939114DF, 0x171D2073])
        .is_some_and(|version| version >= 31)
    {
        let name = probe.read_name_ref(path).ok()?;
        package.resolve_name_cow(name)?;
        PropertyValue::Name(name)
    } else {
        PropertyValue::String(probe.read_fstring(path).ok()?)
    };
    fields.push(named("InputName", input_name));
    for name in ["Mask", "MaskR", "MaskG", "MaskB", "MaskA"] {
        fields.push(named(
            name,
            PropertyValue::Int(probe.read_i32(path).ok()?.into()),
        ));
    }
    if !matches!(name, "ExpressionInput" | "MaterialAttributesInput") {
        fields.push(named(
            "UseConstant",
            PropertyValue::Bool(read_archive_bool(&mut probe, path).ok()?),
        ));
        let constant = match name {
            "ScalarMaterialInput" => PropertyValue::Float(probe.read_f32(path).ok()?),
            "ShadingModelMaterialInput" | "SubstrateMaterialInput" => {
                PropertyValue::UInt(probe.read_u32(path).ok()?.into())
            }
            "VectorMaterialInput" | "Vector2MaterialInput" => {
                // UE4 FVector/FVector2D constants are floats. UE5 explicitly uses
                // FVector3f/FVector2f here, independently of large-world coordinates.
                let count = if name == "VectorMaterialInput" { 3 } else { 2 };
                let mut components = vec![];
                for name in ["X", "Y", "Z"].into_iter().take(count) {
                    components.push(named(
                        name,
                        PropertyValue::Float(probe.read_f32(path).ok()?),
                    ));
                }
                PropertyValue::NativeStruct { fields: components }
            }
            "ColorMaterialInput"
                if package.summary.versions.ue5 != 0
                    && custom_version(
                        package,
                        [0x601D1886, 0xAC644F84, 0xAA16D3DE, 0x0DEAC7D6],
                    )
                    .is_some_and(|version| version >= 171) =>
            {
                // MaterialInputUsesLinearColor=171. Preserve the saved color type,
                // rather than applying Unreal's post-load color conversion.
                PropertyValue::LinearColor(LinearColorValue {
                    r: probe.read_f32(path).ok()?,
                    g: probe.read_f32(path).ok()?,
                    b: probe.read_f32(path).ok()?,
                    a: probe.read_f32(path).ok()?,
                })
            }
            "ColorMaterialInput" => {
                let b = probe.read_u8(path).ok()?;
                let g = probe.read_u8(path).ok()?;
                let r = probe.read_u8(path).ok()?;
                let a = probe.read_u8(path).ok()?;
                PropertyValue::Color(ColorValue { r, g, b, a })
            }
            _ => return None,
        };
        fields.push(named("Constant", constant));
    }
    *reader = probe;
    Some(PropertyValue::NativeStruct { fields })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::{CustomVersion, test_package};
    use crate::test_support::{name_ref, push_f32, push_fstring, push_i32};

    fn version(package: &mut Package, key: [u32; 4], version: i32) {
        package.summary.custom_versions.push(CustomVersion {
            key: Guid {
                a: key[0],
                b: key[1],
                c: key[2],
                d: key[3],
            },
            version,
            friendly_name: None,
        });
    }

    fn package(name: &str, ue5: i32, pins: i32, color: i32) -> (Package, PropertyTypeName) {
        let mut package = test_package(
            [
                "StructProperty",
                name,
                "/Script/Engine",
                "/Script/Fixture",
                "FixtureInput",
                "None",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        package.summary.versions.ue5 = ue5;
        package.summary.custom_versions.clear();
        version(
            &mut package,
            [0x375EC13C, 0x06E448FB, 0xB50084F0, 0x262A717E],
            1,
        );
        version(
            &mut package,
            [0xCFFC743F, 0x43B04480, 0x939114DF, 0x171D2073],
            pins,
        );
        version(
            &mut package,
            [0x601D1886, 0xAC644F84, 0xAA16D3DE, 0x0DEAC7D6],
            color,
        );
        let ty = PropertyTypeName {
            name: name_ref(0, 0),
            parameters: vec![PropertyTypeName {
                name: name_ref(1, 0),
                parameters: vec![PropertyTypeName {
                    name: name_ref(2, 0),
                    parameters: vec![],
                }],
            }],
        };
        (package, ty)
    }

    fn bytes(name: &str, pins: bool, linear: bool) -> Vec<u8> {
        let mut bytes = vec![];
        push_i32(&mut bytes, 0);
        push_i32(&mut bytes, 2);
        if pins {
            push_i32(&mut bytes, 4);
            push_i32(&mut bytes, 0);
        } else {
            push_fstring(&mut bytes, "FixtureInput");
        }
        for mask in [1, 1, 0, 1, 0] {
            push_i32(&mut bytes, mask);
        }
        if !matches!(name, "ExpressionInput" | "MaterialAttributesInput") {
            push_i32(&mut bytes, 1);
            match name {
                "ColorMaterialInput" if !linear => bytes.extend_from_slice(&[30, 20, 10, 255]),
                "ColorMaterialInput" => {
                    for value in [0.1, 0.2, 0.3, 1.0] {
                        push_f32(&mut bytes, value);
                    }
                }
                "VectorMaterialInput" => {
                    for value in [1.0, 2.0, 3.0] {
                        push_f32(&mut bytes, value);
                    }
                }
                "Vector2MaterialInput" => {
                    for value in [1.0, 2.0] {
                        push_f32(&mut bytes, value);
                    }
                }
                "ScalarMaterialInput" => push_f32(&mut bytes, 0.5),
                _ => push_i32(&mut bytes, 7),
            }
        }
        bytes
    }

    #[test]
    fn material_inputs_pin_connections_constants_and_both_historical_version_gates() {
        for ue5 in [0, 1017, 1018] {
            for pins in [30, 31] {
                for color in [170, 171] {
                    for name in [
                        "ExpressionInput",
                        "MaterialAttributesInput",
                        "ColorMaterialInput",
                        "ScalarMaterialInput",
                        "VectorMaterialInput",
                        "Vector2MaterialInput",
                        "ShadingModelMaterialInput",
                        "SubstrateMaterialInput",
                    ] {
                        if ue5 == 0 && name == "SubstrateMaterialInput" {
                            continue;
                        }
                        let (package, ty) = package(name, ue5, pins, color);
                        let bytes = bytes(name, pins >= 31, ue5 != 0 && color >= 171);
                        let mut reader = Reader::new(&bytes);
                        let value = optional(&ty, &mut reader, &package, "Fixture").unwrap();
                        assert_eq!(reader.remaining(), 0);
                        assert_eq!(
                            field(&value, "Expression"),
                            Some(&PropertyValue::ObjectRef(PackageIndex::Null))
                        );
                        assert_eq!(field(&value, "OutputIndex"), Some(&PropertyValue::Int(2)));
                        assert_eq!(field(&value, "MaskB"), Some(&PropertyValue::Int(1)));
                        assert_eq!(
                            field(&value, "InputName"),
                            Some(&if pins >= 31 {
                                PropertyValue::Name(name_ref(4, 0))
                            } else {
                                PropertyValue::String("FixtureInput".into())
                            })
                        );
                        match name {
                            "ColorMaterialInput" if ue5 == 0 || color < 171 => assert_eq!(
                                field(&value, "Constant"),
                                Some(&PropertyValue::Color(ColorValue {
                                    r: 10,
                                    g: 20,
                                    b: 30,
                                    a: 255
                                }))
                            ),
                            "ColorMaterialInput" => assert_eq!(
                                field(&value, "Constant"),
                                Some(&PropertyValue::LinearColor(LinearColorValue {
                                    r: 0.1,
                                    g: 0.2,
                                    b: 0.3,
                                    a: 1.0
                                }))
                            ),
                            "ScalarMaterialInput" => assert_eq!(
                                field(&value, "Constant"),
                                Some(&PropertyValue::Float(0.5))
                            ),
                            "VectorMaterialInput" | "Vector2MaterialInput" => assert_eq!(
                                field(field(&value, "Constant").unwrap(), "X"),
                                Some(&PropertyValue::Float(1.0))
                            ),
                            "ShadingModelMaterialInput" | "SubstrateMaterialInput" => {
                                assert_eq!(field(&value, "Constant"), Some(&PropertyValue::UInt(7)))
                            }
                            _ => assert!(field(&value, "Constant").is_none()),
                        }
                        for end in 0..bytes.len() {
                            let mut reader = Reader::new(&bytes[..end]);
                            assert!(
                                optional(&ty, &mut reader, &package, "Fixture").is_none(),
                                "{name}: {end}"
                            );
                            assert_eq!(reader.tell(), 0);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn ambiguous_identity_archive_flags_and_invalid_fields_preserve_fallback() {
        let (original, ty) = package("ScalarMaterialInput", 1018, 31, 171);
        let bytes = bytes("ScalarMaterialInput", true, false);
        for index in 0..7 {
            let mut package = original.clone();
            let mut ty = ty.clone();
            if index == 0 {
                package.summary.custom_versions.remove(0);
            } else if index == 1 {
                package.summary.custom_versions[0].version = 0;
            }
            match index {
                2 => ty.parameters[0].parameters[0].name = name_ref(3, 0),
                3 => ty.parameters[0].parameters.clear(),
                4 => {
                    package.summary.versions.package_flags = crate::version::PackageFlags::from_bits(
                        crate::version::PackageFlags::FILTER_EDITOR_ONLY,
                    )
                }
                5 => {
                    package.summary.versions.package_flags = crate::version::PackageFlags::from_bits(
                        crate::version::PackageFlags::COOKED,
                    )
                }
                6 => package.summary.versions.ue5 = 1019,
                _ => {}
            }
            let mut reader = Reader::new(&bytes);
            assert!(
                optional(&ty, &mut reader, &package, "Fixture").is_none(),
                "case {index}"
            );
            assert_eq!(reader.tell(), 0);
        }
        for (offset, value) in [(0, i32::MAX), (8, i32::MAX), (12, -1), (36, 2)] {
            let mut bad = bytes.clone();
            bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            let mut reader = Reader::new(&bad);
            assert!(
                optional(&ty, &mut reader, &original, "Fixture").is_none(),
                "offset {offset}"
            );
            assert_eq!(reader.tell(), 0);
        }
    }

    #[test]
    fn native_material_arrays_preserve_each_element_boundary() {
        for ue5 in [0, 1018] {
            let (package, mut ty) = package("ScalarMaterialInput", ue5, 31, 171);
            if ue5 == 0 {
                ty.parameters[0].parameters.clear();
            }
            let element = bytes("ScalarMaterialInput", true, false);
            let bytes = [element.clone(), element].concat();
            let mut reader = Reader::new(&bytes);
            let value = decode_array_elements(
                &bytes,
                TypeSpec {
                    name: "StructProperty",
                    tree: &ty,
                    struct_guid: None,
                },
                &mut reader,
                &package,
                "Fixture",
                DecodeScope::root(None),
                2,
                if ue5 == 0 {
                    ContainerSerializer::Unknown
                } else {
                    ContainerSerializer::BinaryOrNative
                },
            )
            .unwrap();
            assert!(matches!(value, PropertyValue::Array(ref values) if values.len() == 2));
            assert_eq!(reader.remaining(), 0);
        }
    }
}
