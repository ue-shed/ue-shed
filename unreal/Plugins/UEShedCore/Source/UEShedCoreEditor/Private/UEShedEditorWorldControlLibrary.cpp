#include "UEShedEditorWorldControlLibrary.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "Misc/PackageName.h"
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
