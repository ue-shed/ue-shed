#include "UEShedCameraAuthoringBridge.h"
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
struct FAuthoringState
{
    FString Session, CameraId, Producer = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
    TWeakObjectPtr<AUEShedAuthoringCamera> Proxy;
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
void Observe()
{
    if (!AuthoringState || !AuthoringState->Proxy.IsValid())
        return;
    auto *C = AuthoringState->Proxy.Get();
    const auto L = C->GetActorLocation();
    const auto R = C->GetActorRotation();
    const float F = C->GetCameraComponent()->FieldOfView;
    if (!L.Equals(AuthoringState->ObservedLocation, 0.0001) || !R.Equals(AuthoringState->ObservedRotation, 0.0001) ||
        !FMath::IsNearlyEqual(F, AuthoringState->ObservedFOV, 0.0001f))
    {
        if (AuthoringState->SaveRequested)
        {
            AuthoringState->SaveRequested = false;
            AuthoringState->Notice = TEXT("Camera changed after Save; review and Save again.");
        }
        AuthoringState->ObservedLocation = L;
        AuthoringState->ObservedRotation = R;
        AuthoringState->ObservedFOV = F;
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
    if (V->GetActorLock().GetLockedActor() == AuthoringState->Proxy.Get())
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
    GetCameraComponent()->SetFlags(RF_Transient | RF_Transactional);
    GetCameraComponent()->SetAspectRatio(16.f / 9.f);
}
AUEShedAuthoringCamera *FUEShedCameraAuthoringBridge::Camera()
{
    return AuthoringState ? AuthoringState->Proxy.Get() : nullptr;
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
    if (GEditor && AuthoringState->Proxy.IsValid())
    {
        const bool Selected = AuthoringState->Proxy->IsSelected();
        if (Selected)
        {
            GEditor->SelectNone(false, true, false);
            for (const auto &A : AuthoringState->Selection)
                if (A.IsValid())
                    GEditor->SelectActor(A.Get(), true, false);
            GEditor->NoteSelectionChange();
        }
        if (AuthoringState->World.IsValid())
            AuthoringState->World->DestroyActor(AuthoringState->Proxy.Get(), false, false);
    }
    FUEShedCameraEditorOwnership::Release(AuthoringState->Session);
    AuthoringState.Reset();
}
bool FUEShedCameraAuthoringBridge::Tick(float DeltaSeconds)
{
    if (AuthoringState && (!GEditor || GEditor->PlayWorld || !AuthoringState->Proxy.IsValid() ||
                           AuthoringState->World.Get() != GEditor->GetEditorWorldContext().World() ||
                           FPlatformTime::Seconds() > AuthoringState->Deadline))
        Shutdown();
    Observe();
    return true;
}
TSharedPtr<FJsonObject> FUEShedCameraAuthoringBridge::Execute(const TSharedPtr<FJsonObject> &Q)
{
    check(IsInGameThread());
    Tick(0);
    double Version = 0;
    if (!Number(Q, TEXT("version"), Version) || Version != 1)
        return Result(TEXT("invalid"), TEXT("Expected camera authoring version 1."));
    const FString Op = Str(Q, TEXT("operation")), Session = Str(Q, TEXT("sessionId"));
    if (Op == TEXT("discover"))
    {
        auto R = Result(TEXT("available"));
        R->SetNumberField(TEXT("leaseSeconds"), 30);
        R->SetBoolField(TEXT("viewportCulling"), true);
        R->SetBoolField(TEXT("arrangementPanel"), true);
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
        if (!FUEShedCameraEditorOwnership::TryAcquire(Session))
            return Result(TEXT("busy"), TEXT("Capture or another tool owns the editor."));
        AuthoringState = MakeUnique<FAuthoringState>();
        AuthoringState->Session = Session;
        AuthoringState->World = W;
        AuthoringState->CameraId = Str(Q, TEXT("cameraId"));
        AuthoringState->Revision = static_cast<int64>(Revision);
        FActorSpawnParameters Params;
        Params.ObjectFlags = RF_Transient | RF_Transactional;
        Params.bTemporaryEditorActor = true;
        Params.bCreateActorPackage = false;
        auto *C = W->SpawnActor<AUEShedAuthoringCamera>(L, R, Params);
        if (!C)
        {
            Shutdown();
            return Result(TEXT("unavailable"), TEXT("Could not create the temporary camera."));
        }
        AuthoringState->Proxy = C;
        C->SetActorLabel(TEXT("UE Shed — ") + AuthoringState->CameraId, false);
        C->GetCameraComponent()->SetFieldOfView(FOV);
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
                if (Actor == AuthoringState->Proxy.Get())
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
        if (AuthoringState->Visibility)
            AuthoringState->Visibility->Enabled = false;
        AuthoringState->CameraId = Str(Q, TEXT("cameraId"));
        AuthoringState->Proxy->SetActorLabel(TEXT("UE Shed — ") + AuthoringState->CameraId, false);
        AuthoringState->Proxy->SetActorLocationAndRotation(L, R);
        AuthoringState->Proxy->GetCameraComponent()->SetFieldOfView(FOV);
        AuthoringState->ObservedLocation = AuthoringState->Proxy->GetActorLocation();
        AuthoringState->ObservedRotation = AuthoringState->Proxy->GetActorRotation();
        AuthoringState->ObservedFOV = AuthoringState->Proxy->GetCameraComponent()->FieldOfView;
        if (AuthoringState->Viewport && GEditor->GetLevelViewportClients().Contains(AuthoringState->Viewport))
        {
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
    if (Op == TEXT("select") || Op == TEXT("pilot"))
    {
        if (Op == TEXT("pilot") && !AuthoringState->Viewport)
        {
            auto *V = GCurrentLevelEditingViewportClient;
            if (!V || !V->Viewport || !V->IsPerspective() || V->IsAnyActorLocked())
                return Result(TEXT("busy"), TEXT("Choose an unlocked perspective Level Editor viewport."));
            AuthoringState->Viewport = V;
            AuthoringState->ViewLocation = V->GetViewLocation();
            AuthoringState->ViewRotation = V->GetViewRotation();
            AuthoringState->ViewFOV = V->ViewFOV;
            AuthoringState->LockedCamera = V->bLockedCameraView;
            V->SetActorLock(AuthoringState->Proxy.Get());
            V->bLockedCameraView = true;
            V->MoveCameraToLockedActor();
            V->Invalidate();
        }
        GEditor->SelectNone(false, true, false);
        GEditor->SelectActor(AuthoringState->Proxy.Get(), true, true);
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
        AuthoringState->Proxy->SetActorLocationAndRotation(L, R);
        AuthoringState->Proxy->GetCameraComponent()->SetFieldOfView(FOV);
        AuthoringState->ObservedLocation = AuthoringState->Proxy->GetActorLocation();
        AuthoringState->ObservedRotation = AuthoringState->Proxy->GetActorRotation();
        AuthoringState->ObservedFOV = AuthoringState->Proxy->GetCameraComponent()->FieldOfView;
        AuthoringState->Revision = static_cast<int64>(Revision);
        AuthoringState->Acknowledged = AuthoringState->Sequence;
        AuthoringState->SaveRequested = false;
        if (AuthoringState->Viewport && GEditor->GetLevelViewportClients().Contains(AuthoringState->Viewport))
            AuthoringState->Viewport->Invalidate();
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
