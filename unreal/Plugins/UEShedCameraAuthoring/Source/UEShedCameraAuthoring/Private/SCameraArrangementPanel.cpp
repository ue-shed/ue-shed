#include "SCameraArrangementPanel.h"
#include "Styling/AppStyle.h"
#include "Styling/StyleColors.h"
#include "Serialization/JsonSerializer.h"
#include "Widgets/Layout/SWidgetSwitcher.h"
#include "Framework/Application/SlateApplication.h"
#include "UEShedCameraAuthoringBridge.h"
#include "UEShedCameraVisibility.h"
#include "CameraPreviewShelf.h"
#include "CameraShotStatus.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/SOverlay.h"
#include "Editor.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SNumericEntryBox.h"
#include "Widgets/Input/SSegmentedControl.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SExpandableArea.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SUniformGridPanel.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/Layout/SWrapBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
using FObject = TSharedPtr<FJsonObject>;
FObject Obj()
{
    return MakeShared<FJsonObject>();
}
FObject Child(const FObject &O, const TCHAR *Key)
{
    const FObject *V;
    return O && O->TryGetObjectField(Key, V) ? *V : Obj();
}
bool Flag(const FObject &O, const TCHAR *Key)
{
    bool Value = false;
    if (O)
        O->TryGetBoolField(Key, Value);
    return Value;
}
FString Str(const FObject &O, const TCHAR *Key)
{
    FString V;
    if (O)
        O->TryGetStringField(Key, V);
    return V;
}
TArray<TSharedPtr<FJsonValue>> Items(const FObject &O, const TCHAR *Key)
{
    const TArray<TSharedPtr<FJsonValue>> *V;
    return O && O->TryGetArrayField(Key, V) ? *V : TArray<TSharedPtr<FJsonValue>>();
}
FString Json(const FObject &O)
{
    FString Text;
    FJsonSerializer::Serialize(O.ToSharedRef(), TJsonWriterFactory<>::Create(&Text));
    return Text;
}
TSharedRef<SWidget> Text(const FString &V)
{
    return SNew(STextBlock).Text(FText::FromString(V)).AutoWrapText(true);
}
} // namespace

bool SCameraArrangementPanel::Ready() const
{
    return Str(Active, TEXT("status")) == TEXT("ready") && Panel->HasField(TEXT("arrangement")) &&
           !Active->HasField(TEXT("panelEvent")) && !Active->GetBoolField(TEXT("pending"));
}
SCameraArrangementPanel::FObject SCameraArrangementPanel::Request(const TCHAR *Op) const
{
    auto R = Obj();
    R->SetNumberField(TEXT("version"), 1);
    R->SetStringField(TEXT("operation"), Op);
    R->SetStringField(TEXT("sessionId"), Str(Active, TEXT("sessionId")));
    R->SetStringField(TEXT("producerId"), Str(Active, TEXT("producerId")));
    return R;
}
SCameraArrangementPanel::FObject SCameraArrangementPanel::Call(const FObject &Q)
{
    const auto R = FUEShedCameraAuthoringBridge::Execute(Q);
    Message = Str(R, TEXT("message"));
    return R;
}
void SCameraArrangementPanel::Action(const FObject &A)
{
    auto Q = Request(TEXT("enqueue"));
    Q->SetObjectField(TEXT("action"), A);
    Call(Q);
}
void SCameraArrangementPanel::SimpleAction(const TCHAR *Kind)
{
    auto A = Obj();
    A->SetStringField(TEXT("kind"), Kind);
    Action(A);
}
void SCameraArrangementPanel::SelectCameras(const TArray<TSharedPtr<FJsonValue>>& Ids)
{
    auto Q = Request(TEXT("select_cameras"));
    Q->SetArrayField(TEXT("cameraIds"), Ids);
    const auto Result = Call(Q);
    if (Str(Result, TEXT("status")) == TEXT("ready")) Active = Result;
}
void SCameraArrangementPanel::SetCameraSelected(const FString& Id, bool Checked)
{
    SettingEdit.Reset();
    Scope = TEXT("cameras");
    if (Checked) Selected.Add(Id);
    else Selected.Remove(Id);
    ActorKey.Reset();
    SelectCameras(SelectedIds());
}
void SCameraArrangementPanel::StopPiloting()
{
    // Keep the snapshot current so an immediate Select frames instead of piloting again.
    const auto Result = Call(Request(TEXT("eject")));
    if (Str(Result, TEXT("status")) == TEXT("ready")) Active = Result;
}
void SCameraArrangementPanel::FocusCamera(const FString& Id)
{
    // While piloting, the viewport already looks through a camera: switch it to this one.
    if (Flag(Active, TEXT("piloting")))
    {
        PilotCamera(Id);
        return;
    }
    Selected.Reset();
    Selected.Add(Id);
    Scope = TEXT("cameras");
    ActorKey.Reset();
    SelectCameras({MakeShared<FJsonValueString>(Id)});
    // Otherwise behave like pressing F: frame the camera and its subject, leaving the viewport free.
    auto* Camera = FUEShedCameraAuthoringBridge::Camera(Id);
    if (!Camera || !GEditor) return;
    TArray<AActor*> Framed{Camera};
    if (auto* Subject = UEShedResolveCameraActor(Camera->GetWorld(), Child(Arrangement, TEXT("subject"))))
        Framed.Add(Subject);
    GEditor->MoveViewportCamerasToActor(Framed, true);
}
void SCameraArrangementPanel::PilotCamera(const FString& Id)
{
    auto Q = Request(TEXT("pilot_camera"));
    Q->SetStringField(TEXT("cameraId"), Id);
    const auto Result = Call(Q);
    if (Str(Result, TEXT("status")) == TEXT("ready"))
    {
        Active = Result;
        Selected.Reset();
        Selected.Add(Id);
        Scope = TEXT("cameras");
    }
    PreviewVisibility();
}
SCameraArrangementPanel::FObject SCameraArrangementPanel::Command(const TCHAR *Kind) const
{
    auto C = Obj();
    C->SetStringField(TEXT("kind"), Kind);
    C->SetStringField(TEXT("arrangementId"), Str(Arrangement, TEXT("id")));
    C->SetNumberField(TEXT("expectedRevision"), Arrangement->GetNumberField(TEXT("revision")));
    C->SetStringField(TEXT("operationId"), TEXT("menu-pending"));
    return C;
}
void SCameraArrangementPanel::Submit(const FObject &C)
{
    auto A = Obj();
    A->SetStringField(TEXT("kind"), TEXT("command"));
    A->SetObjectField(TEXT("command"), C);
    Action(A);
}
TArray<TSharedPtr<FJsonValue>> SCameraArrangementPanel::SelectedIds() const
{
    TArray<TSharedPtr<FJsonValue>> R;
    for (const auto &V : Items(Arrangement, TEXT("cameras")))
        if (Selected.Contains(Str(V->AsObject(), TEXT("id"))))
            R.Add(MakeShared<FJsonValueString>(Str(V->AsObject(), TEXT("id"))));
    return R;
}
SCameraArrangementPanel::FObject SCameraArrangementPanel::EditScope() const
{
    auto S = Obj();
    S->SetStringField(TEXT("kind"), Scope);
    if (Scope == TEXT("group"))
        S->SetStringField(TEXT("groupId"), GroupId);
    if (Scope == TEXT("cameras"))
        S->SetArrayField(TEXT("cameraIds"), SelectedIds());
    return S;
}
TArray<SCameraArrangementPanel::FObject> SCameraArrangementPanel::ScopedCameras() const
{
    TArray<FObject> R;
    for (const auto &V : Items(Arrangement, TEXT("cameras")))
    {
        const auto C = V->AsObject();
        if (Scope == TEXT("arrangement") || (Scope == TEXT("group") && Str(C, TEXT("groupId")) == GroupId) ||
            (Scope == TEXT("cameras") && Selected.Contains(Str(C, TEXT("id")))))
            R.Add(C);
    }
    return R;
}
double SCameraArrangementPanel::PositionDragSpan() const
{
    const auto Extent = Child(Child(Arrangement, TEXT("bounds")), TEXT("extent"));
    double Size = 0;
    for (const TCHAR* Axis : {TEXT("x"), TEXT("y"), TEXT("z")})
    {
        double Value = 0;
        if (Extent->TryGetNumberField(Axis, Value) && FMath::IsFinite(Value))
            Size = FMath::Max(Size, FMath::Abs(Value));
    }
    // One field-width drag covers the subject's longest dimension, at any existing offset.
    return Size > 0 && Size < DBL_MAX / 2 ? Size * 2 : 100.;
}
bool SCameraArrangementPanel::HasManualCamera() const
{
    for (const auto& Camera : ScopedCameras())
        if (Camera->HasField(TEXT("manualPose"))) return true;
    return false;
}
SCameraArrangementPanel::FObject SCameraArrangementPanel::LivePose(const FString& Id) const
{
    // Native observations remain current even while the host is saving the draft.
    for (const auto& Value : Items(Active, TEXT("cameras")))
        if (Str(Value->AsObject(), TEXT("id")) == Id)
            return Child(Value->AsObject(), TEXT("pose"));
    for (const auto& Value : Items(Arrangement, TEXT("cameras")))
        if (Str(Value->AsObject(), TEXT("id")) == Id)
            return Child(Value->AsObject(), TEXT("manualPose"));
    return Obj();
}
void SCameraArrangementPanel::RebuildManualRows()
{
    FString Key = Json(EditScope());
    for (const auto& Camera : ScopedCameras())
        if (Camera->HasField(TEXT("manualPose"))) Key += Str(Camera, TEXT("id")) + TEXT(":") + Str(Camera, TEXT("displayName")) + TEXT(";");
    if (Key == ManualRowsKey) return;
    ManualRowsKey = Key;
    ManualRows->ClearChildren();
    for (const auto& Camera : ScopedCameras())
    {
        if (!Camera->HasField(TEXT("manualPose"))) continue;
        const FString Id = Str(Camera, TEXT("id"));
        auto Grid = SNew(SUniformGridPanel).SlotPadding(FMargin(4));
        ManualRows->AddSlot().AutoHeight().Padding(0, 8, 0, 2)[Text(Str(Camera, TEXT("displayName")) + TEXT(" · Manual position"))];
        ManualRows->AddSlot().AutoHeight()[Text(TEXT("World position (cm)"))];
        ManualRows->AddSlot().AutoHeight()[Grid];
        for (int32 Index = 0; Index < 6; ++Index)
        {
            const FString Field = Index == 0 ? TEXT("x") : Index == 1 ? TEXT("y") : Index == 2 ? TEXT("z") :
                Index == 3 ? TEXT("pitch") : Index == 4 ? TEXT("yaw") : TEXT("roll");
            const FString Group = Index < 3 ? TEXT("location") : TEXT("rotation");
            Grid->AddSlot(Index % 3, Index / 3)[SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight()[Text(Index < 3 ? Field.ToUpper() : Field + TEXT(" (°)"))]
                + SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).Text_Lambda([this, Id, Field, Group] {
                    double Value = 0;
                    if (!Child(LivePose(Id), *Group)->TryGetNumberField(Field, Value)) return FText::FromString(TEXT("—"));
                    return FText::FromString(FString::Printf(TEXT("%.2f"), Value));
                })]];
        }
    }
}
bool SCameraArrangementPanel::CanAdjust(const FString& Field) const
{
    const auto Cameras = ScopedCameras();
    if (Cameras.IsEmpty()) return false;
    if (Field == TEXT("fieldOfViewDegrees")) return true;
    for (const auto& Camera : Cameras)
        if (!Camera->HasField(TEXT("manualPose"))) return true;
    return false;
}
void SCameraArrangementPanel::RestoreFittedCamera()
{
    const auto Cameras = ScopedCameras();
    if (!Ready() || Cameras.Num() != 1 || !Cameras[0]->HasField(TEXT("manualPose"))) return;
    auto C = Command(TEXT("unpin"));
    C->SetStringField(TEXT("cameraId"), Str(Cameras[0], TEXT("id")));
    Submit(C);
}
SCameraArrangementPanel::FObject SCameraArrangementPanel::Group() const
{
    for (const auto &V : Items(Arrangement, TEXT("groups")))
        if (Str(V->AsObject(), TEXT("id")) == GroupId)
            return V->AsObject();
    return Obj();
}
SCameraArrangementPanel::FObject SCameraArrangementPanel::LocalVisibility() const
{
    const auto Cs = ScopedCameras();
    return Scope == TEXT("arrangement") ? Child(Arrangement, TEXT("visibility"))
           : Scope == TEXT("group")     ? Child(Group(), TEXT("visibility"))
           : Cs.Num() == 1              ? Child(Cs[0], TEXT("visibility"))
                                        : Obj();
}
TOptional<double> SCameraArrangementPanel::Effective(const TCHAR *Field) const
{
    TOptional<double> Common;
    for (const auto &C : ScopedCameras())
    {
        if (FString(Field) != TEXT("fieldOfViewDegrees") && C->HasField(TEXT("manualPose"))) continue;
        double V = 0;
        Child(Arrangement, TEXT("settings"))->TryGetNumberField(Field, V);
        if (Scope != TEXT("arrangement"))
            for (const auto &G : Items(Arrangement, TEXT("groups")))
                if (Str(G->AsObject(), TEXT("id")) == Str(C, TEXT("groupId")))
                    Child(G->AsObject(), TEXT("overrides"))->TryGetNumberField(Field, V);
        if (Scope == TEXT("cameras"))
            Child(C, TEXT("overrides"))->TryGetNumberField(Field, V);
        if (Common.IsSet() && !FMath::IsNearlyEqual(Common.GetValue(), V))
            return {};
        Common = V;
    }
    return Common;
}
TSharedRef<SWidget> SCameraArrangementPanel::Button(const FString &Label, TFunction<void()> Fn, bool NeedsReady, bool Compact)
{
    return SNew(SButton)
        .ButtonStyle(FAppStyle::Get(), "Button")
        .ContentPadding(Compact ? FMargin(6, 3) : FMargin(10, 6))
        .Text(FText::FromString(Label))
        .IsEnabled_Lambda([this, NeedsReady] { return !NeedsReady || Ready(); })
        .OnClicked_Lambda([Fn] {
            Fn();
            return FReply::Handled();
        });
}
TSharedRef<SWidget> SCameraArrangementPanel::Number(const TCHAR *Label, double &Value, bool ArcSpan, bool Position)
{
    return SNew(SVerticalBox) + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 3)[Text(Label)] +
           SVerticalBox::Slot().AutoHeight()[SNew(SNumericEntryBox<double>)
                      .AllowSpin(true).Delta(Position ? .01 : 1).LinearDeltaSensitivity(5)
                      .MinValue(ArcSpan ? TOptional<double>(0) : TOptional<double>())
                      .MaxValue(ArcSpan ? TOptional<double>(360) : TOptional<double>())
                      .MinSliderValue_Lambda([this, &Value, ArcSpan, Position] { return Position ? TOptional<double>(Value - PositionDragSpan() / 2) : ArcSpan ? TOptional<double>(0) : TOptional<double>(); })
                      .MaxSliderValue_Lambda([this, &Value, ArcSpan, Position] { return Position ? TOptional<double>(Value + PositionDragSpan() / 2) : ArcSpan ? TOptional<double>(360) : TOptional<double>(); })
                      .MaxFractionalDigits(2)
                      .ToolTipText(FText::FromString(TEXT("Drag to adjust; Ctrl for finer steps, Shift for larger steps. Click to type an exact value.")))
                      .Value_Lambda([&Value] { return Value; })
                      .OnValueChanged_Lambda([&Value, ArcSpan](double V) { if (FMath::IsFinite(V)) Value = ArcSpan ? FMath::Clamp(V, 0., 360.) : V; })
                      .OnValueCommitted_Lambda([&Value, ArcSpan](double V, ETextCommit::Type) { if (FMath::IsFinite(V)) Value = ArcSpan ? FMath::Clamp(V, 0., 360.) : V; })];
}
TSharedRef<SWidget> SCameraArrangementPanel::Input(const TCHAR *Label, FString &Value)
{
    return SNew(SEditableTextBox)
        .HintText(FText::FromString(Label))
        .Text(FText::FromString(Value))
        .OnTextChanged_Lambda([&Value](const FText &T) { Value = T.ToString(); });
}
TSharedRef<SWidget> SCameraArrangementPanel::Setting(const TCHAR *Label, const TCHAR *Field)
{
    const FString Name(Field);
    const TOptional<double> Minimum = Name == TEXT("fieldOfViewDegrees") ? TOptional<double>(5) :
        Name == TEXT("distanceScale") ? TOptional<double>(.01) : Name == TEXT("margin") ? TOptional<double>(0) :
        Name == TEXT("elevationDegrees") ? TOptional<double>(-89) : TOptional<double>();
    const TOptional<double> Maximum = Name == TEXT("fieldOfViewDegrees") ? TOptional<double>(170) :
        Name == TEXT("distanceScale") ? TOptional<double>(100) : Name == TEXT("margin") ? TOptional<double>(.45) :
        Name == TEXT("elevationDegrees") ? TOptional<double>(89) : TOptional<double>();
    // Margin is stored as a fraction of the frame per side; designers read and type it as a percentage.
    const double Scale = Name == TEXT("margin") ? 100. : 1.;
    const auto Scaled = [Scale](TOptional<double> V) { return V.IsSet() ? TOptional<double>(V.GetValue() * Scale) : V; };
    auto ValueRow = SNew(SHorizontalBox);
    ValueRow->AddSlot().FillWidth(1)[SNew(SNumericEntryBox<double>)
                      .AllowSpin(true).MinValue(Scaled(Minimum)).MaxValue(Scaled(Maximum))
                      .MinSliderValue_Lambda([this, Field, Name, Minimum, Scaled] { return Name == TEXT("heightOffset") ? TOptional<double>(DisplaySetting(Field).Get(0) - PositionDragSpan() / 2) : Name == TEXT("distanceScale") ? TOptional<double>(.25) : Name == TEXT("fieldOfViewDegrees") ? TOptional<double>(30) : Name == TEXT("elevationDegrees") ? TOptional<double>(-45) : Scaled(Minimum); })
                      .MaxSliderValue_Lambda([this, Field, Name, Maximum, Scaled] { return Name == TEXT("heightOffset") ? TOptional<double>(DisplaySetting(Field).Get(0) + PositionDragSpan() / 2) : Name == TEXT("distanceScale") ? TOptional<double>(3) : Name == TEXT("fieldOfViewDegrees") ? TOptional<double>(100) : Name == TEXT("elevationDegrees") ? TOptional<double>(45) : Scaled(Maximum); })
                      .Delta(Name == TEXT("distanceScale") || Name == TEXT("heightOffset") ? .01 : Name == TEXT("margin") ? .5 : .1)
                      .LinearDeltaSensitivity(5).MinFractionalDigits(1).MaxFractionalDigits(3)
                      .ToolTipText(FText::FromString(Name == TEXT("distanceScale")
                          ? TEXT("Multiplier of the distance needed to fit the subject: 1 fits, 2 is twice as far. Drag 0.25–3; type 0.01–100. Ctrl for finer steps.")
                          : Name == TEXT("heightOffset") ? TEXT("Vertical offset in centimeters. A field-width drag covers about one subject length. Ctrl for finer steps; Shift for larger moves. Click to type exactly.")
                          : Name == TEXT("margin") ? TEXT("Empty space kept on each side of the subject, as a percentage of the frame: 12 leaves 12% on every side. Range 0–45. Ctrl for finer steps.")
                          : TEXT("Drag to adjust; Ctrl for finer steps, Shift for larger steps. Click to type an exact value.")))
                      .UndeterminedString(FText::FromString(TEXT("Mixed")))
                      .IsEnabled_Lambda([this, Name] { return (Ready() || (SettingEdit && SettingEdit->Field == Name)) && CanAdjust(Name); })
                      .Value_Lambda([this, Field, Scaled] { return Scaled(DisplaySetting(Field)); })
                      .OnBeginSliderMovement_Lambda([this, Name] { BeginSettingDrag(Name); })
                      .OnValueChanged_Lambda([this, Name, Scale](double V) {
                          if (SettingEdit && SettingEdit->Dragging && SettingEdit->Field == Name) ChangeSetting(Name, V / Scale, false);
                      })
                      .OnEndSliderMovement_Lambda([this, Name, Scale](double V) {
                          if (SettingEdit && SettingEdit->Dragging && SettingEdit->Field == Name) ChangeSetting(Name, V / Scale, true);
                      })
                      .OnValueCommitted_Lambda([this, Field, Scale](double V, ETextCommit::Type T) {
                          if (T == ETextCommit::OnCleared || CommittingNumber || (SettingEdit && SettingEdit->Dragging))
                              return;
                          TGuardValue<bool> CommitGuard(CommittingNumber, true);
                          if (T == ETextCommit::OnEnter)
                              FSlateApplication::Get().ClearKeyboardFocus(EFocusCause::Cleared);
                          ChangeSetting(Field, V / Scale, true);
                      })];
    ValueRow->AddSlot().AutoWidth()[SNew(SBox).IsEnabled_Lambda([this, Name] { return CanAdjust(Name); }).ToolTipText(FText::FromString(TEXT("Reset to inherited value"))).Visibility_Lambda([this] { return Scope == TEXT("arrangement") ? EVisibility::Collapsed : EVisibility::Visible; })[Button(TEXT("↶"), [this, Field] {
               if (!CanAdjust(Field)) return;
               if (Scope == TEXT("arrangement"))
               {
                   Message = TEXT("The whole set has no inherited value to return to. Choose cameras or a group first.");
                   return;
               }
               auto C = Command(TEXT("batch"));
               C->SetObjectField(TEXT("scope"), EditScope());
               C->SetObjectField(TEXT("settings"), Obj());
               C->SetArrayField(TEXT("resetFields"), {MakeShared<FJsonValueString>(Field)});
               Submit(C);
           })]];
    return SNew(SVerticalBox) + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 3)[Text(Label)] +
        SVerticalBox::Slot().AutoHeight()[ValueRow];
}

TOptional<double> SCameraArrangementPanel::DisplaySetting(const TCHAR* Field) const
{
    if (!SettingEdit && FString(Field) == TEXT("fieldOfViewDegrees") && HasManualCamera())
    {
        TOptional<double> Common;
        for (const auto& Camera : ScopedCameras())
        {
            double Value = 0;
            if (!LivePose(Str(Camera, TEXT("id")))->TryGetNumberField(Field, Value)) return Effective(Field);
            if (Common.IsSet() && !FMath::IsNearlyEqual(Common.GetValue(), Value)) return {};
            Common = Value;
        }
        return Common;
    }
    return SettingEdit && SettingEdit->Field == Field ? TOptional<double>(SettingEdit->Value) : Effective(Field);
}
void SCameraArrangementPanel::BeginSettingDrag(const FString& Field)
{
    if (!Ready() || !CanAdjust(Field)) return;
    SettingEdit = FSettingEdit{Field, Str(Active, TEXT("producerId")), EditScope(), Effective(*Field).Get(0), true, false};
}
void SCameraArrangementPanel::ChangeSetting(const FString& Field, double Value, bool Final)
{
    if (!FMath::IsFinite(Value) || !CanAdjust(Field)) return;
    if (Field == TEXT("fieldOfViewDegrees")) Value = FMath::Clamp(Value, 5., 170.);
    if (Field == TEXT("distanceScale")) Value = FMath::Clamp(Value, .01, 100.);
    if (Field == TEXT("margin")) Value = FMath::Clamp(Value, 0., .45);
    if (Field == TEXT("elevationDegrees")) Value = FMath::Clamp(Value, -89., 89.);
    if (!SettingEdit)
    {
        if (!Ready() || ScopedCameras().IsEmpty()) return;
        SettingEdit = FSettingEdit{Field, Str(Active, TEXT("producerId")), EditScope(), Value, false, false};
    }
    if (SettingEdit->Field != Field) return;
    SettingEdit->Value = Value;
    SettingEdit->Dirty = true;
    if (Final) { SettingEdit->Dragging = false; FlushSetting(); }
}
void SCameraArrangementPanel::FlushSetting()
{
    if (!SettingEdit) return;
    if (!CanAdjust(SettingEdit->Field) || SettingEdit->Producer != Str(Active, TEXT("producerId")) || Json(SettingEdit->Scope) != Json(EditScope()))
    {
        SettingEdit.Reset();
        Message = TEXT("Value adjustment stopped because the camera placement, selection or session changed.");
        return;
    }
    if (!Ready()) return;
    if (!SettingEdit->Dirty)
    {
        if (!SettingEdit->Dragging) SettingEdit.Reset();
        return;
    }
    auto C = Command(TEXT("batch")), S = Obj(), A = Obj(), Q = Request(TEXT("enqueue"));
    S->SetNumberField(SettingEdit->Field, SettingEdit->Value);
    C->SetObjectField(TEXT("scope"), SettingEdit->Scope);
    C->SetObjectField(TEXT("settings"), S);
    C->SetArrayField(TEXT("resetFields"), {});
    A->SetStringField(TEXT("kind"), TEXT("command"));
    A->SetObjectField(TEXT("command"), C);
    Q->SetObjectField(TEXT("action"), A);
    const auto Result = Call(Q);
    if (Str(Result, TEXT("status")) == TEXT("ready")) { Active = Result; SettingEdit->Dirty = false; }
    else SettingEdit.Reset();
}

void SCameraArrangementPanel::Construct(const FArguments &Args)
{
    Active = Obj();
    Panel = Obj();
    Arrangement = Obj();
    Setup = FUEShedCameraAuthoringBridge::InspectSetup();
    SeePreviews = Args._OnSeePreviews;
    auto Shell = SNew(SVerticalBox);
    ChildSlot[SNew(SBox).Padding(12).MinDesiredWidth(560)[Shell]];
    auto Header = SNew(SHorizontalBox);
    Header->AddSlot().FillWidth(1)[SNew(STextBlock)
        .Font(FAppStyle::GetFontStyle("NormalFontBold")).AutoWrapText(true)
        .Text_Lambda([this] {
            const FString Name = Str(Arrangement, TEXT("displayName"));
            return FText::FromString(Name.IsEmpty() ? TEXT("Camera sets") : Name);
        })];
    Header->AddSlot().AutoWidth().Padding(8, 0)[SNew(SBox)
        .Visibility_Lambda([this] { return Panel->HasField(TEXT("arrangement")) && !SetupOpen ? EVisibility::Visible : EVisibility::Collapsed; })
        [Button(TEXT("New set…"), [this] { StartSetup(true); }, false)]];
    Header->AddSlot().AutoWidth()[SNew(SBox)
        .Visibility_Lambda([this] { return Panel->HasField(TEXT("arrangement")) && !SetupOpen ? EVisibility::Visible : EVisibility::Collapsed; })
        [Button(TEXT("Change preset…"), [this] { StartSetup(false); })]];
    Shell->AddSlot().AutoHeight().Padding(0, 0, 0, 6)[Header];
    Shell->AddSlot().AutoHeight().Padding(0, 0, 0, 12)[SNew(STextBlock).AutoWrapText(true)
        .Text_Lambda([this] {
            if (!Panel->HasField(TEXT("arrangement"))) return FText::FromString(TEXT("Choose an actor and a preset to begin."));
            const int32 N = Items(Arrangement, TEXT("cameras")).Num();
            return FText::FromString(FString::Printf(TEXT("%d camera%s  ·  %s"), N, N == 1 ? TEXT("") : TEXT("s"),
                Ready() ? TEXT("Changes saved automatically") : TEXT("Syncing changes…")));
        })];
    auto Root = SNew(SWidgetSwitcher).WidgetIndex_Lambda([this] { return SetupOpen || !Panel->HasField(TEXT("arrangement")) ? 0 : 1; });
    Shell->AddSlot().FillHeight(1)[Root];
    Root->AddSlot()[SNew(SScrollBox) + SScrollBox::Slot()[BuildSetup()]];
    auto Editing = SNew(SVerticalBox);
    auto Inspector = SNew(SVerticalBox);
    Root->AddSlot()[SNew(SSplitter).PhysicalSplitterHandleSize(6)
        + SSplitter::Slot().Value(.34f).MinSize(180)[SNew(SBox).Padding(0, 0, 8, 0)[Editing]]
        + SSplitter::Slot().Value(.66f).MinSize(320)[Inspector]];
    auto Toolbar = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(4, 4));
    Toolbar->AddSlot()[Button(TEXT("Select all"), [this] {
        Scope = TEXT("cameras");
        TArray<TSharedPtr<FJsonValue>> Ids;
        for (const auto& Camera : Items(Arrangement, TEXT("cameras")))
            Ids.Add(MakeShared<FJsonValueString>(Str(Camera->AsObject(), TEXT("id"))));
        SelectCameras(Ids);
    }, false)];
    Toolbar->AddSlot()[SNew(SBox).Visibility_Lambda([this] { return Flag(Active, TEXT("piloting")) ? EVisibility::Visible : EVisibility::Collapsed; })
        [Button(TEXT("Stop piloting"), [this] { StopPiloting(); }, false)]];
    Editing->AddSlot().AutoHeight().Padding(0, 0, 0, 8)[Toolbar];
    Editing->AddSlot().FillHeight(1)[SNew(SScrollBox) + SScrollBox::Slot()[SAssignNew(CameraRows, SVerticalBox)]];
    Editing->AddSlot().AutoHeight().Padding(0, 8, 0, 0)[SNew(STextBlock).AutoWrapText(true)
        .Text(FText::FromString(TEXT("Select frames a camera and its subject in the viewport. Pilot to look through it.")))];
    auto Tools = SNew(SVerticalBox);
    Inspector->AddSlot().AutoHeight().Padding(0, 0, 0, 6)[SNew(SSegmentedControl<FString>)
        .Value_Lambda([this] { return Scope; })
        .OnValueChanged_Lambda([this](FString Value) { Scope = Value; ActorKey.Reset(); })
        + SSegmentedControl<FString>::Slot(TEXT("arrangement")).Text(FText::FromString(TEXT("Whole set")))
        + SSegmentedControl<FString>::Slot(TEXT("cameras")).Text(FText::FromString(TEXT("Selected cameras")))];
    Inspector->AddSlot().AutoHeight().Padding(0, 0, 0, 8)[SNew(STextBlock).Text_Lambda([this] {
        return FText::FromString(Scope == TEXT("arrangement") ? TEXT("Editing the whole set") :
            Scope == TEXT("group") ? TEXT("Editing group: ") + Str(Group(), TEXT("name")) : SelectionSummary(Selected.Num()));
    })];
    auto Tabs = SNew(SHorizontalBox);
    auto Pages = SNew(SWidgetSwitcher).WidgetIndex_Lambda([this] { return InspectorPage; });
    Inspector->AddSlot().AutoHeight()[Tabs];
    Inspector->AddSlot().FillHeight(1)[SNew(SBorder).BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder")).Padding(10)
        [SNew(SScrollBox) + SScrollBox::Slot()[Pages]]];
    TSharedRef<SVerticalBox> SectionBody = Tools;
    int32 PageIndex = 0;
    auto Page = [&Tabs, &Pages, &SectionBody, &PageIndex, this](const TCHAR* Title) {
        const int32 Index = PageIndex++;
        Tabs->AddSlot().AutoWidth().Padding(0, 0, 2, 0)[SNew(SCheckBox)
            .Style(FAppStyle::Get(), "ToolPalette.DockingTab").Padding(FMargin(0))
            .IsChecked_Lambda([this, Index] { return InspectorPage == Index ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
            .OnCheckStateChanged_Lambda([this, Index](ECheckBoxState State) { if (State == ECheckBoxState::Checked) InspectorPage = Index; })
            [SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(12, 8)[Text(Title)]
                + SVerticalBox::Slot().AutoHeight()[SNew(SBox).HeightOverride(2)
                    [SNew(SBorder).Padding(0).BorderImage(FAppStyle::GetBrush("WhiteBrush"))
                        .BorderBackgroundColor_Lambda([this, Index] { return InspectorPage == Index ? FStyleColors::Primary : FSlateColor(FLinearColor::Transparent); })]]]];
        SectionBody = SNew(SVerticalBox);
        Pages->AddSlot()[SectionBody];
    };
    auto Add = [&SectionBody](TSharedRef<SWidget> W) { SectionBody->AddSlot().AutoHeight().Padding(0, 4)[W]; };
    auto Section = [&SectionBody](const TCHAR *Title, bool Expanded = false) {
        auto Parent = SectionBody;
        SectionBody = SNew(SVerticalBox);
        Parent->AddSlot().AutoHeight().Padding(0, 6)[SNew(SExpandableArea).InitiallyCollapsed(!Expanded).HeaderContent()[Text(Title)].BodyContent()[SectionBody]];
    };
    Page(TEXT("Framing"));
    auto Framing = SectionBody;
    auto Fields = SNew(SUniformGridPanel).SlotPadding(FMargin(4, 4));
    FittedFields = Fields;
    Fields->SetVisibility(TAttribute<EVisibility>::CreateLambda([this] { return CanAdjust(TEXT("distanceScale")) ? EVisibility::Visible : EVisibility::Collapsed; }));
    Add(Fields);
    Add(SNew(STextBlock).ColorAndOpacity(FSlateColor::UseSubduedForeground()).AutoWrapText(true)
        .Visibility_Lambda([this] { return CanAdjust(TEXT("distanceScale")) ? EVisibility::Visible : EVisibility::Collapsed; })
        .Text(FText::FromString(TEXT("Drag to adjust · Ctrl for precision · click to type"))));
    auto Manual = SNew(SVerticalBox).Visibility_Lambda([this] { return HasManualCamera() ? EVisibility::Visible : EVisibility::Collapsed; });
    Manual->AddSlot().AutoHeight()[SAssignNew(ManualRows, SVerticalBox)];
    Manual->AddSlot().AutoHeight().Padding(0, 8)[SNew(SBox)
        .Visibility_Lambda([this] { return CanAdjust(TEXT("distanceScale")) ? EVisibility::Collapsed : EVisibility::Visible; })
        [Setting(TEXT("FOV (°)"), TEXT("fieldOfViewDegrees"))]];
    Manual->AddSlot().AutoHeight()[Text(TEXT("Live from Unreal · Pilot or use the viewport / Details to change the pose."))];
    Add(Manual);
    Add(SNew(STextBlock).AutoWrapText(true)
        .Visibility_Lambda([this] { return ScopedCameras().Num() > 1 && HasManualCamera() ? EVisibility::Visible : EVisibility::Collapsed; })
        .Text(FText::FromString(TEXT("Framing and aim adjust fitted cameras; manual cameras keep their poses. FOV applies to the whole scope. Select one manual camera to restore fitted placement."))));
    Add(SNew(SBox).Visibility_Lambda([this] { return ScopedCameras().Num() == 1 && !CanAdjust(TEXT("distanceScale")) ? EVisibility::Visible : EVisibility::Collapsed; })
        .ToolTipText(FText::FromString(TEXT("Moves this camera back to its fitted position around the subject and enables framing controls.")))
        [Button(TEXT("Restore fitted position"), [this] { RestoreFittedCamera(); })]);
    Section(TEXT("Groups"));
    Add(SAssignNew(GroupRows, SVerticalBox));
    Add(Button(TEXT("Add selection to group"), [this] {
        if (Scope != TEXT("group") || !Group() || Selected.IsEmpty())
        {
            Message = TEXT("Choose a group and select cameras first.");
            return;
        }
        auto C = Command(TEXT("group"));
        C->SetObjectField(TEXT("group"), Group());
        C->SetArrayField(TEXT("cameraIds"), SelectedIds());
        Submit(C);
    }));
    Add(Input(TEXT("Group name"), GroupName));
    Add(Button(TEXT("Create group"), [this] {
        auto C = Command(TEXT("group")), G = Obj();
        G->SetStringField(TEXT("id"), TEXT("group-") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
        G->SetStringField(TEXT("name"), GroupName);
        G->SetObjectField(TEXT("overrides"), Obj());
        C->SetObjectField(TEXT("group"), G);
        C->SetArrayField(TEXT("cameraIds"), SelectedIds());
        Submit(C);
    }));
    SectionBody = Framing;
    int32 FieldIndex = 0;
    for (const auto &P : TArray<TPair<FString, FString>>{{TEXT("FOV (°)"), TEXT("fieldOfViewDegrees")},
                                                         {TEXT("Distance (1 = fits subject)"), TEXT("distanceScale")},
                                                         {TEXT("Height (cm)"), TEXT("heightOffset")},
                                                         {TEXT("Elevation (°)"), TEXT("elevationDegrees")},
                                                         {TEXT("Yaw (°)"), TEXT("yawOffset")},
                                                         {TEXT("Margin (% per side)"), TEXT("margin")}})
    {
        // Stable literal storage: Setting callbacks retain field strings via static interned names below.
        const TCHAR *Field = P.Value == TEXT("fieldOfViewDegrees") ? TEXT("fieldOfViewDegrees")
                             : P.Value == TEXT("distanceScale")    ? TEXT("distanceScale")
                             : P.Value == TEXT("heightOffset")     ? TEXT("heightOffset")
                             : P.Value == TEXT("elevationDegrees") ? TEXT("elevationDegrees")
                             : P.Value == TEXT("yawOffset")        ? TEXT("yawOffset")
                                                                   : TEXT("margin");
        Fields->AddSlot(FieldIndex % 2, FieldIndex / 2)[Setting(*P.Key, Field)];
        ++FieldIndex;
    }
    Section(TEXT("Camera actions"));
    Add(Button(TEXT("Add camera from viewport"), [this] {
        const auto R = Call(Request(TEXT("viewport_pose")));
        if (Str(R, TEXT("status")) != TEXT("viewport_pose")) return;
        auto A = Obj();
        A->SetStringField(TEXT("kind"), TEXT("add_viewport"));
        A->SetObjectField(TEXT("pose"), Child(R, TEXT("pose")));
        Action(A);
    }));
    Add(SAssignNew(ActiveActions, SVerticalBox));
    SectionBody = Framing;
    Section(TEXT("Aim and placement"));
    auto AimFields = SNew(SUniformGridPanel).SlotPadding(FMargin(4, 4));
    AimFields->SetVisibility(TAttribute<EVisibility>::CreateLambda([this] { return CanAdjust(TEXT("aimOffset")) ? EVisibility::Visible : EVisibility::Collapsed; }));
    AimFields->SetEnabled(TAttribute<bool>::CreateLambda([this] { return Ready() && CanAdjust(TEXT("aimOffset")); }));
    AimFields->AddSlot(0, 0)[Number(TEXT("Aim X (cm)"), AimX, false, true)];
    AimFields->AddSlot(1, 0)[Number(TEXT("Aim Y (cm)"), AimY, false, true)];
    AimFields->AddSlot(0, 1)[Number(TEXT("Aim Z (cm)"), AimZ, false, true)];
    Add(AimFields);
    auto AimActions = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(4, 4));
    AimActions->SetVisibility(TAttribute<EVisibility>::CreateLambda([this] { return CanAdjust(TEXT("aimOffset")) ? EVisibility::Visible : EVisibility::Collapsed; }));
    AimActions->SetEnabled(TAttribute<bool>::CreateLambda([this] { return Ready() && CanAdjust(TEXT("aimOffset")); }));
    Add(AimActions);
    AimActions->AddSlot()[Button(TEXT("Apply aim offset"), [this] {
        if (!CanAdjust(TEXT("aimOffset"))) return;
        auto C = Command(TEXT("batch")), S = Obj(), V = Obj();
        V->SetNumberField(TEXT("x"), AimX);
        V->SetNumberField(TEXT("y"), AimY);
        V->SetNumberField(TEXT("z"), AimZ);
        S->SetObjectField(TEXT("aimOffset"), V);
        C->SetObjectField(TEXT("settings"), S);
        C->SetObjectField(TEXT("scope"), EditScope());
        C->SetArrayField(TEXT("resetFields"), {});
        Submit(C);
    })];
    AimActions->AddSlot()[Button(TEXT("Reset"), [this] {
        if (!CanAdjust(TEXT("aimOffset"))) return;
        if (Scope == TEXT("arrangement"))
        {
            Message = TEXT("The whole set has no inherited aim to return to. Set an aim offset instead.");
            return;
        }
        auto C = Command(TEXT("batch"));
        C->SetObjectField(TEXT("settings"), Obj());
        C->SetObjectField(TEXT("scope"), EditScope());
        C->SetArrayField(TEXT("resetFields"), {MakeShared<FJsonValueString>(TEXT("aimOffset"))});
        Submit(C);
    })];
    auto Moves = SNew(SUniformGridPanel).SlotPadding(FMargin(4, 4));
    Moves->AddSlot(0, 0)[Number(TEXT("Dolly (cm)"), Dolly, false, true)];
    Moves->AddSlot(1, 0)[Number(TEXT("World Z (cm)"), Height, false, true)];
    Add(Moves);
    Add(Button(TEXT("Move cameras"), [this] {
        auto C = Command(TEXT("nudge")), V = Obj();
        V->SetNumberField(TEXT("x"), 0);
        V->SetNumberField(TEXT("y"), 0);
        V->SetNumberField(TEXT("z"), Height);
        C->SetObjectField(TEXT("translation"), V);
        C->SetNumberField(TEXT("dolly"), Dolly);
        C->SetObjectField(TEXT("scope"), EditScope());
        Submit(C);
    }));
    Add(Input(TEXT("Active camera name"), CameraName));
    Add(Button(TEXT("Rename"), [this] {
        auto C = Command(TEXT("rename"));
        C->SetStringField(TEXT("cameraId"), Str(Active, TEXT("cameraId")));
        C->SetStringField(TEXT("displayName"), CameraName);
        Submit(C);
    }));
    Page(TEXT("Visibility"));
    // Visibility output modes, in the designer's terms: what the saved shots show.
    Add(SNew(STextBlock).Font(FAppStyle::GetFontStyle("NormalFontBold")).Text(FText::FromString(TEXT("What saved shots show"))));
    auto Outputs = SNew(SSegmentedControl<FString>)
        .IsEnabled_Lambda([this] { return Ready(); })
        .Value_Lambda([this] { return OutputMode(); })
        .OnValueChanged_Lambda([this](FString Mode) {
            if (Mode == OutputMode()) return;
            auto C = Command(TEXT("output"));
            C->SetStringField(TEXT("output"), Mode);
            Submit(C);
        });
    for (const TCHAR* Mode : {TEXT("natural_only"), TEXT("authored_only"), TEXT("natural_and_authored")})
        Outputs->AddSlot(Mode).Text(FText::FromString(OutputLabel(Mode))).ToolTip(FText::FromString(OutputDescription(Mode)));
    Add(Outputs);
    Add(SNew(STextBlock).AutoWrapText(true).ColorAndOpacity(FSlateColor::UseSubduedForeground())
        .Text_Lambda([this] { return FText::FromString(OutputDescription(OutputMode())); }));
    Add(SNew(STextBlock).Font(FAppStyle::GetFontStyle("NormalFontBold")).Text(FText::FromString(TEXT("Hidden actors"))));
    Add(Text(TEXT("Select actors in the viewport or Outliner, then choose an action. It applies to the scope above.")));
    Add(SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(4, 4))
        + SWrapBox::Slot()[SNew(SBox).ToolTipText(FText::FromString(TEXT("Leave the selected actors out of shots that hide actors.")))
            [Button(TEXT("Hide selected actors"), [this] { CaptureSelection(TEXT("hide")); })]]
        + SWrapBox::Slot()[SNew(SBox).ToolTipText(FText::FromString(TEXT("Keep the selected actors in every shot, even if a wider scope hides them. The subject is always shown.")))
            [Button(TEXT("Always show selected actors"), [this] { CaptureSelection(TEXT("protect")); })]]);
    Add(SAssignNew(ActorRows, SVerticalBox));
    Add(SNew(SCheckBox)
        .ToolTipText(FText::FromString(TEXT("While you pilot a camera, hide its hidden actors in the viewport too. Shots that show the level as it is are not affected.")))
        .IsEnabled_Lambda([this] { return OutputMode() != TEXT("natural_only"); })
        .IsChecked_Lambda([this] { return Preview ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; }).OnCheckStateChanged_Lambda([this](ECheckBoxState S) {
        Preview = S == ECheckBoxState::Checked;
        PreviewVisibility();
    })[Text(TEXT("Hide them in the viewport while piloting"))]);
    Section(TEXT("Visibility presets"));
    Add(Input(TEXT("Preset file"), VisibilityPath));
    Add(Input(TEXT("Visibility preset name"), VisibilityName));
    for (const bool Export : {true, false})
        Add(Button(Export ? TEXT("Save preset")
                          : TEXT("Load preset"),
                   [this, Export] {
                       auto A = Obj();
                       A->SetStringField(TEXT("kind"), Export ? TEXT("export_visibility") : TEXT("import_visibility"));
                       A->SetStringField(TEXT("path"), VisibilityPath);
                       A->SetObjectField(TEXT("scope"), EditScope());
                       if (Export)
                           A->SetStringField(TEXT("name"), VisibilityName);
                       Action(A);
                   }));
    Page(TEXT("Capture"));
    auto ExposureRow = SNew(SHorizontalBox);
    Add(ExposureRow);
    ExposureRow->AddSlot().FillWidth(1)[SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()[Text(TEXT("Fixed exposure (EV100)"))]
        + SVerticalBox::Slot().AutoHeight()[SAssignNew(ExposureInput, SNumericEntryBox<double>)
            .AllowSpin(true).Delta(.1).LinearDeltaSensitivity(5)
            .MinValue(-20).MaxValue(30).MinSliderValue(-20).MaxSliderValue(30)
            .Value_Lambda([this] { return ExposureEV; })
            .OnValueChanged_Lambda([this](double V) { if (FMath::IsFinite(V)) ExposureEV = FMath::Clamp(V, -20., 30.); })
            .OnValueCommitted_Lambda([this](double V, ETextCommit::Type) { if (FMath::IsFinite(V)) ExposureEV = FMath::Clamp(V, -20., 30.); })]];
    ExposureRow->AddSlot().AutoWidth().VAlign(VAlign_Bottom).Padding(6, 0)
        [Button(TEXT("Apply fixed"), [this] { ApplyExposure(false); })];
    Add(Text(TEXT("Lower EV brightens the image. Range: -20 to 30. Exposure applies to the whole set.")));
    Add(Button(TEXT("Restore default (automatic exposure)"), [this] { ApplyExposure(true); }));
    Add(SNew(SCheckBox)
        .ToolTipText(FText::FromString(TEXT("Some actors only show an editor preview of what they will spawn, for example a spawn volume. "
                                            "Turn this on to include those previews in saved shots and in See previews. Other editor-only content stays hidden.")))
        .IsEnabled_Lambda([this] { return Ready(); })
        .IsChecked_Lambda([this] {
            return Flag(Child(Child(Panel, TEXT("renderPolicy")), TEXT("renderer")), TEXT("editorPreviews"))
                ? ECheckBoxState::Checked : ECheckBoxState::Unchecked;
        })
        .OnCheckStateChanged_Lambda([this](ECheckBoxState State) { SetEditorPreviews(State == ECheckBoxState::Checked); })
        [Text(TEXT("Show editor-only previews in shots (for example what a spawn volume spawns)"))]);
    Add(SNew(STextBlock).AutoWrapText(true).Text_Lambda([this] {
        auto Policy = Child(Panel, TEXT("renderPolicy"));
        const auto Renderer = Child(Policy, TEXT("renderer")), Exposure = Child(Policy, TEXT("exposure"));
        const FString Backend =
            Str(Renderer, TEXT("kind")) == TEXT("editor_viewport") ? TEXT("Editor viewport") : TEXT("SceneCapture");
        FString ExposureLabel = TEXT("Project automatic exposure");
        double EV = 0;
        if (Str(Exposure, TEXT("mode")) == TEXT("fixed_ev100") && Exposure->TryGetNumberField(TEXT("ev100"), EV))
            ExposureLabel = FString::Printf(TEXT("Fixed EV100: %.2f"), EV);
        else if (Str(Exposure, TEXT("mode")) == TEXT("meter_once"))
            ExposureLabel = TEXT("Meter once, then hold exposure");
        const bool Previews = Flag(Renderer, TEXT("editorPreviews"));
        return FText::FromString(Backend + TEXT(" · ") + ExposureLabel + (Previews ? TEXT(" · Editor-only previews shown") : TEXT("")));
    }));
    Section(TEXT("Portable recipes"));
    Add(Input(TEXT("Recipe file"), RecipePath));
    Add(Input(TEXT("Recipe name"), RecipeName));
    Add(Button(TEXT("Export recipe"), [this] { RecipeAction(true); }));
    Add(Button(TEXT("Load recipe"), [this] { RecipeAction(false); }));
    Shell->AddSlot().AutoHeight().Padding(0, 8)[SNew(STextBlock).AutoWrapText(true)
        .ColorAndOpacity(FLinearColor(1.f, .65f, .3f))
        .Text_Lambda([this] { return FText::FromString(Message.IsEmpty() ? Str(Panel, TEXT("notice")) : Message); })];
    auto Review = SNew(SHorizontalBox);
    Review->AddSlot().AutoWidth().VAlign(VAlign_Center)[SNew(SBox)
        .ToolTipText(FText::FromString(TEXT("Render a snapshot of every camera in a separate tab to check the shots. Doesn't save anything.")))
        [Button(TEXT("See previews"), [this] { SeePreviews.ExecuteIfBound(); })]];
    Review->AddSlot().FillWidth(1).VAlign(VAlign_Center).Padding(12, 0)[SNew(STextBlock)
        .AutoWrapText(true).ColorAndOpacity(FSlateColor::UseSubduedForeground())
        .Text_Lambda([this] { return FText::FromString(SaveStatus()); })];
    // Saving keeps the designer's work, so it is the primary action. Drafts autosave separately.
    Review->AddSlot().AutoWidth().VAlign(VAlign_Center).Padding(6, 0)[SNew(SButton)
        .ButtonStyle(FAppStyle::Get(), "PrimaryButton").ContentPadding(FMargin(14, 8))
        .Text(FText::FromString(TEXT("Save views")))
        .ToolTipText(FText::FromString(TEXT("Save every camera in this set as a view for capture. Updates views you saved before. Doesn't render images.")))
        .IsEnabled_Lambda([this] { return Ready(); })
        .OnClicked_Lambda([this] {
            const auto Previous = Scope; Scope = TEXT("arrangement"); SaveScope(); Scope = Previous;
            return FReply::Handled();
        })];
    Review->AddSlot().AutoWidth().VAlign(VAlign_Center)[SNew(SBox)
        .ToolTipText(FText::FromString(TEXT("Remove this set's temporary cameras from the level. The set stays saved.")))
        [Button(TEXT("Close set"), [this] { Call(Request(TEXT("detach"))); }, false)]];
    Shell->AddSlot().AutoHeight()[SNew(SBox).Visibility_Lambda([this] {
        return Panel->HasField(TEXT("arrangement")) && !SetupOpen ? EVisibility::Visible : EVisibility::Collapsed;
    })[Review]];
    RegisterActiveTimer(.2f, FWidgetActiveTimerDelegate::CreateSP(this, &SCameraArrangementPanel::Refresh));
}

void SCameraArrangementPanel::RecipeAction(bool Export)
{
    auto A = Obj();
    A->SetStringField(TEXT("kind"), Export ? TEXT("export_recipe") : TEXT("import_recipe"));
    A->SetStringField(TEXT("path"), RecipePath);
    if (Export)
        A->SetStringField(TEXT("name"), RecipeName);
    Action(A);
}
FString SCameraArrangementPanel::SaveStatus() const
{
    const auto Cameras = Items(Panel, TEXT("cameras"));
    int32 Unsaved = 0;
    for (const auto& Camera : Cameras)
        Unsaved += Flag(Camera->AsObject(), TEXT("approved")) ? 0 : 1;
    if (Cameras.IsEmpty()) return {};
    if (Unsaved == 0) return TEXT("All views saved");
    return Unsaved == Cameras.Num()
        ? FString::Printf(TEXT("%d %s not saved yet"), Unsaved, Unsaved == 1 ? TEXT("view") : TEXT("views"))
        : FString::Printf(TEXT("%d of %d views not saved yet"), Unsaved, Cameras.Num());
}
void SCameraArrangementPanel::SaveScope()
{
    auto A = Obj();
    A->SetStringField(TEXT("kind"), TEXT("approve"));
    TArray<TSharedPtr<FJsonValue>> Ids, Retired;
    for (const auto &C : ScopedCameras())
        Ids.Add(MakeShared<FJsonValueString>(Str(C, TEXT("id"))));
    if (RemoveRetired && Scope == TEXT("arrangement"))
        for (const auto &V : Items(Panel, TEXT("retiredViews")))
            Retired.Add(MakeShared<FJsonValueString>(Str(V->AsObject(), TEXT("id"))));
    A->SetArrayField(TEXT("cameraIds"), Ids);
    A->SetArrayField(TEXT("removeRetiredViewIds"), Retired);
    Action(A);
}
void SCameraArrangementPanel::PreviewVisibility()
{
    for (const auto &V : Items(Panel, TEXT("cameras")))
        if (Str(V->AsObject(), TEXT("id")) == Str(Active, TEXT("cameraId")))
        {
            auto Q = Request(TEXT("preview_visibility"));
            Q->SetObjectField(TEXT("actors"), Child(V->AsObject(), TEXT("visibility")));
            Q->SetBoolField(TEXT("enabled"), Preview && OutputMode() != TEXT("natural_only"));
            Call(Q);
        }
}
void SCameraArrangementPanel::CaptureSelection(const TCHAR *List)
{
    const auto R = Call(Request(TEXT("selection")));
    if (Str(R, TEXT("status")) != TEXT("selection"))
        return;
    if (Items(R, TEXT("actors")).IsEmpty())
    {
        Message = TEXT("Select actors in Unreal first.");
        return;
    }
    auto C = Command(TEXT("edit_visibility"));
    C->SetObjectField(TEXT("scope"), EditScope());
    C->SetStringField(TEXT("list"), List);
    C->SetStringField(TEXT("operation"), TEXT("add"));
    C->SetArrayField(TEXT("entries"), Items(R, TEXT("actors")));
    Submit(C);
}

SCameraArrangementPanel::FObject SCameraArrangementPanel::EditablePolicy() const
{
    auto Policy = Child(Panel, TEXT("renderPolicy"));
    if (!Policy->HasField(TEXT("renderer")))
    {
        const FString Default = TEXT(
            R"({"renderer":{"kind":"scene_capture","profile":"scene_capture_defaults","lodDistanceScale":1,"fog":true,"volumetricFog":true},"exposure":{"mode":"project_auto"},"settling":{"minimumFrames":1,"timeoutMs":120000},"time":"live_editor","preparation":{"geometry":{"mode":"preserve_loading"},"dataLayers":[]}})");
        FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Default), Policy);
    }
    else
    {
        TSharedPtr<FJsonObject> Copy;
        FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json(Policy)), Copy);
        Policy = Copy;
    }
    return Policy;
}
void SCameraArrangementPanel::ApplyExposure(bool Automatic)
{
    if (!Automatic && (!FMath::IsFinite(ExposureEV) || ExposureEV < -20 || ExposureEV > 30)) return;
    auto Policy = EditablePolicy();
    auto Exposure = Obj();
    Exposure->SetStringField(TEXT("mode"), Automatic ? TEXT("project_auto") : TEXT("fixed_ev100"));
    if (!Automatic)
    {
        Exposure->SetNumberField(TEXT("ev100"), ExposureEV);
        Exposure->SetStringField(TEXT("compensation"), TEXT("project"));
    }
    Policy->SetObjectField(TEXT("exposure"), Exposure);
    auto C = Command(TEXT("render_policy"));
    C->SetObjectField(TEXT("policy"), Policy);
    Submit(C);
}
void SCameraArrangementPanel::SetEditorPreviews(bool Enabled)
{
    // renderer.editorPreviews: captures and these previews reveal editor-only preview children.
    auto Policy = EditablePolicy();
    auto Renderer = Child(Policy, TEXT("renderer"));
    if (Enabled)
        Renderer->SetBoolField(TEXT("editorPreviews"), true);
    else
        Renderer->RemoveField(TEXT("editorPreviews"));
    Policy->SetObjectField(TEXT("renderer"), Renderer);
    auto C = Command(TEXT("render_policy"));
    C->SetObjectField(TEXT("policy"), Policy);
    Submit(C);
}

EActiveTimerReturnType SCameraArrangementPanel::Refresh(double Time, float Delta)
{
    const FString PreviousProducer = Str(Active, TEXT("producerId"));
    Active = FUEShedCameraAuthoringBridge::InspectActive();
    if (PreviousProducer != Str(Active, TEXT("producerId"))) { Selected.Reset(); Scope = TEXT("arrangement"); RowKey.Reset(); ActorKey.Reset(); }
    Panel = Child(Active, TEXT("panel"));
    Arrangement = Child(Panel, TEXT("arrangement"));
    // Thumbnails belong to one open set; drop them once no set is open.
    if (Str(Active, TEXT("status")) != TEXT("ready"))
        FCameraPreviewShelf::Get().Reset();
    ShotKeys.Reset();
    for (const auto &Camera : Items(Arrangement, TEXT("cameras")))
    {
        const FString Id = Str(Camera->AsObject(), TEXT("id"));
        ShotKeys.Add(Id, FCameraPreviewShelf::Key(Panel, Id));
    }
    const auto Exposure = Child(Child(Panel, TEXT("renderPolicy")), TEXT("exposure"));
    const FString NextExposureKey = Str(Active, TEXT("producerId")) + Json(Exposure);
    if (NextExposureKey != ExposureKey)
    {
        ExposureKey = NextExposureKey;
        double EV = 10;
        Exposure->TryGetNumberField(TEXT("ev100"), EV);
        ExposureEV = FMath::Clamp(EV, -20., 30.);
    }
    Setup = FUEShedCameraAuthoringBridge::InspectSetup();
    if (!Panel->HasField(TEXT("arrangement"))) NewSetup = true;
    if (!CreatingId.IsEmpty() && !Setup->HasField(TEXT("request")))
    {
        Message = Str(Setup, TEXT("message"));
        if (Message.IsEmpty() && Panel->HasField(TEXT("arrangement"))) SetupOpen = false;
        CreatingId.Reset();
    }
    if (Active->HasField(TEXT("selectedCameraIds")))
    {
        Selected.Reset();
        for (const auto& Id : Items(Active, TEXT("selectedCameraIds"))) Selected.Add(Id->AsString());
    }
    FlushSetting();
    RebuildManualRows();
    if (!Arrangement->HasField(TEXT("cameras"))) {
        CameraRows->ClearChildren();
        if (!RowKey.IsEmpty()) { GroupRows->ClearChildren(); ActorRows->ClearChildren(); ActiveActions->ClearChildren(); ProposalRows->ClearChildren(); RowKey.Reset(); }
        return EActiveTimerReturnType::Continue;
    }
    FString Key = Str(Active, TEXT("producerId")) + LexToString(Flag(Active, TEXT("piloting"))) + Str(Arrangement, TEXT("id")) + Str(Active, TEXT("cameraId")) + LexToString(Arrangement->GetNumberField(TEXT("revision")));
    for (const auto& Camera : Items(Panel, TEXT("cameras")))
        Key += Flag(Camera->AsObject(), TEXT("approved")) ? TEXT("1") : TEXT("0");
    if (Key != RowKey)
    {
        RowKey = Key;
        RebuildCameras();
        if (Preview)
            PreviewVisibility();
    }
    const FString PKey = Json(Child(Panel, TEXT("proposal"))) + LexToString(Items(Panel, TEXT("retiredViews")).Num());
    if (PKey != ProposalKey)
    {
        ProposalKey = PKey;
        ProposalRows->ClearChildren();
        const auto P = Child(Panel, TEXT("proposal"));
        if (P->HasField(TEXT("cameras")))
        {
            ProposalRows->AddSlot().AutoHeight()[Text(FString::Printf(
                TEXT("PROPOSAL: %d added · %d removed · %d customized removed"), Items(P, TEXT("added")).Num(),
                Items(P, TEXT("removed")).Num(), Items(P, TEXT("customized")).Num()))];
            for (const auto &Id : Items(P, TEXT("customized")))
                ProposalRows->AddSlot().AutoHeight()[Text(TEXT("Discard customization: ") + Id->AsString())];
            ProposalRows->AddSlot().AutoHeight()[Button(TEXT("Apply changes"),
                                                        [this] { SimpleAction(TEXT("accept_proposal")); if (Message.IsEmpty()) SetupOpen = false; })];
            ProposalRows->AddSlot()
                .AutoHeight()[Button(TEXT("Cancel"), [this] { SimpleAction(TEXT("cancel_proposal")); })];
        }
        for (const auto &V : Items(Panel, TEXT("retiredViews")))
            ProposalRows->AddSlot().AutoHeight()[Text(TEXT("Removed camera, view still saved: ") + Str(V->AsObject(), TEXT("name")))];
    }
    const FString AKey = Key + Scope + GroupId + LexToString(Selected.Num());
    if (AKey != ActorKey)
    {
        ActorKey = AKey;
        RebuildActors();
    }
    return EActiveTimerReturnType::Continue;
}
const FCameraPreviewShelf::FShot *SCameraArrangementPanel::PreviewShot(const FString &Id) const
{
    return FCameraPreviewShelf::Get().Find(FCameraPreviewShelf::Session(Active), Id);
}
bool SCameraArrangementPanel::PreviewStale(const FString &Id) const
{
    const auto *Shot = PreviewShot(Id);
    const FString *Current = ShotKeys.Find(Id);
    return Shot && Current && *Current != Shot->Key;
}
FCameraShotStatus SCameraArrangementPanel::ShotLine(const FString &Id) const
{
    const auto *Shot = PreviewShot(Id);
    if (!Shot)
    {
        FCameraShotStatus None;
        None.Label = TEXT("No preview yet");
        None.Detail = TEXT("See previews renders a thumbnail for every camera and checks whether each shot shows the subject.");
        return None;
    }
    auto Status = DescribeShot(&Shot->Visibility, Shot->bSubjectFound, Shot->bEditorPreviews);
    if (PreviewStale(Id))
    {
        Status.Label += TEXT(" · out of date");
        Status.Detail = TEXT("This camera changed after its preview. Refresh in See previews to check it again.");
        Status.Color = FLinearColor(.6f, .6f, .6f);
    }
    return Status;
}
TSharedRef<SWidget> SCameraArrangementPanel::Thumbnail(const FString &Id)
{
    // The review's own 160x90 readback; the list never renders anything itself.
    auto Brush = MakeShared<FSlateBrush>();
    Brush->DrawAs = ESlateBrushDrawType::Image;
    Brush->ImageSize = FVector2D(FUEShedCameraPreviewReview::ThumbnailWidth, FUEShedCameraPreviewReview::ThumbnailHeight);
    return SNew(SBox).WidthOverride(80).HeightOverride(45)
        .ToolTipText_Lambda([this, Id] { return FText::FromString(ShotLine(Id).Detail); })
        [SNew(SBorder).Padding(0).BorderImage(FAppStyle::GetBrush("WhiteBrush"))
            .BorderBackgroundColor(FLinearColor(0, 0, 0, .35f))
            [SNew(SOverlay)
                + SOverlay::Slot()[SNew(SImage)
                    .ColorAndOpacity_Lambda([this, Id] { return FSlateColor(PreviewStale(Id) ? FLinearColor(1, 1, 1, .4f) : FLinearColor::White); })
                    .Image_Lambda([this, Id, Brush]() -> const FSlateBrush * {
                        const auto *Shot = PreviewShot(Id);
                        Brush->SetResourceObject(Shot ? Shot->Thumbnail.Get() : nullptr);
                        return Shot && Shot->Thumbnail.IsValid() ? &Brush.Get() : nullptr;
                    })]
                + SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)[SNew(STextBlock)
                    .Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
                    .ColorAndOpacity(FSlateColor::UseSubduedForeground())
                    .Visibility_Lambda([this, Id] { return PreviewShot(Id) ? EVisibility::Collapsed : EVisibility::HitTestInvisible; })
                    .Text(FText::FromString(TEXT("No preview")))]]];
}
void SCameraArrangementPanel::RebuildCameras()
{
    CameraRows->ClearChildren();
    ActiveActions->ClearChildren();
    GroupRows->ClearChildren();
    TSet<FString> Existing;
    for (const auto &V : Items(Arrangement, TEXT("cameras")))
    {
        const auto C = V->AsObject();
        const FString Id = Str(C, TEXT("id"));
        Existing.Add(Id);
        const FString Label = Str(C, TEXT("displayName"));
        auto Row = SNew(SHorizontalBox);
        Row->AddSlot().AutoWidth()[SNew(SCheckBox)
                                       .IsChecked_Lambda([this, Id] {
                                           return Selected.Contains(Id) ? ECheckBoxState::Checked
                                                                        : ECheckBoxState::Unchecked;
                                       })
                                       .OnCheckStateChanged_Lambda([this, Id](ECheckBoxState S) {
                                           SetCameraSelected(Id, S == ECheckBoxState::Checked);
                                       })];
        Row->AddSlot().AutoWidth().VAlign(VAlign_Center).Padding(6, 0, 0, 0)[Thumbnail(Id)];
        Row->AddSlot().FillWidth(1).VAlign(VAlign_Center).Padding(8, 0)[SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).AutoWrapText(true).Text(FText::FromString(Label))]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 2, 0, 0)[SNew(STextBlock)
                .AutoWrapText(true).Font(FCoreStyle::GetDefaultFontStyle("Regular", 8))
                .ColorAndOpacity_Lambda([this, Id] { return FSlateColor(ShotLine(Id).Color); })
                .ToolTipText_Lambda([this, Id] { return FText::FromString(ShotLine(Id).Detail); })
                .Text_Lambda([this, Id] { return FText::FromString(ShotLine(Id).Label); })]];
        auto CameraButtons = SNew(SHorizontalBox);
        CameraButtons->AddSlot().AutoWidth()[SNew(SBox)
            .ToolTipText(FText::FromString(TEXT("Select this camera and frame it with its subject in the viewport. "
                                                "While piloting, switches the viewport to this camera.")))
            [Button(TEXT("Select"), [this, Id] { FocusCamera(Id); }, false, true)]];
        CameraButtons->AddSlot().AutoWidth().Padding(4, 0)[Button(Id == Str(Active, TEXT("cameraId")) && Flag(Active, TEXT("piloting")) ? TEXT("Piloting") : TEXT("Pilot"), [this, Id] { PilotCamera(Id); }, false, true)];
        if (Id == Str(Active, TEXT("cameraId"))) {
        auto Actions = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(4, 4));
        ActiveActions->AddSlot().AutoHeight()[Actions];
        Actions->AddSlot()[Button(TEXT("Duplicate"), [this, Id] {
            auto C = Command(TEXT("duplicate"));
            C->SetStringField(TEXT("cameraId"), Id);
            C->SetStringField(TEXT("newCameraId"), TEXT("camera-") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
            C->SetStringField(TEXT("newViewId"), TEXT("view-") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
            Submit(C);
        })];
        Actions->AddSlot()[Button(TEXT("Restore fitted position"), [this, Id] {
            auto C = Command(TEXT("unpin"));
            C->SetStringField(TEXT("cameraId"), Id);
            Submit(C);
        })];
        Actions->AddSlot()[Button(TEXT("Remove…"), [this, Id] {
            auto A = Obj();
            A->SetStringField(TEXT("kind"), TEXT("remove"));
            A->SetArrayField(TEXT("cameraIds"), {MakeShared<FJsonValueString>(Id)});
            Action(A);
        })];
        for (int32 Direction : {-1, 1})
            Actions->AddSlot()[Button(Direction < 0 ? TEXT("Move up") : TEXT("Move down"), [this, Id, Direction] {
                auto Values = Items(Arrangement, TEXT("cameras"));
                const int32 Index =
                    Values.IndexOfByPredicate([&Id](const auto &V) { return Str(V->AsObject(), TEXT("id")) == Id; });
                if (!Values.IsValidIndex(Index + Direction))
                    return;
                Values.Swap(Index, Index + Direction);
                TArray<TSharedPtr<FJsonValue>> Ids;
                for (const auto &V : Values)
                    Ids.Add(MakeShared<FJsonValueString>(Str(V->AsObject(), TEXT("id"))));
                auto C = Command(TEXT("reorder"));
                C->SetArrayField(TEXT("cameraIds"), Ids);
                Submit(C);
            })];
        }
        CameraRows->AddSlot().AutoHeight().Padding(0, 2)[SNew(SBorder)
            .BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder")).Padding(FMargin(8, 6))
            [SNew(SVerticalBox) + SVerticalBox::Slot().AutoHeight()[Row]
                + SVerticalBox::Slot().AutoHeight().Padding(0, 5, 0, 0)[CameraButtons]]];
    }
    for (auto It = Selected.CreateIterator(); It; ++It)
        if (!Existing.Contains(*It))
            It.RemoveCurrent();
    for (const auto &V : Items(Arrangement, TEXT("groups")))
    {
        const FString Id = Str(V->AsObject(), TEXT("id")), Name = Str(V->AsObject(), TEXT("name"));
        GroupRows->AddSlot().AutoHeight()[Button(TEXT("Edit group: ") + Name, [this, Id] {
            Scope = TEXT("group");
            GroupId = Id;
            ActorKey.Reset();
        })];
    }
}
FString SCameraArrangementPanel::SelectionSummary(int32 Count)
{
    return Count == 0   ? TEXT("No cameras selected. Check cameras in the list to edit them.")
           : Count == 1 ? TEXT("Editing 1 selected camera")
                        : FString::Printf(TEXT("Editing %d selected cameras"), Count);
}
FString SCameraArrangementPanel::OutputMode() const
{
    // Sets saved before visibility output existed capture the level as it is.
    const FString Output = Str(Arrangement, TEXT("output"));
    return Output.IsEmpty() ? FString(TEXT("natural_only")) : Output;
}
FString SCameraArrangementPanel::OutputLabel(const FString& Mode)
{
    return Mode == TEXT("authored_only")          ? TEXT("Without hidden actors")
           : Mode == TEXT("natural_and_authored") ? TEXT("Both")
                                                  : TEXT("Level as it is");
}
FString SCameraArrangementPanel::OutputDescription(const FString& Mode)
{
    return Mode == TEXT("authored_only")
               ? TEXT("Shots leave out the hidden actors. The subject and actors marked Always show stay in.")
           : Mode == TEXT("natural_and_authored")
               ? TEXT("Each view saves two shots: the level as it is, and one without the hidden actors. With "
                      "SceneCapture rendering, set a fixed exposure on the Capture tab so both shots match.")
               : TEXT("Shots show every actor, including hidden ones. Your hidden-actor lists are kept for later.");
}
FString SCameraArrangementPanel::VisibilityProblem(const FString& Status)
{
    return Status == TEXT("missing_or_unloaded") ? TEXT("isn't in the open level, or isn't loaded. Load it before capturing.")
           : Status == TEXT("ambiguous")         ? TEXT("matches more than one actor. Hide or show the exact actor again.")
           : Status == TEXT("unsupported")
               ? TEXT("can't be left out of shots yet. Only solid, non-Nanite static meshes can be hidden.")
               : TEXT("can't be found. Hide or show it again.");
}
FString SCameraArrangementPanel::ScopeName() const
{
    if (Scope == TEXT("arrangement")) return TEXT("the whole set");
    if (Scope == TEXT("group")) return TEXT("group ") + Str(Group(), TEXT("name"));
    const auto Cameras = ScopedCameras();
    return Cameras.Num() == 1 ? Str(Cameras[0], TEXT("displayName"))
                              : FString::Printf(TEXT("%d selected cameras"), Cameras.Num());
}
void SCameraArrangementPanel::RebuildActors()
{
    ActorRows->ClearChildren();
    const auto Local = LocalVisibility();
    const bool Any = !Items(Local, TEXT("hide")).IsEmpty() || !Items(Local, TEXT("protect")).IsEmpty();
    const bool Single = Scope != TEXT("cameras") || ScopedCameras().Num() == 1;
    ActorRows->AddSlot().AutoHeight().Padding(0, 6, 0, 2)[Text(
        !Single ? TEXT("Select one camera, a group or the whole set to see its list.")
        : Any   ? TEXT("Set for ") + ScopeName() + TEXT(":")
                : TEXT("Nothing hidden or always shown for ") + ScopeName() + TEXT("."))];
    TMap<FString, FString> Labels;
    for (const TCHAR *Field : {TEXT("hide"), TEXT("protect")})
        for (const auto &V : Items(Local, Field))
        {
            const auto E = V->AsObject();
            const FString Key = Json(Child(E, TEXT("locator")));
            ActorRows->AddSlot()
                .AutoHeight()[SNew(SHorizontalBox) +
                              SHorizontalBox::Slot().FillWidth(1).VAlign(VAlign_Center)[Text(
                                  (FCString::Strcmp(Field, TEXT("hide")) == 0 ? TEXT("Hidden · ") : TEXT("Always shown · ")) +
                                  Str(E, TEXT("label")))] +
                              SHorizontalBox::Slot().AutoWidth()[Button(TEXT("Remove"), [this, Field, Key] {
                                  auto Next = Obj();
                                  const auto Local = LocalVisibility();
                                  for (const TCHAR *F : {TEXT("hide"), TEXT("protect")})
                                  {
                                      auto Values = Items(Local, F);
                                      if (FCString::Strcmp(F, Field) == 0)
                                          Values.RemoveAll([&Key](const auto &E) {
                                              return Json(Child(E->AsObject(), TEXT("locator"))) == Key;
                                          });
                                      Next->SetArrayField(F, Values);
                                  }
                                  auto C = Command(TEXT("visibility"));
                                  C->SetObjectField(TEXT("scope"), EditScope());
                                  C->SetObjectField(TEXT("visibility"), Next);
                                  Submit(C);
                              }, true, true)]];
        }
    for (const auto &V : Items(Panel, TEXT("cameras")))
        if (Str(V->AsObject(), TEXT("id")) == Str(Active, TEXT("cameraId")))
        {
            // The composed list this camera's shots use, after group and set lists and Always show.
            const auto Lists = Child(V->AsObject(), TEXT("visibility"));
            const int32 Hidden = Items(Lists, TEXT("hide")).Num(), Shown = Items(Lists, TEXT("protect")).Num();
            FString Name;
            for (const auto &Camera : Items(Arrangement, TEXT("cameras")))
                if (Str(Camera->AsObject(), TEXT("id")) == Str(Active, TEXT("cameraId")))
                    Name = Str(Camera->AsObject(), TEXT("displayName"));
            ActorRows->AddSlot().AutoHeight().Padding(0, 8, 0, 2)[Text(FString::Printf(
                TEXT("In %s's shots: %d hidden, %d always shown"), *Name, Hidden, Shown))];
            for (const TCHAR *F : {TEXT("hide"), TEXT("protect")})
                for (const auto &E : Items(Lists, F))
                {
                    Labels.Add(Json(Child(E->AsObject(), TEXT("locator"))), Str(E->AsObject(), TEXT("label")));
                    ActorRows->AddSlot().AutoHeight()[Text(
                        (FCString::Strcmp(F, TEXT("hide")) == 0 ? TEXT("Hidden · ") : TEXT("Always shown · ")) +
                        Str(E->AsObject(), TEXT("label")))];
                }
            auto Q = Request(TEXT("resolve_visibility"));
            Q->SetObjectField(TEXT("actors"), Lists);
            // Each problem is explained beside its actor; keep the panel message for actions.
            const auto R = FUEShedCameraAuthoringBridge::Execute(Q);
            for (const auto &D : Items(R, TEXT("diagnostics")))
                if (Str(D->AsObject(), TEXT("status")) != TEXT("resolved"))
                {
                    const FString *Label = Labels.Find(Json(Child(D->AsObject(), TEXT("locator"))));
                    ActorRows->AddSlot().AutoHeight()[SNew(STextBlock).AutoWrapText(true)
                        .ColorAndOpacity(FLinearColor(1.f, .65f, .3f))
                        .Text(FText::FromString((Label && !Label->IsEmpty() ? *Label : FString(TEXT("An actor"))) + TEXT(" ") +
                                                VisibilityProblem(Str(D->AsObject(), TEXT("status")))))];
                }
        }
}
