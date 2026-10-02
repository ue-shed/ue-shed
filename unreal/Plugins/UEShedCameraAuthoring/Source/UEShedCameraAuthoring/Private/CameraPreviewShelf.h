#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "UEShedCameraPreviewReview.h"
#include "UObject/StrongObjectPtr.h"

class UTexture2D;

/**
 * The latest review thumbnail and subject check for each camera of the open set. The review tab
 * fills it as snapshots complete; the camera list reads it, including after the review tab closes.
 * Nothing here renders. Thumbnails are 160x90 (about 14 MB for 256 cameras) and are released when
 * another set opens, the set closes or the module shuts down. Game thread only.
 */
class FCameraPreviewShelf
{
  public:
    struct FShot
    {
        TStrongObjectPtr<UTexture2D> Thumbnail;
        /** Key() of the inputs this shot was rendered from. */
        FString Key;
        FUEShedCameraSubjectVisibility Visibility;
        bool bSubjectFound = false;
        bool bEditorPreviews = false;
    };
    static FCameraPreviewShelf &Get()
    {
        static FCameraPreviewShelf Shelf;
        return Shelf;
    }
    /** One open set: producer and session identities, as the bridge reports them. */
    static FString Session(const TSharedPtr<FJsonObject> &Active)
    {
        FString Producer, Id;
        if (Active)
        {
            Active->TryGetStringField(TEXT("producerId"), Producer);
            Active->TryGetStringField(TEXT("sessionId"), Id);
        }
        return Producer + TEXT("/") + Id;
    }
    /** Everything that changes one camera's image: its pose and lists, the policy, output and subject. */
    static FString Key(const TSharedPtr<FJsonObject> &Panel, const FString &CameraId);
    void Put(const FString &InSession, const FString &CameraId, FShot Shot)
    {
        if (InSession != OpenSession)
        {
            Shots.Reset();
            OpenSession = InSession;
        }
        Shots.Add(CameraId, MoveTemp(Shot));
    }
    void Remove(const FString &InSession, const FString &CameraId)
    {
        if (InSession == OpenSession)
            Shots.Remove(CameraId);
    }
    const FShot *Find(const FString &InSession, const FString &CameraId) const
    {
        return InSession == OpenSession ? Shots.Find(CameraId) : nullptr;
    }
    void Reset()
    {
        Shots.Reset();
        OpenSession.Reset();
    }

  private:
    FString OpenSession;
    TMap<FString, FShot> Shots;
};
