use super::*;
mod property_bag;
use crate::native::{NativeError, NativeValue, decode_native};
use crate::property::{NativeProperty, PropertyErrorKind};
use crate::schema::{SchemaProvider, embedded_source_model};

pub(crate) fn read_layout(
    reader: &mut Reader<'_>,
    name: &str,
    path: &str,
) -> Result<NativeValue, PropertyError> {
    let layout = embedded_source_model().native_layout(name).ok_or_else(|| {
        error(
            reader,
            path,
            PropertyErrorKind::UnsupportedCapability,
            format!("missing native layout {name}"),
        )
    })?;
    decode_native(reader, layout, path).map_err(|failure| match failure {
        NativeError::Archive(failure) => failure.into(),
        NativeError::Layout(message) => error(
            reader,
            path,
            PropertyErrorKind::UnsupportedCapability,
            message,
        ),
    })
}

fn error(
    reader: &Reader<'_>,
    path: &str,
    kind: PropertyErrorKind,
    message: impl Into<String>,
) -> PropertyError {
    PropertyError::new(kind, Some(reader.tell()), path, message)
}

pub(crate) fn property(value: NativeValue) -> PropertyValue {
    match value {
        NativeValue::String(value) => PropertyValue::String(value),
        NativeValue::Name(value) => PropertyValue::Name(value),
        NativeValue::Int64(value) => PropertyValue::Int(value),
        NativeValue::Int32(value) => PropertyValue::Int(i64::from(value)),
        NativeValue::UInt8(value) => PropertyValue::UInt(u64::from(value)),
        NativeValue::Float(value) => PropertyValue::Float(value),
        NativeValue::Double(value) => PropertyValue::Double(value),
        NativeValue::Bool(value) => PropertyValue::Bool(value),
        NativeValue::Record(fields) => PropertyValue::NativeStruct {
            fields: fields
                .into_iter()
                .filter_map(|(name, value)| {
                    (!matches!(value, NativeValue::Padding)).then(|| NativeProperty {
                        name,
                        value: property(value),
                    })
                })
                .collect(),
        },
        NativeValue::Array(values) => {
            PropertyValue::Array(values.into_iter().map(property).collect())
        }
        NativeValue::Map(values) => PropertyValue::Map(
            values
                .into_iter()
                .map(|(key, value)| MapEntry {
                    key: property(key),
                    value: property(value),
                })
                .collect(),
        ),
        NativeValue::Padding => unreachable!("padding is only emitted inside native records"),
    }
}

pub(super) fn known_struct(
    source: &[u8],
    name: &str,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
) -> Result<Option<PropertyValue>, PropertyError> {
    match name {
        "RichCurveKey" => {
            let value = property(read_layout(reader, "FRichCurveKey", path)?);
            Ok(Some(value))
        }
        "MovieSceneFloatChannel" | "MovieSceneDoubleChannel" => {
            if package.summary.versions.ue5 != crate::version::VersionContext::LATEST_SUPPORTED_UE5
            {
                return Err(error(
                    reader,
                    path,
                    PropertyErrorKind::UnsupportedVersion,
                    "native numeric channels currently require the verified UE 5.7 package revision",
                ));
            }
            // FortniteMain 53 introduced the persistent ShowCurve field. Earlier framing
            // must not be guessed from the package revision alone.
            if !matches!(
                custom_version(package, [0x601D1886, 0xAC644F84, 0xAA16D3DE, 0x0DEAC7D6]),
                Some(53..)
            ) {
                return Err(error(
                    reader,
                    path,
                    PropertyErrorKind::UnsupportedVersion,
                    "numeric channel custom version does not include ShowCurve",
                ));
            }
            let value = property(read_layout(reader, &format!("F{name}"), path)?);
            validate_channel(&value, reader, path)?;
            Ok(Some(value))
        }
        "InstancedStruct" => instanced(source, reader, package, path, depth).map(Some),
        _ => Ok(None),
    }
}

/// Source-generated property recipes use package-qualified identities, including when nested
/// in containers or InstancedStruct. A project type sharing an engine short name cannot match.
pub(super) fn property_type_path(module: &str, name: &str) -> Option<&'static str> {
    // Build the borrowed identity index once; do not allocate a joined path for every struct
    // in large tables or maps, including the many types without a native recipe.
    type PropertyTypes = std::collections::BTreeMap<(&'static str, &'static str), &'static str>;
    static TYPES: once_cell::sync::Lazy<PropertyTypes> = once_cell::sync::Lazy::new(|| {
        embedded_source_model()
            .native_layouts
            .keys()
            .filter_map(|path| {
                path.split_once('.')
                    .map(|identity| (identity, path.as_str()))
            })
            .collect()
    });
    TYPES.get(&(module, name)).copied()
}

pub(super) fn generated_value(
    source: &[u8],
    type_path: &str,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
) -> Result<Option<PropertyValue>, PropertyError> {
    if type_path == "/Script/CoreUObject.InstancedPropertyBag" {
        return property_bag::decode(source, reader, package, path, depth).map(Some);
    }
    generated_struct(type_path, reader, package, path)
}

fn generated_struct(
    type_path: &str,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
) -> Result<Option<PropertyValue>, PropertyError> {
    let Some(layout) = embedded_source_model().native_layout(type_path) else {
        return Ok(None);
    };
    if package.summary.versions.ue5 != crate::version::VersionContext::LATEST_SUPPORTED_UE5 {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::UnsupportedVersion,
            "generated native properties require the verified UE 5.7 package revision",
        ));
    }
    let value =
        decode_native(reader, layout, path)
            .map(property)
            .map_err(|failure| match failure {
                NativeError::Archive(failure) => PropertyError::from(failure),
                NativeError::Layout(message) => error(
                    reader,
                    path,
                    PropertyErrorKind::UnsupportedCapability,
                    message,
                ),
            })?;
    if type_path == "/Script/CoreUObject.Box"
        && !matches!(field(&value, "IsValid"), Some(PropertyValue::UInt(0 | 1)))
    {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::MalformedData,
            "box validity must be 0 or 1",
        ));
    }
    if type_path == "/Script/GameplayTags.GameplayTagContainer" {
        let Some(PropertyValue::Array(tags)) = field(&value, "GameplayTags") else {
            unreachable!()
        };
        for tag in tags {
            if !matches!(tag, PropertyValue::Name(name) if package.resolve_name_cow(*name).is_some())
            {
                return Err(error(
                    reader,
                    path,
                    PropertyErrorKind::MalformedData,
                    "gameplay tag has an invalid name reference",
                ));
            }
        }
    }
    Ok(Some(value))
}

fn custom_version(package: &Package, words: [u32; 4]) -> Option<i32> {
    let key = crate::archive::Guid {
        a: words[0],
        b: words[1],
        c: words[2],
        d: words[3],
    };
    package
        .summary
        .custom_versions
        .iter()
        .find(|version| version.key == key)
        .map(|version| version.version)
}

fn field<'a>(value: &'a PropertyValue, name: &str) -> Option<&'a PropertyValue> {
    let PropertyValue::NativeStruct { fields } = value else {
        return None;
    };
    fields
        .iter()
        .find(|field| field.name == name)
        .map(|field| &field.value)
}

fn validate_channel(
    value: &PropertyValue,
    reader: &Reader<'_>,
    path: &str,
) -> Result<(), PropertyError> {
    let Some(PropertyValue::Array(times)) = field(value, "Times") else {
        unreachable!()
    };
    let Some(PropertyValue::Array(values)) = field(value, "Values") else {
        unreachable!()
    };
    if times.len() != values.len() {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::MalformedData,
            "channel key times and values have different counts",
        ));
    }
    if !times.windows(2).all(|pair| matches!((&pair[0], &pair[1]), (PropertyValue::Int(a), PropertyValue::Int(b)) if a <= b)) {
        return Err(error(reader, path, PropertyErrorKind::MalformedData, "channel key times are not ordered"));
    }
    if !matches!(field(value, "TickDenominator"), Some(PropertyValue::Int(value)) if *value > 0) {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::MalformedData,
            "channel tick denominator must be positive",
        ));
    }
    Ok(())
}

fn instanced(
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
            "instanced struct nesting exceeds property depth limit",
        ));
    }
    // Current packages use a custom-versioned header. Legacy variants remain explicitly raw
    // until their framing has independent fixture evidence.
    if package.summary.versions.ue5 != crate::version::VersionContext::LATEST_SUPPORTED_UE5 {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::UnsupportedVersion,
            "InstancedStruct currently requires the verified UE 5.7 package revision",
        ));
    }
    if custom_version(package, [0xE21E1CAA, 0xAF47425E, 0x89BF6AD4, 0x4C44A8BB]) != Some(0) {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::UnsupportedVersion,
            "unsupported InstancedStruct custom version",
        ));
    }
    let header = property(read_layout(reader, "FInstancedStructHeader", path)?);
    let Some(PropertyValue::Int(raw_type)) = field(&header, "StructType") else {
        unreachable!()
    };
    let Some(PropertyValue::Int(size)) = field(&header, "SerialSize") else {
        unreachable!()
    };
    if *size < 0 {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::MalformedData,
            "negative InstancedStruct payload size",
        ));
    }
    let struct_type = PackageIndex::from_raw(*raw_type as i32);
    let payload = crate::archive::Span::new(reader.tell(), *size as u64)?;
    let mut inner = reader.take_bounded(*size as u64, path)?;
    let value = if struct_type == PackageIndex::Null {
        if *size != 0 {
            Some(Box::new(PropertyValue::Raw {
                reason: RawReason::DecoderRejected(
                    "InstancedStruct has no type for its saved payload".into(),
                ),
            }))
        } else {
            None
        }
    } else {
        let type_path = package.resolve_index_str(struct_type).ok_or_else(|| {
            error(
                &inner,
                path,
                PropertyErrorKind::MalformedData,
                "unresolved InstancedStruct type reference",
            )
        })?;
        let name = type_path.rsplit('.').next().unwrap_or(type_path);
        let generated = generated_value(source, type_path, &mut inner, package, path, depth + 1)?;
        let decoded = if generated.is_some() {
            generated
        } else {
            match type_path {
                "/Script/CoreUObject.Vector" => Some(PropertyValue::Vector(decode_vector_value(
                    &mut inner, path,
                )?)),
                "/Script/CoreUObject.IntPoint" => Some(PropertyValue::IntPoint(
                    decode_int_point_value(&mut inner, path)?,
                )),
                "/Script/CoreUObject.Guid" => {
                    Some(PropertyValue::Guid(decode_guid_value(&mut inner, path)?))
                }
                _ => known_struct(source, name, &mut inner, package, path, depth + 1)?,
            }
        };
        let decoded = if let Some(value) = decoded {
            value
        } else {
            // A self-describing tagged stream can be decoded without external project source.
            // Other custom native structs retain their bounded span instead of guessing a layout.
            let attempt = (|| {
                let mut stream = read_tagged_property_stream(
                    &mut inner,
                    &package.summary.versions,
                    &package.names,
                    path,
                )?;
                decode_property_stream_values_at_depth(source, &mut stream, package, depth + 1)?;
                Ok::<_, PropertyError>(PropertyValue::Struct(stream))
            })();
            match attempt {
                Ok(value) if inner.remaining() == 0 => value,
                Err(failure) if failure.kind() == PropertyErrorKind::ResourceLimit => {
                    return Err(failure);
                }
                _ => PropertyValue::Raw {
                    reason: RawReason::DecoderRejected(format!(
                        "unsupported InstancedStruct payload for {type_path}"
                    )),
                },
            }
        };
        if !matches!(decoded, PropertyValue::Raw { .. }) && inner.remaining() != 0 {
            return Err(error(
                &inner,
                path,
                PropertyErrorKind::MalformedData,
                "InstancedStruct has trailing bytes after its decoded value",
            ));
        }
        Some(Box::new(decoded))
    };
    Ok(PropertyValue::InstancedStruct {
        struct_type,
        payload,
        value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::Span;
    use crate::property::read_uobject_tagged_property_stream;
    const FIXTURE: &[u8] = include_bytes!(
        "../../../../fixtures/unreal-project/Content/Fixture/ParserNative/DA_Native.uasset"
    );

    fn payload(package: &Package, name: &str) -> Vec<u8> {
        let export = package
            .exports
            .iter()
            .find(|export| export.is_asset == Some(true))
            .unwrap();
        let mut reader = Reader::new(FIXTURE)
            .bounded(
                Span::new(export.serial_offset.get(), export.serial_size).unwrap(),
                "fixture",
            )
            .unwrap();
        let stream = read_uobject_tagged_property_stream(
            &mut reader,
            &package.summary.versions,
            &package.names,
            "fixture",
        )
        .unwrap();
        let span = stream
            .records
            .iter()
            .find(|record| package.resolve_name(record.name).as_deref() == Some(name))
            .unwrap()
            .payload;
        FIXTURE[span.offset() as usize..span.end() as usize].to_vec()
    }
    fn decode(bytes: &[u8], package: &Package, name: &str) -> Result<PropertyValue, PropertyError> {
        known_struct(bytes, name, &mut Reader::new(bytes), package, "test", 0).map(Option::unwrap)
    }
    #[test]
    fn property_bags_reject_truncation_invalid_names_counts_types_and_custom_versions() {
        let mut package = Package::parse(FIXTURE).unwrap();
        let bytes = payload(&package, "Parameters");
        let read = |bytes: &[u8], package: &Package| {
            generated_value(
                bytes,
                "/Script/CoreUObject.InstancedPropertyBag",
                &mut Reader::new(bytes),
                package,
                "bag",
                0,
            )
        };
        assert!(read(&bytes, &package).is_ok());
        for end in 0..bytes.len() {
            assert!(
                read(&bytes[..end], &package).is_err(),
                "truncated bag at {end}"
            );
        }
        // HasData, descriptor count, first type reference, first FName index/number.
        for (offset, value) in [
            (0, 2),
            (4, -1),
            (4, i32::MAX),
            (8, i32::MAX),
            (28, i32::MAX),
            (32, -1),
        ] {
            let mut bad = bytes.clone();
            bad[offset..offset + 4].copy_from_slice(&i32::to_le_bytes(value));
            assert!(read(&bad, &package).is_err(), "bag offset {offset}");
        }
        for (offset, value) in [(36, 255), (37, 255)] {
            let mut bad = bytes.clone();
            bad[offset] = value;
            assert!(read(&bad, &package).is_err(), "bag offset {offset}");
        }
        // Metadata is framed with an archive bool, not a permissive byte.
        let mut bad = bytes.clone();
        bad[38..42].copy_from_slice(&2_i32.to_le_bytes());
        assert!(read(&bad, &package).is_err());
        let id = crate::archive::Guid {
            a: 0x134A157E,
            b: 0xD5E249A3,
            c: 0x8D4E843C,
            d: 0x98FE9E31,
        };
        let entry = package
            .summary
            .custom_versions
            .iter_mut()
            .find(|v| v.key == id)
            .unwrap();
        entry.version = 6;
        assert_eq!(
            read(&bytes, &package).unwrap_err().kind(),
            PropertyErrorKind::UnsupportedVersion
        );
        assert_eq!(
            property_bag::decode(
                &bytes,
                &mut Reader::new(&bytes),
                &package,
                "bag",
                MAX_PROPERTY_DECODE_DEPTH
            )
            .unwrap_err()
            .kind(),
            PropertyErrorKind::ResourceLimit
        );
    }
    #[test]
    fn channel_framing_rejects_truncation_bad_stride_counts_order_and_boolean() {
        let package = Package::parse(FIXTURE).unwrap();
        for (field, name) in [
            ("FloatChannel", "MovieSceneFloatChannel"),
            ("DoubleChannel", "MovieSceneDoubleChannel"),
            ("EmptyChannel", "MovieSceneFloatChannel"),
        ] {
            let bytes = payload(&package, field);
            assert!(decode(&bytes, &package, name).is_ok());
            for end in 0..bytes.len() {
                assert!(
                    decode(&bytes[..end], &package, name).is_err(),
                    "{name}: truncation {end}"
                );
            }
        }
        let bytes = payload(&package, "FloatChannel");
        for (offset, value, kind) in [
            (2, 8, PropertyErrorKind::UnsupportedCapability),
            (6, -1, PropertyErrorKind::MalformedData),
            (6, i32::MAX, PropertyErrorKind::MalformedData),
            (10, 99, PropertyErrorKind::MalformedData),
            (bytes.len() - 16, 2, PropertyErrorKind::MalformedData),
            (bytes.len() - 8, 0, PropertyErrorKind::MalformedData),
        ] {
            let mut malformed = bytes.clone();
            malformed[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert_eq!(
                decode(&malformed, &package, "MovieSceneFloatChannel")
                    .unwrap_err()
                    .kind(),
                kind,
                "offset {offset}"
            );
        }
        let mut value = decode(&bytes, &package, "MovieSceneFloatChannel").unwrap();
        let PropertyValue::NativeStruct { fields } = &mut value else {
            panic!()
        };
        let PropertyValue::Array(times) = &mut fields
            .iter_mut()
            .find(|field| field.name == "Times")
            .unwrap()
            .value
        else {
            panic!()
        };
        times.pop();
        assert_eq!(
            validate_channel(&value, &Reader::new(&[]), "test")
                .unwrap_err()
                .kind(),
            PropertyErrorKind::MalformedData
        );
    }
    #[test]
    fn instanced_struct_bounds_nulls_unknown_values_and_versions_are_explicit() {
        let package = Package::parse(FIXTURE).unwrap();
        let bytes = payload(&package, "NativeValue");
        for end in 0..bytes.len() {
            assert!(decode(&bytes[..end], &package, "InstancedStruct").is_err());
        }
        for (offset, value) in [(0, i32::MAX), (4, -1), (4, i32::MAX), (4, 23)] {
            let mut malformed = bytes.clone();
            malformed[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(decode(&malformed, &package, "InstancedStruct").is_err());
        }
        let mut trailing = bytes.clone();
        trailing[4..8].copy_from_slice(&25_i32.to_le_bytes());
        trailing.push(0);
        assert!(decode(&trailing, &package, "InstancedStruct").is_err());
        let null = decode(&[0; 8], &package, "InstancedStruct").unwrap();
        assert!(matches!(
            null,
            PropertyValue::InstancedStruct {
                struct_type: PackageIndex::Null,
                value: None,
                ..
            }
        ));
        let opaque = payload(&package, "OpaqueValue");
        let PropertyValue::InstancedStruct {
            payload,
            value: Some(value),
            ..
        } = decode(&opaque, &package, "InstancedStruct").unwrap()
        else {
            panic!()
        };
        assert_eq!(payload.len(), 8);
        assert!(matches!(*value, PropertyValue::Raw { .. }));
        assert_eq!(
            instanced(
                &bytes,
                &mut Reader::new(&bytes),
                &package,
                "test",
                MAX_PROPERTY_DECODE_DEPTH
            )
            .unwrap_err()
            .kind(),
            PropertyErrorKind::ResourceLimit
        );
        let mut old = package.clone();
        old.summary.custom_versions.clear();
        assert_eq!(
            decode(&bytes, &old, "InstancedStruct").unwrap_err().kind(),
            PropertyErrorKind::UnsupportedVersion
        );
        assert_eq!(
            decode(&[], &old, "MovieSceneFloatChannel")
                .unwrap_err()
                .kind(),
            PropertyErrorKind::UnsupportedVersion
        );
        old.summary.versions.ue5 -= 1;
        assert_eq!(
            decode(&[], &old, "MovieSceneFloatChannel")
                .unwrap_err()
                .kind(),
            PropertyErrorKind::UnsupportedVersion
        );
    }
    #[test]
    fn rich_curve_key_is_exactly_bounded_and_numeric() {
        let package = Package::parse(FIXTURE).unwrap();
        let mut bytes = vec![2, 2, 3];
        for value in [-1_f32, 4.5, 1.25, 0.125, -2.5, 0.75] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for end in 0..bytes.len() {
            assert!(decode(&bytes[..end], &package, "RichCurveKey").is_err());
        }
        let value = decode(&bytes, &package, "RichCurveKey").unwrap();
        assert_eq!(field(&value, "Time"), Some(&PropertyValue::Float(-1.0)));
        assert_eq!(
            field(&value, "LeaveTangentWeight"),
            Some(&PropertyValue::Float(0.75))
        );
    }

    #[test]
    fn generated_properties_reject_truncation_bad_counts_names_and_versions() {
        let package = Package::parse(FIXTURE).unwrap();
        for (name, size) in [
            ("Quat", 32),
            ("Vector2D", 16),
            ("Box", 49),
            ("IntVector", 12),
        ] {
            let type_path = format!("/Script/CoreUObject.{name}");
            let bytes = vec![0; size];
            for end in 0..size {
                assert!(
                    generated_struct(
                        &type_path,
                        &mut Reader::new(&bytes[..end]),
                        &package,
                        "test"
                    )
                    .is_err(),
                    "{name}: {end}"
                );
            }
            assert!(
                generated_struct(&type_path, &mut Reader::new(&bytes), &package, "test")
                    .unwrap()
                    .is_some()
            );
            assert!(
                generated_struct(
                    &format!("/Script/Project.{name}"),
                    &mut Reader::new(&bytes),
                    &package,
                    "test"
                )
                .unwrap()
                .is_none()
            );
        }
        let tags = "/Script/GameplayTags.GameplayTagContainer";
        for count in [-1_i32, i32::MAX, 1] {
            assert!(
                generated_struct(
                    tags,
                    &mut Reader::new(&count.to_le_bytes()),
                    &package,
                    "test"
                )
                .is_err()
            );
        }
        let mut bad_name = 1_i32.to_le_bytes().to_vec();
        bad_name.extend_from_slice(&i32::MAX.to_le_bytes());
        bad_name.extend_from_slice(&0_i32.to_le_bytes());
        assert!(generated_struct(tags, &mut Reader::new(&bad_name), &package, "test").is_err());
        let empty = generated_struct(tags, &mut Reader::new(&[0; 4]), &package, "test")
            .unwrap()
            .unwrap();
        assert_eq!(
            field(&empty, "GameplayTags"),
            Some(&PropertyValue::Array(Vec::new()))
        );
        let mut bad_box = vec![0; 49];
        bad_box[48] = 2;
        assert!(
            generated_struct(
                "/Script/CoreUObject.Box",
                &mut Reader::new(&bad_box),
                &package,
                "test"
            )
            .is_err()
        );
        let mut older = package.clone();
        older.summary.versions.ue5 -= 1;
        assert_eq!(
            generated_struct(tags, &mut Reader::new(&[0; 4]), &older, "test")
                .unwrap_err()
                .kind(),
            PropertyErrorKind::UnsupportedVersion
        );
    }
}
