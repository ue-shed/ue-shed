#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "Engine/DataAsset.h"
#include "GameFramework/Actor.h"
#include "UEShedSyncProbeLibrary.generated.h"

UCLASS()
class UESHEDSYNCPROBE_API UUEShedSyncProbeDataAsset : public UDataAsset
{
	GENERATED_BODY()
public:
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Probe")
	float Value = 0;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Probe")
	FText Text;
};

UCLASS()
class UESHEDSYNCPROBE_API AUEShedSyncProbeActor : public AActor
{
	GENERATED_BODY()
public:
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Probe")
	float Value = 0;
};

UCLASS()
class UESHEDSYNCPROBE_API UUEShedSyncProbeLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	UFUNCTION(BlueprintCallable, Category = "Probe")
	static void Mark(const FString& Label, FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "Probe")
	static void Clear(FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "Probe")
	static void GetCounts(FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "Probe")
	static void Undo(FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "Probe")
	static void Redo(FString& ResultJson);
	UFUNCTION(BlueprintCallable, Category = "Probe")
	static void Scenario(const FString& RequestJson, FString& ResultJson);
};
