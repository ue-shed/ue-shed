#include "UEShedCameraPreviewPool.h"

#include "Components/SceneCaptureComponent2D.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/IConsoleManager.h"
#include "UEShedCameraRenderSession.h"
#include "UEShedTransientCapture.h"

struct FUEShedCameraPreviewPool::FEntry
{
    FString Id;
    TUniquePtr<FUEShedTransientCapture> Capture;
    int32 Pending = 2;
    uint64 Frames = 0;
};

FUEShedCameraPreviewPool::FUEShedCameraPreviewPool(bool InReviewQuality) : ReviewQuality(InReviewQuality)
{
    CleanupHandle = FWorldDelegates::OnWorldCleanup.AddLambda([this](UWorld *Closing, bool, bool) {
        if (World.Get() == Closing || !World.IsValid())
            Reset();
    });
    PlayHandle = FEditorDelegates::PreBeginPIE.AddLambda([this](bool) { Reset(); });
}

FUEShedCameraPreviewPool::~FUEShedCameraPreviewPool()
{
    FWorldDelegates::OnWorldCleanup.Remove(CleanupHandle);
    FEditorDelegates::PreBeginPIE.Remove(PlayHandle);
    Reset();
}

bool FUEShedCameraPreviewPool::SetViews(UWorld *InWorld, const TArray<FUEShedCameraPreviewView> &Views, FString &Error)
{
    check(IsInGameThread());
    Error.Reset();
    TSet<FString> Ids;
    if (!IsValid(InWorld) || InWorld->WorldType != EWorldType::Editor || (GEditor && GEditor->PlayWorld) ||
        Views.Num() > MaximumViews)
        Error = TEXT("Previews require an editor world and at most four cameras; stop Play/Simulate first.");
    for (const auto &View : Views)
    {
        if (View.Id.IsEmpty() || Ids.Contains(View.Id) || View.Location.ContainsNaN() || View.Rotation.ContainsNaN() ||
            !FMath::IsFinite(View.FieldOfView) || View.FieldOfView <= 0 || View.FieldOfView >= 180 ||
            !FMath::IsFinite(View.LodDistanceScale) || View.LodDistanceScale < .1f || View.LodDistanceScale > 100 ||
            (View.FixedEV100.IsSet() && (!FMath::IsFinite(View.FixedEV100.GetValue()) ||
                                         View.FixedEV100.GetValue() < -20 || View.FixedEV100.GetValue() > 30)))
            Error = TEXT("Preview cameras require unique IDs, finite poses, and valid lens/render settings.");
        Ids.Add(View.Id);
    }
    if (!Error.IsEmpty())
    {
        Reset();
        return false;
    }
    if (World.Get() != InWorld)
        Reset();
    World = InWorld;
    Entries.RemoveAll([&Ids](const auto &Entry) { return !Ids.Contains(Entry->Id); });
    for (const auto &View : Views)
    {
        auto *Found = Entries.FindByPredicate([&View](const auto &Entry) { return Entry->Id == View.Id; });
        if (!Found)
        {
            auto Entry = MakeUnique<FEntry>();
            Entry->Id = View.Id;
            Entry->Capture =
                FUEShedTransientCapture::Create(InWorld, View.Location, View.Rotation, ReviewQuality ? 640 : 320,
                                                ReviewQuality ? 360 : 180, TEXT("UEShedCameraPreview"));
            if (!Entry->Capture)
            {
                Error = TEXT("Could not create a transient camera preview.");
                Reset();
                return false;
            }
            Entry->Capture->BeginPersistentCameraCut();
            if (ReviewQuality)
                Entry->Capture->ConfigureFullFidelityRenderer();
            Entries.Add(MoveTemp(Entry));
            Found = &Entries.Last();
        }
        auto &Entry = **Found;
        auto *Component = Entry.Capture->Component();
        Component->SetWorldLocationAndRotation(View.Location, View.Rotation);
        Entry.Capture->ConfigurePerspective(View.FieldOfView);
        Entry.Capture->ConfigureRenderPolicy(View.Fog, View.VolumetricFog, View.LodDistanceScale);
        Component->HiddenActors.Reset();
        for (const auto &Actor : View.HiddenActors)
            if (Actor.IsValid())
                Component->HiddenActors.Add(Actor.Get());
        auto &Exposure = Component->PostProcessSettings;
        Exposure.bOverride_AutoExposureMinBrightness = View.FixedEV100.IsSet();
        Exposure.bOverride_AutoExposureMaxBrightness = View.FixedEV100.IsSet();
        if (View.FixedEV100.IsSet())
        {
            const auto *Extended = IConsoleManager::Get().FindConsoleVariable(
                TEXT("r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange"));
            const auto *Lens = IConsoleManager::Get().FindConsoleVariable(TEXT("r.EyeAdaptation.LensAttenuation"));
            const float EV = View.FixedEV100.GetValue();
            Exposure.AutoExposureMinBrightness = Exposure.AutoExposureMaxBrightness =
                Extended && Extended->GetInt()
                    ? EV
                    : .78f / FMath::Max(.01f, Lens ? Lens->GetFloat() : .78f) * FMath::Pow(2.f, EV);
        }
        Component->PostProcessBlendWeight = ReviewQuality || View.FixedEV100.IsSet() ? 1.f : 0.f;
        Entry.Pending = ReviewQuality ? 8 : 2;
    }
    Next = Entries.IsEmpty() ? 0 : Next % Entries.Num();
    return true;
}

void FUEShedCameraPreviewPool::UpdatePose(const FString &Id, const FVector &Location, const FRotator &Rotation,
                                          float Fov)
{
    if (Location.ContainsNaN() || Rotation.ContainsNaN() || !FMath::IsFinite(Fov) || Fov <= 0 || Fov >= 180)
        return;
    for (const auto &Entry : Entries)
        if (Entry->Id == Id)
        {
            Entry->Capture->Component()->SetWorldLocationAndRotation(Location, Rotation);
            Entry->Capture->ConfigurePerspective(Fov);
            return;
        }
}

void FUEShedCameraPreviewPool::RequestRefresh()
{
    for (const auto &Entry : Entries)
        Entry->Pending = ReviewQuality ? 8 : 2;
}

FString FUEShedCameraPreviewPool::Tick(double Seconds, bool Realtime)
{
    check(IsInGameThread());
    if (!World.IsValid() || (GEditor && GEditor->PlayWorld) || Entries.IsEmpty() || Seconds < NextCaptureTime ||
        FUEShedCameraRenderSession::IsBusy())
        return {};
    for (int32 I = 0; I < Entries.Num(); ++I)
    {
        auto &Entry = *Entries[Next];
        Next = (Next + 1) % Entries.Num();
        if (!Realtime && Entry.Pending == 0)
            continue;
        Entry.Capture->Capture();
        Entry.Pending = FMath::Max(0, Entry.Pending - 1);
        ++Entry.Frames;
        // No catch-up burst after a slow frame. One capture per editor frame, at most 60/s total.
        NextCaptureTime = Seconds + 1.0 / 60.0;
        return Entry.Id;
    }
    return {};
}

UTextureRenderTarget2D *FUEShedCameraPreviewPool::Texture(const FString &Id) const
{
    for (const auto &Entry : Entries)
        if (Entry->Id == Id)
            return Entry->Capture->RenderTarget();
    return nullptr;
}

uint64 FUEShedCameraPreviewPool::Frames(const FString &Id) const
{
    for (const auto &Entry : Entries)
        if (Entry->Id == Id)
            return Entry->Frames;
    return 0;
}

int32 FUEShedCameraPreviewPool::Num() const
{
    return Entries.Num();
}

bool FUEShedCameraPreviewPool::NeedsRefresh() const
{
    return Entries.ContainsByPredicate([](const auto &Entry) { return Entry->Pending > 0; });
}

void FUEShedCameraPreviewPool::Reset()
{
    Entries.Reset();
    World.Reset();
    Next = 0;
    NextCaptureTime = 0;
}
