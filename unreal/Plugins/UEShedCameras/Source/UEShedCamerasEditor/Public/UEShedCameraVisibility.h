#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "SceneViewExtension.h"

class UWorld;
class AActor;
class UPrimitiveComponent;

/** Per-view exclusion only. No actor/component visibility flags or package state are changed. */
class UESHEDCAMERASEDITOR_API FUEShedCameraVisibility final : public FSceneViewExtensionBase
{
  public:
    FUEShedCameraVisibility(const FAutoRegister &Register) : FSceneViewExtensionBase(Register)
    {
    }
    FSceneViewStateInterface *Target = nullptr;
    TArray<TWeakObjectPtr<UPrimitiveComponent>> Components;
    bool Enabled = false;
    void SetupView(FSceneViewFamily &Family, FSceneView &View) override;
};
struct UESHEDCAMERASEDITOR_API FUEShedResolvedVisibility
{
    bool Valid = true;
    TArray<TWeakObjectPtr<AActor>> Hidden;
    TArray<TWeakObjectPtr<UPrimitiveComponent>> Components;
    TArray<TSharedPtr<FJsonValue>> Diagnostics;
    FString Message;
};
/** Strict loaded-world resolution. A GUID never silently falls back to a possibly reassigned path. */
UESHEDCAMERASEDITOR_API FUEShedResolvedVisibility UEShedResolveCameraVisibility(UWorld *World,
                                                                                const TSharedPtr<FJsonObject> &Actors);
UESHEDCAMERASEDITOR_API TSharedPtr<FJsonObject> UEShedCameraActorEntry(AActor *Actor);
UESHEDCAMERASEDITOR_API TSharedPtr<FJsonObject> UEShedCameraVisibilityCapabilities();
