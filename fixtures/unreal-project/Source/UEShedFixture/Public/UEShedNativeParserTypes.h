#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "Channels/MovieSceneFloatChannel.h"
#include "Channels/MovieSceneDoubleChannel.h"
#include "StructUtils/InstancedStruct.h"
#include "GameplayTagContainer.h"
#include "StructUtils/PropertyBag.h"
#include "NiagaraCommon.h"
#include "NiagaraParameterStore.h"
#include "UniversalObjectLocatorFragment.h"
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
	UPROPERTY() FVector3f Position3f = FVector3f::ZeroVector;
	UPROPERTY() TArray<FVector3f> Positions3f;
	UPROPERTY() TMap<FName, FVector3f> NamedPositions3f;
	UPROPERTY() FBox Bounds;
	UPROPERTY() FIntVector Grid = FIntVector::ZeroValue;
	UPROPERTY() TArray<FQuat> Rotations;
	UPROPERTY() TArray<FTransform> Transforms;
	UPROPERTY() TArray<FVector2D> Positions2D;
	UPROPERTY() TArray<FBox> Boxes;
	UPROPERTY() TSet<FIntVector> Grids;
	UPROPERTY() TMap<FName, FTransform> NamedTransforms;
	UPROPERTY() TArray<FInstancedStruct> MathInstances;
	UPROPERTY() FInstancedStruct Vector3fInstance;
	UPROPERTY() FInstancedPropertyBag Parameters;
	UPROPERTY() FInstancedPropertyBag EmptyParameters;
	UPROPERTY() TArray<FInstancedPropertyBag> ParameterBags;
	UPROPERTY() FInstancedStruct BagInstance;
};

UCLASS()
class UUEShedCoverageBatchAsset : public UDataAsset
{
	GENERATED_BODY()
public:
	UPROPERTY() FIntVector2 Cell2D = FIntVector2::ZeroValue;
	UPROPERTY() FVector4f Direction4f = FVector4f(0, 0, 0, 0);
	UPROPERTY() FBox2f Bounds2f;
	UPROPERTY() TArray<FIntVector2> Cells2D;
	UPROPERTY() TArray<FVector4f> Directions4f;
	UPROPERTY() TArray<FBox2f> Rectangles2f;
	UPROPERTY() TArray<FInstancedStruct> AliasInstances;
	UPROPERTY() FText CategoryText;
	UPROPERTY() FText NamedCategoryText;
	UPROPERTY() FText EscapedFormatText;
	UPROPERTY() TOptional<bool> OptionalUnset = TOptional<bool>(true);
	UPROPERTY() TOptional<bool> OptionalFalse;
	UPROPERTY() TOptional<bool> OptionalTrue;
	UPROPERTY() TOptional<FText> OptionalText;
	UPROPERTY() TArray<FUniversalObjectLocatorFragment> LocatorFragments;
	UPROPERTY() FNiagaraVariableBase BaseVariable;
	UPROPERTY() FNiagaraVariable DataVariable;
	UPROPERTY() FNiagaraVariableWithOffset OffsetVariable;
	UPROPERTY() TArray<FNiagaraVariable> VariableRecords;
	UPROPERTY() FVMExternalFunctionBindingInfo ExternalFunction;
	UPROPERTY() TArray<FVMExternalFunctionBindingInfo> ExternalFunctions;
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
