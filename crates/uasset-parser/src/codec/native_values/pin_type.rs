use super::*;

pub(super) fn decode(
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
) -> Result<PropertyValue, PropertyError> {
    if !crate::asset::supports_blueprint_graph_package_version(&package.summary.versions)
        || !matches!(
            custom_version(package, [0xCFFC743F, 0x43B04480, 0x939114DF, 0x171D2073]),
            Some(31..)
        )
        || !matches!(
            custom_version(package, [0x9C54D522, 0xA8264FBE, 0x94210746, 0x61B482D0]),
            Some(32..)
        )
        || (package.summary.versions.ue5 != 0
            && !matches!(
                custom_version(package, [0xD89B5E42, 0x24BD4D46, 0x8412ACA8, 0xDF641779]),
                Some(0..)
            ))
    {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::UnsupportedVersion,
            "pin type requires the verified modern editor custom versions",
        ));
    }
    let mut fields = record_fields(read_layout(reader, "FEdGraphPinTypePrefix", path)?);
    let container = fields
        .iter()
        .find(|v| v.name == "ContainerType")
        .and_then(|v| {
            if let PropertyValue::UInt(v) = v.value {
                Some(v)
            } else {
                None
            }
        })
        .unwrap_or(u64::MAX);
    if container > 3 {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::MalformedData,
            "invalid pin container type",
        ));
    }
    convert_index(&mut fields, "PinSubCategoryObject");
    if container == 3 {
        let mut terminal = record_fields(read_layout(reader, "FEdGraphTerminalType", path)?);
        convert_index(&mut terminal, "TerminalSubCategoryObject");
        fields.push(NativeProperty {
            name: "PinValueType".into(),
            value: PropertyValue::NativeStruct { fields: terminal },
        });
    }
    // UE 4.27 / 5.7 EdGraphPin.cpp, FEdGraphPinType::Serialize. UE4 has
    // no UE5ReleaseStream SerializeFloatPinDefaultValuesAsSinglePrecision flag.
    let suffix = if package.summary.versions.ue5 == 0
        || matches!(
            custom_version(package, [0xD89B5E42, 0x24BD4D46, 0x8412ACA8, 0xDF641779]),
            Some(..36)
        ) {
        static UE4_SUFFIX: once_cell::sync::Lazy<crate::native::NativeLayout> =
            once_cell::sync::Lazy::new(|| {
                let Some(crate::native::NativeLayout::Record { fields }) =
                    embedded_source_model().native_layout("FEdGraphPinTypeSuffix")
                else {
                    unreachable!()
                };
                crate::native::NativeLayout::Record {
                    fields: fields
                        .iter()
                        .filter(|field| field.name != "bSerializeAsSinglePrecisionFloat")
                        .cloned()
                        .collect(),
                }
            });
        decode_native(reader, &UE4_SUFFIX, path).map_err(|failure| match failure {
            NativeError::Archive(failure) => PropertyError::from(failure),
            NativeError::Layout(message) => error(
                reader,
                path,
                PropertyErrorKind::UnsupportedCapability,
                message,
            ),
        })?
    } else {
        read_layout(reader, "FEdGraphPinTypeSuffix", path)?
    };
    let mut suffix = record_fields(suffix);
    convert_index(&mut suffix, "MemberParent");
    if let Some(field) = suffix.iter_mut().find(|v| v.name == "MemberGuid")
        && let PropertyValue::NativeStruct { fields } = &field.value
    {
        let words: Vec<_> = fields
            .iter()
            .filter_map(|v| {
                if let PropertyValue::Int(v) = v.value {
                    Some(v as u32)
                } else {
                    None
                }
            })
            .collect();
        if words.len() == 4 {
            field.value = PropertyValue::Guid(crate::archive::Guid {
                a: words[0],
                b: words[1],
                c: words[2],
                d: words[3],
            });
        }
    }
    fields.extend(suffix);
    validate_references(&fields, reader, package, path)?;
    Ok(PropertyValue::NativeStruct { fields })
}

fn validate_references(
    fields: &[NativeProperty],
    reader: &Reader<'_>,
    package: &Package,
    path: &str,
) -> Result<(), PropertyError> {
    for field in fields {
        let valid = match &field.value {
            PropertyValue::Name(v) => package.resolve_name_cow(*v).is_some(),
            PropertyValue::ObjectRef(crate::package::PackageIndex::Null) => true,
            PropertyValue::ObjectRef(v) => package.resolve_index_str(*v).is_some(),
            PropertyValue::NativeStruct { fields } => {
                validate_references(fields, reader, package, path)?;
                true
            }
            _ => true,
        };
        if !valid {
            return Err(error(
                reader,
                path,
                PropertyErrorKind::MalformedData,
                format!("invalid pin type reference in {}", field.name),
            ));
        }
    }
    Ok(())
}

fn record_fields(value: NativeValue) -> Vec<NativeProperty> {
    let PropertyValue::NativeStruct { fields } = property(value) else {
        unreachable!("source-checked pin fragments are records")
    };
    fields
}
fn convert_index(fields: &mut [NativeProperty], name: &str) {
    if let Some(field) = fields.iter_mut().find(|v| v.name == name)
        && let PropertyValue::Int(v) = field.value
    {
        field.value = PropertyValue::ObjectRef(crate::package::PackageIndex::from_raw(v as i32));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &[u8] = include_bytes!(
        "../../../../../fixtures/unreal-project/Content/Fixture/Blueprints/BP_ReviewFixture.uasset"
    );

    fn payload(map: bool) -> Vec<u8> {
        let mut bytes = vec![0; 20]; // two valid name references and a null object
        bytes.push(if map { 3 } else { 0 });
        if map {
            bytes.extend([0; 32]);
        } // two names, object and three archive booleans
        bytes.extend([0; 48]); // member reference and five archive booleans
        bytes
    }

    #[test]
    fn ue5_pin_precision_suffix_follows_custom_version_36_in_older_saved_packages() {
        let mut package = Package::parse(FIXTURE).unwrap();
        package.summary.versions.ue5 = 1009;
        for version in [35, 36] {
            package
                .summary
                .custom_versions
                .iter_mut()
                .find(|v| {
                    [v.key.a, v.key.b, v.key.c, v.key.d]
                        == [0xD89B5E42, 0x24BD4D46, 0x8412ACA8, 0xDF641779]
                })
                .unwrap()
                .version = version;
            let bytes = payload(false);
            let bytes = if version == 35 {
                &bytes[..bytes.len() - 4]
            } else {
                &bytes[..]
            };
            let mut reader = Reader::new(bytes);
            assert!(decode(&mut reader, &package, "Fixture").is_ok());
            assert_eq!(reader.remaining(), 0);
            for end in 0..bytes.len() {
                assert!(decode(&mut Reader::new(&bytes[..end]), &package, "Fixture").is_err());
            }
        }
    }

    #[test]
    fn pin_fragments_reject_truncation_bad_names_objects_containers_booleans_and_versions() {
        let package = Package::parse(FIXTURE).unwrap();
        for map in [false, true] {
            let bytes = payload(map);
            assert!(decode(&mut Reader::new(&bytes), &package, "pin").is_ok());
            for end in 0..bytes.len() {
                assert!(
                    decode(&mut Reader::new(&bytes[..end]), &package, "pin").is_err(),
                    "{map} {end}"
                );
            }
            for (offset, value) in [
                (0, i32::MAX),
                (16, i32::MAX),
                (if map { 53 } else { 21 }, 2),
            ] {
                let mut bad = bytes.clone();
                bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
                assert!(decode(&mut Reader::new(&bad), &package, "pin").is_err());
            }
            let mut bad = bytes.clone();
            bad[20] = 4;
            assert!(decode(&mut Reader::new(&bad), &package, "pin").is_err());
            if map {
                for offset in [21, 37, 41] {
                    let mut bad = bytes.clone();
                    bad[offset..offset + 4].copy_from_slice(&i32::MAX.to_le_bytes());
                    assert!(decode(&mut Reader::new(&bad), &package, "pin").is_err());
                }
            }
            for words in [
                [0xCFFC743F, 0x43B04480, 0x939114DF, 0x171D2073],
                [0x9C54D522, 0xA8264FBE, 0x94210746, 0x61B482D0],
                [0xD89B5E42, 0x24BD4D46, 0x8412ACA8, 0xDF641779],
            ] {
                let mut old = package.clone();
                old.summary
                    .custom_versions
                    .retain(|v| [v.key.a, v.key.b, v.key.c, v.key.d] != words);
                assert_eq!(
                    decode(&mut Reader::new(&bytes), &old, "pin")
                        .unwrap_err()
                        .kind(),
                    PropertyErrorKind::UnsupportedVersion
                );
            }
        }
    }

    #[test]
    fn ue427_pin_type_has_no_ue5_float_precision_suffix() {
        let mut package = Package::parse(FIXTURE).unwrap();
        package.summary.versions.ue5 = 0;
        package.summary.custom_versions.retain(|v| {
            [v.key.a, v.key.b, v.key.c, v.key.d] != [0xD89B5E42, 0x24BD4D46, 0x8412ACA8, 0xDF641779]
        });
        for map in [false, true] {
            let bytes = payload(map);
            let bytes = &bytes[..bytes.len() - 4];
            let mut reader = Reader::new(bytes);
            assert!(decode(&mut reader, &package, "Fixture.PinType").is_ok());
            assert_eq!(reader.remaining(), 0);
            assert!(
                decode(
                    &mut Reader::new(&bytes[..bytes.len() - 1]),
                    &package,
                    "Fixture.PinType"
                )
                .is_err()
            );
        }
    }
}
