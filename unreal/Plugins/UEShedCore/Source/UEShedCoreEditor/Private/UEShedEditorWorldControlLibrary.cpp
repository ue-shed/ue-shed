#include "UEShedEditorWorldControlLibrary.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "Misc/PackageName.h"
#include "Misc/App.h"
#include "Containers/Ticker.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
TSharedRef<FJsonObject> ContractJson()
{
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("unreal-editor-world-control"));
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}

bool IsSafeIdentifier(const FString& Value)
{
	if (Value.IsEmpty() || Value.Len() > 128 || !FChar::IsAlnum(Value[0])) return false;
	for (const TCHAR Character : Value)
	{
		if (!FChar::IsAlnum(Character)
			&& Character != TEXT('-')
			&& Character != TEXT('_')
			&& Character != TEXT('.'))
		{
			return false;
		}
	}
	return true;
}

TSharedRef<FJsonObject> Snapshot()
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const UWorld* World = GEditor == nullptr ? nullptr : GEditor->GetEditorWorldContext().World();
	if (World != nullptr)
	{
		Result->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
	}
	Result->SetBoolField(
		TEXT("playSessionActive"),
		GEditor != nullptr && GEditor->IsPlaySessionInProgress());
	TArray<UPackage*> DirtyPackages;
	FEditorFileUtils::GetDirtyWorldPackages(DirtyPackages);
	TArray<TSharedPtr<FJsonValue>> DirtyPackagePaths;
	const int32 Count = FMath::Min(DirtyPackages.Num(), 256);
	DirtyPackagePaths.Reserve(Count);
	for (int32 Index = 0; Index < Count; ++Index)
	{
		if (DirtyPackages[Index] != nullptr)
		{
			DirtyPackagePaths.Add(
				MakeShared<FJsonValueString>(DirtyPackages[Index]->GetName()));
		}
	}
	Result->SetArrayField(TEXT("dirtyWorldPackages"), DirtyPackagePaths);
	return Result;
}

void SerializeResponse(
	const FString& OperationId,
	const FString& TargetMapPath,
	const TCHAR* Outcome,
	const TSharedRef<FJsonObject>& Before,
	FString& ResultJson,
	const TCHAR* Code = nullptr,
	const TCHAR* Message = nullptr,
	const TCHAR* Recovery = nullptr,
	bool bRetrySafe = false)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("operationId"), OperationId);
	Root->SetStringField(TEXT("targetMapPath"), TargetMapPath);
	Root->SetStringField(TEXT("outcome"), Outcome);
	Root->SetObjectField(TEXT("before"), Before);
	Root->SetObjectField(TEXT("after"), Snapshot());
	if (Code != nullptr)
	{
		Root->SetStringField(TEXT("code"), Code);
		Root->SetStringField(TEXT("message"), Message);
		Root->SetStringField(TEXT("recovery"), Recovery);
		Root->SetBoolField(TEXT("retrySafe"), bRetrySafe);
	}
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ResultJson);
	FJsonSerializer::Serialize(Root, Writer);
}

struct FMapOpenJob
{
	FString OperationId, TargetMapPath, RequestJson, ResultJson;
	FString Status = TEXT("pending");
};
TArray<FMapOpenJob> MapOpenJobs;
FTSTicker::FDelegateHandle MapOpenTicker;

TSharedRef<FJsonObject> JobEnvelope(const FString& OperationId, const FString& TargetMapPath)
{
	auto Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("operationId"), OperationId);
	Root->SetStringField(TEXT("targetMapPath"), TargetMapPath);
	return Root;
}

void WriteJson(const TSharedRef<FJsonObject>& Root, FString& ResultJson)
{
	ResultJson.Reset();
	FJsonSerializer::Serialize(Root, TJsonWriterFactory<>::Create(&ResultJson));
}

void UnavailableJob(const FString& Id, const FString& Map, const TCHAR* Code,
	const TCHAR* Message, const TCHAR* Recovery, FString& ResultJson)
{
	auto Root = JobEnvelope(Id, Map);
	Root->SetStringField(TEXT("status"), TEXT("unavailable"));
	Root->SetStringField(TEXT("code"), Code);
	Root->SetStringField(TEXT("message"), Message);
	Root->SetStringField(TEXT("recovery"), Recovery);
	WriteJson(Root, ResultJson);
}

bool ReadJobRequest(const FString& RequestJson, FString& Id, FString& Map, FString& ResultJson)
{
	TSharedPtr<FJsonObject> Request;
	const TSharedPtr<FJsonObject>* Contract = nullptr;
	const TSharedPtr<FJsonObject>* Version = nullptr;
	FString Name;
	double Major = -1, Minor = -1;
	if (RequestJson.Len() <= 16 * 1024
		&& FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RequestJson), Request)
		&& Request.IsValid() && Request->TryGetStringField(TEXT("operationId"), Id)
		&& IsSafeIdentifier(Id) && Request->TryGetStringField(TEXT("targetMapPath"), Map)
		&& Map.Len() <= 1024 && Map.StartsWith(TEXT("/Game/"))
		&& FPackageName::IsValidLongPackageName(Map)
		&& Request->TryGetObjectField(TEXT("contract"), Contract)
		&& (*Contract)->TryGetStringField(TEXT("name"), Name)
		&& Name == TEXT("unreal-editor-world-control")
		&& (*Contract)->TryGetObjectField(TEXT("version"), Version)
		&& (*Version)->TryGetNumberField(TEXT("major"), Major) && Major == 1
		&& (*Version)->TryGetNumberField(TEXT("minor"), Minor) && Minor == 0) return true;
	UnavailableJob(TEXT("invalid"), TEXT("/Game/Invalid"), TEXT("invalid_request"),
		TEXT("Invalid map-open operation request."), TEXT("Send a version 1.0 request with a safe ID and /Game/ map path."), ResultJson);
	return false;
}

void WriteJob(const FMapOpenJob& Job, FString& ResultJson)
{
	auto Root = JobEnvelope(Job.OperationId, Job.TargetMapPath);
	Root->SetStringField(TEXT("status"), Job.Status);
	if (Job.Status == TEXT("completed"))
	{
		TSharedPtr<FJsonObject> Result;
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Job.ResultJson), Result);
		Root->SetObjectField(TEXT("result"), Result);
	}
	WriteJson(Root, ResultJson);
}
}

void UUEShedEditorWorldControlLibrary::GetWorldState(FString& ResultJson)
{
	auto Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("projectName"), FApp::GetProjectName());
	Root->SetObjectField(TEXT("snapshot"), Snapshot());
	WriteJson(Root, ResultJson);
}

void UUEShedEditorWorldControlLibrary::GetOpenMapStatus(const FString& RequestJson, FString& ResultJson)
{
	FString Id, Map;
	if (!ReadJobRequest(RequestJson, Id, Map, ResultJson)) return;
	const auto* Job = MapOpenJobs.FindByPredicate([&](const auto& Item) { return Item.OperationId == Id; });
	if (!Job)
		UnavailableJob(Id, Map, TEXT("unknown_operation"), TEXT("This editor no longer knows that map-open operation."),
			TEXT("Check the current editor map before issuing a new open; the original command is not replayed."), ResultJson);
	else if (Job->TargetMapPath != Map)
		UnavailableJob(Id, Map, TEXT("conflict"), TEXT("This operation ID belongs to another map."),
			TEXT("Use the original target when querying this operation."), ResultJson);
	else WriteJob(*Job, ResultJson);
}

void UUEShedEditorWorldControlLibrary::BeginOpenMap(const FString& RequestJson, FString& ResultJson)
{
	FString Id, Map;
	if (!ReadJobRequest(RequestJson, Id, Map, ResultJson)) return;
	if (MapOpenJobs.ContainsByPredicate([&](const auto& Item) { return Item.OperationId == Id; }))
	{
		GetOpenMapStatus(RequestJson, ResultJson);
		return;
	}
	if (MapOpenJobs.ContainsByPredicate([](const auto& Item) { return Item.Status != TEXT("completed"); }))
	{
		UnavailableJob(Id, Map, TEXT("busy"), TEXT("An editor map-open operation is already in progress."),
			TEXT("Wait for that map to finish loading before requesting another switch."), ResultJson);
		return;
	}
	// Retain bounded terminal results for lost acknowledgements and repeat status queries.
	if (MapOpenJobs.Num() >= 32) MapOpenJobs.RemoveAt(0);
	FMapOpenJob Job;
	Job.OperationId = Id;
	Job.TargetMapPath = Map;
	Job.RequestJson = RequestJson;
	MapOpenJobs.Add(Job);
	WriteJob(MapOpenJobs.Last(), ResultJson);
	// Return the acknowledgement before entering Unreal's blocking game-thread map loader.
	MapOpenTicker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([Id](float)
	{
		auto* Pending = MapOpenJobs.FindByPredicate([&](const auto& Item) { return Item.OperationId == Id; });
		if (!Pending) return false;
		Pending->Status = TEXT("running");
		const FString Request = Pending->RequestJson;
		FString Response;
		UUEShedEditorWorldControlLibrary::OpenMap(Request, Response);
		Pending = MapOpenJobs.FindByPredicate([&](const auto& Item) { return Item.OperationId == Id; });
		if (Pending)
		{
			Pending->ResultJson = MoveTemp(Response);
			Pending->Status = TEXT("completed");
		}
		MapOpenTicker.Reset();
		return false;
	}), 0.1f);
}

void UUEShedEditorWorldControlLibrary::ShutdownWorldControl()
{
	FTSTicker::RemoveTicker(MapOpenTicker);
	MapOpenTicker.Reset();
	MapOpenJobs.Reset();
}

void UUEShedEditorWorldControlLibrary::OpenMap(
	const FString& RequestJson,
	FString& ResultJson)
{
	FString OperationId(TEXT("invalid"));
	FString TargetMapPath(TEXT("/Game/Invalid"));
	const TSharedRef<FJsonObject> InitialSnapshot = Snapshot();
	auto Reject = [&](
		const TCHAR* Code,
		const TCHAR* Message,
		const TCHAR* Recovery,
		bool bRetrySafe)
	{
		SerializeResponse(
			OperationId,
			TargetMapPath,
			TEXT("rejected"),
			InitialSnapshot,
			ResultJson,
			Code,
			Message,
			Recovery,
			bRetrySafe);
	};

	if (RequestJson.Len() > 16 * 1024)
	{
		Reject(
			TEXT("invalid_request"),
			TEXT("Editor world-control request exceeds 16 KiB."),
			TEXT("Send only the versioned operation identity and target map path."),
			false);
		return;
	}
	TSharedPtr<FJsonObject> Request;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Request) || !Request.IsValid())
	{
		Reject(
			TEXT("invalid_request"),
			TEXT("Editor world-control request is not valid JSON."),
			TEXT("Validate the request against unreal-editor-world-control 1.0."),
			false);
		return;
	}
	FString RequestedOperationId;
	FString RequestedTargetMapPath;
	Request->TryGetStringField(TEXT("operationId"), RequestedOperationId);
	Request->TryGetStringField(TEXT("targetMapPath"), RequestedTargetMapPath);
	if (IsSafeIdentifier(RequestedOperationId)) OperationId = RequestedOperationId;
	if (RequestedTargetMapPath.StartsWith(TEXT("/Game/"))
		&& FPackageName::IsValidLongPackageName(RequestedTargetMapPath))
	{
		TargetMapPath = RequestedTargetMapPath;
	}
	const TSharedPtr<FJsonObject>* Contract;
	const TSharedPtr<FJsonObject>* Version;
	FString ContractName;
	double Major = 0.0;
	double Minor = 0.0;
	if (!IsSafeIdentifier(RequestedOperationId)
		|| !Request->TryGetObjectField(TEXT("contract"), Contract)
		|| !(*Contract)->TryGetStringField(TEXT("name"), ContractName)
		|| ContractName != TEXT("unreal-editor-world-control")
		|| !(*Contract)->TryGetObjectField(TEXT("version"), Version)
		|| !(*Version)->TryGetNumberField(TEXT("major"), Major)
		|| !(*Version)->TryGetNumberField(TEXT("minor"), Minor)
		|| Major != 1.0
		|| Minor != 0.0
		|| !RequestedTargetMapPath.StartsWith(TEXT("/Game/"))
		|| !FPackageName::IsValidLongPackageName(RequestedTargetMapPath))
	{
		Reject(
			TEXT("invalid_request"),
			TEXT("Editor world-control request or target map path is invalid."),
			TEXT("Use contract 1.0, a safe operation ID, and a /Game/ long package name."),
			false);
		return;
	}
	if (GEditor == nullptr)
	{
		Reject(
			TEXT("unavailable"),
			TEXT("The Unreal editor is unavailable."),
			TEXT("Run this operation in an initialized Unreal Editor process."),
			true);
		return;
	}
	const UWorld* CurrentWorld = GEditor->GetEditorWorldContext().World();
	if (CurrentWorld != nullptr && CurrentWorld->GetOutermost()->GetName() == TargetMapPath)
	{
		SerializeResponse(
			OperationId,
			TargetMapPath,
			TEXT("already_open"),
			InitialSnapshot,
			ResultJson);
		return;
	}
	if (GEditor->IsPlaySessionInProgress())
	{
		Reject(
			TEXT("play_session_active"),
			TEXT("A Play In Editor or Simulate session is active or starting."),
			TEXT("Stop the editor play session, then retry the map switch."),
			true);
		return;
	}
	TArray<UPackage*> DirtyPackages;
	FEditorFileUtils::GetDirtyWorldPackages(DirtyPackages);
	if (!DirtyPackages.IsEmpty())
	{
		Reject(
			TEXT("dirty_world"),
			TEXT("The editor has unsaved world packages; UE Shed refused to switch maps."),
			TEXT("Save or revert the dirty world packages explicitly, then retry."),
			true);
		return;
	}
	if (!FPackageName::DoesPackageExist(TargetMapPath))
	{
		Reject(
			TEXT("map_not_found"),
			TEXT("The target map package does not exist in this project."),
			TEXT("Choose a map path reported by the selected project's saved map index."),
			false);
		return;
	}

	const FString ObjectPath = FString::Printf(
		TEXT("%s.%s"),
		*TargetMapPath,
		*FPackageName::GetShortName(TargetMapPath));
	UWorld* OpenedWorld = UEditorLoadingAndSavingUtils::LoadMap(ObjectPath);
	if (OpenedWorld == nullptr || OpenedWorld->GetOutermost()->GetName() != TargetMapPath)
	{
		Reject(
			TEXT("open_failed"),
			TEXT("Unreal Editor did not open the requested map."),
			TEXT("Inspect the editor log and map load dependencies, then retry."),
			true);
		return;
	}
	SerializeResponse(
		OperationId,
		TargetMapPath,
		TEXT("opened"),
		InitialSnapshot,
		ResultJson);
}
