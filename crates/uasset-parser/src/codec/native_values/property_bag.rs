use super::*;

const TYPE: &str = "/Script/CoreUObject.InstancedPropertyBag";

pub(super) fn decode(
    source: &[u8],
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
) -> Result<PropertyValue, PropertyError> {
    if depth >= MAX_PROPERTY_DECODE_DEPTH {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::ResourceLimit,
            "property bag nesting exceeds limit",
        ));
    }
    let version = custom_version(package, [0x134A157E, 0xD5E249A3, 0x8D4E843C, 0x98FE9E31]);
    if package.summary.versions.ue5 != crate::version::VersionContext::LATEST_SUPPORTED_UE5
        || !matches!(version, Some(3 | 5))
    {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::UnsupportedVersion,
            "property bags require verified custom version 3 (UE 5.7) or 5 (UE 5.8)",
        ));
    }
    let version = version.unwrap();
    let has_data = property(read_layout(reader, TYPE, path)?);
    let mut fields = vec![
        named("CustomVersion", PropertyValue::Int(i64::from(version))),
        named("HasData", has_data.clone()),
    ];
    if has_data == PropertyValue::Bool(false) {
        return Ok(PropertyValue::NativeStruct { fields });
    }
    let count = reader.read_count(&format!("{path}.Descriptors"))?;
    let capacity = reader.checked_vec_capacity::<PropertyValue>(count, 34, path)?;
    let mut descriptors = Vec::with_capacity(capacity);
    let mut names = std::collections::HashSet::new();
    for index in 0..count {
        let desc_path = format!("{path}.Descriptors[{index}]");
        let prefix = property(read_layout(
            reader,
            "FPropertyBagDescriptorPrefix",
            &desc_path,
        )?);
        let name = field(&prefix, "Name")
            .expect("generated descriptor name")
            .clone();
        let PropertyValue::Name(name_ref) = name else {
            unreachable!()
        };
        if package.resolve_name_cow(name_ref).is_none() || !names.insert(name_ref) {
            return Err(error(
                reader,
                &desc_path,
                PropertyErrorKind::MalformedData,
                "invalid or duplicate property-bag field name",
            ));
        }
        let PropertyValue::NativeStruct { fields: id } = field(&prefix, "ID").unwrap() else {
            unreachable!()
        };
        let words: Vec<_> = id.iter().map(|f| integer(&f.value) as u32).collect();
        let mut desc = vec![
            named("Name", name),
            named(
                "ID",
                PropertyValue::Guid(crate::archive::Guid {
                    a: words[0],
                    b: words[1],
                    c: words[2],
                    d: words[3],
                }),
            ),
            named(
                "ValueTypeObject",
                object(
                    integer(field(&prefix, "ValueTypeObject").unwrap()) as i32,
                    reader,
                    package,
                    &desc_path,
                )?,
            ),
            named(
                "ValueType",
                type_name(
                    integer(field(&prefix, "ValueType").unwrap()),
                    version,
                    reader,
                    &desc_path,
                )?,
            ),
        ];
        let count = reader.read_u8(&desc_path)?;
        if count > 2 {
            return Err(error(
                reader,
                &desc_path,
                PropertyErrorKind::ResourceLimit,
                "property-bag container nesting exceeds two",
            ));
        }
        let mut containers = Vec::new();
        for _ in 0..count {
            let kind = match reader.read_u8(&desc_path)? {
                1 => "array",
                2 => "set",
                3 if version == 5 => "map",
                _ => {
                    return Err(error(
                        reader,
                        &desc_path,
                        PropertyErrorKind::UnsupportedCapability,
                        "unknown property-bag container type",
                    ));
                }
            };
            containers.push(PropertyValue::String(kind.into()));
        }
        desc.push(named("ContainerTypes", PropertyValue::Array(containers)));
        let has_metadata = reader.read_bool(&desc_path)?;
        if has_metadata {
            let metadata = property(read_layout(reader, "FPropertyBagMetadata", &desc_path)?);
            let PropertyValue::Array(entries) = &metadata else {
                unreachable!()
            };
            for entry in entries {
                if !matches!(field(entry, "Key"), Some(PropertyValue::Name(key)) if package.resolve_name_cow(*key).is_some())
                {
                    return Err(error(
                        reader,
                        &desc_path,
                        PropertyErrorKind::MalformedData,
                        "invalid property-bag metadata name",
                    ));
                }
            }
            desc.push(named("MetaData", metadata));
            let meta_class = reader.read_i32(&desc_path)?;
            desc.push(named(
                "MetaClass",
                object(meta_class, reader, package, &desc_path)?,
            ));
        }
        if version == 5 {
            let layout = crate::schema::embedded_property_bag_ue58_model()
                .native_layout("FPropertyBagDescriptorV5Suffix")
                .expect("generated UE 5.8 suffix");
            let suffix = decode_native(reader, layout, &desc_path)
                .map(property)
                .map_err(|failure| match failure {
                    NativeError::Archive(e) => PropertyError::from(e),
                    NativeError::Layout(message) => error(
                        reader,
                        &desc_path,
                        PropertyErrorKind::UnsupportedCapability,
                        message,
                    ),
                })?;
            desc.push(named(
                "PropertyFlags",
                PropertyValue::UInt(integer(field(&suffix, "PropertyFlags").unwrap()) as u64),
            ));
            desc.push(named(
                "KeyType",
                type_name(
                    integer(field(&suffix, "KeyType").unwrap()),
                    version,
                    reader,
                    &desc_path,
                )?,
            ));
            desc.push(named(
                "KeyTypeObject",
                object(
                    integer(field(&suffix, "KeyTypeObject").unwrap()) as i32,
                    reader,
                    package,
                    &desc_path,
                )?,
            ));
        }
        descriptors.push(PropertyValue::NativeStruct { fields: desc });
    }
    fields.push(named("Descriptors", PropertyValue::Array(descriptors)));
    let size = reader.read_i32(path)?;
    if size < 0 {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::MalformedData,
            "negative property-bag value size",
        ));
    }
    let mut inner = reader.take_bounded(size as u64, path)?;
    let mut stream =
        read_tagged_property_stream(&mut inner, &package.summary.versions, &package.names, path)?;
    if inner.remaining() != 0 {
        return Err(error(
            &inner,
            path,
            PropertyErrorKind::MalformedData,
            "trailing bytes in property-bag value",
        ));
    }
    decode_property_stream_values_at_depth(source, &mut stream, package, depth + 1)?;
    fields.push(named("Value", PropertyValue::Struct(stream)));
    Ok(PropertyValue::NativeStruct { fields })
}

fn named(name: &str, value: PropertyValue) -> NativeProperty {
    NativeProperty {
        name: name.into(),
        value,
    }
}
fn integer(value: &PropertyValue) -> i64 {
    match value {
        PropertyValue::Int(v) => *v,
        PropertyValue::UInt(v) => *v as i64,
        _ => unreachable!("generated integer"),
    }
}
fn object(
    raw: i32,
    reader: &Reader<'_>,
    package: &Package,
    path: &str,
) -> Result<PropertyValue, PropertyError> {
    let index = PackageIndex::from_raw(raw);
    if index != PackageIndex::Null && package.resolve_index_str(index).is_none() {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::MalformedData,
            "invalid property-bag type reference",
        ));
    }
    Ok(PropertyValue::ObjectRef(index))
}
fn type_name(
    raw: i64,
    version: i32,
    reader: &Reader<'_>,
    path: &str,
) -> Result<PropertyValue, PropertyError> {
    const BASE: &[&str] = &[
        "none",
        "bool",
        "byte",
        "int32",
        "int64",
        "float",
        "double",
        "name",
        "string",
        "text",
        "enum",
        "struct",
        "object",
        "soft_object",
        "class",
        "soft_class",
    ];
    let extra: &[&str] = if version == 3 {
        &["uint32", "uint64"]
    } else {
        &["int8", "int16", "uint16", "uint32", "uint64"]
    };
    let value = BASE.iter().chain(extra).nth(raw as usize).ok_or_else(|| {
        error(
            reader,
            path,
            PropertyErrorKind::UnsupportedCapability,
            "unknown property-bag value type",
        )
    })?;
    Ok(PropertyValue::String((*value).into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_type_ids_are_custom_version_specific() {
        let reader = Reader::new(&[]);
        for (raw, version, expected) in [
            (16, 3, "uint32"),
            (17, 3, "uint64"),
            (16, 5, "int8"),
            (19, 5, "uint32"),
            (20, 5, "uint64"),
        ] {
            assert_eq!(
                type_name(raw, version, &reader, "type").unwrap(),
                PropertyValue::String(expected.into())
            );
        }
        assert!(type_name(18, 3, &reader, "type").is_err());
        assert!(type_name(21, 5, &reader, "type").is_err());
    }
}
