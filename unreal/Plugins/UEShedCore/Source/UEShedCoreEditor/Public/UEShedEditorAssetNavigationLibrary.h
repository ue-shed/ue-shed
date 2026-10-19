#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedEditorAssetNavigationLibrary.generated.h"

UCLASS()
class UESHEDCOREEDITOR_API UUEShedEditorAssetNavigationLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor Assets")
	static void LocateAsset(const FString& ObjectPath, bool BringToFront, FString& ResultJson);

	/** Opens a top-level asset using Unreal's asset editor; BringToFront requests editor focus. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor Assets")
	static void OpenAsset(const FString& ObjectPath, bool BringToFront, FString& ResultJson);
};
