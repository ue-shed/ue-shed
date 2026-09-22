#include "SCameraArrangementPanel.h"
#include "UEShedCameraAuthoringBridge.h"
#include "Styling/AppStyle.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SNumericEntryBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SExpandableArea.h"
#include "Widgets/Layout/SUniformGridPanel.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
FString Value(const TSharedPtr<FJsonObject>& O, const TCHAR* Key)
{
    FString V;
    if (O) O->TryGetStringField(Key, V);
    return V;
}
TSharedPtr<FJsonObject> Selection(const TSharedPtr<FJsonObject>& Setup)
{
    const TSharedPtr<FJsonObject>* S;
    return Setup && Setup->TryGetObjectField(TEXT("selection"), S) ? *S : MakeShared<FJsonObject>();
}
bool Connected(const TSharedPtr<FJsonObject>& Setup)
{
    bool B = false;
    return Setup && Setup->TryGetBoolField(TEXT("connected"), B) && B;
}
}

void SCameraArrangementPanel::StartSetup(bool New)
{
    if (!CreatingId.IsEmpty()) return;
    NewSetup = New;
    SetupOpen = true;
    SetupName.Reset();
    Message.Reset();
}
SCameraArrangementPanel::FObject SCameraArrangementPanel::Layout() const
{
    auto L = MakeShared<FJsonObject>();
    L->SetStringField(TEXT("kind"), LayoutKind);
    L->SetNumberField(TEXT("count"), LayoutKind == TEXT("single") ? 1 : Count);
    L->SetNumberField(TEXT("startDegrees"), Start);
    L->SetNumberField(TEXT("spanDegrees"), Span);
    L->SetStringField(TEXT("orientation"), SubjectOrientation ? TEXT("subject") : TEXT("world"));
    return L;
}
void SCameraArrangementPanel::CreateFromPreset()
{
    if (!CreatingId.IsEmpty()) return;
    if (!NewSetup && Panel->HasField(TEXT("arrangement")))
    {
        auto A = MakeShared<FJsonObject>();
        A->SetStringField(TEXT("kind"), TEXT("layout"));
        A->SetObjectField(TEXT("layout"), Layout());
        A->SetBoolField(TEXT("retainExisting"), Retain);
        Action(A);
        return;
    }
    const auto Subject = Selection(Setup);
    auto Intent = MakeShared<FJsonObject>(), Q = MakeShared<FJsonObject>();
    const FString Id = FGuid::NewGuid().ToString(EGuidFormats::Digits);
    Intent->SetStringField(TEXT("id"), Id);
    Intent->SetStringField(TEXT("actorPath"), Value(Subject, TEXT("actorPath")));
    Intent->SetStringField(TEXT("mapPath"), Value(Subject, TEXT("mapPath")));
    Intent->SetStringField(TEXT("name"), SetupName.TrimStartAndEnd().IsEmpty() ? Value(Subject, TEXT("displayName")).Left(80) : SetupName.TrimStartAndEnd());
    Intent->SetObjectField(TEXT("layout"), Layout());
    Q->SetNumberField(TEXT("version"), 1);
    Q->SetStringField(TEXT("operation"), TEXT("setup_create"));
    Q->SetObjectField(TEXT("intent"), Intent);
    const auto Result = Call(Q);
    if (Value(Result, TEXT("status")) == TEXT("setup")) CreatingId = Id;
}
TSharedRef<SWidget> SCameraArrangementPanel::BuildSetup()
{
    auto Body = SNew(SVerticalBox).IsEnabled_Lambda([this] { return CreatingId.IsEmpty(); });
    Body->AddSlot().AutoHeight().Padding(0, 0, 0, 12)[SNew(STextBlock)
        .Font(FAppStyle::GetFontStyle("NormalFontBold"))
        .Text_Lambda([this] { return FText::FromString(NewSetup ? TEXT("Create a camera set") : TEXT("Change camera preset")); })];
    Body->AddSlot().AutoHeight().Padding(0, 0, 0, 12)[SNew(STextBlock).AutoWrapText(true)
        .Text_Lambda([this] {
            if (!NewSetup) return FText::FromString(TEXT("Choose a new arrangement around this subject. Review the changes before applying."));
            const FString Name = Value(Selection(Setup), TEXT("displayName"));
            return FText::FromString(Name.IsEmpty() ? TEXT("1. Select one subject actor in the viewport or Outliner.") : TEXT("Subject: ") + Name);
        })];
    Body->AddSlot().AutoHeight().Padding(0, 0, 0, 6)[SNew(STextBlock).Text(FText::FromString(TEXT("Choose a starting preset")))];
    auto Grid = SNew(SUniformGridPanel).SlotPadding(3);
    struct FPreset { const TCHAR* Label; const TCHAR* Description; const TCHAR* Kind; int32 Count; double Start; double Span; };
    const FPreset Presets[] = {
        {TEXT("Single"), TEXT("1 camera · one fitted view"), TEXT("single"), 1, 0, 0},
        {TEXT("Four sides"), TEXT("4 cameras · around the actor"), TEXT("orbit"), 4, 0, 360},
        {TEXT("Front arc"), TEXT("3 cameras · front and corners"), TEXT("arc"), 3, -45, 90},
        {TEXT("Full orbit"), TEXT("8 cameras · every 45 degrees"), TEXT("orbit"), 8, 0, 360}
    };
    for (int32 I = 0; I < 4; ++I)
    {
        const auto P = Presets[I];
        Grid->AddSlot(I % 2, I / 2)[SNew(SButton).ContentPadding(FMargin(10, 8))
            .ButtonStyle(FAppStyle::Get(), "Button")
            .ButtonColorAndOpacity_Lambda([this, P] {
                return LayoutKind == P.Kind && Count == P.Count && Start == P.Start && Span == P.Span ? FLinearColor(.16f, .42f, .64f) : FLinearColor(.24f, .24f, .24f);
            })
            .OnClicked_Lambda([this, P] { LayoutKind = P.Kind; Count = P.Count; Start = P.Start; Span = P.Span; return FReply::Handled(); })
            [SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).Font(FAppStyle::GetFontStyle("NormalFontBold")).Text(FText::FromString(P.Label))]
                + SVerticalBox::Slot().AutoHeight().Padding(0, 4, 0, 0)[SNew(STextBlock).AutoWrapText(true).Text(FText::FromString(P.Description))]]];
    }
    Body->AddSlot().AutoHeight()[Grid];
    auto Options = SNew(SVerticalBox);
    Options->AddSlot().AutoHeight().Padding(0, 4)[SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1)[SNew(STextBlock).Text(FText::FromString(TEXT("Camera count")))]
        + SHorizontalBox::Slot().FillWidth(1)[SNew(SNumericEntryBox<int32>).MinValue(1).MaxValue(256)
            .AllowSpin(true).Delta(1).MinSliderValue(1).MaxSliderValue(16)
            .IsEnabled_Lambda([this] { return LayoutKind != TEXT("single"); })
            .Value_Lambda([this] { return static_cast<int32>(Count); })
            .OnValueChanged_Lambda([this](int32 N) { Count = FMath::Clamp(N, 1, 256); })
            .OnValueCommitted_Lambda([this](int32 N, ETextCommit::Type) { Count = FMath::Clamp(N, 1, 256); })]];
    Options->AddSlot().AutoHeight().Padding(0, 4)[Number(TEXT("Start angle (degrees)"), Start)];
    Options->AddSlot().AutoHeight().Padding(0, 4)[Number(TEXT("Arc span (degrees)"), Span, true)];
    Options->AddSlot().AutoHeight().Padding(0, 4)[SNew(SCheckBox).OnCheckStateChanged_Lambda([this](ECheckBoxState S) { SubjectOrientation = S == ECheckBoxState::Checked; })
        [SNew(STextBlock).Text(FText::FromString(TEXT("Orient with the subject")))]];
    Body->AddSlot().AutoHeight().Padding(0, 8)[SNew(SExpandableArea).InitiallyCollapsed(true)
        .HeaderContent()[SNew(STextBlock).Text(FText::FromString(TEXT("Customize count and angles")))]
        .BodyContent()[Options]];
    Body->AddSlot().AutoHeight().Padding(0, 4)[SNew(SBox).Visibility_Lambda([this] { return NewSetup ? EVisibility::Visible : EVisibility::Collapsed; })
        [SNew(SEditableTextBox).HintText(FText::FromString(TEXT("Set name (defaults to actor name)")))
            .Text_Lambda([this] { return FText::FromString(SetupName); })
            .OnTextChanged_Lambda([this](const FText& T) { SetupName = T.ToString().Left(80); })]];
    Body->AddSlot().AutoHeight().Padding(0, 4)[SNew(SCheckBox)
        .Visibility_Lambda([this] { return NewSetup ? EVisibility::Collapsed : EVisibility::Visible; })
        .IsChecked_Lambda([this] { return Retain ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
        .OnCheckStateChanged_Lambda([this](ECheckBoxState S) { Retain = S == ECheckBoxState::Checked; })
        [SNew(STextBlock).Text(FText::FromString(TEXT("Keep existing camera adjustments")))]];
    Body->AddSlot().AutoHeight().Padding(0, 8)[SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(1)[SNew(SButton).ButtonStyle(FAppStyle::Get(), "PrimaryButton").ContentPadding(FMargin(12, 8))
            .IsEnabled_Lambda([this] { return CreatingId.IsEmpty() && (NewSetup ? Connected(Setup) && !Value(Selection(Setup), TEXT("actorPath")).IsEmpty() : Ready()); })
            .Text_Lambda([this] { return FText::FromString(!CreatingId.IsEmpty() ? TEXT("Creating cameras…") : NewSetup ? FString::Printf(TEXT("Create %d camera%s"), static_cast<int32>(Count), Count == 1 ? TEXT("") : TEXT("s")) : TEXT("Review changes")); })
            .OnClicked_Lambda([this] { CreateFromPreset(); return FReply::Handled(); })]
        + SHorizontalBox::Slot().AutoWidth().Padding(6, 0)[SNew(SBox).Visibility_Lambda([this] { return Panel->HasField(TEXT("arrangement")) ? EVisibility::Visible : EVisibility::Collapsed; })
            [Button(TEXT("Cancel"), [this] { SetupOpen = false; }, false)]]];
    Body->AddSlot().AutoHeight()[SNew(STextBlock).AutoWrapText(true)
        .Text_Lambda([this] { return FText::FromString(NewSetup && !Connected(Setup) ? TEXT("Waiting for a camera host for this project. Keep Workbench connected in the background.") : TEXT("Cameras stay out of level data. Edits sync automatically to the camera set.")); })];
    Body->AddSlot().AutoHeight().Padding(0, 6)[SAssignNew(ProposalRows, SVerticalBox)];
    return SNew(SBorder).BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder")).Padding(14)[Body];
}
