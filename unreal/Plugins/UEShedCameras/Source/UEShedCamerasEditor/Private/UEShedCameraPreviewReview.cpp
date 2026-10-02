#include "UEShedCameraPreviewReview.h"
#include "Camera/CameraTypes.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Editor.h"
#include "Engine/Texture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "UEShedCameraRenderSession.h"
#include "UEShedCameraSubjectAssessment.h"
#include "UEShedEditorPreviews.h"
#include "UObject/ObjectSaveContext.h"
#include "UObject/Package.h"

struct FUEShedCameraPreviewReview::FEntry
{
    FUEShedCameraPreviewView View;
    TStrongObjectPtr<UTexture2D> Snapshot;
    TStrongObjectPtr<UTexture2D> Thumbnail;
    FUEShedCameraSubjectVisibility Visibility;
    FString Error;
};

namespace
{
UTexture2D *TransientTexture(const FImage &Image)
{
    auto *Texture = UTexture2D::CreateTransient(Image.SizeX, Image.SizeY, PF_B8G8R8A8, NAME_None,
                                                MakeArrayView(Image.RawData.GetData(), Image.RawData.Num()));
    if (Texture)
        Texture->UpdateResource();
    return Texture;
}

/** Interprets the review capture's raw measurement for one completed snapshot. */
FUEShedCameraSubjectVisibility AssessSubject(UWorld *World, const FUEShedCameraPreviewView &View,
                                             USceneCaptureComponent2D *Component, int32 Width, int32 Height)
{
    using EStatus = FUEShedCameraSubjectVisibility::EStatus;
    FUEShedCameraSubjectVisibility Result;
    AActor *Subject = View.Subject.Get();
    if (!Subject || !Component)
        return Result;
    FVector Center, Extent;
    Subject->GetActorBounds(false, Center, Extent, true);
    FMinimalViewInfo Info;
    Info.Location = View.Location;
    Info.Rotation = View.Rotation;
    Info.FOV = View.FieldOfView;
    Info.AspectRatio = double(Width) / Height;
    Info.ProjectionMode = ECameraProjectionMode::Perspective;
    auto Projection = UEShedProjectReviewSubject(Center, Extent, FRotator::ZeroRotator, Info);
    FString ProjectionStatus, ViewportStatus;
    Projection->TryGetStringField(TEXT("status"), ProjectionStatus);
    Projection->TryGetStringField(TEXT("viewportStatus"), ViewportStatus);
    const bool Straddles = ProjectionStatus == TEXT("unprojectable");
    bool Behind = true;
    for (const double X : {-1., 1.})
        for (const double Y : {-1., 1.})
            for (const double Z : {-1., 1.})
                Behind &= FVector::DotProduct(Center + Extent * FVector(X, Y, Z) - View.Location,
                                              View.Rotation.Vector()) <= 0;
    if (Behind || ViewportStatus == TEXT("fully_outside_viewport"))
    {
        Result.Status = EStatus::OutOfShot;
        return Result;
    }
    if (Straddles)
    {
        // Bounds that cross the camera plane have no projected box, but rendered depth still
        // measures whatever part reaches the frame.
        Projection = MakeShared<FJsonObject>();
        Projection->SetStringField(TEXT("status"), TEXT("projected"));
        Projection->SetStringField(TEXT("viewportStatus"), TEXT("partially_outside_viewport"));
    }
    Result.CutOff = Straddles || ViewportStatus == TEXT("partially_outside_viewport");
    const auto Measured = UEShedAssessReviewVisibility(World, Subject, View.Location, Center, Extent,
                                                       FRotator::ZeroRotator, TEXT("depth_compare"), Projection,
                                                       Component, Width, Height);
    FString Status;
    Measured->TryGetStringField(TEXT("status"), Status);
    if (Status == TEXT("assessed") && Measured->TryGetNumberField(TEXT("visibleFraction"), Result.VisibleFraction))
    {
        Result.Status = Result.VisibleFraction >= FUEShedCameraSubjectVisibility::ClearAtOrAbove ? EStatus::Visible
                        : Result.VisibleFraction <= FUEShedCameraSubjectVisibility::BlockedAtOrBelow
                            ? EStatus::Blocked
                            : EStatus::Partial;
        return Result;
    }
    const TSharedPtr<FJsonObject> *Failure = nullptr;
    FString Code;
    if (Measured->TryGetObjectField(TEXT("failure"), Failure))
    {
        (*Failure)->TryGetStringField(TEXT("code"), Code);
        (*Failure)->TryGetStringField(TEXT("message"), Result.Message);
    }
    else
        Measured->TryGetStringField(TEXT("reason"), Result.Message);
    // No subject pixels: nothing of a subject reaching past the frame edge is in the shot, while a
    // subject inside the frame did not render at all (hidden, editor-only or not depth-writing).
    Result.Status = Code != TEXT("subject_depth_unavailable") ? EStatus::Failed
                    : Straddles                               ? EStatus::OutOfShot
                                                              : EStatus::NotRendered;
    return Result;
}
} // namespace

FUEShedCameraPreviewReview::FUEShedCameraPreviewReview() : EditorPreviews(MakeUnique<FUEShedEditorPreviews>())
{
    CleanupHandle = FWorldDelegates::OnWorldCleanup.AddLambda([this](UWorld *Closing, bool, bool) {
        if (World.Get() == Closing || !World.IsValid())
            Release(false);
    });
    PlayHandle = FEditorDelegates::PreBeginPIE.AddLambda([this](bool) { Reset(); });
    // Revealed editor previews must never be saved, including by autosave during a review.
    PreSaveHandle = FCoreUObjectDelegates::OnObjectPreSave.AddLambda(
        [this](UObject *Object, FObjectPreSaveContext) { EditorPreviews->PreSave(Object); });
    SavedHandle = UPackage::PackageSavedWithContextEvent.AddLambda(
        [this](const FString &, UPackage *Package, FObjectPostSaveContext) { EditorPreviews->PostSave(Package); });
}

FUEShedCameraPreviewReview::~FUEShedCameraPreviewReview()
{
    FWorldDelegates::OnWorldCleanup.Remove(CleanupHandle);
    FEditorDelegates::PreBeginPIE.Remove(PlayHandle);
    FCoreUObjectDelegates::OnObjectPreSave.Remove(PreSaveHandle);
    UPackage::PackageSavedWithContextEvent.Remove(SavedHandle);
    Reset();
}

bool FUEShedCameraPreviewReview::Begin(UWorld *InWorld, const TArray<FUEShedCameraPreviewView> &Views, FString &Error)
{
    Reset();
    Error.Reset();
    if (!IsValid(InWorld) || InWorld->WorldType != EWorldType::Editor || (GEditor && GEditor->PlayWorld) ||
        Views.Num() > MaximumViews)
    {
        Error = TEXT("Review requires an editor world, Play/Simulate stopped, and at most 256 cameras.");
        return false;
    }
    TSet<FString> Ids;
    for (const auto &View : Views)
    {
        if (View.Id.IsEmpty() || Ids.Contains(View.Id))
        {
            Error = TEXT("Review cameras require unique, nonempty IDs.");
            return false;
        }
        Ids.Add(View.Id);
    }
    World = InWorld;
    for (const auto &View : Views)
    {
        auto Entry = MakeUnique<FEntry>();
        Entry->View = View;
        Entries.Add(MoveTemp(Entry));
    }
    return true;
}

void FUEShedCameraPreviewReview::Tick(double Time)
{
    check(IsInGameThread());
    if (!IsRunning() || FUEShedCameraRenderSession::IsBusy())
        return;
    auto &Entry = *Entries[Current];
    // Same rule as the shared renderer's renderer.editorPreviews; rescanned every frame.
    if (Entry.View.EditorPreviews)
        EditorPreviews->Apply(World.Get());
    else if (EditorPreviews->Num() > 0)
        EditorPreviews->Restore(true);
    if (Capture.Num() == 0 && !Capture.SetViews(World.Get(), {Entry.View}, Entry.Error))
    {
        ++Current;
        if (!IsRunning())
            EditorPreviews->Restore(true);
        return;
    }
    Capture.Tick(Time, false);
    if (Capture.NeedsRefresh())
        return;
    FImage Image;
    if (FImageUtils::GetRenderTargetImage(Capture.Texture(Entry.View.Id), Image))
    {
        // Store only the completed image, not a camera actor or its expensive view state.
        Image.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
        Entry.Snapshot.Reset(TransientTexture(Image));
        FImage Small;
        FImageCore::ResizeImageAllocDest(Image, Small, ThumbnailWidth, ThumbnailHeight);
        Entry.Thumbnail.Reset(TransientTexture(Small));
        // Measured on the same settled capture, with the same exclusions and editor previews.
        Entry.Visibility = AssessSubject(World.Get(), Entry.View, Capture.Component(Entry.View.Id), Image.SizeX,
                                         Image.SizeY);
    }
    if (!Entry.Snapshot.IsValid())
        Entry.Error = TEXT("Could not read the rendered preview. Refresh to retry.");
    Capture.Reset();
    ++Current;
    if (!IsRunning())
        EditorPreviews->Restore(true);
}

bool FUEShedCameraPreviewReview::IsRunning() const
{
    return World.IsValid() && Current < Entries.Num();
}
int32 FUEShedCameraPreviewReview::Completed() const
{
    return Current;
}
int32 FUEShedCameraPreviewReview::Failed() const
{
    int32 Count = 0;
    for (const auto &Entry : Entries)
        if (!Entry->Error.IsEmpty())
            ++Count;
    return Count;
}
int32 FUEShedCameraPreviewReview::Num() const
{
    return Entries.Num();
}
int32 FUEShedCameraPreviewReview::ActiveCaptures() const
{
    return Capture.Num();
}
UTexture2D *FUEShedCameraPreviewReview::Texture(const FString &Id) const
{
    for (const auto &Entry : Entries)
        if (Entry->View.Id == Id)
            return Entry->Snapshot.Get();
    return nullptr;
}
UTexture2D *FUEShedCameraPreviewReview::Thumbnail(const FString &Id) const
{
    for (const auto &Entry : Entries)
        if (Entry->View.Id == Id)
            return Entry->Thumbnail.Get();
    return nullptr;
}
const FUEShedCameraSubjectVisibility *FUEShedCameraPreviewReview::SubjectVisibility(const FString &Id) const
{
    for (const auto &Entry : Entries)
        if (Entry->View.Id == Id)
            return &Entry->Visibility;
    return nullptr;
}
int32 FUEShedCameraPreviewReview::RevealedEditorPreviews() const
{
    return EditorPreviews->Num();
}
FString FUEShedCameraPreviewReview::Error(const FString &Id) const
{
    for (const auto &Entry : Entries)
        if (Entry->View.Id == Id)
            return Entry->Error;
    return {};
}
void FUEShedCameraPreviewReview::Reset()
{
    Release(true);
}
void FUEShedCameraPreviewReview::Release(bool bRecreateRenderState)
{
    Capture.Reset();
    Entries.Reset();
    World.Reset();
    Current = 0;
    // World teardown skips render-state recreation, as the shared renderer does.
    EditorPreviews->Restore(bRecreateRenderState);
}
