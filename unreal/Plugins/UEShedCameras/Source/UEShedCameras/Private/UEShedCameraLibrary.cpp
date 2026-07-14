#include "UEShedCameraLibrary.h"

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "UEShedCameraSubsystem.h"

namespace
{
UUEShedCameraSubsystem* FindCameraSubsystem()
{
	if (GEngine == nullptr) return nullptr;
	for (const FWorldContext& Context : GEngine->GetWorldContexts())
	{
		UWorld* World = Context.World();
		if (World != nullptr && World->IsGameWorld())
		{
			return World->GetSubsystem<UUEShedCameraSubsystem>();
		}
	}
	return nullptr;
}
}

void UUEShedCameraLibrary::GetStatus(FString& ResultJson)
{
	if (UUEShedCameraSubsystem* Subsystem = FindCameraSubsystem())
	{
		ResultJson = Subsystem->StatusJson();
		return;
	}
	ResultJson = TEXT("{\"schemaVersion\":1,\"error\":\"no-running-game-world\"}");
}

void UUEShedCameraLibrary::Configure(const FString& ConfigJson, FString& ResultJson)
{
	if (UUEShedCameraSubsystem* Subsystem = FindCameraSubsystem())
	{
		FString Error;
		if (Subsystem->ApplyConfigJson(ConfigJson, Error))
		{
			ResultJson = Subsystem->StatusJson();
			return;
		}
		ResultJson = FString::Printf(TEXT("{\"schemaVersion\":1,\"error\":\"%s\"}"), *Error);
		return;
	}
	ResultJson = TEXT("{\"schemaVersion\":1,\"error\":\"no-running-game-world\"}");
}
