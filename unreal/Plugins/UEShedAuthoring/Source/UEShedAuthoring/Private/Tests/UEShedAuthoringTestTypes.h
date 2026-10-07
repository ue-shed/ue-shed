#pragma once

#include "Components/ActorComponent.h"
#include "Engine/DataTable.h"
#include "GameFramework/Actor.h"
#include "UEShedAuthoringTestTypes.generated.h"

// Private reflected types for the native automation tests. They are transient
// test objects, never project assets or part of the public authoring contract.
USTRUCT()
struct FUEShedAuthoringTestReference
{
	GENERATED_BODY()

	UPROPERTY()
	FDataTableRowHandle Handle;

	UPROPERTY()
	FString Tag = TEXT("nested-default");

	bool operator==(const FUEShedAuthoringTestReference& Other) const
	{
		return Handle == Other.Handle && Tag == Other.Tag;
	}

	friend uint32 GetTypeHash(const FUEShedAuthoringTestReference& Value)
	{
		return HashCombine(GetTypeHash(Value.Handle.DataTable.Get()),
			HashCombine(GetTypeHash(Value.Handle.RowName), GetTypeHash(Value.Tag)));
	}
};

template<>
struct TStructOpsTypeTraits<FUEShedAuthoringTestReference>
	: public TStructOpsTypeTraitsBase2<FUEShedAuthoringTestReference>
{
	enum { WithIdenticalViaEquality = true };
};

USTRUCT()
struct FUEShedAuthoringTestRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY()
	int32 Count = 73;

	UPROPERTY()
	FString Label = TEXT("native-default");

	UPROPERTY()
	FUEShedAuthoringTestReference Nested;

	UPROPERTY()
	TArray<int32> Numbers = { 3, 7 };

	UPROPERTY()
	int32 StaticNumbers[2] = { 11, 13 };
};

UCLASS(Transient, NotBlueprintable)
class UUEShedAuthoringTestComponent : public UActorComponent
{
	GENERATED_BODY()

public:
	UPROPERTY()
	FUEShedAuthoringTestReference Nested;
};

UCLASS(Transient, NotBlueprintable)
class AUEShedAuthoringTestActor : public AActor
{
	GENERATED_BODY()

public:
	UPROPERTY()
	FDataTableRowHandle Direct;

	UPROPERTY()
	FUEShedAuthoringTestReference Nested;

	UPROPERTY()
	FDataTableRowHandle StaticReferences[2];

	UPROPERTY()
	TArray<FUEShedAuthoringTestReference> Array;

	UPROPERTY()
	TSet<FUEShedAuthoringTestReference> Set;

	UPROPERTY()
	TMap<FUEShedAuthoringTestReference, FUEShedAuthoringTestReference> Map;
};
