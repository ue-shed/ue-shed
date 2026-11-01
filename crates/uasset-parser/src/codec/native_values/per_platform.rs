//! Source-verified native TPerPlatformProperty values, including their native override maps.
use super::saved_structs::named;
use super::*;

#[derive(Clone, Copy)]
enum Kind {
    Float,
    Int,
    Bool,
    FrameRate,
}

impl Kind {
    fn value(self, reader: &mut Reader<'_>, path: &str) -> Result<PropertyValue, PropertyError> {
        Ok(match self {
            Self::Float => PropertyValue::Float(reader.read_f32(path)?),
            Self::Int => PropertyValue::Int(i64::from(reader.read_i32(path)?)),
            // Native FArchive booleans are uint32, unlike FBoolProperty container elements.
            Self::Bool => PropertyValue::Bool(read_archive_bool(reader, path)?),
            // UE 5.7/5.8 Core/Private/Misc/FrameRate.cpp operator<<.
            Self::FrameRate => PropertyValue::NativeStruct {
                fields: vec![
                    named(
                        "Numerator",
                        PropertyValue::Int(i64::from(reader.read_i32(path)?)),
                    ),
                    named(
                        "Denominator",
                        PropertyValue::Int(i64::from(reader.read_i32(path)?)),
                    ),
                ],
            },
        })
    }
}

pub(super) fn optional(
    ty: &PropertyTypeName,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
) -> Option<PropertyValue> {
    let versions = &package.summary.versions;
    if versions.ue4 != crate::version::VersionContext::LATEST_SUPPORTED_UE4
        || !matches!(versions.ue5, 0 | 1000..=1018)
    {
        return None;
    }
    let identity = ty.parameters.first()?;
    let name = package.resolve_name_str(identity.name)?;
    let kind = match name {
        "PerPlatformFloat" => Kind::Float,
        "PerPlatformInt" => Kind::Int,
        "PerPlatformBool" => Kind::Bool,
        "PerPlatformFrameRate" => Kind::FrameRate,
        _ => return None,
    };
    let module = identity
        .parameters
        .first()
        .and_then(|module| package.resolve_name_str(module.name));
    // The three original types moved from Engine to CoreUObject. Legacy tags omit
    // their module; user-defined struct GUIDs are excluded by the calling codec.
    match module {
        Some("/Script/CoreUObject") => {}
        Some("/Script/Engine") if !matches!(kind, Kind::FrameRate) => {}
        None if versions.uses_legacy_property_tags() && !matches!(kind, Kind::FrameRate) => {}
        _ => return None,
    }
    let mut probe = reader.clone();
    let value = decode(&mut probe, package, path, kind).ok()?;
    *reader = probe;
    Some(value)
}

fn decode(
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    kind: Kind,
) -> Result<PropertyValue, PropertyError> {
    // UE 4.27 Engine/Private/PerPlatformProperties.cpp and UE 5.7/5.8
    // CoreUObject/Public/UObject/PerPlatformPropertiesImpl.inl:
    // archive bool, default value, then a native TMap<FName, Value> when false.
    // 5.8 calls the flag bStripSerializeAllProperties rather than bCooked, but
    // its physical meaning here is the same: whether the override map is absent.
    let stripped = read_archive_bool(reader, &format!("{path}.StripOverrides"))?;
    let default = kind.value(reader, &format!("{path}.Default"))?;
    let mut fields = vec![
        named("OverridesSerialized", PropertyValue::Bool(!stripped)),
        named("Default", default),
    ];
    if !stripped {
        let count = reader.read_count(&format!("{path}.PerPlatform.Count"))?;
        let minimum = if matches!(kind, Kind::FrameRate) {
            16
        } else {
            12
        };
        let capacity = reader.checked_vec_capacity::<MapEntry>(count, minimum, path)?;
        let mut entries = Vec::with_capacity(capacity);
        for _ in 0..count {
            let name = reader.read_name_ref(path)?;
            if package.resolve_name_cow(name).is_none() {
                return Err(error(
                    reader,
                    path,
                    PropertyErrorKind::MalformedData,
                    "invalid per-platform override name",
                ));
            }
            entries.push(MapEntry {
                key: PropertyValue::Name(name),
                value: kind.value(reader, path)?,
            });
        }
        fields.push(named("PerPlatform", PropertyValue::Map(entries)));
    }
    Ok(PropertyValue::NativeStruct { fields })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::test_package;
    use crate::test_support::{name_ref, push_i32};

    fn package(name: &str, version: i32) -> (Package, PropertyTypeName) {
        let mut package = test_package(
            [
                "StructProperty",
                name,
                "/Script/CoreUObject",
                "/Script/Fixture",
                "FixturePlatform",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        package.summary.versions.ue5 = version;
        let ty = PropertyTypeName {
            name: name_ref(0, 0),
            parameters: vec![PropertyTypeName {
                name: name_ref(1, 0),
                parameters: if version == 0 {
                    vec![]
                } else {
                    vec![PropertyTypeName {
                        name: name_ref(2, 0),
                        parameters: vec![],
                    }]
                },
            }],
        };
        (package, ty)
    }

    fn bytes(name: &str, stripped: bool) -> Vec<u8> {
        let mut bytes = i32::from(stripped).to_le_bytes().to_vec();
        let value = match name {
            "PerPlatformFloat" => 1.25_f32.to_le_bytes().to_vec(),
            "PerPlatformInt" => (-42_i32).to_le_bytes().to_vec(),
            "PerPlatformBool" => 1_i32.to_le_bytes().to_vec(),
            "PerPlatformFrameRate" => [24_i32.to_le_bytes(), 1_i32.to_le_bytes()].concat(),
            _ => unreachable!(),
        };
        bytes.extend(&value);
        if !stripped {
            push_i32(&mut bytes, 1);
            push_i32(&mut bytes, 4);
            push_i32(&mut bytes, 0);
            bytes.extend(&value);
        }
        bytes
    }

    #[test]
    fn native_defaults_and_override_maps_consume_exact_values_and_archive_booleans() {
        for version in [0, 1000, 1011, 1017, 1018] {
            for name in [
                "PerPlatformFloat",
                "PerPlatformInt",
                "PerPlatformBool",
                "PerPlatformFrameRate",
            ] {
                if version == 0 && name == "PerPlatformFrameRate" {
                    continue;
                }
                let (package, ty) = package(name, version);
                for stripped in [false, true] {
                    let bytes = bytes(name, stripped);
                    let mut reader = Reader::new(&bytes);
                    let value = optional(&ty, &mut reader, &package, "Fixture").unwrap();
                    assert_eq!(reader.remaining(), 0, "{name} {version}");
                    assert_eq!(
                        field(&value, "OverridesSerialized"),
                        Some(&PropertyValue::Bool(!stripped))
                    );
                    let default = field(&value, "Default").unwrap();
                    match name {
                        "PerPlatformFloat" => assert_eq!(default, &PropertyValue::Float(1.25)),
                        "PerPlatformInt" => assert_eq!(default, &PropertyValue::Int(-42)),
                        "PerPlatformBool" => assert_eq!(default, &PropertyValue::Bool(true)),
                        "PerPlatformFrameRate" => {
                            assert_eq!(field(default, "Numerator"), Some(&PropertyValue::Int(24)));
                            assert_eq!(field(default, "Denominator"), Some(&PropertyValue::Int(1)));
                        }
                        _ => unreachable!(),
                    }
                    if stripped {
                        assert!(field(&value, "PerPlatform").is_none());
                    } else {
                        let Some(PropertyValue::Map(entries)) = field(&value, "PerPlatform") else {
                            panic!("override map");
                        };
                        assert_eq!(entries.len(), 1);
                        assert_eq!(entries[0].key, PropertyValue::Name(name_ref(4, 0)));
                        assert_eq!(&entries[0].value, default);
                    }
                    for end in 0..bytes.len() {
                        let mut reader = Reader::new(&bytes[..end]);
                        assert!(
                            optional(&ty, &mut reader, &package, "Fixture").is_none(),
                            "{name} {version} {end}"
                        );
                        assert_eq!(reader.tell(), 0);
                    }
                }
            }
        }
    }

    #[test]
    fn malformed_versions_names_counts_and_booleans_do_not_advance_the_fallback() {
        let (mut package, mut ty) = package("PerPlatformBool", 1018);
        let bytes = bytes("PerPlatformBool", false);
        for (offset, value) in [(0, 2), (4, 2), (8, -1), (8, i32::MAX), (12, i32::MAX)] {
            let mut bad = bytes.clone();
            bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            let mut reader = Reader::new(&bad);
            assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
        ty.parameters[0].parameters[0].name = name_ref(3, 0);
        let mut reader = Reader::new(&bytes);
        assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
        assert_eq!(reader.tell(), 0);
        ty.parameters[0].parameters[0].name = name_ref(2, 0);
        for version in [999, 1019] {
            package.summary.versions.ue5 = version;
            assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
    }

    #[test]
    fn native_values_work_inside_arrays_without_consuming_the_next_element() {
        let (package, ty) = package("PerPlatformFloat", 0);
        let bytes = [
            bytes("PerPlatformFloat", false),
            bytes("PerPlatformFloat", true),
        ]
        .concat();
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
            ContainerSerializer::Unknown,
        )
        .unwrap();
        let PropertyValue::Array(values) = value else {
            panic!("array");
        };
        assert_eq!(values.len(), 2);
        assert_eq!(reader.remaining(), 0);
        assert!(field(&values[0], "PerPlatform").is_some());
        assert!(field(&values[1], "PerPlatform").is_none());
    }
}
