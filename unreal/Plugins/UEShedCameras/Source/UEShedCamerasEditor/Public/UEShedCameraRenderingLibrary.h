#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedCameraRenderingLibrary.generated.h"

UCLASS()
class UESHEDCAMERASEDITOR_API UUEShedCameraRenderingLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Rendering")
	static void GetCameraRenderCapabilities(FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Rendering")
	static void PreflightCameraRender(const FString& RequestJson, FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Rendering")
	static void BeginCameraRender(const FString& RequestJson, FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Rendering")
	static void StartCameraFrame(const FString& RequestJson, FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Rendering")
	static void PollCameraFrame(const FString& SessionId, const FString& OperationId, FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Rendering")
	static void EndCameraRender(const FString& SessionId, FString& ResultJson);
};
