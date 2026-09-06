#pragma once

#include "CoreMinimal.h"
class UWorld;

// Editor-only experiment. Owns temporary state across synchronous tile batches.
void RegisterUEShedMapCaptureFreeze();
void UnregisterUEShedMapCaptureFreeze();
bool BeginUEShedOwnedMapFreeze(UWorld* World, const FString& Owner);
bool RenewUEShedOwnedMapFreeze(const FString& Owner);
void EndUEShedOwnedMapFreeze(const FString& Owner);
