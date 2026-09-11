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
    SLATE_END_ARGS()
    void Construct(const FArguments &Args);

  private:
    using FObject = TSharedPtr<FJsonObject>;
    FObject Active, Panel, Arrangement;
    TSharedPtr<SVerticalBox> CameraRows, GroupRows, ActorRows, ProposalRows;
    TSet<FString> Selected;
    FString Scope = TEXT("arrangement"), GroupId, Message, RowKey, ActorKey, ProposalKey;
    FString VisibilityPath, VisibilityName = TEXT("Visibility preset");
    FString LayoutKind = TEXT("single"), RecipePath, RecipeName = TEXT("Camera recipe"), GroupName = TEXT("Group"),
            CameraName = TEXT("Camera");
    double ExposureEV = 10;
    double Count = 6, Start = 0, Span = 180, Dolly = 100, Height = 0, AimX = 0, AimY = 0, AimZ = 0;
    bool Retain = true, SubjectOrientation = false, RemoveRetired = false, Preview = false;
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
    TSharedRef<SWidget> Button(const FString &Label, TFunction<void()> Action, bool NeedsReady = true);
    TSharedRef<SWidget> Number(const TCHAR *Label, double &Value);
    TSharedRef<SWidget> Input(const TCHAR *Label, FString &Value);
    TSharedRef<SWidget> Setting(const TCHAR *Label, const TCHAR *Field);
    void CaptureSelection(const TCHAR *List);
    void PreviewVisibility();
    void SaveScope();
    void RecipeAction(bool Export);
    void RebuildCameras();
    void RebuildActors();
    EActiveTimerReturnType Refresh(double Time, float Delta);
};
