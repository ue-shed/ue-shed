#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "Channels/MovieSceneFloatChannel.h"
#include "Channels/MovieSceneDoubleChannel.h"
#include "StructUtils/InstancedStruct.h"
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
};
