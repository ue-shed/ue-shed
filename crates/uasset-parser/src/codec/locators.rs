//! Stock Universal Object Locator fragments. Unknown registered payloads stay opaque.
use super::*;
use crate::property::NativeProperty;

pub(super) fn applies(ty: &PropertyTypeName, package: &Package) -> bool {
    matches!(package.summary.versions.ue5, 1012..=1018)
        && ty.parameters.first().is_some_and(|identity| {
            package.resolve_name_str(identity.name) == Some("UniversalObjectLocatorFragment")
                && identity.parameters.first().is_some_and(|module| {
                    package.resolve_name_str(module.name) == Some("/Script/UniversalObjectLocator")
                })
        })
}

pub(super) fn decode(
    source: &[u8],
    ty: &PropertyTypeName,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    scope: DecodeScope<'_>,
) -> Option<PropertyValue> {
    if !applies(ty, package) || scope.depth >= MAX_PROPERTY_DECODE_DEPTH {
        return None;
    }
    let mut probe = reader.clone();
    // UE5.7/5.8 UniversalObjectLocatorFragment.cpp: FName ID, then that registered
    // UScriptStruct's SerializeItem. These stock payload structs are tagged (their
    // traits only add equality). An unknown plugin may use native bytes with no
    // length prefix, so even NAME_None-looking payload bytes cannot prove a layout.
    let id = probe.read_name_ref(path).ok()?;
    let name = package.resolve_name(id)?;
    let mut fields = vec![NativeProperty {
        name: Cow::Borrowed("FragmentTypeID"),
        value: PropertyValue::Name(id),
    }];
    match name.as_str() {
        "None" => {}
        // UniversalObjectLocatorModule.cpp and Engine/Private/UnrealEngine.cpp.
        "subobj" | "uobj" | "actor" | "asset" | "animinst" => {
            let mut payload = read_tagged_property_stream(
                &mut probe,
                &package.summary.versions,
                &package.names,
                path,
            )
            .ok()?;
            decode_property_stream_values_at_depth(source, &mut payload, package, scope.nested())
                .ok()?;
            fields.push(NativeProperty {
                name: Cow::Borrowed("Payload"),
                value: PropertyValue::Struct(Box::new(payload)),
            });
        }
        _ => return None,
    }
    *reader = probe;
    Some(PropertyValue::NativeStruct { fields })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::Span;
    use crate::package::test_package;
    use crate::test_support::{
        TypeParam, name_ref, push_fstring, push_i32, write_property_tag, write_property_terminator,
    };

    fn ty(index: i32, parameters: Vec<PropertyTypeName>) -> PropertyTypeName {
        PropertyTypeName {
            name: name_ref(index, 0),
            parameters,
        }
    }
    fn package(version: i32) -> Package {
        let mut p = test_package(
            [
                "None",
                "StructProperty",
                "UniversalObjectLocatorFragment",
                "/Script/UniversalObjectLocator",
                "subobj",
                "PathWithinContext",
                "StrProperty",
                "Value",
                "ArrayProperty",
                "custom",
                "actor",
                "asset",
                "animinst",
                "uobj",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        p.summary.versions.ue5 = version;
        p
    }
    fn fragment_type() -> PropertyTypeName {
        ty(1, vec![ty(2, vec![ty(3, vec![])])])
    }
    fn fragment(id: i32) -> Vec<u8> {
        let mut bytes = vec![];
        push_i32(&mut bytes, id);
        push_i32(&mut bytes, 0);
        if id != 0 {
            let mut string = vec![];
            push_fstring(&mut string, "FixtureComponent");
            write_property_tag(
                &mut bytes,
                5,
                &TypeParam {
                    type_index: 6,
                    parameters: vec![],
                },
                0,
                &string,
            );
            write_property_terminator(&mut bytes, 0);
        }
        bytes
    }
    fn decode_record(p: &Package, ty: PropertyTypeName, bytes: &[u8]) -> PropertyValue {
        let mut r = PropertyRecord {
            name: name_ref(7, 0),
            type_name: ty,
            array_index: 0,
            flags: PropertyTagFlags(8),
            property_guid: None,
            struct_guid: None,
            extensions: None,
            payload: Span::new(0, bytes.len() as u64).unwrap(),
            value: PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            },
        };
        decode_property_record(bytes, &mut r, p, DecodeScope::root(None)).unwrap();
        r.value
    }

    #[test]
    fn stock_fragment_ids_and_tagged_payloads_are_bounded_and_qualified() {
        for version in [1012, 1017, 1018] {
            let p = package(version);
            for id in [0, 4, 10, 11, 12, 13] {
                let bytes = fragment(id);
                let PropertyValue::NativeStruct { fields } =
                    decode_record(&p, fragment_type(), &bytes)
                else {
                    panic!("fragment {id}")
                };
                assert_eq!(fields[0].value, PropertyValue::Name(name_ref(id, 0)));
                if id == 0 {
                    assert_eq!(fields.len(), 1);
                } else {
                    let PropertyValue::Struct(payload) = &fields[1].value else {
                        panic!("payload")
                    };
                    assert_eq!(
                        payload.records[0].value,
                        PropertyValue::String("FixtureComponent".into())
                    );
                }
                for end in 0..bytes.len() {
                    assert!(matches!(
                        decode_record(&p, fragment_type(), &bytes[..end]),
                        PropertyValue::Raw { .. }
                    ));
                }
                let mut trailing = bytes;
                trailing.push(0);
                assert!(matches!(
                    decode_record(&p, fragment_type(), &trailing),
                    PropertyValue::Raw { .. }
                ));
            }
            let mut other = p.clone();
            other.names[3] = "/Script/Fixture".into();
            assert!(matches!(
                decode_record(&other, fragment_type(), &fragment(4)),
                PropertyValue::Raw { .. }
            ));
            // A plugin payload can be native even if its first eight bytes look like None.
            assert!(matches!(
                decode_record(
                    &p,
                    fragment_type(),
                    &[9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
                ),
                PropertyValue::Raw { .. }
            ));
        }
        for version in [0, 1011, 1019] {
            assert!(matches!(
                decode_record(&package(version), fragment_type(), &fragment(4)),
                PropertyValue::Raw { .. }
            ));
        }
    }

    #[test]
    fn fragment_arrays_preserve_empty_fragments_and_unknown_or_truncated_later_elements() {
        let p = package(1018);
        let ty = ty(8, vec![fragment_type()]);
        let mut bytes = vec![];
        push_i32(&mut bytes, 2);
        bytes.extend(fragment(4));
        bytes.extend(fragment(0));
        let PropertyValue::Array(values) = decode_record(&p, ty.clone(), &bytes) else {
            panic!("array")
        };
        assert_eq!(values.len(), 2);
        bytes.pop();
        assert!(matches!(
            decode_record(&p, ty.clone(), &bytes),
            PropertyValue::Raw { .. }
        ));
        let mut bytes = vec![];
        push_i32(&mut bytes, 2);
        bytes.extend(fragment(4));
        bytes.extend(fragment(9));
        assert!(matches!(
            decode_record(&p, ty, &bytes),
            PropertyValue::Raw { .. }
        ));
        let bytes = fragment(4);
        let mut reader = Reader::new(&bytes);
        assert!(
            decode(
                &bytes,
                &fragment_type(),
                &mut reader,
                &p,
                "Fixture",
                DecodeScope {
                    depth: MAX_PROPERTY_DECODE_DEPTH,
                    filter: None,
                    formatted_text_budget: None
                }
            )
            .is_none()
        );
        assert_eq!(reader.tell(), 0);
    }
}
