#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedEditorWorldControlLibrary.generated.h"

UCLASS()
class UESHEDCOREEDITOR_API UUEShedEditorWorldControlLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor World")
	static void OpenMap(const FString& RequestJson, FString& ResultJson);
};
