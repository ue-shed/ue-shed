#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedWorldLibrary.generated.h"

UCLASS()
class UESHEDWORLDEDITOR_API UUEShedWorldLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
  public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|World")
	static void ExecuteWorldPreparation(const FString &RequestJson, FString &ResultJson);
};
