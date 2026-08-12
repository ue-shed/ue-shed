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
	if (FModuleManager::Get().IsModuleLoaded(TEXT("UEShedCamerasEditor")))
	{
		Root->SetStringField(TEXT("cameraReviewObjectPath"),
			TEXT("/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary"));
		const TSharedRef<FJsonObject> Limits = MakeShared<FJsonObject>();
		Limits->SetNumberField(TEXT("maxTilesPerRequest"), 64);
		Limits->SetNumberField(TEXT("maxTilePixels"), 4096);
		Limits->SetNumberField(TEXT("maxGutterPixels"), 32);
		Root->SetObjectField(TEXT("mapTileCaptureLimits"), Limits);
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("cameras.map-tile-capture.v1")));
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
		Root->SetStringField(
			TEXT("worldControlObjectPath"),
			TEXT("/Script/UEShedCoreEditor.Default__UEShedEditorWorldControlLibrary"));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("editor.asset-navigation.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("editor.play-session.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("editor.world-control.v1")));
	}
	if (FModuleManager::Get().IsModuleLoaded(TEXT("UEShedScenariosEditor")))
	{
		Root->SetStringField(TEXT("scenariosObjectPath"),
			TEXT("/Script/UEShedScenariosEditor.Default__UEShedScenarioLibrary"));
		const TSharedRef<FJsonObject> Limits = MakeShared<FJsonObject>();
		Limits->SetNumberField(TEXT("maxActions"), 8);
		Limits->SetNumberField(TEXT("maxDurationMs"), 30000);
		Limits->SetNumberField(TEXT("maxEvidence"), 8);
		Limits->SetNumberField(TEXT("maxKeyframes"), 32);
		Root->SetObjectField(TEXT("scenarioLimits"), Limits);
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("scenarios.execute.pie.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("scenarios.evidence.world-state.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("scenarios.input-isolation.slate.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("scenarios.input.pre-evaluation.v1")));
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
