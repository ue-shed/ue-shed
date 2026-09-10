#if WITH_DEV_AUTOMATION_TESTS
#include "UEShedCameraAuthoringBridge.h"
#include "Camera/CameraComponent.h"
#include "Editor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FileHelpers.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "LevelEditorViewport.h"
#include "Misc/App.h"
#include "Misc/AutomationTest.h"
#include "Misc/ScopeExit.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedCameraEditorOwnership.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraAuthoringTest, "UEShed.Cameras.Authoring.NativeLifecycle",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FUEShedCameraAuthoringTest::RunTest(const FString& Parameters)
{
	auto* W = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	auto* V = GCurrentLevelEditingViewportClient;
	if (!W || !V || !V->Viewport) { AddError(TEXT("A rendering editor fixture is required.")); return false; }
	const bool Dirty = W->GetOutermost()->IsDirty();
	const auto Location = V->GetViewLocation(); const auto Rotation = V->GetViewRotation();
	ON_SCOPE_EXIT { FUEShedCameraAuthoringBridge::Shutdown(); };
	TSharedPtr<FJsonObject> Q;
	FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(TEXT(R"({"version":1,"operation":"attach","sessionId":"native-test","cameraId":"camera-a","revision":0,"pose":{"projection":"perspective","aspectRatio":"16:9","fieldOfViewDegrees":60,"location":{"x":0,"y":0,"z":500},"rotation":{"pitch":0,"yaw":0,"roll":0}}})")), Q);
	Q->SetStringField(TEXT("projectName"), FApp::GetProjectName()); Q->SetStringField(TEXT("mapPath"), W->GetOutermost()->GetName());
	auto R = FUEShedCameraAuthoringBridge::Execute(Q);
	TestEqual(TEXT("Attach"), R->GetStringField(TEXT("status")), FString(TEXT("ready")));
	auto* C = FUEShedCameraAuthoringBridge::Camera(); if (!C) return false;
	TestTrue(TEXT("Transient transactional camera"), C->HasAllFlags(RF_Transient | RF_Transactional));
	TestTrue(TEXT("Transient lens"), C->GetCameraComponent()->HasAnyFlags(RF_Transient));
	TestTrue(TEXT("Capture ownership held"), FUEShedCameraEditorOwnership::HasAuthoringOwner());
	Q->SetStringField(TEXT("producerId"), R->GetStringField(TEXT("producerId")));
	Q->SetStringField(TEXT("operation"), TEXT("pilot")); R = FUEShedCameraAuthoringBridge::Execute(Q);
	TestTrue(TEXT("Native pilot lock"), V->GetActorLock().GetLockedActor() == C);
	const FVector Start = C->GetActorLocation();
	{
		FScopedTransaction Transaction(NSLOCTEXT("UEShed", "CameraTest", "Edit camera"));
		C->Modify(); C->GetCameraComponent()->Modify(); C->SetActorLocation(Start + FVector(50, 25, 10));
		C->GetCameraComponent()->SetFieldOfView(40); C->PostEditMove(true);
	}
	Q->SetStringField(TEXT("operation"), TEXT("inspect")); R = FUEShedCameraAuthoringBridge::Execute(Q);
	TestTrue(TEXT("Native changes pending"), R->GetBoolField(TEXT("pending")));
	const double FirstSequence = R->GetNumberField(TEXT("sequence"));
	TestEqual(TEXT("Lens readback"), R->GetObjectField(TEXT("pose"))->GetNumberField(TEXT("fieldOfViewDegrees")), 40.0);
	GEditor->UndoTransaction();
	R = FUEShedCameraAuthoringBridge::Execute(Q);
	TestEqual(TEXT("Undo pose"), C->GetActorLocation(), Start);
	TestEqual(TEXT("Undo lens"), C->GetCameraComponent()->FieldOfView, 60.f);
	TestTrue(TEXT("Undo observed"), R->GetNumberField(TEXT("sequence")) > FirstSequence);
	GEditor->RedoTransaction(); R = FUEShedCameraAuthoringBridge::Execute(Q);
	TestEqual(TEXT("Redo lens"), C->GetCameraComponent()->FieldOfView, 40.f);
	TestEqual(TEXT("Map dirty state preserved"), W->GetOutermost()->IsDirty(), Dirty);
	Q->SetStringField(TEXT("operation"), TEXT("apply")); Q->SetNumberField(TEXT("expectedRevision"), 0);
	Q->SetNumberField(TEXT("sequence"), FirstSequence); Q->SetNumberField(TEXT("revision"), 1);
	TestEqual(TEXT("Stale acknowledgement rejected"), FUEShedCameraAuthoringBridge::Execute(Q)->GetStringField(TEXT("status")), FString(TEXT("stale")));
	Q->SetNumberField(TEXT("sequence"), R->GetNumberField(TEXT("sequence"))); Q->SetObjectField(TEXT("pose"), R->GetObjectField(TEXT("pose")));
	R = FUEShedCameraAuthoringBridge::Execute(Q); TestFalse(TEXT("Confirmed state does not echo"), R->GetBoolField(TEXT("pending")));
	Q->SetStringField(TEXT("operation"), TEXT("save")); R = FUEShedCameraAuthoringBridge::Execute(Q);
	TestTrue(TEXT("Save requested for reviewed pose"), R->GetBoolField(TEXT("saveRequested")));
	C->SetActorLocation(C->GetActorLocation() + FVector(1, 0, 0));
	Q->SetStringField(TEXT("operation"), TEXT("inspect")); R = FUEShedCameraAuthoringBridge::Execute(Q);
	TestFalse(TEXT("Later movement cancels deferred Save"), R->GetBoolField(TEXT("saveRequested")));
	TestFalse(TEXT("Canceled Save explains recovery"), R->GetStringField(TEXT("message")).IsEmpty());
	Q->SetStringField(TEXT("operation"), TEXT("save")); R = FUEShedCameraAuthoringBridge::Execute(Q);
	TestTrue(TEXT("New pose can be explicitly saved"), R->GetBoolField(TEXT("saveRequested")));
	const FString RecoveryPath = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/CameraAuthoringRecovery"), R->GetStringField(TEXT("producerId")) + TEXT(".json"));
	FUEShedCameraAuthoringBridge::Shutdown();
	FString RecoveryJson; TestTrue(TEXT("Pending edits survive proxy cleanup"), FFileHelper::LoadFileToString(RecoveryJson, *RecoveryPath));
	TSharedPtr<FJsonObject> Recovery;
	TestTrue(TEXT("Recovery is structured JSON"), FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RecoveryJson), Recovery));
	if (Recovery) TestTrue(TEXT("Recovery records unacknowledged state"), Recovery->GetBoolField(TEXT("pending")));
	TestFalse(TEXT("Ownership released"), FUEShedCameraEditorOwnership::HasAuthoringOwner());
	TestFalse(TEXT("Pilot lock released"), V->IsAnyActorLocked());
	TestEqual(TEXT("Viewport position restored"), V->GetViewLocation(), Location);
	TestEqual(TEXT("Viewport rotation restored"), V->GetViewRotation(), Rotation);
	TestEqual(TEXT("Cleanup preserves dirty state"), W->GetOutermost()->IsDirty(), Dirty);
	TestNull(TEXT("Proxy released"), FUEShedCameraAuthoringBridge::Camera());
	const FString OriginalMap = W->GetOutermost()->GetName();
	const FString SavedMap = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("CameraAuthoringCleanMap.umap"));
	Q->SetStringField(TEXT("operation"), TEXT("attach"));
	TestEqual(TEXT("Reattach before save"), FUEShedCameraAuthoringBridge::Execute(Q)->GetStringField(TEXT("status")), FString(TEXT("ready")));
	TestTrue(TEXT("Save map with a live transient camera"), FEditorFileUtils::SaveMap(W, SavedMap));
	TestTrue(TEXT("Reload saved map"), FEditorFileUtils::LoadMap(SavedMap, false, false));
	TestNull(TEXT("Map load detached the bridge"), FUEShedCameraAuthoringBridge::Camera());
	int32 SavedProxies = 0;
	for (TActorIterator<AUEShedAuthoringCamera> It(GEditor->GetEditorWorldContext().World()); It; ++It) ++SavedProxies;
	TestEqual(TEXT("No authoring camera serialized into the map"), SavedProxies, 0);
	TestTrue(TEXT("Restore fixture map"), FEditorFileUtils::LoadMap(OriginalMap, false, false));
	return true;
}
#endif
