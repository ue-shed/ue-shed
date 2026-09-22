#if WITH_DEV_AUTOMATION_TESTS
#include "Engine/Engine.h"
#include "Camera/CameraComponent.h"
#include "Widgets/Input/SSpinBox.h"
#include "Types/SlateAttributeMetaData.h"
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
    auto ExposureSpin = StaticCastSharedPtr<SSpinBox<double>>(Panel->ExposureInput->GetSpinBox());
    TestEqual(TEXT("Exposure typed minimum"), ExposureSpin->GetMinValue(), -20.);
    TestEqual(TEXT("Exposure typed maximum"), ExposureSpin->GetMaxValue(), 30.);
    TestEqual(TEXT("Exposure slider minimum"), ExposureSpin->GetMinSliderValue(), -20.);
    TestEqual(TEXT("Exposure slider maximum"), ExposureSpin->GetMaxSliderValue(), 30.);
    ExposureSpin->SetValue(86.3, true);
    TestEqual(TEXT("Committed exposure is bounded"), Panel->ExposureEV, 30.);
    // SetValue replaces the spinbox attribute; restore its live binding after this simulated commit.
    ExposureSpin->SetValue(TAttribute<double>::CreateLambda([PanelPtr = Panel.operator->()] { return PanelPtr->ExposureEV; }));
    Panel->ExposureEV = -2;
    Panel->ApplyExposure(false);
    auto ExposureEvent = FUEShedCameraAuthoringBridge::InspectActive()->GetObjectField(TEXT("panelEvent"));
    auto FixedPolicy = ExposureEvent->GetObjectField(TEXT("action"))->GetObjectField(TEXT("command"))->GetObjectField(TEXT("policy"));
    TestEqual(TEXT("Apply uses entered EV"), FixedPolicy->GetObjectField(TEXT("exposure"))->GetNumberField(TEXT("ev100")), -2.);
    State->SetObjectField(TEXT("renderPolicy"), FixedPolicy);
    Request->SetStringField(TEXT("acknowledgeEvent"), ExposureEvent->GetStringField(TEXT("id")));
    FUEShedCameraAuthoringBridge::Execute(Request);
    Panel->Refresh(1.1, .1f);
    for (auto *Camera : FUEShedCameraAuthoringBridge::Cameras())
        TestTrue(TEXT("Fixed exposure reaches all native camera previews"), Camera->GetCameraComponent()->PostProcessSettings.bOverride_AutoExposureMinBrightness != 0);
    TestEqual(TEXT("Field follows acknowledged exposure"), Panel->ExposureEV, -2.);
    Panel->ApplyExposure(true);
    ExposureEvent = FUEShedCameraAuthoringBridge::InspectActive()->GetObjectField(TEXT("panelEvent"));
    auto DefaultPolicy = ExposureEvent->GetObjectField(TEXT("action"))->GetObjectField(TEXT("command"))->GetObjectField(TEXT("policy"));
    TestEqual(TEXT("Restore default selects automatic exposure"), DefaultPolicy->GetObjectField(TEXT("exposure"))->GetStringField(TEXT("mode")), FString(TEXT("project_auto")));
    TestTrue(TEXT("Restoring exposure preserves renderer policy"), DefaultPolicy->HasField(TEXT("renderer")));
    State->SetObjectField(TEXT("renderPolicy"), DefaultPolicy);
    Request->SetStringField(TEXT("acknowledgeEvent"), ExposureEvent->GetStringField(TEXT("id")));
    FUEShedCameraAuthoringBridge::Execute(Request);
    Panel->Refresh(1.2, .1f);
    for (auto *Camera : FUEShedCameraAuthoringBridge::Cameras())
        TestFalse(TEXT("Restore removes native exposure overrides"), Camera->GetCameraComponent()->PostProcessSettings.bOverride_AutoExposureMinBrightness != 0);
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
    auto Bounds = MakeShared<FJsonObject>(), Extent = MakeShared<FJsonObject>();
    Extent->SetNumberField(TEXT("x"), 1000);
    Extent->SetNumberField(TEXT("y"), 100);
    Extent->SetNumberField(TEXT("z"), 100);
    Bounds->SetObjectField(TEXT("extent"), Extent);
    Arrangement->SetObjectField(TEXT("bounds"), Bounds);
    double LargeHeightMove = 0;
    int32 HeightPass = 0;
    for (const TCHAR* FieldName : {TEXT("fieldOfViewDegrees"), TEXT("distanceScale"), TEXT("heightOffset"), TEXT("heightOffset")})
    {
        if (FString(FieldName) == TEXT("heightOffset") && HeightPass++ == 1)
        {
            Extent->SetNumberField(TEXT("x"), 10);
            Extent->SetNumberField(TEXT("y"), 1);
            Extent->SetNumberField(TEXT("z"), 1);
        }
        const double Before = Panel->Effective(FieldName).GetValue();
        auto Field = Panel->Setting(FieldName, FieldName);
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
            const double Value = Event->GetObjectField(TEXT("action"))->GetObjectField(TEXT("command"))->GetObjectField(TEXT("settings"))->GetNumberField(FieldName);
            TestTrue(TEXT("Dragging right increases the field value"), Value > Before);
            if (FString(FieldName) == TEXT("distanceScale"))
                TestTrue(TEXT("A short distance drag changes less than one multiplier unit"), Value - Before < 1);
            if (FString(FieldName) == TEXT("heightOffset"))
            {
                if (HeightPass == 1)
                {
                    LargeHeightMove = Value - Before;
                    TestTrue(TEXT("A short height drag moves meters for a 20m subject"), LargeHeightMove > 100 && LargeHeightMove < 1000);
                }
                else
                    TestTrue(TEXT("The same drag scales down for a 20cm prop without snapping the existing offset"), FMath::IsNearlyEqual((Value - Before) * 100, LargeHeightMove, 2.));
            }
            Settings->SetNumberField(FieldName, Value);
            Request->SetStringField(TEXT("acknowledgeEvent"), Event->GetStringField(TEXT("id")));
            FUEShedCameraAuthoringBridge::Execute(Request);
            Panel->Refresh(1.6, .2f);
        }
        DragWindow->RequestDestroyWindow();
    }
    {
        // Test the host-owned placement mode, including mixed whole-set selections.
        const auto Camera = Panel->ScopedCameras()[0];
        Camera->SetObjectField(TEXT("manualPose"), MakeShared<FJsonObject>());
        Panel->InspectorPage = 0;
        Panel->Refresh(1.65, .2f);
        FSlateApplication::Get().Tick();
        TestEqual(TEXT("Mixed whole set retains fitted controls"), Panel->FittedFields->GetVisibility(), EVisibility::Visible);
        TestTrue(TEXT("Mixed whole set can adjust aim"), Panel->CanAdjust(TEXT("aimOffset")));
        Screenshot(Panel, TEXT("framing-mixed.png"));
        Panel->Selected.Reset();
        Panel->SetCameraSelected(TEXT("camera-1"), true);
        TestEqual(TEXT("Checkbox selection switches away from whole set"), Panel->Scope, FString(TEXT("cameras")));
        TestFalse(TEXT("Selecting a fitted camera excludes the unrelated manual camera"), Panel->HasManualCamera());
        const auto ObservedSelection = FUEShedCameraAuthoringBridge::InspectActive();
        auto SelectionAck = MakeShared<FJsonObject>(*Request);
        SelectionAck->SetStringField(TEXT("operation"), TEXT("apply"));
        SelectionAck->SetStringField(TEXT("cameraId"), ObservedSelection->GetStringField(TEXT("cameraId")));
        SelectionAck->SetNumberField(TEXT("expectedRevision"), ObservedSelection->GetNumberField(TEXT("revision")));
        SelectionAck->SetNumberField(TEXT("revision"), ObservedSelection->GetNumberField(TEXT("revision")));
        SelectionAck->SetNumberField(TEXT("sequence"), ObservedSelection->GetNumberField(TEXT("sequence")));
        SelectionAck->SetObjectField(TEXT("pose"), ObservedSelection->GetObjectField(TEXT("pose")));
        SelectionAck->SetArrayField(TEXT("cameras"), ObservedSelection->GetArrayField(TEXT("cameras")));
        FUEShedCameraAuthoringBridge::Execute(SelectionAck);
        Panel->Refresh(1.655, .2f);
        TestTrue(TEXT("Checked fitted camera is adjustable"), Panel->CanAdjust(TEXT("heightOffset")));
        TestTrue(TEXT("Checked fitted camera is ready: ") + Panel->Message, Panel->Ready());
        Panel->ChangeSetting(TEXT("heightOffset"), 250, true);
        if (!TestTrue(TEXT("Fitted selection queues a height edit: ") + Panel->Message, FUEShedCameraAuthoringBridge::InspectActive()->HasField(TEXT("panelEvent")))) return false;
        const auto FittedEvent = FUEShedCameraAuthoringBridge::InspectActive()->GetObjectField(TEXT("panelEvent"));
        const auto FittedCommand = FittedEvent->GetObjectField(TEXT("action"))->GetObjectField(TEXT("command"));
        const auto FittedIds = FittedCommand->GetObjectField(TEXT("scope"))->GetArrayField(TEXT("cameraIds"));
        if (!TestEqual(TEXT("Fitted edit contains one checked camera"), FittedIds.Num(), 1)) return false;
        TestEqual(TEXT("Fitted edit targets the checked camera"), FittedIds[0]->AsString(), FString(TEXT("camera-1")));
        TestEqual(TEXT("Fitted camera height remains editable"), FittedCommand->GetObjectField(TEXT("settings"))->GetNumberField(TEXT("heightOffset")), 250.);
        Request->SetStringField(TEXT("acknowledgeEvent"), FittedEvent->GetStringField(TEXT("id")));
        Request->RemoveField(TEXT("cameraId"));
        State->SetStringField(TEXT("activeCameraId"), FUEShedCameraAuthoringBridge::InspectActive()->GetStringField(TEXT("cameraId")));
        FUEShedCameraAuthoringBridge::Execute(Request);
        Panel->Refresh(1.66, .2f);
        Panel->SetCameraSelected(TEXT("camera-1"), false);
        Panel->SetCameraSelected(Camera->GetStringField(TEXT("id")), true);
        State->SetStringField(TEXT("activeCameraId"), FUEShedCameraAuthoringBridge::InspectActive()->GetStringField(TEXT("cameraId")));
        for (const TCHAR* Name : {TEXT("distanceScale"), TEXT("heightOffset"), TEXT("elevationDegrees"), TEXT("yawOffset"), TEXT("margin")})
        {
            auto Field = Panel->Setting(Name, Name);
            auto Numeric = StaticCastSharedRef<SNumericEntryBox<double>>(Field->GetChildren()->GetChildAt(1)->GetChildren()->GetChildAt(0));
            FSlateAttributeMetaData::UpdateAllAttributes(*Numeric, FSlateAttributeMetaData::EInvalidationPermission::AllowInvalidation);
            TestFalse(TEXT("Manual-only selection disables fitted input"), Numeric->IsEnabled());
            Panel->ChangeSetting(Name, 2, true);
            TestFalse(TEXT("Manual framing cannot enqueue an ineffective edit"), FUEShedCameraAuthoringBridge::InspectActive()->HasField(TEXT("panelEvent")));
        }
        TestTrue(TEXT("FOV remains editable with a manual pose"), Panel->CanAdjust(TEXT("fieldOfViewDegrees")));
        TestFalse(TEXT("Aim offset disables for manual poses"), Panel->CanAdjust(TEXT("aimOffset")));
        Panel->Scope = TEXT("cameras");
        Panel->Selected = {Camera->GetStringField(TEXT("id"))};
        Panel->SelectCameras({MakeShared<FJsonValueString>(Camera->GetStringField(TEXT("id")))});
        const auto ManualSelection = FUEShedCameraAuthoringBridge::InspectActive();
        SelectionAck->SetStringField(TEXT("cameraId"), ManualSelection->GetStringField(TEXT("cameraId")));
        SelectionAck->SetNumberField(TEXT("sequence"), ManualSelection->GetNumberField(TEXT("sequence")));
        SelectionAck->SetObjectField(TEXT("pose"), ManualSelection->GetObjectField(TEXT("pose")));
        SelectionAck->SetArrayField(TEXT("cameras"), ManualSelection->GetArrayField(TEXT("cameras")));
        FUEShedCameraAuthoringBridge::Execute(SelectionAck);
        State->SetStringField(TEXT("activeCameraId"), ManualSelection->GetStringField(TEXT("cameraId")));
        Panel->InspectorPage = 0;
        Panel->Refresh(1.7, .2f);
        FSlateApplication::Get().Tick();
        TestEqual(TEXT("Manual selection replaces fitted fields"), Panel->FittedFields->GetVisibility(), EVisibility::Collapsed);
        TestTrue(TEXT("Manual selection shows pose data"), Panel->ManualRows->GetChildren()->Num() > 0);
        Screenshot(Panel, TEXT("framing-manual.png"));
        Panel->RestoreFittedCamera();
        const auto Event = FUEShedCameraAuthoringBridge::InspectActive()->GetObjectField(TEXT("panelEvent"));
        const auto Command = Event->GetObjectField(TEXT("action"))->GetObjectField(TEXT("command"));
        TestEqual(TEXT("Restore uses the public unpin command"), Command->GetStringField(TEXT("kind")), FString(TEXT("unpin")));
        TestEqual(TEXT("Restore targets the selected camera"), Command->GetStringField(TEXT("cameraId")), Camera->GetStringField(TEXT("id")));
        Camera->RemoveField(TEXT("manualPose"));
        Request->SetStringField(TEXT("acknowledgeEvent"), Event->GetStringField(TEXT("id")));
        FUEShedCameraAuthoringBridge::Execute(Request);
        Panel->Refresh(1.8, .2f);
        TestTrue(TEXT("Fitted controls re-enable after restoring placement"), Panel->CanAdjust(TEXT("distanceScale")));
        Panel->Scope = TEXT("arrangement");
        Panel->Selected.Reset();
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
    // Observe the actual camera while the host's saved manual pose stays unchanged.
    Cameras[0]->AsObject()->SetObjectField(TEXT("manualPose"), Effective[0]->AsObject()->GetObjectField(TEXT("pose")));
    FUEShedCameraAuthoringBridge::Execute(Request);
    Panel->Scope = TEXT("cameras");
    Panel->SelectCameras({MakeShared<FJsonValueString>(TEXT("camera-0"))});
    auto* LiveCamera = FUEShedCameraAuthoringBridge::Camera(TEXT("camera-0"));
    const FVector Moved(1234.5, -678.25, 901.75);
    LiveCamera->SetActorLocation(Moved);
    LiveCamera->SetActorRotation(FRotator(-12, 34, 5));
    LiveCamera->GetCameraComponent()->SetFieldOfView(52);
    Panel->Refresh(Start + 6.2, .2f);
    TestTrue(TEXT("Native pose edits are still awaiting host save"), Panel->Active->GetBoolField(TEXT("pending")));
    const auto LivePose = Panel->LivePose(TEXT("camera-0"));
    TestEqual(TEXT("Manual UI reads live X before host acknowledgement"), LivePose->GetObjectField(TEXT("location"))->GetNumberField(TEXT("x")), Moved.X);
    TestTrue(TEXT("Manual UI reads live pitch before host acknowledgement"), FMath::IsNearlyEqual(LivePose->GetObjectField(TEXT("rotation"))->GetNumberField(TEXT("pitch")), -12., .01));
    TestEqual(TEXT("Manual UI reads live FOV before host acknowledgement"), Panel->DisplaySetting(TEXT("fieldOfViewDegrees")).GetValue(), 52.);
    Window->Resize(FVector2D(620, 640));
    FSlateApplication::Get().Tick();
    Screenshot(Panel, TEXT("manual-live.png"));
    LiveCamera->SetActorLocation(FVector(2345.5, -678.25, 901.75));
    Panel->Refresh(Start + 6.4, .2f);
    TestEqual(TEXT("Manual UI follows subsequent camera movement"), Panel->LivePose(TEXT("camera-0"))->GetObjectField(TEXT("location"))->GetNumberField(TEXT("x")), 2345.5);
    FUEShedCameraAuthoringBridge::Shutdown();
    Panel->Refresh(Start + 7, .2f);
    Reopened->Poll(Start + 7, .2f);
    TestEqual(TEXT("Detach clears review grid"), Reopened->Grid->GetChildren()->Num(), 0);
    TestEqual(TEXT("Detach releases snapshots"), Reopened->Review.Num(), 0);
    return true;
}
#endif
