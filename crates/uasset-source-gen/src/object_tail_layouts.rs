//! Source checks for the inherited records saved by actors and components.
use super::{GeneratorError, Token};
use std::collections::BTreeMap;
use uasset_parser::native::NativeLayout as L;

fn require(tokens: &[Token], fragments: &[&str]) -> Result<(), GeneratorError> {
    let source = tokens
        .iter()
        .map(|token| token.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let mut cursor = 0;
    for fragment in fragments {
        let expected = super::lex(fragment)?
            .iter()
            .map(|token| token.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let offset = source[cursor..].find(&expected).ok_or_else(|| {
            GeneratorError::new(format!(
                "actor/component serialization changed; missing ordered fragment {fragment}"
            ))
        })?;
        cursor += offset + expected.len();
    }
    Ok(())
}

pub(super) fn derive(
    sources: &BTreeMap<String, Vec<Token>>,
    layouts: &mut BTreeMap<String, L>,
) -> Result<(), GeneratorError> {
    let find = |suffix: &str| {
        sources
            .iter()
            .find(|(path, _)| path.ends_with(suffix))
            .map(|(_, tokens)| tokens)
    };
    // The dedicated configs opt into these serializers together. Other configs keep their scope.
    let Some(actor) = find("Engine/Private/Actor.cpp") else {
        return Ok(());
    };
    let required = |suffix: &str| {
        find(suffix)
            .ok_or_else(|| GeneratorError::new(format!("actor/component recipes require {suffix}")))
    };
    require(
        actor,
        &[
            "void AActor::Serialize(FArchive& Ar)",
            "Super::Serialize(Ar)",
            "if(Ar.IsPersistent() && (Ar.CustomVer(FUE5SpecialProjectStreamObjectVersion::GUID) >= FUE5SpecialProjectStreamObjectVersion::SerializeActorLabelInCookedBuilds))",
            "bool bIsCooked = Ar.IsCooking()",
            "Ar << bIsCooked",
            "if (bIsCooked)",
            "Ar << ActorLabel",
        ],
    )?;
    require(
        required("Components/ActorComponent.cpp")?,
        &[
            "void UActorComponent::Serialize(FArchive& Ar)",
            "Super::Serialize(Ar)",
            "if (Ar.CustomVer(FFortniteReleaseBranchCustomObjectVersion::GUID) >= FFortniteReleaseBranchCustomObjectVersion::ActorComponentUCSModifiedPropertiesSparseStorage)",
            "TArray<FSimpleMemberReference> UCSModifiedProperties",
            "Ar << UCSModifiedProperties",
            "Ar << *UCSModifiedProperties",
            "TArray<FSimpleMemberReference> EmptyUCSModifiedProperties",
            "Ar << EmptyUCSModifiedProperties",
        ],
    )?;
    require(
        required("Components/SceneComponent.cpp")?,
        &[
            "void USceneComponent::Serialize(FArchive& Ar)",
            "Super::Serialize(Ar)",
            "if (bComputeBoundsOnceForGame)",
            "if(Ar.CustomVer(FUE5SpecialProjectStreamObjectVersion::GUID) >= FUE5SpecialProjectStreamObjectVersion::SerializeSceneComponentStaticBounds)",
            "bool bIsCooked = bComputedBoundsOnceForGame && Ar.IsCooking()",
            "Ar << bIsCooked",
            "if (bIsCooked)",
            "Ar << Bounds",
        ],
    )?;
    require(
        required("EdGraph/EdGraphPin.h")?,
        &[
            "operator<<(FArchive& Ar, FSimpleMemberReference& Data)",
            "Ar << Data.MemberParent",
            "Ar << Data.MemberName",
            "Ar << Data.MemberGuid",
        ],
    )?;
    require(
        required("FortniteReleaseBranchCustomObjectVersions.inl")?,
        &["FORTNITE_RELEASE_VERSION(ActorComponentUCSModifiedPropertiesSparseStorage, 4)"],
    )?;
    require(
        required("UE5SpecialProjectStreamObjectVersion.inl")?,
        &[
            "UE5_SPECIAL_PROJECT_VERSION(SerializeSceneComponentStaticBounds, 2)",
            "UE5_SPECIAL_PROJECT_VERSION(SerializeActorLabelInCookedBuilds, 4)",
        ],
    )?;
    require(
        required("UObject/DevObjectVersion.cpp")?,
        &[
            "FFortniteReleaseBranchCustomObjectVersion::GUID(0xE7086368, 0x6B234C58, 0x84391B70, 0x16265E91)",
            "FUE5SpecialProjectStreamObjectVersion::GUID(0x59DA5D52, 0x12324948, 0xB8785978, 0x70B8E98B)",
        ],
    )?;
    require(
        required("UObject/ObjectMacros.h")?,
        &["RF_ClassDefaultObject = 0x00000010"],
    )?;
    require(
        required("UObject/SavePackage2.cpp")?,
        &[
            "if (Export.Object->HasAnyFlags(RF_ClassDefaultObject))",
            "Export.Object->GetClass()->SerializeDefaultObject(Export.Object, Linker)",
            "else",
            "Export.Object->Serialize(Linker)",
        ],
    )?;
    require(
        required("UObject/Class.cpp")?,
        &[
            "void UClass::SerializeDefaultObject(UObject* Object, FStructuredArchive::FSlot Slot)",
            "SerializeTaggedProperties(Slot, (uint8*)Object, GetSuperClass(), (uint8*)Object->GetArchetype())",
            "UnderlyingArchive.StopSerializingDefaults()",
        ],
    )?;
    layouts.insert("AActor.CookedLabel".into(), L::Bool);
    layouts.insert(
        "UActorComponent.UCSModifiedProperties".into(),
        L::array(L::record([
            ("MemberParent", L::Int32),
            ("MemberName", L::Name),
            (
                "MemberGuid",
                L::record([
                    ("A", L::Int32),
                    ("B", L::Int32),
                    ("C", L::Int32),
                    ("D", L::Int32),
                ]),
            ),
        ])),
    );
    layouts.insert("USceneComponent.StaticBoundsCooked".into(), L::Bool);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> BTreeMap<String, Vec<Token>> {
        [
            ("Engine/Private/Actor.cpp", "void AActor::Serialize(FArchive& Ar) { Super::Serialize(Ar); if(Ar.IsPersistent() && (Ar.CustomVer(FUE5SpecialProjectStreamObjectVersion::GUID) >= FUE5SpecialProjectStreamObjectVersion::SerializeActorLabelInCookedBuilds)) { bool bIsCooked = Ar.IsCooking(); Ar << bIsCooked; if (bIsCooked) { Ar << ActorLabel; } } }"),
            ("Engine/Private/Components/ActorComponent.cpp", "void UActorComponent::Serialize(FArchive& Ar) { Super::Serialize(Ar); if (Ar.CustomVer(FFortniteReleaseBranchCustomObjectVersion::GUID) >= FFortniteReleaseBranchCustomObjectVersion::ActorComponentUCSModifiedPropertiesSparseStorage) { TArray<FSimpleMemberReference> UCSModifiedProperties; Ar << UCSModifiedProperties; Ar << *UCSModifiedProperties; TArray<FSimpleMemberReference> EmptyUCSModifiedProperties; Ar << EmptyUCSModifiedProperties; } }"),
            ("Engine/Private/Components/SceneComponent.cpp", "void USceneComponent::Serialize(FArchive& Ar) { Super::Serialize(Ar); if (bComputeBoundsOnceForGame) { if(Ar.CustomVer(FUE5SpecialProjectStreamObjectVersion::GUID) >= FUE5SpecialProjectStreamObjectVersion::SerializeSceneComponentStaticBounds) { bool bIsCooked = bComputedBoundsOnceForGame && Ar.IsCooking(); Ar << bIsCooked; if (bIsCooked) { Ar << Bounds; } } } }"),
            ("Engine/Classes/EdGraph/EdGraphPin.h", "operator<<(FArchive& Ar, FSimpleMemberReference& Data) { Ar << Data.MemberParent; Ar << Data.MemberName; Ar << Data.MemberGuid; }"),
            ("Core/Public/UObject/FortniteReleaseBranchCustomObjectVersions.inl", "FORTNITE_RELEASE_VERSION(ActorComponentUCSModifiedPropertiesSparseStorage, 4)"),
            ("Core/Public/UObject/UE5SpecialProjectStreamObjectVersion.inl", "UE5_SPECIAL_PROJECT_VERSION(SerializeSceneComponentStaticBounds, 2) UE5_SPECIAL_PROJECT_VERSION(SerializeActorLabelInCookedBuilds, 4)"),
            ("Core/Private/UObject/DevObjectVersion.cpp", "FFortniteReleaseBranchCustomObjectVersion::GUID(0xE7086368, 0x6B234C58, 0x84391B70, 0x16265E91); FUE5SpecialProjectStreamObjectVersion::GUID(0x59DA5D52, 0x12324948, 0xB8785978, 0x70B8E98B);"),
            ("CoreUObject/Public/UObject/ObjectMacros.h", "RF_ClassDefaultObject = 0x00000010"),
            ("CoreUObject/Private/UObject/SavePackage2.cpp", "if (Export.Object->HasAnyFlags(RF_ClassDefaultObject)) { Export.Object->GetClass()->SerializeDefaultObject(Export.Object, Linker); } else { Export.Object->Serialize(Linker); }"),
            ("CoreUObject/Private/UObject/Class.cpp", "void UClass::SerializeDefaultObject(UObject* Object, FStructuredArchive::FSlot Slot) { SerializeTaggedProperties(Slot, (uint8*)Object, GetSuperClass(), (uint8*)Object->GetArchetype()); UnderlyingArchive.StopSerializingDefaults(); }")
        ].into_iter().map(|(path, source)| (path.into(), super::super::lex(source).unwrap())).collect()
    }

    #[test]
    fn changing_member_order_version_gates_or_cdo_dispatch_invalidates_recipes() {
        let original = sources();
        let mut layouts = BTreeMap::new();
        derive(&original, &mut layouts).unwrap();
        assert_eq!(layouts.len(), 3);
        for (path, changed) in [
            (
                "Engine/Classes/EdGraph/EdGraphPin.h",
                "operator<<(FArchive& Ar, FSimpleMemberReference& Data) { Ar << Data.MemberName; Ar << Data.MemberParent; Ar << Data.MemberGuid; }",
            ),
            (
                "Core/Public/UObject/FortniteReleaseBranchCustomObjectVersions.inl",
                "FORTNITE_RELEASE_VERSION(ActorComponentUCSModifiedPropertiesSparseStorage, 5)",
            ),
            (
                "CoreUObject/Private/UObject/SavePackage2.cpp",
                "if (Export.Object->HasAnyFlags(RF_ClassDefaultObject)) { Export.Object->Serialize(Linker); } else { Export.Object->GetClass()->SerializeDefaultObject(Export.Object, Linker); }",
            ),
        ] {
            let mut sources = original.clone();
            sources.insert(path.into(), super::super::lex(changed).unwrap());
            assert!(derive(&sources, &mut BTreeMap::new()).is_err(), "{path}");
        }
    }

    #[test]
    fn incomplete_opt_in_requires_related_sources() {
        let sources = BTreeMap::from([(
            "Engine/Private/Actor.cpp".into(),
            super::super::lex("void AActor::Serialize(FArchive& Ar) { Super::Serialize(Ar); }")
                .unwrap(),
        )]);
        assert!(derive(&sources, &mut BTreeMap::new()).is_err());
        assert!(derive(&BTreeMap::new(), &mut BTreeMap::new()).is_ok());
    }
}
