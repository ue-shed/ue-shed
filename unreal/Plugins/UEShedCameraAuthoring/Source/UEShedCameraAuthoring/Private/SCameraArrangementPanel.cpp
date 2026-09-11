#include "SCameraArrangementPanel.h"
#include "Serialization/JsonSerializer.h"
#include "Widgets/Layout/SWidgetSwitcher.h"
#include "Framework/Application/SlateApplication.h"
#include "UEShedCameraAuthoringBridge.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SNumericEntryBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SExpandableArea.h"
#include "Widgets/Layout/SScrollBox.h"
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
TSharedRef<SWidget> SCameraArrangementPanel::Button(const FString &Label, TFunction<void()> Fn, bool NeedsReady)
{
    return SNew(SButton)
        .Text(FText::FromString(Label))
        .IsEnabled_Lambda([this, NeedsReady] { return !NeedsReady || Ready(); })
        .OnClicked_Lambda([Fn] {
            Fn();
            return FReply::Handled();
        });
}
TSharedRef<SWidget> SCameraArrangementPanel::Number(const TCHAR *Label, double &Value)
{
    return SNew(SHorizontalBox) + SHorizontalBox::Slot().FillWidth(1)[Text(Label)] +
           SHorizontalBox::Slot().FillWidth(
               1)[SNew(SNumericEntryBox<double>)
                      .Value_Lambda([&Value] { return Value; })
                      .OnValueCommitted_Lambda([&Value](double V, ETextCommit::Type) { Value = V; })];
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
    return SNew(SHorizontalBox) + SHorizontalBox::Slot().FillWidth(1)[Text(Label)] +
           SHorizontalBox::Slot().FillWidth(
               1)[SNew(SNumericEntryBox<double>)
                      .AllowSpin(false)
                      .UndeterminedString(FText::FromString(TEXT("Mixed")))
                      .IsEnabled_Lambda([this] { return Ready() && !ScopedCameras().IsEmpty(); })
                      .Value_Lambda([this, Field] { return Effective(Field); })
                      .OnValueCommitted_Lambda([this, Field](double V, ETextCommit::Type T) {
                          if (T == ETextCommit::OnCleared || CommittingNumber || !Ready())
                              return;
                          TGuardValue<bool> CommitGuard(CommittingNumber, true);
                          if (T == ETextCommit::OnEnter)
                              FSlateApplication::Get().ClearKeyboardFocus(EFocusCause::Cleared);
                          auto C = Command(TEXT("batch")), S = Obj();
                          S->SetNumberField(Field, V);
                          C->SetObjectField(TEXT("scope"), EditScope());
                          C->SetObjectField(TEXT("settings"), S);
                          C->SetArrayField(TEXT("resetFields"), {});
                          Submit(C);
                      })] +
           SHorizontalBox::Slot().AutoWidth()[SNew(SBox).Visibility_Lambda([this] { return Scope == TEXT("arrangement") ? EVisibility::Collapsed : EVisibility::Visible; })[Button(TEXT("Reset"), [this, Field] {
               if (Scope == TEXT("arrangement"))
               {
                   Message = TEXT("Arrangement defaults have no parent. Choose a group or cameras.");
                   return;
               }
               auto C = Command(TEXT("batch"));
               C->SetObjectField(TEXT("scope"), EditScope());
               C->SetObjectField(TEXT("settings"), Obj());
               C->SetArrayField(TEXT("resetFields"), {MakeShared<FJsonValueString>(Field)});
               Submit(C);
           })]];
}

void SCameraArrangementPanel::Construct(const FArguments &Args)
{
    Active = Obj();
    Panel = Obj();
    Arrangement = Obj();
    auto Root = SNew(SVerticalBox);
    ChildSlot[SNew(SBox).Padding(12).MinDesiredWidth(340)[Root]];
    Root->AddSlot().AutoHeight().Padding(0, 0, 0, 8)[SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 14)).Text_Lambda([this] {
        const auto Subject = Child(Arrangement, TEXT("subject"));
        FString Name = Str(Subject, TEXT("diagnosticLabel"));
        if (Name.IsEmpty() && !Items(Arrangement, TEXT("cameras")).IsEmpty())
            Name = Str(Items(Arrangement, TEXT("cameras"))[0]->AsObject(), TEXT("displayName"));
        return FText::FromString(Name.IsEmpty() ? TEXT("Camera sets") : Name);
    })];
    Root->AddSlot().AutoHeight().Padding(0, 0, 0, 6)[SNew(STextBlock).Text_Lambda([this] {
        return FText::FromString(!Panel->HasField(TEXT("arrangement")) ? TEXT("No set open") :
            FString::Printf(TEXT("%d cameras  ·  %s"), Items(Arrangement, TEXT("cameras")).Num(), Ready() ? TEXT("Synced") : TEXT("Syncing…")));
    })];
    Root->AddSlot().AutoHeight()[SNew(SBox).MaxDesiredHeight(190)[SNew(SScrollBox) + SScrollBox::Slot()[SAssignNew(CameraRows, SVerticalBox)]]];
    Root->AddSlot().AutoHeight().Padding(0, 6)[SNew(SHorizontalBox) +
        SHorizontalBox::Slot().FillWidth(1)[Button(TEXT("Whole set"), [this] { Scope = TEXT("arrangement"); ActorKey.Reset(); })] +
        SHorizontalBox::Slot().FillWidth(1)[Button(TEXT("Selected cameras"), [this] {
            Scope = TEXT("cameras");
            if (Selected.IsEmpty()) Selected.Add(Str(Active, TEXT("cameraId")));
            ActorKey.Reset();
        })]];
    Root->AddSlot().AutoHeight().Padding(0, 4)[SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 10)).Text_Lambda([this] {
        return FText::FromString(Scope == TEXT("arrangement") ? TEXT("Whole set") :
            Scope == TEXT("group") ? Str(Group(), TEXT("name")) : FString::Printf(TEXT("%d selected"), Selected.Num()));
    })];
    Root->AddSlot().AutoHeight().Padding(0, 4)[SNew(SHorizontalBox) +
        SHorizontalBox::Slot().FillWidth(1)[Button(TEXT("Pilot"), [this] { Call(Request(TEXT("pilot"))); PreviewVisibility(); })] +
        SHorizontalBox::Slot().FillWidth(1)[Button(TEXT("Details"), [this] { Call(Request(TEXT("select"))); })] +
        SHorizontalBox::Slot().FillWidth(1)[Button(TEXT("Stop piloting"), [this] { Call(Request(TEXT("eject"))); })]];
    auto Tabs = SNew(SHorizontalBox);
    auto Pages = SNew(SWidgetSwitcher).WidgetIndex_Lambda([this] { return InspectorPage; });
    Root->AddSlot().AutoHeight().Padding(0, 8)[Tabs];
    Root->AddSlot().FillHeight(1)[Pages];
    TSharedRef<SVerticalBox> SectionBody = Root;
    int32 PageIndex = 0;
    auto Page = [&Tabs, &Pages, &SectionBody, &PageIndex, this](const TCHAR* Title) {
        const int32 Index = PageIndex++;
        Tabs->AddSlot().FillWidth(1)[SNew(SCheckBox).Style(FCoreStyle::Get(), "ToggleButtonCheckbox")
            .IsChecked_Lambda([this, Index] { return InspectorPage == Index ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
            .OnCheckStateChanged_Lambda([this, Index](ECheckBoxState) { InspectorPage = Index; })[Text(Title)]];
        SectionBody = SNew(SVerticalBox);
        Pages->AddSlot()[SNew(SScrollBox) + SScrollBox::Slot()[SectionBody]];
    };
    auto Add = [&SectionBody](TSharedRef<SWidget> W) { SectionBody->AddSlot().AutoHeight().Padding(0, 4)[W]; };
    auto Section = [&SectionBody](const TCHAR *Title, bool Expanded = false) {
        auto Parent = SectionBody;
        SectionBody = SNew(SVerticalBox);
        Parent->AddSlot().AutoHeight().Padding(0, 6)[SNew(SExpandableArea).InitiallyCollapsed(!Expanded).HeaderContent()[Text(Title)].BodyContent()[SectionBody]];
    };
    Page(TEXT("Framing"));
    auto Framing = SectionBody;
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
    for (const auto &P : TArray<TPair<FString, FString>>{{TEXT("FOV (°)"), TEXT("fieldOfViewDegrees")},
                                                         {TEXT("Distance"), TEXT("distanceScale")},
                                                         {TEXT("Height (cm)"), TEXT("heightOffset")},
                                                         {TEXT("Elevation (°)"), TEXT("elevationDegrees")},
                                                         {TEXT("Yaw (°)"), TEXT("yawOffset")},
                                                         {TEXT("Margin"), TEXT("margin")}})
    {
        // Stable literal storage: Setting callbacks retain field strings via static interned names below.
        const TCHAR *Field = P.Value == TEXT("fieldOfViewDegrees") ? TEXT("fieldOfViewDegrees")
                             : P.Value == TEXT("distanceScale")    ? TEXT("distanceScale")
                             : P.Value == TEXT("heightOffset")     ? TEXT("heightOffset")
                             : P.Value == TEXT("elevationDegrees") ? TEXT("elevationDegrees")
                             : P.Value == TEXT("yawOffset")        ? TEXT("yawOffset")
                                                                   : TEXT("margin");
        Add(Setting(*P.Key, Field));
    }
    Section(TEXT("Camera actions"));
    Add(SAssignNew(ActiveActions, SVerticalBox));
    SectionBody = Framing;
    Section(TEXT("Aim and placement"));
    Add(Number(TEXT("Aim offset X (cm)"), AimX));
    Add(Number(TEXT("Aim offset Y (cm)"), AimY));
    Add(Number(TEXT("Aim offset Z (cm)"), AimZ));
    Add(Button(TEXT("Apply aim offset"), [this] {
        auto C = Command(TEXT("batch")), S = Obj(), V = Obj();
        V->SetNumberField(TEXT("x"), AimX);
        V->SetNumberField(TEXT("y"), AimY);
        V->SetNumberField(TEXT("z"), AimZ);
        S->SetObjectField(TEXT("aimOffset"), V);
        C->SetObjectField(TEXT("settings"), S);
        C->SetObjectField(TEXT("scope"), EditScope());
        C->SetArrayField(TEXT("resetFields"), {});
        Submit(C);
    }));
    Add(Button(TEXT("Reset aim offset"), [this] {
        if (Scope == TEXT("arrangement"))
        {
            Message = TEXT("Arrangement defaults have no parent. Set an explicit aim offset.");
            return;
        }
        auto C = Command(TEXT("batch"));
        C->SetObjectField(TEXT("settings"), Obj());
        C->SetObjectField(TEXT("scope"), EditScope());
        C->SetArrayField(TEXT("resetFields"), {MakeShared<FJsonValueString>(TEXT("aimOffset"))});
        Submit(C);
    }));
    Add(Number(TEXT("Dolly forward (cm)"), Dolly));
    Add(Number(TEXT("World Z move (cm)"), Height));
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
    Page(TEXT("Layout"));
    for (const FString Kind : {TEXT("single"), TEXT("orbit"), TEXT("arc")})
        Add(Button(Kind, [this, Kind] { LayoutKind = Kind; }));
    Add(SNew(STextBlock).Text_Lambda([this] { return FText::FromString(TEXT("Layout: ") + LayoutKind); }));
    Add(Number(TEXT("Count (1–256)"), Count));
    Add(Number(TEXT("Start angle (degrees)"), Start));
    Add(Number(TEXT("Arc span (degrees)"), Span));
    Add(SNew(SCheckBox).OnCheckStateChanged_Lambda([this](ECheckBoxState S) {
        SubjectOrientation = S == ECheckBoxState::Checked;
    })[Text(TEXT("Use subject orientation"))]);
    Add(SNew(SCheckBox).IsChecked(ECheckBoxState::Checked).OnCheckStateChanged_Lambda([this](ECheckBoxState S) {
        Retain = S == ECheckBoxState::Checked;
    })[Text(TEXT("Keep existing adjustments"))]);
    Add(Button(TEXT("Review layout"), [this] {
        auto A = Obj(), L = Obj();
        A->SetStringField(TEXT("kind"), TEXT("layout"));
        L->SetStringField(TEXT("kind"), LayoutKind);
        L->SetNumberField(TEXT("count"), Count);
        L->SetNumberField(TEXT("startDegrees"), Start);
        L->SetNumberField(TEXT("spanDegrees"), Span);
        L->SetStringField(TEXT("orientation"), SubjectOrientation ? TEXT("subject") : TEXT("world"));
        A->SetObjectField(TEXT("layout"), L);
        A->SetBoolField(TEXT("retainExisting"), Retain);
        Action(A);
    }));
    Add(Button(TEXT("Add from viewport"), [this] {
        const auto R = Call(Request(TEXT("viewport_pose")));
        if (Str(R, TEXT("status")) != TEXT("viewport_pose"))
            return;
        auto A = Obj();
        A->SetStringField(TEXT("kind"), TEXT("add_viewport"));
        A->SetObjectField(TEXT("pose"), Child(R, TEXT("pose")));
        Action(A);
    }));
    Add(SAssignNew(ProposalRows, SVerticalBox));
    Page(TEXT("Visibility"));
    Add(Button(TEXT("Hide selection"), [this] { CaptureSelection(TEXT("hide")); }));
    Add(Button(TEXT("Protect selection"), [this] { CaptureSelection(TEXT("protect")); }));
    Add(SAssignNew(ActorRows, SVerticalBox));
    Add(SNew(SCheckBox).OnCheckStateChanged_Lambda([this](ECheckBoxState S) {
        Preview = S == ECheckBoxState::Checked;
        PreviewVisibility();
    })[Text(TEXT("Preview hidden actors"))]);
    Add(SNew(STextBlock).Text_Lambda([this] {
        return FText::FromString(TEXT("Saved output: ") + (Str(Arrangement, TEXT("output")).IsEmpty()
                                                               ? TEXT("natural_only")
                                                               : Str(Arrangement, TEXT("output"))));
    }));
    for (const auto &P : TArray<TPair<FString, FString>>{{TEXT("Pure only"), TEXT("natural_only")},
                                                         {TEXT("Authored only"), TEXT("authored_only")},
                                                         {TEXT("Pure + Authored"), TEXT("natural_and_authored")}})
        Add(Button(P.Key, [this, Mode = P.Value] {
            auto C = Command(TEXT("output"));
            C->SetStringField(TEXT("output"), Mode);
            Submit(C);
        }));
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
    Add(Number(TEXT("Fixed EV100 (-20 to 30)"), ExposureEV));
    Add(Button(TEXT("Apply exposure"), [this] {
        if (ExposureEV < -20 || ExposureEV > 30)
        {
            Message = TEXT("EV100 must be between -20 and 30.");
            return;
        }
        auto Policy = Child(Panel, TEXT("renderPolicy"));
        if (!Policy)
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
        auto Exposure = Obj();
        Exposure->SetStringField(TEXT("mode"), TEXT("fixed_ev100"));
        Exposure->SetNumberField(TEXT("ev100"), ExposureEV);
        Exposure->SetStringField(TEXT("compensation"), TEXT("project"));
        Policy->SetObjectField(TEXT("exposure"), Exposure);
        auto C = Command(TEXT("render_policy"));
        C->SetObjectField(TEXT("policy"), Policy);
        Submit(C);
    }));
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
        return FText::FromString(Backend + TEXT(" · ") + ExposureLabel);
    }));
    Section(TEXT("Portable recipes"));
    Add(Input(TEXT("Recipe file"), RecipePath));
    Add(Input(TEXT("Recipe name"), RecipeName));
    Add(Button(TEXT("Export recipe"), [this] { RecipeAction(true); }));
    Add(Button(TEXT("Load recipe"), [this] { RecipeAction(false); }));
    SectionBody = Root;
    Add(SNew(STextBlock).AutoWrapText(true).Text_Lambda([this] { return FText::FromString(Message); }));
    Add(SNew(SHorizontalBox) +
        SHorizontalBox::Slot().FillWidth(1)[Button(TEXT("Save set"), [this] {
            const auto Previous = Scope; Scope = TEXT("arrangement"); SaveScope(); Scope = Previous;
        })] +
        SHorizontalBox::Slot().AutoWidth()[Button(TEXT("Close"), [this] { Call(Request(TEXT("detach"))); }, false)]);
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
            Q->SetBoolField(TEXT("enabled"), Preview);
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
        Message = TEXT("Select blocker actors in the Outliner or viewport; the authoring camera is excluded.");
        return;
    }
    auto C = Command(TEXT("edit_visibility"));
    C->SetObjectField(TEXT("scope"), EditScope());
    C->SetStringField(TEXT("list"), List);
    C->SetStringField(TEXT("operation"), TEXT("add"));
    C->SetArrayField(TEXT("entries"), Items(R, TEXT("actors")));
    Submit(C);
}

EActiveTimerReturnType SCameraArrangementPanel::Refresh(double Time, float Delta)
{
    Active = FUEShedCameraAuthoringBridge::InspectActive();
    Panel = Child(Active, TEXT("panel"));
    Arrangement = Child(Panel, TEXT("arrangement"));
    if (!Arrangement->HasField(TEXT("cameras")))
        return EActiveTimerReturnType::Continue;
    const FString Key = Str(Active, TEXT("cameraId")) + LexToString(Arrangement->GetNumberField(TEXT("revision")));
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
                                                        [this] { SimpleAction(TEXT("accept_proposal")); })];
            ProposalRows->AddSlot()
                .AutoHeight()[Button(TEXT("Cancel"), [this] { SimpleAction(TEXT("cancel_proposal")); })];
        }
        for (const auto &V : Items(Panel, TEXT("retiredViews")))
            ProposalRows->AddSlot().AutoHeight()[Text(TEXT("Retired saved View: ") + Str(V->AsObject(), TEXT("name")))];
    }
    const FString AKey = Key + Scope + GroupId + LexToString(Selected.Num());
    if (AKey != ActorKey)
    {
        ActorKey = AKey;
        RebuildActors();
    }
    return EActiveTimerReturnType::Continue;
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
        FString Label = (Id == Str(Active, TEXT("cameraId")) ? TEXT("▶ ") : TEXT("")) + Str(C, TEXT("displayName"));
        Label += C->HasField(TEXT("manualPose")) ? TEXT(" · manual") : TEXT(" · fitted");
        if (Child(C, TEXT("overrides"))->Values.Num())
            Label += TEXT(" · overrides");
        for (const auto &Effective : Items(Panel, TEXT("cameras")))
            if (Str(Effective->AsObject(), TEXT("id")) == Id)
                Label += Flag(Effective->AsObject(), TEXT("approved")) ? TEXT(" · saved") : TEXT(" · draft");
        auto Row = SNew(SHorizontalBox);
        Row->AddSlot().AutoWidth()[SNew(SCheckBox)
                                       .IsChecked_Lambda([this, Id] {
                                           return Selected.Contains(Id) ? ECheckBoxState::Checked
                                                                        : ECheckBoxState::Unchecked;
                                       })
                                       .OnCheckStateChanged_Lambda([this, Id](ECheckBoxState S) {
                                           if (S == ECheckBoxState::Checked)
                                               Selected.Add(Id);
                                           else
                                               Selected.Remove(Id);
                                           ActorKey.Reset();
                                       })];
        Row->AddSlot().FillWidth(1)[Button(Label, [this, Id] {
            Selected.Reset(); Selected.Add(Id); Scope = TEXT("cameras"); ActorKey.Reset();
            auto A = Obj();
            A->SetStringField(TEXT("kind"), TEXT("activate"));
            A->SetStringField(TEXT("cameraId"), Id);
            Action(A);
        })];
        if (Id == Str(Active, TEXT("cameraId"))) {
        ActiveActions->AddSlot().AutoHeight().Padding(0, 3)[Button(TEXT("Duplicate"), [this, Id] {
            auto C = Command(TEXT("duplicate"));
            C->SetStringField(TEXT("cameraId"), Id);
            C->SetStringField(TEXT("newCameraId"), TEXT("camera-") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
            C->SetStringField(TEXT("newViewId"), TEXT("view-") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
            Submit(C);
        })];
        ActiveActions->AddSlot().AutoHeight().Padding(0, 3)[Button(TEXT("Unpin"), [this, Id] {
            auto C = Command(TEXT("unpin"));
            C->SetStringField(TEXT("cameraId"), Id);
            Submit(C);
        })];
        ActiveActions->AddSlot().AutoHeight().Padding(0, 3)[Button(TEXT("Remove…"), [this, Id] {
            auto A = Obj();
            A->SetStringField(TEXT("kind"), TEXT("remove"));
            A->SetArrayField(TEXT("cameraIds"), {MakeShared<FJsonValueString>(Id)});
            Action(A);
        })];
        for (int32 Direction : {-1, 1})
            ActiveActions->AddSlot().AutoHeight().Padding(0, 3)[Button(Direction < 0 ? TEXT("↑") : TEXT("↓"), [this, Id, Direction] {
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
        CameraRows->AddSlot().AutoHeight().Padding(0, 2)[Row];
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
void SCameraArrangementPanel::RebuildActors()
{
    ActorRows->ClearChildren();
    const auto Local = LocalVisibility();
    for (const TCHAR *Field : {TEXT("hide"), TEXT("protect")})
        for (const auto &V : Items(Local, Field))
        {
            const auto E = V->AsObject();
            const FString Key = Json(Child(E, TEXT("locator")));
            ActorRows->AddSlot()
                .AutoHeight()[SNew(SHorizontalBox) +
                              SHorizontalBox::Slot().FillWidth(
                                  1)[Text(FString(Field) + TEXT(" · local · ") + Str(E, TEXT("label")))] +
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
                              })]];
        }
    for (const auto &V : Items(Panel, TEXT("cameras")))
        if (Str(V->AsObject(), TEXT("id")) == Str(Active, TEXT("cameraId")))
        {
            const auto Lists = Child(V->AsObject(), TEXT("visibility"));
            ActorRows->AddSlot().AutoHeight()[Text(
                TEXT("ACTIVE CAMERA · Effective exclusions, including inheritance; protection wins"))];
            for (const TCHAR *F : {TEXT("hide"), TEXT("protect")})
                for (const auto &E : Items(Lists, F))
                    ActorRows->AddSlot()
                        .AutoHeight()[Text(FString(F) + TEXT(" · ") + Str(E->AsObject(), TEXT("label")))];
            auto Q = Request(TEXT("resolve_visibility"));
            Q->SetObjectField(TEXT("actors"), Lists);
            const auto R = Call(Q);
            for (const auto &D : Items(R, TEXT("diagnostics")))
                if (Str(D->AsObject(), TEXT("status")) != TEXT("resolved"))
                    ActorRows->AddSlot().AutoHeight()[Text(Str(D->AsObject(), TEXT("status")) + TEXT(" · ") +
                                                           Json(Child(D->AsObject(), TEXT("locator"))) + TEXT(": ") +
                                                           Str(D->AsObject(), TEXT("message")))];
        }
}
