#pragma once

#include "CoreMinimal.h"
#include "Engine/DataTable.h"
#include "UEShedFixtureTypes.generated.h"

UENUM(BlueprintType)
enum class EUEShedFixtureRarity : uint8
{
	Common,
	Uncommon,
	Rare
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureNestedValue
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	int32 Count = 0;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FString Label;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FVector Offset = FVector::ZeroVector;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureScalarsRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	bool Enabled = false;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture", meta = (ClampMin = "0", ClampMax = "100"))
	int32 Count = 0;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture", meta = (ClampMin = "0.0", ClampMax = "1.0", UIMin = "0.0", UIMax = "1.0"))
	float Ratio = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FName Key;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture", meta = (MultiLine = "true"))
	FString Notes;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureEnumRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	EUEShedFixtureRarity Rarity = EUEShedFixtureRarity::Common;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureStructRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FUEShedFixtureNestedValue Nested;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FString Label;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureTextRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FText DisplayName;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureAssetReferenceRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	TSoftObjectPtr<UObject> Asset;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureRightReferenceRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FString Description;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureLeftReferenceRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FDataTableRowHandle Target;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureContainerRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	TArray<int32> Sequence;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	TSet<FName> Labels;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	TMap<FName, int32> Weights;
};

USTRUCT(BlueprintType)
struct UESHEDFIXTURE_API FUEShedFixtureOpaqueRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Fixture")
	FIntPoint OpaqueValue = FIntPoint::ZeroValue;
};
