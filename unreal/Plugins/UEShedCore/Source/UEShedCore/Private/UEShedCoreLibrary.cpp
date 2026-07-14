#include "UEShedCoreLibrary.h"

#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Modules/ModuleManager.h"

void UUEShedCoreLibrary::GetCapabilityManifest(FString& ResultJson)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetNumberField(TEXT("schemaVersion"), 1);
	Root->SetStringField(TEXT("producerKind"), TEXT("unreal_editor"));
	Root->SetStringField(
		TEXT("authoringObjectPath"),
		TEXT("/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary"));
	TArray<TSharedPtr<FJsonValue>> Capabilities = {
		MakeShared<FJsonValueString>(TEXT("authoring.snapshot.v1")),
		MakeShared<FJsonValueString>(TEXT("authoring.apply.v1")),
		MakeShared<FJsonValueString>(TEXT("authoring.apply-result.v1")),
		MakeShared<FJsonValueString>(TEXT("authoring.save.v1"))
	};
	if (FModuleManager::Get().ModuleExists(TEXT("UEShedCameras")))
	{
		Root->SetStringField(TEXT("camerasObjectPath"),
			TEXT("/Script/UEShedCameras.Default__UEShedCameraLibrary"));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("cameras.control.v1")));
		Capabilities.Add(MakeShared<FJsonValueString>(TEXT("cameras.frames.bgra8.pipe.v1")));
	}
	Root->SetArrayField(TEXT("capabilities"), Capabilities);
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ResultJson);
	FJsonSerializer::Serialize(Root, Writer);
}
