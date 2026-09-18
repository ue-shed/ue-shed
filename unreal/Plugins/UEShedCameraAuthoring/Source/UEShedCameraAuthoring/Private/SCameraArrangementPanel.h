#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Widgets/SCompoundWidget.h"
class SVerticalBox;

/** A replaceable native presentation of the host-owned arrangement. */
class SCameraArrangementPanel : public SCompoundWidget
{
  public:
    SLATE_BEGIN_ARGS(SCameraArrangementPanel)
    {
    }
    SLATE_EVENT(FSimpleDelegate, OnSeePreviews)
    SLATE_END_ARGS()
    void Construct(const FArguments &Args);

  private:
    friend class FUEShedCameraPreviewPanelTest;
    using FObject = TSharedPtr<FJsonObject>;
    FObject Active, Panel, Arrangement, Setup;
    TSharedPtr<SVerticalBox> CameraRows, GroupRows, ActorRows, ProposalRows, ActiveActions;
    FSimpleDelegate SeePreviews;
    TSet<FString> Selected;
    FString Scope = TEXT("arrangement"), GroupId, Message, RowKey, ActorKey, ProposalKey;
    FString VisibilityPath, VisibilityName = TEXT("Visibility preset");
    FString LayoutKind = TEXT("orbit"), RecipePath, RecipeName = TEXT("Camera recipe"), GroupName = TEXT("Group"),
            CameraName = TEXT("Camera");
    int32 InspectorPage = 0;
    bool SetupOpen = false, NewSetup = true;
    FString SetupName, CreatingId;
    TSharedRef<SWidget> BuildSetup();
    void StartSetup(bool New);
    void CreateFromPreset();
    FObject Layout() const;
    bool CommittingNumber = false;
    struct FSettingEdit
    {
        FString Field, Producer;
        FObject Scope;
        double Value = 0;
        bool Dragging = false, Dirty = false;
    };
    TOptional<FSettingEdit> SettingEdit;
    void BeginSettingDrag(const FString& Field);
    void ChangeSetting(const FString& Field, double Value, bool Final);
    void FlushSetting();
    TOptional<double> DisplaySetting(const TCHAR* Field) const;
    double ExposureEV = 10;
    double Count = 4, Start = 0, Span = 360, Dolly = 100, Height = 0, AimX = 0, AimY = 0, AimZ = 0;
    bool Retain = true, SubjectOrientation = false, RemoveRetired = false, Preview = true;
    bool Ready() const;
    FObject Request(const TCHAR *Operation) const;
    FObject Call(const FObject &Request);
    void Action(const FObject &Action);
    void SimpleAction(const TCHAR *Kind);
    FObject Command(const TCHAR *Kind) const;
    void Submit(const FObject &Command);
    FObject EditScope() const;
    TArray<FObject> ScopedCameras() const;
    TArray<TSharedPtr<FJsonValue>> SelectedIds() const;
    FObject Group() const;
    FObject LocalVisibility() const;
    TOptional<double> Effective(const TCHAR *Field) const;
    TSharedRef<SWidget> Button(const FString &Label, TFunction<void()> Action, bool NeedsReady = true, bool Compact = false);
    TSharedRef<SWidget> Number(const TCHAR *Label, double &Value);
    TSharedRef<SWidget> Input(const TCHAR *Label, FString &Value);
    TSharedRef<SWidget> Setting(const TCHAR *Label, const TCHAR *Field);
    void CaptureSelection(const TCHAR *List);
    void PreviewVisibility();
    void SelectCameras(const TArray<TSharedPtr<FJsonValue>>& Ids);
    void PilotCamera(const FString& Id);
    void SaveScope();
    void RecipeAction(bool Export);
    void RebuildCameras();
    void RebuildActors();
    EActiveTimerReturnType Refresh(double Time, float Delta);
};
