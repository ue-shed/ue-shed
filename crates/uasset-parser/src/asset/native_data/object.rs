//! Inherited native object records. Unknown subclass bytes remain a separate span.
use super::*;
use crate::archive::Reader;
use crate::property::NativeProperty;
use std::borrow::Cow;

type DecodedObjectTail = (Option<Guid>, Option<Box<PropertyValue>>, Span);

const FORTNITE_RELEASE: [u32; 4] = [0xE7086368, 0x6B234C58, 0x84391B70, 0x16265E91];
const SPECIAL_PROJECT: [u32; 4] = [0x59DA5D52, 0x12324948, 0xB8785978, 0x70B8E98B];
const NIAGARA_GUID: [u32; 4] = [0xFCF57AFA, 0x50764283, 0xB9A9E658, 0xFFA02D32];
const NIAGARA_SYSTEM_CLASS: &str = "/Script/Niagara.NiagaraSystem";
const STATIC_MESH_COMPONENT_CLASS: &str = "/Script/Engine.StaticMeshComponent";

/// The package versions an object tail reads, settled once by a decode session.
#[derive(Clone, Copy)]
pub(crate) struct TailSummary {
    graph_version: bool,
    actor_cooked_label: bool,
    component_ucs_modified: bool,
    scene_static_bounds: bool,
    niagara_v51: bool,
}

impl TailSummary {
    pub(crate) fn of(package: &Package) -> Self {
        Self {
            graph_version: supports_blueprint_graph_package_version(&package.summary.versions),
            actor_cooked_label: custom_version(package, SPECIAL_PROJECT) >= 4,
            component_ucs_modified: custom_version(package, FORTNITE_RELEASE) >= 4,
            scene_static_bounds: custom_version(package, SPECIAL_PROJECT) >= 2,
            niagara_v51: package.summary.versions.ue5 == 0
                && custom_version(package, NIAGARA_GUID) >= 51,
        }
    }
}

/// Everything [`decode`] asks about an export's class and package, which a session settles
/// once per class. Each field is the predicate [`decode`] otherwise evaluates per export.
#[derive(Clone, Copy)]
pub(crate) struct ObjectTailFacts {
    summary: TailSummary,
    blueprint_class: bool,
    niagara_system: bool,
    actor: bool,
    component: bool,
    scene_component: bool,
    ue427_static_mesh_component: bool,
}

impl ObjectTailFacts {
    pub(crate) fn of(
        export: &Export,
        context: &AssetDecodeContext<'_>,
        summary: TailSummary,
    ) -> Self {
        Self {
            summary,
            blueprint_class: super::class::is_blueprint_class(export),
            niagara_system: is_niagara_system(export),
            actor: class_is_a(context, export, "/Script/Engine.Actor"),
            component: is_component(context, export),
            scene_component: class_is_a(context, export, "/Script/Engine.SceneComponent"),
            ue427_static_mesh_component: is_ue427_static_mesh_component(context, export),
        }
    }
}

fn is_niagara_system(export: &Export) -> bool {
    export.class_path.as_ref().map(ObjectPath::as_str) == Some(NIAGARA_SYSTEM_CLASS)
}

fn is_component(context: &AssetDecodeContext<'_>, export: &Export) -> bool {
    class_is_a(context, export, "/Script/Engine.ActorComponent")
        || (context.package.summary.versions.ue5 == 0
            && saved_native_class(context.package, export).is_some_and(|class| {
                matches!(
                    class,
                    "/Script/Engine.StaticMeshComponent"
                        | "/Script/Engine.InstancedStaticMeshComponent"
                        | "/Script/Engine.HierarchicalInstancedStaticMeshComponent"
                        | "/Script/Engine.SplineMeshComponent"
                )
            }))
}

fn is_ue427_static_mesh_component(context: &AssetDecodeContext<'_>, export: &Export) -> bool {
    context.package.summary.versions.ue5 == 0
        && saved_native_class(context.package, export) == Some(STATIC_MESH_COMPONENT_CLASS)
}

fn custom_version(package: &Package, words: [u32; 4]) -> i32 {
    package
        .summary
        .custom_versions
        .iter()
        .find(|version| [version.key.a, version.key.b, version.key.c, version.key.d] == words)
        .map_or(-1, |version| version.version)
}

fn class_is_a(context: &AssetDecodeContext<'_>, export: &Export, base: &str) -> bool {
    let Some(class) = export.class_path.as_ref() else {
        return false;
    };
    let mut current = class.as_str();
    let mut index = export.class_index;
    for _ in 0..64 {
        if context.schemas.class_is_a_str(current, base) {
            return true;
        }
        // Follow only an actual saved generated-class export, using its package index.
        let PackageIndex::Export(class_index) = index else {
            return false;
        };
        let Some(class_export) = context.package.exports.get(class_index as usize) else {
            return false;
        };
        if class_export.object_path.as_str() != current
            || class_export.class_path.as_ref().map(ObjectPath::as_str)
                != Some("/Script/Engine.BlueprintGeneratedClass")
        {
            return false;
        }
        let Some(parent) = context.package.resolve_index_str(class_export.super_index) else {
            return false;
        };
        current = parent;
        index = class_export.super_index;
    }
    false
}

fn native_bool(
    reader: &mut Reader<'_>,
    context: &AssetDecodeContext<'_>,
    recipe: &str,
    path: &ObjectPath,
) -> Result<PropertyValue, AssetError> {
    match modeled_data(reader, context, recipe, path)? {
        NativeValue::Bool(false) => Ok(PropertyValue::Bool(false)),
        NativeValue::Bool(true) => Err(AssetError::new(
            AssetErrorKind::UnsupportedFormat,
            format!("{path}: {recipe} contains cooked data in an uncooked package"),
        )),
        _ => Err(invalid_layout(path, recipe)),
    }
}

fn member(
    value: NativeValue,
    package: &Package,
    path: &ObjectPath,
) -> Result<PropertyValue, AssetError> {
    let mut value = value;
    let NativeValue::Int32(parent) = field(&mut value, "MemberParent", path)? else {
        return Err(invalid_layout(path, "MemberParent"));
    };
    let parent = PackageIndex::from_raw(parent);
    if parent != PackageIndex::Null && package.resolve_index_str(parent).is_none() {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("{path}: modified member parent is outside the package tables"),
        ));
    }
    let NativeValue::Name(name) = field(&mut value, "MemberName", path)? else {
        return Err(invalid_layout(path, "MemberName"));
    };
    if !package.has_name(name) {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("{path}: modified member name is outside the name table"),
        ));
    }
    let mut guid = field(&mut value, "MemberGuid", path)?;
    let mut words = [0_u32; 4];
    for (index, name) in ["A", "B", "C", "D"].iter().enumerate() {
        let NativeValue::Int32(word) = field(&mut guid, name, path)? else {
            return Err(invalid_layout(path, "MemberGuid"));
        };
        words[index] = word as u32;
    }
    finish_record(guid, path)?;
    finish_record(value, path)?;
    Ok(PropertyValue::NativeStruct {
        fields: vec![
            NativeProperty {
                name: Cow::Borrowed("MemberParent"),
                value: PropertyValue::ObjectRef(parent),
            },
            NativeProperty {
                name: Cow::Borrowed("MemberName"),
                value: PropertyValue::Name(name),
            },
            NativeProperty {
                name: Cow::Borrowed("MemberGuid"),
                value: PropertyValue::Guid(Guid {
                    a: words[0],
                    b: words[1],
                    c: words[2],
                    d: words[3],
                }),
            },
        ],
    })
}

/// Decodes the native records after an object's tagged properties. `facts`, when a session has
/// settled them for this export's class, answer the class and version checks; without them each
/// check is evaluated here, only when reached.
pub(crate) fn decode(
    export: &Export,
    context: &AssetDecodeContext<'_>,
    properties: &PropertyStream,
    reader: &mut Reader<'_>,
    facts: Option<&ObjectTailFacts>,
) -> Result<DecodedObjectTail, AssetError> {
    let package = context.package;
    let blueprint_class = facts.map_or_else(
        || super::class::is_blueprint_class(export),
        |facts| facts.blueprint_class,
    );
    if blueprint_class {
        let mut probe = reader.clone();
        if let Ok((guid, data)) = super::class::decode(&mut probe, context, &export.object_path) {
            *reader = probe;
            return Ok((
                guid,
                Some(Box::new(data)),
                Span::new(reader.tell(), reader.remaining())?,
            ));
        }
        // Unsupported class scripts, field kinds and malformed native records retain every byte.
        let (guid, tail) = consume_uobject_export_footer_lenient(reader, &export.object_path)?;
        return Ok((guid, None, tail));
    }
    // SavePackage routes class default objects through UClass::SerializeDefaultObject,
    // which saves properties without invoking the actor/component native serializer.
    if export.object_flags & 0x10 != 0 {
        let (guid, tail) = consume_uobject_export_footer_lenient(reader, &export.object_path)?;
        return Ok((guid, None, tail));
    }
    let niagara_v51_system = facts.map_or_else(
        || {
            package.summary.versions.ue5 == 0
                && is_niagara_system(export)
                && custom_version(package, NIAGARA_GUID) >= 51
        },
        |facts| facts.summary.niagara_v51 && facts.niagara_system,
    );
    if niagara_v51_system {
        // UE 4.27 / 5.7 NiagaraSystem.cpp, UNiagaraSystem::Serialize:
        // ChangeEmitterCompiledDataToSharedRefs=51 adds an array of explicitly tagged records.
        // Probe transactionally: invalid layouts retain the entire original native tail.
        let mut probe = reader.clone();
        if let Ok((guid, value)) = niagara_system(&mut probe, context, &export.object_path) {
            *reader = probe;
            return Ok((
                guid,
                Some(Box::new(value)),
                Span::new(reader.tell(), reader.remaining())?,
            ));
        }
    }
    let actor = facts.map_or_else(
        || class_is_a(context, export, "/Script/Engine.Actor"),
        |facts| facts.actor,
    );
    let component = facts.map_or_else(|| is_component(context, export), |facts| facts.component);
    if !(actor || component)
        || !facts.map_or_else(
            || supports_blueprint_graph_package_version(&package.summary.versions),
            |facts| facts.summary.graph_version,
        )
    {
        let (guid, tail) = consume_uobject_export_footer_lenient(reader, &export.object_path)?;
        return Ok((guid, None, tail));
    }
    // These source-proven serializers all call UObject before adding native data.
    let object_guid =
        match reader.read_i32(&format_args!("{}.ObjectGuid.Present", export.object_path))? {
            0 => None,
            1 => Some(reader.read_guid(&format_args!("{}.ObjectGuid", export.object_path))?),
            marker => {
                return Err(AssetError::new(
                    AssetErrorKind::MalformedData,
                    format!(
                        "{}: invalid object GUID marker {marker}",
                        export.object_path
                    ),
                ));
            }
        };
    let mut fields = Vec::new();
    if actor
        && facts.map_or_else(
            || custom_version(package, SPECIAL_PROJECT) >= 4,
            |facts| facts.summary.actor_cooked_label,
        )
    {
        fields.push(NativeProperty {
            name: Cow::Borrowed("ActorLabelIsCooked"),
            value: native_bool(reader, context, "AActor.CookedLabel", &export.object_path)?,
        });
    }
    if component
        && facts.map_or_else(
            || custom_version(package, FORTNITE_RELEASE) >= 4,
            |facts| facts.summary.component_ucs_modified,
        )
    {
        let NativeValue::Array(values) = modeled_data(
            reader,
            context,
            "UActorComponent.UCSModifiedProperties",
            &export.object_path,
        )?
        else {
            return Err(invalid_layout(&export.object_path, "UCSModifiedProperties"));
        };
        fields.push(NativeProperty {
            name: Cow::Borrowed("UCSModifiedProperties"),
            value: PropertyValue::Array(
                values
                    .into_iter()
                    .map(|value| member(value, context.package, &export.object_path))
                    .collect::<Result<_, _>>()?,
            ),
        });
    }
    // Only an explicitly saved true flag proves this conditional branch. An absent flag in
    // an arbitrary subclass can inherit a default we do not know; its bytes stay opaque.
    if component
        && facts.map_or_else(
            || class_is_a(context, export, "/Script/Engine.SceneComponent"),
            |facts| facts.scene_component,
        )
        && facts.map_or_else(
            || custom_version(package, SPECIAL_PROJECT) >= 2,
            |facts| facts.summary.scene_static_bounds,
        )
    {
        // No numbered name renders as this unsuffixed name, so the borrow-only lookup agrees.
        let compute = properties.records.iter().find(|record| {
            context.package.resolve_name_str(record.name) == Some("bComputeBoundsOnceForGame")
        });
        if let Some(record) = compute {
            match record.value {
                PropertyValue::Bool(true) => fields.push(NativeProperty {
                    name: Cow::Borrowed("StaticBoundsIsCooked"),
                    value: native_bool(
                        reader,
                        context,
                        "USceneComponent.StaticBoundsCooked",
                        &export.object_path,
                    )?,
                }),
                PropertyValue::Bool(false) => {}
                _ => {
                    return Err(AssetError::new(
                        AssetErrorKind::MalformedData,
                        format!(
                            "{}: bComputeBoundsOnceForGame is not a saved boolean",
                            export.object_path
                        ),
                    ));
                }
            }
        }
    }
    // UE 4.27 Components/StaticMeshComponent.cpp, UStaticMeshComponent::Serialize:
    // the only native suffix is LODData. Its empty array is a count, not FText.
    // UActorComponent/PrimitiveComponent::Serialize add no persistent native bytes on 4.27.
    // Nonempty LOD records and subclass serializers remain opaque.
    if facts.map_or_else(
        || is_ue427_static_mesh_component(context, export),
        |facts| facts.ue427_static_mesh_component,
    ) {
        let mut probe = reader.clone();
        if probe.read_i32(&format_args!("{}.LODData.Count", export.object_path))? == 0 {
            fields.push(NativeProperty {
                name: Cow::Borrowed("LODData"),
                value: PropertyValue::Array(Vec::new()),
            });
            *reader = probe;
        }
    }
    let tail = Span::new(reader.tell(), reader.remaining())?;
    let data = (!fields.is_empty()).then(|| Box::new(PropertyValue::NativeStruct { fields }));
    Ok((object_guid, data, tail))
}

fn niagara_system(
    reader: &mut Reader<'_>,
    context: &AssetDecodeContext<'_>,
    path: &ObjectPath,
) -> Result<(Option<Guid>, PropertyValue), AssetError> {
    let guid = consume_inline_object_guid_footer(reader, path)?;
    let count = reader.read_count(path.as_str())?;
    let capacity = reader.checked_vec_capacity::<PropertyValue>(count, 8, path.as_str())?;
    let mut values = Vec::with_capacity(capacity);
    for _ in 0..count {
        let mut stream = read_tagged_property_stream(
            reader,
            &context.package.summary.versions,
            &context.package.names,
            path.as_str(),
        )?;
        decode_property_stream_values_at_depth(
            context.source,
            &mut stream,
            context.package,
            DecodeScope::root(context.property_filter),
        )?;
        values.push(PropertyValue::Struct(Box::new(stream)));
    }
    Ok((
        guid,
        PropertyValue::NativeStruct {
            fields: vec![NativeProperty {
                name: Cow::Borrowed("EmitterCompiledData"),
                value: PropertyValue::Array(values),
            }],
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::{CustomVersion, test_export, test_import, test_package};
    use crate::property::{PropertyRecord, PropertyTagFlags, PropertyTypeName};
    use crate::schema::embedded_source_model;
    use crate::test_support::{name_ref, push_i32};

    #[test]
    fn ue427_static_mesh_component_decodes_empty_lod_array_and_retains_nonempty_data() {
        let mut package = package();
        package.summary.versions.ue5 = 0;
        package.summary.custom_versions.clear();
        let values = properties(None);
        let bytes = vec![0; 8]; // UObject GUID marker, LODData count
        let (_, data, tail) = read(
            &bytes,
            "/Script/Engine.StaticMeshComponent",
            &package,
            &values,
        )
        .unwrap();
        assert!(tail.is_empty());
        assert!(data.is_some());
        let mut bytes = bytes;
        bytes[4..8].copy_from_slice(&1_i32.to_le_bytes());
        let (_, _, tail) = read(
            &bytes,
            "/Script/Engine.StaticMeshComponent",
            &package,
            &values,
        )
        .unwrap();
        assert_eq!(tail.len(), 4);
    }

    #[test]
    fn ue427_saved_blueprint_mesh_ancestry_is_proven_by_indices_and_cycles_are_bounded() {
        let mut package = package();
        package.summary.versions.ue5 = 0;
        package.summary.custom_versions.clear();
        package.imports[0] = test_import(
            "/Script/Engine.StaticMeshComponent",
            "/Script/CoreUObject.Class",
            0,
            None,
        );
        let class = "/Game/Fixture.Mesh_C";
        let mut generated = test_export(0, class, "/Script/Engine.BlueprintGeneratedClass");
        generated.super_index = PackageIndex::Import(0);
        package.exports.push(generated);
        let bytes = [0; 8];
        let (_, native, tail) = read(&bytes, class, &package, &properties(None)).unwrap();
        assert!(native.is_some() && tail.is_empty());
        package.exports[0].super_index = PackageIndex::Export(0);
        assert!(
            read(&bytes, class, &package, &properties(None))
                .unwrap()
                .1
                .is_none()
        );
        package.exports[0].super_index = PackageIndex::Import(0);
        package.exports[0].class_path = Some(ObjectPath::new("/Script/Fixture.NativeClass"));
        assert!(
            read(&bytes, class, &package, &properties(None))
                .unwrap()
                .1
                .is_none()
        );
    }

    #[test]
    fn ue427_niagara_compiled_records_are_tagged_and_truncated_tails_remain_opaque() {
        let mut package = package();
        package.summary.versions.ue5 = 0;
        package.summary.custom_versions.push(CustomVersion {
            key: Guid {
                a: 0xFCF57AFA,
                b: 0x50764283,
                c: 0xB9A9E658,
                d: 0xFFA02D32,
            },
            version: 51,
            friendly_name: None,
        });
        let bytes = [0_i32, 1, 0, 0]
            .into_iter()
            .flat_map(i32::to_le_bytes)
            .collect::<Vec<_>>();
        let (_, native, tail) = read(
            &bytes,
            "/Script/Niagara.NiagaraSystem",
            &package,
            &properties(None),
        )
        .unwrap();
        assert!(native.is_some() && tail.is_empty());
        let context = AssetDecodeContext {
            property_filter: None,
            source: &bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        for end in 0..bytes.len() {
            assert!(
                niagara_system(
                    &mut Reader::new(&bytes[..end]),
                    &context,
                    &ObjectPath::new("Fixture")
                )
                .is_err()
            );
        }
        package.summary.custom_versions.last_mut().unwrap().version = 50;
        let (_, native, tail) = read(
            &bytes,
            "/Script/Niagara.NiagaraSystem",
            &package,
            &properties(None),
        )
        .unwrap();
        assert!(native.is_none());
        assert_eq!(tail.len(), bytes.len() as u64);
    }

    fn package() -> Package {
        let mut package = test_package(vec![
            "None".into(),
            "SavedMember".into(),
            "bComputeBoundsOnceForGame".into(),
        ]);
        package.imports.push(test_import(
            "/Script/Engine.SceneComponent",
            "/Script/CoreUObject.Class",
            0,
            None,
        ));
        package.summary.custom_versions = [FORTNITE_RELEASE, SPECIAL_PROJECT]
            .into_iter()
            .map(|words| CustomVersion {
                key: Guid {
                    a: words[0],
                    b: words[1],
                    c: words[2],
                    d: words[3],
                },
                version: 4,
                friendly_name: None,
            })
            .collect();
        package
    }

    fn properties(value: Option<PropertyValue>) -> PropertyStream {
        PropertyStream {
            class_extensions: None,
            terminator: Span::default(),
            records: value
                .into_iter()
                .map(|value| PropertyRecord {
                    name: name_ref(2, 0),
                    type_name: PropertyTypeName {
                        name: name_ref(0, 0),
                        parameters: vec![],
                    },
                    array_index: 0,
                    flags: PropertyTagFlags::default(),
                    property_guid: None,
                    struct_guid: None,
                    extensions: None,
                    payload: Span::default(),
                    value,
                })
                .collect(),
        }
    }

    fn read(
        bytes: &[u8],
        class: &str,
        package: &Package,
        properties: &PropertyStream,
    ) -> Result<DecodedObjectTail, AssetError> {
        let mut export = test_export(bytes.len() as u64, "/Game/Test.Object", class);
        if let Some(index) = package
            .exports
            .iter()
            .position(|export| export.object_path.as_str() == class)
        {
            export.class_index = PackageIndex::Export(index as u32);
        }
        let context = AssetDecodeContext {
            property_filter: None,
            source: bytes,
            package,
            schemas: embedded_source_model(),
        };
        let per_export = decode(&export, &context, properties, &mut Reader::new(bytes), None);
        // A session's settled facts must reach the same tail, success or failure.
        let facts = ObjectTailFacts::of(&export, &context, TailSummary::of(package));
        let settled = decode(
            &export,
            &context,
            properties,
            &mut Reader::new(bytes),
            Some(&facts),
        );
        assert_eq!(format!("{settled:?}"), format!("{per_export:?}"));
        per_export
    }

    fn component() -> Vec<u8> {
        let mut bytes = Vec::new();
        for word in [0, 1, -1, 1, 0, i32::MIN, -1, 3, 4] {
            push_i32(&mut bytes, word);
        }
        bytes
    }

    #[test]
    fn member_references_and_guids_survive_and_subclass_bytes_stay_opaque() {
        let mut bytes = component();
        let package = package();
        let (_, data, tail) = read(
            &bytes,
            "/Script/Engine.CameraComponent",
            &package,
            &properties(None),
        )
        .unwrap();
        assert!(tail.is_empty());
        let PropertyValue::NativeStruct { fields } = *data.unwrap() else {
            panic!("native object data");
        };
        let PropertyValue::Array(members) = &fields[0].value else {
            panic!("members");
        };
        let PropertyValue::NativeStruct { fields } = &members[0] else {
            panic!("member");
        };
        assert_eq!(
            fields[0].value,
            PropertyValue::ObjectRef(PackageIndex::Import(0))
        );
        assert_eq!(
            fields[2].value,
            PropertyValue::Guid(Guid {
                a: 0x8000_0000,
                b: u32::MAX,
                c: 3,
                d: 4
            })
        );
        bytes.extend_from_slice(&[0xab; 9]);
        let (_, _, tail) = read(
            &bytes,
            "/Script/Engine.CameraComponent",
            &package,
            &properties(None),
        )
        .unwrap();
        assert_eq!(tail.len(), 9);
    }

    #[test]
    fn rejects_every_truncation_and_invalid_counts_names_indices_or_flags() {
        let package = package();
        let values = properties(None);
        let valid = component();
        for end in 0..valid.len() {
            assert!(
                read(
                    &valid[..end],
                    "/Script/Engine.ActorComponent",
                    &package,
                    &values
                )
                .is_err(),
                "end {end}"
            );
        }
        for (offset, value) in [
            (0, 2),
            (4, -1),
            (4, i32::MAX),
            (8, -2),
            (8, 1),
            (12, 200),
            (16, -1),
        ] {
            let mut bytes = valid.clone();
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(
                read(&bytes, "/Script/Engine.ActorComponent", &package, &values).is_err(),
                "offset {offset}, value {value}"
            );
        }
        for flag in [1_i32, 2, -1] {
            let bytes = [0_i32.to_le_bytes(), flag.to_le_bytes()].concat();
            assert!(read(&bytes, "/Script/Engine.Actor", &package, &values).is_err());
        }
    }

    #[test]
    fn empty_records_guid_footer_and_version_branches_are_distinct() {
        let mut package = package();
        let values = properties(None);
        let empty = [0_u8; 8];
        for class in ["/Script/Engine.Actor", "/Script/Engine.ActorComponent"] {
            let (_, data, tail) = read(&empty, class, &package, &values).unwrap();
            assert!(data.is_some() && tail.is_empty());
        }
        let mut guid_bytes = Vec::new();
        for word in [1, 10, 20, 30, 40, 0] {
            push_i32(&mut guid_bytes, word);
        }
        assert_eq!(
            read(
                &guid_bytes,
                "/Script/Engine.ActorComponent",
                &package,
                &values
            )
            .unwrap()
            .0,
            Some(Guid {
                a: 10,
                b: 20,
                c: 30,
                d: 40
            })
        );
        for version in &mut package.summary.custom_versions {
            version.version = 3;
        }
        assert!(
            read(&empty[..4], "/Script/Engine.Actor", &package, &values)
                .unwrap()
                .1
                .is_none()
        );
        // Version 3 does not contain the component array: it must remain untouched.
        assert_eq!(
            read(&empty, "/Script/Engine.ActorComponent", &package, &values)
                .unwrap()
                .2
                .len(),
            4
        );
        package.summary.custom_versions.clear();
        assert!(
            read(
                &empty[..4],
                "/Script/Engine.ActorComponent",
                &package,
                &values
            )
            .unwrap()
            .1
            .is_none()
        );
    }

    #[test]
    fn scene_record_requires_saved_branch_evidence() {
        let package = package();
        let bytes = [0_u8; 12];
        let (_, data, tail) = read(
            &bytes,
            "/Script/Engine.SceneComponent",
            &package,
            &properties(Some(PropertyValue::Bool(true))),
        )
        .unwrap();
        assert!(tail.is_empty());
        let PropertyValue::NativeStruct { fields } = *data.unwrap() else {
            panic!("native data");
        };
        assert_eq!(fields[1].name, "StaticBoundsIsCooked");
        for flag in [None, Some(PropertyValue::Bool(false))] {
            assert_eq!(
                read(
                    &bytes,
                    "/Script/Engine.SceneComponent",
                    &package,
                    &properties(flag)
                )
                .unwrap()
                .2
                .len(),
                4
            );
        }
        assert!(
            read(
                &bytes,
                "/Script/Engine.SceneComponent",
                &package,
                &properties(Some(PropertyValue::Int(1)))
            )
            .is_err()
        );
        assert!(
            read(
                &bytes[..8],
                "/Script/Engine.SceneComponent",
                &package,
                &properties(Some(PropertyValue::Bool(true)))
            )
            .is_err()
        );
    }

    #[test]
    fn generated_class_ancestry_does_not_apply_native_serialization_to_cdos() {
        let mut package = package();
        let class = "/Game/Test.Generated_C";
        let mut generated = test_export(0, class, "/Script/Engine.BlueprintGeneratedClass");
        generated.super_index = PackageIndex::Import(0);
        package.exports.push(generated);
        let bytes = [0_u8; 8];
        assert!(
            read(&bytes, class, &package, &properties(None))
                .unwrap()
                .1
                .is_some()
        );
        let mut cdo = test_export(0, "/Game/Test.Default__Generated_C", class);
        cdo.object_flags |= 0x10;
        let context = AssetDecodeContext {
            property_filter: None,
            source: &[],
            package: &package,
            schemas: embedded_source_model(),
        };
        let (_, data, tail) = decode(
            &cdo,
            &context,
            &properties(None),
            &mut Reader::new(&[]),
            None,
        )
        .unwrap();
        assert!(data.is_none() && tail.is_empty());
    }
}
