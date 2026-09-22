#include "UEShedCameraAuthoringBridge.h"
#include "UEShedCameraSetup.h"
#include "UEShedCameraExposure.h"
#include "Camera/CameraComponent.h"
#include "Containers/Ticker.h"
#include "Editor.h"
#include "Engine/Selection.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "LevelEditorViewport.h"
#include "Misc/App.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedCameraEditorOwnership.h"
#include "UEShedCameraVisibility.h"

namespace
{
struct FAuthoringCamera
{
    TWeakObjectPtr<AUEShedAuthoringCamera> Actor;
    FString Label;
    FVector Location = FVector::ZeroVector;
    FRotator Rotation = FRotator::ZeroRotator;
    float FOV = 60;
    bool Changed = false;
    bool HostPresent = true;
    TSharedPtr<FJsonObject> Definition;
};
struct FAuthoringState
{
    FString Session, CameraId, Producer = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
    TWeakObjectPtr<AUEShedAuthoringCamera> Proxy;
    TMap<FString, FAuthoringCamera> Cameras;
    TMap<FString, FAuthoringCamera> Deleted;
    bool MultiCamera = false;
    TWeakObjectPtr<UWorld> World;
    TArray<TWeakObjectPtr<AActor>> Selection;
    FLevelEditorViewportClient *Viewport = nullptr;
    FVector ViewLocation, ObservedLocation;
    FRotator ViewRotation, ObservedRotation;
    float ViewFOV = 90, ObservedFOV = 60;
    bool LockedCamera = false;
    bool SaveRequested = false;
    FString Notice;
    TSharedPtr<FJsonObject> Panel, Event;
    int64 EventSequence = 0;
    TSharedPtr<FUEShedCameraVisibility, ESPMode::ThreadSafe> Visibility;
    int64 Revision = 0, Sequence = 0, Acknowledged = 0;
    double Deadline = 0;
};
TUniquePtr<FAuthoringState> AuthoringState;
FString LastRecoveryMessage;
TArray<TWeakObjectPtr<AUEShedAuthoringCamera>> ImportedCameras;
TArray<TWeakObjectPtr<AUEShedAuthoringCamera>> UndoCameras;
const FString CameraTagPrefix = TEXT("UEShed.Camera.");
const FString ProducerTagPrefix = TEXT("UEShed.Producer.");
void Eject();
void TagCamera(AUEShedAuthoringCamera *Actor, const FString &Id)
{
    Actor->Tags.RemoveAll([](const FName &Tag) {
        return Tag.ToString().StartsWith(CameraTagPrefix) || Tag.ToString().StartsWith(ProducerTagPrefix);
    });
    Actor->Tags.Add(FName(CameraTagPrefix + Id));
    Actor->Tags.Add(FName(ProducerTagPrefix + AuthoringState->Producer));
}
TSharedPtr<FJsonObject> Obj()
{
    return MakeShared<FJsonObject>();
}
FString Str(const TSharedPtr<FJsonObject> &O, const TCHAR *Key)
{
    FString V;
    if (O)
        O->TryGetStringField(Key, V);
    return V;
}
bool Number(const TSharedPtr<FJsonObject> &O, const TCHAR *Key, double &V)
{
    return O && O->TryGetNumberField(Key, V) && FMath::IsFinite(V);
}
bool Identifier(const FString &Value)
{
    if (Value.IsEmpty() || Value.Len() > 128)
        return false;
    for (int32 I = 0; I < Value.Len(); ++I)
    {
        const TCHAR C = Value[I];
        const bool Alnum = (C >= 'a' && C <= 'z') || (C >= 'A' && C <= 'Z') || (C >= '0' && C <= '9');
        if (!Alnum && (I == 0 || (C != '.' && C != '_' && C != '-')))
            return false;
    }
    return true;
}
TSharedPtr<FJsonObject> Child(const TSharedPtr<FJsonObject> &O, const TCHAR *Key)
{
    const TSharedPtr<FJsonObject> *V;
    return O && O->TryGetObjectField(Key, V) ? *V : nullptr;
}
TSharedPtr<FJsonObject> Result(const TCHAR *Status, const TCHAR *Message = TEXT(""))
{
    auto R = Obj();
    R->SetStringField(TEXT("status"), Status);
    R->SetStringField(TEXT("message"), Message);
    R->SetNumberField(TEXT("version"), 1);
    return R;
}
bool ReadPose(const TSharedPtr<FJsonObject> &P, FVector &L, FRotator &R, double &FOV)
{
    const auto Pos = Child(P, TEXT("location")), Rot = Child(P, TEXT("rotation"));
    return Str(P, TEXT("projection")) == TEXT("perspective") && Str(P, TEXT("aspectRatio")) == TEXT("16:9") &&
           Number(Pos, TEXT("x"), L.X) && Number(Pos, TEXT("y"), L.Y) && Number(Pos, TEXT("z"), L.Z) &&
           Number(Rot, TEXT("pitch"), R.Pitch) && Number(Rot, TEXT("yaw"), R.Yaw) &&
           Number(Rot, TEXT("roll"), R.Roll) && Number(P, TEXT("fieldOfViewDegrees"), FOV) && FOV >= 5 && FOV <= 170;
}
TSharedPtr<FJsonObject> Pose(const FVector &Location, const FRotator &Rotation, float FOV)
{
    auto P = Obj(), L = Obj(), R = Obj();
    L->SetNumberField(TEXT("x"), Location.X);
    L->SetNumberField(TEXT("y"), Location.Y);
    L->SetNumberField(TEXT("z"), Location.Z);
    R->SetNumberField(TEXT("pitch"), Rotation.Pitch);
    R->SetNumberField(TEXT("yaw"), Rotation.Yaw);
    R->SetNumberField(TEXT("roll"), Rotation.Roll);
    P->SetObjectField(TEXT("location"), L);
    P->SetObjectField(TEXT("rotation"), R);
    P->SetNumberField(TEXT("fieldOfViewDegrees"), FOV);
    P->SetStringField(TEXT("projection"), TEXT("perspective"));
    P->SetStringField(TEXT("aspectRatio"), TEXT("16:9"));
    return P;
}
void ActiveObservation()
{
    if (const auto *Entry = AuthoringState->Cameras.Find(AuthoringState->CameraId))
    {
        AuthoringState->Proxy = Entry->Actor;
        AuthoringState->ObservedLocation = Entry->Location;
        AuthoringState->ObservedRotation = Entry->Rotation;
        AuthoringState->ObservedFOV = Entry->FOV;
    }
}
bool Owned(const AActor *Actor)
{
    if (Actor && AuthoringState)
        for (const auto &Pair : AuthoringState->Cameras)
            if (Pair.Value.Actor.Get() == Actor)
                return true;
    return false;
}
bool ReadCameras(const TSharedPtr<FJsonObject> &Q, TMap<FString, FAuthoringCamera> &Entries)
{
    const TArray<TSharedPtr<FJsonValue>> *Values;
    if (!Q->TryGetArrayField(TEXT("cameras"), Values) || Values->IsEmpty() || Values->Num() > 256)
        return false;
    for (const auto &Value : *Values)
    {
        if (!Value || Value->Type != EJson::Object)
            return false;
        const auto C = Value->AsObject();
        const FString Id = Str(C, TEXT("id")), Label = Str(C, TEXT("displayName"));
        FAuthoringCamera Entry;
        double FOV = 0;
        if (!Identifier(Id) || Label.IsEmpty() || Entries.Contains(Id) ||
            !ReadPose(Child(C, TEXT("pose")), Entry.Location, Entry.Rotation, FOV))
            return false;
        Entry.Label = Label;
        Entry.FOV = FOV;
        Entry.Definition = Child(C, TEXT("definition"));
        if (Entry.Definition &&
            (Str(Entry.Definition, TEXT("id")) != Id || !Identifier(Str(Entry.Definition, TEXT("viewId")))))
            return false;
        Entries.Add(Id, Entry);
    }
    return true;
}
bool Materialize(TMap<FString, FAuthoringCamera> Entries)
{
    // Reuse native actor identities: selection, Details and Unreal transactions keep working.
    TArray<AUEShedAuthoringCamera *> Created;
    for (auto &Pair : Entries)
    {
        auto *Existing = AuthoringState->Cameras.Find(Pair.Key);
        Pair.Value.Actor = Existing ? Existing->Actor : nullptr;
        if (!Pair.Value.Actor.IsValid())
        {
            FActorSpawnParameters Params;
            Params.ObjectFlags = RF_Transient | RF_Transactional;
            Params.bTemporaryEditorActor = true;
            Params.bCreateActorPackage = false;
            Pair.Value.Actor = AuthoringState->World->SpawnActor<AUEShedAuthoringCamera>(Pair.Value.Location,
                                                                                         Pair.Value.Rotation, Params);
            if (!Pair.Value.Actor.IsValid())
            {
                for (auto *Actor : Created)
                    AuthoringState->World->DestroyActor(Actor, false, false);
                return false;
            }
            Created.Add(Pair.Value.Actor.Get());
        }
    }
    for (auto &Pair : Entries)
    {
        auto *Actor = Pair.Value.Actor.Get();
        TagCamera(Actor, Pair.Key);
        Actor->SetActorLabel(TEXT("UE Shed — ") + Pair.Value.Label, false);
        Actor->SetActorLocationAndRotation(Pair.Value.Location, Pair.Value.Rotation);
        Actor->GetCameraComponent()->SetFieldOfView(Pair.Value.FOV);
        Pair.Value.Location = Actor->GetActorLocation();
        Pair.Value.Rotation = Actor->GetActorRotation();
        Pair.Value.FOV = Actor->GetCameraComponent()->FieldOfView;
    }
    for (const auto &Pair : AuthoringState->Cameras)
        if (!Entries.Contains(Pair.Key) && Pair.Value.Actor.IsValid())
        {
            GEditor->SelectActor(Pair.Value.Actor.Get(), false, false);
            AuthoringState->World->DestroyActor(Pair.Value.Actor.Get(), false, false);
        }
    AuthoringState->Cameras = MoveTemp(Entries);
    for (auto &Pair : AuthoringState->Deleted)
        Pair.Value.HostPresent = false;
    ActiveObservation();
    return true;
}
void Observe()
{
    if (!AuthoringState || !GEditor)
        return;
    bool Changed = false;
    FString SelectedId;
    // Native Undo revives the same transaction-owned actor; retain its camera and View identities.
    for (auto It = AuthoringState->Deleted.CreateIterator(); It; ++It)
        if (It.Value().Actor.IsValid())
        {
            AuthoringState->Cameras.Add(It.Key(), It.Value());
            It.RemoveCurrent();
            Changed = true;
        }
    TArray<FString> Removed;
    for (auto &Pair : AuthoringState->Cameras)
    {
        auto &Entry = Pair.Value;
        auto *C = Entry.Actor.Get();
        if (!C)
        {
            if (AuthoringState->MultiCamera && Entry.Definition)
                Removed.Add(Pair.Key);
            continue;
        }
        const auto L = C->GetActorLocation();
        const auto R = C->GetActorRotation();
        const float F = C->GetCameraComponent()->FieldOfView;
        if (!L.Equals(Entry.Location, 0.0001) || !R.Equals(Entry.Rotation, 0.0001) ||
            !FMath::IsNearlyEqual(F, Entry.FOV, 0.0001f))
        {
            Entry.Location = L;
            Entry.Rotation = R;
            Entry.FOV = F;
            Entry.Changed = true;
            Changed = true;
        }
        if (C->IsSelected() && GEditor->GetSelectedActorCount() == 1)
            SelectedId = Pair.Key;
    }
    for (const auto &Id : Removed)
    {
        if (AuthoringState->Deleted.Num() >= 256)
            for (auto It = AuthoringState->Deleted.CreateIterator(); It; ++It)
                if (!It.Value().HostPresent)
                {
                    It.RemoveCurrent();
                    break;
                }
        AuthoringState->Deleted.Add(Id, AuthoringState->Cameras.FindChecked(Id));
        AuthoringState->Cameras.Remove(Id);
        Changed = true;
    }
    if (!AuthoringState->Cameras.Contains(AuthoringState->CameraId) && AuthoringState->Cameras.Num())
    {
        Eject();
        AuthoringState->CameraId = AuthoringState->Cameras.CreateConstIterator().Key();
    }
    if (!SelectedId.IsEmpty() && SelectedId != AuthoringState->CameraId && !AuthoringState->Viewport)
    {
        AuthoringState->CameraId = SelectedId;
        Changed = true;
    }
    ActiveObservation();
    if (Changed)
    {
        if (AuthoringState->SaveRequested)
        {
            AuthoringState->SaveRequested = false;
            AuthoringState->Notice = TEXT("Camera changed after Save; review and Save again.");
        }
        ++AuthoringState->Sequence;
    }
}
TSharedPtr<FJsonObject> Snapshot()
{
    Observe();
    auto R = Result(TEXT("ready"), *AuthoringState->Notice);
    R->SetStringField(TEXT("sessionId"), AuthoringState->Session);
    R->SetStringField(TEXT("cameraId"), AuthoringState->CameraId);
    R->SetStringField(TEXT("producerId"), AuthoringState->Producer);
    R->SetNumberField(TEXT("revision"), AuthoringState->Revision);
    R->SetNumberField(TEXT("sequence"), AuthoringState->Sequence);
    R->SetBoolField(TEXT("pending"), AuthoringState->Sequence != AuthoringState->Acknowledged);
    R->SetBoolField(TEXT("saveRequested"), AuthoringState->SaveRequested);
    R->SetBoolField(TEXT("piloting"),
                    GEditor && AuthoringState->Viewport &&
                        GEditor->GetLevelViewportClients().Contains(AuthoringState->Viewport) &&
                        AuthoringState->Viewport->GetActorLock().GetLockedActor() == AuthoringState->Proxy.Get());
    auto P = Obj(), L = Obj(), A = Obj();
    L->SetNumberField(TEXT("x"), AuthoringState->ObservedLocation.X);
    L->SetNumberField(TEXT("y"), AuthoringState->ObservedLocation.Y);
    L->SetNumberField(TEXT("z"), AuthoringState->ObservedLocation.Z);
    A->SetNumberField(TEXT("pitch"), AuthoringState->ObservedRotation.Pitch);
    A->SetNumberField(TEXT("yaw"), AuthoringState->ObservedRotation.Yaw);
    A->SetNumberField(TEXT("roll"), AuthoringState->ObservedRotation.Roll);
    P->SetObjectField(TEXT("location"), L);
    P->SetObjectField(TEXT("rotation"), A);
    P->SetNumberField(TEXT("fieldOfViewDegrees"), AuthoringState->ObservedFOV);
    P->SetStringField(TEXT("projection"), TEXT("perspective"));
    P->SetStringField(TEXT("aspectRatio"), TEXT("16:9"));
    R->SetObjectField(TEXT("pose"), P);
    if (AuthoringState->MultiCamera)
    {
        TArray<TSharedPtr<FJsonValue>> Cameras, Edits, Selected, Added, Removed;
        for (const auto &Pair : AuthoringState->Cameras)
        {
            auto C = Obj();
            C->SetStringField(TEXT("id"), Pair.Key);
            C->SetStringField(TEXT("displayName"), Pair.Value.Label);
            if (Pair.Value.Definition)
                C->SetObjectField(TEXT("definition"), Pair.Value.Definition);
            const auto NativePose = Pose(Pair.Value.Location, Pair.Value.Rotation, Pair.Value.FOV);
            C->SetObjectField(TEXT("pose"), NativePose);
            Cameras.Add(MakeShared<FJsonValueObject>(C));
            if (!Pair.Value.HostPresent && Pair.Value.Definition)
            {
                auto Definition = MakeShared<FJsonObject>(*Pair.Value.Definition);
                Definition->SetObjectField(TEXT("manualPose"), NativePose);
                auto Overrides = Child(Definition, TEXT("overrides"));
                Overrides = Overrides ? MakeShared<FJsonObject>(*Overrides) : Obj();
                Overrides->SetNumberField(TEXT("fieldOfViewDegrees"), Pair.Value.FOV);
                Definition->SetObjectField(TEXT("overrides"), Overrides);
                Added.Add(MakeShared<FJsonValueObject>(Definition));
            }
            else if (Pair.Value.Changed)
            {
                auto Edit = Obj();
                Edit->SetStringField(TEXT("cameraId"), Pair.Key);
                Edit->SetObjectField(TEXT("pose"), NativePose);
                Edits.Add(MakeShared<FJsonValueObject>(Edit));
            }
            if (Pair.Value.Actor.IsValid() && Pair.Value.Actor->IsSelected())
                Selected.Add(MakeShared<FJsonValueString>(Pair.Key));
        }
        for (const auto &Pair : AuthoringState->Deleted)
            if (Pair.Value.HostPresent)
                Removed.Add(MakeShared<FJsonValueString>(Pair.Key));
        R->SetArrayField(TEXT("added"), Added);
        R->SetArrayField(TEXT("removed"), Removed);
        R->SetArrayField(TEXT("cameras"), Cameras);
        R->SetArrayField(TEXT("edits"), Edits);
        R->SetArrayField(TEXT("selectedCameraIds"), Selected);
    }
    if (AuthoringState->Panel)
        R->SetObjectField(TEXT("panel"), AuthoringState->Panel);
    if (AuthoringState->Event)
        R->SetObjectField(TEXT("panelEvent"), AuthoringState->Event);
    return R;
}
void Eject()
{
    if (AuthoringState && AuthoringState->Visibility)
        AuthoringState->Visibility->Enabled = false;
    if (!AuthoringState || !AuthoringState->Viewport || !GEditor ||
        !GEditor->GetLevelViewportClients().Contains(AuthoringState->Viewport))
        return;
    auto *V = AuthoringState->Viewport;
    if (Owned(V->GetActorLock().GetLockedActor()) || !V->GetActorLock().GetLockedActor())
    {
        V->SetActorLock(nullptr);
        V->bLockedCameraView = AuthoringState->LockedCamera;
        V->SetViewLocation(AuthoringState->ViewLocation);
        V->SetViewRotation(AuthoringState->ViewRotation);
        V->ViewFOV = AuthoringState->ViewFOV;
        V->Invalidate();
    }
    AuthoringState->Viewport = nullptr;
}
} // namespace

AUEShedAuthoringCamera::AUEShedAuthoringCamera()
{
    SetFlags(RF_Transient | RF_Transactional);
    bIsEditorOnlyActor = true;
    GetCameraComponent()->SetFlags(RF_Transient | RF_Transactional);
    GetCameraComponent()->SetAspectRatio(16.f / 9.f);
}
void AUEShedAuthoringCamera::PostEditImport()
{
    Super::PostEditImport();
    SetFlags(RF_Transient | RF_Transactional);
    TInlineComponentArray<UActorComponent *> Components(this);
    for (auto *Component : Components)
        Component->SetFlags(RF_Transient | RF_Transactional);
    FUEShedCameraAuthoringBridge::RegisterImportedCamera(this);
}
void AUEShedAuthoringCamera::PostEditUndo()
{
    Super::PostEditUndo();
    UndoCameras.AddUnique(this);
}
bool AUEShedAuthoringCamera::CanDeleteSelectedActor(FText &OutReason) const
{
    if (!AuthoringState || !AuthoringState->MultiCamera)
        return Super::CanDeleteSelectedActor(OutReason);
    int32 Remaining = 0;
    for (const auto &Pair : AuthoringState->Cameras)
        if (Pair.Value.Actor.IsValid() && Pair.Value.Actor.Get() != this && !Pair.Value.Actor->IsSelected())
            ++Remaining;
    if (Remaining > 0)
        return Super::CanDeleteSelectedActor(OutReason);
    OutReason = FText::FromString(
        TEXT("Keep at least one camera in the set. Close Camera Authoring to remove the whole transient set."));
    return false;
}
void FUEShedCameraAuthoringBridge::RegisterImportedCamera(AUEShedAuthoringCamera *Actor)
{
    // Import finishes positioning the actor after PostEditImport. Adopt it on the next bridge tick.
    ImportedCameras.AddUnique(Actor);
}
AUEShedAuthoringCamera *FUEShedCameraAuthoringBridge::Camera()
{
    return AuthoringState ? AuthoringState->Proxy.Get() : nullptr;
}
AUEShedAuthoringCamera *FUEShedCameraAuthoringBridge::Camera(const FString &CameraId)
{
    const auto *Entry = AuthoringState ? AuthoringState->Cameras.Find(CameraId) : nullptr;
    return Entry ? Entry->Actor.Get() : nullptr;
}
TArray<AUEShedAuthoringCamera *> FUEShedCameraAuthoringBridge::Cameras()
{
    TArray<AUEShedAuthoringCamera *> Result;
    if (AuthoringState)
        for (const auto &Pair : AuthoringState->Cameras)
            if (Pair.Value.Actor.IsValid())
                Result.Add(Pair.Value.Actor.Get());
    return Result;
}
FSimpleMulticastDelegate &FUEShedCameraAuthoringBridge::OnEditorFocusRequested()
{
    static FSimpleMulticastDelegate FocusRequested;
    return FocusRequested;
}

TSharedPtr<FJsonObject> FUEShedCameraAuthoringBridge::InspectActive()
{
    Tick(0);
    return AuthoringState
               ? Snapshot()
               : Result(TEXT("unavailable"), LastRecoveryMessage.IsEmpty()
                                                 ? TEXT("Attach an arrangement camera from UE Shed or the CLI.")
                                                 : *LastRecoveryMessage);
}
void FUEShedCameraAuthoringBridge::Shutdown()
{
    if (!AuthoringState)
        return;
    Observe();
    if (AuthoringState->Sequence != AuthoringState->Acknowledged || AuthoringState->Event)
    {
        const auto Recovery = Snapshot();
        Recovery->SetStringField(TEXT("projectName"), FApp::GetProjectName());
        Recovery->SetStringField(TEXT("mapPath"), AuthoringState->World.IsValid()
                                                      ? AuthoringState->World->GetOutermost()->GetName()
                                                      : TEXT(""));
        const FString Directory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/CameraAuthoringRecovery"));
        const FString Path = FPaths::Combine(Directory, AuthoringState->Producer + TEXT(".json"));
        IFileManager::Get().MakeDirectory(*Directory, true);
        FString Json;
        FJsonSerializer::Serialize(Recovery.ToSharedRef(), TJsonWriterFactory<>::Create(&Json));
        LastRecoveryMessage = FFileHelper::SaveStringToFile(Json, *Path)
                                  ? TEXT("Pending native edits preserved at ") + Path
                                  : TEXT("Could not write pending native camera recovery at ") + Path;
    }
    Eject();
    if (GEditor)
    {
        bool Selected = false;
        for (const auto &Pair : AuthoringState->Cameras)
            Selected |= Pair.Value.Actor.IsValid() && Pair.Value.Actor->IsSelected();
        if (Selected)
        {
            GEditor->SelectNone(false, true, false);
            for (const auto &A : AuthoringState->Selection)
                if (A.IsValid())
                    GEditor->SelectActor(A.Get(), true, false);
            GEditor->NoteSelectionChange();
        }
        if (AuthoringState->World.IsValid())
            for (const auto &Pair : AuthoringState->Cameras)
                if (Pair.Value.Actor.IsValid())
                    AuthoringState->World->DestroyActor(Pair.Value.Actor.Get(), false, false);
    }
    FUEShedCameraEditorOwnership::Release(AuthoringState->Session);
    AuthoringState.Reset();
}
bool FUEShedCameraAuthoringBridge::Tick(float DeltaSeconds)
{
    for (const auto &WeakActor : UndoCameras)
        if (auto *Actor = WeakActor.Get())
            if (!AuthoringState || !Actor->Tags.Contains(FName(ProducerTagPrefix + AuthoringState->Producer)))
                Actor->GetWorld()->DestroyActor(Actor, false, false);
    UndoCameras.Reset();
    for (const auto &WeakActor : ImportedCameras)
    {
        auto *Actor = WeakActor.Get();
        if (!Actor || Owned(Actor))
            continue;
        const FAuthoringCamera *Source = nullptr;
        if (AuthoringState && AuthoringState->MultiCamera && Actor->GetWorld() == AuthoringState->World.Get() &&
            Actor->Tags.Contains(FName(ProducerTagPrefix + AuthoringState->Producer)))
            for (const auto &Tag : Actor->Tags)
                if (Tag.ToString().StartsWith(CameraTagPrefix))
                    Source = AuthoringState->Cameras.Find(Tag.ToString().RightChop(CameraTagPrefix.Len()));
        if (!Source || !Source->Definition || AuthoringState->Cameras.Num() >= 256)
        {
            Actor->GetWorld()->DestroyActor(Actor, false, false);
            if (AuthoringState)
                AuthoringState->Notice =
                    TEXT("Cannot duplicate this camera: a synced set with fewer than 256 cameras is required.");
            continue;
        }
        FAuthoringCamera Entry = *Source;
        const FString Id = TEXT("camera-") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
        Entry.Actor = Actor;
        Entry.Label += TEXT(" copy");
        Entry.HostPresent = false;
        Entry.Changed = true;
        Entry.Definition = MakeShared<FJsonObject>(*Source->Definition);
        Entry.Definition->SetStringField(TEXT("id"), Id);
        Entry.Definition->SetStringField(TEXT("viewId"),
                                         TEXT("view-") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
        Entry.Definition->SetStringField(TEXT("displayName"), Entry.Label);
        TagCamera(Actor, Id);
        Actor->SetActorLabel(TEXT("UE Shed — ") + Entry.Label, false);
        AuthoringState->Cameras.Add(Id, MoveTemp(Entry));
        ++AuthoringState->Sequence;
        AuthoringState->SaveRequested = false;
    }
    ImportedCameras.Reset();
    Observe();
    if (AuthoringState &&
        (!GEditor || GEditor->PlayWorld || !AuthoringState->Proxy.IsValid() || AuthoringState->Cameras.IsEmpty() ||
         AuthoringState->World.Get() != GEditor->GetEditorWorldContext().World() ||
         FPlatformTime::Seconds() > AuthoringState->Deadline))
        Shutdown();
    Observe();
    return true;
}
TSharedPtr<FJsonObject> FUEShedCameraAuthoringBridge::InspectSetup()
{
    return FUEShedCameraSetup::Inspect();
}
TSharedPtr<FJsonObject> FUEShedCameraAuthoringBridge::Execute(const TSharedPtr<FJsonObject> &Q)
{
    check(IsInGameThread());
    Tick(0);
    double Version = 0;
    if (!Number(Q, TEXT("version"), Version) || Version != 1)
        return Result(TEXT("invalid"), TEXT("Expected camera authoring version 1."));
    const FString Op = Str(Q, TEXT("operation")), Session = Str(Q, TEXT("sessionId"));
    if (Op == TEXT("setup_status")) return FUEShedCameraSetup::Inspect();
    if (Op == TEXT("setup_poll") || Op == TEXT("setup_create") || Op == TEXT("setup_release")) return FUEShedCameraSetup::Execute(Q);
    if (Op == TEXT("discover"))
    {
        auto R = Result(TEXT("available"));
        R->SetNumberField(TEXT("leaseSeconds"), 30);
        R->SetBoolField(TEXT("viewportCulling"), true);
        R->SetBoolField(TEXT("arrangementPanel"), true);
        R->SetBoolField(TEXT("multiCameraEditing"), true);
        R->SetBoolField(TEXT("nativeSetup"), true);
        return R;
    }
    if (!Identifier(Session))
        return Result(TEXT("invalid"), TEXT("A bounded ASCII session identifier is required."));
    if (Op == TEXT("attach"))
    {
        UWorld *W = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
        if (!W || GEditor->PlayWorld)
            return Result(TEXT("unavailable"), TEXT("Open an editor map outside Play or Simulate."));
        if (Str(Q, TEXT("mapPath")) != W->GetOutermost()->GetName() ||
            Str(Q, TEXT("projectName")) != FApp::GetProjectName())
            return Result(TEXT("stale"), TEXT("The editor project or map differs from the requested scope."));
        if (AuthoringState)
            return AuthoringState->Session == Session && AuthoringState->CameraId == Str(Q, TEXT("cameraId"))
                       ? Snapshot()
                       : Result(TEXT("busy"), TEXT("Detach the active camera first."));
        FVector L = FVector::ZeroVector;
        FRotator R = FRotator::ZeroRotator;
        double FOV = 0, Revision = 0;
        if (!Identifier(Str(Q, TEXT("cameraId"))) || !ReadPose(Child(Q, TEXT("pose")), L, R, FOV) ||
            !Number(Q, TEXT("revision"), Revision) || Revision < 0 || Revision > 9007199254740991.0 ||
            Revision != FMath::FloorToDouble(Revision))
            return Result(TEXT("invalid"), TEXT("A camera ID, revision, and finite perspective pose are required."));
        TMap<FString, FAuthoringCamera> Entries;
        if (Q->HasField(TEXT("cameras")))
        {
            if (!ReadCameras(Q, Entries) || !Entries.Contains(Str(Q, TEXT("cameraId"))))
                return Result(TEXT("invalid"),
                              TEXT("Provide 1–256 unique camera IDs, names and poses, including the active camera."));
        }
        else
        {
            FAuthoringCamera Entry;
            Entry.Label = Str(Q, TEXT("cameraId"));
            Entry.Location = L;
            Entry.Rotation = R;
            Entry.FOV = FOV;
            Entries.Add(Str(Q, TEXT("cameraId")), Entry);
        }
        if (!FUEShedCameraEditorOwnership::TryAcquire(Session))
            return Result(TEXT("busy"), TEXT("Capture or another tool owns the editor."));
        AuthoringState = MakeUnique<FAuthoringState>();
        AuthoringState->Session = Session;
        AuthoringState->World = W;
        AuthoringState->CameraId = Str(Q, TEXT("cameraId"));
        AuthoringState->Revision = static_cast<int64>(Revision);
        AuthoringState->MultiCamera = Q->HasField(TEXT("cameras"));
        if (!Materialize(MoveTemp(Entries)))
        {
            Shutdown();
            return Result(TEXT("unavailable"), TEXT("Could not create the temporary camera."));
        }
        AuthoringState->ObservedLocation = AuthoringState->Proxy->GetActorLocation();
        AuthoringState->ObservedRotation = AuthoringState->Proxy->GetActorRotation();
        AuthoringState->ObservedFOV = AuthoringState->Proxy->GetCameraComponent()->FieldOfView;
        for (FSelectionIterator It(*GEditor->GetSelectedActors()); It; ++It)
            if (auto *A = Cast<AActor>(*It))
                AuthoringState->Selection.Add(A);
        AuthoringState->Deadline = FPlatformTime::Seconds() + 30;
        return Snapshot();
    }
    if (!AuthoringState)
        return Result(TEXT("unavailable"), LastRecoveryMessage.IsEmpty()
                                               ? TEXT("Attach a camera; the previous lease may have expired.")
                                               : *LastRecoveryMessage);
    if (AuthoringState->Session != Session || AuthoringState->Producer != Str(Q, TEXT("producerId")))
        return Result(TEXT("stale"), TEXT("The session or editor producer changed. Inspect and reconnect."));
    AuthoringState->Deadline = FPlatformTime::Seconds() + 30;
    if (Op == TEXT("panel"))
    {
        const auto Panel = Child(Q, TEXT("state")), Arrangement = Child(Panel, TEXT("arrangement"));
        double Revision = 0;
        if (!Panel || !Arrangement || Str(Arrangement, TEXT("id")) != Session ||
            Str(Arrangement, TEXT("mapPath")) != AuthoringState->World->GetOutermost()->GetName() ||
            !Number(Arrangement, TEXT("revision"), Revision) || Revision != AuthoringState->Revision ||
            Str(Panel, TEXT("activeCameraId")) != AuthoringState->CameraId)
            return Result(TEXT("stale"), TEXT("Panel state must match this arrangement, revision, and active camera."));
        const auto Policy = Child(Panel, TEXT("renderPolicy")), Exposure = Child(Policy, TEXT("exposure"));
        TOptional<float> FixedEV;
        if (Str(Exposure, TEXT("mode")) == TEXT("fixed_ev100"))
        {
            double EV = 0;
            if (!Number(Exposure, TEXT("ev100"), EV) || EV < -20 || EV > 30)
                return Result(TEXT("invalid"), TEXT("EV100 must be between -20 and 30."));
            FixedEV = EV;
        }
        for (auto *Camera : Cameras())
        {
            auto *Component = Camera->GetCameraComponent();
            UEShedApplyCameraExposure(Component->PostProcessSettings, FixedEV);
            Component->PostProcessBlendWeight = FixedEV.IsSet() ? 1.f : 0.f;
        }
        AuthoringState->Panel = Panel;
        if (AuthoringState->Event && Str(Q, TEXT("acknowledgeEvent")) == Str(AuthoringState->Event, TEXT("id")))
            AuthoringState->Event.Reset();
        return Snapshot();
    }
    if (Op == TEXT("enqueue"))
    {
        Observe();
        if (!AuthoringState->Panel)
            return Result(TEXT("unavailable"), TEXT("Connect the arrangement host before editing its controls."));
        if (AuthoringState->Event || AuthoringState->Sequence != AuthoringState->Acknowledged)
            return Result(TEXT("busy"),
                          TEXT("Waiting for the previous edit to synchronize. Camera movement remains native."));
        const auto Action = Child(Q, TEXT("action"));
        if (!Action)
            return Result(TEXT("invalid"), TEXT("An explicit scoped panel action is required."));
        AuthoringState->Event = Obj();
        AuthoringState->Event->SetObjectField(TEXT("action"), Action);
        AuthoringState->Event->SetNumberField(TEXT("expectedRevision"), AuthoringState->Revision);
        AuthoringState->Event->SetStringField(TEXT("id"), TEXT("panel-") + AuthoringState->Producer + TEXT("-") +
                                                              LexToString(++AuthoringState->EventSequence));
        return Snapshot();
    }
    if (Op == TEXT("cancel_event"))
    {
        AuthoringState->Event.Reset();
        return Snapshot();
    }
    if (Op == TEXT("selection"))
    {
        TArray<TSharedPtr<FJsonValue>> Actors;
        for (FSelectionIterator It(*GEditor->GetSelectedActors()); It; ++It)
            if (auto *Actor = Cast<AActor>(*It))
            {
                if (Owned(Actor))
                    continue;
                if (Actor->GetWorld() != AuthoringState->World.Get() ||
                    !Actor->GetPathName().StartsWith(TEXT("/Game/")))
                    return Result(TEXT("invalid"), TEXT("Select actors in the attached editor map."));
                Actors.Add(MakeShared<FJsonValueObject>(UEShedCameraActorEntry(Actor)));
                if (Actors.Num() > 256)
                    return Result(TEXT("invalid"),
                                  TEXT("Selection exceeds 256 actors. Nothing was imported; select a smaller batch."));
            }
        auto Lists = Obj();
        Lists->SetArrayField(TEXT("hide"), Actors);
        Lists->SetArrayField(TEXT("protect"), {});
        const auto Resolved = UEShedResolveCameraVisibility(AuthoringState->World.Get(), Lists);
        auto R = Result(TEXT("selection"), *Resolved.Message);
        R->SetArrayField(TEXT("actors"), Actors);
        R->SetArrayField(TEXT("diagnostics"), Resolved.Diagnostics);
        return R;
    }
    if (Op == TEXT("resolve_visibility") || Op == TEXT("preview_visibility"))
    {
        if (!Child(Q, TEXT("actors")))
            return Result(TEXT("invalid"), TEXT("Explicit hide/protect actor lists are required."));
        const auto Resolved = UEShedResolveCameraVisibility(AuthoringState->World.Get(), Child(Q, TEXT("actors")));
        if (Op == TEXT("preview_visibility"))
        {
            if (!AuthoringState->Visibility)
                AuthoringState->Visibility = FSceneViewExtensions::NewExtension<FUEShedCameraVisibility>();
            bool Enabled = false;
            Q->TryGetBoolField(TEXT("enabled"), Enabled);
            AuthoringState->Visibility->Enabled = false;
            if (Enabled && Resolved.Valid && AuthoringState->Viewport &&
                GEditor->GetLevelViewportClients().Contains(AuthoringState->Viewport))
            {
                AuthoringState->Visibility->Target = AuthoringState->Viewport->ViewState.GetReference();
                AuthoringState->Visibility->Components = Resolved.Components;
                AuthoringState->Visibility->Enabled = true;
                AuthoringState->Viewport->Invalidate();
            }
        }
        auto R = Result(TEXT("visibility"), *Resolved.Message);
        R->SetBoolField(TEXT("valid"), Resolved.Valid);
        R->SetArrayField(TEXT("diagnostics"), Resolved.Diagnostics);
        return R;
    }
    if (Op == TEXT("viewport_pose"))
    {
        auto *V = GCurrentLevelEditingViewportClient;
        if (!V || !V->IsPerspective())
            return Result(TEXT("unavailable"), TEXT("Choose a perspective Level Editor viewport."));
        auto R = Result(TEXT("viewport_pose")), P = Obj(), L = Obj(), Rotation = Obj();
        const auto Location = V->GetViewLocation();
        const auto Angles = V->GetViewRotation();
        L->SetNumberField(TEXT("x"), Location.X);
        L->SetNumberField(TEXT("y"), Location.Y);
        L->SetNumberField(TEXT("z"), Location.Z);
        Rotation->SetNumberField(TEXT("pitch"), Angles.Pitch);
        Rotation->SetNumberField(TEXT("yaw"), Angles.Yaw);
        Rotation->SetNumberField(TEXT("roll"), Angles.Roll);
        P->SetObjectField(TEXT("location"), L);
        P->SetObjectField(TEXT("rotation"), Rotation);
        P->SetNumberField(TEXT("fieldOfViewDegrees"), V->ViewFOV);
        P->SetStringField(TEXT("projection"), TEXT("perspective"));
        P->SetStringField(TEXT("aspectRatio"), TEXT("16:9"));
        R->SetObjectField(TEXT("pose"), P);
        return R;
    }
    if (Op == TEXT("activate"))
    {
        double Expected = 0, Sequence = 0, FOV = 0;
        FVector L = FVector::ZeroVector;
        FRotator R = FRotator::ZeroRotator;
        Observe();
        if (!Number(Q, TEXT("expectedRevision"), Expected) || !Number(Q, TEXT("sequence"), Sequence) ||
            Expected != AuthoringState->Revision || Sequence != AuthoringState->Sequence ||
            AuthoringState->Sequence != AuthoringState->Acknowledged)
            return Result(TEXT("stale"), TEXT("Synchronize the active camera before switching."));
        if (!Identifier(Str(Q, TEXT("cameraId"))) || !ReadPose(Child(Q, TEXT("pose")), L, R, FOV))
            return Result(TEXT("invalid"), TEXT("A valid camera identity and pose are required."));
        if (AuthoringState->MultiCamera && !Camera(Str(Q, TEXT("cameraId"))))
            return Result(TEXT("invalid"), TEXT("The camera is outside this arrangement."));
        if (AuthoringState->Visibility)
            AuthoringState->Visibility->Enabled = false;
        if (!AuthoringState->MultiCamera)
        {
            auto Entry = AuthoringState->Cameras.FindChecked(AuthoringState->CameraId);
            Entry.Label = Str(Q, TEXT("cameraId"));
            Entry.Location = L;
            Entry.Rotation = R;
            Entry.FOV = FOV;
            Entry.Actor->SetActorLocationAndRotation(L, R);
            Entry.Actor->GetCameraComponent()->SetFieldOfView(FOV);
            AuthoringState->Cameras.Reset();
            AuthoringState->Cameras.Add(Entry.Label, Entry);
        }
        AuthoringState->CameraId = Str(Q, TEXT("cameraId"));
        ActiveObservation();
        GEditor->SelectNone(false, true, false);
        GEditor->SelectActor(AuthoringState->Proxy.Get(), true, true);
        if (AuthoringState->Viewport && GEditor->GetLevelViewportClients().Contains(AuthoringState->Viewport))
        {
            AuthoringState->Viewport->SetActorLock(AuthoringState->Proxy.Get());
            AuthoringState->Viewport->UpdateViewForLockedActor();
            AuthoringState->Viewport->Invalidate();
        }
        return Snapshot();
    }
    if (Op == TEXT("inspect"))
        return Snapshot();
    if (Op == TEXT("save"))
    {
        Observe();
        AuthoringState->Notice.Reset();
        AuthoringState->SaveRequested = true;
        ++AuthoringState->Sequence;
        return Snapshot();
    }
    if (Op == TEXT("detach"))
    {
        Shutdown();
        return Result(TEXT("detached"));
    }
    if (Op == TEXT("eject"))
    {
        Eject();
        return Snapshot();
    }
    if (Op == TEXT("select_cameras"))
    {
        const TArray<TSharedPtr<FJsonValue>> *Ids;
        if (!Q->TryGetArrayField(TEXT("cameraIds"), Ids) || Ids->Num() > 256)
            return Result(TEXT("invalid"), TEXT("Select up to 256 cameras in this arrangement."));
        TSet<FString> Unique;
        for (const auto &Id : *Ids)
        {
            FString Value;
            if (!Id->TryGetString(Value) || !Camera(Value) || Unique.Contains(Value))
                return Result(TEXT("invalid"), TEXT("Select unique cameras in this arrangement."));
            Unique.Add(Value);
        }
        Eject();
        GEditor->SelectNone(false, true, false);
        for (const auto &Id : Unique)
            GEditor->SelectActor(Camera(Id), true, false);
        GEditor->NoteSelectionChange();
        OnEditorFocusRequested().Broadcast();
        return Snapshot();
    }
    if (Op == TEXT("select") || Op == TEXT("pilot") || Op == TEXT("pilot_camera"))
    {
        const FString TargetId = Op == TEXT("pilot_camera") ? Str(Q, TEXT("cameraId")) : AuthoringState->CameraId;
        if (!Camera(TargetId))
            return Result(TEXT("invalid"), TEXT("The camera is outside this arrangement."));
        if ((Op == TEXT("pilot") || Op == TEXT("pilot_camera")) && !AuthoringState->Viewport)
        {
            auto *V = GCurrentLevelEditingViewportClient;
            if (!V || !V->Viewport || !V->IsPerspective() || V->IsAnyActorLocked())
                return Result(TEXT("busy"), TEXT("Choose an unlocked perspective Level Editor viewport."));
            AuthoringState->Viewport = V;
            AuthoringState->ViewLocation = V->GetViewLocation();
            AuthoringState->ViewRotation = V->GetViewRotation();
            AuthoringState->ViewFOV = V->ViewFOV;
            AuthoringState->LockedCamera = V->bLockedCameraView;
            V->SetActorLock(Camera(TargetId));
            V->bLockedCameraView = true;
            V->MoveCameraToLockedActor();
            V->Invalidate();
        }
        if (Op == TEXT("pilot_camera"))
        {
            if (AuthoringState->CameraId != TargetId)
                ++AuthoringState->Sequence;
            AuthoringState->CameraId = TargetId;
            ActiveObservation();
            if (AuthoringState->Visibility)
                AuthoringState->Visibility->Enabled = false;
            auto *V = AuthoringState->Viewport;
            if (V && GEditor->GetLevelViewportClients().Contains(V))
            {
                V->SetActorLock(Camera(TargetId));
                V->bLockedCameraView = true;
                V->MoveCameraToLockedActor();
                V->Invalidate();
            }
        }
        GEditor->SelectNone(false, true, false);
        GEditor->SelectActor(AuthoringState->Proxy.Get(), true, true);
        OnEditorFocusRequested().Broadcast();
        return Snapshot();
    }
    if (Op == TEXT("apply"))
    {
        double Expected = 0, Sequence = 0, Revision = 0, FOV = 0;
        FVector L = FVector::ZeroVector;
        FRotator R = FRotator::ZeroRotator;
        if (!Number(Q, TEXT("expectedRevision"), Expected) || !Number(Q, TEXT("sequence"), Sequence) ||
            !Number(Q, TEXT("revision"), Revision) || Revision < Expected || Revision > 9007199254740991.0 ||
            Revision != FMath::FloorToDouble(Revision) || !ReadPose(Child(Q, TEXT("pose")), L, R, FOV))
            return Result(TEXT("invalid"), TEXT("Expected revision, observed sequence, and valid pose are required."));
        Observe();
        if (Expected != AuthoringState->Revision || Sequence != AuthoringState->Sequence)
            return Result(TEXT("stale"),
                          TEXT("A newer native edit or host revision exists; reconcile before applying."));
        TMap<FString, FAuthoringCamera> Entries;
        const FString ActiveId = Q->HasField(TEXT("cameraId")) ? Str(Q, TEXT("cameraId")) : AuthoringState->CameraId;
        if (AuthoringState->MultiCamera)
        {
            if (!ReadCameras(Q, Entries) || !Entries.Contains(ActiveId))
                return Result(TEXT("invalid"),
                              TEXT("Apply must contain the complete camera set and its active camera."));
        }
        else
        {
            auto Entry = AuthoringState->Cameras.FindChecked(AuthoringState->CameraId);
            Entry.Location = L;
            Entry.Rotation = R;
            Entry.FOV = FOV;
            Entry.Changed = false;
            Entries.Add(AuthoringState->CameraId, Entry);
        }
        const FString PreviousId = AuthoringState->CameraId;
        AuthoringState->CameraId = ActiveId;
        if (!Materialize(MoveTemp(Entries)))
        {
            AuthoringState->CameraId = PreviousId;
            return Result(TEXT("unavailable"),
                          TEXT("Could not materialize the camera set. Native changes remain pending."));
        }
        AuthoringState->Revision = static_cast<int64>(Revision);
        AuthoringState->Acknowledged = AuthoringState->Sequence;
        AuthoringState->SaveRequested = false;
        if (PreviousId != ActiveId)
        {
            GEditor->SelectNone(false, true, false);
            GEditor->SelectActor(AuthoringState->Proxy.Get(), true, true);
        }
        if (AuthoringState->Viewport && GEditor->GetLevelViewportClients().Contains(AuthoringState->Viewport))
        {
            AuthoringState->Viewport->SetActorLock(AuthoringState->Proxy.Get());
            AuthoringState->Viewport->UpdateViewForLockedActor();
            AuthoringState->Viewport->Invalidate();
        }
        return Snapshot();
    }
    if (Op == TEXT("edit"))
    {
        double Expected = 0, Sequence = 0, FOV = 0;
        FVector L = FVector::ZeroVector;
        FRotator R = FRotator::ZeroRotator;
        if (!Number(Q, TEXT("expectedRevision"), Expected) || !Number(Q, TEXT("sequence"), Sequence) ||
            !ReadPose(Child(Q, TEXT("pose")), L, R, FOV))
            return Result(TEXT("invalid"),
                          TEXT("An editor gesture requires the observed revision, sequence, and pose."));
        Observe();
        if (Expected != AuthoringState->Revision || Sequence != AuthoringState->Sequence)
            return Result(TEXT("stale"), TEXT("Refresh before editing this camera."));
        FScopedTransaction Transaction(NSLOCTEXT("UEShed", "EditCamera", "Edit UE Shed camera"));
        AuthoringState->Proxy->Modify();
        AuthoringState->Proxy->GetCameraComponent()->Modify();
        AuthoringState->Proxy->SetActorLocationAndRotation(L, R);
        AuthoringState->Proxy->GetCameraComponent()->SetFieldOfView(FOV);
        AuthoringState->Proxy->PostEditMove(true);
        return Snapshot();
    }
    return Result(TEXT("invalid"), TEXT("Unknown authoring operation."));
}
void UUEShedCameraAuthoringBridgeLibrary::ExecuteCameraAuthoring(const FString &RequestJson, FString &ResultJson)
{
    TSharedPtr<FJsonObject> Q;
    if (RequestJson.Len() <= 4 * 1024 * 1024)
        FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RequestJson), Q);
    FJsonSerializer::Serialize(FUEShedCameraAuthoringBridge::Execute(Q).ToSharedRef(),
                               TJsonWriterFactory<>::Create(&ResultJson));
}
class FUEShedCameraAuthoringBridgeModule final : public IModuleInterface
{
    FTSTicker::FDelegateHandle Handle;
    FDelegateHandle MapHandle, PlayHandle;

  public:
    void StartupModule() override
    {
        Handle =
            FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateStatic(&FUEShedCameraAuthoringBridge::Tick));
        MapHandle = FEditorDelegates::OnMapLoad.AddLambda(
            [](const FString &, FCanLoadMap &) { FUEShedCameraAuthoringBridge::Shutdown(); });
        PlayHandle = FEditorDelegates::PreBeginPIE.AddLambda([](bool) { FUEShedCameraAuthoringBridge::Shutdown(); });
    }
    void ShutdownModule() override
    {
        FEditorDelegates::OnMapLoad.Remove(MapHandle);
        FEditorDelegates::PreBeginPIE.Remove(PlayHandle);
        FTSTicker::GetCoreTicker().RemoveTicker(Handle);
        FUEShedCameraAuthoringBridge::Shutdown();
    }
};
IMPLEMENT_MODULE(FUEShedCameraAuthoringBridgeModule, UEShedCameraAuthoringBridge)
