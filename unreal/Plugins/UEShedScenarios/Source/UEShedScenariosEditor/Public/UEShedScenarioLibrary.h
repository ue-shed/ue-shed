#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedScenarioLibrary.generated.h"

UCLASS()
class UESHEDSCENARIOSEDITOR_API UUEShedScenarioLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Scenarios")
	static void PrepareScenarioWorld(const FString& ScenarioId, const FString& MapPath,
		FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Scenarios")
	static void StartScenarioRun(const FString& RequestJson, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Scenarios")
	static void GetScenarioRunStatus(const FString& RunId, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Scenarios")
	static void CancelScenarioRun(const FString& RunId, FString& ResultJson);
};
