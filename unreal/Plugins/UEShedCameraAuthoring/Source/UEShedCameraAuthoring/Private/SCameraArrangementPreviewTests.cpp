#if WITH_DEV_AUTOMATION_TESTS
#include "Engine/Engine.h"
#include "Editor.h"
#include "HAL/FileManager.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "ImageUtils.h"
#include "Misc/App.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "SCameraArrangementPanel.h"
#include "SCameraSetPreviews.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedCameraAuthoringBridge.h"
#include "UObject/GarbageCollection.h"
#include "Widgets/Layout/SWrapBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SWindow.h"
#include "Widgets/Input/SNumericEntryBox.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraPreviewPanelTest, "UEShed.Cameras.Authoring.PreviewPanel",
                                 EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraPreviewPanelTest::RunTest(const FString &Parameters)
{
    UWorld *World = nullptr;
    for (const auto &Context : GEngine->GetWorldContexts())
        if (Context.WorldType == EWorldType::Editor)
            World = Context.World();
    if (!World)
    {
        AddError(TEXT("Open an editor world."));
        return false;
    }
    FActorSpawnParameters Spawn;
    Spawn.ObjectFlags = RF_Transient;
    Spawn.bTemporaryEditorActor = true;
    auto Subject = World->SpawnActor<AActor>(Spawn);
    ON_SCOPE_EXIT
    {
        // Detach restores the original subject selection. Release its editor selection handle
        // before destroying the fixture actor (UE 5.7 retains that handle until shutdown otherwise).
        GEditor->SelectActor(Subject, false, true);
        World->DestroyActor(Subject);
    };
    Subject->SetActorLabel(TEXT("Preset setup subject"));
    GEditor->SelectNone(false, true);
    GEditor->SelectActor(Subject, true, true);
    auto Poll = MakeShared<FJsonObject>();
    Poll->SetNumberField(TEXT("version"), 1);
    Poll->SetStringField(TEXT("operation"), TEXT("setup_poll"));
    Poll->SetStringField(TEXT("hostId"), TEXT("native-panel-test"));
    Poll->SetStringField(TEXT("projectName"), FApp::GetProjectName());
    TestEqual(TEXT("Setup host can connect before any camera exists"), FUEShedCameraAuthoringBridge::Execute(Poll)->GetStringField(TEXT("status")), FString(TEXT("setup")));
    auto SetupPanel = SNew(SCameraArrangementPanel);
    auto SetupWindow = SNew(SWindow).Title(FText::FromString(TEXT("Camera setup"))).ClientSize(FVector2D(580, 640))[SetupPanel];
    FSlateApplication::Get().AddWindow(SetupWindow);
    ON_SCOPE_EXIT { SetupWindow->RequestDestroyWindow(); };
    SetupPanel->Refresh(0, .2f);
    FSlateApplication::Get().Tick();
    auto Screenshot = [this](TSharedRef<SWidget> Widget, const TCHAR* Name) {
        IFileManager::Get().MakeDirectory(*FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/PreviewValidation")), true);
        TArray<FColor> Pixels;
        FIntVector Size;
        if (TestTrue(TEXT("Capture native authoring UI"), FSlateApplication::Get().TakeScreenshot(Widget, Pixels, Size)))
            TestTrue(TEXT("Save native authoring UI"), FImageUtils::SaveImageByExtension(*FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/PreviewValidation"), Name), FImageView(Pixels.GetData(), Size.X, Size.Y)));
    };
    Screenshot(SetupPanel, TEXT("setup.png"));
    SetupPanel->CreateFromPreset();
    auto Queued = FUEShedCameraAuthoringBridge::Execute(Poll);
    TestEqual(TEXT("Native create queues the chosen preset before attachment"), Queued->GetObjectField(TEXT("request"))->GetObjectField(TEXT("layout"))->GetNumberField(TEXT("count")), 4.0);
    TestEqual(TEXT("Native setup names the explicit subject"), Queued->GetObjectField(TEXT("request"))->GetStringField(TEXT("actorPath")), Subject->GetPathName());
    TestEqual(TEXT("Setup does not create cameras without host persistence"), FUEShedCameraAuthoringBridge::Cameras().Num(), 0);
    auto Outcome = MakeShared<FJsonObject>();
    Outcome->SetStringField(TEXT("id"), Queued->GetObjectField(TEXT("request"))->GetStringField(TEXT("id")));
    Outcome->SetStringField(TEXT("error"), TEXT("Fixture write denied"));
    Poll->SetObjectField(TEXT("outcome"), Outcome);
    FUEShedCameraAuthoringBridge::Execute(Poll);
    SetupPanel->Refresh(.2, .2f);
    TestEqual(TEXT("Setup errors reach the panel"), SetupPanel->Message, FString(TEXT("Fixture write denied")));
    TestTrue(TEXT("Failed setup can be retried"), SetupPanel->CreatingId.IsEmpty());
    Poll->RemoveField(TEXT("outcome"));
    auto InvalidCreate = MakeShared<FJsonObject>();
    InvalidCreate->SetNumberField(TEXT("version"), 1);
    InvalidCreate->SetStringField(TEXT("operation"), TEXT("setup_create"));
    auto InvalidIntent = MakeShared<FJsonObject>(*Queued->GetObjectField(TEXT("request")));
    auto InvalidLayout = MakeShared<FJsonObject>(*InvalidIntent->GetObjectField(TEXT("layout")));
    InvalidLayout->SetNumberField(TEXT("count"), 0);
    InvalidIntent->SetObjectField(TEXT("layout"), InvalidLayout);
    InvalidCreate->SetObjectField(TEXT("intent"), InvalidIntent);
    TestEqual(TEXT("Native setup rejects an empty preset"), FUEShedCameraAuthoringBridge::Execute(InvalidCreate)->GetStringField(TEXT("status")), FString(TEXT("invalid")));
    auto Release = MakeShared<FJsonObject>();
    Release->SetNumberField(TEXT("version"), 1);
    Release->SetStringField(TEXT("operation"), TEXT("setup_release"));
    Release->SetStringField(TEXT("hostId"), TEXT("another-host"));
    TestEqual(TEXT("Another host cannot release setup"), FUEShedCameraAuthoringBridge::Execute(Release)->GetStringField(TEXT("status")), FString(TEXT("stale")));
    Release->SetStringField(TEXT("hostId"), TEXT("native-panel-test"));
    TestFalse(TEXT("Graceful shutdown immediately disconnects setup"), FUEShedCameraAuthoringBridge::Execute(Release)->GetBoolField(TEXT("connected")));
    Poll->SetStringField(TEXT("projectName"), FString(FApp::GetProjectName()) + TEXT("-other"));
    TestEqual(TEXT("Setup host cannot use another project"), FUEShedCameraAuthoringBridge::Execute(Poll)->GetStringField(TEXT("status")), FString(TEXT("stale")));
    Poll->SetStringField(TEXT("projectName"), FApp::GetProjectName());
    Poll->SetStringField(TEXT("hostId"), TEXT("restarted-host"));
    TestTrue(TEXT("Restarted host connects without waiting for lease expiry"), FUEShedCameraAuthoringBridge::Execute(Poll)->GetBoolField(TEXT("connected")));
    TSharedPtr<FJsonObject> Request;
    FJsonSerializer::Deserialize(
        TJsonReaderFactory<>::Create(TEXT(
            R"({"version":1,"operation":"attach","sessionId":"preview-panel","cameraId":"camera-0","revision":0,"pose":{"projection":"perspective","aspectRatio":"16:9","fieldOfViewDegrees":60,"location":{"x":1000,"y":1000,"z":900},"rotation":{"pitch":-30,"yaw":-135,"roll":0}}})")),
        Request);
    Request->SetStringField(TEXT("projectName"), FApp::GetProjectName());
    Request->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
    TArray<TSharedPtr<FJsonValue>> NativeCameras;
    for (int32 I = 0; I < 16; ++I)
    {
        auto Camera = MakeShared<FJsonObject>();
        Camera->SetStringField(TEXT("id"), FString::Printf(TEXT("camera-%d"), I));
        Camera->SetStringField(TEXT("displayName"), FString::Printf(TEXT("Orbit %d"), I + 1));
        Camera->SetObjectField(TEXT("pose"), Request->GetObjectField(TEXT("pose")));
        NativeCameras.Add(MakeShared<FJsonValueObject>(Camera));
    }
    Request->SetArrayField(TEXT("cameras"), NativeCameras);
    const auto Attached = FUEShedCameraAuthoringBridge::Execute(Request);
    ON_SCOPE_EXIT
    {
        FUEShedCameraAuthoringBridge::Shutdown();
    };
    if (!TestEqual(TEXT("Attach panel fixture"), Attached->GetStringField(TEXT("status")), FString(TEXT("ready"))))
        return false;
    auto State = MakeShared<FJsonObject>(), Arrangement = MakeShared<FJsonObject>();
    Arrangement->SetStringField(TEXT("id"), TEXT("preview-panel"));
    Arrangement->SetStringField(TEXT("displayName"), TEXT("Camera preview fixture"));
    Arrangement->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
    Arrangement->SetNumberField(TEXT("revision"), 0);
    Arrangement->SetArrayField(TEXT("groups"), {});
    auto Settings = MakeShared<FJsonObject>();
    Settings->SetNumberField(TEXT("fieldOfViewDegrees"), 60);
    Settings->SetNumberField(TEXT("distanceScale"), 1.15);
    Settings->SetNumberField(TEXT("heightOffset"), 0);
    Settings->SetNumberField(TEXT("elevationDegrees"), 15);
    Settings->SetNumberField(TEXT("yawOffset"), 0);
    Settings->SetNumberField(TEXT("margin"), .1);
    Arrangement->SetObjectField(TEXT("settings"), Settings);
    TArray<TSharedPtr<FJsonValue>> Cameras, Effective;
    for (int32 I = 0; I < 16; ++I)
    {
        auto Camera = MakeShared<FJsonObject>(), Resolved = MakeShared<FJsonObject>();
        const FString Id = FString::Printf(TEXT("camera-%d"), I);
        Camera->SetStringField(TEXT("id"), Id);
        Camera->SetStringField(TEXT("displayName"), FString::Printf(TEXT("Orbit %d"), I + 1));
        Cameras.Add(MakeShared<FJsonValueObject>(Camera));
        Resolved->SetStringField(TEXT("id"), Id);
        Resolved->SetBoolField(TEXT("approved"), false);
        auto Pose = MakeShared<FJsonObject>(*Request->GetObjectField(TEXT("pose")));
        auto Rotation = MakeShared<FJsonObject>(*Pose->GetObjectField(TEXT("rotation")));
        Rotation->SetNumberField(TEXT("yaw"), -135 + I * 30);
        Pose->SetObjectField(TEXT("rotation"), Rotation);
        Resolved->SetObjectField(TEXT("pose"), Pose);
        auto Visibility = MakeShared<FJsonObject>();
        Visibility->SetArrayField(TEXT("hide"), {});
        Visibility->SetArrayField(TEXT("protect"), {});
        Resolved->SetObjectField(TEXT("visibility"), Visibility);
        Effective.Add(MakeShared<FJsonValueObject>(Resolved));
    }
    Arrangement->SetArrayField(TEXT("cameras"), Cameras);
    State->SetObjectField(TEXT("arrangement"), Arrangement);
    State->SetStringField(TEXT("activeCameraId"), TEXT("camera-0"));
    State->SetArrayField(TEXT("cameras"), Effective);
    Request->SetStringField(TEXT("operation"), TEXT("panel"));
    Request->SetStringField(TEXT("producerId"), Attached->GetStringField(TEXT("producerId")));
    Request->SetObjectField(TEXT("state"), State);
    TestEqual(TEXT("Publish panel"), FUEShedCameraAuthoringBridge::Execute(Request)->GetStringField(TEXT("status")),
              FString(TEXT("ready")));
    bool RequestedReview = false;
    auto Panel = SNew(SCameraArrangementPanel).OnSeePreviews(FSimpleDelegate::CreateLambda([&RequestedReview] {
        RequestedReview = true;
    }));
    auto Window = SNew(SWindow).Title(FText::FromString(TEXT("Camera editing"))).ClientSize(FVector2D(580, 640))[Panel];
    FSlateApplication::Get().AddWindow(Window);
    ON_SCOPE_EXIT
    {
        Window->RequestDestroyWindow();
    };
    Panel->Refresh(1, .2f);
    FSlateApplication::Get().Tick();
    Screenshot(Panel, TEXT("editing.png"));
    Window->Resize(FVector2D(1000, 640));
    FSlateApplication::Get().Tick();
    FSlateApplication::Get().Tick();
    Screenshot(Panel, TEXT("editing-wide.png"));
    Panel->InspectorPage = 1;
    FSlateApplication::Get().Tick();
    Screenshot(Panel, TEXT("visibility.png"));
    Panel->InspectorPage = 2;
    FSlateApplication::Get().Tick();
    Screenshot(Panel, TEXT("capture.png"));
    Panel->InspectorPage = 0;
    Window->Resize(FVector2D(620, 640));
    FSlateApplication::Get().Tick();
    Panel->StartSetup(false);
    FSlateApplication::Get().Tick();
    Screenshot(Panel, TEXT("change-preset.png"));
    Panel->SetupOpen = false;
    FSlateApplication::Get().Tick();
    // Exercise the same scrub handlers as SNumericEntryBox, including a slow host acknowledgement.
    Panel->BeginSettingDrag(TEXT("fieldOfViewDegrees"));
    Panel->ChangeSetting(TEXT("fieldOfViewDegrees"), 65, false);
    Panel->FlushSetting();
    auto FirstEdit = FUEShedCameraAuthoringBridge::InspectActive()->GetObjectField(TEXT("panelEvent"));
    TestEqual(TEXT("Dragging queues a live field edit"), FirstEdit->GetObjectField(TEXT("action"))->GetObjectField(TEXT("command"))->GetObjectField(TEXT("settings"))->GetNumberField(TEXT("fieldOfViewDegrees")), 65.0);
    Panel->ChangeSetting(TEXT("fieldOfViewDegrees"), 70, false);
    Panel->ChangeSetting(TEXT("fieldOfViewDegrees"), 75, true);
    TestEqual(TEXT("No new event overwrites an in-flight edit"), FUEShedCameraAuthoringBridge::InspectActive()->GetObjectField(TEXT("panelEvent"))->GetStringField(TEXT("id")), FirstEdit->GetStringField(TEXT("id")));
    TestEqual(TEXT("The displayed scrub value does not snap back during acknowledgement"), Panel->DisplaySetting(TEXT("fieldOfViewDegrees")).GetValue(), 75.0);
    Settings->SetNumberField(TEXT("fieldOfViewDegrees"), 65);
    Request->SetStringField(TEXT("acknowledgeEvent"), FirstEdit->GetStringField(TEXT("id")));
    FUEShedCameraAuthoringBridge::Execute(Request);
    Panel->Refresh(1.2, .2f);
    auto FinalEdit = FUEShedCameraAuthoringBridge::InspectActive()->GetObjectField(TEXT("panelEvent"));
    TestEqual(TEXT("Mouse release preserves the final value behind a slow host"), FinalEdit->GetObjectField(TEXT("action"))->GetObjectField(TEXT("command"))->GetObjectField(TEXT("settings"))->GetNumberField(TEXT("fieldOfViewDegrees")), 75.0);
    Settings->SetNumberField(TEXT("fieldOfViewDegrees"), 75);
    Request->SetStringField(TEXT("acknowledgeEvent"), FinalEdit->GetStringField(TEXT("id")));
    FUEShedCameraAuthoringBridge::Execute(Request);
    Panel->Refresh(1.4, .2f);
    TestFalse(TEXT("Acknowledged scrub clears its local pending value"), Panel->SettingEdit.IsSet());
    Panel->BeginSettingDrag(TEXT("fieldOfViewDegrees"));
    Panel->ChangeSetting(TEXT("fieldOfViewDegrees"), 80, false);
    Panel->Scope = TEXT("cameras");
    Panel->FlushSetting();
    TestFalse(TEXT("Scope changes cancel unsent scrub values"), Panel->SettingEdit.IsSet());
    TestFalse(TEXT("Scrubbing never retargets another camera scope"), FUEShedCameraAuthoringBridge::InspectActive()->HasField(TEXT("panelEvent")));
    Panel->Scope = TEXT("arrangement");
    Panel->Message.Reset();
    {
        auto Field = Panel->Setting(TEXT("FOV (degrees)"), TEXT("fieldOfViewDegrees"));
        auto Numeric = StaticCastSharedRef<SNumericEntryBox<double>>(Field->GetChildren()->GetChildAt(1)->GetChildren()->GetChildAt(0));
        TestTrue(TEXT("Framing fields use native draggable spin controls"), Numeric->GetSpinBox().IsValid());
        auto DragWindow = SNew(SWindow).Title(FText::FromString(TEXT("Numeric interaction"))).ClientSize(FVector2D(320, 100))[Field];
        auto& Slate = FSlateApplication::Get();
        Slate.AddWindow(DragWindow);
        Slate.Tick();
        Slate.Tick();
        const FVector2D Point = Numeric->GetCachedGeometry().GetAbsolutePosition() + FVector2D(40, 10);
        const TSet<FKey> Pressed{EKeys::LeftMouseButton};
        Slate.ProcessMouseButtonDownEvent(DragWindow->GetNativeWindow(), FPointerEvent(0, Point, Point, Pressed, EKeys::LeftMouseButton, 0, FModifierKeysState()));
        Slate.ProcessMouseMoveEvent(FPointerEvent(0, Point + FVector2D(20, 0), Point, Pressed, EKeys::Invalid, 0, FModifierKeysState()));
        Slate.ProcessMouseMoveEvent(FPointerEvent(0, Point + FVector2D(60, 0), Point + FVector2D(20, 0), Pressed, EKeys::Invalid, 0, FModifierKeysState()));
        Slate.ProcessMouseButtonUpEvent(FPointerEvent(0, Point + FVector2D(60, 0), Point + FVector2D(60, 0), {}, EKeys::LeftMouseButton, 0, FModifierKeysState()));
        const auto Snapshot = FUEShedCameraAuthoringBridge::InspectActive();
        if (TestTrue(TEXT("Real mouse dragging submits a numeric edit"), Snapshot->HasField(TEXT("panelEvent"))))
        {
            const auto Event = Snapshot->GetObjectField(TEXT("panelEvent"));
            const double Value = Event->GetObjectField(TEXT("action"))->GetObjectField(TEXT("command"))->GetObjectField(TEXT("settings"))->GetNumberField(TEXT("fieldOfViewDegrees"));
            TestTrue(TEXT("Dragging right increases the field value"), Value > 75);
            Settings->SetNumberField(TEXT("fieldOfViewDegrees"), Value);
            Request->SetStringField(TEXT("acknowledgeEvent"), Event->GetStringField(TEXT("id")));
            FUEShedCameraAuthoringBridge::Execute(Request);
            Panel->Refresh(1.6, .2f);
        }
        DragWindow->RequestDestroyWindow();
    }
    TestEqual(TEXT("Editing panel lists the entire set"), Panel->CameraRows->GetChildren()->Num(), 16);
    TArray<TSharedPtr<FJsonValue>> SelectIds;
    for (const auto &Camera : NativeCameras)
        SelectIds.Add(MakeShared<FJsonValueString>(Camera->AsObject()->GetStringField(TEXT("id"))));
    Panel->SelectCameras(SelectIds);
    for (auto *Camera : FUEShedCameraAuthoringBridge::Cameras())
        TestTrue(TEXT("Panel selects actual native cameras"), Camera->IsSelected());
    Panel->PilotCamera(TEXT("camera-0"));
    TestTrue(TEXT("Panel pilots native camera"),
             FUEShedCameraAuthoringBridge::InspectActive()->GetBoolField(TEXT("piloting")));
    Panel->SelectCameras(SelectIds);
    Panel->SeePreviews.ExecuteIfBound();
    TestTrue(TEXT("See Previews requests a separate panel"), RequestedReview);
    auto Previews = SNew(SCameraSetPreviews).PreviewVisible(false);
    auto ReviewWindow =
        SNew(SWindow).Title(FText::FromString(TEXT("Camera Previews"))).ClientSize(FVector2D(1100, 700))[Previews];
    FSlateApplication::Get().AddWindow(ReviewWindow);
    ON_SCOPE_EXIT
    {
        Previews->Close();
        ReviewWindow->RequestDestroyWindow();
    };
    TestEqual(TEXT("Review lists all sixteen cameras without paging"), Previews->Grid->GetChildren()->Num(), 16);
    TestEqual(TEXT("Whole set queued"), Previews->Review.Num(), 16);
    Previews->Draw(1, .02f);
    TestEqual(TEXT("Hidden review does not allocate capture actors"), Previews->Review.ActiveCaptures(), 0);
    Previews->PreviewVisible.Set(true);
    const double Start = FSlateApplication::Get().GetCurrentTime();
    for (int32 I = 0; I < 128; ++I)
    {
        Previews->Draw(Start + I * .02, .02f);
        TestTrue(TEXT("Only one live renderer at a time"), Previews->Review.ActiveCaptures() <= 1);
    }
    TestFalse(TEXT("Rendering stops after one batch"), Previews->Review.IsRunning());
    TestEqual(TEXT("No render actors remain after review"), Previews->Review.ActiveCaptures(), 0);
    for (int32 I = 0; I < 16; ++I)
        TestNotNull(TEXT("Every camera has a review snapshot"),
                    Previews->Review.Texture(FString::Printf(TEXT("camera-%d"), I)));
    CollectGarbage(RF_NoFlags);
    TestNotNull(TEXT("Snapshot textures survive garbage collection"), Previews->Review.Texture(TEXT("camera-0")));
    const auto *FirstTexture = Previews->Review.Texture(TEXT("camera-0"));
    Previews->Draw(Start + 3, .02f);
    TestTrue(TEXT("Completed snapshots stay frozen"), FirstTexture == Previews->Review.Texture(TEXT("camera-0")));
    FSlateApplication::Get().Tick();
    TArray<FColor> Pixels;
    FIntVector Size;
    if (TestTrue(TEXT("Capture separate review panel"),
                 FSlateApplication::Get().TakeScreenshot(Previews, Pixels, Size)))
    {
        const FString Path = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/PreviewValidation/panel.png"));
        TestTrue(TEXT("Save panel screenshot"),
                 FImageUtils::SaveImageByExtension(*Path, FImageView(Pixels.GetData(), Size.X, Size.Y)));
    }
    Effective[0]->AsObject()->GetObjectField(TEXT("pose"))->SetNumberField(TEXT("fieldOfViewDegrees"), 45);
    FUEShedCameraAuthoringBridge::Execute(Request);
    Previews->Poll(Start + 4, .2f);
    TestTrue(TEXT("Camera edits mark snapshots out of date"), Previews->Stale);
    TestTrue(TEXT("Editing does not silently rerender review images"),
             FirstTexture == Previews->Review.Texture(TEXT("camera-0")));
    Previews->RenderAll();
    TestFalse(TEXT("Refresh all clears stale status"), Previews->Stale);
    TestTrue(TEXT("Refresh all schedules the entire set"), Previews->Review.IsRunning());
    TestNull(TEXT("Old images do not masquerade as refreshed results"), Previews->Review.Texture(TEXT("camera-0")));
    Previews->Draw(Start + 5, .02f);
    Previews->Close();
    Previews->Poll(Start + 6, .2f);
    TestEqual(TEXT("Closing mid-render releases all review resources"), Previews->Review.Num(), 0);
    TestEqual(TEXT("Closing review does not end the editing session"),
              FUEShedCameraAuthoringBridge::InspectActive()->GetStringField(TEXT("status")), FString(TEXT("ready")));
    auto Reopened = SNew(SCameraSetPreviews).PreviewVisible(false);
    TestEqual(TEXT("Reopening queues a fresh whole-set review"), Reopened->Review.Num(), 16);
    FUEShedCameraAuthoringBridge::Shutdown();
    Panel->Refresh(Start + 7, .2f);
    Reopened->Poll(Start + 7, .2f);
    TestEqual(TEXT("Detach clears review grid"), Reopened->Grid->GetChildren()->Num(), 0);
    TestEqual(TEXT("Detach releases snapshots"), Reopened->Review.Num(), 0);
    return true;
}
#endif
