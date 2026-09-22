#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Game-thread-only shared native boundary. Requests match ue-shed-world-preparation 1.0. */
class UESHEDWORLDEDITOR_API FUEShedWorldPreparation
{
  public:
	static TSharedPtr<FJsonObject> Execute(const TSharedPtr<FJsonObject> &Request);
	static TSharedPtr<FJsonObject> Describe();
	static void Startup();
	static void Shutdown();
};
