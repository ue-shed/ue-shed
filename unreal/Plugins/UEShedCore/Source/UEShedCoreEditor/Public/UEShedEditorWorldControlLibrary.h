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

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor World")
	static void BeginOpenMap(const FString& RequestJson, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor World")
	static void GetOpenMapStatus(const FString& RequestJson, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Editor World")
	static void GetWorldState(FString& ResultJson);

	static void ShutdownWorldControl();
};
