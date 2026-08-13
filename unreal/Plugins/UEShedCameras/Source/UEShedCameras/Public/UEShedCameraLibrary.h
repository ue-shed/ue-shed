#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedCameraLibrary.generated.h"

UCLASS()
class UESHEDCAMERAS_API UUEShedCameraLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras")
	static void GetStatus(FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras")
	static void Configure(const FString& ConfigJson, FString& ResultJson);

	/** Provision or reconcile transient cameras from JSON in the active editor or play world. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras")
	static void EnsureProvisionedCameras(const FString& RequestJson, FString& ResultJson);

	/** Destroy provisioned cameras and rediscover authored cameras on the next tick. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras")
	static void ClearProvisionedCameras(FString& ResultJson);
};
