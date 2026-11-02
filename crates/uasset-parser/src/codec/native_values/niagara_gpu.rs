//! Native Niagara shader parameter descriptions, including historical serializer gates.
use super::saved_structs::named;
use super::*;

pub(in crate::codec) fn applies(ty: &PropertyTypeName, package: &Package) -> bool {
    let Some(identity) = ty.parameters.first() else {
        return false;
    };
    let Some(name) = package.resolve_name_str(identity.name) else {
        return false;
    };
    let module = match name {
        "NiagaraDataInterfaceGPUParamInfo" | "NiagaraDataInterfaceGeneratedFunction" => {
            "/Script/NiagaraShader"
        }
        "NiagaraVariableCommonReference" if package.summary.versions.ue5 != 0 => {
            "/Script/NiagaraCore"
        }
        _ => return false,
    };
    let versions = &package.summary.versions;
    if versions.ue4 != crate::version::VersionContext::LATEST_SUPPORTED_UE4
        || !matches!(versions.ue5, 0 | 1000..=1018)
    {
        return false;
    }
    let saved_module = identity
        .parameters
        .first()
        .and_then(|module| package.resolve_name_str(module.name));
    if saved_module != Some(module)
        && !(saved_module.is_none() && versions.uses_legacy_property_tags())
    {
        return false;
    }
    // NiagaraCustomVersion.h: latest known versions in UE4.27 and UE5.7/5.8.
    custom_version(package, [0xFCF57AFA, 0x50764283, 0xB9A9E658, 0xFFA02D32]).unwrap_or(-1)
        <= if versions.ue5 == 0 { 68 } else { 93 }
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
    let version =
        custom_version(package, [0xFCF57AFA, 0x50764283, 0xB9A9E658, 0xFFA02D32]).unwrap_or(-1);
    let mut probe = reader.clone();
    let value = match name {
        "NiagaraVariableCommonReference" => reference(&mut probe, package, path)?,
        "NiagaraDataInterfaceGeneratedFunction" => function(&mut probe, package, path, version)?,
        "NiagaraDataInterfaceGPUParamInfo" => {
            // NiagaraShader.cpp, UE4.27/5.7/5.8. ShaderParametersOffset is not saved
            // by this native serializer, despite being a reflected field in UE5.
            let mut fields = vec![
                named(
                    "DataInterfaceHLSLSymbol",
                    PropertyValue::String(probe.read_fstring(path).ok()?),
                ),
                named(
                    "DIClassName",
                    PropertyValue::String(probe.read_fstring(path).ok()?),
                ),
            ];
            if version >= 55 {
                // AddGeneratedFunctionsToGPUParamInfo.
                let count = probe.read_count(path).ok()?;
                let capacity = probe
                    .checked_vec_capacity::<PropertyValue>(count, 16, path)
                    .ok()?;
                let mut values = Vec::with_capacity(capacity);
                for _ in 0..count {
                    values.push(function(&mut probe, package, path, version)?);
                }
                fields.push(named("GeneratedFunctions", PropertyValue::Array(values)));
            }
            PropertyValue::NativeStruct { fields }
        }
        _ => return None,
    };
    *reader = probe;
    Some(value)
}

fn name(reader: &mut Reader<'_>, package: &Package, path: &str) -> Option<PropertyValue> {
    let name = reader.read_name_ref(path).ok()?;
    package.resolve_name_cow(name)?;
    Some(PropertyValue::Name(name))
}

fn reference(reader: &mut Reader<'_>, package: &Package, path: &str) -> Option<PropertyValue> {
    // NiagaraCoreModule.cpp, UE5.7/5.8: FName then persistent UObject reference.
    let name = name(reader, package, path)?;
    let object = PackageIndex::from_raw(reader.read_i32(path).ok()?);
    if object != PackageIndex::Null {
        package.resolve_index(object)?;
    }
    Some(PropertyValue::NativeStruct {
        fields: vec![
            named("Name", name),
            named("UnderlyingType", PropertyValue::ObjectRef(object)),
        ],
    })
}

fn function(
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    version: i32,
) -> Option<PropertyValue> {
    // NiagaraShader.cpp, all three engines; Tuple.h serializes Key then Value.
    let definition = name(reader, package, path)?;
    let instance = reader.read_fstring(path).ok()?;
    let count = reader.read_count(path).ok()?;
    let capacity = reader
        .checked_vec_capacity::<PropertyValue>(count, 16, path)
        .ok()?;
    let mut specifiers = Vec::with_capacity(capacity);
    for _ in 0..count {
        specifiers.push(PropertyValue::NativeStruct {
            fields: vec![
                named("Key", name(reader, package, path)?),
                named("Value", name(reader, package, path)?),
            ],
        });
    }
    let mut fields = vec![
        named("DefinitionName", definition),
        named("InstanceName", PropertyValue::String(instance)),
        named("Specifiers", PropertyValue::Array(specifiers)),
    ];
    if package.summary.versions.ue5 != 0 {
        if version >= 77 {
            // AddVariadicParametersToGPUFunctionInfo.
            for field in ["VariadicInputs", "VariadicOutputs"] {
                let count = reader.read_count(path).ok()?;
                let capacity = reader
                    .checked_vec_capacity::<PropertyValue>(count, 12, path)
                    .ok()?;
                let mut values = Vec::with_capacity(capacity);
                for _ in 0..count {
                    values.push(reference(reader, package, path)?);
                }
                fields.push(named(field, PropertyValue::Array(values)));
            }
        }
        if version >= 91 {
            // SerializeUsageBitMaskToGPUFunctionInfo.
            fields.push(named(
                "MiscUsageBitMask",
                PropertyValue::UInt(reader.read_u16(path).ok()?.into()),
            ));
        }
    }
    Some(PropertyValue::NativeStruct { fields })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::{CustomVersion, test_package};
    use crate::test_support::{name_ref, push_fstring, push_i32};

    fn package(ue5: i32, version: i32) -> (Package, PropertyTypeName) {
        let mut package = test_package(
            [
                "StructProperty",
                "NiagaraDataInterfaceGPUParamInfo",
                "/Script/NiagaraShader",
                "/Script/NiagaraCore",
                "/Script/Fixture",
                "FixtureFunction",
                "FixtureKey",
                "FixtureValue",
                "FixtureVariable",
                "None",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        package.summary.versions.ue5 = ue5;
        package.summary.custom_versions.push(CustomVersion {
            key: Guid {
                a: 0xFCF57AFA,
                b: 0x50764283,
                c: 0xB9A9E658,
                d: 0xFFA02D32,
            },
            version,
            friendly_name: None,
        });
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

    fn function_bytes(ue5: i32, version: i32) -> Vec<u8> {
        let mut bytes = vec![];
        for word in [5, 0] {
            push_i32(&mut bytes, word);
        }
        push_fstring(&mut bytes, "FixtureInstance");
        for word in [1, 6, 0, 7, 0] {
            push_i32(&mut bytes, word);
        }
        if ue5 != 0 && version >= 77 {
            for _ in 0..2 {
                for word in [1, 8, 0, 0] {
                    push_i32(&mut bytes, word);
                }
            }
        }
        if ue5 != 0 && version >= 91 {
            bytes.extend_from_slice(&0x1234_u16.to_le_bytes());
        }
        bytes
    }

    fn bytes(ue5: i32, version: i32) -> Vec<u8> {
        let mut bytes = vec![];
        push_fstring(&mut bytes, "FixtureSymbol");
        push_fstring(&mut bytes, "FixtureClass");
        if version >= 55 {
            push_i32(&mut bytes, 1);
            bytes.extend_from_slice(&function_bytes(ue5, version));
        }
        bytes
    }

    #[test]
    fn shader_parameters_pin_generated_variadic_and_usage_mask_version_gates() {
        for ue5 in [0, 1017, 1018] {
            for version in [-1, 54, 55, 68, 76, 77, 90, 91, 93] {
                if ue5 == 0 && version > 68 {
                    continue;
                }
                let (package, ty) = package(ue5, version);
                let bytes = bytes(ue5, version);
                let mut reader = Reader::new(&bytes);
                let value = optional(&ty, &mut reader, &package, "Fixture").unwrap();
                assert_eq!(reader.remaining(), 0);
                assert_eq!(
                    field(&value, "DataInterfaceHLSLSymbol"),
                    Some(&PropertyValue::String("FixtureSymbol".into()))
                );
                assert!(field(&value, "ShaderParametersOffset").is_none());
                if version < 55 {
                    assert!(field(&value, "GeneratedFunctions").is_none());
                } else {
                    let PropertyValue::Array(functions) =
                        field(&value, "GeneratedFunctions").unwrap()
                    else {
                        panic!("functions");
                    };
                    assert_eq!(functions.len(), 1);
                    assert_eq!(
                        field(&functions[0], "DefinitionName"),
                        Some(&PropertyValue::Name(name_ref(5, 0)))
                    );
                    assert_eq!(
                        field(&functions[0], "VariadicInputs").is_some(),
                        ue5 != 0 && version >= 77
                    );
                    assert_eq!(
                        field(&functions[0], "MiscUsageBitMask"),
                        (ue5 != 0 && version >= 91).then_some(&PropertyValue::UInt(0x1234))
                    );
                }
                for end in 0..bytes.len() {
                    let mut reader = Reader::new(&bytes[..end]);
                    assert!(
                        optional(&ty, &mut reader, &package, "Fixture").is_none(),
                        "{ue5}, {version}, {end}"
                    );
                    assert_eq!(reader.tell(), 0);
                }
                let both = [bytes.clone(), bytes].concat();
                let mut reader = Reader::new(&both);
                let value = decode_array_elements(
                    &both,
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

    #[test]
    fn standalone_functions_and_common_references_validate_names_and_objects() {
        let (mut package, mut ty) = package(1018, 93);
        package.names[1] = "NiagaraDataInterfaceGeneratedFunction".into();
        let bytes = function_bytes(1018, 93);
        assert!(optional(&ty, &mut Reader::new(&bytes), &package, "Fixture").is_some());
        for offset in [0, 4] {
            let mut bad = bytes.clone();
            bad[offset..offset + 4].copy_from_slice(&(-1_i32).to_le_bytes());
            let mut reader = Reader::new(&bad);
            assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
        package.names[1] = "NiagaraVariableCommonReference".into();
        ty.parameters[0].parameters[0].name = name_ref(3, 0);
        let bytes = [8_i32, 0, 0]
            .into_iter()
            .flat_map(i32::to_le_bytes)
            .collect::<Vec<_>>();
        let value = optional(&ty, &mut Reader::new(&bytes), &package, "Fixture").unwrap();
        assert_eq!(
            field(&value, "UnderlyingType"),
            Some(&PropertyValue::ObjectRef(PackageIndex::Null))
        );
        for offset in [0, 8] {
            let mut bad = bytes.clone();
            bad[offset..offset + 4].copy_from_slice(&i32::MAX.to_le_bytes());
            let mut reader = Reader::new(&bad);
            assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
    }

    #[test]
    fn shader_recipe_rejects_unknown_versions_namespaces_and_impossible_counts() {
        let (original, original_ty) = package(1018, 93);
        let bytes = bytes(1018, 93);
        for case in 0..4 {
            let mut package = original.clone();
            let mut ty = original_ty.clone();
            match case {
                0 => package.summary.custom_versions.last_mut().unwrap().version = 94,
                1 => ty.parameters[0].parameters[0].name = name_ref(4, 0),
                2 => ty.parameters[0].parameters.clear(),
                _ => package.summary.versions.ue5 = 1019,
            }
            let mut reader = Reader::new(&bytes);
            assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
        let count_at = bytes.len() - function_bytes(1018, 93).len() - 4;
        for count in [-1_i32, i32::MAX] {
            let mut bad = bytes.clone();
            bad[count_at..count_at + 4].copy_from_slice(&count.to_le_bytes());
            let mut reader = Reader::new(&bad);
            assert!(optional(&original_ty, &mut reader, &original, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
    }
}
