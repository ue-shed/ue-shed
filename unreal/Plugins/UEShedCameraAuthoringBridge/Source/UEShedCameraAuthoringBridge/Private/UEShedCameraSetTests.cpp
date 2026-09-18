#if WITH_DEV_AUTOMATION_TESTS
#include "Camera/CameraComponent.h"
#include "Editor.h"
#include "Engine/Selection.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FileHelpers.h"
#include "LevelEditorViewport.h"
#include "Misc/App.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonSerializer.h"
#include "Subsystems/EditorActorSubsystem.h"
#include "UEShedCameraAuthoringBridge.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraSetTest, "UEShed.Cameras.Authoring.FullSetEditing",
                                 EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FUEShedCameraSetTest::RunTest(const FString &Parameters)
{
    auto *World = GEditor->GetEditorWorldContext().World();
    auto *Viewport = GCurrentLevelEditingViewportClient;
    if (!World || !Viewport)
    {
        AddError(TEXT("An editor viewport is required."));
        return false;
    }
    const bool Dirty = World->GetOutermost()->IsDirty();
    const auto OriginalView = Viewport->GetViewLocation();
    TSharedPtr<FJsonObject> Q;
    FJsonSerializer::Deserialize(
        TJsonReaderFactory<>::Create(TEXT(
            R"({"version":1,"operation":"attach","sessionId":"full-set","cameraId":"camera-0","revision":0,"pose":{"projection":"perspective","aspectRatio":"16:9","fieldOfViewDegrees":60,"location":{"x":100,"y":200,"z":500},"rotation":{"pitch":-20,"yaw":0,"roll":0}}})")),
        Q);
    Q->SetStringField(TEXT("projectName"), FApp::GetProjectName());
    Q->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
    TArray<TSharedPtr<FJsonValue>> Cameras;
    for (int32 I = 0; I < 16; ++I)
    {
        auto C = MakeShared<FJsonObject>();
        C->SetStringField(TEXT("id"), FString::Printf(TEXT("camera-%d"), I));
        C->SetStringField(TEXT("displayName"), FString::Printf(TEXT("Orbit %d"), I + 1));
        C->SetObjectField(TEXT("pose"), Q->GetObjectField(TEXT("pose")));
        auto Definition = MakeShared<FJsonObject>();
        Definition->SetStringField(TEXT("id"), C->GetStringField(TEXT("id")));
        Definition->SetStringField(TEXT("displayName"), C->GetStringField(TEXT("displayName")));
        Definition->SetStringField(TEXT("viewId"), FString::Printf(TEXT("view-%d"), I));
        Definition->SetNumberField(TEXT("yawDegrees"), I * 22.5);
        Definition->SetObjectField(TEXT("overrides"), MakeShared<FJsonObject>());
        C->SetObjectField(TEXT("definition"), Definition);
        Cameras.Add(MakeShared<FJsonValueObject>(C));
    }
    Q->SetArrayField(TEXT("cameras"), Cameras);
    auto R = FUEShedCameraAuthoringBridge::Execute(Q);
    ON_SCOPE_EXIT
    {
        FUEShedCameraAuthoringBridge::Shutdown();
    };
    if (!TestEqual(TEXT("Attach whole set"), R->GetStringField(TEXT("status")), FString(TEXT("ready"))))
        return false;
    TestEqual(TEXT("All sixteen native actors spawned"), FUEShedCameraAuthoringBridge::Cameras().Num(), 16);
    Q->SetStringField(TEXT("producerId"), R->GetStringField(TEXT("producerId")));
    auto *First = FUEShedCameraAuthoringBridge::Camera(TEXT("camera-0"));
    auto *Other = FUEShedCameraAuthoringBridge::Camera(TEXT("camera-7"));
    for (auto *Camera : FUEShedCameraAuthoringBridge::Cameras())
    {
        TestTrue(TEXT("Each camera is transient and transactional"),
                 Camera->HasAllFlags(RF_Transient | RF_Transactional));
        TestTrue(TEXT("Each lens is transient"),
                 Camera->GetCameraComponent()->HasAllFlags(RF_Transient | RF_Transactional));
    }
    Q->SetStringField(TEXT("operation"), TEXT("select_cameras"));
    Q->SetArrayField(TEXT("cameraIds"),
                     {MakeShared<FJsonValueString>(TEXT("camera-0")), MakeShared<FJsonValueString>(TEXT("camera-7"))});
    R = FUEShedCameraAuthoringBridge::Execute(Q);
    TestTrue(TEXT("Real editor multiselection"), First->IsSelected() && Other->IsSelected());
    TestEqual(TEXT("Native selection reported"), R->GetArrayField(TEXT("selectedCameraIds")).Num(), 2);
    {
        FScopedTransaction Transaction(NSLOCTEXT("UEShed", "MoveSet", "Move camera set"));
        First->Modify();
        Other->Modify();
        Other->GetCameraComponent()->Modify();
        First->AddActorWorldOffset(FVector(25, 0, 0));
        Other->AddActorWorldOffset(FVector(0, 50, 0));
        Other->GetCameraComponent()->SetFieldOfView(35);
        First->PostEditMove(true);
        Other->PostEditMove(true);
    }
    Q->SetStringField(TEXT("operation"), TEXT("inspect"));
    R = FUEShedCameraAuthoringBridge::Execute(Q);
    TestEqual(TEXT("Active and inactive edits included in one batch"), R->GetArrayField(TEXT("edits")).Num(), 2);
    const double OldSequence = R->GetNumberField(TEXT("sequence"));
    GEditor->UndoTransaction();
    R = FUEShedCameraAuthoringBridge::Execute(Q);
    TestEqual(TEXT("Undo restores inactive camera lens"), Other->GetCameraComponent()->FieldOfView, 60.f);
    TestTrue(TEXT("Undo advances native sequence"), R->GetNumberField(TEXT("sequence")) > OldSequence);
    GEditor->RedoTransaction();
    R = FUEShedCameraAuthoringBridge::Execute(Q);
    TestEqual(TEXT("Redo restores inactive camera lens"), Other->GetCameraComponent()->FieldOfView, 35.f);
    Q->SetStringField(TEXT("operation"), TEXT("apply"));
    Q->SetNumberField(TEXT("expectedRevision"), 0);
    Q->SetNumberField(TEXT("revision"), 1);
    Q->SetNumberField(TEXT("sequence"), OldSequence);
    Q->SetArrayField(TEXT("cameras"), R->GetArrayField(TEXT("cameras")));
    TestEqual(TEXT("Stale set acknowledgement rejected"),
              FUEShedCameraAuthoringBridge::Execute(Q)->GetStringField(TEXT("status")), FString(TEXT("stale")));
    Q->SetNumberField(TEXT("sequence"), R->GetNumberField(TEXT("sequence")));
    R = FUEShedCameraAuthoringBridge::Execute(Q);
    TestFalse(TEXT("Acknowledged set does not echo"), R->GetBoolField(TEXT("pending")));
    TestTrue(TEXT("Host reconciliation preserves actor identities"),
             Other == FUEShedCameraAuthoringBridge::Camera(TEXT("camera-7")));
    Q->SetStringField(TEXT("operation"), TEXT("pilot_camera"));
    Q->SetStringField(TEXT("cameraId"), TEXT("camera-7"));
    R = FUEShedCameraAuthoringBridge::Execute(Q);
    TestTrue(TEXT("Pilot chosen camera"), Viewport->GetActorLock().GetLockedActor() == Other);
    Q->SetStringField(TEXT("cameraId"), TEXT("camera-0"));
    R = FUEShedCameraAuthoringBridge::Execute(Q);
    TestTrue(TEXT("Switch pilot without replacing either actor"),
             Viewport->GetActorLock().GetLockedActor() == First &&
                 Other == FUEShedCameraAuthoringBridge::Camera(TEXT("camera-7")));
    Q->SetStringField(TEXT("operation"), TEXT("eject"));
    FUEShedCameraAuthoringBridge::Execute(Q);
    TestEqual(TEXT("Eject restores original editor view"), Viewport->GetViewLocation(), OriginalView);
    auto Acknowledge = [&]() {
        R = FUEShedCameraAuthoringBridge::InspectActive();
        Q->SetStringField(TEXT("operation"), TEXT("apply"));
        Q->SetStringField(TEXT("cameraId"), R->GetStringField(TEXT("cameraId")));
        Q->SetNumberField(TEXT("expectedRevision"), R->GetNumberField(TEXT("revision")));
        Q->SetNumberField(TEXT("revision"), R->GetNumberField(TEXT("revision")) + 1);
        Q->SetNumberField(TEXT("sequence"), R->GetNumberField(TEXT("sequence")));
        Q->SetArrayField(TEXT("cameras"), R->GetArrayField(TEXT("cameras")));
        Q->SetObjectField(TEXT("pose"), R->GetObjectField(TEXT("pose")));
        R = FUEShedCameraAuthoringBridge::Execute(Q);
        TestFalse(TEXT("Membership changes acknowledged"), R->GetBoolField(TEXT("pending")));
    };
    auto *Actors = GEditor->GetEditorSubsystem<UEditorActorSubsystem>();
    const auto Copies = Actors->DuplicateActors({Other}, World, FVector(100, 0, 0));
    if (!TestEqual(TEXT("Native duplicate created"), Copies.Num(), 1))
        return false;
    R = FUEShedCameraAuthoringBridge::InspectActive();
    if (!TestEqual(TEXT("Native duplicate adopted into set"), R->GetArrayField(TEXT("added")).Num(), 1))
        return false;
    const FString CopyId = R->GetArrayField(TEXT("added"))[0]->AsObject()->GetStringField(TEXT("id"));
    TestEqual(TEXT("Set grows after native duplicate"), FUEShedCameraAuthoringBridge::Cameras().Num(), 17);
    TestTrue(TEXT("Duplicate is also transient"), Copies[0]->HasAnyFlags(RF_Transient));
    Acknowledge();
    // Delete with Unreal's real editor operation and verify Undo after the deletion is acknowledged.
    TestTrue(TEXT("Native delete"), Actors->DestroyActor(Copies[0]));
    R = FUEShedCameraAuthoringBridge::InspectActive();
    TestEqual(TEXT("Deleted camera is a pending membership change"), R->GetArrayField(TEXT("removed")).Num(), 1);
    Acknowledge();
    TestEqual(TEXT("Deleting one camera keeps editing session"), FUEShedCameraAuthoringBridge::Cameras().Num(), 16);
    GEditor->UndoTransaction();
    R = FUEShedCameraAuthoringBridge::InspectActive();
    TestNotNull(TEXT("Undo restores original camera identity"), FUEShedCameraAuthoringBridge::Camera(CopyId));
    TestEqual(TEXT("Undo is synced as restoration"), R->GetArrayField(TEXT("added")).Num(), 1);
    Acknowledge();
    GEditor->RedoTransaction();
    R = FUEShedCameraAuthoringBridge::InspectActive();
    TestEqual(TEXT("Redo deletion is synced"), R->GetArrayField(TEXT("removed")).Num(), 1);
    Acknowledge();
    TestEqual(TEXT("Full-set editing preserves map dirt"), World->GetOutermost()->IsDirty(), Dirty);
    const FString OriginalMap = World->GetOutermost()->GetName();
    const FString SavedMap = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("CameraSetCleanMap.umap"));
    TestTrue(TEXT("Save with all sixteen camera actors"), FEditorFileUtils::SaveMap(World, SavedMap));
    TestTrue(TEXT("Reload saved map"), FEditorFileUtils::LoadMap(SavedMap, false, false));
    int32 Count = 0;
    for (TActorIterator<AUEShedAuthoringCamera> It(GEditor->GetEditorWorldContext().World()); It; ++It)
        ++Count;
    TestEqual(TEXT("No camera is stored in level data"), Count, 0);
    TestEqual(TEXT("Map load releases complete set"), FUEShedCameraAuthoringBridge::Cameras().Num(), 0);
    TestTrue(TEXT("Restore fixture"), FEditorFileUtils::LoadMap(OriginalMap, false, false));
    return true;
}
#endif
