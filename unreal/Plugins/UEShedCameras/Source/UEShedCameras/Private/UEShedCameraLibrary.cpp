#include "UEShedCameraLibrary.h"

#include "Dom/JsonObject.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UEShedCameraSubsystem.h"

namespace
{
UUEShedCameraSubsystem* FindCameraSubsystem()
{
	if (GEngine == nullptr) return nullptr;
	for (const FWorldContext& Context : GEngine->GetWorldContexts())
	{
		UWorld* World = Context.World();
		if (World != nullptr && World->IsGameWorld())
		{
			return World->GetSubsystem<UUEShedCameraSubsystem>();
		}
	}
	return nullptr;
}

FString ErrorJson(const TCHAR* Code)
{
	return FString::Printf(TEXT("{\"schemaVersion\":1,\"status\":\"failed\",\"error\":\"%s\"}"), Code);
}
}

void UUEShedCameraLibrary::GetStatus(FString& ResultJson)
{
	if (UUEShedCameraSubsystem* Subsystem = FindCameraSubsystem())
	{
		ResultJson = Subsystem->StatusJson();
		return;
	}
	ResultJson = TEXT("{\"schemaVersion\":1,\"error\":\"no-running-game-world\"}");
}

void UUEShedCameraLibrary::Configure(const FString& ConfigJson, FString& ResultJson)
{
	if (UUEShedCameraSubsystem* Subsystem = FindCameraSubsystem())
	{
		FString Error;
		if (Subsystem->ApplyConfigJson(ConfigJson, Error))
		{
			ResultJson = Subsystem->StatusJson();
			return;
		}
		ResultJson = FString::Printf(TEXT("{\"schemaVersion\":1,\"error\":\"%s\"}"), *Error);
		return;
	}
	ResultJson = TEXT("{\"schemaVersion\":1,\"error\":\"no-running-game-world\"}");
}

void UUEShedCameraLibrary::EnsureProvisionedCameras(
	const FString& RequestJson,
	FString& ResultJson)
{
	UUEShedCameraSubsystem* Subsystem = FindCameraSubsystem();
	if (Subsystem == nullptr)
	{
		ResultJson = ErrorJson(TEXT("no-running-game-world"));
		return;
	}
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		ResultJson = ErrorJson(TEXT("invalid-json"));
		return;
	}
	const TArray<TSharedPtr<FJsonValue>>* CamerasJson = nullptr;
	if (!Root->TryGetArrayField(TEXT("cameras"), CamerasJson))
	{
		// Accept the pre-rename field while clients and installed plugins roll forward together.
		Root->TryGetArrayField(TEXT("sources"), CamerasJson);
	}
	if (CamerasJson == nullptr)
	{
		ResultJson = ErrorJson(TEXT("missing-cameras"));
		return;
	}
	if (CamerasJson->Num() == 0 || CamerasJson->Num() > 32)
	{
		ResultJson = ErrorJson(TEXT("invalid-camera-count"));
		return;
	}
	TArray<FUEShedProvisionedCameraSpec> Specs;
	Specs.Reserve(CamerasJson->Num());
	for (const TSharedPtr<FJsonValue>& Entry : *CamerasJson)
	{
		const TSharedPtr<FJsonObject> Object = Entry->AsObject();
		if (!Object.IsValid())
		{
			ResultJson = ErrorJson(TEXT("invalid-camera"));
			return;
		}
		FUEShedProvisionedCameraSpec Spec;
		const TSharedPtr<FJsonObject>* CorrelationObject = nullptr;
		if (Object->TryGetObjectField(TEXT("correlation"), CorrelationObject))
		{
			if (!(*CorrelationObject)->TryGetStringField(TEXT("type"), Spec.CorrelationType)
				|| (Spec.CorrelationType != TEXT("framing_candidate")
					&& Spec.CorrelationType != TEXT("review_view")))
			{
				ResultJson = ErrorJson(TEXT("invalid-correlation-type"));
				return;
			}
			const TCHAR* CorrelationIdField = Spec.CorrelationType == TEXT("framing_candidate")
				? TEXT("candidateId") : TEXT("reviewViewId");
			if (!(*CorrelationObject)->TryGetStringField(CorrelationIdField, Spec.CorrelationId)
				|| Spec.CorrelationId.IsEmpty())
			{
				ResultJson = ErrorJson(TEXT("invalid-correlation-id"));
				return;
			}
		}
		else if (Object->TryGetStringField(TEXT("candidateId"), Spec.CorrelationId)
			&& !Spec.CorrelationId.IsEmpty())
		{
			// Compatibility decoder for the candidate-only request emitted before Plan 032.
			Spec.CorrelationType = TEXT("framing_candidate");
		}
		else
		{
			ResultJson = ErrorJson(TEXT("invalid-correlation"));
			return;
		}
		const TSharedPtr<FJsonObject>* LocationObject = nullptr;
		const TSharedPtr<FJsonObject>* RotationObject = nullptr;
		double X = 0;
		double Y = 0;
		double Z = 0;
		double Pitch = 0;
		double Yaw = 0;
		double Roll = 0;
		double Fov = 60;
		double Width = 320;
		double Height = 180;
		if (!Object->TryGetObjectField(TEXT("location"), LocationObject)
			|| !(*LocationObject)->TryGetNumberField(TEXT("x"), X)
			|| !(*LocationObject)->TryGetNumberField(TEXT("y"), Y)
			|| !(*LocationObject)->TryGetNumberField(TEXT("z"), Z)
			|| !Object->TryGetObjectField(TEXT("rotation"), RotationObject)
			|| !(*RotationObject)->TryGetNumberField(TEXT("pitch"), Pitch)
			|| !(*RotationObject)->TryGetNumberField(TEXT("yaw"), Yaw))
		{
			ResultJson = ErrorJson(TEXT("invalid-pose"));
			return;
		}
		(*RotationObject)->TryGetNumberField(TEXT("roll"), Roll);
		Object->TryGetNumberField(TEXT("fieldOfViewDegrees"), Fov);
		Object->TryGetNumberField(TEXT("width"), Width);
		Object->TryGetNumberField(TEXT("height"), Height);
		if (!FMath::IsFinite(Fov) || Fov < 5 || Fov > 170 || Width < 64 || Width > 2560
			|| Height < 64 || Height > 1440)
		{
			ResultJson = ErrorJson(TEXT("invalid-camera-dimensions"));
			return;
		}
		Spec.Location = FVector(X, Y, Z);
		Spec.Rotation = FRotator(Pitch, Yaw, Roll);
		Spec.FieldOfViewDegrees = static_cast<float>(Fov);
		Spec.Width = FMath::RoundToInt(Width);
		Spec.Height = FMath::RoundToInt(Height);
		Specs.Add(Spec);
	}
	FString Error;
	if (!Subsystem->EnsureProvisionedCameras(Specs, Error))
	{
		ResultJson = ErrorJson(*Error);
		return;
	}
	double PreviewFps = 10.0;
	Root->TryGetNumberField(TEXT("previewFps"), PreviewFps);
	const int32 ClampedFps = FMath::Clamp(FMath::RoundToInt(PreviewFps), 1, 10);
	FString ConfigureError;
	const FString ConfigJson = FString::Printf(
		TEXT("{\"activeCameraCount\":%d,\"backgroundFps\":%d,\"captureBudgetPerTick\":%d,")
		TEXT("\"focusedCameraIndex\":0,\"focusedFps\":%d,\"paused\":false,")
		TEXT("\"pipelineMode\":\"full_pipeline\",\"renderProfile\":\"observation\",")
		TEXT("\"resolution\":\"%dx%d\",\"viewMode\":\"posed\"}"),
		Specs.Num(),
		ClampedFps,
		FMath::Clamp(Specs.Num(), 1, 8),
		ClampedFps,
		Specs[0].Width,
		Specs[0].Height);
	if (!Subsystem->ApplyConfigJson(ConfigJson, ConfigureError))
	{
		Subsystem->ClearProvisionedCameras();
		ResultJson = ErrorJson(*ConfigureError);
		return;
	}
	ResultJson = Subsystem->StatusJson();
}

void UUEShedCameraLibrary::ClearProvisionedCameras(FString& ResultJson)
{
	UUEShedCameraSubsystem* Subsystem = FindCameraSubsystem();
	if (Subsystem == nullptr)
	{
		ResultJson = ErrorJson(TEXT("no-running-game-world"));
		return;
	}
	Subsystem->ClearProvisionedCameras();
	ResultJson = Subsystem->StatusJson();
}
