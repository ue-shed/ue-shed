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
	/** Extended discovery is separate so existing strict v1 clients retain their response shape. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Rendering")
	static void GetCameraRenderCapabilitiesV2(FString &ResultJson);
	/** Adds the offscreen_viewport strategy; v1 and v2 responses are unchanged for strict clients. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Rendering")
	static void GetCameraRenderCapabilitiesV3(FString &ResultJson);
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
