#if WITH_DEV_AUTOMATION_TESTS
#include "Camera/CameraActor.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMemory.h"
#include "HAL/PlatformTime.h"
#include "LevelEditorViewport.h"
#include "Misc/App.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "RenderingThread.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedCameraAuthoringBridge.h"
#include "UEShedCameraPreviewReview.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraScaleTest, "UEShed.Cameras.Authoring.ScaleAndCleanup",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FUEShedCameraScaleTest::RunTest(const FString &Parameters)
{
    auto *World = GEditor->GetEditorWorldContext().World();
    auto *Viewport = GCurrentLevelEditingViewportClient;
    if (!World || !Viewport) return false;
    const bool Dirty = World->GetOutermost()->IsDirty();
    const auto OriginalLocation = Viewport->GetViewLocation();
    TArray<TSharedPtr<FJsonValue>> Measurements;
    ON_SCOPE_EXIT { FUEShedCameraAuthoringBridge::Shutdown(); };
    for (int32 Count : {1, 6, 37})
    {
        FActorSpawnParameters Spawn;
        Spawn.ObjectFlags = RF_Transient;
        Spawn.bTemporaryEditorActor = true;
        Spawn.bCreateActorPackage = false;
        auto *Baseline = World->SpawnActor<ACameraActor>(Spawn);
        if (!Baseline) return false;
        auto Move = [](ACameraActor *Camera) {
            const double Start = FPlatformTime::Seconds();
            for (int32 I = 0; I < 100; ++I)
            {
                Camera->AddActorWorldOffset(FVector(0.1, 0, 0));
                Camera->PostEditMove(true);
            }
            return (FPlatformTime::Seconds() - Start) * 1000.0 / 100.0;
        };
        const double BaselineMs = Move(Baseline);
        World->DestroyActor(Baseline);
        TSharedPtr<FJsonObject> Request;
        FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(TEXT(
            R"({"version":1,"operation":"attach","sessionId":"scale-proof","cameraId":"camera-0","revision":0,"pose":{"projection":"perspective","aspectRatio":"16:9","fieldOfViewDegrees":60,"location":{"x":950,"y":-750,"z":650},"rotation":{"pitch":-25,"yaw":140,"roll":0}}})")), Request);
        Request->SetStringField(TEXT("projectName"), FApp::GetProjectName());
        Request->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
        TArray<TSharedPtr<FJsonValue>> Cameras;
        TArray<FUEShedCameraPreviewView> Views;
        for (int32 I = 0; I < Count; ++I)
        {
            auto Camera = MakeShared<FJsonObject>();
            const FString Id = FString::Printf(TEXT("camera-%d"), I);
            Camera->SetStringField(TEXT("id"), Id);
            Camera->SetStringField(TEXT("displayName"), Id);
            Camera->SetObjectField(TEXT("pose"), Request->GetObjectField(TEXT("pose")));
            Cameras.Add(MakeShared<FJsonValueObject>(Camera));
            FUEShedCameraPreviewView View;
            View.Id = Id;
            View.Location = FVector(950, -750, 650);
            View.Rotation = FRotator(-25, 140, 0);
            Views.Add(View);
        }
        Request->SetArrayField(TEXT("cameras"), Cameras);
        const double AttachStart = FPlatformTime::Seconds();
        auto Response = FUEShedCameraAuthoringBridge::Execute(Request);
        if (!TestEqual(TEXT("Scale attach"), Response->GetStringField(TEXT("status")), FString(TEXT("ready")))) return false;
        auto Measurement = MakeShared<FJsonObject>();
        Measurement->SetNumberField(TEXT("cameras"), Count);
        Measurement->SetNumberField(TEXT("attachMs"), (FPlatformTime::Seconds() - AttachStart) * 1000);
        Measurement->SetNumberField(TEXT("baselineMoveMeanMs"), BaselineMs);
        Measurement->SetNumberField(TEXT("authoringMoveMeanMs"), Move(FUEShedCameraAuthoringBridge::Camera(TEXT("camera-0"))));
        Response = FUEShedCameraAuthoringBridge::InspectActive();
        TestTrue(TEXT("Movement remains pending without host"), Response->GetBoolField(TEXT("pending")));
        TestEqual(TEXT("Repeated movement coalesces per camera"), Response->GetArrayField(TEXT("edits")).Num(), 1);
        TestEqual(TEXT("No camera count truncation"), FUEShedCameraAuthoringBridge::Cameras().Num(), Count);
        const auto BeforeMemory = FPlatformMemory::GetStats().UsedPhysical;
        FUEShedCameraPreviewReview Review;
        FString Error;
        if (!TestTrue(TEXT("Begin scale preview"), Review.Begin(World, Views, Error))) return false;
        const double PreviewStart = FPlatformTime::Seconds();
        double FirstPreviewMs = 0;
        for (int32 Tick = 0; Tick < Count * 32 && Review.IsRunning(); ++Tick)
        {
            Review.Tick(Tick * 1.0);
            FlushRenderingCommands();
            TestTrue(TEXT("Only one live capture"), Review.ActiveCaptures() <= 1);
            if (Review.Completed() > 0 && FirstPreviewMs == 0)
                FirstPreviewMs = (FPlatformTime::Seconds() - PreviewStart) * 1000;
        }
        TestEqual(TEXT("All scale previews complete"), Review.Completed(), Count);
        TestEqual(TEXT("All scale previews succeed"), Review.Failed(), 0);
        TestFalse(TEXT("No continuous capture after completion"), Review.IsRunning());
        Measurement->SetNumberField(TEXT("firstPreviewMs"), FirstPreviewMs);
        Measurement->SetNumberField(TEXT("previewBatchMs"), (FPlatformTime::Seconds() - PreviewStart) * 1000);
        Measurement->SetNumberField(TEXT("processPhysicalDeltaBytes"), static_cast<double>(FPlatformMemory::GetStats().UsedPhysical) - static_cast<double>(BeforeMemory));
        Measurement->SetNumberField(TEXT("cachedImageBytes"), Count * 640 * 360 * 4);
        Review.Reset();
        TestEqual(TEXT("Review release empties cache"), Review.Num(), 0);
        FEditorDelegates::PreBeginPIE.Broadcast(false);
        TestEqual(TEXT("PIE transition releases all authoring cameras"), FUEShedCameraAuthoringBridge::Cameras().Num(), 0);
        TestEqual(TEXT("Viewport remains unchanged"), Viewport->GetViewLocation(), OriginalLocation);
        TestEqual(TEXT("Map dirt remains unchanged"), World->GetOutermost()->IsDirty(), Dirty);
        Measurements.Add(MakeShared<FJsonValueObject>(Measurement));
    }
    const FString Directory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/CameraScale"));
    IFileManager::Get().MakeDirectory(*Directory, true);
    auto Report = MakeShared<FJsonObject>();
    Report->SetStringField(TEXT("note"), TEXT("Stock fixture, automation-driven ticks and render-thread flushes. Render work duration excludes interactive tick pacing; movement measures transform callbacks, not input-to-display latency."));
    Report->SetArrayField(TEXT("measurements"), Measurements);
    FString Text;
    FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Text));
    return TestTrue(TEXT("Scale evidence saved"), FFileHelper::SaveStringToFile(Text, *FPaths::Combine(Directory, TEXT("evidence.json"))));
}
#endif
