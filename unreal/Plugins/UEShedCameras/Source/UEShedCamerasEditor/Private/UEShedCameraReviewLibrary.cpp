#include "UEShedCameraReviewLibrary.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "LevelEditorViewport.h"
#include "Selection.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/SceneCapture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "EngineUtils.h"
#include "HAL/FileManager.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/BufferArchive.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
FString JsonString(const TSharedRef<FJsonObject>& Object)
{
	FString Result;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Result);
	FJsonSerializer::Serialize(Object, Writer);
	return Result;
}

FString FailureJson(
	const FString& OperationId,
	const FString& ViewId,
	const TCHAR* Code,
	const TCHAR* Message,
	const TCHAR* Recovery,
	bool bRetrySafe)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-review-capture"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	Result->SetObjectField(TEXT("contract"), Contract);
	Result->SetStringField(TEXT("status"), TEXT("failed"));
	Result->SetStringField(TEXT("operationId"), OperationId);
	Result->SetStringField(TEXT("viewId"), ViewId);
	Result->SetStringField(TEXT("code"), Code);
	Result->SetStringField(TEXT("message"), Message);
	Result->SetStringField(TEXT("recovery"), Recovery);
	Result->SetBoolField(TEXT("retrySafe"), bRetrySafe);
	return JsonString(Result);
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

bool ReadVector(
	const TSharedPtr<FJsonObject>& Object,
	const TCHAR* Field,
	FVector& Result)
{
	const TSharedPtr<FJsonObject>* Vector;
	double X;
	double Y;
	double Z;
	if (!Object->TryGetObjectField(Field, Vector)
		|| !(*Vector)->TryGetNumberField(TEXT("x"), X)
		|| !(*Vector)->TryGetNumberField(TEXT("y"), Y)
		|| !(*Vector)->TryGetNumberField(TEXT("z"), Z))
	{
		return false;
	}
	Result = FVector(X, Y, Z);
	return !Result.ContainsNaN();
}

bool ReadRotation(
	const TSharedPtr<FJsonObject>& Object,
	const TCHAR* Field,
	FRotator& Result)
{
	const TSharedPtr<FJsonObject>* Rotation;
	double Pitch;
	double Yaw;
	double Roll;
	if (!Object->TryGetObjectField(Field, Rotation)
		|| !(*Rotation)->TryGetNumberField(TEXT("pitch"), Pitch)
		|| !(*Rotation)->TryGetNumberField(TEXT("yaw"), Yaw)
		|| !(*Rotation)->TryGetNumberField(TEXT("roll"), Roll))
	{
		return false;
	}
	Result = FRotator(Pitch, Yaw, Roll);
	return !Result.ContainsNaN();
}

AActor* FindActorByPath(UWorld* World, const FString& ActorPath)
{
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		if (It->GetPathName() == ActorPath) return *It;
	}
	return nullptr;
}
}

void UUEShedCameraReviewLibrary::InspectReviewSelection(FString& ResultJson)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-review-selection"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	Result->SetObjectField(TEXT("contract"), Contract);
	auto Fail = [&](const TCHAR* Code, const TCHAR* Message, const TCHAR* Recovery)
	{
		Result->SetStringField(TEXT("status"), TEXT("failed"));
		Result->SetStringField(TEXT("code"), Code);
		Result->SetStringField(TEXT("message"), Message);
		Result->SetStringField(TEXT("recovery"), Recovery);
		Result->SetBoolField(TEXT("retrySafe"), true);
		ResultJson = JsonString(Result);
	};

	if (GEditor == nullptr)
	{
		Fail(TEXT("editor_unavailable"), TEXT("The Unreal editor is unavailable."),
			TEXT("Run spatial authoring in an editor process."));
		return;
	}
	TArray<AActor*> SelectedActors;
	GEditor->GetSelectedActors()->GetSelectedObjects<AActor>(SelectedActors);
	if (SelectedActors.IsEmpty())
	{
		Fail(TEXT("no_selection"), TEXT("No actor is selected."),
			TEXT("Select exactly one actor in the Level Editor, then try again."));
		return;
	}
	if (SelectedActors.Num() != 1)
	{
		Fail(TEXT("multiple_selection"), TEXT("Spatial authoring requires one selected actor."),
			TEXT("Reduce the Level Editor selection to exactly one actor."));
		return;
	}
	AActor* Actor = SelectedActors[0];
	FVector Center;
	FVector Extent;
	Actor->GetActorBounds(false, Center, Extent, true);
	const FRotator ActorRotation = Actor->GetActorRotation();
	auto VectorJson = [](const FVector& Value)
	{
		const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
		Json->SetNumberField(TEXT("x"), Value.X);
		Json->SetNumberField(TEXT("y"), Value.Y);
		Json->SetNumberField(TEXT("z"), Value.Z);
		return Json;
	};
	auto RotationJson = [](const FRotator& Value)
	{
		const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
		Json->SetNumberField(TEXT("pitch"), Value.Pitch);
		Json->SetNumberField(TEXT("roll"), Value.Roll);
		Json->SetNumberField(TEXT("yaw"), Value.Yaw);
		return Json;
	};
	const TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
	Bounds->SetObjectField(TEXT("center"), VectorJson(Center));
	Bounds->SetObjectField(TEXT("extent"), VectorJson(Extent));
	Bounds->SetObjectField(TEXT("rotation"), RotationJson(ActorRotation));
	Result->SetStringField(TEXT("status"), TEXT("selected"));
	Result->SetStringField(TEXT("actorPath"), Actor->GetPathName());
	Result->SetStringField(TEXT("displayName"), Actor->GetActorNameOrLabel());
	Result->SetStringField(TEXT("mapPath"), Actor->GetWorld()->GetOutermost()->GetName());
	Result->SetObjectField(TEXT("bounds"), Bounds);
	if (GCurrentLevelEditingViewportClient != nullptr
		&& GCurrentLevelEditingViewportClient->IsPerspective())
	{
		const TSharedRef<FJsonObject> EditorView = MakeShared<FJsonObject>();
		EditorView->SetStringField(TEXT("aspectRatio"), TEXT("16:9"));
		EditorView->SetNumberField(
			TEXT("fieldOfViewDegrees"), GCurrentLevelEditingViewportClient->ViewFOV);
		EditorView->SetObjectField(
			TEXT("location"), VectorJson(GCurrentLevelEditingViewportClient->GetViewLocation()));
		EditorView->SetStringField(TEXT("projection"), TEXT("perspective"));
		EditorView->SetObjectField(
			TEXT("rotation"), RotationJson(GCurrentLevelEditingViewportClient->GetViewRotation()));
		Result->SetObjectField(TEXT("editorView"), EditorView);
	}
	ResultJson = JsonString(Result);
}

void UUEShedCameraReviewLibrary::CaptureReviewView(
	const FString& RequestJson,
	FString& ResultJson)
{
	FString OperationId;
	FString ViewId;
	auto Fail = [&](const TCHAR* Code, const TCHAR* Message, const TCHAR* Recovery, bool bRetrySafe)
	{
		ResultJson = FailureJson(
			OperationId, ViewId, Code, Message, Recovery, bRetrySafe);
	};

	if (RequestJson.Len() > 64 * 1024)
	{
		Fail(TEXT("request_too_large"), TEXT("Review capture request exceeds 64 KiB."),
			TEXT("Send one bounded Review View request."), false);
		return;
	}
	TSharedPtr<FJsonObject> Request;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Request) || !Request.IsValid())
	{
		Fail(TEXT("invalid_request"), TEXT("Review capture request is not valid JSON."),
			TEXT("Validate the request against contract version 1."), false);
		return;
	}
	const TSharedPtr<FJsonObject>* Contract;
	const TSharedPtr<FJsonObject>* Version;
	FString ContractName;
	double ContractMajor;
	if (!Request->TryGetObjectField(TEXT("contract"), Contract)
		|| !(*Contract)->TryGetStringField(TEXT("name"), ContractName)
		|| ContractName != TEXT("ue-shed-review-capture")
		|| !(*Contract)->TryGetObjectField(TEXT("version"), Version)
		|| !(*Version)->TryGetNumberField(TEXT("major"), ContractMajor)
		|| ContractMajor != 1)
	{
		Fail(TEXT("unsupported_contract"), TEXT("Review capture contract major 1 is required."),
			TEXT("Negotiate a supported UE Shed Cameras capability."), false);
		return;
	}
	Request->TryGetStringField(TEXT("operationId"), OperationId);
	Request->TryGetStringField(TEXT("viewId"), ViewId);
	FGuid OperationGuid;
	if (!FGuid::Parse(OperationId, OperationGuid) || !IsSafeIdentifier(ViewId))
	{
		Fail(TEXT("invalid_identity"), TEXT("operationId or viewId is invalid."),
			TEXT("Use a UUID operationId and a safe Review View identifier."), false);
		return;
	}

	if (GEditor == nullptr)
	{
		Fail(TEXT("editor_unavailable"), TEXT("The Unreal editor is unavailable."),
			TEXT("Run review capture in an editor process."), true);
		return;
	}
	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (World == nullptr)
	{
		Fail(TEXT("world_unavailable"), TEXT("No editor world is open."),
			TEXT("Open the expected map and retry."), true);
		return;
	}
	FString ExpectedMapPath;
	if (!Request->TryGetStringField(TEXT("expectedMapPath"), ExpectedMapPath)
		|| World->GetOutermost()->GetName() != ExpectedMapPath)
	{
		Fail(TEXT("map_mismatch"), TEXT("The open editor map does not match the Review Set."),
			TEXT("Open the expected map or choose a Review Set for this world."), true);
		return;
	}

	const TSharedPtr<FJsonObject>* Subject;
	FString SubjectKind;
	FString ActorPath;
	if (!Request->TryGetObjectField(TEXT("subject"), Subject)
		|| !(*Subject)->TryGetStringField(TEXT("kind"), SubjectKind)
		|| SubjectKind != TEXT("actor_path")
		|| !(*Subject)->TryGetStringField(TEXT("actorPath"), ActorPath))
	{
		Fail(TEXT("unsupported_subject"), TEXT("The Review View subject is unsupported."),
			TEXT("Use an actor_path subject for the durable-loop slice."), false);
		return;
	}
	AActor* SubjectActor = FindActorByPath(World, ActorPath);
	if (SubjectActor == nullptr)
	{
		Fail(TEXT("subject_not_found"), TEXT("The Review View subject was not found."),
			TEXT("Restore the actor or update the Review View subject."), true);
		return;
	}

	const TSharedPtr<FJsonObject>* Pose;
	FVector Location;
	FRotator Rotation;
	double FieldOfView;
	if (!Request->TryGetObjectField(TEXT("approvedPose"), Pose)
		|| !ReadVector(*Pose, TEXT("location"), Location)
		|| !ReadRotation(*Pose, TEXT("rotation"), Rotation)
		|| !(*Pose)->TryGetNumberField(TEXT("fieldOfViewDegrees"), FieldOfView)
		|| FieldOfView < 5.0 || FieldOfView > 170.0)
	{
		Fail(TEXT("invalid_pose"), TEXT("The approved camera pose is invalid."),
			TEXT("Validate the Review Set and approve a finite perspective pose."), false);
		return;
	}
	const TSharedPtr<FJsonObject>* Resolution;
	double WidthValue;
	double HeightValue;
	if (!Request->TryGetObjectField(TEXT("resolution"), Resolution)
		|| !(*Resolution)->TryGetNumberField(TEXT("width"), WidthValue)
		|| !(*Resolution)->TryGetNumberField(TEXT("height"), HeightValue))
	{
		Fail(TEXT("invalid_resolution"), TEXT("Capture resolution is missing."),
			TEXT("Use a supported bounded capture profile."), false);
		return;
	}
	const int32 Width = FMath::RoundToInt(WidthValue);
	const int32 Height = FMath::RoundToInt(HeightValue);
	if (Width < 160 || Width > 3840 || Height < 90 || Height > 2160
		|| WidthValue != Width || HeightValue != Height)
	{
		Fail(TEXT("invalid_resolution"), TEXT("Capture resolution is outside supported limits."),
			TEXT("Use integer dimensions from 160x90 through 3840x2160."), false);
		return;
	}

	UPackage* MapPackage = World->GetOutermost();
	const bool bDirtyBefore = MapPackage->IsDirty();
	const double StartedSeconds = FPlatformTime::Seconds();
	FActorSpawnParameters SpawnParameters;
	SpawnParameters.Name = MakeUniqueObjectName(
		World->PersistentLevel, ASceneCapture2D::StaticClass(), TEXT("UEShedReviewCapture"));
	SpawnParameters.ObjectFlags = RF_Transient;
	SpawnParameters.OverrideLevel = World->PersistentLevel;
	SpawnParameters.SpawnCollisionHandlingOverride =
		ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	SpawnParameters.bTemporaryEditorActor = true;
	SpawnParameters.bHideFromSceneOutliner = true;
	SpawnParameters.bCreateActorPackage = false;
	ASceneCapture2D* CaptureActor = World->SpawnActor<ASceneCapture2D>(
		Location, Rotation, SpawnParameters);
	if (CaptureActor == nullptr)
	{
		Fail(TEXT("realization_failed"), TEXT("Unreal could not create a transient capture source."),
			TEXT("Check the editor world and retry."), true);
		return;
	}

	UTextureRenderTarget2D* RenderTarget = NewObject<UTextureRenderTarget2D>(
		CaptureActor, NAME_None, RF_Transient);
	RenderTarget->RenderTargetFormat = RTF_RGBA8_SRGB;
	RenderTarget->ClearColor = FLinearColor::Black;
	RenderTarget->InitAutoFormat(Width, Height);
	RenderTarget->UpdateResourceImmediate(true);
	USceneCaptureComponent2D* CaptureComponent = CaptureActor->GetCaptureComponent2D();
	CaptureComponent->bCaptureEveryFrame = false;
	CaptureComponent->bCaptureOnMovement = false;
	CaptureComponent->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
	CaptureComponent->FOVAngle = FieldOfView;
	CaptureComponent->TextureTarget = RenderTarget;
	CaptureComponent->CaptureScene();

	FBufferArchive PngBytes;
	const bool bExported = FImageUtils::ExportRenderTarget2DAsPNG(RenderTarget, PngBytes);
	const FString CaptureDirectory = FPaths::Combine(
		FPaths::ProjectSavedDir(), TEXT("UEShed"), TEXT("ReviewStaging"), OperationId, ViewId);
	const FString CapturePath = FPaths::Combine(CaptureDirectory, TEXT("pure.png"));
	IFileManager::Get().MakeDirectory(*CaptureDirectory, true);
	const bool bWritten = bExported && FFileHelper::SaveArrayToFile(PngBytes, *CapturePath);
	CaptureComponent->TextureTarget = nullptr;
	World->DestroyActor(CaptureActor, false, false);
	const bool bDirtyAfter = MapPackage->IsDirty();

	if (!bExported || !bWritten)
	{
		Fail(TEXT("capture_write_failed"), TEXT("Unreal could not write the staged PNG."),
			TEXT("Check the project Saved directory and retry."), true);
		return;
	}

	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> ResultContract = MakeShared<FJsonObject>();
	ResultContract->SetStringField(TEXT("name"), TEXT("ue-shed-review-capture"));
	const TSharedRef<FJsonObject> ResultVersion = MakeShared<FJsonObject>();
	ResultVersion->SetNumberField(TEXT("major"), 1);
	ResultVersion->SetNumberField(TEXT("minor"), 0);
	ResultContract->SetObjectField(TEXT("version"), ResultVersion);
	Result->SetObjectField(TEXT("contract"), ResultContract);
	Result->SetStringField(TEXT("status"), TEXT("captured"));
	Result->SetStringField(TEXT("operationId"), OperationId);
	Result->SetStringField(TEXT("viewId"), ViewId);
	Result->SetStringField(TEXT("actorPath"), SubjectActor->GetPathName());
	Result->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
	Result->SetStringField(TEXT("stagingPath"), FPaths::ConvertRelativePathToFull(CapturePath));
	Result->SetNumberField(TEXT("width"), Width);
	Result->SetNumberField(TEXT("height"), Height);
	Result->SetNumberField(
		TEXT("captureDurationMs"), (FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
	Result->SetBoolField(TEXT("mapPackageDirtyBefore"), bDirtyBefore);
	Result->SetBoolField(TEXT("mapPackageDirtyAfter"), bDirtyAfter);
	ResultJson = JsonString(Result);
}
