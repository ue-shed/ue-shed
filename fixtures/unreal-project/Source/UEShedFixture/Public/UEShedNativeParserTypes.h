#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "Channels/MovieSceneFloatChannel.h"
#include "Channels/MovieSceneDoubleChannel.h"
#include "StructUtils/InstancedStruct.h"
#include "GameplayTagContainer.h"
#include "UEShedNativeParserTypes.generated.h"

USTRUCT()
struct FUEShedNativeInner
{
	GENERATED_BODY()
	UPROPERTY() int32 Count = 0;
	UPROPERTY() FString Label;
	UPROPERTY() FVector Offset = FVector::ZeroVector;
	UPROPERTY() TObjectPtr<UObject> Reference;
};

UCLASS()
class UUEShedNativeCoverageAsset : public UDataAsset
{
	GENERATED_BODY()
public:
	UPROPERTY() FMovieSceneFloatChannel FloatChannel;
	UPROPERTY() FMovieSceneDoubleChannel DoubleChannel;
	UPROPERTY() FMovieSceneFloatChannel EmptyChannel;
	UPROPERTY() FInstancedStruct Value;
	UPROPERTY() FInstancedStruct EmptyValue;
	UPROPERTY() FInstancedStruct NativeValue;
	UPROPERTY() TArray<FInstancedStruct> Values;
	UPROPERTY() FInstancedStruct OpaqueValue;
	UPROPERTY() FGameplayTagContainer Tags;
	UPROPERTY() FGameplayTagContainer EmptyTags;
	UPROPERTY() TArray<FGameplayTagContainer> TagContainers;
	UPROPERTY() FQuat Rotation = FQuat::Identity;
	UPROPERTY() FTransform Transform;
	UPROPERTY() FVector2D Position2D = FVector2D::ZeroVector;
	UPROPERTY() FBox Bounds;
	UPROPERTY() FIntVector Grid = FIntVector::ZeroValue;
	UPROPERTY() TArray<FQuat> Rotations;
	UPROPERTY() TArray<FTransform> Transforms;
	UPROPERTY() TArray<FVector2D> Positions2D;
	UPROPERTY() TArray<FBox> Boxes;
	UPROPERTY() TSet<FIntVector> Grids;
	UPROPERTY() TMap<FName, FTransform> NamedTransforms;
	UPROPERTY() TArray<FInstancedStruct> MathInstances;
};

USTRUCT()
struct FUEShedOpaqueNative
{
	GENERATED_BODY()
	int64 Value = 0x12345678;
	bool Serialize(FArchive& Ar) { Ar << Value; return true; }
};

template<> struct TStructOpsTypeTraits<FUEShedOpaqueNative> : TStructOpsTypeTraitsBase2<FUEShedOpaqueNative>
{
	enum { WithSerializer = true };
};
