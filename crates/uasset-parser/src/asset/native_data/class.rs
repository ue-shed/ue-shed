//! Uncooked UBlueprintGeneratedClass native records. Unknown layouts remain opaque.
use super::*;
use crate::archive::Reader;
use crate::property::NativeProperty;
use std::borrow::Cow;

pub(super) fn is_blueprint_class(export: &Export) -> bool {
    // UE 4.27 Animation/AnimBlueprintGeneratedClass.cpp and
    // UMG/Private/WidgetBlueprintGeneratedClass.cpp, ::Serialize: only Super plus
    // custom-version registration, with no additional persistent native data.
    export.class_path.as_ref().is_some_and(|class| {
        matches!(
            class.as_str(),
            "/Script/Engine.BlueprintGeneratedClass"
                | "/Script/Engine.AnimBlueprintGeneratedClass"
                | "/Script/UMG.WidgetBlueprintGeneratedClass"
        )
    })
}

pub(crate) fn property_guids(
    export: &Export,
    context: &AssetDecodeContext<'_>,
    properties: &mut PropertyStream,
) {
    if !context.package.summary.versions.uses_legacy_property_tags() || !is_blueprint_class(export)
    {
        return;
    }
    // UE 4.27 / 5.7 Engine/Classes/Engine/BlueprintGeneratedClass.h:
    // PropertyGuids is TMap<FName, FGuid>. PropertyMap.cpp omits the struct identity
    // in legacy tags; this exact owning declaration supplies it without guessing.
    for record in &mut properties.records {
        if context.package.resolve_name(record.name).as_deref() != Some("PropertyGuids")
            || context
                .package
                .resolve_name(record.type_name.name)
                .as_deref()
                != Some("MapProperty")
            || !matches!(record.value, PropertyValue::Raw { .. })
        {
            continue;
        }
        if let Ok(value) = read_property_guids(context, record.payload) {
            record.value = value;
        }
    }
}

fn read_property_guids(
    context: &AssetDecodeContext<'_>,
    payload: Span,
) -> Result<PropertyValue, AssetError> {
    let mut reader = Reader::new(context.source).bounded(payload, "PropertyGuids")?;
    let removed = reader.read_i32("PropertyGuids.KeysToRemove.Count")?;
    if removed < -1 {
        return Err(invalid_layout(
            &ObjectPath::new("PropertyGuids"),
            "removed key count",
        ));
    }
    if removed > 0 {
        reader.checked_vec_capacity::<crate::archive::NameRef>(
            removed as usize,
            8,
            "PropertyGuids.KeysToRemove",
        )?;
        for _ in 0..removed {
            let name = reader.read_name_ref("PropertyGuids.RemovedKey")?;
            if context.package.resolve_name(name).is_none() {
                return Err(invalid_layout(
                    &ObjectPath::new("PropertyGuids"),
                    "removed key",
                ));
            }
        }
    }
    let count = reader.read_count("PropertyGuids.Count")?;
    let capacity =
        reader.checked_vec_capacity::<crate::property::MapEntry>(count, 24, "PropertyGuids")?;
    let mut entries = Vec::with_capacity(capacity);
    for _ in 0..count {
        let name = reader.read_name_ref("PropertyGuids.Key")?;
        if context.package.resolve_name(name).is_none() {
            return Err(invalid_layout(&ObjectPath::new("PropertyGuids"), "key"));
        }
        entries.push(crate::property::MapEntry {
            key: PropertyValue::Name(name),
            value: PropertyValue::Guid(reader.read_guid("PropertyGuids.Value")?),
        });
    }
    if reader.remaining() != 0 {
        return Err(invalid_layout(
            &ObjectPath::new("PropertyGuids"),
            "trailing bytes",
        ));
    }
    Ok(PropertyValue::Map(entries))
}

pub(super) fn decode(
    reader: &mut Reader<'_>,
    context: &AssetDecodeContext<'_>,
    path: &ObjectPath,
) -> Result<(Option<Guid>, PropertyValue), AssetError> {
    // UE 4.27 CoreUObject/Private/UObject/Class.cpp, UField::Serialize,
    // UStruct::Serialize/SerializeProperties and UClass::Serialize. FProperties=4;
    // RemoveUField_Next=29. BlueprintGeneratedClass.cpp, UBlueprintGeneratedClass::Serialize
    // adds no persistent fields in unfiltered packages. UE 5.6–5.8 Class.cpp retains
    // the same persistent UStruct/UClass fields; unknown field layouts stay opaque.
    let version = |words| {
        context
            .package
            .summary
            .custom_versions
            .iter()
            .find(|v| [v.key.a, v.key.b, v.key.c, v.key.d] == words)
            .map_or(-1, |v| v.version)
    };
    if !matches!(context.package.summary.versions.ue5, 0 | 1000..=1018)
        || context
            .package
            .summary
            .versions
            .package_flags
            .contains(crate::version::PackageFlags::FILTER_EDITOR_ONLY)
        || version([0x375EC13C, 0x06E448FB, 0xB50084F0, 0x262A717E]) < 4
        || version([0xCFFC743F, 0x43B04480, 0x939114DF, 0x171D2073]) < 29
    {
        return Err(invalid_layout(path, "legacy class custom versions"));
    }
    let guid = consume_inline_object_guid_footer(reader, path)?;
    // Class scripts normally live in UFunction exports. Do not hide a class-level
    // script: decode_struct_definition rejects any nonzero bytecode/storage size.
    let fields = decode_struct_definition(reader, context, path)?;
    let mut data = vec![NativeProperty {
        name: Cow::Borrowed("ChildProperties"),
        value: PropertyValue::Array(
            fields
                .into_iter()
                .map(|field| PropertyValue::NativeStruct {
                    fields: vec![
                        NativeProperty {
                            name: Cow::Borrowed("Name"),
                            value: PropertyValue::Name(field.name),
                        },
                        NativeProperty {
                            name: Cow::Borrowed("Type"),
                            value: PropertyValue::Name(field.type_name),
                        },
                    ],
                })
                .collect(),
        ),
    }];
    let count = reader.read_count(&format!("{path}.FuncMap.Count"))?;
    let capacity =
        reader.checked_vec_capacity::<crate::property::MapEntry>(count, 12, path.as_str())?;
    let mut functions = Vec::with_capacity(capacity);
    for index in 0..count {
        let name = reader.read_name_ref(&format!("{path}.FuncMap[{index}].Name"))?;
        if context.package.resolve_name(name).is_none() {
            return Err(invalid_layout(path, "function name"));
        }
        let function = reference(reader, context, path, "Function")?;
        functions.push(crate::property::MapEntry {
            key: PropertyValue::Name(name),
            value: function,
        });
    }
    data.push(NativeProperty {
        name: Cow::Borrowed("FuncMap"),
        value: PropertyValue::Map(functions),
    });
    data.push(NativeProperty {
        name: Cow::Borrowed("ClassFlags"),
        value: PropertyValue::UInt(u64::from(reader.read_u32(path.as_str())?)),
    });
    data.push(NativeProperty {
        name: Cow::Borrowed("ClassWithin"),
        value: reference(reader, context, path, "ClassWithin")?,
    });
    for field in ["ClassConfigName", "ClassGeneratedBy"] {
        let value = if field == "ClassConfigName" {
            let name = reader.read_name_ref(&format!("{path}.{field}"))?;
            if context.package.resolve_name(name).is_none() {
                return Err(invalid_layout(path, field));
            }
            PropertyValue::Name(name)
        } else {
            reference(reader, context, path, field)?
        };
        data.push(NativeProperty {
            name: Cow::Borrowed(field),
            value,
        });
    }
    let count = reader.read_count(&format!("{path}.Interfaces.Count"))?;
    let capacity = reader.checked_vec_capacity::<PropertyValue>(count, 12, path.as_str())?;
    let mut interfaces = Vec::with_capacity(capacity);
    for _ in 0..count {
        interfaces.push(PropertyValue::NativeStruct {
            fields: vec![
                NativeProperty {
                    name: Cow::Borrowed("Class"),
                    value: reference(reader, context, path, "InterfaceClass")?,
                },
                NativeProperty {
                    name: Cow::Borrowed("PointerOffset"),
                    value: PropertyValue::Int(i64::from(reader.read_i32(path.as_str())?)),
                },
                NativeProperty {
                    name: Cow::Borrowed("ImplementedByK2"),
                    value: PropertyValue::Bool(read_archive_bool(reader, path.as_str())?),
                },
            ],
        });
    }
    data.push(NativeProperty {
        name: Cow::Borrowed("Interfaces"),
        value: PropertyValue::Array(interfaces),
    });
    data.push(NativeProperty {
        name: Cow::Borrowed("DeprecatedForceScriptOrder"),
        value: PropertyValue::Bool(read_archive_bool(reader, path.as_str())?),
    });
    let dummy = reader.read_name_ref(&format!("{path}.Dummy"))?;
    if context.package.resolve_name(dummy).as_deref() != Some("None") {
        return Err(invalid_layout(path, "class dummy name"));
    }
    if read_archive_bool(reader, &format!("{path}.Cooked"))? {
        return Err(invalid_layout(path, "cooked class"));
    }
    data.push(NativeProperty {
        name: Cow::Borrowed("ClassDefaultObject"),
        value: reference(reader, context, path, "ClassDefaultObject")?,
    });
    Ok((guid, PropertyValue::NativeStruct { fields: data }))
}

fn reference(
    reader: &mut Reader<'_>,
    context: &AssetDecodeContext<'_>,
    path: &ObjectPath,
    field: &str,
) -> Result<PropertyValue, AssetError> {
    let index = read_package_index(reader, &format!("{path}.{field}"))?;
    if index != PackageIndex::Null && context.package.resolve_index(index).is_none() {
        return Err(invalid_layout(path, field));
    }
    Ok(PropertyValue::ObjectRef(index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::{CustomVersion, test_package};
    use crate::schema::embedded_source_model;

    #[test]
    fn ue5_class_record_retains_legacy_layout_and_rejection_falls_back_without_export_errors() {
        let mut package = test_package(vec!["None".into()]);
        for (words, version) in [
            ([0x375EC13C, 0x06E448FB, 0xB50084F0, 0x262A717E], 4),
            ([0xCFFC743F, 0x43B04480, 0x939114DF, 0x171D2073], 29),
        ] {
            package.summary.custom_versions.push(CustomVersion {
                key: Guid {
                    a: words[0],
                    b: words[1],
                    c: words[2],
                    d: words[3],
                },
                version,
                friendly_name: None,
            });
        }
        let bytes = vec![0; 72];
        let path = ObjectPath::new("Fixture.GeneratedClass");
        for version in [1016, 1017, 1018] {
            package.summary.versions.ue5 = version;
            let context = AssetDecodeContext {
                property_filter: None,
                source: &bytes,
                package: &package,
                schemas: embedded_source_model(),
            };
            let mut reader = Reader::new(&bytes);
            assert!(decode(&mut reader, &context, &path).is_ok());
            assert_eq!(reader.remaining(), 0);
            for end in 0..bytes.len() {
                assert!(decode(&mut Reader::new(&bytes[..end]), &context, &path).is_err());
                let export = crate::package::test_export(
                    end as u64,
                    path.as_str(),
                    "/Script/Engine.BlueprintGeneratedClass",
                );
                let properties = PropertyStream {
                    class_extensions: None,
                    records: vec![],
                    terminator: Span::default(),
                };
                assert!(
                    super::super::object::decode(
                        &export,
                        &context,
                        &properties,
                        &mut Reader::new(&bytes[..end])
                    )
                    .is_ok()
                );
            }
        }
        for version in [999, 1019] {
            package.summary.versions.ue5 = version;
            let context = AssetDecodeContext {
                property_filter: None,
                source: &bytes,
                package: &package,
                schemas: embedded_source_model(),
            };
            assert!(decode(&mut Reader::new(&bytes), &context, &path).is_err());
        }
    }

    #[test]
    fn legacy_property_guids_use_the_declared_native_guid_value_layout() {
        let package = test_package(vec!["None".into(), "Value".into()]);
        let mut bytes = Vec::new();
        for word in [0_i32, 1, 1, 0, 10, 20, 30, 40] {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        let context = AssetDecodeContext {
            property_filter: None,
            source: &bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let PropertyValue::Map(values) =
            read_property_guids(&context, Span::new(0, bytes.len() as u64).unwrap()).unwrap()
        else {
            panic!("map");
        };
        assert_eq!(values.len(), 1);
        assert_eq!(
            values[0].value,
            PropertyValue::Guid(Guid {
                a: 10,
                b: 20,
                c: 30,
                d: 40
            })
        );
        for end in 0..bytes.len() {
            assert!(read_property_guids(&context, Span::new(0, end as u64).unwrap()).is_err());
        }
    }

    #[test]
    fn ue427_empty_class_native_record_is_bounded_and_script_is_never_skipped() {
        let mut package = test_package(vec!["None".into()]);
        package.summary.versions.ue5 = 0;
        for (words, version) in [
            ([0x375EC13C, 0x06E448FB, 0xB50084F0, 0x262A717E], 4),
            ([0xCFFC743F, 0x43B04480, 0x939114DF, 0x171D2073], 31),
        ] {
            package.summary.custom_versions.push(CustomVersion {
                key: Guid {
                    a: words[0],
                    b: words[1],
                    c: words[2],
                    d: words[3],
                },
                version,
                friendly_name: None,
            });
        }
        let context = AssetDecodeContext {
            property_filter: None,
            source: &[],
            package: &package,
            schemas: embedded_source_model(),
        };
        let path = ObjectPath::new("Fixture.GeneratedClass");
        // GUID marker; UStruct super/children/fields/script sizes; UClass function map,
        // flags, within, config FName, generated-by, interfaces, force-script-order,
        // dummy FName, cooked bool, default object. All empty/null is 72 bytes.
        let bytes = vec![0; 72];
        let mut reader = Reader::new(&bytes);
        assert!(decode(&mut reader, &context, &path).is_ok());
        assert_eq!(reader.remaining(), 0);
        let properties = PropertyStream {
            class_extensions: None,
            records: vec![],
            terminator: Span::default(),
        };
        for class in [
            "/Script/Engine.BlueprintGeneratedClass",
            "/Script/Engine.AnimBlueprintGeneratedClass",
            "/Script/UMG.WidgetBlueprintGeneratedClass",
        ] {
            let export =
                crate::package::test_export(bytes.len() as u64, "Fixture.GeneratedClass", class);
            let (_, native, tail) = super::super::object::decode(
                &export,
                &context,
                &properties,
                &mut Reader::new(&bytes),
            )
            .unwrap();
            assert!(native.is_some());
            assert!(tail.is_empty());
        }
        for end in 0..bytes.len() {
            assert!(
                decode(&mut Reader::new(&bytes[..end]), &context, &path).is_err(),
                "{end}"
            );
        }
        for offset in [16, 20] {
            let mut script = bytes.clone();
            script[offset..offset + 4].copy_from_slice(&1_i32.to_le_bytes());
            assert!(decode(&mut Reader::new(&script), &context, &path).is_err());
        }
    }
}
