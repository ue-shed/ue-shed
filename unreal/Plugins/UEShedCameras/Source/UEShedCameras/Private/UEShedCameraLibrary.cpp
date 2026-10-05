#include "UEShedCameraLibrary.h"

#include "Dom/JsonObject.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UEShedCameraSubsystem.h"

FUEShedResolvePreviewVisibility& UEShedPreviewVisibilityResolver() { static FUEShedResolvePreviewVisibility Resolver; return Resolver; }
FUEShedProvisionedEditorPreviews& UEShedProvisionedEditorPreviewsHook() { static FUEShedProvisionedEditorPreviews Hook; return Hook; }

namespace
{
UUEShedCameraSubsystem* FindCameraSubsystem()
{
	if (GEngine == nullptr) return nullptr;
	UUEShedCameraSubsystem* EditorSubsystem = nullptr;
	for (const FWorldContext& Context : GEngine->GetWorldContexts())
	{
		UWorld* World = Context.World();
		if (World != nullptr && World->IsGameWorld())
		{
			if (UUEShedCameraSubsystem* Subsystem =
				World->GetSubsystem<UUEShedCameraSubsystem>()) return Subsystem;
		}
		if (World != nullptr && World->WorldType == EWorldType::Editor)
		{
			EditorSubsystem = World->GetSubsystem<UUEShedCameraSubsystem>();
		}
	}
	return EditorSubsystem;
}

void ClearOtherProvisionedCameraSubsystems(UUEShedCameraSubsystem* Selected)
{
	if (GEngine == nullptr) return;
	for (const FWorldContext& Context : GEngine->GetWorldContexts())
	{
		UWorld* World = Context.World();
		if (World == nullptr) continue;
		UUEShedCameraSubsystem* Subsystem = World->GetSubsystem<UUEShedCameraSubsystem>();
		if (Subsystem != nullptr && Subsystem != Selected
			&& Subsystem->IsProvisionedCameraSessionActive())
		{
			Subsystem->ClearProvisionedCameras();
		}
	}
}

void ClearAllProvisionedCameraSubsystems()
{
	if (GEngine == nullptr) return;
	for (const FWorldContext& Context : GEngine->GetWorldContexts())
	{
		UWorld* World = Context.World();
		if (World == nullptr) continue;
		if (UUEShedCameraSubsystem* Subsystem = World->GetSubsystem<UUEShedCameraSubsystem>();
			Subsystem != nullptr && Subsystem->IsProvisionedCameraSessionActive())
		{
			Subsystem->ClearProvisionedCameras();
		}
	}
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
	ResultJson = TEXT("{\"schemaVersion\":1,\"error\":\"no-renderable-world\"}");
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
	ResultJson = TEXT("{\"schemaVersion\":1,\"error\":\"no-renderable-world\"}");
}

void UUEShedCameraLibrary::EnsureProvisionedCameras(
	const FString& RequestJson,
	FString& ResultJson)
{
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		ResultJson = ErrorJson(TEXT("invalid-json"));
		return;
	}
	double RequestedVersion = 0;
	Root->TryGetNumberField(TEXT("schemaVersion"), RequestedVersion);
	// Version 5 responses echo the version even on failure, so a client can tell a native failure
	// from an older plugin that ignored editorPreviews.
	auto Fail = [&ResultJson, RequestedVersion](const TCHAR* Code)
	{
		ResultJson = RequestedVersion == 5
			? FString::Printf(TEXT("{\"schemaVersion\":5,\"status\":\"failed\",\"error\":\"%s\"}"), Code)
			: ErrorJson(Code);
	};
	UUEShedCameraSubsystem* Subsystem = FindCameraSubsystem();
	if (Subsystem == nullptr)
	{
		Fail(TEXT("no-renderable-world"));
		return;
	}
	FString ExpectedMapPath;
	if (Root->TryGetStringField(TEXT("expectedMapPath"), ExpectedMapPath))
	{
		const UWorld* World = Subsystem->GetWorld();
		const FString ActualMapPath = World == nullptr
			? FString() : UWorld::RemovePIEPrefix(World->GetOutermost()->GetName());
		if (ExpectedMapPath.IsEmpty() || ActualMapPath != ExpectedMapPath)
		{
			Fail(TEXT("expected-map-mismatch"));
			return;
		}
	}
	const TArray<TSharedPtr<FJsonValue>>* CamerasJson = nullptr;
	if (!Root->TryGetArrayField(TEXT("cameras"), CamerasJson))
	{
		// Accept the pre-rename field while clients and installed plugins roll forward together.
		Root->TryGetArrayField(TEXT("sources"), CamerasJson);
	}
	if (CamerasJson == nullptr)
	{
		Fail(TEXT("missing-cameras"));
		return;
	}
	if (CamerasJson->Num() == 0 || CamerasJson->Num() > 32)
	{
		Fail(TEXT("invalid-camera-count"));
		return;
	}
	// Version 5 adds editorPreviews; older plugins ignore it and echo no version 5.
	bool bEditorPreviews = false;
	if (const TSharedPtr<FJsonValue>* EditorPreviews = Root->Values.Find(TEXT("editorPreviews")))
	{
		if (RequestedVersion != 5 || !EditorPreviews->IsValid()
			|| (*EditorPreviews)->Type != EJson::Boolean)
		{
			Fail(TEXT("invalid-editor-previews"));
			return;
		}
		bEditorPreviews = (*EditorPreviews)->AsBool();
		if (bEditorPreviews && !UEShedProvisionedEditorPreviewsHook().IsBound())
		{
			Fail(TEXT("editor-previews-unavailable"));
			return;
		}
	}
	TArray<FUEShedProvisionedCameraSpec> Specs;
	Specs.Reserve(CamerasJson->Num());
	for (const TSharedPtr<FJsonValue>& Entry : *CamerasJson)
	{
		const TSharedPtr<FJsonObject> Object = Entry->AsObject();
		if (!Object.IsValid())
		{
			Fail(TEXT("invalid-camera"));
			return;
		}
		FUEShedProvisionedCameraSpec Spec;
        if (Object->HasField(TEXT("visibility")))
        {
            const TSharedPtr<FJsonObject>* Visibility = nullptr;
            FString VisibilityError;
            auto& Resolver = UEShedPreviewVisibilityResolver();
            if ((RequestedVersion != 4 && RequestedVersion != 5) || !Object->TryGetObjectField(TEXT("visibility"), Visibility) || !Resolver.IsBound() || !Resolver.Execute(Subsystem->GetWorld(), *Visibility, Spec.HiddenActors, VisibilityError))
            {
                Fail(VisibilityError.IsEmpty() ? TEXT("authored-preview-unavailable") : *VisibilityError);
                return;
            }
        }
		const TSharedPtr<FJsonObject>* CorrelationObject = nullptr;
		if (Object->TryGetObjectField(TEXT("correlation"), CorrelationObject))
		{
			if (!(*CorrelationObject)->TryGetStringField(TEXT("type"), Spec.CorrelationType)
				|| (Spec.CorrelationType != TEXT("framing_candidate")
					&& Spec.CorrelationType != TEXT("review_view")
					&& Spec.CorrelationType != TEXT("map_capture_plan")))
			{
				Fail(TEXT("invalid-correlation-type"));
				return;
			}
			const TCHAR* CorrelationIdField =
				Spec.CorrelationType == TEXT("framing_candidate") ? TEXT("candidateId")
				: Spec.CorrelationType == TEXT("review_view") ? TEXT("reviewViewId")
				: TEXT("mapCapturePlanId");
			if (!(*CorrelationObject)->TryGetStringField(CorrelationIdField, Spec.CorrelationId)
				|| Spec.CorrelationId.IsEmpty())
			{
				Fail(TEXT("invalid-correlation-id"));
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
			Fail(TEXT("invalid-correlation"));
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
		double OrthoWidth = 512;
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
			Fail(TEXT("invalid-pose"));
			return;
		}
		(*RotationObject)->TryGetNumberField(TEXT("roll"), Roll);
		const TSharedPtr<FJsonObject>* ProjectionObject = nullptr;
		if (Object->TryGetObjectField(TEXT("projection"), ProjectionObject))
		{
			FString ProjectionType;
			if (!(*ProjectionObject)->TryGetStringField(TEXT("type"), ProjectionType))
			{
				Fail(TEXT("invalid-projection"));
				return;
			}
			if (ProjectionType == TEXT("perspective"))
			{
				if (!(*ProjectionObject)->TryGetNumberField(TEXT("fieldOfViewDegrees"), Fov))
				{
					Fail(TEXT("invalid-perspective-projection"));
					return;
				}
			}
			else if (ProjectionType == TEXT("orthographic"))
			{
				Spec.bOrthographic = true;
				if (!(*ProjectionObject)->TryGetNumberField(TEXT("orthoWidth"), OrthoWidth))
				{
					Fail(TEXT("invalid-orthographic-projection"));
					return;
				}
			}
			else
			{
				Fail(TEXT("invalid-projection-type"));
				return;
			}
		}
		else
		{
			// Compatibility decoder for schemaVersion 1 and 2 perspective requests.
			Object->TryGetNumberField(TEXT("fieldOfViewDegrees"), Fov);
		}
		Object->TryGetNumberField(TEXT("width"), Width);
		Object->TryGetNumberField(TEXT("height"), Height);
		if ((!Spec.bOrthographic && (!FMath::IsFinite(Fov) || Fov < 5 || Fov > 170))
			|| (Spec.bOrthographic && (!FMath::IsFinite(OrthoWidth) || OrthoWidth <= 0))
			|| Width < 64 || Width > 2560
			|| Height < 64 || Height > 1440)
		{
			Fail(TEXT("invalid-camera-dimensions"));
			return;
		}
		Spec.Location = FVector(X, Y, Z);
		Spec.Rotation = FRotator(Pitch, Yaw, Roll);
		Spec.FieldOfViewDegrees = static_cast<float>(Fov);
		Spec.OrthoWidth = static_cast<float>(OrthoWidth);
		Spec.Width = FMath::RoundToInt(Width);
		Spec.Height = FMath::RoundToInt(Height);
		Specs.Add(Spec);
	}
	ClearOtherProvisionedCameraSubsystems(Subsystem);
	FString Error;
	if (!Subsystem->EnsureProvisionedCameras(Specs, Error, bEditorPreviews))
	{
		Fail(*Error);
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
		Fail(*ConfigureError);
		return;
	}
	ResultJson = Subsystem->StatusJson();
    // Echoing the version confirms the plugin honoured visibility (4) and editor previews (5).
    if (RequestedVersion == 4 || RequestedVersion == 5) {
        TSharedPtr<FJsonObject> Status;
        if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(ResultJson), Status) && Status) {
            Status->SetNumberField(TEXT("schemaVersion"), RequestedVersion);
            ResultJson.Reset();
            FJsonSerializer::Serialize(Status.ToSharedRef(), TJsonWriterFactory<>::Create(&ResultJson));
        }
    }
}

void UUEShedCameraLibrary::ClearProvisionedCameras(FString& ResultJson)
{
	UUEShedCameraSubsystem* Subsystem = FindCameraSubsystem();
	if (Subsystem == nullptr)
	{
		ResultJson = ErrorJson(TEXT("no-renderable-world"));
		return;
	}
	ClearAllProvisionedCameraSubsystems();
	ResultJson = Subsystem->StatusJson();
}
