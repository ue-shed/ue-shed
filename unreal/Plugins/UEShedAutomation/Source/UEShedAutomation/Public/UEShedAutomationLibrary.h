#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedAutomationLibrary.generated.h"

/** Runtime automation with explicit game-world selection and versioned JSON results. */
UCLASS()
class UESHEDAUTOMATION_API UUEShedAutomationLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Automation")
	static void ListPlayers(const FString& RequestJson, FString& ResultJson);

	/** Injects once into the selected local controller's next Enhanced Input evaluation. */
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Automation")
	static void InjectInput(const FString& RequestJson, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Automation")
	static void CsvProfiler(const FString& RequestJson, FString& ResultJson);
};
