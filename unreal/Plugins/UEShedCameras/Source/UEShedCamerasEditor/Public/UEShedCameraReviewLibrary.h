#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedCameraReviewLibrary.generated.h"

UCLASS()
class UESHEDCAMERASEDITOR_API UUEShedCameraReviewLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Review")
	static void InspectReviewSelection(FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Cameras|Review")
	static void CaptureReviewView(const FString& RequestJson, FString& ResultJson);
};
