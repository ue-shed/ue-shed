#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEShedAuthoringLibrary.generated.h"

UCLASS()
class UESHEDAUTHORING_API UUEShedAuthoringLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "UE Shed|Authoring")
	static void ListTableObjectPaths(FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Authoring")
	static void GetTableSnapshot(const FString& TableObjectPath, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Authoring")
	static void FindActorsReferencingRow(const FString& RequestJson, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Authoring")
	static void Apply(const FString& RequestJson, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Authoring")
	static void LookupApplyResult(const FString& OperationId, FString& ResultJson);

	UFUNCTION(BlueprintCallable, Category = "UE Shed|Authoring")
	static void Save(const FString& RequestJson, FString& ResultJson);
};
