//! UE4 Niagara's custom-versioned native variable records.
use super::*;

/// Whether this package's Niagara variables use the recipe below: UE4 at
/// VariablesUseTypeDefRegistry (64) or later. Elsewhere they decode as tagged streams.
pub(in crate::codec) fn applies(package: &Package) -> bool {
    package.summary.versions.ue5 == 0
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
    depth: usize,
) -> Result<Option<PropertyValue>, PropertyError> {
    // UE 4.27 Niagara/Private/NiagaraModule.cpp, FNiagaraVariableBase::Serialize,
    // FNiagaraVariable::Serialize and operator<<(FNiagaraTypeDefinitionHandle&);
    // NiagaraParameterStore.cpp, FNiagaraVariableWithOffset::Serialize.
    // VariablesUseTypeDefRegistry=64: FName, tagged type definition, then bytes/offset.
    // UE 5.7 retains these serializers but changes FNiagaraTypeDefinition::Serialize;
    // keep that version outside this recipe. Earlier revisions use tagged fallback.
    if !applies(package) {
        return Ok(None);
    }
    if depth >= MAX_PROPERTY_DECODE_DEPTH {
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
    decode_property_stream_values_at_depth(source, &mut type_def, package, depth + 1)?;
    let mut fields = vec![
        NativeProperty {
            name: "Name".into(),
            value: PropertyValue::Name(variable_name),
        },
        NativeProperty {
            name: "TypeDefHandle".into(),
            value: PropertyValue::Struct(type_def),
        },
    ];
    if name == "NiagaraVariable" {
        let count = reader.read_count(path)?;
        reader.checked_vec_capacity::<PropertyValue>(count, 1, path)?;
        let bytes = reader.read_bytes(count, path)?;
        fields.push(NativeProperty {
            name: "VarData".into(),
            value: PropertyValue::Array(
                bytes
                    .iter()
                    .map(|value| PropertyValue::UInt(u64::from(*value)))
                    .collect(),
            ),
        });
    } else if name == "NiagaraVariableWithOffset" {
        fields.push(NativeProperty {
            name: "Offset".into(),
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
                decode(&bytes, name, &mut reader, &package, "Fixture", 0)
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
                        0
                    )
                    .is_err(),
                    "{name}, {end}"
                );
            }
            let mut old = package.clone();
            old.summary.custom_versions.last_mut().unwrap().version = 63;
            let mut reader = Reader::new(&bytes);
            assert!(
                decode(&bytes, name, &mut reader, &old, "Fixture", 0)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(reader.tell(), 0);
            // Containers treat these as known layouts only where this recipe reads them;
            // UE5 and older UE4 revisions keep the tagged-stream fallback.
            let mut ue5 = package.clone();
            ue5.summary.versions.ue5 = 1009;
            assert!(is_known_struct(name, &package));
            assert!(!is_known_struct(name, &old));
            assert!(!is_known_struct(name, &ue5));
            assert!(
                decode(&bytes, name, &mut Reader::new(&bytes), &ue5, "Fixture", 0)
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
                    0
                )
                .is_err()
            );
        }
    }
}
