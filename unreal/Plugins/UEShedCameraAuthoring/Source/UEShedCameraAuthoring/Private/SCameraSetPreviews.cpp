#include "SCameraSetPreviews.h"
#include "CameraShotStatus.h"
#include "CameraPreviewShelf.h"
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
                return FText::FromString(Summary());
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
                                    "evidence; viewport rendering may differ. Subject visibility is measured from "
                                    "rendered depth, so translucent subjects can read as not rendered. Refresh after "
                                    "scene changes.")))]]];
    Poll(0, 0);
    RegisterActiveTimer(.2f, FWidgetActiveTimerDelegate::CreateSP(this, &SCameraSetPreviews::Poll));
}

void SCameraSetPreviews::Clear()
{
    Review.Reset();
    if (Grid)
        Grid->ClearChildren();
    Errors.Reset();
    Order.Reset();
    Subject.Reset();
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
    Order.Reset();
    Failure.Reset();
    Initial = false;
    Stale = false;
    SnapshotKey = Key(Snapshot);
    Title = TEXT("Camera previews · ") + Str(Arrangement, TEXT("displayName"));
    TArray<FUEShedCameraPreviewView> Views;
    const auto Policy = Child(Panel, TEXT("renderPolicy")), Renderer = Child(Policy, TEXT("renderer")),
               Exposure = Child(Policy, TEXT("exposure"));
    // The same subject and editor-preview policy the host capture uses, so tiles show what it will.
    Subject = UEShedResolveCameraActor(Proxy->GetWorld(), Child(Arrangement, TEXT("subject")));
    EditorPreviews = Flag(Renderer, TEXT("editorPreviews"));
    Queued.Reset();
    Published = 0;
    Keys.Reset();
    for (const auto &Definition : Cameras)
    {
        const FString Id = Str(Definition->AsObject(), TEXT("id"));
        Keys.Add(Id, FCameraPreviewShelf::Key(Panel, Id));
        AddCamera(Id, Str(Definition->AsObject(), TEXT("displayName")));
        Order.Add(Id);
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
        View.Subject = Subject;
        View.EditorPreviews = EditorPreviews;
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
        // Sets without an output choice capture the level as it is, so their previews do too.
        const FString Output = Str(Arrangement, TEXT("output"));
        if (!Output.IsEmpty() && Output != TEXT("natural_only"))
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
        Queued.Add(Id);
    }
    // Cameras that cannot render must not keep showing an older thumbnail in the camera list.
    for (const auto &Error : Errors)
        FCameraPreviewShelf::Get().Remove(Identity, Error.Key);
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
           SVerticalBox::Slot().AutoHeight()[SNew(STextBlock)
               .AutoWrapText(true)
               .ColorAndOpacity_Lambda([this, Id] {
                   const bool Rendered = !Errors.Contains(Id) && Review.Error(Id).IsEmpty() && Review.Texture(Id);
                   return FSlateColor(Rendered ? Shot(Id).Color : FLinearColor(.6f, .6f, .6f));
               })
               .ToolTipText_Lambda([this, Id] {
                   return FText::FromString(Review.Texture(Id) ? Shot(Id).Detail : FString());
               })
               .Text_Lambda([this, Id] {
                   if (const auto *Error = Errors.Find(Id))
                       return FText::FromString(*Error);
                   const FString Error = Review.Error(Id);
                   return FText::FromString(!Error.IsEmpty()     ? Error
                                            : Review.Texture(Id) ? Shot(Id).Label
                                                                 : TEXT("Queued…"));
               })]]]];
}

FCameraShotStatus SCameraSetPreviews::Shot(const FString &Id) const
{
    return DescribeShot(Review.SubjectVisibility(Id), Subject.IsValid(), EditorPreviews);
}

FString SCameraSetPreviews::Summary() const
{
    // Only shots that show the subject count as good; the rest say what is wrong.
    using ECategory = FCameraShotStatus::ECategory;
    int32 Counts[4] = {0, 0, 0, 0}, Rendered = 0;
    for (const auto &Id : Order)
        if (Review.Texture(Id))
        {
            ++Rendered;
            ++Counts[int32(Shot(Id).Category)];
        }
    TArray<FString> Parts;
    if (!Subject.IsValid())
        Parts.Add(FString::Printf(TEXT("%d rendered · subject not found in the level, so shots weren't checked"),
                                  Rendered));
    else
    {
        if (const int32 N = Counts[int32(ECategory::Shows)])
            Parts.Add(FString::Printf(TEXT("%d %s the subject"), N, N == 1 ? TEXT("shows") : TEXT("show")));
        if (const int32 N = Counts[int32(ECategory::Partly)])
            Parts.Add(FString::Printf(TEXT("%d partly %s it"), N, N == 1 ? TEXT("shows") : TEXT("show")));
        if (const int32 N = Counts[int32(ECategory::Missing)])
            Parts.Add(FString::Printf(TEXT("%d %s show it"), N, N == 1 ? TEXT("doesn't") : TEXT("don't")));
        if (const int32 N = Counts[int32(ECategory::Unchecked)])
            Parts.Add(FString::Printf(TEXT("%d not checked"), N));
    }
    if (const int32 Unavailable = Errors.Num() + Review.Failed())
        Parts.Add(FString::Printf(TEXT("%d couldn't render"), Unavailable));
    return TEXT("Review complete · ") + FString::Join(Parts, TEXT(" · "));
}

void SCameraSetPreviews::Publish()
{
    // Hand each completed snapshot's thumbnail and subject check to the camera list.
    for (; Published < Review.Completed() && Queued.IsValidIndex(Published); ++Published)
    {
        const FString &Id = Queued[Published];
        auto *Thumbnail = Review.Thumbnail(Id);
        if (!Thumbnail)
        {
            FCameraPreviewShelf::Get().Remove(Identity, Id);
            continue;
        }
        FCameraPreviewShelf::FShot Shot;
        Shot.Thumbnail.Reset(Thumbnail);
        Shot.Key = Keys.FindRef(Id);
        if (const auto *Visibility = Review.SubjectVisibility(Id))
            Shot.Visibility = *Visibility;
        Shot.bSubjectFound = Subject.IsValid();
        Shot.bEditorPreviews = EditorPreviews;
        FCameraPreviewShelf::Get().Put(Identity, Id, MoveTemp(Shot));
    }
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
    Publish();
    return Review.IsRunning() ? EActiveTimerReturnType::Continue : EActiveTimerReturnType::Stop;
}
