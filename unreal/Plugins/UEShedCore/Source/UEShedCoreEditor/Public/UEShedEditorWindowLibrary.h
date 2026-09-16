#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedEditorWindowLibrary.generated.h"

/** Process-local window activation. Never selects an arbitrary Unreal process or asset window. */
UCLASS()
class UESHEDCOREEDITOR_API UUEShedEditorWindowLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor")
	static void ActivateEditorWindow(const FString& RequestJson, FString& ResultJson);
};
