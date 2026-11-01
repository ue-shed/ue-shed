//! Saved delegate bindings. Payload-bearing dynamic delegates retain their opaque evidence.
use super::saved_structs::named;
use super::*;

pub(in crate::codec) fn optional(
    name: &str,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
) -> Option<PropertyValue> {
    let multicast = match name {
        "DelegateProperty" => false,
        "MulticastDelegateProperty"
        | "MulticastInlineDelegateProperty"
        | "MulticastSparseDelegateProperty" => true,
        _ => return None,
    };
    if !matches!(package.summary.versions.ue5, 0 | 1000..=1018) {
        return None;
    }
    let mut probe = reader.clone();
    let value = if multicast {
        // ScriptDelegates.h TMulticastScriptDelegate saves its native InvocationList.
        // PropertyMulticastDelegate.cpp uses this same list for sparse delegates.
        let count = probe.read_count(path).ok()?;
        let capacity = probe
            .checked_vec_capacity::<PropertyValue>(count, 12, path)
            .ok()?;
        let mut bindings = Vec::with_capacity(capacity);
        for _ in 0..count {
            bindings.push(binding(&mut probe, package, path)?);
        }
        PropertyValue::NativeStruct {
            fields: vec![named("InvocationList", PropertyValue::Array(bindings))],
        }
    } else {
        binding(&mut probe, package, path)?
    };
    *reader = probe;
    Some(value)
}

fn binding(reader: &mut Reader<'_>, package: &Package, path: &str) -> Option<PropertyValue> {
    // UE 4.27/5.7/5.8 ScriptDelegates.h serializes weak Object then FunctionName.
    // ArchiveUObject.cpp serializes persistent weak pointers as UObject references:
    // a four-byte FPackageIndex in a classic saved package, not the in-memory weak handle.
    let object = PackageIndex::from_raw(reader.read_i32(path).ok()?);
    if object != PackageIndex::Null {
        package.resolve_index(object)?;
    }
    let function = reader.read_name_ref(path).ok()?;
    let function_name = package.resolve_name_cow(function)?;
    let version =
        custom_version(package, [0x601D1886, 0xAC644F84, 0xAA16D3DE, 0x0DEAC7D6]).unwrap_or(-1);
    // UE 5.8 FortniteMainBranchObjectVersions.inl: DynamicDelegatePayloads=262
    // adds an archive bool. CompactDynamicDelegatePayloads=263 replaces that
    // bool with ScriptDelegates.h's [bHasPayload] function-name suffix. Binary
    // structured archives use the same framing (BinaryArchiveFormatter.h).
    if version == 262 {
        if read_archive_bool(reader, path).ok()? {
            return None;
        }
    } else if version >= 263 && function_name.ends_with("[bHasPayload]") {
        return None;
    }
    Some(PropertyValue::NativeStruct {
        fields: vec![
            named("Object", PropertyValue::ObjectRef(object)),
            named("FunctionName", PropertyValue::Name(function)),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::test_package;
    use crate::test_support::{name_ref, push_i32, text_version};

    fn package(version: i32, custom: Option<i32>) -> Package {
        let mut package = test_package(
            ["None", "FixtureFunction", "FixtureFunction[bHasPayload]"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
        );
        package.summary.versions.ue5 = version;
        text_version(&mut package, custom, 0);
        package
    }

    fn binding_bytes(custom: Option<i32>, payload: bool) -> Vec<u8> {
        let mut bytes = vec![];
        for value in [
            0,
            if payload && custom.is_some_and(|v| v >= 263) {
                2
            } else {
                1
            },
            0,
        ] {
            push_i32(&mut bytes, value);
        }
        if custom == Some(262) {
            push_i32(&mut bytes, i32::from(payload));
        }
        bytes
    }

    #[test]
    fn delegate_object_and_name_frames_follow_the_two_payload_version_gates() {
        for version in [0, 1000, 1011, 1017, 1018] {
            for custom in [None, Some(261), Some(262), Some(263), Some(268)] {
                let package = package(version, custom);
                let bytes = binding_bytes(custom, false);
                let mut reader = Reader::new(&bytes);
                let value = optional("DelegateProperty", &mut reader, &package, "Fixture").unwrap();
                assert_eq!(reader.remaining(), 0);
                assert_eq!(
                    field(&value, "Object"),
                    Some(&PropertyValue::ObjectRef(PackageIndex::Null))
                );
                assert_eq!(
                    field(&value, "FunctionName"),
                    Some(&PropertyValue::Name(name_ref(1, 0)))
                );
                for end in 0..bytes.len() {
                    let mut reader = Reader::new(&bytes[..end]);
                    assert!(
                        optional("DelegateProperty", &mut reader, &package, "Fixture").is_none()
                    );
                    assert_eq!(reader.tell(), 0);
                }
                if custom.is_some_and(|v| v >= 262) {
                    let bytes = binding_bytes(custom, true);
                    let mut reader = Reader::new(&bytes);
                    assert!(
                        optional("DelegateProperty", &mut reader, &package, "Fixture").is_none()
                    );
                    assert_eq!(reader.tell(), 0);
                }
            }
        }
    }

    #[test]
    fn inline_legacy_and_sparse_multicast_lists_have_the_same_native_array_layout() {
        for custom in [None, Some(262), Some(263)] {
            let package = package(1018, custom);
            for kind in [
                "MulticastDelegateProperty",
                "MulticastInlineDelegateProperty",
                "MulticastSparseDelegateProperty",
            ] {
                for count in [0, 2] {
                    let mut bytes = vec![];
                    push_i32(&mut bytes, count);
                    for _ in 0..count {
                        bytes.extend(binding_bytes(custom, false));
                    }
                    let mut reader = Reader::new(&bytes);
                    let value = optional(kind, &mut reader, &package, "Fixture").unwrap();
                    let Some(PropertyValue::Array(bindings)) = field(&value, "InvocationList")
                    else {
                        panic!("invocation list");
                    };
                    assert_eq!(bindings.len(), count as usize);
                    assert_eq!(reader.remaining(), 0);
                    for end in 0..bytes.len() {
                        let mut reader = Reader::new(&bytes[..end]);
                        assert!(optional(kind, &mut reader, &package, "Fixture").is_none());
                        assert_eq!(reader.tell(), 0);
                    }
                }
            }
        }
    }

    #[test]
    fn invalid_reference_name_count_and_payload_flag_keep_the_entire_value_raw() {
        let package = package(1018, Some(262));
        let bytes = binding_bytes(Some(262), false);
        for (offset, value) in [(0, i32::MAX), (4, i32::MAX), (8, -1), (12, 2)] {
            let mut bad = bytes.clone();
            bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            let mut reader = Reader::new(&bad);
            assert!(optional("DelegateProperty", &mut reader, &package, "Fixture").is_none());
            assert_eq!(reader.tell(), 0);
        }
        for count in [-1_i32, i32::MAX] {
            let bytes = count.to_le_bytes();
            let mut reader = Reader::new(&bytes);
            assert!(
                optional(
                    "MulticastInlineDelegateProperty",
                    &mut reader,
                    &package,
                    "Fixture"
                )
                .is_none()
            );
            assert_eq!(reader.tell(), 0);
        }
    }
}
