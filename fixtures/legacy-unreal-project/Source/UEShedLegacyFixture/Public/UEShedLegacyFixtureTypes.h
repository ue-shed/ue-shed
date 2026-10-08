#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "Engine/DataTable.h"
#include "UEShedLegacyFixtureTypes.generated.h"

USTRUCT()
struct UESHEDLEGACYFIXTURE_API FUEShedLegacyNested
{
	GENERATED_BODY()

	UPROPERTY() FText Text;
	UPROPERTY() TArray<FText> Texts;
};

USTRUCT()
struct UESHEDLEGACYFIXTURE_API FUEShedLegacyFixtureRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY() FText BaseText;
	UPROPERTY() FText InvariantText;
	UPROPERTY() FText TableText;
	UPROPERTY() FText EmptyText;
	UPROPERTY() TArray<FText> Texts;
	UPROPERTY() TMap<FName, FText> TextMap;
	UPROPERTY() FUEShedLegacyNested Nested;
	UPROPERTY() TArray<FVector> Vectors;
	UPROPERTY() TMap<FName, FUEShedLegacyNested> NestedMap;
	UPROPERTY() TMap<FName, FVector> NativeVectors;
};

UCLASS()
class UESHEDLEGACYFIXTURE_API UUEShedLegacyFixtureTextAsset : public UDataAsset
{
	GENERATED_BODY()

public:
	UPROPERTY() FText Text;
	UPROPERTY() TArray<FText> Texts;
	UPROPERTY() FUEShedLegacyNested Nested;
};
