#pragma once

#include "CoreMinimal.h"
class FJsonObject;
class UWorld;

void BeginUEShedLitMapTileCapture(const TSharedPtr<FJsonObject>& Request, UWorld* World, FString& ResultJson);
void ShutdownUEShedLitMapTileCapture();
