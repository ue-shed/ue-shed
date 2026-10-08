#include "UEShedAutomationLibrary.h"

#include "UEShedAutomationJson.h"
#include "UEShedAutomationProfiler.h"
#include "Engine/GameInstance.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EnhancedPlayerInput.h"
#include "GameFramework/PlayerController.h"
#include "InputAction.h"
#include "InputActionValue.h"
#include "UObject/UObjectGlobals.h"

namespace
{
UWorld* ResolveWorld(const TSharedPtr<FJsonObject>& Request,
	const TSharedRef<FJsonObject>& Result)
{
	FString Path;
	if (!UEShedAutomation::RequiredPath(Request, Result, TEXT("worldObjectPath"), Path))
		return nullptr;
	UWorld* World = FindObject<UWorld>(nullptr, *Path);
	if (!IsValid(World))
	{
		UEShedAutomation::Error(Result, TEXT("world_not_found"), TEXT("Select an already-loaded world."));
		return nullptr;
	}
	if (World->bIsTearingDown)
	{
		UEShedAutomation::Error(Result, TEXT("world_tearing_down"),
			TEXT("The selected world is shutting down. Select a live game or PIE world."));
		return nullptr;
	}
	if (World->WorldType != EWorldType::Game && World->WorldType != EWorldType::PIE
		&& World->WorldType != EWorldType::GamePreview)
	{
		UEShedAutomation::Error(Result, TEXT("unsupported_world"), TEXT("Select a game or PIE world."));
		return nullptr;
	}
	return World;
}

bool IsSelectedLocalController(UWorld* World, APlayerController* Controller)
{
	if (!IsValid(Controller) || Controller->GetWorld() != World) return false;
	const UGameInstance* Instance = World->GetGameInstance();
	if (!Instance) return false;
	for (const ULocalPlayer* Player : Instance->GetLocalPlayers())
		if (IsValid(Player) && Player->GetPlayerController(World) == Controller
			&& Controller->Player == Player) return true;
	return false;
}

bool DecodeValue(const TSharedPtr<FJsonObject>& Request, FInputActionValue& OutValue)
{
	const TSharedPtr<FJsonObject>* Value = nullptr;
	FString Kind;
	if (!Request->TryGetObjectField(TEXT("value"), Value)
		|| !(*Value)->TryGetStringField(TEXT("kind"), Kind)) return false;
	if (Kind == TEXT("boolean"))
	{
		bool Boolean = false;
		if (!(*Value)->TryGetBoolField(TEXT("value"), Boolean)) return false;
		OutValue = FInputActionValue(Boolean);
		return true;
	}
	double X = 0, Y = 0, Z = 0;
	if (!(*Value)->TryGetNumberField(TEXT("x"), X)
		|| !FMath::IsFinite(X) || FMath::Abs(X) > MAX_flt) return false;
	if (Kind == TEXT("axis1d"))
	{
		OutValue = FInputActionValue(static_cast<float>(X));
		return true;
	}
	if (!(*Value)->TryGetNumberField(TEXT("y"), Y)
		|| !FMath::IsFinite(Y) || FMath::Abs(Y) > MAX_flt) return false;
	if (Kind == TEXT("axis2d"))
	{
		OutValue = FInputActionValue(FVector2D(X, Y));
		return true;
	}
	if (Kind != TEXT("axis3d") || !(*Value)->TryGetNumberField(TEXT("z"), Z)
		|| !FMath::IsFinite(Z) || FMath::Abs(Z) > MAX_flt) return false;
	OutValue = FInputActionValue(FVector(X, Y, Z));
	return true;
}
}

void UUEShedAutomationLibrary::ListPlayers(const FString& RequestJson, FString& ResultJson)
{
	auto Result = UEShedAutomation::Result(TEXT("unreal-automation-players"));
	Result->SetStringField(TEXT("worldObjectPath"), TEXT(""));
	TArray<TSharedPtr<FJsonValue>> Players;
	TSharedPtr<FJsonObject> Request;
	if (UEShedAutomation::Parse(RequestJson, TEXT("unreal-automation-players"), Result, Request))
	{
		if (UWorld* World = ResolveWorld(Request, Result))
		{
			if (const UGameInstance* Instance = World->GetGameInstance())
			{
				const auto& LocalPlayers = Instance->GetLocalPlayers();
				for (int32 Index = 0; Index < LocalPlayers.Num(); ++Index)
				{
					const ULocalPlayer* Player = LocalPlayers[Index];
					APlayerController* Controller = Player ? Player->GetPlayerController(World) : nullptr;
					if (!IsSelectedLocalController(World, Controller)) continue;
					auto Entry = MakeShared<FJsonObject>();
					Entry->SetStringField(TEXT("controllerObjectPath"), Controller->GetPathName());
					Entry->SetNumberField(TEXT("localPlayerIndex"), Index);
					if (IsValid(Controller->PlayerInput))
						Entry->SetStringField(TEXT("playerInputObjectPath"), Controller->PlayerInput->GetPathName());
					else Entry->SetField(TEXT("playerInputObjectPath"), MakeShared<FJsonValueNull>());
					Players.Add(MakeShared<FJsonValueObject>(Entry));
				}
			}
			Result->SetStringField(TEXT("status"), TEXT("ok"));
		}
	}
	Result->SetArrayField(TEXT("players"), Players);
	UEShedAutomation::Encode(Result, ResultJson);
}

void UUEShedAutomationLibrary::InjectInput(const FString& RequestJson, FString& ResultJson)
{
	auto Result = UEShedAutomation::Result(TEXT("unreal-automation-input"));
	Result->SetStringField(TEXT("worldObjectPath"), TEXT(""));
	Result->SetStringField(TEXT("playerControllerObjectPath"), TEXT(""));
	Result->SetStringField(TEXT("actionObjectPath"), TEXT(""));
	TSharedPtr<FJsonObject> Request;
	if (UEShedAutomation::Parse(RequestJson, TEXT("unreal-automation-input"), Result, Request))
	{
		FString WorldPath, ControllerPath, ActionPath;
		// Echo valid selections even if an earlier selection no longer resolves. The trusted
		// transport can correlate rejected results without mistaking them for target substitution.
		const bool bWorldValid = UEShedAutomation::RequiredPath(Request, Result,
			TEXT("worldObjectPath"), WorldPath);
		const bool bControllerValid = UEShedAutomation::RequiredPath(Request, Result,
			TEXT("playerControllerObjectPath"), ControllerPath);
		const bool bActionValid = UEShedAutomation::RequiredPath(Request, Result,
			TEXT("actionObjectPath"), ActionPath);
		UWorld* World = bWorldValid && bControllerValid && bActionValid
			? ResolveWorld(Request, Result) : nullptr;
		if (World)
		{
			APlayerController* Controller = FindObject<APlayerController>(nullptr, *ControllerPath);
			UInputAction* Action = FindObject<UInputAction>(nullptr, *ActionPath);
			FInputActionValue Value;
			if (!IsSelectedLocalController(World, Controller))
				UEShedAutomation::Error(Result, TEXT("controller_not_local"),
					TEXT("Select a local player controller belonging to the chosen world."));
			else if (!IsValid(Action))
				UEShedAutomation::Error(Result, TEXT("action_not_found"),
					TEXT("Select an already-loaded Enhanced Input action."));
			else if (!DecodeValue(Request, Value))
				UEShedAutomation::Error(Result, TEXT("invalid_value"),
					TEXT("Supply a typed input value with finite, representable coordinates."));
			else if (Action->ValueType != Value.GetValueType())
				UEShedAutomation::Error(Result, TEXT("value_type_mismatch"),
					TEXT("The value kind must match the Input Action value type exactly."));
			else if (UEnhancedPlayerInput* Input = Cast<UEnhancedPlayerInput>(Controller->PlayerInput))
			{
				Input->InjectInputForAction(Action, Value);
				Result->SetStringField(TEXT("status"), TEXT("injected"));
			}
			else UEShedAutomation::Error(Result, TEXT("enhanced_input_unavailable"),
				TEXT("The selected controller does not have Enhanced Player Input."));
		}
	}
	UEShedAutomation::Encode(Result, ResultJson);
}

void UUEShedAutomationLibrary::CsvProfiler(const FString& RequestJson, FString& ResultJson)
{
	UEShedAutomation::GetProfiler().Request(RequestJson, ResultJson);
}
