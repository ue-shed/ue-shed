//! Exact engine declarations that recover identities omitted by legacy container tags.
use super::*;

#[derive(Clone, Copy)]
enum Element {
    Guid,
    Tagged,
    NiagaraVariable,
    NiagaraVariableBase,
}

fn has_legacy_struct_elements(record: &PropertyRecord, package: &Package, count: usize) -> bool {
    record.type_name.parameters.len() == count
        && record.type_name.parameters.iter().all(|ty| {
            package.resolve_name_str(ty.name) == Some("StructProperty") && ty.parameters.is_empty()
        })
}

pub(crate) fn object_containers(
    source: &[u8],
    stream: &mut PropertyStream,
    class: &str,
    package: &Package,
) {
    // UE 4.27 / 5.7 Niagara/Public/NiagaraComponent.h:
    // InstanceParameterOverrides is TMap<FNiagaraVariableBase, FNiagaraVariant>.
    // NiagaraVariant.h declares tagged Object/DataInterface/Bytes/CurrentMode fields.
    if !package.summary.versions.uses_legacy_property_tags()
        || class != "/Script/Niagara.NiagaraComponent"
    {
        return;
    }
    for record in &mut stream.records {
        if package.resolve_name_str(record.name) == Some("InstanceParameterOverrides")
            && package.resolve_name_str(record.type_name.name) == Some("MapProperty")
            && has_legacy_struct_elements(record, package, 2)
            && matches!(record.value, PropertyValue::Raw { .. })
            && let Ok(decoded) = container(
                source,
                record,
                package,
                0,
                Element::NiagaraVariableBase,
                Some(Element::Tagged),
            )
        {
            record.value = decoded;
        }
    }
}

pub(super) fn declared_containers(
    source: &[u8],
    stream: &mut PropertyStream,
    owner: &PropertyTypeName,
    package: &Package,
    depth: usize,
) {
    if !package.summary.versions.uses_legacy_property_tags() {
        return;
    }
    // UE 4.27 / 5.7 LevelSequence/Public/LevelSequenceBindingReference.h,
    // FLevelSequenceBindingReferences: TMap<FGuid, FLevelSequenceBindingReferenceArray>
    // and TSet<FGuid>. The array struct has only tagged UPROPERTY References.
    let owner_name = resolve_struct_type_name(package, owner);
    let module = owner
        .parameters
        .first()
        .and_then(|ty| ty.parameters.first())
        .and_then(|ty| package.resolve_name_str(ty.name));
    for record in &mut stream.records {
        let name = package.resolve_name_str(record.name);
        let kind = package.resolve_name_str(record.type_name.name);
        let layout = match (owner_name.as_deref(), module, name, kind) {
            (
                Some("LevelSequenceBindingReferences"),
                None | Some("/Script/LevelSequence"),
                Some("BindingIdToReferences"),
                Some("MapProperty"),
            ) => Some((Element::Guid, Some(Element::Tagged))),
            (
                Some("LevelSequenceBindingReferences"),
                None | Some("/Script/LevelSequence"),
                Some("AnimSequenceInstances"),
                Some("SetProperty"),
            ) => Some((Element::Guid, None)),
            // UE 4.27 / 5.7 NiagaraUserRedirectionParameterStore.h:
            // UserParameterRedirects is TMap<FNiagaraVariable, FNiagaraVariable>.
            (
                Some("NiagaraUserRedirectionParameterStore"),
                None | Some("/Script/Niagara"),
                Some("UserParameterRedirects"),
                Some("MapProperty"),
            ) => Some((Element::NiagaraVariable, Some(Element::NiagaraVariable))),
            _ => None,
        };
        if let Some((key, value)) = layout
            && has_legacy_struct_elements(record, package, if value.is_some() { 2 } else { 1 })
            && let Ok(decoded) = container(source, record, package, depth, key, value)
        {
            record.value = decoded;
        }
    }
}

fn tagged(
    source: &[u8],
    reader: &mut Reader<'_>,
    package: &Package,
    depth: usize,
) -> Result<PropertyValue, PropertyError> {
    if depth >= MAX_PROPERTY_DECODE_DEPTH {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::ResourceLimit,
            Some(reader.tell()),
            "DeclaredContainer",
            "property nesting limit",
        ));
    }
    let mut stream = read_tagged_property_stream(
        reader,
        &package.summary.versions,
        &package.names,
        "DeclaredContainer",
    )?;
    decode_property_stream_values_at_depth(source, &mut stream, package, depth + 1)?;
    Ok(PropertyValue::Struct(stream))
}

fn element(
    source: &[u8],
    reader: &mut Reader<'_>,
    package: &Package,
    depth: usize,
    kind: Element,
) -> Result<PropertyValue, PropertyError> {
    match kind {
        Element::Guid => Ok(PropertyValue::Guid(
            reader.read_guid("DeclaredContainer.Guid")?,
        )),
        Element::Tagged => tagged(source, reader, package, depth),
        Element::NiagaraVariable | Element::NiagaraVariableBase => {
            super::native_values::niagara::decode(
                source,
                if matches!(kind, Element::NiagaraVariable) {
                    "NiagaraVariable"
                } else {
                    "NiagaraVariableBase"
                },
                reader,
                package,
                "DeclaredContainer.Variable",
                depth,
            )?
            .map_or_else(|| tagged(source, reader, package, depth), Ok)
        }
    }
}

fn container(
    source: &[u8],
    record: &PropertyRecord,
    package: &Package,
    depth: usize,
    key: Element,
    value: Option<Element>,
) -> Result<PropertyValue, PropertyError> {
    let mut reader = Reader::new(source).bounded(record.payload, "DeclaredContainer")?;
    let removed = reader.read_i32("DeclaredContainer.Removed.Count")?;
    if removed < if value.is_some() { -1 } else { 0 } {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(reader.tell()),
            "DeclaredContainer",
            "invalid removal count",
        ));
    }
    reader.checked_vec_capacity::<PropertyValue>(
        removed.max(0) as usize,
        8,
        "DeclaredContainer.Removed",
    )?;
    for _ in 0..removed.max(0) {
        element(source, &mut reader, package, depth, key)?;
    }
    let count = reader.read_count("DeclaredContainer.Count")?;
    let capacity = reader.checked_vec_capacity::<PropertyValue>(count, 8, "DeclaredContainer")?;
    let decoded = if let Some(value) = value {
        let mut entries = Vec::with_capacity(capacity);
        for _ in 0..count {
            entries.push(MapEntry {
                key: element(source, &mut reader, package, depth, key)?,
                value: element(source, &mut reader, package, depth, value)?,
            });
        }
        PropertyValue::Map(entries)
    } else {
        let mut values = Vec::with_capacity(capacity);
        for _ in 0..count {
            values.push(element(source, &mut reader, package, depth, key)?);
        }
        PropertyValue::Set(values)
    };
    if reader.remaining() != 0 {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(reader.tell()),
            "DeclaredContainer",
            "trailing container bytes",
        ));
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::Span;
    use crate::package::test_package;
    use crate::test_support::{name_ref, push_i32};

    fn record(len: usize, name: i32, kind: i32) -> PropertyRecord {
        PropertyRecord {
            name: name_ref(name, 0),
            type_name: PropertyTypeName {
                name: name_ref(kind, 0),
                parameters: vec![],
            },
            array_index: 0,
            flags: PropertyTagFlags::default(),
            property_guid: None,
            struct_guid: None,
            extensions: None,
            payload: Span::new(0, len as u64).unwrap(),
            value: PropertyValue::Raw {
                reason: RawReason::LegacyContainerElementWithoutTypeInformation,
            },
        }
    }

    #[test]
    fn ue427_declared_guid_map_and_set_are_bounded_including_removed_elements() {
        let mut package = test_package(vec!["None".into()]);
        package.summary.versions.ue5 = 0;
        for map in [false, true] {
            let mut bytes = Vec::new();
            for word in [1, 10, 20, 30, 40, 1, 50, 60, 70, 80] {
                push_i32(&mut bytes, word);
            }
            if map {
                bytes.extend_from_slice(&[0; 8]);
            }
            let entry = record(bytes.len(), 0, 0);
            let value = container(
                &bytes,
                &entry,
                &package,
                0,
                Element::Guid,
                map.then_some(Element::Tagged),
            )
            .unwrap();
            if map {
                assert!(matches!(value, PropertyValue::Map(ref entries) if entries.len() == 1));
            } else {
                assert!(matches!(value, PropertyValue::Set(ref values) if values.len() == 1));
            }
            for end in 0..bytes.len() {
                assert!(
                    container(
                        &bytes,
                        &record(end, 0, 0),
                        &package,
                        0,
                        Element::Guid,
                        map.then_some(Element::Tagged)
                    )
                    .is_err(),
                    "{map}, {end}"
                );
            }
            let mut extra = bytes.clone();
            extra.push(0);
            assert!(
                container(
                    &extra,
                    &record(extra.len(), 0, 0),
                    &package,
                    0,
                    Element::Guid,
                    map.then_some(Element::Tagged)
                )
                .is_err()
            );
            let mut invalid = bytes.clone();
            invalid[..4].copy_from_slice(&(-2_i32).to_le_bytes());
            assert!(
                container(
                    &invalid,
                    &entry,
                    &package,
                    0,
                    Element::Guid,
                    map.then_some(Element::Tagged)
                )
                .is_err()
            );
        }
    }

    #[test]
    fn declared_layout_is_scoped_to_the_engine_owner_and_preserves_rejected_bytes() {
        let mut package = test_package(
            [
                "None",
                "StructProperty",
                "LevelSequenceBindingReferences",
                "BindingIdToReferences",
                "MapProperty",
                "/Script/Other",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        );
        package.summary.versions.ue5 = 0;
        let bytes = [0; 8];
        let mut owner = PropertyTypeName {
            name: name_ref(1, 0),
            parameters: vec![PropertyTypeName {
                name: name_ref(2, 0),
                parameters: vec![],
            }],
        };
        let mut map = record(bytes.len(), 3, 4);
        map.type_name.parameters = vec![
            PropertyTypeName {
                name: name_ref(1, 0),
                parameters: vec![]
            };
            2
        ];
        let stream = PropertyStream {
            class_extensions: None,
            records: vec![map],
            terminator: Span::default(),
        };
        let mut decoded = stream.clone();
        declared_containers(&bytes, &mut decoded, &owner, &package, 0);
        assert_eq!(decoded.records[0].value, PropertyValue::Map(vec![]));
        owner.parameters[0].parameters.push(PropertyTypeName {
            name: name_ref(5, 0),
            parameters: vec![],
        });
        let mut other = stream.clone();
        declared_containers(&bytes, &mut other, &owner, &package, 0);
        assert_eq!(other, stream);
        owner.parameters[0].parameters.clear();
        let mut truncated = stream.clone();
        truncated.records[0].payload = Span::new(0, 7).unwrap();
        let original = truncated.clone();
        declared_containers(&bytes, &mut truncated, &owner, &package, 0);
        assert_eq!(truncated, original);
    }

    #[test]
    fn ue427_niagara_redirects_and_instance_overrides_use_declared_key_and_value_layouts() {
        use crate::package::CustomVersion;
        let mut package = test_package(vec!["None".into(), "Value".into()]);
        package.summary.versions.ue5 = 0;
        package.summary.custom_versions.push(CustomVersion {
            key: Guid {
                a: 0xFCF57AFA,
                b: 0x50764283,
                c: 0xB9A9E658,
                d: 0xFFA02D32,
            },
            version: 64,
            friendly_name: None,
        });
        for redirects in [true, false] {
            let mut bytes = Vec::new();
            for word in [0, 1, 1, 0, 0, 0] {
                push_i32(&mut bytes, word);
            }
            if redirects {
                // Key VarData, then value Name + tagged type definition + VarData.
                for word in [0, 1, 0, 0, 0, 0] {
                    push_i32(&mut bytes, word);
                }
            } else {
                bytes.extend_from_slice(&[0; 8]);
            } // Tagged FNiagaraVariant.
            let (key, value) = if redirects {
                (Element::NiagaraVariable, Element::NiagaraVariable)
            } else {
                (Element::NiagaraVariableBase, Element::Tagged)
            };
            assert!(
                matches!(container(&bytes, &record(bytes.len(), 0, 0), &package, 0, key, Some(value)).unwrap(), PropertyValue::Map(ref entries) if entries.len() == 1)
            );
            for end in 0..bytes.len() {
                assert!(
                    container(&bytes, &record(end, 0, 0), &package, 0, key, Some(value)).is_err(),
                    "{redirects}, {end}"
                );
            }
        }
    }

    #[test]
    fn data_table_row_handle_accepts_elided_defaults_but_rejects_wrong_saved_types() {
        let package = test_package(vec![
            "None".into(),
            "DataTable".into(),
            "RowName".into(),
            "Value".into(),
        ]);
        let mut stream = PropertyStream {
            class_extensions: None,
            records: vec![],
            terminator: Span::default(),
        };
        let expected = PropertyValue::Struct(stream.clone());
        assert_eq!(
            decode_data_table_row_handle(&stream, &package, "Fixture").unwrap(),
            expected
        );
        let mut row = record(0, 2, 0);
        row.value = PropertyValue::Name(name_ref(3, 0));
        stream.records.push(row);
        assert!(matches!(
            decode_data_table_row_handle(&stream, &package, "Fixture").unwrap(),
            PropertyValue::Struct(ref saved) if saved.records.len() == 1
        ));
        stream.records[0].value = PropertyValue::Int(1);
        assert!(decode_data_table_row_handle(&stream, &package, "Fixture").is_err());
    }
}
