#pragma once

#include "CoreMinimal.h"
#include "UEShedCameraPreviewPool.h"
#include "UObject/StrongObjectPtr.h"

class FUEShedEditorPreviews;
class UTexture2D;

/** Whether one review snapshot shows its subject, from the review capture's depth comparison. */
struct UESHEDCAMERASEDITOR_API FUEShedCameraSubjectVisibility
{
    /** The same bounds as review ray classification: clear at or above, blocked at or below. */
    static constexpr double ClearAtOrAbove = .95;
    static constexpr double BlockedAtOrBelow = .05;
    enum class EStatus : uint8
    {
        /** No subject was requested, or the view did not render. */
        NotChecked,
        Visible,
        Partial,
        /** Inside the frame, but other geometry covers it. */
        Blocked,
        /** Entirely outside the frame. */
        OutOfShot,
        /** Inside the frame, but nothing of it rendered: hidden, editor-only or not depth-writing. */
        NotRendered,
        Failed
    };
    EStatus Status = EStatus::NotChecked;
    double VisibleFraction = 0;
    /** Part of the subject's bounds lies outside the frame. */
    bool CutOff = false;
    FString Message;
};

/** On-demand contact sheet. One renderer at a time, immutable 640x360 snapshots for up to
 * 256 cameras. Unlike the live pool, reads pixels once per completed camera, never per UI frame.
 * When a view names its subject, each snapshot also measures whether the shot shows it, using
 * the review capture's depth comparison on the same capture. Stops after completion and releases
 * everything, including revealed editor previews, on Reset, world cleanup, or PIE.
 */
class UESHEDCAMERASEDITOR_API FUEShedCameraPreviewReview
{
  public:
    static constexpr int32 MaximumViews = 256;
    /** Thumbnails are downscaled from the same readback; no second render is made. */
    static constexpr int32 ThumbnailWidth = 160;
    static constexpr int32 ThumbnailHeight = 90;
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
    UTexture2D *Thumbnail(const FString &Id) const;
    const FUEShedCameraSubjectVisibility *SubjectVisibility(const FString &Id) const;
    /** Child actors currently revealed for views that request editor previews. */
    int32 RevealedEditorPreviews() const;
    FString Error(const FString &Id) const;
    void Reset();

  private:
    struct FEntry;
    TArray<TUniquePtr<FEntry>> Entries;
    FUEShedCameraPreviewPool Capture{true};
    TUniquePtr<FUEShedEditorPreviews> EditorPreviews;
    TWeakObjectPtr<UWorld> World;
    FDelegateHandle CleanupHandle, PlayHandle, PreSaveHandle, SavedHandle;
    int32 Current = 0;
    void Release(bool bRecreateRenderState);
};
