#if WITH_DEV_AUTOMATION_TESTS
#include "UEShedEditorAssetNavigationLibrary.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Internationalization/StringTable.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Runtime/Launch/Resources/Version.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "UEShedCoreLibrary.h"
#include "UObject/Package.h"

namespace
{
TSharedPtr<FJsonObject> DecodeAssetResult(const FString& Json)
{
	TSharedPtr<FJsonObject> Result;
	FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Result);
	return Result;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedEditorCapabilitiesTest,
	"UEShed.Core.EditorAssets.Manifest",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedEditorCapabilitiesTest::RunTest(const FString& Parameters)
{
	FString Json;
	UUEShedCoreLibrary::GetCapabilityManifest(Json);
	const TSharedPtr<FJsonObject> Manifest = DecodeAssetResult(Json);
	if (!TestTrue(TEXT("Manifest returns JSON"), Manifest.IsValid())) return false;
	TArray<FString> Capabilities;
	for (const TSharedPtr<FJsonValue>& Value : Manifest->GetArrayField(TEXT("capabilities")))
		Capabilities.Add(Value->AsString());
	// Every engine builds asset navigation and window activation into this module, UE 4.27 only
	// those, so each capability and object path follows its own class.
	struct FExpected
	{
		const TCHAR* Class;
		const TCHAR* Field;
		TArray<const TCHAR*> Names;
	};
	const TArray<FExpected> Expected = {
		{TEXT("UEShedEditorAssetNavigationLibrary"), TEXT("assetNavigationObjectPath"),
			{TEXT("editor.asset-navigation.v1"), TEXT("editor.asset-open.v1")}},
		{TEXT("UEShedEditorWindowLibrary"), TEXT("windowActivationObjectPath"),
			{TEXT("editor.window-activation.v1")}},
		{TEXT("UEShedEditorPlaySessionLibrary"), TEXT("playSessionObjectPath"),
			{TEXT("editor.play-session.v1")}},
		{TEXT("UEShedEditorWorldControlLibrary"), TEXT("worldControlObjectPath"),
			{TEXT("editor.world-control.v1"), TEXT("editor.world-control.async.v1"),
				TEXT("editor.world-state.v1")}}};
	for (const FExpected& Item : Expected)
	{
		const bool bBuilt =
			FindObject<UClass>(nullptr, *(FString(TEXT("/Script/UEShedCoreEditor.")) + Item.Class)) != nullptr;
		TestEqual(FString(TEXT("Object path follows the class: ")) + Item.Class,
			Manifest->HasField(Item.Field), bBuilt);
		for (const TCHAR* Name : Item.Names)
			TestEqual(FString(TEXT("Capability follows the class: ")) + Name,
				Capabilities.Contains(Name), bBuilt);
	}
	TestTrue(TEXT("Asset navigation is built on every engine"),
		Capabilities.Contains(TEXT("editor.asset-navigation.v1")) &&
			Capabilities.Contains(TEXT("editor.asset-open.v1")));
#if ENGINE_MAJOR_VERSION < 5
	TestFalse(TEXT("UE 4.27 keeps UE5 editor features out"),
		Capabilities.Contains(TEXT("editor.play-session.v1")) ||
			Capabilities.Contains(TEXT("editor.world-control.v1")) ||
			Capabilities.Contains(TEXT("editor.foreground-responsiveness.v1")));
#endif
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedAssetLocateTest, "UEShed.Core.EditorAssets.Locate",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedAssetLocateTest::RunTest(const FString& Parameters)
{
	// Only select generated assets in the isolated compatibility project, never a user's project.
	if (FPaths::GetBaseFilename(FPaths::GetProjectFilePath()) != TEXT("UEShedPluginCompatibility"))
	{
		AddError(TEXT("Run using test:unreal-plugins in its isolated compatibility project."));
		return false;
	}
	auto Locate = [](const FString& Path)
	{
		FString Json;
		UUEShedEditorAssetNavigationLibrary::LocateAsset(Path, false, Json);
		return DecodeAssetResult(Json);
	};
	for (const FString& Path : {FString(TEXT("not an object path")), FString(TEXT("/Engine/Asset.Asset"))})
	{
		const TSharedPtr<FJsonObject> Result = Locate(Path);
		if (!TestTrue(TEXT("Invalid path returns JSON"), Result.IsValid())) return false;
		TestEqual(TEXT("Invalid path reason"), Result->GetStringField(TEXT("reason")),
			FString(TEXT("invalid_object_path")));
	}
	const TSharedPtr<FJsonObject> Missing = Locate(TEXT("/Game/UEShedTests/Missing_") +
		FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT(".Missing"));
	if (!TestTrue(TEXT("Missing asset returns JSON"), Missing.IsValid())) return false;
	TestEqual(TEXT("Missing asset reason"), Missing->GetStringField(TEXT("reason")),
		FString(TEXT("asset_not_found")));
	TestTrue(TEXT("Missing asset may appear after a rescan"), Missing->GetBoolField(TEXT("retrySafe")));

	const FString PackageName =
		TEXT("/Game/UEShedTests/LocateAsset_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
	UPackage* Package = CreatePackage(*PackageName);
	UStringTable* Asset = NewObject<UStringTable>(Package, TEXT("ST_LocateAsset"), RF_Public | RF_Standalone);
	FAssetRegistryModule::AssetCreated(Asset);
	const FString Path = Asset->GetPathName();
	const TSharedPtr<FJsonObject> Located = Locate(Path);
	if (TestTrue(TEXT("Locate returns JSON"), Located.IsValid()))
	{
		TestEqual(TEXT("Registered asset is located"), Located->GetStringField(TEXT("status")),
			FString(TEXT("located")));
		TestEqual(TEXT("Reply identifies the asset"), Located->GetStringField(TEXT("objectPath")), Path);
	}
	FAssetRegistryModule::AssetDeleted(Asset);
	Asset->ClearFlags(RF_Standalone);
	Package->SetDirtyFlag(false);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedAssetOpenUnavailableTest,
	"UEShed.Core.EditorAssets.OpenUnavailable",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedAssetOpenUnavailableTest::RunTest(const FString& Parameters)
{
	const TArray<FString> InvalidPaths = {
		TEXT(""), TEXT("not an object path"), TEXT("/Game/Fixture/Asset"),
		TEXT("/Game/Fixture/Asset.Asset:Subobject"), TEXT("/Game/Fixture/Asset.Asset.Subobject"),
		TEXT("/Game/Fixture/") + FString::ChrN(NAME_SIZE, TEXT('a')) + TEXT(".Asset"),
		TEXT("/Game/Fixture/Asset.") + FString::ChrN(NAME_SIZE, TEXT('a'))
	};
	for (const FString& Path : InvalidPaths)
	{
		FString Json;
		UUEShedEditorAssetNavigationLibrary::OpenAsset(Path, false, Json);
		const TSharedPtr<FJsonObject> Result = DecodeAssetResult(Json);
		if (!TestTrue(TEXT("Invalid path returns JSON"), Result.IsValid())) return false;
		TestEqual(TEXT("Unavailable status"), Result->GetStringField(TEXT("status")), FString(TEXT("unavailable")));
		TestEqual(TEXT("Invalid path reason"), Result->GetStringField(TEXT("reason")), FString(TEXT("invalid_object_path")));
		TestFalse(TEXT("Invalid input is not retryable"), Result->GetBoolField(TEXT("retrySafe")));
	}
	const FString Missing = TEXT("/Game/UEShedTests/Missing_") +
		FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT(".Missing");
	FString Json;
	UUEShedEditorAssetNavigationLibrary::OpenAsset(Missing, false, Json);
	const TSharedPtr<FJsonObject> Result = DecodeAssetResult(Json);
	if (!TestTrue(TEXT("Missing asset returns JSON"), Result.IsValid())) return false;
	TestEqual(TEXT("Missing asset is unavailable"), Result->GetStringField(TEXT("status")), FString(TEXT("unavailable")));
	TestEqual(TEXT("Missing asset reason"), Result->GetStringField(TEXT("reason")), FString(TEXT("asset_not_found")));
	TestEqual(TEXT("Open has a separate contract"), Result->GetObjectField(TEXT("contract"))->GetStringField(TEXT("name")), FString(TEXT("unreal-editor-asset-open")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedAssetOpenTest, "UEShed.Core.EditorAssets.Open",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedAssetOpenTest::RunTest(const FString& Parameters)
{
	// Only open generated editors in the isolated compatibility project, never a user's project.
	if (FPaths::GetBaseFilename(FPaths::GetProjectFilePath()) != TEXT("UEShedPluginCompatibility"))
	{
		AddError(TEXT("Run using test:unreal-plugins in its isolated compatibility project."));
		return false;
	}
	UAssetEditorSubsystem* Editors = GEditor ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
	if (!TestNotNull(TEXT("Asset editor subsystem"), Editors)) return false;
	const FString PackageName = TEXT("/Game/UEShedTests/OpenAsset_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
	UPackage* Package = CreatePackage(*PackageName);
	UStringTable* Asset = NewObject<UStringTable>(Package, TEXT("ST_OpenAsset"), RF_Public | RF_Standalone);
	FAssetRegistryModule::AssetCreated(Asset);
	const FString Path = Asset->GetPathName();
	FString Json;
	UUEShedEditorAssetNavigationLibrary::OpenAsset(Path, false, Json);
	const TSharedPtr<FJsonObject> Result = DecodeAssetResult(Json);
	if (TestTrue(TEXT("Open returns JSON"), Result.IsValid()))
	{
		TestEqual(TEXT("Open accepted"), Result->GetStringField(TEXT("status")), FString(TEXT("ok")));
		TestEqual(TEXT("Reply identifies the asset"), Result->GetStringField(TEXT("objectPath")), Path);
	}
	TestNotNull(TEXT("An asset editor was opened"), Editors->FindEditorForAsset(Asset, false));
	for (const bool BringToFront : {false, true})
	{
		UUEShedEditorAssetNavigationLibrary::OpenAsset(Path, BringToFront, Json);
		const TSharedPtr<FJsonObject> Reopened = DecodeAssetResult(Json);
		if (TestTrue(TEXT("Repeated open returns JSON"), Reopened.IsValid()))
			TestEqual(TEXT("Already-open asset succeeds"), Reopened->GetStringField(TEXT("status")), FString(TEXT("ok")));
	}
	Editors->CloseAllEditorsForAsset(Asset);
	FAssetRegistryModule::AssetDeleted(Asset);
	Asset->ClearFlags(RF_Standalone);
	Package->SetDirtyFlag(false);
	return true;
}
#endif
