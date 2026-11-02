//! FOptionalProperty's saved presence flag and inner SerializeItem value.
use super::*;
use crate::property::NativeProperty;

#[allow(clippy::too_many_arguments)]
pub(super) fn decode(
    source: &[u8],
    ty: &PropertyTypeName,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    scope: DecodeScope<'_>,
    serializer: ContainerSerializer,
) -> Option<PropertyValue> {
    // UE5.7/5.8 PropertyOptional.cpp: before complete type names (1012), a set
    // optional has a second property tag. Keep that older representation raw.
    if !matches!(package.summary.versions.ue5, 1012..=1018)
        || ty.parameters.len() != 1
        || scope.depth >= MAX_PROPERTY_DECODE_DEPTH
    {
        return None;
    }
    let inner = &ty.parameters[0];
    let name = package.resolve_name_str(inner.name)?;
    let mut probe = reader.clone();
    // BinaryArchiveFormatter::TryEnterField serializes an archive bool (uint32).
    let is_set = read_archive_bool(&mut probe, path).ok()?;
    let mut fields = vec![NativeProperty {
        name: Cow::Borrowed("IsSet"),
        value: PropertyValue::Bool(is_set),
    }];
    if is_set {
        let value = if name == "BoolProperty" {
            // FBoolProperty::SerializeItem writes one byte, unlike presence above
            // and unlike scalar tagged bools whose value lives in the tag flags.
            match probe.read_u8(path).ok()? {
                0 => PropertyValue::Bool(false),
                1 => PropertyValue::Bool(true),
                _ => return None,
            }
        } else {
            let budget =
                std::cell::Cell::new(crate::archive::ArchiveLimits::default().max_allocation_bytes);
            let scope = DecodeScope {
                formatted_text_budget: Some(scope.formatted_text_budget.unwrap_or(&budget)),
                ..scope
            };
            let spec = TypeSpec {
                name,
                tree: inner,
                struct_guid: None,
            };
            decode_container_element(
                source,
                spec,
                &struct_facts(package, spec),
                &mut probe,
                package,
                path,
                scope.nested(),
                serializer,
            )
            .ok()??
        };
        fields.push(NativeProperty {
            name: Cow::Borrowed("Value"),
            value,
        });
    }
    *reader = probe;
    Some(PropertyValue::NativeStruct { fields })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::Span;
    use crate::package::test_package;
    use crate::test_support::{name_ref, push_fstring};

    fn ty(index: i32, parameters: Vec<PropertyTypeName>) -> PropertyTypeName {
        PropertyTypeName {
            name: name_ref(index, 0),
            parameters,
        }
    }

    fn package(version: i32) -> Package {
        let mut p = test_package(
            [
                "OptionalProperty",
                "BoolProperty",
                "IntProperty",
                "TextProperty",
                "ArrayProperty",
                "UnknownProperty",
                "Value",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        p.summary.versions.ue5 = version;
        p
    }

    fn decode_record(
        package: &Package,
        inner: PropertyTypeName,
        bytes: &[u8],
        flags: u8,
    ) -> PropertyValue {
        let mut record = PropertyRecord {
            name: name_ref(6, 0),
            type_name: ty(0, vec![inner]),
            array_index: 0,
            flags: PropertyTagFlags(flags),
            property_guid: None,
            struct_guid: None,
            extensions: None,
            payload: Span::new(0, bytes.len() as u64).unwrap(),
            value: PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            },
        };
        decode_property_record(bytes, &mut record, package, DecodeScope::root(None)).unwrap();
        record.value
    }

    fn expected(value: Option<PropertyValue>) -> PropertyValue {
        let mut fields = vec![NativeProperty {
            name: Cow::Borrowed("IsSet"),
            value: PropertyValue::Bool(value.is_some()),
        }];
        if let Some(value) = value {
            fields.push(NativeProperty {
                name: Cow::Borrowed("Value"),
                value,
            });
        }
        PropertyValue::NativeStruct { fields }
    }

    #[test]
    fn optional_presence_is_distinct_from_false_zero_and_nested_unset() {
        for version in [1012, 1017, 1018] {
            let p = package(version);
            for flags in [0, 8] {
                for (bytes, value) in [
                    (vec![0, 0, 0, 0], None),
                    (vec![1, 0, 0, 0, 0], Some(PropertyValue::Bool(false))),
                    (vec![1, 0, 0, 0, 1], Some(PropertyValue::Bool(true))),
                ] {
                    assert_eq!(
                        decode_record(&p, ty(1, vec![]), &bytes, flags),
                        expected(value)
                    );
                    for end in 0..bytes.len() {
                        assert!(matches!(
                            decode_record(&p, ty(1, vec![]), &bytes[..end], flags),
                            PropertyValue::Raw { .. }
                        ));
                    }
                    let mut trailing = bytes;
                    trailing.push(0);
                    assert!(matches!(
                        decode_record(&p, ty(1, vec![]), &trailing, flags),
                        PropertyValue::Raw { .. }
                    ));
                }
                assert_eq!(
                    decode_record(&p, ty(2, vec![]), &[1, 0, 0, 0, 0, 0, 0, 0], flags),
                    expected(Some(PropertyValue::Int(0)))
                );
                assert_eq!(
                    decode_record(
                        &p,
                        ty(0, vec![ty(1, vec![])]),
                        &[1, 0, 0, 0, 0, 0, 0, 0],
                        flags
                    ),
                    expected(Some(expected(None)))
                );
            }
            for bad in [&[2, 0, 0, 0][..], &[1, 0, 0, 0, 2], &[1, 0, 0, 1, 0]] {
                assert!(matches!(
                    decode_record(&p, ty(1, vec![]), bad, 0),
                    PropertyValue::Raw { .. }
                ));
            }
            assert!(matches!(
                decode_record(&p, ty(5, vec![]), &[1, 0, 0, 0], 0),
                PropertyValue::Raw { .. }
            ));
        }
        for version in [0, 1011, 1019] {
            assert!(matches!(
                decode_record(&package(version), ty(1, vec![]), &[1, 0, 0, 0, 1], 0),
                PropertyValue::Raw { .. }
            ));
        }
    }

    #[test]
    fn optional_text_arrays_and_reader_bounds_preserve_following_values() {
        let p = package(1018);
        let mut text = vec![1, 0, 0, 0, 0, 0, 0, 0, 0];
        for field in ["Fixture", "OptionalKey", "Optional text"] {
            push_fstring(&mut text, field);
        }
        let PropertyValue::NativeStruct { fields } = decode_record(&p, ty(3, vec![]), &text, 0)
        else {
            panic!("optional")
        };
        assert!(
            matches!(&fields[1].value, PropertyValue::Text(text) if text.source=="Optional text")
        );
        let base = |source: &str| {
            let mut bytes = vec![0; 5];
            for value in ["Fixture", "FormatKey", source] {
                push_fstring(&mut bytes, value);
            }
            bytes
        };
        let mut formatted = vec![1, 0, 0, 0, 0, 0, 0, 0, 2];
        formatted.extend(base("{0}|End"));
        formatted.extend(1_i32.to_le_bytes());
        formatted.push(4);
        formatted.extend(base("Start"));
        let PropertyValue::NativeStruct { fields } =
            decode_record(&p, ty(3, vec![]), &formatted, 0)
        else {
            panic!("formatted optional")
        };
        assert!(matches!(&fields[1].value, PropertyValue::Text(text) if text.source=="Start|End"));
        let bytes = [1, 0, 0, 0, 2, 0, 0, 0, 7, 0, 0, 0, 9, 0, 0, 0];
        assert_eq!(
            decode_record(&p, ty(4, vec![ty(2, vec![])]), &bytes, 0),
            expected(Some(PropertyValue::Array(vec![
                PropertyValue::Int(7),
                PropertyValue::Int(9)
            ])))
        );
        let mut bytes = vec![1, 0, 0, 0, 1, 99];
        let mut reader = Reader::new(&bytes);
        assert!(
            decode(
                &bytes,
                &ty(0, vec![ty(1, vec![])]),
                &mut reader,
                &p,
                "Fixture",
                DecodeScope::root(None),
                ContainerSerializer::Tagged
            )
            .is_some()
        );
        assert_eq!(reader.read_u8("Following").unwrap(), 99);
        bytes[0] = 2;
        let mut reader = Reader::new(&bytes);
        assert!(
            decode(
                &bytes,
                &ty(0, vec![ty(1, vec![])]),
                &mut reader,
                &p,
                "Fixture",
                DecodeScope::root(None),
                ContainerSerializer::Tagged
            )
            .is_none()
        );
        assert_eq!(reader.tell(), 0);
    }
}
