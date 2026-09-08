#include "UEShedCameraReviewLibrary.h"
#include "UEShedCameraRenderSession.h"
#include "UEShedTransientCapture.h"

#include "Camera/CameraTypes.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/Level.h"
#include "Engine/SceneCapture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "HAL/FileManager.h"
#include "ImageUtils.h"
#include "Kismet/GameplayStatics.h"
#include "LevelEditorViewport.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Selection.h"
#include "Serialization/BufferArchive.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
FString JsonString(const TSharedRef<FJsonObject> &Object)
{
	FString Result;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Result);
	FJsonSerializer::Serialize(Object, Writer);
	return Result;
}

FString FailureJson(const FString &OperationId, const FString &ViewId, int32 ContractMinor, const TCHAR *Code,
					const TCHAR *Message, const TCHAR *Recovery, bool bRetrySafe)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-review-capture"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), ContractMinor);
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

bool HasOnlyFields(const TSharedPtr<FJsonObject> &Object, const TArray<FString> &AllowedFields)
{
	if (!Object.IsValid())
		return false;
	for (const TPair<FString, TSharedPtr<FJsonValue>> &Field : Object->Values)
	{
		if (!AllowedFields.Contains(Field.Key))
			return false;
	}
	return true;
}

bool IsSafeIdentifier(const FString &Value)
{
	if (Value.IsEmpty() || Value.Len() > 128 || !FChar::IsAlnum(Value[0]))
		return false;
	for (const TCHAR Character : Value)
	{
		if (!FChar::IsAlnum(Character) && Character != TEXT('-') && Character != TEXT('_') &&
			Character != TEXT('.'))
		{
			return false;
		}
	}
	return true;
}

bool IsReviewActorPath(const FString &Value)
{
	return Value.Len() >= 7 && Value.Len() <= 4096 && Value.StartsWith(TEXT("/Game/"));
}

bool ReadOptionalNonEmptyString(const TSharedPtr<FJsonObject> &Object, const TCHAR *Field, FString &Result)
{
	if (!Object->HasField(Field))
		return true;
	return Object->TryGetStringField(Field, Result) && !Result.IsEmpty();
}

bool ReadVector(const TSharedPtr<FJsonObject> &Object, const TCHAR *Field, FVector &Result)
{
	const TSharedPtr<FJsonObject> *Vector = nullptr;
	double X = 0;
	double Y = 0;
	double Z = 0;
	if (!Object->TryGetObjectField(Field, Vector) ||
		!HasOnlyFields(*Vector, {TEXT("x"), TEXT("y"), TEXT("z")}) ||
		!(*Vector)->TryGetNumberField(TEXT("x"), X) || !(*Vector)->TryGetNumberField(TEXT("y"), Y) ||
		!(*Vector)->TryGetNumberField(TEXT("z"), Z))
	{
		return false;
	}
	Result = FVector(X, Y, Z);
	return !Result.ContainsNaN();
}

bool ReadRotation(const TSharedPtr<FJsonObject> &Object, const TCHAR *Field, FRotator &Result)
{
	const TSharedPtr<FJsonObject> *Rotation = nullptr;
	double Pitch = 0;
	double Yaw = 0;
	double Roll = 0;
	if (!Object->TryGetObjectField(Field, Rotation) ||
		!HasOnlyFields(*Rotation, {TEXT("pitch"), TEXT("yaw"), TEXT("roll")}) ||
		!(*Rotation)->TryGetNumberField(TEXT("pitch"), Pitch) ||
		!(*Rotation)->TryGetNumberField(TEXT("yaw"), Yaw) ||
		!(*Rotation)->TryGetNumberField(TEXT("roll"), Roll))
	{
		return false;
	}
	Result = FRotator(Pitch, Yaw, Roll);
	return !Result.ContainsNaN();
}

bool ReadBounds(const TSharedPtr<FJsonObject> &Object, FVector &Center, FVector &Extent, FRotator &Rotation)
{
	return HasOnlyFields(Object, {TEXT("center"), TEXT("extent"), TEXT("rotation")}) &&
		   ReadVector(Object, TEXT("center"), Center) && ReadVector(Object, TEXT("extent"), Extent) &&
		   ReadRotation(Object, TEXT("rotation"), Rotation) && Extent.X >= 0.0 && Extent.Y >= 0.0 &&
		   Extent.Z >= 0.0;
}

bool ReadPose(const TSharedPtr<FJsonObject> &Pose, FVector &Location, FRotator &Rotation, double &FieldOfView)
{
	FString AspectRatio;
	FString Projection;
	return HasOnlyFields(Pose, {TEXT("aspectRatio"), TEXT("fieldOfViewDegrees"), TEXT("location"),
								TEXT("projection"), TEXT("rotation")}) &&
		   Pose->TryGetStringField(TEXT("aspectRatio"), AspectRatio) && AspectRatio == TEXT("16:9") &&
		   Pose->TryGetStringField(TEXT("projection"), Projection) && Projection == TEXT("perspective") &&
		   ReadVector(Pose, TEXT("location"), Location) && ReadRotation(Pose, TEXT("rotation"), Rotation) &&
		   Pose->TryGetNumberField(TEXT("fieldOfViewDegrees"), FieldOfView) && FMath::IsFinite(FieldOfView) &&
		   FieldOfView >= 5.0 && FieldOfView <= 170.0;
}

AActor *FindActorByPath(UWorld *World, const FString &ActorPath)
{
	if (World == nullptr)
		return nullptr;
	for (ULevel *Level : World->GetLevels())
	{
		if (Level == nullptr)
			continue;
		for (AActor *Actor : Level->Actors)
		{
			if (Actor != nullptr && Actor->GetPathName() == ActorPath)
				return Actor;
		}
	}
	return nullptr;
}

FString ActorGuidString(const AActor *Actor)
{
	return Actor == nullptr || !Actor->GetActorGuid().IsValid()
			   ? FString()
			   : Actor->GetActorGuid().ToString(EGuidFormats::UniqueObjectGuid).ToLower();
}

AActor *FindActorByGuid(UWorld *World, const FString &ActorGuid)
{
	FGuid RequestedGuid;
	if (World == nullptr || !FGuid::ParseExact(ActorGuid, EGuidFormats::UniqueObjectGuid, RequestedGuid) ||
		!RequestedGuid.IsValid())
	{
		return nullptr;
	}
	for (ULevel *Level : World->GetLevels())
	{
		if (Level == nullptr)
			continue;
		for (AActor *Actor : Level->Actors)
		{
			if (Actor != nullptr && Actor->GetActorGuid() == RequestedGuid)
				return Actor;
		}
	}
	return nullptr;
}

TSharedRef<FJsonObject> VectorJson(const FVector &Value)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetNumberField(TEXT("x"), Value.X);
	Json->SetNumberField(TEXT("y"), Value.Y);
	Json->SetNumberField(TEXT("z"), Value.Z);
	return Json;
}

TSharedRef<FJsonObject> RotationJson(const FRotator &Value)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetNumberField(TEXT("pitch"), Value.Pitch);
	Json->SetNumberField(TEXT("roll"), Value.Roll);
	Json->SetNumberField(TEXT("yaw"), Value.Yaw);
	return Json;
}

TSharedRef<FJsonObject> BoundsJson(const FVector &Center, const FVector &Extent, const FRotator &Rotation)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetObjectField(TEXT("center"), VectorJson(Center));
	Json->SetObjectField(TEXT("extent"), VectorJson(Extent));
	Json->SetObjectField(TEXT("rotation"), RotationJson(Rotation));
	return Json;
}

TSharedRef<FJsonObject> PoseJson(const FVector &Location, const FRotator &Rotation, double FieldOfView)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("aspectRatio"), TEXT("16:9"));
	Json->SetNumberField(TEXT("fieldOfViewDegrees"), FieldOfView);
	Json->SetObjectField(TEXT("location"), VectorJson(Location));
	Json->SetStringField(TEXT("projection"), TEXT("perspective"));
	Json->SetObjectField(TEXT("rotation"), RotationJson(Rotation));
	return Json;
}

void AddSelectionResult(const TSharedRef<FJsonObject> &Result, AActor *Actor, bool bIncludeEditorView)
{
	FVector Center;
	FVector Extent;
	Actor->GetActorBounds(false, Center, Extent, true);
	const TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
	Bounds->SetObjectField(TEXT("center"), VectorJson(Center));
	Bounds->SetObjectField(TEXT("extent"), VectorJson(Extent));
	Bounds->SetObjectField(TEXT("rotation"), RotationJson(Actor->GetActorRotation()));
	Result->SetStringField(TEXT("status"), TEXT("selected"));
	Result->SetStringField(TEXT("actorPath"), Actor->GetPathName());
	const FString ActorGuid = ActorGuidString(Actor);
	if (!ActorGuid.IsEmpty())
		Result->SetStringField(TEXT("actorGuid"), ActorGuid);
	Result->SetStringField(TEXT("displayName"), Actor->GetActorNameOrLabel());
	Result->SetStringField(TEXT("mapPath"), Actor->GetWorld()->GetOutermost()->GetName());
	Result->SetObjectField(TEXT("bounds"), Bounds);
	if (bIncludeEditorView && GCurrentLevelEditingViewportClient != nullptr &&
		GCurrentLevelEditingViewportClient->IsPerspective())
	{
		const TSharedRef<FJsonObject> EditorView = MakeShared<FJsonObject>();
		EditorView->SetStringField(TEXT("aspectRatio"), TEXT("16:9"));
		EditorView->SetNumberField(TEXT("fieldOfViewDegrees"), GCurrentLevelEditingViewportClient->ViewFOV);
		EditorView->SetObjectField(TEXT("location"),
								   VectorJson(GCurrentLevelEditingViewportClient->GetViewLocation()));
		EditorView->SetStringField(TEXT("projection"), TEXT("perspective"));
		EditorView->SetObjectField(TEXT("rotation"),
								   RotationJson(GCurrentLevelEditingViewportClient->GetViewRotation()));
		Result->SetObjectField(TEXT("editorView"), EditorView);
	}
}

TSharedRef<FJsonObject> ProjectSubjectBounds(const FVector &Center, const FVector &Extent,
											 const FRotator &BoundsRotation,
											 const FMinimalViewInfo &CaptureView)
{
	FMatrix ViewMatrix;
	FMatrix ProjectionMatrix;
	FMatrix ViewProjectionMatrix;
	UGameplayStatics::GetViewProjectionMatrix(CaptureView, ViewMatrix, ProjectionMatrix,
											  ViewProjectionMatrix);
	const float NearPlane = CaptureView.GetFinalPerspectiveNearClipPlane();
	TArray<FVector> Corners;
	Corners.Reserve(8);
	for (const double X : {-1.0, 1.0})
	{
		for (const double Y : {-1.0, 1.0})
		{
			for (const double Z : {-1.0, 1.0})
			{
				Corners.Add(Center +
							BoundsRotation.RotateVector(FVector(X * Extent.X, Y * Extent.Y, Z * Extent.Z)));
			}
		}
	}
	bool bBehindCamera = false;
	bool bNearPlaneCrossing = false;
	float MinimumX = TNumericLimits<float>::Max();
	float MinimumY = TNumericLimits<float>::Max();
	float MaximumX = TNumericLimits<float>::Lowest();
	float MaximumY = TNumericLimits<float>::Lowest();
	for (const FVector &Corner : Corners)
	{
		const FPlane Clip = ViewProjectionMatrix.TransformFVector4(FVector4(Corner, 1.0));
		if (!FMath::IsFinite(Clip.X) || !FMath::IsFinite(Clip.Y) || !FMath::IsFinite(Clip.W))
		{
			bBehindCamera = true;
			break;
		}
		if (Clip.W <= 0.0f)
		{
			bBehindCamera = true;
			continue;
		}
		if (Clip.W <= NearPlane)
		{
			bNearPlaneCrossing = true;
			continue;
		}
		const float NormalizedX = Clip.X / Clip.W * 0.5f + 0.5f;
		const float NormalizedY = 0.5f - Clip.Y / Clip.W * 0.5f;
		if (!FMath::IsFinite(NormalizedX) || !FMath::IsFinite(NormalizedY))
		{
			bBehindCamera = true;
			break;
		}
		MinimumX = FMath::Min(MinimumX, NormalizedX);
		MinimumY = FMath::Min(MinimumY, NormalizedY);
		MaximumX = FMath::Max(MaximumX, NormalizedX);
		MaximumY = FMath::Max(MaximumY, NormalizedY);
	}

	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	if (bBehindCamera || bNearPlaneCrossing)
	{
		Result->SetStringField(TEXT("status"), TEXT("unprojectable"));
		Result->SetStringField(TEXT("code"),
							   bBehindCamera ? TEXT("behind_camera") : TEXT("near_plane_crossing"));
		Result->SetStringField(
			TEXT("message"),
			bBehindCamera
				? TEXT("At least one subject-bounds corner is behind the transient capture camera.")
				: TEXT("At least one subject-bounds corner crosses the transient capture near plane."));
		return Result;
	}

	const bool bFullyOutside = MaximumX < 0.0f || MinimumX > 1.0f || MaximumY < 0.0f || MinimumY > 1.0f;
	const bool bFullyWithin = MinimumX >= 0.0f && MaximumX <= 1.0f && MinimumY >= 0.0f && MaximumY <= 1.0f;
	const TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
	Bounds->SetNumberField(TEXT("minX"), MinimumX);
	Bounds->SetNumberField(TEXT("minY"), MinimumY);
	Bounds->SetNumberField(TEXT("maxX"), MaximumX);
	Bounds->SetNumberField(TEXT("maxY"), MaximumY);
	const TSharedRef<FJsonObject> Margins = MakeShared<FJsonObject>();
	Margins->SetNumberField(TEXT("left"), MinimumX);
	Margins->SetNumberField(TEXT("right"), 1.0f - MaximumX);
	Margins->SetNumberField(TEXT("top"), MinimumY);
	Margins->SetNumberField(TEXT("bottom"), 1.0f - MaximumY);
	Result->SetStringField(TEXT("status"), TEXT("projected"));
	Result->SetStringField(TEXT("viewportStatus"), bFullyWithin	   ? TEXT("fully_within_viewport")
												   : bFullyOutside ? TEXT("fully_outside_viewport")
																   : TEXT("partially_outside_viewport"));
	Result->SetObjectField(TEXT("normalizedBounds"), Bounds);
	Result->SetObjectField(TEXT("margins"), Margins);
	return Result;
}

TSharedRef<FJsonObject> AssessVisibility(
	UWorld *World, AActor *SubjectActor, const FVector &CameraLocation, const FVector &Center,
	const FVector &Extent, const FRotator &BoundsRotation, const FString &Method, const FString &SamplePreset,
	const TSharedRef<FJsonObject> &Projection, bool bIncludeClassification,
	USceneCaptureComponent2D *CaptureComponent, int32 CaptureWidth, int32 CaptureHeight)
{
	const double StartedSeconds = FPlatformTime::Seconds();
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	if (SubjectActor == nullptr)
	{
		Result->SetStringField(TEXT("status"), TEXT("not_assessed"));
		Result->SetStringField(TEXT("reason"),
							   TEXT("Oriented-area visibility needs a render-truthful region method."));
		Result->SetArrayField(
			TEXT("limitations"),
			{MakeShared<FJsonValueString>(
				TEXT("Area contents are review subject matter and are not treated as blockers."))});
		return Result;
	}
	FString ProjectionStatus;
	FString ViewportStatus;
	Projection->TryGetStringField(TEXT("status"), ProjectionStatus);
	Projection->TryGetStringField(TEXT("viewportStatus"), ViewportStatus);
	if (!bIncludeClassification &&
		(ProjectionStatus == TEXT("unprojectable") || ViewportStatus == TEXT("fully_outside_viewport")))
	{
		Result->SetStringField(TEXT("status"), TEXT("not_assessed"));
		Result->SetStringField(TEXT("reason"),
							   TEXT("The subject is outside the effective capture projection, so visibility "
									"has no valid image-space denominator."));
		Result->SetArrayField(
			TEXT("limitations"),
			{MakeShared<FJsonValueString>(TEXT(
				"Inspect subjectProjection for behind-camera, near-plane, or viewport-clipping evidence."))});
		return Result;
	}
	if (!bIncludeClassification && (Method == TEXT("automatic") || Method == TEXT("depth_compare")))
	{
		const int32 Width = FMath::Max(
			1, FMath::RoundToInt(CaptureWidth *
								 FMath::Min(1.0, FMath::Min(320.0 / CaptureWidth, 180.0 / CaptureHeight))));
		const int32 Height = FMath::Max(
			1, FMath::RoundToInt(CaptureHeight *
								 FMath::Min(1.0, FMath::Min(320.0 / CaptureWidth, 180.0 / CaptureHeight))));
		UTextureRenderTarget2D *SceneDepthTarget =
			NewObject<UTextureRenderTarget2D>(CaptureComponent, NAME_None, RF_Transient);
		UTextureRenderTarget2D *SubjectDepthTarget =
			NewObject<UTextureRenderTarget2D>(CaptureComponent, NAME_None, RF_Transient);
		for (UTextureRenderTarget2D *Target : {SceneDepthTarget, SubjectDepthTarget})
		{
			Target->RenderTargetFormat = RTF_RGBA32f;
			Target->ClearColor = FLinearColor::Black;
			Target->InitAutoFormat(Width, Height);
			Target->UpdateResourceImmediate(true);
		}

		UTextureRenderTarget2D *PreviousTarget = CaptureComponent->TextureTarget;
		const ESceneCaptureSource PreviousSource = CaptureComponent->CaptureSource;
		const ESceneCapturePrimitiveRenderMode PreviousPrimitiveMode = CaptureComponent->PrimitiveRenderMode;
		const bool PreviousPersistRenderingState = CaptureComponent->bAlwaysPersistRenderingState;
		// Depth passes change primitive visibility; color-pass occlusion history is not reusable.
		CaptureComponent->bAlwaysPersistRenderingState = false;
		ON_SCOPE_EXIT
		{
			CaptureComponent->bAlwaysPersistRenderingState = PreviousPersistRenderingState;
			CaptureComponent->bCameraCutThisFrame = true;
			CaptureComponent->ClearShowOnlyComponents();
			CaptureComponent->PrimitiveRenderMode = PreviousPrimitiveMode;
			CaptureComponent->CaptureSource = PreviousSource;
			CaptureComponent->TextureTarget = PreviousTarget;
		};

		CaptureComponent->CaptureSource = ESceneCaptureSource::SCS_SceneDepth;
		CaptureComponent->PrimitiveRenderMode = ESceneCapturePrimitiveRenderMode::PRM_RenderScenePrimitives;
		CaptureComponent->TextureTarget = SceneDepthTarget;
		CaptureComponent->CaptureScene();
		TArray<FLinearColor> SceneDepth;
		const bool bReadScene =
			SceneDepthTarget->GameThread_GetRenderTargetResource()->ReadLinearColorPixels(SceneDepth);

		CaptureComponent->ClearShowOnlyComponents();
		CaptureComponent->PrimitiveRenderMode = ESceneCapturePrimitiveRenderMode::PRM_UseShowOnlyList;
		CaptureComponent->ShowOnlyActorComponents(SubjectActor, true);
		CaptureComponent->TextureTarget = SubjectDepthTarget;
		CaptureComponent->CaptureScene();
		TArray<FLinearColor> SubjectDepth;
		const bool bReadSubject =
			SubjectDepthTarget->GameThread_GetRenderTargetResource()->ReadLinearColorPixels(SubjectDepth);

		if (!bReadScene || !bReadSubject || SceneDepth.Num() != Width * Height ||
			SubjectDepth.Num() != Width * Height)
		{
			Result->SetStringField(TEXT("status"), TEXT("assessment_failed"));
			const TSharedRef<FJsonObject> Failure = MakeShared<FJsonObject>();
			Failure->SetStringField(TEXT("code"), TEXT("visibility_readback_failed"));
			Failure->SetStringField(TEXT("message"),
									TEXT("Unreal could not read the bounded depth captures."));
			Failure->SetStringField(TEXT("recovery"), TEXT("Retry or request diagnostic ray sampling."));
			Failure->SetBoolField(TEXT("retrySafe"), true);
			Result->SetObjectField(TEXT("failure"), Failure);
			return Result;
		}

		int32 SubjectPixels = 0;
		int32 VisiblePixels = 0;
		constexpr float DepthTolerance = 1.0f;
		const float MaximumSubjectDepth =
			FVector::Distance(CameraLocation, Center) + Extent.Size() + DepthTolerance;
		for (int32 Index = 0; Index < SubjectDepth.Num(); ++Index)
		{
			const float SubjectValue = SubjectDepth[Index].R;
			if (!FMath::IsFinite(SubjectValue) || SubjectValue <= 0.0f || SubjectValue > MaximumSubjectDepth)
			{
				continue;
			}
			++SubjectPixels;
			const float SceneValue = SceneDepth[Index].R;
			if (FMath::IsFinite(SceneValue) && SceneValue > 0.0f &&
				SubjectValue <= SceneValue + DepthTolerance)
			{
				++VisiblePixels;
			}
		}
		if (SubjectPixels == 0)
		{
			Result->SetStringField(TEXT("status"), TEXT("assessment_failed"));
			const TSharedRef<FJsonObject> Failure = MakeShared<FJsonObject>();
			Failure->SetStringField(TEXT("code"), TEXT("subject_depth_unavailable"));
			Failure->SetStringField(
				TEXT("message"),
				TEXT("The subject produced no depth pixels at the bounded assessment resolution."));
			Failure->SetStringField(
				TEXT("recovery"),
				TEXT("Use diagnostic ray sampling for translucent or non-depth-writing subjects."));
			Failure->SetBoolField(TEXT("retrySafe"), false);
			Result->SetObjectField(TEXT("failure"), Failure);
			return Result;
		}

		Result->SetStringField(TEXT("status"), TEXT("assessed"));
		const TSharedRef<FJsonObject> EffectiveMethod = MakeShared<FJsonObject>();
		EffectiveMethod->SetStringField(TEXT("method"), TEXT("depth_compare"));
		EffectiveMethod->SetNumberField(TEXT("version"), 1);
		Result->SetObjectField(TEXT("method"), EffectiveMethod);
		Result->SetNumberField(TEXT("visibleFraction"), static_cast<double>(VisiblePixels) / SubjectPixels);
		Result->SetNumberField(TEXT("sampleCount"), SubjectPixels);
		Result->SetNumberField(TEXT("assessmentDurationMs"),
							   (FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
		Result->SetArrayField(
			TEXT("limitations"),
			{MakeShared<FJsonValueString>(
				 TEXT("Depth comparison covers rendered depth-writing subject pixels; translucent or "
					  "non-depth-writing material coverage is unsupported.")),
			 MakeShared<FJsonValueString>(
				 TEXT("Assessment is bounded to at most 320x180 pixels, masks empty depth outside the "
					  "resolved subject bounds, and uses a 1 cm depth tolerance."))});
		Result->SetArrayField(TEXT("occluders"), {});
		return Result;
	}
	if (Method == TEXT("subject_mask") || Method == TEXT("depth_compare"))
	{
		Result->SetStringField(TEXT("status"), TEXT("assessment_failed"));
		const TSharedRef<FJsonObject> Failure = MakeShared<FJsonObject>();
		Failure->SetStringField(TEXT("code"), TEXT("visibility_method_unavailable"));
		Failure->SetStringField(TEXT("message"),
								TEXT("The requested render-truthful visibility method is unavailable."));
		Failure->SetStringField(
			TEXT("recovery"), TEXT("Use automatic or ray_samples until the negotiated method is available."));
		Failure->SetBoolField(TEXT("retrySafe"), false);
		Result->SetObjectField(TEXT("failure"), Failure);
		return Result;
	}

	if (ProjectionStatus == TEXT("unprojectable") || ViewportStatus == TEXT("fully_outside_viewport"))
	{
		Result->SetStringField(TEXT("status"), TEXT("assessed"));
		if (bIncludeClassification)
		{
			Result->SetStringField(TEXT("classification"), TEXT("not_visible"));
		}
		const TSharedRef<FJsonObject> EffectiveMethod = MakeShared<FJsonObject>();
		EffectiveMethod->SetStringField(TEXT("method"), TEXT("ray_samples"));
		EffectiveMethod->SetNumberField(TEXT("version"), 1);
		Result->SetObjectField(TEXT("method"), EffectiveMethod);
		Result->SetNumberField(TEXT("visibleFraction"), 0.0);
		Result->SetNumberField(TEXT("sampleCount"), 0);
		Result->SetNumberField(TEXT("assessmentDurationMs"),
							   (FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
		Result->SetArrayField(
			TEXT("limitations"),
			{MakeShared<FJsonValueString>(
				TEXT("Collision rays are diagnostic and may differ from rendered visibility."))});
		Result->SetArrayField(TEXT("occluders"), {});
		return Result;
	}

	const int32 AxisSamples = SamplePreset == TEXT("dense") ? 3 : 2;
	TArray<FVector> Points;
	Points.Add(Center);
	for (int32 X = 0; X < AxisSamples; ++X)
	{
		for (int32 Y = 0; Y < AxisSamples; ++Y)
		{
			for (int32 Z = 0; Z < AxisSamples; ++Z)
			{
				if (SamplePreset == TEXT("sparse") && Points.Num() >= 5)
					break;
				const FVector Local(AxisSamples == 2 ? (X == 0 ? -Extent.X : Extent.X) : (X - 1) * Extent.X,
									AxisSamples == 2 ? (Y == 0 ? -Extent.Y : Extent.Y) : (Y - 1) * Extent.Y,
									AxisSamples == 2 ? (Z == 0 ? -Extent.Z : Extent.Z) : (Z - 1) * Extent.Z);
				Points.Add(Center + BoundsRotation.RotateVector(Local));
			}
		}
	}

	int32 VisibleSamples = 0;
	TMap<FString, int32> OccluderCounts;
	FCollisionQueryParams QueryParams(SCENE_QUERY_STAT(UEShedReviewVisibility), true);
	for (const FVector &Point : Points)
	{
		FHitResult Hit;
		const bool bHit =
			World->LineTraceSingleByChannel(Hit, CameraLocation, Point, ECC_Visibility, QueryParams);
		AActor *HitActor = bHit ? Hit.GetActor() : nullptr;
		if (!bHit || HitActor == SubjectActor ||
			(HitActor != nullptr && HitActor->IsAttachedTo(SubjectActor)))
		{
			++VisibleSamples;
		}
		else if (HitActor != nullptr && OccluderCounts.Num() < 32)
		{
			OccluderCounts.FindOrAdd(HitActor->GetPathName()) += 1;
		}
	}

	const double VisibleFraction =
		Points.IsEmpty() ? 0.0 : static_cast<double>(VisibleSamples) / Points.Num();
	Result->SetStringField(TEXT("status"), TEXT("assessed"));
	if (bIncludeClassification)
	{
		Result->SetStringField(TEXT("classification"), VisibleFraction >= 0.95	 ? TEXT("clear")
													   : VisibleFraction <= 0.05 ? TEXT("blocked")
																				 : TEXT("partial"));
	}
	const TSharedRef<FJsonObject> EffectiveMethod = MakeShared<FJsonObject>();
	EffectiveMethod->SetStringField(TEXT("method"), TEXT("ray_samples"));
	EffectiveMethod->SetNumberField(TEXT("version"), 1);
	Result->SetObjectField(TEXT("method"), EffectiveMethod);
	Result->SetNumberField(TEXT("visibleFraction"), VisibleFraction);
	Result->SetNumberField(TEXT("sampleCount"), Points.Num());
	Result->SetNumberField(TEXT("assessmentDurationMs"),
						   (FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
	Result->SetArrayField(
		TEXT("limitations"),
		{MakeShared<FJsonValueString>(TEXT("Collision rays are diagnostic and may differ from rendered "
										   "visibility, especially for translucent materials."))});
	TArray<TSharedPtr<FJsonValue>> Occluders;
	for (const TPair<FString, int32> &Entry : OccluderCounts)
	{
		const TSharedRef<FJsonObject> Evidence = MakeShared<FJsonObject>();
		Evidence->SetNumberField(TEXT("confidence"), static_cast<double>(Entry.Value) / Points.Num());
		const TSharedRef<FJsonObject> Locator = MakeShared<FJsonObject>();
		Locator->SetStringField(TEXT("kind"), TEXT("actor_path"));
		Locator->SetStringField(TEXT("actorPath"), Entry.Key);
		Evidence->SetObjectField(TEXT("locator"), Locator);
		Evidence->SetStringField(TEXT("reason"),
								 TEXT("The actor blocked one or more bounded visibility rays."));
		Occluders.Add(MakeShared<FJsonValueObject>(Evidence));
	}
	Result->SetArrayField(TEXT("occluders"), Occluders);
	return Result;
}
} // namespace

void UUEShedCameraReviewLibrary::InspectReviewSelection(FString &ResultJson)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-review-selection"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 1);
	Contract->SetObjectField(TEXT("version"), Version);
	Result->SetObjectField(TEXT("contract"), Contract);
	auto Fail = [&](const TCHAR *Code, const TCHAR *Message, const TCHAR *Recovery) {
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
	TArray<AActor *> SelectedActors;
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
	AActor *Actor = SelectedActors[0];
	AddSelectionResult(Result, Actor, true);
	ResultJson = JsonString(Result);
}

void UUEShedCameraReviewLibrary::InspectReviewSubject(const FString &ActorPath, FString &ResultJson)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-review-selection"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 1);
	Contract->SetObjectField(TEXT("version"), Version);
	Result->SetObjectField(TEXT("contract"), Contract);
	auto Fail = [&](const TCHAR *Code, const TCHAR *Message, const TCHAR *Recovery) {
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
	UWorld *World = GEditor->GetEditorWorldContext().World();
	if (World == nullptr)
	{
		Fail(TEXT("map_mismatch"), TEXT("No editor world is open."),
			 TEXT("Open the expected Review Set map and resume again."));
		return;
	}
	AActor *Actor = FindActorByPath(World, ActorPath);
	if (Actor == nullptr)
	{
		Fail(TEXT("subject_not_found"), TEXT("The persisted review subject was not found."),
			 TEXT("Restore the subject or discard this authoring session."));
		return;
	}
	AddSelectionResult(Result, Actor, false);
	ResultJson = JsonString(Result);
}

void UUEShedCameraReviewLibrary::InspectReviewSubjectByGuid(const FString &ActorGuid, FString &ResultJson)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-review-selection"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 1);
	Contract->SetObjectField(TEXT("version"), Version);
	Result->SetObjectField(TEXT("contract"), Contract);
	auto Fail = [&](const TCHAR *Code, const TCHAR *Message, const TCHAR *Recovery) {
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
	UWorld *World = GEditor->GetEditorWorldContext().World();
	if (World == nullptr)
	{
		Fail(TEXT("map_mismatch"), TEXT("No editor world is open."),
			 TEXT("Open the expected Review Set map and resume again."));
		return;
	}
	AActor *Actor = FindActorByGuid(World, ActorGuid);
	if (Actor == nullptr)
	{
		Fail(TEXT("subject_not_found"), TEXT("The persisted review subject was not found."),
			 TEXT("Restore the authored actor or discard this authoring session."));
		return;
	}
	AddSelectionResult(Result, Actor, false);
	ResultJson = JsonString(Result);
}

void UUEShedCameraReviewLibrary::GetReviewAssessmentCapabilities(FString &ResultJson)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-review-assessment-capabilities"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	Result->SetObjectField(TEXT("contract"), Contract);

	const TSharedRef<FJsonObject> MaximumResolution = MakeShared<FJsonObject>();
	MaximumResolution->SetNumberField(TEXT("width"), 320);
	MaximumResolution->SetNumberField(TEXT("height"), 180);
	Result->SetObjectField(TEXT("depthCompareMaximumResolution"), MaximumResolution);

	TArray<TSharedPtr<FJsonValue>> Methods;
	auto AddSupported = [&Methods](const TCHAR *RequestedMethod, const TCHAR *EffectiveMethod,
								   const TCHAR *Limitation) {
		const TSharedRef<FJsonObject> Method = MakeShared<FJsonObject>();
		Method->SetStringField(TEXT("requestedMethod"), RequestedMethod);
		Method->SetStringField(TEXT("status"), TEXT("supported"));
		const TSharedRef<FJsonObject> Effective = MakeShared<FJsonObject>();
		Effective->SetStringField(TEXT("method"), EffectiveMethod);
		Effective->SetNumberField(TEXT("version"), 1);
		Method->SetObjectField(TEXT("effectiveMethod"), Effective);
		Method->SetArrayField(TEXT("limitations"), {MakeShared<FJsonValueString>(Limitation)});
		Methods.Add(MakeShared<FJsonValueObject>(Method));
	};
	auto AddUnsupported = [&Methods](const TCHAR *RequestedMethod, const TCHAR *Reason) {
		const TSharedRef<FJsonObject> Method = MakeShared<FJsonObject>();
		Method->SetStringField(TEXT("requestedMethod"), RequestedMethod);
		Method->SetStringField(TEXT("status"), TEXT("unsupported"));
		Method->SetStringField(TEXT("reason"), Reason);
		Methods.Add(MakeShared<FJsonValueObject>(Method));
	};
	AddSupported(TEXT("automatic"), TEXT("depth_compare"),
				 TEXT("Automatic uses bounded depth comparison for depth-writing actor subjects."));
	AddSupported(TEXT("depth_compare"), TEXT("depth_compare"),
				 TEXT("Depth comparison requires depth-writing actor subject pixels."));
	AddSupported(TEXT("ray_samples"), TEXT("ray_samples"),
				 TEXT("Collision-ray samples are diagnostic and can disagree with rendered visibility."));
	AddUnsupported(TEXT("subject_mask"),
				   TEXT("A render-truthful subject-mask method is not available from this producer."));
	Result->SetArrayField(TEXT("methods"), Methods);
	ResultJson = JsonString(Result);
}

namespace
{
bool ReviewStageContract(const TSharedPtr<FJsonObject> &Request)
{
	const TSharedPtr<FJsonObject> *C = nullptr;
	const TSharedPtr<FJsonObject> *V = nullptr;
	FString Name;
	double Major = -1, Minor = -1;
	return Request && Request->TryGetObjectField(TEXT("contract"), C) &&
		   HasOnlyFields(*C, {TEXT("name"), TEXT("version")}) &&
		   (*C)->TryGetStringField(TEXT("name"), Name) && Name == TEXT("ue-shed-review-render-stages") &&
		   (*C)->TryGetObjectField(TEXT("version"), V) && HasOnlyFields(*V, {TEXT("major"), TEXT("minor")}) &&
		   (*V)->TryGetNumberField(TEXT("major"), Major) && Major == 1 &&
		   (*V)->TryGetNumberField(TEXT("minor"), Minor) && Minor == 0;
}
AActor *ReviewActor(UWorld *World, const TSharedPtr<FJsonObject> &Subject, bool &Valid)
{
	Valid = false;
	FString Kind, Path, Guid;
	if (!Subject || !Subject->TryGetStringField(TEXT("kind"), Kind))
		return nullptr;
	FString Diagnostic, LastKnown;
	if (Subject->HasField(TEXT("diagnosticLabel")) &&
		(!Subject->TryGetStringField(TEXT("diagnosticLabel"), Diagnostic) || Diagnostic.IsEmpty()))
		return nullptr;
	if (Subject->HasField(TEXT("lastKnownActorPath")) &&
		(!Subject->TryGetStringField(TEXT("lastKnownActorPath"), LastKnown) || !IsReviewActorPath(LastKnown)))
		return nullptr;
	if (Kind == TEXT("actor_path"))
	{
		Valid = HasOnlyFields(Subject, {TEXT("kind"), TEXT("actorPath"), TEXT("diagnosticLabel")}) &&
				Subject->TryGetStringField(TEXT("actorPath"), Path) && IsReviewActorPath(Path);
		return Valid ? FindActorByPath(World, Path) : nullptr;
	}
	FGuid Parsed;
	if (Kind == TEXT("actor_guid"))
	{
		Valid = HasOnlyFields(Subject, {TEXT("kind"), TEXT("actorGuid"), TEXT("lastKnownActorPath"),
										TEXT("diagnosticLabel")}) &&
				Subject->TryGetStringField(TEXT("actorGuid"), Guid) &&
				FGuid::ParseExact(Guid, EGuidFormats::UniqueObjectGuid, Parsed) && Parsed.IsValid();
		return Valid ? FindActorByGuid(World, Guid) : nullptr;
	}
	return nullptr;
}
TSharedRef<FJsonObject> ReviewResolvedActor(AActor *Actor, const TSharedPtr<FJsonObject> &Subject)
{
	auto Out = MakeShared<FJsonObject>();
	if (!Actor)
	{
		Out->SetStringField(TEXT("kind"), TEXT("unresolved_actor"));
		Out->SetObjectField(TEXT("subject"), Subject);
		Out->SetStringField(TEXT("reason"), TEXT("The actor is unavailable in the loaded editor world; the "
												 "fixed camera remains independent."));
		return Out;
	}
	Out->SetStringField(TEXT("kind"), Subject->GetStringField(TEXT("kind")));
	if (Subject->GetStringField(TEXT("kind")) == TEXT("actor_guid"))
		Out->SetStringField(TEXT("actorGuid"), ActorGuidString(Actor));
	Out->SetStringField(TEXT("actorPath"), Actor->GetPathName());
	auto Transform = MakeShared<FJsonObject>();
	Transform->SetObjectField(TEXT("location"), VectorJson(Actor->GetActorLocation()));
	Transform->SetObjectField(TEXT("rotation"), RotationJson(Actor->GetActorRotation()));
	Out->SetObjectField(TEXT("transform"), Transform);
	return Out;
}
FString ReviewStageFailure(const TCHAR *Code, const TCHAR *Message)
{
	auto Out = MakeShared<FJsonObject>();
	Out->SetStringField(TEXT("status"), TEXT("failed"));
	Out->SetStringField(TEXT("code"), Code);
	Out->SetStringField(TEXT("message"), Message);
	Out->SetStringField(
		TEXT("recovery"),
		TEXT("Validate the Review request and inspect the editor world and rendering session."));
	return JsonString(Out);
}
} // namespace

void UUEShedCameraReviewLibrary::ResolveReviewViewpoint(const FString &RequestJson, FString &ResultJson)
{
	const auto Request = UEShedCameraJson(RequestJson);
	const TSharedPtr<FJsonObject> *Viewpoint = nullptr;
	const TSharedPtr<FJsonObject> *Subject = nullptr;
	const TSharedPtr<FJsonObject> *Pose = nullptr;
	FString Kind, ExpectedMap;
	FVector Location;
	FRotator Rotation;
	double Fov;
	if (!ReviewStageContract(Request) ||
		!HasOnlyFields(Request,
					   {TEXT("contract"), TEXT("viewpoint"), TEXT("subject"), TEXT("expectedMapPath")}) ||
		!Request->TryGetObjectField(TEXT("viewpoint"), Viewpoint) ||
		!Request->TryGetObjectField(TEXT("subject"), Subject) ||
		!Request->TryGetStringField(TEXT("expectedMapPath"), ExpectedMap) ||
		!(*Viewpoint)->TryGetStringField(TEXT("kind"), Kind))
	{
		ResultJson =
			ReviewStageFailure(TEXT("invalid_request"), TEXT("Invalid viewpoint realization request."));
		return;
	}
	UWorld *World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	if (!World || GEditor->PlayWorld || World->GetOutermost()->GetName() != ExpectedMap)
	{
		ResultJson = ReviewStageFailure(
			TEXT("map_mismatch"), TEXT("Open the expected editor world with Play and Simulate stopped."));
		return;
	}
	const bool Fixed = Kind == TEXT("world_fixed");
	if ((Fixed && !HasOnlyFields(*Viewpoint, {TEXT("kind"), TEXT("approvedPose")})) ||
		(!Fixed && !HasOnlyFields(*Viewpoint, {TEXT("kind"), TEXT("relativePose"), TEXT("targetSnapshot")})))
	{
		ResultJson = ReviewStageFailure(TEXT("invalid_viewpoint"), TEXT("Unexpected viewpoint fields."));
		return;
	}
	if (!Fixed)
	{
		const TSharedPtr<FJsonObject> *Snapshot = nullptr;
		FVector SnapshotLocation;
		FRotator SnapshotRotation;
		if (!(*Viewpoint)->TryGetObjectField(TEXT("targetSnapshot"), Snapshot) ||
			!HasOnlyFields(*Snapshot, {TEXT("location"), TEXT("rotation")}) ||
			!ReadVector(*Snapshot, TEXT("location"), SnapshotLocation) ||
			!ReadRotation(*Snapshot, TEXT("rotation"), SnapshotRotation))
		{
			ResultJson = ReviewStageFailure(TEXT("invalid_viewpoint"), TEXT("Invalid target snapshot."));
			return;
		}
	}
	if ((!Fixed && Kind != TEXT("target_relative")) ||
		!(*Viewpoint)->TryGetObjectField(Fixed ? TEXT("approvedPose") : TEXT("relativePose"), Pose) ||
		!ReadPose(*Pose, Location, Rotation, Fov))
	{
		ResultJson = ReviewStageFailure(TEXT("invalid_pose"), TEXT("Invalid approved camera pose."));
		return;
	}
	auto Out = MakeShared<FJsonObject>();
	if (!Fixed)
	{
		bool Valid;
		AActor *Actor = ReviewActor(World, *Subject, Valid);
		if (!Valid || !Actor)
		{
			ResultJson = ReviewStageFailure(TEXT("subject_not_found"),
											TEXT("Actor-relative cameras require their actor to be loaded."));
			return;
		}
		const FTransform Transform(Actor->GetActorRotation(), Actor->GetActorLocation());
		Location = Transform.TransformPosition(Location);
		Rotation = (Transform.GetRotation() * Rotation.Quaternion()).Rotator();
		Out->SetObjectField(TEXT("resolvedSubject"), ReviewResolvedActor(Actor, *Subject));
	}
	Out->SetStringField(TEXT("status"), TEXT("resolved"));
	Out->SetObjectField(TEXT("pose"), PoseJson(Location, Rotation, Fov));
	ResultJson = JsonString(Out);
}

void UUEShedCameraReviewLibrary::InspectRenderedReview(const FString &SessionId, const FString &RequestJson,
													   FString &ResultJson)
{
	const auto Renderer = FUEShedCameraRenderSession::Find(SessionId);
	const auto Request = UEShedCameraJson(RequestJson);
	const TSharedPtr<FJsonObject> *Subject = nullptr;
	const TSharedPtr<FJsonObject> *Assessment = nullptr;
	const TSharedPtr<FJsonObject> *Clear = nullptr;
	if (!Renderer || !Renderer->CurrentFrame() || !ReviewStageContract(Request) ||
		!HasOnlyFields(Request,
					   {TEXT("contract"), TEXT("subject"), TEXT("assessment"), TEXT("clearCompanion")}) ||
		!Request->TryGetObjectField(TEXT("subject"), Subject) ||
		!Request->TryGetObjectField(TEXT("assessment"), Assessment) ||
		!Request->TryGetObjectField(TEXT("clearCompanion"), Clear))
	{
		ResultJson = ReviewStageFailure(
			TEXT("invalid_request"),
			TEXT("A completed owned frame and a bounded Review inspection request are required."));
		return;
	}
	const auto Frame = Renderer->CurrentFrame();
	if (Renderer->Poll(Frame->GetStringField(TEXT("operationId")))->GetStringField(TEXT("status")) !=
		TEXT("captured"))
	{
		ResultJson = ReviewStageFailure(TEXT("frame_not_ready"),
										TEXT("Wait for the Natural frame before assessment."));
		return;
	}
	TArray<TSharedPtr<FJsonValue>> StagedArtifacts;
	auto Stage = [&](const TSharedPtr<FJsonObject> &Rendered, const TCHAR *Variant) {
		const FString Directory = FPaths::ConvertRelativePathToFull(
			FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/ReviewStaging"), SessionId));
		const FString Destination = FPaths::Combine(Directory, FString(Variant) + TEXT(".png"));
		const FString Source =
			FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/CameraRenderStaging"),
							Rendered->GetObjectField(TEXT("artifact"))->GetStringField(TEXT("relativePath")));
		IFileManager::Get().MakeDirectory(*Directory, true);
		if (IFileManager::Get().Copy(*Destination, *Source) != COPY_OK)
			return false;
		auto Artifact = MakeShared<FJsonObject>();
		Artifact->SetStringField(TEXT("variant"), Variant);
		Artifact->SetStringField(TEXT("stagingPath"), Destination);
		StagedArtifacts.Add(MakeShared<FJsonValueObject>(Artifact));
		return true;
	};
	if (!Stage(Renderer->Poll(Frame->GetStringField(TEXT("operationId"))), TEXT("pure")))
	{
		ResultJson =
			ReviewStageFailure(TEXT("staging_failed"), TEXT("Could not stage the Natural artifact."));
		return;
	}
	FString SubjectKind, Method, Preset = TEXT("standard"), ClearStatus, Strategy;
	if (!(*Subject)->TryGetStringField(TEXT("kind"), SubjectKind) ||
		!(*Assessment)->TryGetStringField(TEXT("method"), Method) ||
		!(*Clear)->TryGetStringField(TEXT("status"), ClearStatus))
	{
		ResultJson =
			ReviewStageFailure(TEXT("invalid_request"), TEXT("Review inspection discriminants are missing."));
		return;
	}
	if (Method == TEXT("ray_samples"))
	{
		if (!HasOnlyFields(*Assessment, {TEXT("method"), TEXT("samplePreset")}) ||
			!(*Assessment)->TryGetStringField(TEXT("samplePreset"), Preset) ||
			(Preset != TEXT("sparse") && Preset != TEXT("standard") && Preset != TEXT("dense")))
		{
			ResultJson = ReviewStageFailure(TEXT("invalid_assessment"), TEXT("Invalid ray sample policy."));
			return;
		}
	}
	else if (!HasOnlyFields(*Assessment, {TEXT("method")}) ||
			 (Method != TEXT("automatic") && Method != TEXT("depth_compare") &&
			  Method != TEXT("subject_mask")))
	{
		ResultJson = ReviewStageFailure(TEXT("invalid_assessment"), TEXT("Unsupported visibility method."));
		return;
	}
	if (ClearStatus != TEXT("not_requested") && ClearStatus != TEXT("requested"))
	{
		ResultJson = ReviewStageFailure(TEXT("invalid_clear"), TEXT("Invalid Clear policy."));
		return;
	}
	if (ClearStatus == TEXT("requested") &&
		(!(*Clear)->TryGetStringField(TEXT("strategy"), Strategy) ||
		 (Strategy != TEXT("isolate_target") && Strategy != TEXT("hide_explicit"))))
	{
		ResultJson = ReviewStageFailure(TEXT("invalid_clear"), TEXT("Unsupported Clear strategy."));
		return;
	}
	if ((ClearStatus == TEXT("not_requested") && !HasOnlyFields(*Clear, {TEXT("status")})) ||
		(Strategy == TEXT("isolate_target") && !HasOnlyFields(*Clear, {TEXT("status"), TEXT("strategy")})))
	{
		ResultJson = ReviewStageFailure(TEXT("invalid_clear"), TEXT("Unexpected Clear fields."));
		return;
	}
	UWorld *World = Renderer->World();
	AActor *Actor = nullptr;
	FVector Center, Extent;
	FRotator BoundsRotation = FRotator::ZeroRotator;
	auto Out = MakeShared<FJsonObject>();
	if (SubjectKind == TEXT("oriented_bounds"))
	{
		const TSharedPtr<FJsonObject> *Bounds = nullptr;
		if (!HasOnlyFields(*Subject, {TEXT("kind"), TEXT("bounds")}) ||
			!(*Subject)->TryGetObjectField(TEXT("bounds"), Bounds) ||
			!ReadBounds(*Bounds, Center, Extent, BoundsRotation))
		{
			ResultJson = ReviewStageFailure(TEXT("invalid_subject"), TEXT("Invalid oriented bounds."));
			return;
		}
		Out->SetObjectField(TEXT("resolvedSubject"), *Subject);
	}
	else
	{
		bool Valid;
		Actor = ReviewActor(World, *Subject, Valid);
		if (!Valid)
		{
			ResultJson = ReviewStageFailure(TEXT("invalid_subject"), TEXT("Invalid actor locator."));
			return;
		}
		Out->SetObjectField(TEXT("resolvedSubject"), ReviewResolvedActor(Actor, *Subject));
		if (Actor)
			Actor->GetActorBounds(false, Center, Extent, true);
	}
	const auto C = Frame->GetObjectField(TEXT("camera"));
	const auto Size = Frame->GetObjectField(TEXT("size"));
	FMinimalViewInfo View;
	ReadVector(C, TEXT("location"), View.Location);
	ReadRotation(C, TEXT("rotation"), View.Rotation);
	const auto P = C->GetObjectField(TEXT("projection"));
	View.ProjectionMode = P->GetStringField(TEXT("kind")) == TEXT("orthographic")
							  ? ECameraProjectionMode::Orthographic
							  : ECameraProjectionMode::Perspective;
	if (View.ProjectionMode == ECameraProjectionMode::Perspective)
		View.FOV = P->GetNumberField(TEXT("horizontalFieldOfView"));
	else
		View.OrthoWidth = P->GetNumberField(TEXT("width"));
	View.AspectRatio = Size->GetNumberField(TEXT("width")) / Size->GetNumberField(TEXT("height"));
	TSharedPtr<FJsonObject> Projection;
	if (Actor || SubjectKind == TEXT("oriented_bounds"))
	{
		Projection = ProjectSubjectBounds(Center, Extent, BoundsRotation, View);
		Out->SetObjectField(TEXT("subjectProjection"), Projection);
	}
	auto *Component = Renderer->SceneComponent();
	if (Component && Projection)
		Out->SetObjectField(TEXT("visibility"),
							AssessVisibility(World, Actor, View.Location, Center, Extent, BoundsRotation,
											 Method, Preset, Projection.ToSharedRef(), false, Component,
											 Size->GetIntegerField(TEXT("width")),
											 Size->GetIntegerField(TEXT("height"))));
	else
	{
		auto Visibility = MakeShared<FJsonObject>();
		Visibility->SetStringField(TEXT("status"), TEXT("not_assessed"));
		Visibility->SetStringField(
			TEXT("reason"),
			!Actor
				? TEXT("Actor unavailable in the loaded editor world; the independent camera was rendered.")
				: TEXT("Viewport pixels do not provide SceneCapture visibility assessment."));
		Out->SetObjectField(TEXT("visibility"), Visibility);
	}
	auto ClearResult = MakeShared<FJsonObject>();
	ClearResult->SetStringField(TEXT("status"), TEXT("not_requested"));
	if (ClearStatus == TEXT("requested"))
	{
		ClearResult->SetStringField(TEXT("strategy"), Strategy);
		ClearResult->SetArrayField(TEXT("interventions"), {});
		auto Restoration = MakeShared<FJsonObject>();
		Restoration->SetStringField(TEXT("status"), TEXT("restored"));
		Restoration->SetStringField(TEXT("method"), TEXT("transient_capture_component_lists"));
		ClearResult->SetObjectField(TEXT("restoration"), Restoration);
		auto FailClear = [&](const TCHAR *Code, const TCHAR *Message) {
			ClearResult->SetStringField(TEXT("status"), TEXT("failed"));
			auto Error = MakeShared<FJsonObject>();
			Error->SetStringField(TEXT("code"), Code);
			Error->SetStringField(TEXT("message"), Message);
			Error->SetStringField(
				TEXT("recovery"),
				TEXT("Use a loaded actor and an explicitly selected SceneCapture policy for Clear."));
			Error->SetBoolField(TEXT("retrySafe"), true);
			ClearResult->SetObjectField(TEXT("failure"), Error);
		};
		TArray<AActor *> Hidden;
		bool Valid = Component && Actor;
		if (Strategy == TEXT("hide_explicit"))
		{
			const TArray<TSharedPtr<FJsonValue>> *Values = nullptr;
			if (!HasOnlyFields(*Clear, {TEXT("status"), TEXT("strategy"), TEXT("actors")}) ||
				!(*Clear)->TryGetArrayField(TEXT("actors"), Values) || Values->IsEmpty() ||
				Values->Num() > 32)
			{
				ResultJson = ReviewStageFailure(TEXT("invalid_clear"),
												TEXT("Clear requires one to 32 explicit actor paths."));
				return;
			}
			TSet<FString> Paths;
			for (const auto &V : *Values)
			{
				FString Path;
				if (!V->TryGetString(Path) || !IsReviewActorPath(Path))
				{
					Valid = false;
					break;
				}
				if (Paths.Contains(Path))
				{
					ResultJson =
						ReviewStageFailure(TEXT("invalid_clear"), TEXT("Clear actor paths must be unique."));
					return;
				}
				Paths.Add(Path);
				auto *A = FindActorByPath(World, Path);
				if (!A)
				{
					Valid = false;
					break;
				}
				Hidden.Add(A);
			}
		}
		if (!Valid)
			FailClear(TEXT("clear_unavailable"), TEXT("The requested actor intervention is unavailable."));
		else
		{
			const auto PreviousMode = Component->PrimitiveRenderMode;
			ON_SCOPE_EXIT
			{
				if (Renderer->SceneComponent() == Component)
				{
					Component->ClearShowOnlyComponents();
					Component->ClearHiddenComponents();
					Component->PrimitiveRenderMode = PreviousMode;
				}
			};
			TArray<TSharedPtr<FJsonValue>> Interventions;
			if (Strategy == TEXT("isolate_target"))
			{
				Component->PrimitiveRenderMode = ESceneCapturePrimitiveRenderMode::PRM_UseShowOnlyList;
				Component->ShowOnlyActorComponents(Actor, true);
				auto I = MakeShared<FJsonObject>(), L = MakeShared<FJsonObject>();
				I->SetStringField(TEXT("type"), TEXT("show_only_subject_components"));
				L->SetStringField(TEXT("kind"), TEXT("actor_path"));
				L->SetStringField(TEXT("actorPath"), Actor->GetPathName());
				I->SetObjectField(TEXT("subject"), L);
				Interventions.Add(MakeShared<FJsonValueObject>(I));
			}
			else
				for (auto *A : Hidden)
				{
					Component->HideActorComponents(A, true);
					auto I = MakeShared<FJsonObject>(), L = MakeShared<FJsonObject>();
					I->SetStringField(TEXT("type"), TEXT("hide_actor_components"));
					L->SetStringField(TEXT("kind"), TEXT("actor_path"));
					L->SetStringField(TEXT("actorPath"), A->GetPathName());
					I->SetObjectField(TEXT("target"), L);
					Interventions.Add(MakeShared<FJsonValueObject>(I));
				}
			const auto ClearFrame = Renderer->RenderConfiguredFrameBlocking(TEXT("clear"));
			if (ClearFrame->GetStringField(TEXT("status")) == TEXT("captured") &&
				Stage(ClearFrame, TEXT("clear")))
			{
				ClearResult->SetStringField(TEXT("status"), TEXT("captured"));
				ClearResult->SetArrayField(TEXT("interventions"), Interventions);
				Out->SetObjectField(TEXT("clearFrame"), ClearFrame);
			}
			else
				FailClear(TEXT("clear_capture_failed"),
						  TEXT("The shared renderer could not capture the Clear intervention."));
		}
	}
	Out->SetArrayField(TEXT("stagedArtifacts"), StagedArtifacts);
	Out->SetStringField(TEXT("status"), TEXT("inspected"));
	Out->SetObjectField(TEXT("clearCompanion"), ClearResult);
	ResultJson = JsonString(Out);
}

void UUEShedCameraReviewLibrary::CaptureReviewView(const FString &RequestJson, FString &ResultJson)
{
	FString OperationId;
	FString ViewId;
	int32 ResponseContractMinor = 0;
	auto Fail = [&](const TCHAR *Code, const TCHAR *Message, const TCHAR *Recovery, bool bRetrySafe) {
		ResultJson =
			FailureJson(OperationId, ViewId, ResponseContractMinor, Code, Message, Recovery, bRetrySafe);
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
	Request->TryGetStringField(TEXT("operationId"), OperationId);
	Request->TryGetStringField(TEXT("viewId"), ViewId);
	const TSharedPtr<FJsonObject> *Contract = nullptr;
	const TSharedPtr<FJsonObject> *Version = nullptr;
	FString ContractName;
	double ContractMajor = 0;
	double RequestMinor = 0;
	if (!Request->TryGetObjectField(TEXT("contract"), Contract) ||
		!HasOnlyFields(*Contract, {TEXT("name"), TEXT("version")}) ||
		!(*Contract)->TryGetStringField(TEXT("name"), ContractName) ||
		ContractName != TEXT("ue-shed-review-capture") ||
		!(*Contract)->TryGetObjectField(TEXT("version"), Version) ||
		!HasOnlyFields(*Version, {TEXT("major"), TEXT("minor")}) ||
		!(*Version)->TryGetNumberField(TEXT("major"), ContractMajor) || ContractMajor != 1)
	{
		Fail(TEXT("unsupported_contract"), TEXT("Review capture contract major 1 is required."),
			 TEXT("Negotiate a supported UE Shed Cameras capability."), false);
		return;
	}
	if (!(*Version)->TryGetNumberField(TEXT("minor"), RequestMinor) || RequestMinor < 0 || RequestMinor > 6 ||
		RequestMinor != FMath::FloorToDouble(RequestMinor))
	{
		Fail(TEXT("unsupported_contract"), TEXT("Review capture contract minor is unsupported."),
			 TEXT("Negotiate a supported UE Shed Cameras capability."), false);
		return;
	}
	ResponseContractMinor = static_cast<int32>(RequestMinor);
	const bool bProjectionRequested = RequestMinor >= 1;
	const bool bCurrentRequest = RequestMinor >= 2;
	const bool bRawVisibility = RequestMinor >= 3;
	const bool bClearCompanionRequested = RequestMinor >= 4;
	const bool bStableActorLocator = RequestMinor >= 5;
	const bool bSharedRendering = RequestMinor >= 6;
	TArray<FString> AllowedRequestFields = {TEXT("contract"),		 TEXT("operationId"), TEXT("viewId"),
											TEXT("expectedMapPath"), TEXT("subject"),	  TEXT("resolution")};
	if (bSharedRendering)
		AllowedRequestFields.Add(TEXT("renderPolicy"));
	if (bCurrentRequest)
	{
		AllowedRequestFields.Add(TEXT("assessment"));
		AllowedRequestFields.Add(TEXT("viewpoint"));
	}
	else
	{
		AllowedRequestFields.Add(TEXT("approvedPose"));
	}
	if (bClearCompanionRequested)
		AllowedRequestFields.Add(TEXT("clearCompanion"));
	if (!HasOnlyFields(Request, AllowedRequestFields))
	{
		Fail(TEXT("invalid_contract"), TEXT("Review capture fields contradict the requested minor."),
			 TEXT("Remove fields that are not defined by the requested contract minor."), false);
		return;
	}
	FGuid OperationGuid;
	if (!FGuid::ParseExact(OperationId, EGuidFormats::DigitsWithHyphens, OperationGuid) ||
		!OperationGuid.IsValid() || !IsSafeIdentifier(ViewId))
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
	UWorld *World = GEditor->GetEditorWorldContext().World();
	if (World == nullptr)
	{
		Fail(TEXT("world_unavailable"), TEXT("No editor world is open."),
			 TEXT("Open the expected map and retry."), true);
		return;
	}
	FString ExpectedMapPath;
	if (!Request->TryGetStringField(TEXT("expectedMapPath"), ExpectedMapPath) ||
		World->GetOutermost()->GetName() != ExpectedMapPath)
	{
		Fail(TEXT("map_mismatch"), TEXT("The open editor map does not match the Review Set."),
			 TEXT("Open the expected map or choose a Review Set for this world."), true);
		return;
	}

	const TSharedPtr<FJsonObject> *Subject = nullptr;
	FString SubjectKind;
	FString ActorGuid;
	FString ActorPath;
	FVector SubjectCenter = FVector::ZeroVector;
	FVector SubjectExtent = FVector::ZeroVector;
	const TSharedPtr<FJsonObject> *RequestedViewpoint;
	FString RequestedViewpointKind;
	const bool bIndependentCamera =
		bSharedRendering && Request->TryGetObjectField(TEXT("viewpoint"), RequestedViewpoint) &&
		(*RequestedViewpoint)->TryGetStringField(TEXT("kind"), RequestedViewpointKind) &&
		RequestedViewpointKind == TEXT("world_fixed");
	FRotator SubjectBoundsRotation = FRotator::ZeroRotator;
	AActor *SubjectActor = nullptr;
	if (!Request->TryGetObjectField(TEXT("subject"), Subject) ||
		!(*Subject)->TryGetStringField(TEXT("kind"), SubjectKind))
	{
		Fail(TEXT("unsupported_subject"), TEXT("The Review View subject is unsupported."),
			 TEXT("Use an actor_guid, actor_path, or oriented_bounds subject."), false);
		return;
	}
	if (SubjectKind == TEXT("actor_path"))
	{
		FString DiagnosticLabel;
		if (!HasOnlyFields(*Subject, {TEXT("kind"), TEXT("actorPath"), TEXT("diagnosticLabel")}) ||
			!(*Subject)->TryGetStringField(TEXT("actorPath"), ActorPath) || !IsReviewActorPath(ActorPath) ||
			!ReadOptionalNonEmptyString(*Subject, TEXT("diagnosticLabel"), DiagnosticLabel))
		{
			Fail(TEXT("invalid_subject"), TEXT("The actor subject has no actorPath."),
				 TEXT("Validate the Review Set capture subject."), false);
			return;
		}
		SubjectActor = FindActorByPath(World, ActorPath);
		if (SubjectActor == nullptr && !bIndependentCamera)
		{
			Fail(TEXT("subject_not_found"), TEXT("The Review View subject was not found."),
				 TEXT("Restore the actor or update the Review View subject."), true);
			return;
		}
		if (SubjectActor)
			SubjectActor->GetActorBounds(false, SubjectCenter, SubjectExtent, true);
	}
	else if (SubjectKind == TEXT("actor_guid") && bStableActorLocator)
	{
		FGuid ParsedActorGuid;
		FString LastKnownActorPath;
		FString DiagnosticLabel;
		if (!HasOnlyFields(*Subject, {TEXT("kind"), TEXT("actorGuid"), TEXT("lastKnownActorPath"),
									  TEXT("diagnosticLabel")}) ||
			!(*Subject)->TryGetStringField(TEXT("actorGuid"), ActorGuid) ||
			!FGuid::ParseExact(ActorGuid, EGuidFormats::UniqueObjectGuid, ParsedActorGuid) ||
			!ParsedActorGuid.IsValid() ||
			!ReadOptionalNonEmptyString(*Subject, TEXT("lastKnownActorPath"), LastKnownActorPath) ||
			(!LastKnownActorPath.IsEmpty() && !IsReviewActorPath(LastKnownActorPath)) ||
			!ReadOptionalNonEmptyString(*Subject, TEXT("diagnosticLabel"), DiagnosticLabel))
		{
			Fail(TEXT("invalid_subject"), TEXT("The actor subject has no actorGuid."),
				 TEXT("Validate the Review Set capture subject."), false);
			return;
		}
		SubjectActor = FindActorByGuid(World, ActorGuid);
		if (SubjectActor == nullptr && !bIndependentCamera)
		{
			Fail(TEXT("subject_not_found"), TEXT("The Review View subject was not found."),
				 TEXT("Restore the authored actor or update the Review View subject."), true);
			return;
		}
		if (SubjectActor)
		{
			ActorGuid = ActorGuidString(SubjectActor);
			ActorPath = SubjectActor->GetPathName();
		}
		if (SubjectActor)
			SubjectActor->GetActorBounds(false, SubjectCenter, SubjectExtent, true);
	}
	else if (SubjectKind == TEXT("oriented_bounds") && bCurrentRequest)
	{
		const TSharedPtr<FJsonObject> *Bounds = nullptr;
		if (!HasOnlyFields(*Subject, {TEXT("kind"), TEXT("bounds")}) ||
			!(*Subject)->TryGetObjectField(TEXT("bounds"), Bounds) ||
			!ReadBounds(*Bounds, SubjectCenter, SubjectExtent, SubjectBoundsRotation))
		{
			Fail(TEXT("invalid_subject"), TEXT("The oriented bounds are invalid."),
				 TEXT("Use finite center, non-negative extent, and rotation values."), false);
			return;
		}
	}
	else
	{
		Fail(TEXT("unsupported_subject"), TEXT("The Review View subject is unsupported."),
			 TEXT("Use an actor_guid, actor_path, or oriented_bounds subject."), false);
		return;
	}

	const TSharedPtr<FJsonObject> *Pose = nullptr;
	FVector Location;
	FRotator Rotation;
	double FieldOfView = 0;
	FString AssessmentMethod = TEXT("automatic");
	FString SamplePreset = TEXT("standard");
	if (bCurrentRequest)
	{
		const TSharedPtr<FJsonObject> *Assessment = nullptr;
		if (!Request->TryGetObjectField(TEXT("assessment"), Assessment) ||
			!(*Assessment)->TryGetStringField(TEXT("method"), AssessmentMethod))
		{
			Fail(TEXT("invalid_assessment"), TEXT("The visibility assessment is invalid."),
				 TEXT("Provide a supported assessment method for contract minor 2 or newer."), false);
			return;
		}
		if (AssessmentMethod == TEXT("ray_samples"))
		{
			if (!HasOnlyFields(*Assessment, {TEXT("method"), TEXT("samplePreset")}) ||
				!(*Assessment)->TryGetStringField(TEXT("samplePreset"), SamplePreset) ||
				(SamplePreset != TEXT("sparse") && SamplePreset != TEXT("standard") &&
				 SamplePreset != TEXT("dense")))
			{
				Fail(TEXT("invalid_assessment"), TEXT("The ray assessment preset is invalid."),
					 TEXT("Use sparse, standard, or dense ray samples."), false);
				return;
			}
		}
		else if (!HasOnlyFields(*Assessment, {TEXT("method")}) ||
				 (AssessmentMethod != TEXT("automatic") && AssessmentMethod != TEXT("subject_mask") &&
				  AssessmentMethod != TEXT("depth_compare")))
		{
			Fail(TEXT("invalid_assessment"), TEXT("The visibility assessment method is unsupported."),
				 TEXT("Use automatic, ray_samples, subject_mask, or depth_compare."), false);
			return;
		}
		const TSharedPtr<FJsonObject> *Viewpoint = nullptr;
		FString ViewpointKind;
		if (!Request->TryGetObjectField(TEXT("viewpoint"), Viewpoint) ||
			!(*Viewpoint)->TryGetStringField(TEXT("kind"), ViewpointKind))
		{
			Fail(TEXT("invalid_viewpoint"), TEXT("The capture viewpoint is invalid."),
				 TEXT("Validate the world-fixed or target-relative viewpoint."), false);
			return;
		}
		if (ViewpointKind == TEXT("world_fixed"))
		{
			if (!HasOnlyFields(*Viewpoint, {TEXT("kind"), TEXT("approvedPose")}) ||
				!(*Viewpoint)->TryGetObjectField(TEXT("approvedPose"), Pose) ||
				!ReadPose(*Pose, Location, Rotation, FieldOfView))
			{
				Fail(TEXT("invalid_pose"), TEXT("The approved camera pose is invalid."),
					 TEXT("Validate the finite perspective pose."), false);
				return;
			}
		}
		else if (ViewpointKind == TEXT("target_relative") && SubjectActor != nullptr)
		{
			FVector RelativeLocation;
			FRotator RelativeRotation;
			const TSharedPtr<FJsonObject> *TargetSnapshot;
			FVector SnapshotLocation;
			FRotator SnapshotRotation;
			if (!HasOnlyFields(*Viewpoint, {TEXT("kind"), TEXT("relativePose"), TEXT("targetSnapshot")}) ||
				!(*Viewpoint)->TryGetObjectField(TEXT("relativePose"), Pose) ||
				!ReadPose(*Pose, RelativeLocation, RelativeRotation, FieldOfView))
			{
				Fail(TEXT("invalid_pose"), TEXT("The relative camera pose is invalid."),
					 TEXT("Validate the finite target-relative perspective pose."), false);
				return;
			}
			if (!(*Viewpoint)->TryGetObjectField(TEXT("targetSnapshot"), TargetSnapshot) ||
				!HasOnlyFields(*TargetSnapshot, {TEXT("location"), TEXT("rotation")}) ||
				!ReadVector(*TargetSnapshot, TEXT("location"), SnapshotLocation) ||
				!ReadRotation(*TargetSnapshot, TEXT("rotation"), SnapshotRotation))
			{
				Fail(TEXT("invalid_viewpoint"), TEXT("The target snapshot is invalid."),
					 TEXT("Provide the saved target location and rotation."), false);
				return;
			}
			const FTransform TargetTransform(SubjectActor->GetActorRotation(),
											 SubjectActor->GetActorLocation());
			Location = TargetTransform.TransformPosition(RelativeLocation);
			Rotation = (TargetTransform.GetRotation() * RelativeRotation.Quaternion()).Rotator();
		}
		else
		{
			Fail(TEXT("invalid_viewpoint"), TEXT("The capture viewpoint is incompatible."),
				 TEXT("Use target-relative only with an actor subject."), false);
			return;
		}
	}
	else if (!Request->TryGetObjectField(TEXT("approvedPose"), Pose) ||
			 !ReadPose(*Pose, Location, Rotation, FieldOfView))
	{
		Fail(TEXT("invalid_pose"), TEXT("The approved camera pose is invalid."),
			 TEXT("Validate the Review Set and approve a finite perspective pose."), false);
		return;
	}
	const TSharedPtr<FJsonObject> *Resolution;
	double WidthValue = 0;
	double HeightValue = 0;
	if (!Request->TryGetObjectField(TEXT("resolution"), Resolution) ||
		!HasOnlyFields(*Resolution, {TEXT("width"), TEXT("height")}) ||
		!(*Resolution)->TryGetNumberField(TEXT("width"), WidthValue) ||
		!(*Resolution)->TryGetNumberField(TEXT("height"), HeightValue))
	{
		Fail(TEXT("invalid_resolution"), TEXT("Capture resolution is missing."),
			 TEXT("Use a supported bounded capture profile."), false);
		return;
	}
	const int32 Width = FMath::RoundToInt(WidthValue);
	const int32 Height = FMath::RoundToInt(HeightValue);
	if (Width < 160 || Width > 3840 || Height < 90 || Height > 2160 || WidthValue != Width ||
		HeightValue != Height)
	{
		Fail(TEXT("invalid_resolution"), TEXT("Capture resolution is outside supported limits."),
			 TEXT("Use integer dimensions from 160x90 through 3840x2160."), false);
		return;
	}

	FString ClearCompanionStatus = TEXT("not_requested");
	FString ClearStrategy;
	TArray<FString> ExplicitClearActorPaths;
	if (bClearCompanionRequested)
	{
		const TSharedPtr<FJsonObject> *ClearCompanion;
		if (!Request->TryGetObjectField(TEXT("clearCompanion"), ClearCompanion) ||
			!(*ClearCompanion)->TryGetStringField(TEXT("status"), ClearCompanionStatus))
		{
			Fail(TEXT("invalid_clear_companion"), TEXT("The Clear companion instruction is invalid."),
				 TEXT("Validate the optional Clear companion against capture contract 1.4."), false);
			return;
		}
		if (ClearCompanionStatus == TEXT("requested"))
		{
			if (!(*ClearCompanion)->TryGetStringField(TEXT("strategy"), ClearStrategy) ||
				(ClearStrategy != TEXT("isolate_target") && ClearStrategy != TEXT("hide_explicit")))
			{
				Fail(TEXT("invalid_clear_companion"), TEXT("The Clear companion strategy is unsupported."),
					 TEXT("Use isolate_target or hide_explicit for the optional Clear companion."), false);
				return;
			}
			if (SubjectActor == nullptr && !bIndependentCamera)
			{
				Fail(TEXT("invalid_clear_companion"),
					 TEXT("Clear companion capture requires an actor subject."),
					 TEXT("Use Natural-only capture for an oriented-area subject."), false);
				return;
			}
			if (ClearStrategy == TEXT("hide_explicit"))
			{
				if (!HasOnlyFields(*ClearCompanion, {TEXT("actors"), TEXT("status"), TEXT("strategy")}))
				{
					Fail(TEXT("invalid_clear_companion"),
						 TEXT("Explicit Clear capture has contradictory fields."),
						 TEXT("Use only actors, status, and strategy."), false);
					return;
				}
				const TArray<TSharedPtr<FJsonValue>> *ActorValues;
				if (!(*ClearCompanion)->TryGetArrayField(TEXT("actors"), ActorValues) ||
					ActorValues->IsEmpty() || ActorValues->Num() > 32)
				{
					Fail(TEXT("invalid_clear_companion"),
						 TEXT("Explicit Clear capture requires one to 32 actor paths."),
						 TEXT("Provide bounded unique actor paths for hide_explicit Clear capture."), false);
					return;
				}
				TSet<FString> UniqueActorPaths;
				for (const TSharedPtr<FJsonValue> &ActorValue : *ActorValues)
				{
					FString ActorPathValue;
					if (!ActorValue.IsValid() || !ActorValue->TryGetString(ActorPathValue) ||
						!ActorPathValue.StartsWith(TEXT("/Game/")) ||
						UniqueActorPaths.Contains(ActorPathValue))
					{
						Fail(TEXT("invalid_clear_companion"),
							 TEXT("Explicit Clear actor paths must be unique Unreal actor paths."),
							 TEXT("Validate the explicit Clear actor list and retry."), false);
						return;
					}
					UniqueActorPaths.Add(ActorPathValue);
					ExplicitClearActorPaths.Add(ActorPathValue);
				}
			}
			else if (!HasOnlyFields(*ClearCompanion, {TEXT("status"), TEXT("strategy")}))
			{
				Fail(TEXT("invalid_clear_companion"),
					 TEXT("Isolate-target Clear capture has contradictory fields."),
					 TEXT("Use only status and strategy."), false);
				return;
			}
		}
		else if (ClearCompanionStatus != TEXT("not_requested"))
		{
			Fail(TEXT("invalid_clear_companion"), TEXT("The Clear companion status is unsupported."),
				 TEXT("Use not_requested or requested for the optional Clear companion."), false);
			return;
		}
		else if (!HasOnlyFields(*ClearCompanion, {TEXT("status")}))
		{
			Fail(TEXT("invalid_clear_companion"),
				 TEXT("The not-requested Clear instruction has contradictory fields."),
				 TEXT("Use only status for a not-requested Clear companion."), false);
			return;
		}
	}

	UPackage *MapPackage = World->GetOutermost();
	const bool bDirtyBefore = MapPackage->IsDirty();
	const double StartedSeconds = FPlatformTime::Seconds();
	TSharedPtr<FJsonObject> RenderError;
	auto RenderRequest = UEShedLegacyRenderRequest(OperationId, World, false);
	if (bSharedRendering)
	{
		const TSharedPtr<FJsonObject> *Policy;
		if (!Request->TryGetObjectField(TEXT("renderPolicy"), Policy))
		{
			Fail(TEXT("invalid_policy"), TEXT("Shared rendering requires an explicit render policy."),
				 TEXT("Resolve the profile's legacy or authored render policy."), false);
			return;
		}
		RenderRequest->SetObjectField(TEXT("policy"), *Policy);
	}
	auto Renderer = FUEShedCameraRenderSession::Open(RenderRequest, RenderError);
	if (!Renderer)
	{
		Fail(*RenderError->GetStringField(TEXT("code")), *RenderError->GetStringField(TEXT("message")),
			 TEXT("Inspect the shared renderer policy and editor ownership."), true);
		return;
	}
	ON_SCOPE_EXIT
	{
		Renderer->Close();
	};
	auto RenderFrame =
		UEShedRenderFrame(OperationId, TEXT("natural"),
						  UEShedCameraPose(Location, Rotation, FieldOfView, false), Width, Height);
	const auto RenderedFrame = Renderer->RenderBlocking(RenderFrame);
	if (RenderedFrame->GetStringField(TEXT("status")) != TEXT("captured"))
	{
		Fail(*RenderedFrame->GetStringField(TEXT("code")), *RenderedFrame->GetStringField(TEXT("message")),
			 TEXT("Inspect the renderer result and editor state before retrying."), true);
		return;
	}
	USceneCaptureComponent2D *CaptureComponent = Renderer->SceneComponent();
	UTextureRenderTarget2D *RenderTarget = CaptureComponent ? CaptureComponent->TextureTarget : nullptr;
	TSharedPtr<FJsonObject> SubjectProjection;
	if (bProjectionRequested && (SubjectActor || SubjectKind == TEXT("oriented_bounds")))
	{
		FMinimalViewInfo CaptureView;
		CaptureView.Location = Location;
		CaptureView.Rotation = Rotation;
		CaptureView.FOV = FieldOfView;
		CaptureView.AspectRatio = double(Width) / Height;
		CaptureView.ProjectionMode = ECameraProjectionMode::Perspective;
		SubjectProjection =
			ProjectSubjectBounds(SubjectCenter, SubjectExtent, SubjectBoundsRotation, CaptureView);
	}
	TSharedPtr<FJsonObject> Visibility;
	if (bCurrentRequest)
	{
		if (!CaptureComponent || (!SubjectActor && SubjectKind != TEXT("oriented_bounds")))
		{
			Visibility = MakeShared<FJsonObject>();
			Visibility->SetStringField(TEXT("status"), TEXT("not_assessed"));
			Visibility->SetStringField(
				TEXT("reason"),
				!SubjectActor
					? TEXT("The actor is unavailable in the loaded editor world; the independent camera was "
						   "retained.")
					: TEXT("Viewport color rendering does not provide SceneCapture visibility assessment."));
		}
		else
			Visibility = AssessVisibility(World, SubjectActor, Location, SubjectCenter, SubjectExtent,
										  SubjectBoundsRotation, AssessmentMethod, SamplePreset,
										  SubjectProjection.ToSharedRef(), !bRawVisibility, CaptureComponent,
										  Width, Height);
	}

	const FString RenderedPath = FPaths::Combine(
		FPaths::ProjectSavedDir(), TEXT("UEShed/CameraRenderStaging"),
		RenderedFrame->GetObjectField(TEXT("artifact"))->GetStringField(TEXT("relativePath")));
	const FString CaptureDirectory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed"),
													 TEXT("ReviewStaging"), OperationId, ViewId);
	const FString CapturePath = FPaths::Combine(CaptureDirectory, TEXT("pure.png"));
	IFileManager::Get().MakeDirectory(*CaptureDirectory, true);
	const bool bWritten = IFileManager::Get().Copy(*CapturePath, *RenderedPath) == COPY_OK;

	if (!bWritten)
	{
		Fail(TEXT("capture_write_failed"), TEXT("Unreal could not write the staged PNG."),
			 TEXT("Check the project Saved directory and retry."), true);
		return;
	}

	TSharedPtr<FJsonObject> ClearCompanionResult;
	TArray<TSharedPtr<FJsonValue>> StagedArtifacts;
	if (bClearCompanionRequested)
	{
		ClearCompanionResult = MakeShared<FJsonObject>();
		auto RestoredClearState = []() {
			const TSharedRef<FJsonObject> Restoration = MakeShared<FJsonObject>();
			Restoration->SetStringField(TEXT("status"), TEXT("restored"));
			Restoration->SetStringField(TEXT("method"), TEXT("transient_capture_component_lists"));
			return Restoration;
		};
		auto SetClearFailure = [&ClearCompanionResult, &RestoredClearState](
								   const FString &Strategy, const TCHAR *Code, const TCHAR *Message,
								   const TCHAR *Recovery, bool bRetrySafe) {
			ClearCompanionResult->SetStringField(TEXT("status"), TEXT("failed"));
			ClearCompanionResult->SetStringField(TEXT("strategy"), Strategy);
			ClearCompanionResult->SetArrayField(TEXT("interventions"), {});
			const TSharedRef<FJsonObject> Failure = MakeShared<FJsonObject>();
			Failure->SetStringField(TEXT("code"), Code);
			Failure->SetStringField(TEXT("message"), Message);
			Failure->SetStringField(TEXT("recovery"), Recovery);
			Failure->SetBoolField(TEXT("retrySafe"), bRetrySafe);
			ClearCompanionResult->SetObjectField(TEXT("failure"), Failure);
			ClearCompanionResult->SetObjectField(TEXT("restoration"), RestoredClearState());
		};

		if (ClearCompanionStatus == TEXT("not_requested"))
		{
			ClearCompanionResult->SetStringField(TEXT("status"), TEXT("not_requested"));
		}
		else if (!SubjectActor || !CaptureComponent)
		{
			SetClearFailure(
				ClearStrategy, TEXT("clear_unavailable"),
				TEXT("Clear requires a loaded actor and a SceneCapture renderer."),
				TEXT("Load the actor and explicitly choose SceneCapture if a Clear companion is required."),
				true);
		}
		else
		{
			TArray<AActor *> ClearActors;
			bool bClearActorsResolved = true;
			if (ClearStrategy == TEXT("isolate_target"))
			{
				ClearActors.Add(SubjectActor);
			}
			else
			{
				for (const FString &ExplicitActorPath : ExplicitClearActorPaths)
				{
					AActor *Actor = FindActorByPath(World, ExplicitActorPath);
					if (Actor == nullptr)
					{
						bClearActorsResolved = false;
						break;
					}
					ClearActors.Add(Actor);
				}
			}
			if (!bClearActorsResolved)
			{
				SetClearFailure(ClearStrategy, TEXT("clear_actor_not_found"),
								TEXT("A requested Clear actor was not found after Pure capture."),
								TEXT("Update the explicit Clear actors and retry."), true);
			}
			else
			{
				const ESceneCapturePrimitiveRenderMode PreviousPrimitiveMode =
					CaptureComponent->PrimitiveRenderMode;
				bool bClearStateRestored = false;
				auto RestoreClearState = [&CaptureComponent, &Renderer, PreviousPrimitiveMode]() {
					if (Renderer->SceneComponent() != CaptureComponent)
						return;
					CaptureComponent->ClearShowOnlyComponents();
					CaptureComponent->ClearHiddenComponents();
					CaptureComponent->PrimitiveRenderMode = PreviousPrimitiveMode;
				};
				ON_SCOPE_EXIT
				{
					if (!bClearStateRestored)
						RestoreClearState();
				};

				TArray<TSharedPtr<FJsonValue>> Interventions;
				if (ClearStrategy == TEXT("isolate_target"))
				{
					CaptureComponent->ClearHiddenComponents();
					CaptureComponent->ClearShowOnlyComponents();
					CaptureComponent->PrimitiveRenderMode =
						ESceneCapturePrimitiveRenderMode::PRM_UseShowOnlyList;
					CaptureComponent->ShowOnlyActorComponents(SubjectActor, true);
					const TSharedRef<FJsonObject> Intervention = MakeShared<FJsonObject>();
					Intervention->SetStringField(TEXT("type"), TEXT("show_only_subject_components"));
					const TSharedRef<FJsonObject> Locator = MakeShared<FJsonObject>();
					Locator->SetStringField(TEXT("kind"), TEXT("actor_path"));
					Locator->SetStringField(TEXT("actorPath"), SubjectActor->GetPathName());
					Intervention->SetObjectField(TEXT("subject"), Locator);
					Interventions.Add(MakeShared<FJsonValueObject>(Intervention));
				}
				else
				{
					CaptureComponent->ClearShowOnlyComponents();
					CaptureComponent->ClearHiddenComponents();
					CaptureComponent->PrimitiveRenderMode =
						ESceneCapturePrimitiveRenderMode::PRM_RenderScenePrimitives;
					for (AActor *ClearActor : ClearActors)
					{
						CaptureComponent->HideActorComponents(ClearActor, true);
						const TSharedRef<FJsonObject> Intervention = MakeShared<FJsonObject>();
						Intervention->SetStringField(TEXT("type"), TEXT("hide_actor_components"));
						const TSharedRef<FJsonObject> Locator = MakeShared<FJsonObject>();
						Locator->SetStringField(TEXT("kind"), TEXT("actor_path"));
						Locator->SetStringField(TEXT("actorPath"), ClearActor->GetPathName());
						Intervention->SetObjectField(TEXT("target"), Locator);
						Interventions.Add(MakeShared<FJsonValueObject>(Intervention));
					}
				}

				const auto ClearFrame = Renderer->RenderConfiguredFrameBlocking(TEXT("clear"));
				FBufferArchive ClearPngBytes;
				const bool bClearExported =
					ClearFrame->GetStringField(TEXT("status")) == TEXT("captured") &&
					FImageUtils::ExportRenderTarget2DAsPNG(RenderTarget, ClearPngBytes);
				const FString ClearCapturePath = FPaths::Combine(CaptureDirectory, TEXT("clear.png"));
				const bool bClearWritten =
					bClearExported && FFileHelper::SaveArrayToFile(ClearPngBytes, *ClearCapturePath);
				RestoreClearState();
				bClearStateRestored = true;

				if (!bClearExported || !bClearWritten)
				{
					IFileManager::Get().Delete(*ClearCapturePath, false, true, true);
					SetClearFailure(ClearStrategy, TEXT("clear_capture_write_failed"),
									TEXT("Unreal could not write the optional Clear companion PNG."),
									TEXT("Check the project Saved directory and retry Clear capture."), true);
				}
				else
				{
					ClearCompanionResult->SetStringField(TEXT("status"), TEXT("captured"));
					ClearCompanionResult->SetStringField(TEXT("strategy"), ClearStrategy);
					ClearCompanionResult->SetArrayField(TEXT("interventions"), Interventions);
					ClearCompanionResult->SetObjectField(TEXT("restoration"), RestoredClearState());
					const TSharedRef<FJsonObject> StagedClear = MakeShared<FJsonObject>();
					StagedClear->SetStringField(TEXT("variant"), TEXT("clear"));
					StagedClear->SetStringField(TEXT("stagingPath"),
												FPaths::ConvertRelativePathToFull(ClearCapturePath));
					StagedArtifacts.Add(MakeShared<FJsonValueObject>(StagedClear));
				}
			}
		}
	}

	const auto Restoration = Renderer->Close();
	if (Restoration->GetStringField(TEXT("status")) != TEXT("closed"))
	{
		Fail(TEXT("restoration_failed"), TEXT("The shared renderer could not restore editor state."),
			 TEXT("Inspect the editor before continuing."), false);
		return;
	}
	const bool bDirtyAfter = MapPackage->IsDirty();

	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> ResultContract = MakeShared<FJsonObject>();
	ResultContract->SetStringField(TEXT("name"), TEXT("ue-shed-review-capture"));
	const TSharedRef<FJsonObject> ResultVersion = MakeShared<FJsonObject>();
	ResultVersion->SetNumberField(TEXT("major"), 1);
	ResultVersion->SetNumberField(TEXT("minor"), RequestMinor);
	ResultContract->SetObjectField(TEXT("version"), ResultVersion);
	Result->SetObjectField(TEXT("contract"), ResultContract);
	if (bSharedRendering)
		Result->SetObjectField(TEXT("renderEvidence"), RenderedFrame->GetObjectField(TEXT("evidence")));
	Result->SetStringField(TEXT("status"), TEXT("captured"));
	Result->SetStringField(TEXT("operationId"), OperationId);
	Result->SetStringField(TEXT("viewId"), ViewId);
	if (bCurrentRequest)
	{
		const TSharedRef<FJsonObject> ResolvedSubject = MakeShared<FJsonObject>();
		if (SubjectActor != nullptr)
		{
			ResolvedSubject->SetStringField(TEXT("kind"), SubjectKind);
			if (SubjectKind == TEXT("actor_guid"))
			{
				ResolvedSubject->SetStringField(TEXT("actorGuid"), ActorGuid);
			}
			ResolvedSubject->SetStringField(TEXT("actorPath"), SubjectActor->GetPathName());
			const TSharedRef<FJsonObject> Transform = MakeShared<FJsonObject>();
			Transform->SetObjectField(TEXT("location"), VectorJson(SubjectActor->GetActorLocation()));
			Transform->SetObjectField(TEXT("rotation"), RotationJson(SubjectActor->GetActorRotation()));
			ResolvedSubject->SetObjectField(TEXT("transform"), Transform);
		}
		else if (SubjectKind != TEXT("oriented_bounds"))
		{
			ResolvedSubject->SetStringField(TEXT("kind"), TEXT("unresolved_actor"));
			ResolvedSubject->SetObjectField(TEXT("subject"), *Subject);
			ResolvedSubject->SetStringField(
				TEXT("reason"),
				TEXT("Actor unavailable in the loaded editor world; fixed camera does not depend on it."));
		}
		else
		{
			ResolvedSubject->SetStringField(TEXT("kind"), TEXT("oriented_bounds"));
			ResolvedSubject->SetObjectField(TEXT("bounds"),
											BoundsJson(SubjectCenter, SubjectExtent, SubjectBoundsRotation));
		}
		Result->SetObjectField(TEXT("resolvedSubject"), ResolvedSubject);
		Result->SetObjectField(TEXT("effectiveWorldPose"), PoseJson(Location, Rotation, FieldOfView));
		Result->SetObjectField(TEXT("visibility"), Visibility.ToSharedRef());
	}
	else
	{
		Result->SetStringField(TEXT("actorPath"), SubjectActor->GetPathName());
	}
	Result->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
	if (bClearCompanionRequested)
	{
		const TSharedRef<FJsonObject> StagedPure = MakeShared<FJsonObject>();
		StagedPure->SetStringField(TEXT("variant"), TEXT("pure"));
		StagedPure->SetStringField(TEXT("stagingPath"), FPaths::ConvertRelativePathToFull(CapturePath));
		StagedArtifacts.Insert(MakeShared<FJsonValueObject>(StagedPure), 0);
		Result->SetArrayField(TEXT("stagedArtifacts"), StagedArtifacts);
		Result->SetObjectField(TEXT("clearCompanion"), ClearCompanionResult.ToSharedRef());
	}
	else
	{
		Result->SetStringField(TEXT("stagingPath"), FPaths::ConvertRelativePathToFull(CapturePath));
	}
	if (SubjectProjection.IsValid())
		Result->SetObjectField(TEXT("subjectProjection"), SubjectProjection.ToSharedRef());
	Result->SetNumberField(TEXT("width"), Width);
	Result->SetNumberField(TEXT("height"), Height);
	Result->SetNumberField(TEXT("captureDurationMs"), (FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
	Result->SetBoolField(TEXT("mapPackageDirtyBefore"), bDirtyBefore);
	Result->SetBoolField(TEXT("mapPackageDirtyAfter"), bDirtyAfter);
	ResultJson = JsonString(Result);
}
