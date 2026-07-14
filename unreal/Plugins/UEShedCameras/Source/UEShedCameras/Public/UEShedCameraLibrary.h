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
};
