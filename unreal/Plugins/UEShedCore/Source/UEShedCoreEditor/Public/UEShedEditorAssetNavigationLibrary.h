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
};
