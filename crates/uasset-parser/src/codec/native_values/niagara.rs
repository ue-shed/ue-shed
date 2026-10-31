//! Custom-versioned Niagara native variable records.
use super::*;

/// VariablesUseTypeDefRegistry (64) writes a name and a tagged type definition in
/// UE 4.27 and UE 5.6–5.8. Unsupported versions retain tagged fallback.
pub(in crate::codec) fn applies(package: &Package) -> bool {
    matches!(package.summary.versions.ue5, 0 | 1000..=1018)
        && matches!(
            custom_version(package, [0xFCF57AFA, 0x50764283, 0xB9A9E658, 0xFFA02D32]),
            Some(64..)
        )
}

pub(in crate::codec) fn decode(
    source: &[u8],
    name: &str,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    scope: DecodeScope<'_>,
) -> Result<Option<PropertyValue>, PropertyError> {
    if package.summary.versions.ue5 != 0 {
        if !applies(package) {
            return Ok(None);
        }
        let mut probe = reader.clone();
        return match decode_record(source, name, &mut probe, package, path, scope) {
            Ok(value) => {
                *reader = probe;
                Ok(value)
            }
            Err(_) => Ok(None),
        };
    }
    decode_record(source, name, reader, package, path, scope)
}

fn decode_record(
    source: &[u8],
    name: &str,
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    scope: DecodeScope<'_>,
) -> Result<Option<PropertyValue>, PropertyError> {
    // UE 4.27 / 5.6–5.8 Niagara/Private/NiagaraModule.cpp, FNiagaraVariableBase::Serialize,
    // FNiagaraVariable::Serialize and operator<<(FNiagaraTypeDefinitionHandle&);
    // NiagaraParameterStore.cpp, FNiagaraVariableWithOffset::Serialize.
    // VariablesUseTypeDefRegistry=64: FName, tagged type definition, then bytes/offset.
    // UE4 FNiagaraTypeDefinition::Serialize returns false for tagged fallback; UE5
    // calls SerializeTaggedProperties directly. Reflected fields differ, but the
    // package tag reader owns their layout in both paths.
    if !applies(package) {
        return Ok(None);
    }
    if scope.depth >= MAX_PROPERTY_DECODE_DEPTH {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::ResourceLimit,
            "Niagara nesting limit",
        ));
    }
    let variable_name = reader.read_name_ref(path)?;
    if package.resolve_name(variable_name).is_none() {
        return Err(error(
            reader,
            path,
            PropertyErrorKind::MalformedData,
            "unresolved Niagara variable name",
        ));
    }
    let mut type_def =
        read_tagged_property_stream(reader, &package.summary.versions, &package.names, path)?;
    decode_property_stream_values_at_depth(source, &mut type_def, package, scope.nested())?;
    let mut fields = vec![
        NativeProperty {
            name: Cow::Borrowed("Name"),
            value: PropertyValue::Name(variable_name),
        },
        NativeProperty {
            name: Cow::Borrowed("TypeDefHandle"),
            value: PropertyValue::Struct(Box::new(type_def)),
        },
    ];
    if name == "NiagaraVariable" {
        let count = reader.read_count(path)?;
        reader.checked_vec_capacity::<PropertyValue>(count, 1, path)?;
        let bytes = reader.read_bytes(count, path)?;
        fields.push(NativeProperty {
            name: Cow::Borrowed("VarData"),
            value: PropertyValue::Array(
                bytes
                    .iter()
                    .map(|value| PropertyValue::UInt(u64::from(*value)))
                    .collect(),
            ),
        });
    } else if name == "NiagaraVariableWithOffset" {
        fields.push(NativeProperty {
            name: Cow::Borrowed("Offset"),
            value: PropertyValue::Int(i64::from(reader.read_i32(path)?)),
        });
    }
    Ok(Some(PropertyValue::NativeStruct { fields }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::{CustomVersion, test_package};
    use crate::test_support::push_i32;

    #[test]
    fn ue5_variable_recipe_is_separate_and_failures_restore_tagged_or_opaque_fallback() {
        let mut package = test_package(vec!["None".into(), "Value".into()]);
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
        for version in [1016, 1017, 1018] {
            package.summary.versions.ue5 = version;
            for name in [
                "NiagaraVariableBase",
                "NiagaraVariable",
                "NiagaraVariableWithOffset",
            ] {
                let mut bytes = vec![];
                for word in [1, 0, 0, 0] {
                    push_i32(&mut bytes, word);
                }
                if name != "NiagaraVariableBase" {
                    push_i32(&mut bytes, 0);
                }
                let mut reader = Reader::new(&bytes);
                assert!(
                    decode(
                        &bytes,
                        name,
                        &mut reader,
                        &package,
                        "Fixture",
                        DecodeScope::root(None)
                    )
                    .unwrap()
                    .is_some()
                );
                assert_eq!(reader.remaining(), 0);
                for end in 0..bytes.len() {
                    let mut reader = Reader::new(&bytes[..end]);
                    assert!(
                        decode(
                            &bytes,
                            name,
                            &mut reader,
                            &package,
                            "Fixture",
                            DecodeScope::root(None)
                        )
                        .unwrap()
                        .is_none()
                    );
                    assert_eq!(reader.tell(), 0);
                }
                // Tagged NAME_None still parses exactly as before after recipe rejection.
                let tagged = [0; 8];
                let mut reader = Reader::new(&tagged);
                assert!(
                    decode(
                        &tagged,
                        name,
                        &mut reader,
                        &package,
                        "Fixture",
                        DecodeScope::root(None)
                    )
                    .unwrap()
                    .is_none()
                );
                assert!(
                    read_tagged_property_stream(
                        &mut reader,
                        &package.summary.versions,
                        &package.names,
                        "Fixture"
                    )
                    .is_ok()
                );
                assert!(!is_known_struct(name, &package));
            }
        }
        for version in [999, 1019] {
            package.summary.versions.ue5 = version;
            assert!(!applies(&package));
        }
    }

    #[test]
    fn ue427_variable_records_follow_the_custom_version_and_reject_every_truncation() {
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
        for name in [
            "NiagaraVariableBase",
            "NiagaraVariable",
            "NiagaraVariableWithOffset",
        ] {
            let mut bytes = Vec::new();
            for word in [1, 0, 0, 0] {
                push_i32(&mut bytes, word);
            }
            if name == "NiagaraVariable" {
                push_i32(&mut bytes, 2);
                bytes.extend_from_slice(&[12, 34]);
            }
            if name == "NiagaraVariableWithOffset" {
                push_i32(&mut bytes, 72);
            }
            let mut reader = Reader::new(&bytes);
            assert!(
                decode(
                    &bytes,
                    name,
                    &mut reader,
                    &package,
                    "Fixture",
                    DecodeScope::root(None)
                )
                .unwrap()
                .is_some()
            );
            assert_eq!(reader.remaining(), 0);
            for end in 0..bytes.len() {
                assert!(
                    decode(
                        &bytes,
                        name,
                        &mut Reader::new(&bytes[..end]),
                        &package,
                        "Fixture",
                        DecodeScope::root(None)
                    )
                    .is_err(),
                    "{name}, {end}"
                );
            }
            let mut old = package.clone();
            old.summary.custom_versions.last_mut().unwrap().version = 63;
            let mut reader = Reader::new(&bytes);
            assert!(
                decode(
                    &bytes,
                    name,
                    &mut reader,
                    &old,
                    "Fixture",
                    DecodeScope::root(None)
                )
                .unwrap()
                .is_none()
            );
            assert_eq!(reader.tell(), 0);
            // Containers treat these as known layouts only where this recipe reads them;
            // UE5 and older UE4 revisions keep the tagged-stream fallback.
            let mut ue5 = package.clone();
            ue5.summary.versions.ue5 = 1019;
            assert!(is_known_struct(name, &package));
            assert!(!is_known_struct(name, &old));
            assert!(!is_known_struct(name, &ue5));
            assert!(
                decode(
                    &bytes,
                    name,
                    &mut Reader::new(&bytes),
                    &ue5,
                    "Fixture",
                    DecodeScope::root(None)
                )
                .unwrap()
                .is_none()
            );
            let mut invalid = bytes.clone();
            invalid[..4].copy_from_slice(&99_i32.to_le_bytes());
            assert!(
                decode(
                    &invalid,
                    name,
                    &mut Reader::new(&invalid),
                    &package,
                    "Fixture",
                    DecodeScope::root(None)
                )
                .is_err()
            );
        }
    }
}
