#include "UEShedEditorAssetNavigationLibrary.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "ContentBrowserModule.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformProcess.h"
#include "IContentBrowserSingleton.h"
#include "Misc/PackageName.h"
#include "Modules/ModuleManager.h"
#include "Runtime/Launch/Resources/Version.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "UEShedEditorWindowLibrary.h"

namespace
{
// UE 4.27's Asset Registry looks object paths up by FName; UE5 by FSoftObjectPath.
FAssetData FindRegisteredAsset(IAssetRegistry& AssetRegistry, const FString& ObjectPath)
{
#if ENGINE_MAJOR_VERSION < 5
	return AssetRegistry.GetAssetByObjectPath(FName(*ObjectPath));
#else
	return AssetRegistry.GetAssetByObjectPath(FSoftObjectPath(ObjectPath));
#endif
}

TSharedRef<FJsonObject> ContractJson()
{
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("unreal-editor-asset-navigation"));
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}

void SerializeResult(const TSharedRef<FJsonObject>& Root, FString& ResultJson)
{
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ResultJson);
	FJsonSerializer::Serialize(Root, Writer);
}

void SerializeUnavailable(
	const FString& ObjectPath,
	const TCHAR* Reason,
	const TCHAR* Message,
	const TCHAR* Recovery,
	bool RetrySafe,
	FString& ResultJson)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("objectPath"), ObjectPath);
	Root->SetStringField(TEXT("status"), TEXT("unavailable"));
	Root->SetStringField(TEXT("reason"), Reason);
	Root->SetStringField(TEXT("message"), Message);
	Root->SetStringField(TEXT("recovery"), Recovery);
	Root->SetBoolField(TEXT("retrySafe"), RetrySafe);
	SerializeResult(Root, ResultJson);
}
}

void UUEShedEditorAssetNavigationLibrary::OpenAsset(
	const FString& ObjectPath,
	bool BringToFront,
	FString& ResultJson)
{
	const TSharedRef<FJsonObject> Contract = ContractJson();
	Contract->SetStringField(TEXT("name"), TEXT("unreal-editor-asset-open"));
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), Contract);
	Root->SetStringField(TEXT("objectPath"), ObjectPath);
	auto Unavailable = [&](const TCHAR* Reason, const FString& Message,
		const TCHAR* Recovery, bool RetrySafe)
	{
		Root->SetStringField(TEXT("status"), TEXT("unavailable"));
		Root->SetStringField(TEXT("reason"), Reason);
		Root->SetStringField(TEXT("message"), Message);
		Root->SetStringField(TEXT("recovery"), Recovery);
		Root->SetBoolField(TEXT("retrySafe"), RetrySafe);
		SerializeResult(Root, ResultJson);
	};

	// Accept any mounted content root, including plugin and engine content, but never subobjects.
	FText PathReason;
	FString PackageName, AssetName;
	const bool HasObjectName = ObjectPath.Split(TEXT("."), &PackageName, &AssetName);
	if (!HasObjectName || PackageName.Len() >= NAME_SIZE || AssetName.Len() >= NAME_SIZE ||
		AssetName.Contains(TEXT(".")) ||
		ObjectPath.Contains(TEXT(":")) ||
		!FPackageName::IsValidObjectPath(ObjectPath, &PathReason))
	{
		Unavailable(TEXT("invalid_object_path"), TEXT("Expected a top-level asset object path."),
			TEXT("Use a full asset object path such as /Game/Folder/Asset.Asset."), false);
		return;
	}
	if (!IsInGameThread() || !GEditor || IsRunningCommandlet() ||
		!FSlateApplication::IsInitialized())
	{
		Unavailable(TEXT("editor_unavailable"), TEXT("No interactive asset editor is available."),
			TEXT("Connect to an interactive Unreal Editor and retry on its game thread."), true);
		return;
	}
	UAssetEditorSubsystem* AssetEditors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
	FAssetRegistryModule* AssetRegistry =
		FModuleManager::LoadModulePtr<FAssetRegistryModule>(TEXT("AssetRegistry"));
	if (!AssetEditors || !AssetRegistry)
	{
		Unavailable(TEXT("editor_unavailable"), TEXT("The editor's asset services are unavailable."),
			TEXT("Wait for the editor to finish starting and retry."), true);
		return;
	}

	const FAssetData AssetData = FindRegisteredAsset(AssetRegistry->Get(), ObjectPath);
	if (!AssetData.IsValid())
	{
		Unavailable(TEXT("asset_not_found"), TEXT("The Asset Registry could not find this asset."),
			TEXT("Confirm the connected project and asset object path, then refresh discovery."), true);
		return;
	}
	UObject* Asset = AssetData.GetAsset();
	if (!Asset)
	{
		Unavailable(TEXT("asset_load_failed"), TEXT("Unreal could not load the registered asset."),
			TEXT("Inspect the editor log and repair the asset or its dependencies, then retry."), true);
		return;
	}
	if (!Asset->IsAsset())
	{
		Unavailable(TEXT("not_an_asset"), TEXT("The loaded object is not a top-level asset."),
			TEXT("Use the object path of a top-level asset."), false);
		return;
	}

#if ENGINE_MAJOR_VERSION >= 5
	FText OpenReason;
	if (!AssetEditors->CanOpenEditorForAsset(Asset, EAssetTypeActivationOpenedMethod::Edit, &OpenReason))
	{
		Unavailable(TEXT("editor_refused"), OpenReason.ToString(),
			TEXT("Check the asset type's editor support and the editor log before retrying."), false);
		return;
	}
#endif
	// UE 4.27 has no CanOpenEditorForAsset; its OpenEditorForAsset refusal below is the only answer.
	// Avoid Unreal's unconditional focus of an already-open editor when BringToFront is false.
	if (!AssetEditors->FindEditorForAsset(Asset, BringToFront) &&
		!AssetEditors->OpenEditorForAsset(Asset, EToolkitMode::Standalone, {}, false))
	{
		Unavailable(TEXT("editor_refused"), TEXT("Unreal refused the asset-editor open request."),
			TEXT("Inspect the editor log for the asset editor's refusal."), false);
		return;
	}
	// As LocateAsset does: an editor tab behind another app is not visible, so raise Unreal's window.
	// Focus is a request, not an OS guarantee.
	if (BringToFront)
	{
		FString ActivationJson;
		UUEShedEditorWindowLibrary::ActivateEditorWindow(
			FString::Printf(TEXT("{\"expectedProcessId\":%u}"), FPlatformProcess::GetCurrentProcessId()),
			ActivationJson);
		TSharedPtr<FJsonObject> Activation;
		if (!ActivationJson.IsEmpty() &&
			FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ActivationJson), Activation))
		{
			Root->SetObjectField(TEXT("windowActivation"), Activation);
		}
	}
	Root->SetStringField(TEXT("status"), TEXT("ok"));
	SerializeResult(Root, ResultJson);
}

void UUEShedEditorAssetNavigationLibrary::LocateAsset(
	const FString& ObjectPath,
	bool BringToFront,
	FString& ResultJson)
{
	FText PathReason;
	if (!ObjectPath.StartsWith(TEXT("/Game/")) ||
		!FPackageName::IsValidObjectPath(ObjectPath, &PathReason))
	{
		SerializeUnavailable(
			ObjectPath,
			TEXT("invalid_object_path"),
			TEXT("The requested value is not a valid project asset object path."),
			TEXT("Use the /Game/ object path reported by the text occurrence."),
			false,
			ResultJson);
		return;
	}

	FAssetRegistryModule& AssetRegistryModule =
		FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
	const FAssetData Asset = FindRegisteredAsset(AssetRegistryModule.Get(), ObjectPath);
	if (!Asset.IsValid())
	{
		SerializeUnavailable(
			ObjectPath,
			TEXT("asset_not_found"),
			TEXT("Unreal could not find this asset in the current project's Asset Registry."),
			TEXT("Confirm Workbench and Unreal are using the same project, then rescan."),
			true,
			ResultJson);
		return;
	}

	FContentBrowserModule& ContentBrowserModule =
		FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
	ContentBrowserModule.Get().SyncBrowserToAssets({Asset}, false, true);
	FString ActivationJson;
	if (BringToFront)
	{
		UUEShedEditorWindowLibrary::ActivateEditorWindow(
			FString::Printf(TEXT("{\"expectedProcessId\":%u}"), FPlatformProcess::GetCurrentProcessId()),
			ActivationJson);
	}

	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("objectPath"), ObjectPath);
	if (!ActivationJson.IsEmpty())
	{
		TSharedPtr<FJsonObject> Activation;
		if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ActivationJson), Activation))
		{
			Root->SetObjectField(TEXT("windowActivation"), Activation);
		}
	}
	Root->SetStringField(TEXT("status"), TEXT("located"));
	SerializeResult(Root, ResultJson);
}
