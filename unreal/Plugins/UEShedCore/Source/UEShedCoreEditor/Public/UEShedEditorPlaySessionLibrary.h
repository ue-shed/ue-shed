#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedEditorPlaySessionLibrary.generated.h"

UCLASS()
class UESHEDCOREEDITOR_API UUEShedEditorPlaySessionLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	static bool GetActiveSessionId(FString& SessionId);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor Session")
	static void GetPlaySessionState(FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor Session")
	static void StartPlaySession(FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor Session")
	static void StartSimulateSession(FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor Session")
	static void StopPlaySession(FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor Session")
	static void PausePlaySession(FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor Session")
	static void ResumePlaySession(FString& ResultJson);
};
