#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Bounded rendezvous, not persistence. A project-scoped host owns the actual creation. */
class FUEShedCameraSetup
{
public:
    /**
     * Extended replies add reopening state (canOpen, sets, open, selection.actorGuid). Only the
     * native panel and hosts that sent `reopen: true` receive them, so older hosts that decode
     * replies strictly never see fields they do not know.
     */
    static TSharedPtr<FJsonObject> Inspect(bool bExtended = true);
    static TSharedPtr<FJsonObject> Execute(const TSharedPtr<FJsonObject>& Request);
};
