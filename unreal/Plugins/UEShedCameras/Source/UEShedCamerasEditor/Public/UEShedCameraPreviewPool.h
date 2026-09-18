#pragma once

#include "CoreMinimal.h"

class AActor;
class UWorld;
class UTextureRenderTarget2D;
class FUEShedTransientCapture;

/** Resolved working view, independent of the authoring UI and any file/transport encoding. */
struct UESHEDCAMERASEDITOR_API FUEShedCameraPreviewView
{
    FString Id;
    FVector Location = FVector::ZeroVector;
    FRotator Rotation = FRotator::ZeroRotator;
    float FieldOfView = 60;
    TOptional<float> FixedEV100;
    bool Fog = true;
    bool VolumetricFog = true;
    float LodDistanceScale = 1;
    TArray<TWeakObjectPtr<AActor>> HiddenActors;
};

/** Game-thread-only GPU previews. At most four targets and one capture per Tick.
 * Defaults to fast 320x180 SceneCapture previews; review mode uses the project renderer at 640x360
 * with bounded temporal settling. Neither is final-capture evidence. The pool itself never moves
 * the viewport, reads pixels to the CPU, writes files, or changes persistent actors/visibility.
 */
class UESHEDCAMERASEDITOR_API FUEShedCameraPreviewPool
{
  public:
    static constexpr int32 MaximumViews = 4;
    explicit FUEShedCameraPreviewPool(bool InReviewQuality = false);
    ~FUEShedCameraPreviewPool();
    FUEShedCameraPreviewPool(const FUEShedCameraPreviewPool &) = delete;
    FUEShedCameraPreviewPool &operator=(const FUEShedCameraPreviewPool &) = delete;
    bool SetViews(UWorld *World, const TArray<FUEShedCameraPreviewView> &Views, FString &Error);
    void UpdatePose(const FString &Id, const FVector &Location, const FRotator &Rotation, float Fov);
    void RequestRefresh();
    FString Tick(double Seconds, bool Realtime);
    UTextureRenderTarget2D *Texture(const FString &Id) const;
    uint64 Frames(const FString &Id) const;
    bool NeedsRefresh() const;
    int32 Num() const;
    void Reset();

  private:
    struct FEntry;
    TArray<TUniquePtr<FEntry>> Entries;
    TWeakObjectPtr<UWorld> World;
    FDelegateHandle CleanupHandle, PlayHandle;
    int32 Next = 0;
    double NextCaptureTime = 0;
    bool ReviewQuality;
};
