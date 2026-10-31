//! Native gameplay-tag containers where legacy tags omit the qualified struct identity.
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
        || !matches!(versions.ue5, 0 | 1000..=1011)
    {
        return None;
    }
    let identity = ty.parameters.first()?;
    if package.resolve_name_str(identity.name) != Some("GameplayTagContainer") {
        return None;
    }
    match identity
        .parameters
        .first()
        .and_then(|module| package.resolve_name_str(module.name))
    {
        None | Some("/Script/GameplayTags") => {}
        _ => return None,
    }
    // GameplayTagContainer.cpp, UE 4.27/5.7/5.8: Serialize saves GameplayTags.
    // VER_UE4_GAMEPLAY_TAG_CONTAINER_TAG_TYPE_CHANGE=376 predates our UE4 floor.
    // GameplayTagContainer.h's native array operator writes each FGameplayTag's
    // TagName directly. Reflected scalar FGameplayTag structs remain tagged.
    let mut probe = reader.clone();
    let count = probe.read_count(path).ok()?;
    let capacity = probe
        .checked_vec_capacity::<PropertyValue>(count, 8, path)
        .ok()?;
    let mut tags = Vec::with_capacity(capacity);
    for _ in 0..count {
        let name = probe.read_name_ref(path).ok()?;
        package.resolve_name_cow(name)?;
        tags.push(PropertyValue::Name(name));
    }
    *reader = probe;
    Some(PropertyValue::NativeStruct {
        fields: vec![named("GameplayTags", PropertyValue::Array(tags))],
    })
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
                "GameplayTagContainer",
                "/Script/GameplayTags",
                "/Script/Fixture",
                "Fixture.Tag",
                "Fixture.Other",
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
                parameters: vec![],
            }],
        };
        (package, ty)
    }

    fn bytes() -> Vec<u8> {
        let mut bytes = vec![];
        for value in [2, 4, 0, 5, 0] {
            push_i32(&mut bytes, value);
        }
        bytes
    }

    #[test]
    fn legacy_tag_containers_preserve_saved_names_in_empty_and_populated_native_arrays() {
        for version in [0, 1000, 1004, 1011] {
            let (package, ty) = package(version);
            for bytes in [bytes(), vec![0; 4]] {
                let mut reader = Reader::new(&bytes);
                let value = optional(&ty, &mut reader, &package, "Fixture").unwrap();
                assert_eq!(reader.remaining(), 0);
                assert_eq!(
                    field(&value, "GameplayTags"),
                    Some(&PropertyValue::Array(if bytes.len() == 4 {
                        vec![]
                    } else {
                        vec![
                            PropertyValue::Name(name_ref(4, 0)),
                            PropertyValue::Name(name_ref(5, 0)),
                        ]
                    }))
                );
                for end in 0..bytes.len() {
                    let mut reader = Reader::new(&bytes[..end]);
                    assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
                    assert_eq!(reader.tell(), 0);
                }
            }
        }
    }

    #[test]
    fn unknown_names_counts_namespaces_and_versions_preserve_the_old_fallback() {
        let (mut package, mut ty) = package(0);
        let bytes = bytes();
        for (offset, value) in [(0, -1), (0, i32::MAX), (4, i32::MAX), (8, -1)] {
            let mut bad = bytes.clone();
            bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            let mut reader = Reader::new(&bad);
            assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
        ty.parameters[0].parameters.push(PropertyTypeName {
            name: name_ref(3, 0),
            parameters: vec![],
        });
        let mut reader = Reader::new(&bytes);
        assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
        assert_eq!(reader.tell(), 0);
        ty.parameters[0].parameters[0].name = name_ref(2, 0);
        for version in [999, 1012, 1018, 1019] {
            package.summary.versions.ue5 = version;
            assert!(optional(&ty, &mut reader, &package, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
    }

    #[test]
    fn legacy_container_arrays_consume_each_native_tag_list_once() {
        let (package, ty) = package(0);
        let bytes = [bytes(), vec![0; 4]].concat();
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
    }
}
