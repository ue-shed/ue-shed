#include "SCameraSetPreviews.h"
#include "Engine/Texture2D.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedCameraAuthoringBridge.h"
#include "UEShedCameraVisibility.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SSlider.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SWrapBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
using FObject = TSharedPtr<FJsonObject>;
FObject Child(const FObject &Object, const TCHAR *Key)
{
    const FObject *Value;
    return Object && Object->TryGetObjectField(Key, Value) ? *Value : MakeShared<FJsonObject>();
}
FString Str(const FObject &Object, const TCHAR *Key)
{
    FString Value;
    if (Object)
        Object->TryGetStringField(Key, Value);
    return Value;
}
bool Flag(const FObject &Object, const TCHAR *Key)
{
    bool Value = false;
    if (Object)
        Object->TryGetBoolField(Key, Value);
    return Value;
}
TArray<TSharedPtr<FJsonValue>> Items(const FObject &Object, const TCHAR *Key)
{
    const TArray<TSharedPtr<FJsonValue>> *Values;
    return Object && Object->TryGetArrayField(Key, Values) ? *Values : TArray<TSharedPtr<FJsonValue>>();
}
FString Key(const FObject &Active)
{
    const auto Panel = Child(Active, TEXT("panel")), Arrangement = Child(Panel, TEXT("arrangement"));
    auto Config = MakeShared<FJsonObject>();
    Config->SetArrayField(TEXT("cameras"), Items(Panel, TEXT("cameras")));
    Config->SetArrayField(TEXT("definitions"), Items(Arrangement, TEXT("cameras")));
    Config->SetObjectField(TEXT("policy"), Child(Panel, TEXT("renderPolicy")));
    Config->SetStringField(TEXT("output"), Str(Arrangement, TEXT("output")));
    FString Text;
    FJsonSerializer::Serialize(Config, TJsonWriterFactory<>::Create(&Text));
    return Text;
}
} // namespace

void SCameraSetPreviews::Construct(const FArguments &Args)
{
    PreviewVisible = Args._PreviewVisible;
    ChildSlot[SNew(SBorder).Padding(
        12)[SNew(SVerticalBox) +
            SVerticalBox::Slot().AutoHeight().Padding(
                0, 0, 0, 8)[SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 14)).Text_Lambda([this] {
                return FText::FromString(Title);
            })] +
            SVerticalBox::Slot()
                .AutoHeight()[SNew(SHorizontalBox) +
                              SHorizontalBox::Slot().AutoWidth()[SNew(SButton)
                                                                     .Text(FText::FromString(TEXT("Refresh all")))
                                                                     .IsEnabled_Lambda([this] { return Synced; })
                                                                     .OnClicked_Lambda([this] {
                                                                         RenderAll();
                                                                         return FReply::Handled();
                                                                     })] +
                              SHorizontalBox::Slot().AutoWidth().Padding(12, 0).VAlign(
                                  VAlign_Center)[SNew(STextBlock).Text(FText::FromString(TEXT("Tile size")))] +
                              SHorizontalBox::Slot().FillWidth(
                                  1)[SNew(SSlider)
                                         .MinValue(160)
                                         .MaxValue(640)
                                         .Value_Lambda([this] { return TileWidth; })
                                         .OnValueChanged_Lambda([this](float Value) { TileWidth = Value; })]] +
            SVerticalBox::Slot().AutoHeight().Padding(0, 8)[SNew(STextBlock).AutoWrapText(true).Text_Lambda([this] {
                if (!Message.IsEmpty())
                    return FText::FromString(Message);
                if (!Failure.IsEmpty())
                    return FText::FromString(Failure);
                if (Stale)
                    return FText::FromString(TEXT("Camera settings changed. These images are out of date — Refresh all "
                                                  "to review the latest set."));
                if (Review.IsRunning())
                    return FText::FromString(
                        FString::Printf(TEXT("Rendering %d / %d cameras…"), Review.Completed(), Review.Num()));
                return FText::FromString(FString::Printf(TEXT("Review complete · %d ready · %d unavailable"),
                                                         Review.Num() - Review.Failed(),
                                                         Errors.Num() + Review.Failed()));
            })] +
            SVerticalBox::Slot().FillHeight(
                1)[SNew(SScrollBox) +
                   SScrollBox::Slot()
                       [SAssignNew(Grid, SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8, 8))]] +
            SVerticalBox::Slot().AutoHeight().Padding(
                0, 8, 0, 0)[SNew(STextBlock)
                                .AutoWrapText(true)
                                .Text(FText::FromString(TEXT(
                                    "640 × 360 SceneCapture snapshots using the project renderer. Not final-capture "
                                    "evidence; viewport rendering may differ. Refresh after scene changes.")))]]];
    Poll(0, 0);
    RegisterActiveTimer(.2f, FWidgetActiveTimerDelegate::CreateSP(this, &SCameraSetPreviews::Poll));
}

void SCameraSetPreviews::Clear()
{
    Review.Reset();
    if (Grid)
        Grid->ClearChildren();
    Errors.Reset();
    Snapshot.Reset();
    SnapshotKey.Reset();
    Identity.Reset();
    Failure.Reset();
    Synced = false;
    Stale = false;
    Initial = true;
}

void SCameraSetPreviews::Close()
{
    Closed = true;
    Clear();
}

EActiveTimerReturnType SCameraSetPreviews::Poll(double Time, float Delta)
{
    if (Closed)
        return EActiveTimerReturnType::Stop;
    Snapshot = FUEShedCameraAuthoringBridge::InspectActive();
    const FString NextIdentity = Str(Snapshot, TEXT("producerId")) + TEXT("/") + Str(Snapshot, TEXT("sessionId"));
    if (Str(Snapshot, TEXT("status")) != TEXT("ready") ||
        !Child(Snapshot, TEXT("panel"))->HasField(TEXT("arrangement")))
    {
        Clear();
        Message = TEXT("Open a synced camera set to see previews.");
        return EActiveTimerReturnType::Continue;
    }
    if (Identity != NextIdentity)
    {
        auto Latest = Snapshot;
        Clear();
        Snapshot = Latest;
        Identity = NextIdentity;
    }
    Synced = !Flag(Snapshot, TEXT("pending")) && !Snapshot->HasField(TEXT("panelEvent"));
    Stale = !SnapshotKey.IsEmpty() && (!Synced || Key(Snapshot) != SnapshotKey);
    Message = Synced ? TEXT("") : TEXT("Camera edits are syncing. Wait for sync, then Refresh all.");
    if (Initial && Synced)
        RenderAll();
    if (Review.IsRunning() && !RenderTimer.IsValid() && PreviewVisible.Get(true))
        RenderTimer = RegisterActiveTimer(0.f, FWidgetActiveTimerDelegate::CreateSP(this, &SCameraSetPreviews::Draw));
    return EActiveTimerReturnType::Continue;
}

void SCameraSetPreviews::RenderAll()
{
    if (Closed)
        return;
    Snapshot = FUEShedCameraAuthoringBridge::InspectActive();
    if (Str(Snapshot, TEXT("status")) != TEXT("ready") || Flag(Snapshot, TEXT("pending")) ||
        Snapshot->HasField(TEXT("panelEvent")))
    {
        Message = TEXT("Wait for camera edits to sync before refreshing.");
        return;
    }
    const auto *Proxy = FUEShedCameraAuthoringBridge::Camera();
    if (!Proxy)
        return;
    const auto Panel = Child(Snapshot, TEXT("panel")), Arrangement = Child(Panel, TEXT("arrangement"));
    const auto Cameras = Items(Arrangement, TEXT("cameras"));
    if (Cameras.Num() > FUEShedCameraPreviewReview::MaximumViews)
    {
        Review.Reset();
        Grid->ClearChildren();
        Errors.Reset();
        Initial = false;
        Failure = TEXT("This review supports at most 256 cameras.");
        return;
    }
    Review.Reset();
    Grid->ClearChildren();
    Errors.Reset();
    Failure.Reset();
    Initial = false;
    Stale = false;
    SnapshotKey = Key(Snapshot);
    Title = TEXT("Camera previews · ") + Str(Arrangement, TEXT("displayName"));
    TArray<FUEShedCameraPreviewView> Views;
    const auto Policy = Child(Panel, TEXT("renderPolicy")), Renderer = Child(Policy, TEXT("renderer")),
               Exposure = Child(Policy, TEXT("exposure"));
    for (const auto &Definition : Cameras)
    {
        const FString Id = Str(Definition->AsObject(), TEXT("id"));
        AddCamera(Id, Str(Definition->AsObject(), TEXT("displayName")));
        const auto Resolved = Items(Panel, TEXT("cameras"));
        const auto *Match =
            Resolved.FindByPredicate([&Id](const auto &Value) { return Str(Value->AsObject(), TEXT("id")) == Id; });
        const auto Camera = Match ? (*Match)->AsObject() : MakeShared<FJsonObject>();
        const auto Pose = Child(Camera, TEXT("pose")), Location = Child(Pose, TEXT("location")),
                   Rotation = Child(Pose, TEXT("rotation"));
        FUEShedCameraPreviewView View;
        View.Id = Id;
        double Fov = 0;
        if (Str(Pose, TEXT("projection")) != TEXT("perspective") || Str(Pose, TEXT("aspectRatio")) != TEXT("16:9") ||
            !Location->TryGetNumberField(TEXT("x"), View.Location.X) ||
            !Location->TryGetNumberField(TEXT("y"), View.Location.Y) ||
            !Location->TryGetNumberField(TEXT("z"), View.Location.Z) ||
            !Rotation->TryGetNumberField(TEXT("pitch"), View.Rotation.Pitch) ||
            !Rotation->TryGetNumberField(TEXT("yaw"), View.Rotation.Yaw) ||
            !Rotation->TryGetNumberField(TEXT("roll"), View.Rotation.Roll) ||
            !Pose->TryGetNumberField(TEXT("fieldOfViewDegrees"), Fov))
        {
            Errors.Add(Id, TEXT("No complete perspective 16:9 pose available."));
            continue;
        }
        View.FieldOfView = Fov;
        Renderer->TryGetBoolField(TEXT("fog"), View.Fog);
        Renderer->TryGetBoolField(TEXT("volumetricFog"), View.VolumetricFog);
        double Lod = 1;
        Renderer->TryGetNumberField(TEXT("lodDistanceScale"), Lod);
        View.LodDistanceScale = Lod;
        double EV = 0;
        if (Str(Exposure, TEXT("mode")) == TEXT("fixed_ev100"))
        {
            if (!Exposure->TryGetNumberField(TEXT("ev100"), EV))
            {
                Errors.Add(Id, TEXT("Missing fixed exposure value."));
                continue;
            }
            View.FixedEV100 = EV;
        }
        if (Str(Arrangement, TEXT("output")) != TEXT("natural_only"))
        {
            const auto Visibility = UEShedResolveCameraVisibility(Proxy->GetWorld(), Child(Camera, TEXT("visibility")));
            if (!Visibility.Valid)
            {
                Errors.Add(Id, Visibility.Message);
                continue;
            }
            View.HiddenActors = Visibility.Hidden;
        }
        Views.Add(View);
    }
    if (!Review.Begin(Proxy->GetWorld(), Views, Failure))
        return;
    if (!RenderTimer.IsValid() && Review.IsRunning() && PreviewVisible.Get(true))
        RenderTimer = RegisterActiveTimer(0.f, FWidgetActiveTimerDelegate::CreateSP(this, &SCameraSetPreviews::Draw));
}

void SCameraSetPreviews::AddCamera(const FString &Id, const FString &Label)
{
    auto Brush = MakeShared<FSlateBrush>();
    Brush->DrawAs = ESlateBrushDrawType::Image;
    Brush->ImageSize = FVector2D(640, 360);
    Grid->AddSlot()[SNew(SBox).WidthOverride_Lambda([this] { return TileWidth; })[SNew(SBorder).Padding(
        6)[SNew(SVerticalBox) +
           SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).Text(FText::FromString(Label)).AutoWrapText(true)] +
           SVerticalBox::Slot().AutoHeight().Padding(0, 6)[SNew(SBox).HeightOverride_Lambda([this] {
               return (TileWidth - 12) * 9 / 16;
           })[SNew(SImage).Image_Lambda([this, Id, Brush]() -> const FSlateBrush * {
               Brush->SetResourceObject(Review.Texture(Id));
               return Review.Texture(Id) ? &Brush.Get() : nullptr;
           })]] +
           SVerticalBox::Slot().AutoHeight()[SNew(STextBlock).AutoWrapText(true).Text_Lambda([this, Id] {
               if (const auto *Error = Errors.Find(Id))
                   return FText::FromString(*Error);
               const FString Error = Review.Error(Id);
               return FText::FromString(!Error.IsEmpty()     ? Error
                                        : Review.Texture(Id) ? TEXT("Ready")
                                                             : TEXT("Queued…"));
           })]]]];
}

EActiveTimerReturnType SCameraSetPreviews::Draw(double Time, float Delta)
{
    if (Closed)
        return EActiveTimerReturnType::Stop;
    if (!FUEShedCameraAuthoringBridge::Camera())
    {
        Clear();
        return EActiveTimerReturnType::Stop;
    }
    if (!PreviewVisible.Get(true) || !Review.IsRunning())
        return EActiveTimerReturnType::Stop;
    Review.Tick(Time);
    return Review.IsRunning() ? EActiveTimerReturnType::Continue : EActiveTimerReturnType::Stop;
}
