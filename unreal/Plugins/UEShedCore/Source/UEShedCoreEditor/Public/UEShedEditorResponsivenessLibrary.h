#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedEditorResponsivenessLibrary.generated.h"

/**
 * Keeps this editor out of background throttling while a leased local client owns the foreground
 * window. Never changes or saves editor settings; Unreal's normal policy applies otherwise.
 */
UCLASS()
class UESHEDCOREEDITOR_API UUEShedEditorResponsivenessLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	/** Acquire, renew, or release a lease. See core/v1/FOREGROUND-RESPONSIVENESS.md. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor")
	static void UpdateForegroundLease(const FString& RequestJson, FString& ResultJson);

	/** Diagnostics: lease count, whether the exemption is in effect, and the user's setting. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor")
	static void GetForegroundResponsivenessState(const FString& RequestJson, FString& ResultJson);

	/** Registers this module's single throttle entry once GEditor exists. */
	static void StartForegroundResponsiveness();
	/** Removes only this module's entry and closes every client handle. */
	static void ShutdownForegroundResponsiveness();
	static bool IsForegroundResponsivenessRegistered();
	/** The registered throttle predicate: true while a leaseholder owns the foreground window. */
	static bool ShouldKeepEditorResponsive();
};
