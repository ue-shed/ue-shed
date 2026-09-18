#include "UEShedCameraPreviewReview.h"
#include "Editor.h"
#include "Engine/Texture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "ImageUtils.h"

struct FUEShedCameraPreviewReview::FEntry
{
    FUEShedCameraPreviewView View;
    TStrongObjectPtr<UTexture2D> Snapshot;
    FString Error;
};

FUEShedCameraPreviewReview::FUEShedCameraPreviewReview()
{
    CleanupHandle = FWorldDelegates::OnWorldCleanup.AddLambda([this](UWorld *Closing, bool, bool) {
        if (World.Get() == Closing || !World.IsValid())
            Reset();
    });
    PlayHandle = FEditorDelegates::PreBeginPIE.AddLambda([this](bool) { Reset(); });
}

FUEShedCameraPreviewReview::~FUEShedCameraPreviewReview()
{
    FWorldDelegates::OnWorldCleanup.Remove(CleanupHandle);
    FEditorDelegates::PreBeginPIE.Remove(PlayHandle);
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
    if (!IsRunning())
        return;
    auto &Entry = *Entries[Current];
    if (Capture.Num() == 0 && !Capture.SetViews(World.Get(), {Entry.View}, Entry.Error))
    {
        ++Current;
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
        Entry.Snapshot.Reset(UTexture2D::CreateTransient(Image.SizeX, Image.SizeY, PF_B8G8R8A8, NAME_None,
                                                         MakeArrayView(Image.RawData.GetData(), Image.RawData.Num())));
        if (Entry.Snapshot.IsValid())
            Entry.Snapshot->UpdateResource();
    }
    if (!Entry.Snapshot.IsValid())
        Entry.Error = TEXT("Could not read the rendered preview. Refresh to retry.");
    Capture.Reset();
    ++Current;
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
FString FUEShedCameraPreviewReview::Error(const FString &Id) const
{
    for (const auto &Entry : Entries)
        if (Entry->View.Id == Id)
            return Entry->Error;
    return {};
}
void FUEShedCameraPreviewReview::Reset()
{
    Capture.Reset();
    Entries.Reset();
    World.Reset();
    Current = 0;
}
