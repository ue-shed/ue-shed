//! Recover legacy Niagara variable records only in source-declared owning fields.
use super::*;

pub(in crate::codec) fn object_records(
    source: &[u8],
    stream: &mut PropertyStream,
    class: &str,
    package: &Package,
    scope: DecodeScope<'_>,
) {
    if !package.summary.versions.uses_legacy_property_tags()
        || !matches!(
            class,
            "/Script/NiagaraEditor.NiagaraScriptVariable"
                | "/Script/NiagaraEditor.NiagaraNodeInput"
                | "/Script/NiagaraEditor.NiagaraNodeOutput"
                | "/Script/NiagaraEditor.NiagaraNodeAssignment"
                | "/Script/NiagaraEditor.NiagaraNodeSelect"
                | "/Script/Niagara.NiagaraParameterCollection"
        )
    {
        return;
    }
    // NiagaraEditor/Public/{NiagaraScriptVariable,NiagaraNodeInput,NiagaraNodeOutput,
    // NiagaraNodeAssignment}.h and Niagara/Classes/NiagaraParameterCollection.h,
    // UE4.27/5.7/5.8. NiagaraNodeSelect is in NiagaraEditor/Private.
    recover(source, stream, package, scope, |field| {
        match (class, field) {
            ("/Script/NiagaraEditor.NiagaraScriptVariable", "Variable")
            | ("/Script/NiagaraEditor.NiagaraNodeInput", "Input") => {
                Some((false, "NiagaraVariable"))
            }
            ("/Script/NiagaraEditor.NiagaraNodeOutput", "Outputs")
            | ("/Script/NiagaraEditor.NiagaraNodeAssignment", "AssignmentTargets")
            | ("/Script/NiagaraEditor.NiagaraNodeSelect", "OutputVars")
            | ("/Script/Niagara.NiagaraParameterCollection", "Parameters") => {
                Some((true, "NiagaraVariable"))
            }
            _ => None,
        }
    });
}

pub(in crate::codec) fn struct_records(
    source: &[u8],
    stream: &mut PropertyStream,
    owner: &PropertyTypeName,
    package: &Package,
    scope: DecodeScope<'_>,
) {
    if !package.summary.versions.uses_legacy_property_tags() {
        return;
    }
    let Some(identity) = owner.parameters.first() else {
        return;
    };
    if identity
        .parameters
        .first()
        .is_some_and(|module| package.resolve_name_str(module.name) != Some("/Script/Niagara"))
    {
        return;
    }
    let Some(name) = package.resolve_name_str(identity.name) else {
        return;
    };
    if !matches!(
        name,
        "NiagaraFunctionSignature"
            | "NiagaraVMExecutableData"
            | "NiagaraParameters"
            | "NiagaraParameterStore"
            | "NiagaraUserRedirectionParameterStore"
            | "VMExternalFunctionBindingInfo"
            | "NiagaraVariableAttributeBinding"
            | "NiagaraCompilerTag"
            | "NiagaraVariableInfo"
    ) {
        return;
    }
    // NiagaraCommon.h, NiagaraParameters.h, NiagaraParameterStore.h, NiagaraScript.h.
    // The saved inner tag remains authoritative where a field changed from Variable
    // to VariableBase between engine revisions (e.g. FunctionSignature.Outputs).
    recover(source, stream, package, scope, |field| {
        match (name, field) {
            ("NiagaraFunctionSignature", "Inputs")
            | (
                "NiagaraVMExecutableData",
                "BakedRapidIterationParameters" | "StaticVariablesWritten",
            )
            | ("NiagaraParameters", "Parameters") => Some((true, "NiagaraVariable")),
            ("NiagaraFunctionSignature", "Outputs" | "NoDefaultValueInputs")
            | ("NiagaraVMExecutableData", "Attributes" | "AttributesWritten")
            | ("VMExternalFunctionBindingInfo", "VariadicInputs" | "VariadicOutputs") => {
                Some((true, "NiagaraVariableBase"))
            }
            (
                "NiagaraParameterStore" | "NiagaraUserRedirectionParameterStore",
                "SortedParameterOffsets",
            ) => Some((true, "NiagaraVariableWithOffset")),
            ("NiagaraVariableAttributeBinding", "ParamMapVariable") => {
                Some((false, "NiagaraVariableBase"))
            }
            (
                "NiagaraVariableAttributeBinding",
                "DataSetVariable" | "RootVariable" | "BoundVariable" | "DefaultValue",
            )
            | ("NiagaraCompilerTag" | "NiagaraVariableInfo", "Variable") => {
                Some((false, "NiagaraVariable"))
            }
            _ => None,
        }
    });
}

fn recover(
    source: &[u8],
    stream: &mut PropertyStream,
    package: &Package,
    scope: DecodeScope<'_>,
    declaration: impl Fn(&str) -> Option<(bool, &'static str)>,
) {
    if !package.summary.versions.uses_legacy_property_tags() || !applies(package) {
        return;
    }
    for record in &mut stream.records {
        if !matches!(&record.value, PropertyValue::Raw { reason } if *reason != RawReason::NotRequested)
        {
            continue;
        }
        let Some((array, expected)) = package.resolve_name_str(record.name).and_then(&declaration)
        else {
            continue;
        };
        if let Some(value) = record_value(source, record, package, scope, array, expected) {
            record.value = value;
        }
    }
}

fn variable_type<'a>(
    ty: &PropertyTypeName,
    guid: Option<Guid>,
    package: &'a Package,
    expected: &str,
) -> Option<Cow<'a, str>> {
    if package.resolve_name_str(ty.name) != Some("StructProperty")
        || guid.is_some_and(|guid| !guid.is_zero())
    {
        return None;
    }
    let identity = ty.parameters.first()?;
    if identity
        .parameters
        .first()
        .is_some_and(|module| package.resolve_name_str(module.name) != Some("/Script/Niagara"))
    {
        return None;
    }
    let name = package.resolve_name_cow(identity.name)?;
    // NiagaraTypes.cpp explicitly accepts Variable -> VariableBase mismatched tags;
    // their serialized strides remain distinct. WithOffset has no such conversion.
    (name == expected || (expected == "NiagaraVariableBase" && name == "NiagaraVariable"))
        .then_some(name)
}

fn record_value(
    source: &[u8],
    record: &PropertyRecord,
    package: &Package,
    scope: DecodeScope<'_>,
    array: bool,
    expected: &str,
) -> Option<PropertyValue> {
    let mut reader = Reader::new(source)
        .bounded(record.payload, "NiagaraDeclaredRecord")
        .ok()?;
    let value = if array {
        if package.resolve_name_str(record.type_name.name) != Some("ArrayProperty")
            || record.type_name.parameters.len() != 1
            || package.resolve_name_str(record.type_name.parameters[0].name)
                != Some("StructProperty")
        {
            return None;
        }
        let count = reader.read_count("NiagaraDeclaredRecord.Count").ok()?;
        let tag_name = reader
            .read_name_ref("NiagaraDeclaredRecord.InnerTag")
            .ok()?;
        let inner = crate::property::read_legacy_property_tag(
            &mut reader,
            &package.summary.versions,
            &package.names,
            tag_name,
            "NiagaraDeclaredRecord",
        )
        .ok()?;
        let name = variable_type(&inner.type_name, inner.struct_guid, package, expected)?;
        let mut elements = Reader::new(source)
            .bounded(inner.payload, "NiagaraDeclaredRecord.Elements")
            .ok()?;
        let capacity = elements
            .checked_vec_capacity::<PropertyValue>(count, 16, "NiagaraDeclaredRecord.Count")
            .ok()?;
        let mut values = Vec::with_capacity(capacity);
        for _ in 0..count {
            values.push(
                decode(
                    source,
                    &name,
                    &mut elements,
                    package,
                    "NiagaraDeclaredRecord",
                    scope,
                )
                .ok()??,
            );
        }
        if elements.remaining() != 0 {
            return None;
        }
        PropertyValue::Array(values)
    } else {
        let name = variable_type(&record.type_name, record.struct_guid, package, expected)?;
        decode(
            source,
            &name,
            &mut reader,
            package,
            "NiagaraDeclaredRecord",
            scope,
        )
        .ok()??
    };
    (reader.remaining() == 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::Span;
    use crate::package::{CustomVersion, test_package};
    use crate::test_support::{name_ref, push_i32, write_legacy_property_tag};

    fn ty(index: i32, parameters: Vec<PropertyTypeName>) -> PropertyTypeName {
        PropertyTypeName {
            name: name_ref(index, 0),
            parameters,
        }
    }
    fn package() -> Package {
        let mut p = test_package(
            [
                "None",
                "Value",
                "StructProperty",
                "NiagaraVariable",
                "NiagaraVariableBase",
                "NiagaraVariableWithOffset",
                "Variable",
                "Input",
                "Outputs",
                "ArrayProperty",
                "NiagaraFunctionSignature",
                "/Script/Niagara",
                "/Script/Fixture",
                "SortedParameterOffsets",
                "NiagaraParameterStore",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        p.summary.versions.ue5 = 1008;
        p.summary.custom_versions.push(CustomVersion {
            key: Guid {
                a: 0xFCF57AFA,
                b: 0x50764283,
                c: 0xB9A9E658,
                d: 0xFFA02D32,
            },
            version: 64,
            friendly_name: None,
        });
        p
    }
    fn bytes(kind: i32) -> Vec<u8> {
        let mut bytes = vec![];
        for word in [1, 0, 0, 0] {
            push_i32(&mut bytes, word);
        }
        if kind == 3 {
            push_i32(&mut bytes, 2);
            bytes.extend([17, 34]);
        }
        if kind == 5 {
            push_i32(&mut bytes, 72);
        }
        bytes
    }
    fn record(name: i32, kind: i32, bytes: &[u8]) -> PropertyRecord {
        PropertyRecord {
            name: name_ref(name, 0),
            type_name: ty(2, vec![ty(kind, vec![])]),
            array_index: 0,
            flags: PropertyTagFlags(0),
            property_guid: None,
            struct_guid: None,
            extensions: None,
            payload: Span::new(0, bytes.len() as u64).unwrap(),
            value: PropertyValue::Raw {
                reason: RawReason::LegacyDecoderRejected("original fallback".into()),
            },
        }
    }
    fn stream(r: PropertyRecord) -> PropertyStream {
        PropertyStream {
            records: vec![r],
            class_extensions: None,
            terminator: Span::new(0, 0).unwrap(),
        }
    }

    #[test]
    fn declared_scalar_recovery_keeps_typed_values_filters_private_types_and_failed_probes() {
        let p = package();
        let bytes = bytes(3);
        let original = record(6, 3, &bytes);
        let recover = |r: PropertyRecord, class: &str, p: &Package| {
            let mut s = stream(r);
            object_records(&bytes, &mut s, class, p, DecodeScope::root(None));
            s.records.remove(0).value
        };
        assert!(matches!(
            recover(
                original.clone(),
                "/Script/NiagaraEditor.NiagaraScriptVariable",
                &p
            ),
            PropertyValue::NativeStruct { .. }
        ));
        assert_eq!(
            recover(
                original.clone(),
                "/Script/Fixture.NiagaraScriptVariable",
                &p
            ),
            original.value
        );
        let incompatible = record(6, 4, &bytes[..16]);
        assert_eq!(
            recover(
                incompatible.clone(),
                "/Script/NiagaraEditor.NiagaraScriptVariable",
                &p
            ),
            incompatible.value
        );
        let mut filtered = original.clone();
        filtered.value = PropertyValue::Raw {
            reason: RawReason::NotRequested,
        };
        assert_eq!(
            recover(
                filtered.clone(),
                "/Script/NiagaraEditor.NiagaraScriptVariable",
                &p
            ),
            filtered.value
        );
        let mut typed = original.clone();
        typed.value = PropertyValue::Int(99);
        assert_eq!(
            recover(typed, "/Script/NiagaraEditor.NiagaraScriptVariable", &p),
            PropertyValue::Int(99)
        );
        let mut private = original.clone();
        private.type_name.parameters[0]
            .parameters
            .push(ty(12, vec![]));
        assert_eq!(
            recover(
                private.clone(),
                "/Script/NiagaraEditor.NiagaraScriptVariable",
                &p
            ),
            private.value
        );
        let mut custom = original.clone();
        custom.struct_guid = Some(Guid {
            a: 1,
            b: 0,
            c: 0,
            d: 0,
        });
        assert_eq!(
            recover(
                custom.clone(),
                "/Script/NiagaraEditor.NiagaraScriptVariable",
                &p
            ),
            custom.value
        );
        let mut old = p.clone();
        old.summary.custom_versions.last_mut().unwrap().version = 63;
        assert_eq!(
            recover(
                original.clone(),
                "/Script/NiagaraEditor.NiagaraScriptVariable",
                &old
            ),
            original.value
        );
        for end in 0..bytes.len() {
            let r = record(6, 3, &bytes[..end]);
            assert_eq!(
                recover(r.clone(), "/Script/NiagaraEditor.NiagaraScriptVariable", &p),
                r.value
            );
        }
    }

    #[test]
    fn declared_legacy_arrays_use_the_saved_inner_type_and_its_exact_payload_boundary() {
        let p = package();
        for kind in [3, 4, 5] {
            let mut elements = bytes(kind);
            elements.extend(bytes(kind));
            let mut extras = vec![];
            push_i32(&mut extras, kind);
            extras.extend([0; 20]);
            extras.push(0);
            let mut bytes = vec![];
            push_i32(&mut bytes, 2);
            write_legacy_property_tag(&mut bytes, 8, 2, &extras, &elements);
            let mut r = record(if kind == 5 { 13 } else { 8 }, kind, &bytes);
            r.type_name = ty(9, vec![ty(2, vec![])]);
            let owner = ty(
                2,
                vec![ty(if kind == 5 { 14 } else { 10 }, vec![ty(11, vec![])])],
            );
            let mut s = stream(r.clone());
            struct_records(&bytes, &mut s, &owner, &p, DecodeScope::root(None));
            let PropertyValue::Array(values) = &s.records[0].value else {
                panic!("kind {kind}")
            };
            assert_eq!(values.len(), 2);
            if kind == 5 {
                let mut incompatible = r.clone();
                incompatible.name = name_ref(8, 0);
                let mut wrong = stream(incompatible);
                struct_records(
                    &bytes,
                    &mut wrong,
                    &ty(2, vec![ty(10, vec![ty(11, vec![])])]),
                    &p,
                    DecodeScope::root(None),
                );
                assert_eq!(wrong.records[0].value, r.value);
            }
            let mut private = owner.clone();
            private.parameters[0].parameters[0] = ty(12, vec![]);
            let mut s = stream(r.clone());
            struct_records(&bytes, &mut s, &private, &p, DecodeScope::root(None));
            assert_eq!(s.records[0].value, r.value);
            for end in 0..bytes.len() {
                let mut truncated = r.clone();
                truncated.payload = Span::new(0, end as u64).unwrap();
                let mut s = stream(truncated);
                struct_records(&bytes, &mut s, &owner, &p, DecodeScope::root(None));
                assert_eq!(s.records[0].value, r.value);
            }
            let mut trailing = bytes.clone();
            trailing.push(0);
            let mut tail = r.clone();
            tail.payload = Span::new(0, trailing.len() as u64).unwrap();
            let mut s = stream(tail);
            struct_records(&trailing, &mut s, &owner, &p, DecodeScope::root(None));
            assert_eq!(s.records[0].value, r.value);
        }
    }
}
