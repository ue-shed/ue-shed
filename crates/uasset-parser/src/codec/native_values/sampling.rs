//! Saved whole-mesh LOD sampling tables, without evaluating or rebuilding the sampler.
use super::saved_structs::named;
use super::*;

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
    if package.resolve_name_str(identity.name) != Some("SkeletalMeshSamplingLODBuiltData") {
        return None;
    }
    match identity
        .parameters
        .first()
        .and_then(|module| package.resolve_name_str(module.name))
    {
        Some("/Script/Engine") => {}
        None if versions.uses_legacy_property_tags() => {}
        _ => return None,
    }
    let mut probe = reader.clone();
    let value = decode(&mut probe, path).ok()?;
    *reader = probe;
    Some(value)
}

fn decode(reader: &mut Reader<'_>, path: &str) -> Result<PropertyValue, PropertyError> {
    // UE 4.27/5.7/5.8 SkeletalMeshSampling.cpp:
    // FSkeletalMeshSamplingLODBuiltData::Serialize delegates to its sampler.
    // WeightedRandomSampler.cpp writes Prob, Alias, TotalWeight. MemoryImage.h
    // aliases TMemoryImageArray<T> to TArray<T, FMemoryImageAllocator>; these
    // are native count-prefixed arrays, not reflected-property delta arrays.
    let probabilities = array(reader, path, ScalarKind::Float)?;
    let aliases = array(reader, path, ScalarKind::Int32)?;
    let weight = reader.read_f32(path)?;
    Ok(PropertyValue::NativeStruct {
        fields: vec![named(
            "AreaWeightedTriangleSampler",
            PropertyValue::NativeStruct {
                fields: vec![
                    named("Prob", probabilities),
                    named("Alias", aliases),
                    named("TotalWeight", PropertyValue::Float(weight)),
                ],
            },
        )],
    })
}

fn array(
    reader: &mut Reader<'_>,
    path: &str,
    kind: ScalarKind,
) -> Result<PropertyValue, PropertyError> {
    let count = reader.read_count(path)?;
    let capacity = reader.checked_vec_capacity::<PropertyValue>(count, 4, path)?;
    let bytes = reader.read_bytes(count * 4, path)?;
    let mut values = Vec::with_capacity(capacity);
    // Both caller-selected kinds have a four-byte serialized representation.
    for bytes in bytes.as_chunks::<4>().0 {
        values.push(kind.decode(bytes));
    }
    Ok(PropertyValue::Array(values))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::test_package;
    use crate::test_support::{name_ref, push_i32};

    fn package(version: i32) -> (Package, PropertyTypeName) {
        let mut package = test_package(
            [
                "StructProperty",
                "SkeletalMeshSamplingLODBuiltData",
                "/Script/Engine",
                "/Script/Fixture",
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

    fn bytes() -> Vec<u8> {
        let mut bytes = vec![];
        push_i32(&mut bytes, 2);
        for value in [0.25_f32, 0.75] {
            bytes.extend(value.to_le_bytes());
        }
        push_i32(&mut bytes, 2);
        for value in [1, -1] {
            push_i32(&mut bytes, value);
        }
        bytes.extend(3.5_f32.to_le_bytes());
        bytes
    }

    #[test]
    fn sampling_tables_follow_native_counts_float_probabilities_and_signed_aliases() {
        for version in [0, 1000, 1011, 1017, 1018] {
            let (package, ty) = package(version);
            for bytes in [bytes(), vec![0; 12]] {
                let mut reader = Reader::new(&bytes);
                let value = optional(&ty, &mut reader, &package, "Fixture").unwrap();
                assert_eq!(reader.remaining(), 0);
                let sampler = field(&value, "AreaWeightedTriangleSampler").unwrap();
                let nonempty = bytes.len() != 12;
                assert_eq!(
                    field(sampler, "Prob"),
                    Some(&PropertyValue::Array(if nonempty {
                        vec![PropertyValue::Float(0.25), PropertyValue::Float(0.75)]
                    } else {
                        vec![]
                    }))
                );
                assert_eq!(
                    field(sampler, "Alias"),
                    Some(&PropertyValue::Array(if nonempty {
                        vec![PropertyValue::Int(1), PropertyValue::Int(-1)]
                    } else {
                        vec![]
                    }))
                );
                assert_eq!(
                    field(sampler, "TotalWeight"),
                    Some(&PropertyValue::Float(if nonempty { 3.5 } else { 0.0 }))
                );
                for end in 0..bytes.len() {
                    let mut reader = Reader::new(&bytes[..end]);
                    assert!(
                        optional(&ty, &mut reader, &package, "Fixture").is_none(),
                        "{version} {end}"
                    );
                    assert_eq!(reader.tell(), 0);
                }
            }
        }
    }

    #[test]
    fn invalid_counts_and_unproven_identities_preserve_the_prior_fallback() {
        let (mut package, mut ty) = package(1018);
        let bytes = bytes();
        for offset in [0, 12] {
            for count in [-1_i32, i32::MAX] {
                let mut bad = bytes.clone();
                bad[offset..offset + 4].copy_from_slice(&count.to_le_bytes());
                let mut reader = Reader::new(&bad);
                assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
                assert_eq!(reader.tell(), 0);
            }
        }
        let mut reader = Reader::new(&bytes);
        ty.parameters[0].parameters[0].name = name_ref(3, 0);
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
    fn sampling_structs_in_legacy_and_binary_arrays_do_not_consume_the_next_value() {
        for version in [0, 1017, 1018] {
            let (package, ty) = package(version);
            let bytes = [bytes(), vec![0; 12]].concat();
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
                if version == 0 {
                    ContainerSerializer::Unknown
                } else {
                    ContainerSerializer::BinaryOrNative
                },
            )
            .unwrap();
            let PropertyValue::Array(values) = value else {
                panic!("array");
            };
            assert_eq!(values.len(), 2);
            assert_eq!(reader.remaining(), 0);
        }
    }
}
