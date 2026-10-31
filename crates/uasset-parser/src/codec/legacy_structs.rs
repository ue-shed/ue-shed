//! Exact engine declarations that recover identities omitted by legacy container tags.
use super::*;

#[derive(Clone, Copy)]
enum Element {
    Guid,
    Tagged,
    NiagaraVariable,
    NiagaraVariableBase,
    Name,
    Object,
    Text,
}

fn has_legacy_elements(
    record: &PropertyRecord,
    package: &Package,
    key: Element,
    value: Option<Element>,
) -> bool {
    let expected = std::iter::once(key).chain(value);
    record.type_name.parameters.len() == if value.is_some() { 2 } else { 1 }
        && record
            .type_name
            .parameters
            .iter()
            .zip(expected)
            .all(|(ty, kind)| {
                let name = match kind {
                    Element::Name => "NameProperty",
                    Element::Object => "ObjectProperty",
                    Element::Text => "TextProperty",
                    _ => "StructProperty",
                };
                package.resolve_name_str(ty.name) == Some(name) && ty.parameters.is_empty()
            })
}

fn is_gap(record: &PropertyRecord) -> bool {
    matches!(record.value, PropertyValue::Raw { ref reason } if *reason != RawReason::NotRequested)
}

pub(crate) fn object_containers(
    source: &[u8],
    stream: &mut PropertyStream,
    class: &str,
    package: &Package,
    scope: DecodeScope<'_>,
) {
    // UE 4.27 / 5.7 / 5.8 Niagara/Public/NiagaraComponent.h:
    // InstanceParameterOverrides is TMap<FNiagaraVariableBase, FNiagaraVariant>.
    // NiagaraVariant.h declares tagged Object/DataInterface/Bytes/CurrentMode fields.
    if !package.summary.versions.uses_legacy_property_tags()
        || !matches!(
            class,
            "/Script/Niagara.NiagaraComponent"
                | "/Script/NiagaraEditor.NiagaraNodeFunctionCall"
                | "/Script/NiagaraEditor.NiagaraGraph"
                | "/Script/NiagaraEditor.NiagaraNodeParameterMapGet"
        )
    {
        return;
    }
    for record in &mut stream.records {
        // Exact declarations in Niagara{Component,Graph,NodeFunctionCall,
        // NodeParameterMapGet}.h. No class-name suffix or byte-shape inference.
        let layout = match (class, package.resolve_name_str(record.name)) {
            ("/Script/Niagara.NiagaraComponent", Some("InstanceParameterOverrides")) => {
                Some((Element::NiagaraVariableBase, Element::Tagged))
            }
            ("/Script/NiagaraEditor.NiagaraNodeFunctionCall", Some("BoundPinNames")) => {
                Some((Element::Guid, Element::Name))
            }
            ("/Script/NiagaraEditor.NiagaraGraph", Some("VariableToScriptVariable")) => {
                Some((Element::NiagaraVariable, Element::Object))
            }
            (
                "/Script/NiagaraEditor.NiagaraNodeParameterMapGet",
                Some("PinOutputToPinDefaultPersistentId"),
            ) => Some((Element::Guid, Element::Guid)),
            _ => None,
        };
        if let Some((key, value)) = layout
            && package.resolve_name_str(record.type_name.name) == Some("MapProperty")
            && has_legacy_elements(record, package, key, Some(value))
            && is_gap(record)
            && let Ok(decoded) = container(source, record, package, scope, key, Some(value))
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
    scope: DecodeScope<'_>,
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
            // NiagaraParameterStore.h (including reflected inherited fields) and
            // NiagaraCommon.h, verified in UE 4.27 / 5.7 / 5.8.
            (
                Some("NiagaraParameterStore" | "NiagaraUserRedirectionParameterStore"),
                None | Some("/Script/Niagara"),
                Some("ParameterGuidMapping"),
                Some("MapProperty"),
            ) => Some((Element::NiagaraVariable, Some(Element::Guid))),
            (
                Some("NiagaraFunctionSignature"),
                None | Some("/Script/Niagara"),
                Some("InputDescriptions" | "OutputDescriptions"),
                Some("MapProperty"),
            ) => Some((Element::NiagaraVariableBase, Some(Element::Text))),
            _ => None,
        };
        if let Some((key, value)) = layout
            && has_legacy_elements(record, package, key, value)
            && is_gap(record)
            && let Ok(decoded) = container(source, record, package, scope, key, value)
        {
            record.value = decoded;
        }
    }
}

fn tagged(
    source: &[u8],
    reader: &mut Reader<'_>,
    package: &Package,
    scope: DecodeScope<'_>,
) -> Result<PropertyValue, PropertyError> {
    if scope.depth >= MAX_PROPERTY_DECODE_DEPTH {
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
    decode_property_stream_values_at_depth(source, &mut stream, package, scope.nested())?;
    Ok(PropertyValue::Struct(Box::new(stream)))
}

fn element(
    source: &[u8],
    reader: &mut Reader<'_>,
    package: &Package,
    scope: DecodeScope<'_>,
    kind: Element,
) -> Result<PropertyValue, PropertyError> {
    match kind {
        Element::Guid => Ok(PropertyValue::Guid(
            reader.read_guid("DeclaredContainer.Guid")?,
        )),
        Element::Tagged => tagged(source, reader, package, scope),
        Element::Name => {
            let name = reader.read_name_ref("DeclaredContainer.Name")?;
            if package.resolve_name_cow(name).is_some() {
                Ok(PropertyValue::Name(name))
            } else {
                Err(invalid_element(reader))
            }
        }
        Element::Object => {
            let index = PackageIndex::from_raw(reader.read_i32("DeclaredContainer.Object")?);
            if index == PackageIndex::Null || package.resolve_index(index).is_some() {
                Ok(PropertyValue::ObjectRef(index))
            } else {
                Err(invalid_element(reader))
            }
        }
        Element::Text => decode_text_value(reader, package, "DeclaredContainer.Text")?
            .map(|value| PropertyValue::Text(Box::new(value)))
            .ok_or_else(|| invalid_element(reader)),
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
                scope,
            )?
            .map_or_else(|| tagged(source, reader, package, scope), Ok)
        }
    }
}

fn invalid_element(reader: &Reader<'_>) -> PropertyError {
    PropertyError::new(
        crate::property::PropertyErrorKind::MalformedData,
        Some(reader.tell()),
        "DeclaredContainer",
        "unresolved declared container element",
    )
}

fn container(
    source: &[u8],
    record: &PropertyRecord,
    package: &Package,
    scope: DecodeScope<'_>,
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
        element(source, &mut reader, package, scope, key)?;
    }
    let count = reader.read_count("DeclaredContainer.Count")?;
    let capacity = reader.checked_vec_capacity::<PropertyValue>(count, 8, "DeclaredContainer")?;
    let decoded = if let Some(value) = value {
        let mut entries = Vec::with_capacity(capacity);
        for _ in 0..count {
            entries.push(MapEntry {
                key: element(source, &mut reader, package, scope, key)?,
                value: element(source, &mut reader, package, scope, value)?,
            });
        }
        PropertyValue::Map(entries)
    } else {
        let mut values = Vec::with_capacity(capacity);
        for _ in 0..count {
            values.push(element(source, &mut reader, package, scope, key)?);
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
                DecodeScope::root(None),
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
                        DecodeScope::root(None),
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
                    DecodeScope::root(None),
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
                    DecodeScope::root(None),
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
        declared_containers(
            &bytes,
            &mut decoded,
            &owner,
            &package,
            DecodeScope::root(None),
        );
        assert_eq!(decoded.records[0].value, PropertyValue::Map(vec![]));
        owner.parameters[0].parameters.push(PropertyTypeName {
            name: name_ref(5, 0),
            parameters: vec![],
        });
        let mut other = stream.clone();
        declared_containers(
            &bytes,
            &mut other,
            &owner,
            &package,
            DecodeScope::root(None),
        );
        assert_eq!(other, stream);
        owner.parameters[0].parameters.clear();
        let mut truncated = stream.clone();
        truncated.records[0].payload = Span::new(0, 7).unwrap();
        let original = truncated.clone();
        declared_containers(
            &bytes,
            &mut truncated,
            &owner,
            &package,
            DecodeScope::root(None),
        );
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
                matches!(container(&bytes, &record(bytes.len(), 0, 0), &package, DecodeScope::root(None), key, Some(value)).unwrap(), PropertyValue::Map(ref entries) if entries.len() == 1)
            );
            for end in 0..bytes.len() {
                assert!(
                    container(
                        &bytes,
                        &record(end, 0, 0),
                        &package,
                        DecodeScope::root(None),
                        key,
                        Some(value)
                    )
                    .is_err(),
                    "{redirects}, {end}"
                );
            }
        }
    }

    fn niagara_package() -> Package {
        let mut package = test_package(
            [
                "None",
                "StructProperty",
                "MapProperty",
                "NameProperty",
                "ObjectProperty",
                "TextProperty",
                "BoundPinNames",
                "VariableToScriptVariable",
                "PinOutputToPinDefaultPersistentId",
                "FixtureValue",
                "NiagaraParameterStore",
                "ParameterGuidMapping",
                "NiagaraFunctionSignature",
                "InputDescriptions",
                "/Script/Niagara",
                "/Script/Other",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        package.summary.versions.ue5 = 0;
        package
            .summary
            .custom_versions
            .push(crate::package::CustomVersion {
                key: Guid {
                    a: 0xFCF57AFA,
                    b: 0x50764283,
                    c: 0xB9A9E658,
                    d: 0xFFA02D32,
                },
                version: 64,
                friendly_name: None,
            });
        package
    }

    fn map_stream(bytes: &[u8], field: i32, value_kind: i32) -> PropertyStream {
        let mut map = record(bytes.len(), field, 2);
        map.type_name.parameters = [1, value_kind]
            .into_iter()
            .map(|index| PropertyTypeName {
                name: name_ref(index, 0),
                parameters: vec![],
            })
            .collect();
        PropertyStream {
            class_extensions: None,
            records: vec![map],
            terminator: Span::default(),
        }
    }

    fn variable(bytes: &mut Vec<u8>, base: bool) {
        for word in [9, 0, 0, 0] {
            push_i32(bytes, word);
        }
        if !base {
            push_i32(bytes, 0);
        }
    }

    #[test]
    fn niagara_object_maps_require_exact_declarations_and_preserve_filters_and_failed_probes() {
        let package = niagara_package();
        for (class, field, value_kind) in [
            ("/Script/NiagaraEditor.NiagaraNodeFunctionCall", 6, 3),
            ("/Script/NiagaraEditor.NiagaraGraph", 7, 4),
            ("/Script/NiagaraEditor.NiagaraNodeParameterMapGet", 8, 1),
        ] {
            let mut bytes = vec![];
            // One removed key, then one saved entry.
            push_i32(&mut bytes, 1);
            if field == 7 {
                variable(&mut bytes, false);
            } else {
                bytes.extend_from_slice(&[1; 16]);
            }
            push_i32(&mut bytes, 1);
            if field == 7 {
                variable(&mut bytes, false);
            } else {
                bytes.extend_from_slice(&[2; 16]);
            }
            match field {
                6 => {
                    push_i32(&mut bytes, 9);
                    push_i32(&mut bytes, 0);
                }
                7 => push_i32(&mut bytes, 0),
                _ => bytes.extend_from_slice(&[3; 16]),
            }
            let original = map_stream(&bytes, field, value_kind);
            let mut stream = original.clone();
            object_containers(
                &bytes,
                &mut stream,
                class,
                &package,
                DecodeScope::root(None),
            );
            assert!(
                matches!(stream.records[0].value, PropertyValue::Map(ref values) if values.len() == 1)
            );
            let mut wrong_owner = original.clone();
            object_containers(
                &bytes,
                &mut wrong_owner,
                "/Script/Fixture.NiagaraGraph",
                &package,
                DecodeScope::root(None),
            );
            assert_eq!(wrong_owner, original);
            for value in [
                PropertyValue::Raw {
                    reason: RawReason::NotRequested,
                },
                PropertyValue::Map(vec![]),
            ] {
                let mut stream = original.clone();
                stream.records[0].value = value;
                let saved = stream.clone();
                object_containers(
                    &bytes,
                    &mut stream,
                    class,
                    &package,
                    DecodeScope::root(None),
                );
                assert_eq!(stream, saved);
            }
            for end in 0..bytes.len() {
                let mut stream = original.clone();
                stream.records[0].payload = Span::new(0, end as u64).unwrap();
                let saved = stream.clone();
                object_containers(
                    &bytes,
                    &mut stream,
                    class,
                    &package,
                    DecodeScope::root(None),
                );
                assert_eq!(stream, saved, "{class}: {end}");
            }
            if field != 8 {
                let offset = bytes.len() - if field == 6 { 8 } else { 4 };
                bytes[offset..offset + 4].copy_from_slice(&i32::MAX.to_le_bytes());
                let mut stream = original.clone();
                object_containers(
                    &bytes,
                    &mut stream,
                    class,
                    &package,
                    DecodeScope::root(None),
                );
                assert_eq!(stream, original);
            }
        }
    }

    #[test]
    fn niagara_struct_maps_recover_guid_and_text_values_only_in_the_declaring_module() {
        let package = niagara_package();
        for (owner, field, kind) in [(10, 11, 1), (12, 13, 5)] {
            let mut bytes = vec![];
            push_i32(&mut bytes, 0);
            push_i32(&mut bytes, 1);
            variable(&mut bytes, owner == 12);
            if owner == 10 {
                bytes.extend_from_slice(&[4; 16]);
            } else {
                push_i32(&mut bytes, 0); // FText flags and Base history.
                bytes.push(0);
                for value in ["Fixture", "Description", "Synthetic text"] {
                    crate::test_support::push_fstring(&mut bytes, value);
                }
            }
            let original = map_stream(&bytes, field, kind);
            let mut ty = PropertyTypeName {
                name: name_ref(1, 0),
                parameters: vec![PropertyTypeName {
                    name: name_ref(owner, 0),
                    parameters: vec![PropertyTypeName {
                        name: name_ref(14, 0),
                        parameters: vec![],
                    }],
                }],
            };
            let mut stream = original.clone();
            declared_containers(&bytes, &mut stream, &ty, &package, DecodeScope::root(None));
            assert!(
                matches!(stream.records[0].value, PropertyValue::Map(ref entries) if entries.len() == 1)
            );
            ty.parameters[0].parameters[0].name = name_ref(15, 0);
            let mut stream = original.clone();
            declared_containers(&bytes, &mut stream, &ty, &package, DecodeScope::root(None));
            assert_eq!(stream, original);
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
        let expected = PropertyValue::Struct(Box::new(stream.clone()));
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
