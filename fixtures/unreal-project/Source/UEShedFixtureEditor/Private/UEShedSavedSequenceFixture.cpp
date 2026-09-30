#include "UEShedSavedSequenceFixture.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/SceneComponent.h"
#include "UObject/UnrealType.h"
#include "Channels/MovieSceneChannelProxy.h"
#include "Channels/MovieSceneFloatChannel.h"
#include "Channels/MovieSceneStringChannel.h"
#include "Channels/MovieSceneObjectPathChannel.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "LevelSequence.h"
#include "Misc/PackageName.h"
#include "MovieScene.h"
#include "Sections/MovieSceneCameraCutSection.h"
#include "Tracks/MovieSceneCameraCutTrack.h"
#include "Tracks/MovieSceneFloatTrack.h"
#include "Tracks/MovieSceneObjectPropertyTrack.h"
#include "Tracks/MovieSceneStringTrack.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace {
constexpr const TCHAR* PackageName = TEXT("/Game/Fixture/ParserNative/LS_SavedDetails");
constexpr const TCHAR* ObjectPath = TEXT("/Game/Fixture/ParserNative/LS_SavedDetails.LS_SavedDetails");
FString Guid(const FGuid& V) { return FString::Printf(TEXT("%08x-%08x-%08x-%08x"), V.A,V.B,V.C,V.D); }
template<typename T> UMovieSceneSection* Section(UMovieScene* Scene, const TCHAR* Name) {
    auto* Track = Scene->AddTrack<T>(); Track->SetPropertyNameAndPath(Name, Name);
    auto* Section = Track->CreateNewSection(); Section->SetRange(TRange<FFrameNumber>(0,120)); Track->AddSection(*Section); return Section;
}
}

bool GenerateSavedSequenceFixture() {
    auto* Package = CreatePackage(PackageName);
    auto* Sequence = NewObject<ULevelSequence>(Package, TEXT("LS_SavedDetails"), RF_Public|RF_Standalone);
    FAssetRegistryModule::AssetCreated(Sequence); Sequence->Initialize();
    auto* Scene = Sequence->GetMovieScene(); Scene->SetTickResolutionDirectly(FFrameRate(24,1)); Scene->SetDisplayRate(FFrameRate(24,1)); Scene->SetPlaybackRange(0,120);
    auto* Text = Section<UMovieSceneStringTrack>(Scene,TEXT("Label"));
    auto* Strings = Text->GetChannelProxy().GetChannels<FMovieSceneStringChannel>()[0];
    Strings->SetDefault(TEXT("default label")); Strings->AddKeys({0,24,100},{TEXT("hello"),TEXT(""),TEXT("世界 🌟")});
    Text->SetRowIndex(2); Text->SetOverlapPriority(-7); Text->SetIsActive(false); Text->SetIsLocked(true); Text->SetPreRollFrames(3); Text->SetPostRollFrames(4);
    Text->Easing.bManualEaseIn=true; Text->Easing.ManualEaseInDuration=8;
    Text->Easing.bManualEaseOut=true; Text->Easing.ManualEaseOutDuration=12;
    auto* Empty = Section<UMovieSceneStringTrack>(Scene,TEXT("DefaultOnly"));
    Empty->GetChannelProxy().GetChannels<FMovieSceneStringChannel>()[0]->SetDefault(TEXT("only"));
    auto* Objects = Section<UMovieSceneObjectPropertyTrack>(Scene,TEXT("Mesh"));
    auto* Channel = Objects->GetChannelProxy().GetChannels<FMovieSceneObjectPathChannel>()[0];
    auto* Cube = LoadObject<UStaticMesh>(nullptr,TEXT("/Engine/BasicShapes/Cube.Cube"));
    auto* Sphere = LoadObject<UStaticMesh>(nullptr,TEXT("/Engine/BasicShapes/Sphere.Sphere"));
    if (!Cube || !Sphere) return false;
    Channel->SetPropertyClass(UStaticMesh::StaticClass()); Channel->SetDefault(Cube);
    Channel->GetData().AddKey(0,FMovieSceneObjectPathChannelKeyValue(Cube));
    Channel->GetData().AddKey(24,FMovieSceneObjectPathChannelKeyValue(nullptr));
    Channel->GetData().AddKey(100,FMovieSceneObjectPathChannelKeyValue(Sphere));
    auto* Amount = Section<UMovieSceneFloatTrack>(Scene,TEXT("Amount"));
    Amount->SetBlendType(EMovieSceneBlendType::Additive); Amount->GetChannelProxy().GetChannels<FMovieSceneFloatChannel>()[0]->SetDefault(0.25f);
    const FGuid Existing = Scene->AddPossessable(TEXT("ExistingCamera"),ACameraActor::StaticClass());
    auto* Template = NewObject<ACameraActor>(Scene,TEXT("SavedCameraTemplate"),RF_Transactional);
    auto* Camera = Template->GetCameraComponent();
    Camera->CreationMethod = EComponentCreationMethod::SimpleConstructionScript;
    Camera->SetFieldOfView(63.0f);
    Camera->PostProcessBlendWeight = 0.75f;
    Camera->DetermineUCSModifiedProperties();
    Template->GetRootComponent()->bComputeBoundsOnceForGame = true;
    const FGuid Spawned = Scene->AddSpawnable(TEXT("SpawnedCamera"),*Template);
    auto* Cuts = CastChecked<UMovieSceneCameraCutTrack>(Scene->AddCameraCutTrack(UMovieSceneCameraCutTrack::StaticClass()));
    const TArray<FMovieSceneObjectBindingID> Bindings = {
        UE::MovieScene::FRelativeObjectBindingID(Existing), UE::MovieScene::FRelativeObjectBindingID(Spawned),
        UE::MovieScene::FRelativeObjectBindingID(FGuid(1,2,3,4),FMovieSceneSequenceID(42),1)
    };
    for (int32 I=0; I<Bindings.Num(); ++I) {
        auto* Cut = CastChecked<UMovieSceneCameraCutSection>(Cuts->CreateNewSection());
        Cut->SetRange(TRange<FFrameNumber>(I*40,(I+1)*40)); Cut->SetCameraBindingID(Bindings[I]); Cut->bLockPreviousCamera=I==1; Cuts->AddSection(*Cut);
    }
    Sequence->MarkPackageDirty(); FSavePackageArgs Args; Args.TopLevelFlags=RF_Public|RF_Standalone; Args.SaveFlags=SAVE_NoError;
    return UPackage::SavePackage(Package,Sequence,*FPackageName::LongPackageNameToFilename(PackageName,FPackageName::GetAssetPackageExtension()),Args);
}

TSharedPtr<FJsonObject> SavedSequenceFixtureEvidence() {
    auto* Sequence = LoadObject<ULevelSequence>(nullptr,ObjectPath); if (!Sequence) return nullptr;
    auto* Scene = Sequence->GetMovieScene(); auto Result = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Tracks;
    for (const auto* Track : Scene->GetTracks()) {
        auto Value=MakeShared<FJsonObject>(); auto* PropertyTrack=CastChecked<UMovieScenePropertyTrack>(Track);
        Value->SetStringField(TEXT("property"),PropertyTrack->GetPropertyName().ToString());
        const auto* Section=Track->GetAllSections()[0];
        Value->SetNumberField(TEXT("row"),Section->GetRowIndex()); Value->SetNumberField(TEXT("priority"),Section->GetOverlapPriority());
        Value->SetBoolField(TEXT("active"),Section->IsActive()); Value->SetBoolField(TEXT("locked"),Section->IsLocked());
        Value->SetNumberField(TEXT("pre"),Section->GetPreRollFrames()); Value->SetNumberField(TEXT("post"),Section->GetPostRollFrames());
        Value->SetNumberField(TEXT("ease_in"),Section->Easing.GetEaseInDuration()); Value->SetNumberField(TEXT("ease_out"),Section->Easing.GetEaseOutDuration());
        TArray<TSharedPtr<FJsonValue>> Keys;
        for (const auto* C : Section->GetChannelProxy().GetChannels<FMovieSceneStringChannel>()) {
            Value->SetBoolField(TEXT("has_default"),C->GetDefault().IsSet()); if (C->GetDefault().IsSet()) Value->SetStringField(TEXT("default"),C->GetDefault().GetValue());
            auto Data=C->GetData(); for (int32 I=0; I<Data.GetTimes().Num(); ++I) { auto K=MakeShared<FJsonObject>(); K->SetNumberField(TEXT("frame"),Data.GetTimes()[I].Value); K->SetStringField(TEXT("value"),Data.GetValues()[I]); Keys.Add(MakeShared<FJsonValueObject>(K)); }
        }
        for (const auto* C : Section->GetChannelProxy().GetChannels<FMovieSceneObjectPathChannel>()) {
            Value->SetStringField(TEXT("property_class"),C->GetPropertyClass()->GetPathName()); Value->SetStringField(TEXT("default"),C->GetDefault().GetSoftPtr().ToSoftObjectPath().ToString());
            auto Data=C->GetData(); for (int32 I=0; I<Data.GetTimes().Num(); ++I) { auto K=MakeShared<FJsonObject>(); K->SetNumberField(TEXT("frame"),Data.GetTimes()[I].Value); K->SetStringField(TEXT("value"),Data.GetValues()[I].GetSoftPtr().ToSoftObjectPath().ToString()); Keys.Add(MakeShared<FJsonValueObject>(K)); }
        }
        Value->SetArrayField(TEXT("keys"),Keys); Tracks.Add(MakeShared<FJsonValueObject>(Value));
    }
    Result->SetArrayField(TEXT("tracks"),Tracks);
    TArray<TSharedPtr<FJsonValue>> Bindings;
    for (int32 I=0; I<Scene->GetPossessableCount(); ++I) { const auto& B=Scene->GetPossessable(I); auto V=MakeShared<FJsonObject>(); V->SetStringField(TEXT("id"),Guid(B.GetGuid())); V->SetStringField(TEXT("name"),B.GetName()); V->SetStringField(TEXT("kind"),TEXT("possessable")); Bindings.Add(MakeShared<FJsonValueObject>(V)); }
    for (int32 I=0; I<Scene->GetSpawnableCount(); ++I) { const auto& B=Scene->GetSpawnable(I); auto V=MakeShared<FJsonObject>(); V->SetStringField(TEXT("id"),Guid(B.GetGuid())); V->SetStringField(TEXT("name"),B.GetName()); V->SetStringField(TEXT("kind"),TEXT("spawnable")); V->SetStringField(TEXT("template"),B.GetObjectTemplate()->GetPathName()); Bindings.Add(MakeShared<FJsonValueObject>(V)); }
    Result->SetArrayField(TEXT("bindings"),Bindings);
    TArray<TSharedPtr<FJsonValue>> Cuts;
    for (const auto* S : Scene->GetCameraCutTrack()->GetAllSections()) { auto* C=CastChecked<UMovieSceneCameraCutSection>(S); auto V=MakeShared<FJsonObject>(); V->SetStringField(TEXT("guid"),Guid(C->GetCameraBindingID().GetGuid())); V->SetNumberField(TEXT("sequence_id"),C->GetCameraBindingID().GetRelativeSequenceID().GetInternalValue()); V->SetBoolField(TEXT("lock"),C->bLockPreviousCamera); V->SetNumberField(TEXT("start"),C->GetInclusiveStartFrame().Value); V->SetNumberField(TEXT("end"),C->GetExclusiveEndFrame().Value); Cuts.Add(MakeShared<FJsonValueObject>(V)); }
    Result->SetArrayField(TEXT("cuts"),Cuts);
    TArray<TSharedPtr<FJsonValue>> NativeObjects;
    auto* Camera = CastChecked<ACameraActor>(Scene->GetSpawnable(0).GetObjectTemplate());
    for (UObject* Object : TArray<UObject*>{Camera, Camera->GetCameraComponent(), Camera->GetRootComponent()}) {
        auto V = MakeShared<FJsonObject>();
        V->SetStringField(TEXT("path"), Object->GetPathName());
        V->SetStringField(TEXT("class"), Object->GetClass()->GetPathName());
        if (const auto* Component = Cast<UActorComponent>(Object)) {
            TSet<const FProperty*> Modified;
            Component->GetUCSModifiedProperties(Modified);
            TArray<const FProperty*> Ordered = Modified.Array();
            Ordered.Sort([](const FProperty& A, const FProperty& B) { return A.GetPathName() < B.GetPathName(); });
            TArray<TSharedPtr<FJsonValue>> Members;
            for (const FProperty* Property : Ordered) {
                auto Member = MakeShared<FJsonObject>();
                Member->SetStringField(TEXT("name"), Property->GetName());
                Member->SetStringField(TEXT("owner"), Property->GetOwnerStruct()->GetPathName());
                Members.Add(MakeShared<FJsonValueObject>(Member));
            }
            V->SetArrayField(TEXT("modified_members"), Members);
        }
        if (const auto* SceneComponent = Cast<USceneComponent>(Object)) {
            V->SetBoolField(TEXT("compute_static_bounds"), SceneComponent->bComputeBoundsOnceForGame);
        }
        NativeObjects.Add(MakeShared<FJsonValueObject>(V));
    }
    Result->SetArrayField(TEXT("native_objects"), NativeObjects);
    return Result;
}
