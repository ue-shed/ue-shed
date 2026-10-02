#pragma once
#include "Dom/JsonObject.h"
#include "UEShedCameraPreviewReview.h"
#include "Widgets/SCompoundWidget.h"

class SWrapBox;
struct FCameraShotStatus;

/** Optional, on-demand review contact sheet. Never owns editing or approval. */
class SCameraSetPreviews : public SCompoundWidget
{
  public:
    SLATE_BEGIN_ARGS(SCameraSetPreviews)
    {
    }
    SLATE_ATTRIBUTE(bool, PreviewVisible)
    SLATE_END_ARGS()
    void Construct(const FArguments &Args);
    void Clear();
    void Close();

  private:
    friend class FUEShedCameraPreviewPanelTest;
    FUEShedCameraPreviewReview Review;
    TSharedPtr<SWrapBox> Grid;
    TAttribute<bool> PreviewVisible;
    TWeakPtr<FActiveTimerHandle> RenderTimer;
    TMap<FString, FString> Errors;
    TArray<FString> Order;
    /** Cameras handed to the review, in its order, and the inputs each was rendered from. */
    TArray<FString> Queued;
    TMap<FString, FString> Keys;
    int32 Published = 0;
    void Publish();
    TWeakObjectPtr<AActor> Subject;
    bool EditorPreviews = false;
    FCameraShotStatus Shot(const FString &Id) const;
    FString Summary() const;
    FString Identity, SnapshotKey, Message, Failure, Title = TEXT("Camera previews");
    bool Initial = true, Stale = false, Synced = false, Closed = false;
    float TileWidth = 280;
    TSharedPtr<FJsonObject> Snapshot;
    void RenderAll();
    void AddCamera(const FString &Id, const FString &Label);
    EActiveTimerReturnType Poll(double Time, float Delta);
    EActiveTimerReturnType Draw(double Time, float Delta);
};
