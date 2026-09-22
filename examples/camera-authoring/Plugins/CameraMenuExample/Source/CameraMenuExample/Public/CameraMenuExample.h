#pragma once
#include "Kismet/BlueprintFunctionLibrary.h"
#include "CameraMenuExample.generated.h"

/** Thin adapter: domain actions are validated and executed by the public bridge/host. */
UCLASS()
class CAMERAMENUEXAMPLE_API UCameraMenuExampleLibrary : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()
public:
    UFUNCTION(BlueprintCallable, Category="Camera Example")
    static void SubmitAction(const FString& SessionId, const FString& ProducerId, int32 ExpectedRevision,
        const FString& ActionJson, FString& ResultJson);
};
