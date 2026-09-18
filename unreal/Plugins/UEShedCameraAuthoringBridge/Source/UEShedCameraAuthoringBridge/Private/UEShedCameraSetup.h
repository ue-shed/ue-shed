#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Bounded rendezvous, not persistence. A project-scoped host owns the actual creation. */
class FUEShedCameraSetup
{
public:
    static TSharedPtr<FJsonObject> Inspect();
    static TSharedPtr<FJsonObject> Execute(const TSharedPtr<FJsonObject>& Request);
};
