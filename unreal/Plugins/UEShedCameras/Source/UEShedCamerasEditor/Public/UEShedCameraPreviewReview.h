#pragma once

#include "CoreMinimal.h"
#include "UEShedCameraPreviewPool.h"
#include "UObject/StrongObjectPtr.h"

class UTexture2D;

/** On-demand contact sheet. One renderer at a time, immutable 640x360 snapshots for up to
 * 256 cameras. Unlike the live pool, reads pixels once per completed camera, never per UI frame.
 * Stops after completion and releases everything on Reset, world cleanup, or PIE.
 */
class UESHEDCAMERASEDITOR_API FUEShedCameraPreviewReview
{
  public:
    static constexpr int32 MaximumViews = 256;
    FUEShedCameraPreviewReview();
    ~FUEShedCameraPreviewReview();
    FUEShedCameraPreviewReview(const FUEShedCameraPreviewReview &) = delete;
    FUEShedCameraPreviewReview &operator=(const FUEShedCameraPreviewReview &) = delete;
    bool Begin(UWorld *InWorld, const TArray<FUEShedCameraPreviewView> &Views, FString &Error);
    void Tick(double Time);
    bool IsRunning() const;
    int32 Completed() const;
    int32 Failed() const;
    int32 Num() const;
    int32 ActiveCaptures() const;
    UTexture2D *Texture(const FString &Id) const;
    FString Error(const FString &Id) const;
    void Reset();

  private:
    struct FEntry;
    TArray<TUniquePtr<FEntry>> Entries;
    FUEShedCameraPreviewPool Capture{true};
    TWeakObjectPtr<UWorld> World;
    FDelegateHandle CleanupHandle, PlayHandle;
    int32 Current = 0;
};
