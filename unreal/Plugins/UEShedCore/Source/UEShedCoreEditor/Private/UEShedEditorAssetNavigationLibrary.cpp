#include "UEShedEditorAssetNavigationLibrary.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "ContentBrowserModule.h"
#include "Dom/JsonObject.h"
#include "Framework/Application/SlateApplication.h"
#include "IContentBrowserSingleton.h"
#include "Misc/PackageName.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Widgets/SWindow.h"

namespace
{
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
	const FAssetData Asset =
		AssetRegistryModule.Get().GetAssetByObjectPath(FSoftObjectPath(ObjectPath));
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
	if (BringToFront && FSlateApplication::IsInitialized())
	{
		if (const TSharedPtr<SWindow> Window =
			FSlateApplication::Get().GetActiveTopLevelWindow())
		{
			Window->BringToFront(true);
		}
	}

	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("objectPath"), ObjectPath);
	Root->SetStringField(TEXT("status"), TEXT("located"));
	SerializeResult(Root, ResultJson);
}
