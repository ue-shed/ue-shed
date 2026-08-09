#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedAssetAuditsLibrary.generated.h"

UCLASS()
class UESHEDASSETAUDITS_API UUEShedAssetAuditsLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Asset Audits")
	static void GetTexturePreview(
		const FString& TextureObjectPath, int32 MaxDimension, FString& ResultJson);

	/** Shared implementation for live-editor and saved-project preview producers. */
	static FString BuildTexturePreviewJson(
		const FString& TextureObjectPath, int32 MaxDimension, const FString& Authority);
};
