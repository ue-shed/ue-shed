#pragma once

#include "CoreMinimal.h"
#include "UObject/Interface.h"
#include "UEShedScenarioStateProvider.generated.h"

UINTERFACE()
class UESHEDSCENARIOS_API UUEShedScenarioStateProvider : public UInterface
{
	GENERATED_BODY()
};

class UESHEDSCENARIOS_API IUEShedScenarioStateProvider
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintNativeEvent, Category = "UE Shed|Scenarios")
	bool EvaluateScenarioCondition(FName ConditionId) const;

	UFUNCTION(BlueprintNativeEvent, Category = "UE Shed|Scenarios")
	FString GetScenarioStateJson() const;
};
