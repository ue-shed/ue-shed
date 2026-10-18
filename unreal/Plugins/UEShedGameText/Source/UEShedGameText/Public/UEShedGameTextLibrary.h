#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedGameTextLibrary.generated.h"

/**
 * Game Text identity actions over stock Remote Control (ADR 0011). `RequestJson` and `ResultJson`
 * carry the versioned `ue-shed-game-text-actions` contract.
 */
UCLASS()
class UESHEDGAMETEXT_API UUEShedGameTextLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Game Text")
	static void ApplyTextActions(const FString& RequestJson, FString& ResultJson);

	/** Verifies a key redirect; activation requires an exact, already persisted project config entry. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Game Text")
	static void VerifyStringTableRedirect(const FString& RequestJson, FString& ResultJson);
};
