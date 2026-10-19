#if WITH_DEV_AUTOMATION_TESTS
#include "UEShedEditorAssetNavigationLibrary.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/StringTable.h"
#include "Misc/AutomationTest.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Subsystems/AssetEditorSubsystem.h"
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
