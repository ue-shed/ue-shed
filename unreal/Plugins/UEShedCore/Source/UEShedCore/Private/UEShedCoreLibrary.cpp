#include "UEShedCoreLibrary.h"

#include "Dom/JsonObject.h"
#include "Misc/App.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Modules/ModuleManager.h"

void UUEShedCoreLibrary::GetCapabilityManifest(FString& ResultJson)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetNumberField(TEXT("schemaVersion"), 1);
	Root->SetStringField(TEXT("producerKind"), TEXT("unreal_editor"));
	Root->SetStringField(TEXT("projectName"), FApp::GetProjectName());
	TArray<TSharedPtr<FJsonValue>> Capabilities;
	if (FModuleManager::Get().IsModuleLoaded(TEXT("UEShedAuthoring")))
	{
		Root->SetStringField(
			TEXT("authoringObjectPath"),
			TEXT("/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary"));
		const TSharedRef<FJsonObject> Limits = MakeShared<FJsonObject>();
		Limits->SetNumberField(TEXT("maxCommands"), 1024);
		Limits->SetNumberField(TEXT("maxPayloadBytes"), 1024 * 1024);
		Limits->SetNumberField(TEXT("maxTables"), 16);
		Root->SetObjectField(TEXT("authoringLimits"), Limits);
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("authoring.snapshot.v2")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("authoring.table-list.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("authoring.apply.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("authoring.apply-result.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("authoring.save.v1")));
	}
	if (FModuleManager::Get().IsModuleLoaded(TEXT("UEShedCameras")))
	{
		Root->SetStringField(TEXT("camerasObjectPath"),
			TEXT("/Script/UEShedCameras.Default__UEShedCameraLibrary"));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("cameras.control.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("cameras.frames.bgra8.pipe.v1")));
	}
	if (FModuleManager::Get().IsModuleLoaded(TEXT("UEShedObservatoryEditor")))
	{
		Root->SetStringField(TEXT("observatoryObjectPath"),
			TEXT("/Script/UEShedObservatoryEditor.Default__UEShedObservatoryLibrary"));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("observatory.actors.snapshot.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("observatory.actors.focus.v1")));
	}
	if (FModuleManager::Get().IsModuleLoaded(TEXT("UEShedCoreEditor")))
	{
		Root->SetStringField(
			TEXT("assetNavigationObjectPath"),
			TEXT("/Script/UEShedCoreEditor.Default__UEShedEditorAssetNavigationLibrary"));
		Root->SetStringField(
			TEXT("playSessionObjectPath"),
			TEXT("/Script/UEShedCoreEditor.Default__UEShedEditorPlaySessionLibrary"));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("editor.asset-navigation.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("editor.play-session.v1")));
	}
	if (FModuleManager::Get().IsModuleLoaded(TEXT("UEShedAssetAudits")))
	{
		Root->SetStringField(TEXT("assetAuditsObjectPath"),
			TEXT("/Script/UEShedAssetAudits.Default__UEShedAssetAuditsLibrary"));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("asset-audits.texture-preview.v1")));
	}
	Root->SetArrayField(TEXT("capabilities"), Capabilities);
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ResultJson);
	FJsonSerializer::Serialize(Root, Writer);
}
