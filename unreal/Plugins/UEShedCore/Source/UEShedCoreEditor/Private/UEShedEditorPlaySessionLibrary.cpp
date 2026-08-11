#include "UEShedEditorPlaySessionLibrary.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "LevelEditor.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "LevelEditorSubsystem.h"

namespace
{
FString ActiveSessionId;
bool StopRequested = false;

struct FPlaySessionSnapshot
{
	FString Status;
	FString Mode;
	FString SessionId;
};

FString NewSessionId()
{
	return FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower);
}

FPlaySessionSnapshot Snapshot()
{
	if (!GEditor)
	{
		ActiveSessionId.Reset();
		StopRequested = false;
		return {TEXT("stopped"), FString(), FString()};
	}

	const bool IsActive = GEditor->IsPlayingSessionInEditor();
	const bool IsQueued = GEditor->IsPlaySessionRequestQueued();
	if (!IsActive && !IsQueued)
	{
		ActiveSessionId.Reset();
		StopRequested = false;
		return {TEXT("stopped"), FString(), FString()};
	}

	if (ActiveSessionId.IsEmpty())
	{
		ActiveSessionId = NewSessionId();
	}
	const FString Mode =
		GEditor->IsSimulatingInEditor() || GEditor->IsSimulateInEditorQueued()
			? TEXT("simulate")
			: TEXT("play");
	if (StopRequested)
	{
		return {TEXT("stopping"), Mode, ActiveSessionId};
	}
	if (IsQueued)
	{
		return {TEXT("starting"), Mode, ActiveSessionId};
	}
	const bool IsPaused = GEditor->PlayWorld && GEditor->PlayWorld->IsPaused();
	return {IsPaused ? TEXT("paused") : TEXT("running"), Mode, ActiveSessionId};
}

TSharedRef<FJsonObject> ContractJson()
{
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("unreal-editor-play-session"));
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}

TSharedRef<FJsonObject> StateJson(const FPlaySessionSnapshot& State)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("status"), State.Status);
	if (State.Status != TEXT("stopped"))
	{
		Result->SetStringField(TEXT("mode"), State.Mode);
		Result->SetStringField(TEXT("sessionId"), State.SessionId);
	}
	return Result;
}

void Serialize(const TSharedRef<FJsonObject>& Root, FString& ResultJson)
{
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ResultJson);
	FJsonSerializer::Serialize(Root, Writer);
}

void SerializeState(FString& ResultJson)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetObjectField(TEXT("state"), StateJson(Snapshot()));
	Serialize(Root, ResultJson);
}

void SerializeCommand(
	const TCHAR* Command,
	const TCHAR* Outcome,
	FString& ResultJson,
	const TCHAR* Code = nullptr,
	const TCHAR* Message = nullptr,
	const TCHAR* Recovery = nullptr)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("command"), Command);
	Root->SetStringField(TEXT("outcome"), Outcome);
	Root->SetObjectField(TEXT("state"), StateJson(Snapshot()));
	if (Code)
	{
		Root->SetStringField(TEXT("code"), Code);
		Root->SetStringField(TEXT("message"), Message);
		Root->SetStringField(TEXT("recovery"), Recovery);
	}
	Serialize(Root, ResultJson);
}

bool HasActiveLevelViewport()
{
	FLevelEditorModule& LevelEditor =
		FModuleManager::LoadModuleChecked<FLevelEditorModule>(TEXT("LevelEditor"));
	return LevelEditor.GetFirstActiveViewport().IsValid();
}

void Start(const bool Simulate, FString& ResultJson)
{
	const TCHAR* Command = Simulate ? TEXT("start_simulate") : TEXT("start_play");
	const FString RequestedMode = Simulate ? TEXT("simulate") : TEXT("play");
	const FPlaySessionSnapshot Before = Snapshot();
	if (Before.Status != TEXT("stopped"))
	{
		if (Before.Status != TEXT("stopping") && Before.Mode == RequestedMode)
		{
			SerializeCommand(Command, TEXT("already_satisfied"), ResultJson);
			return;
		}
		SerializeCommand(
			Command,
			TEXT("rejected"),
			ResultJson,
			TEXT("invalid_state"),
			TEXT("Another editor play-session transition is already active."),
			TEXT("Stop the current session or wait for its transition to finish, then retry."));
		return;
	}
	if (!GEditor || !HasActiveLevelViewport())
	{
		SerializeCommand(
			Command,
			TEXT("rejected"),
			ResultJson,
			TEXT("unavailable"),
			TEXT("No active level viewport is available for an editor play session."),
			TEXT("Open and activate a level viewport in Unreal Editor, then retry."));
		return;
	}
	ULevelEditorSubsystem* LevelEditorSubsystem =
		GEditor->GetEditorSubsystem<ULevelEditorSubsystem>();
	if (!LevelEditorSubsystem)
	{
		SerializeCommand(
			Command,
			TEXT("rejected"),
			ResultJson,
			TEXT("unavailable"),
			TEXT("The Unreal Level Editor subsystem is unavailable."),
			TEXT("Finish editor startup and retry from an active level viewport."));
		return;
	}
	ActiveSessionId = NewSessionId();
	StopRequested = false;
	if (Simulate)
	{
		LevelEditorSubsystem->EditorPlaySimulate();
	}
	else
	{
		LevelEditorSubsystem->EditorRequestBeginPlay();
	}
	if (!GEditor->IsPlaySessionInProgress())
	{
		ActiveSessionId.Reset();
		SerializeCommand(
			Command,
			TEXT("rejected"),
			ResultJson,
			TEXT("unavailable"),
			TEXT("Unreal Editor did not queue the requested play session."),
			TEXT("Resolve any editor validation or launch errors, then retry."));
		return;
	}
	SerializeCommand(Command, TEXT("accepted"), ResultJson);
}
}

void UUEShedEditorPlaySessionLibrary::GetPlaySessionState(FString& ResultJson)
{
	SerializeState(ResultJson);
}

bool UUEShedEditorPlaySessionLibrary::GetActiveSessionId(FString& SessionId)
{
	const FPlaySessionSnapshot State = Snapshot();
	if (State.Status == TEXT("stopped") || State.Status == TEXT("stopping")) return false;
	SessionId = State.SessionId;
	return !SessionId.IsEmpty();
}

void UUEShedEditorPlaySessionLibrary::StartPlaySession(FString& ResultJson)
{
	Start(false, ResultJson);
}

void UUEShedEditorPlaySessionLibrary::StartSimulateSession(FString& ResultJson)
{
	Start(true, ResultJson);
}

void UUEShedEditorPlaySessionLibrary::StopPlaySession(FString& ResultJson)
{
	const FPlaySessionSnapshot Before = Snapshot();
	if (Before.Status == TEXT("stopped") || Before.Status == TEXT("stopping"))
	{
		SerializeCommand(TEXT("stop"), TEXT("already_satisfied"), ResultJson);
		return;
	}
	StopRequested = true;
	GEditor->RequestEndPlayMap();
	SerializeCommand(TEXT("stop"), TEXT("accepted"), ResultJson);
}

void UUEShedEditorPlaySessionLibrary::PausePlaySession(FString& ResultJson)
{
	const FPlaySessionSnapshot Before = Snapshot();
	if (Before.Status == TEXT("paused"))
	{
		SerializeCommand(TEXT("pause"), TEXT("already_satisfied"), ResultJson);
		return;
	}
	if (Before.Status != TEXT("running"))
	{
		SerializeCommand(
			TEXT("pause"),
			TEXT("rejected"),
			ResultJson,
			TEXT("invalid_state"),
			TEXT("Only a running editor play session can be paused."),
			TEXT("Start or resume the play session, then retry pause."));
		return;
	}
	if (!GEditor->SetPIEWorldsPaused(true))
	{
		SerializeCommand(
			TEXT("pause"),
			TEXT("rejected"),
			ResultJson,
			TEXT("unavailable"),
			TEXT("Unreal Editor could not pause its play worlds."),
			TEXT("Check the editor session state and retry."));
		return;
	}
	GEditor->PlaySessionPaused();
	SerializeCommand(TEXT("pause"), TEXT("accepted"), ResultJson);
}

void UUEShedEditorPlaySessionLibrary::ResumePlaySession(FString& ResultJson)
{
	const FPlaySessionSnapshot Before = Snapshot();
	if (Before.Status == TEXT("running"))
	{
		SerializeCommand(TEXT("resume"), TEXT("already_satisfied"), ResultJson);
		return;
	}
	if (Before.Status != TEXT("paused"))
	{
		SerializeCommand(
			TEXT("resume"),
			TEXT("rejected"),
			ResultJson,
			TEXT("invalid_state"),
			TEXT("Only a paused editor play session can be resumed."),
			TEXT("Start a play session or wait for its transition to finish, then retry."));
		return;
	}
	if (!GEditor->SetPIEWorldsPaused(false))
	{
		SerializeCommand(
			TEXT("resume"),
			TEXT("rejected"),
			ResultJson,
			TEXT("unavailable"),
			TEXT("Unreal Editor could not resume its play worlds."),
			TEXT("Check the editor session state and retry."));
		return;
	}
	GEditor->PlaySessionResumed();
	SerializeCommand(TEXT("resume"), TEXT("accepted"), ResultJson);
}
