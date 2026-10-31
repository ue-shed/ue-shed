//! Additional source-verified saved structs. New recipes probe and retain the old
//! tagged/opaque path on rejection, including inside binary-flagged containers.
use super::*;

pub(in crate::codec) fn optional_struct(
    ty: &PropertyTypeName,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
) -> Option<PropertyValue> {
    let identity = ty.parameters.first()?;
    let name = package.resolve_name_cow(identity.name)?;
    match name.as_ref() {
        "PerPlatformFloat" | "PerPlatformInt" | "PerPlatformBool" | "PerPlatformFrameRate" => {
            return super::per_platform::optional(ty, reader, package, path);
        }
        "SkeletalMeshSamplingLODBuiltData" => {
            return super::sampling::optional(ty, reader, package, path);
        }
        _ => {}
    }
    let module = package.resolve_name_cow(identity.parameters.first()?.name)?;
    if !matches!(package.summary.versions.ue5, 1000..=1018) {
        return None;
    }
    let mut probe = reader.clone();
    let value = match (module.as_ref(), name.as_ref()) {
        // UE 5.6–5.8 Engine/Private/Curves/KeyHandle.cpp: FKeyHandleMap::Serialize
        // returns true but writes only to transaction archives, never packages.
        ("/Script/Engine", "KeyHandleMap") => PropertyValue::NativeStruct { fields: vec![] },
        ("/Script/Engine", "Spline") if package.summary.versions.ue5 >= 1017 => {
            spline(&mut probe, path).ok()?
        }
        _ => return None,
    };
    *reader = probe;
    Some(value)
}

pub(super) fn named(name: &'static str, value: PropertyValue) -> NativeProperty {
    NativeProperty {
        name: Cow::Borrowed(name),
        value,
    }
}

fn spline(reader: &mut Reader<'_>, path: &str) -> Result<PropertyValue, PropertyError> {
    // UE 5.7 Curves/Spline.cpp FSpline::SerializeLoad/Save and FLegacySpline::Serialize;
    // UE 5.8 Curves/Spline.cpp and Curves/Splines/TangentSpline.cpp retain variant 1
    // as FLegacyTangentSpline. Variant 0 has no data. Other implementations stay opaque.
    let implementation = reader.read_u8(path)?;
    let mut fields = vec![named(
        "Implementation",
        PropertyValue::UInt(implementation.into()),
    )];
    match implementation {
        0 => {}
        1 => {
            for (name, components) in [
                ("PositionCurve", 3),
                ("RotationCurve", 4),
                ("ScaleCurve", 3),
                ("ReparamTable", 1),
            ] {
                fields.push(named(name, interp_curve(reader, path, components)?));
            }
        }
        _ => {
            return Err(error(
                reader,
                path,
                PropertyErrorKind::UnsupportedCapability,
                "unknown spline implementation",
            ));
        }
    }
    Ok(PropertyValue::NativeStruct { fields })
}

fn interp_curve(
    reader: &mut Reader<'_>,
    path: &str,
    components: usize,
) -> Result<PropertyValue, PropertyError> {
    // Core/Public/Math/InterpCurve{,Point}.h operator<<, UE 5.7/5.8:
    // points (float input, three values, uint8 mode), archive bool, float loop offset.
    // Vector and Quat use doubles after LARGE_WORLD_COORDINATES; reparam uses floats.
    let count = reader.read_count(path)?;
    let point_bytes = 5 + 3 * components * if components == 1 { 4 } else { 8 };
    let capacity = reader.checked_vec_capacity::<PropertyValue>(count, point_bytes, path)?;
    let mut points = Vec::with_capacity(capacity);
    for _ in 0..count {
        let mut fields = vec![named("InVal", PropertyValue::Float(reader.read_f32(path)?))];
        for name in ["OutVal", "ArriveTangent", "LeaveTangent"] {
            let value = if components == 1 {
                PropertyValue::Float(reader.read_f32(path)?)
            } else {
                PropertyValue::NativeStruct {
                    fields: ["X", "Y", "Z", "W"][..components]
                        .iter()
                        .map(|name| Ok(named(name, PropertyValue::Double(reader.read_f64(path)?))))
                        .collect::<Result<_, PropertyError>>()?,
                }
            };
            fields.push(named(name, value));
        }
        fields.push(named(
            "InterpMode",
            PropertyValue::UInt(reader.read_u8(path)?.into()),
        ));
        points.push(PropertyValue::NativeStruct { fields });
    }
    Ok(PropertyValue::NativeStruct {
        fields: vec![
            named("Points", PropertyValue::Array(points)),
            named(
                "IsLooped",
                PropertyValue::Bool(super::super::read_archive_bool(reader, path)?),
            ),
            named(
                "LoopKeyOffset",
                PropertyValue::Float(reader.read_f32(path)?),
            ),
        ],
    })
}

pub(in crate::codec) fn field_path(
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
) -> Option<PropertyValue> {
    if !matches!(package.summary.versions.ue5, 1000..=1018)
        || !matches!(
            custom_version(package, [0x601D1886, 0xAC644F84, 0xAA16D3DE, 0x0DEAC7D6]),
            Some(33..)
        )
    {
        return None;
    }
    // UE 5.6–5.8 CoreUObject/Private/UObject/FieldPath.cpp operator<<:
    // FName path array and owner package index from FortniteMain=33.
    let mut probe = reader.clone();
    let count = probe.read_count(path).ok()?;
    let capacity = probe
        .checked_vec_capacity::<PropertyValue>(count, 8, path)
        .ok()?;
    let mut names = Vec::with_capacity(capacity);
    for _ in 0..count {
        let name = probe.read_name_ref(path).ok()?;
        package.resolve_name_cow(name)?;
        names.push(PropertyValue::Name(name));
    }
    let owner = PackageIndex::from_raw(probe.read_i32(path).ok()?);
    if owner != PackageIndex::Null {
        package.resolve_index(owner)?;
    }
    *reader = probe;
    Some(PropertyValue::NativeStruct {
        fields: vec![
            named("Path", PropertyValue::Array(names)),
            named("Owner", PropertyValue::ObjectRef(owner)),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::test_package;
    use crate::test_support::{name_ref, push_i32, text_version};

    fn ty(name: i32, module: i32) -> PropertyTypeName {
        PropertyTypeName {
            name: name_ref(0, 0),
            parameters: vec![PropertyTypeName {
                name: name_ref(name, 0),
                parameters: vec![PropertyTypeName {
                    name: name_ref(module, 0),
                    parameters: vec![],
                }],
            }],
        }
    }

    #[test]
    fn spline_variants_are_bounded_and_unknown_or_inapplicable_recipes_do_not_consume() {
        let mut package = test_package(vec![
            "StructProperty".into(),
            "Spline".into(),
            "/Script/Engine".into(),
            "/Script/Fixture".into(),
        ]);
        let mut bytes = vec![1];
        for components in [3, 4, 3, 1] {
            push_i32(&mut bytes, 1);
            bytes.extend_from_slice(&2_f32.to_le_bytes());
            for _ in 0..3 * components {
                if components == 1 {
                    bytes.extend_from_slice(&3_f32.to_le_bytes());
                } else {
                    bytes.extend_from_slice(&3_f64.to_le_bytes());
                }
            }
            bytes.push(2);
            push_i32(&mut bytes, 1);
            bytes.extend_from_slice(&4_f32.to_le_bytes());
        }
        for version in [1017, 1018] {
            package.summary.versions.ue5 = version;
            let mut reader = Reader::new(&bytes);
            assert!(optional_struct(&ty(1, 2), &mut reader, &package, "Fixture.Spline").is_some());
            assert_eq!(reader.remaining(), 0);
            for end in 0..bytes.len() {
                let mut reader = Reader::new(&bytes[..end]);
                assert!(
                    optional_struct(&ty(1, 2), &mut reader, &package, "Fixture.Spline").is_none(),
                    "{end}"
                );
                assert_eq!(reader.tell(), 0);
            }
        }
        for version in [0, 1016, 1019] {
            package.summary.versions.ue5 = version;
            let mut reader = Reader::new(&bytes);
            assert!(optional_struct(&ty(1, 2), &mut reader, &package, "Fixture.Spline").is_none());
            assert_eq!(reader.tell(), 0);
        }
        package.summary.versions.ue5 = 1018;
        assert!(
            optional_struct(&ty(1, 3), &mut Reader::new(&bytes), &package, "Fixture").is_none()
        );
        let mut reader = Reader::new(&[2]);
        assert!(optional_struct(&ty(1, 2), &mut reader, &package, "Fixture").is_none());
        assert_eq!(reader.tell(), 0);
        assert!(optional_struct(&ty(1, 2), &mut Reader::new(&[0]), &package, "Fixture").is_some());
    }

    #[test]
    fn key_handle_map_is_empty_in_package_archives_and_requires_engine_identity() {
        let mut package = test_package(vec![
            "StructProperty".into(),
            "KeyHandleMap".into(),
            "/Script/Engine".into(),
            "/Script/Fixture".into(),
        ]);
        for version in [1016, 1017, 1018] {
            package.summary.versions.ue5 = version;
            let mut reader = Reader::new(&[99]);
            assert!(optional_struct(&ty(1, 2), &mut reader, &package, "Fixture").is_some());
            assert_eq!(reader.tell(), 0);
            assert!(optional_struct(&ty(1, 3), &mut reader, &package, "Fixture").is_none());
        }
        package.summary.versions.ue5 = 999;
        assert!(optional_struct(&ty(1, 2), &mut Reader::new(&[]), &package, "Fixture").is_none());
    }

    #[test]
    fn field_paths_follow_the_owner_version_and_rejected_paths_keep_the_old_raw_boundary() {
        let mut package = test_package(vec!["None".into(), "Value".into()]);
        let mut bytes = vec![];
        for word in [1, 1, 0, 0] {
            push_i32(&mut bytes, word);
        }
        for version in [1016, 1017, 1018] {
            package.summary.versions.ue5 = version;
            text_version(&mut package, Some(33), 0);
            let mut reader = Reader::new(&bytes);
            assert!(field_path(&mut reader, &package, "Fixture").is_some());
            assert_eq!(reader.remaining(), 0);
            for end in 0..bytes.len() {
                let mut reader = Reader::new(&bytes[..end]);
                assert!(field_path(&mut reader, &package, "Fixture").is_none());
                assert_eq!(reader.tell(), 0);
            }
            text_version(&mut package, Some(32), 0);
            assert!(field_path(&mut Reader::new(&bytes), &package, "Fixture").is_none());
        }
    }
}
