#include "UEShedCameraReviewLibrary.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "LevelEditorViewport.h"
#include "Selection.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Camera/CameraTypes.h"
#include "Engine/SceneCapture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "EngineUtils.h"
#include "HAL/FileManager.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Serialization/BufferArchive.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Kismet/GameplayStatics.h"

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

bool ReadBounds(
	const TSharedPtr<FJsonObject>& Object,
	FVector& Center,
	FVector& Extent,
	FRotator& Rotation)
{
	return ReadVector(Object, TEXT("center"), Center)
		&& ReadVector(Object, TEXT("extent"), Extent)
		&& ReadRotation(Object, TEXT("rotation"), Rotation)
		&& Extent.X >= 0.0 && Extent.Y >= 0.0 && Extent.Z >= 0.0;
}

bool ReadPose(
	const TSharedPtr<FJsonObject>& Pose,
	FVector& Location,
	FRotator& Rotation,
	double& FieldOfView)
{
	return ReadVector(Pose, TEXT("location"), Location)
		&& ReadRotation(Pose, TEXT("rotation"), Rotation)
		&& Pose->TryGetNumberField(TEXT("fieldOfViewDegrees"), FieldOfView)
		&& FieldOfView >= 5.0 && FieldOfView <= 170.0;
}

AActor* FindActorByPath(UWorld* World, const FString& ActorPath)
{
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		if (It->GetPathName() == ActorPath) return *It;
	}
	return nullptr;
}

TSharedRef<FJsonObject> VectorJson(const FVector& Value)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetNumberField(TEXT("x"), Value.X);
	Json->SetNumberField(TEXT("y"), Value.Y);
	Json->SetNumberField(TEXT("z"), Value.Z);
	return Json;
}

TSharedRef<FJsonObject> RotationJson(const FRotator& Value)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetNumberField(TEXT("pitch"), Value.Pitch);
	Json->SetNumberField(TEXT("roll"), Value.Roll);
	Json->SetNumberField(TEXT("yaw"), Value.Yaw);
	return Json;
}

TSharedRef<FJsonObject> BoundsJson(
	const FVector& Center,
	const FVector& Extent,
	const FRotator& Rotation)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetObjectField(TEXT("center"), VectorJson(Center));
	Json->SetObjectField(TEXT("extent"), VectorJson(Extent));
	Json->SetObjectField(TEXT("rotation"), RotationJson(Rotation));
	return Json;
}

TSharedRef<FJsonObject> PoseJson(
	const FVector& Location,
	const FRotator& Rotation,
	double FieldOfView)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("aspectRatio"), TEXT("16:9"));
	Json->SetNumberField(TEXT("fieldOfViewDegrees"), FieldOfView);
	Json->SetObjectField(TEXT("location"), VectorJson(Location));
	Json->SetStringField(TEXT("projection"), TEXT("perspective"));
	Json->SetObjectField(TEXT("rotation"), RotationJson(Rotation));
	return Json;
}

void AddSelectionResult(
	const TSharedRef<FJsonObject>& Result,
	AActor* Actor,
	bool bIncludeEditorView)
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
	Result->SetStringField(TEXT("displayName"), Actor->GetActorNameOrLabel());
	Result->SetStringField(TEXT("mapPath"), Actor->GetWorld()->GetOutermost()->GetName());
	Result->SetObjectField(TEXT("bounds"), Bounds);
	if (bIncludeEditorView && GCurrentLevelEditingViewportClient != nullptr
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
}

TSharedRef<FJsonObject> ProjectSubjectBounds(
	const FVector& Center,
	const FVector& Extent,
	const FRotator& BoundsRotation,
	USceneCaptureComponent2D* CaptureComponent)
{
	FMinimalViewInfo CaptureView;
	CaptureComponent->GetCameraView(0.0f, CaptureView);
	FMatrix ViewMatrix;
	FMatrix ProjectionMatrix;
	FMatrix ViewProjectionMatrix;
	UGameplayStatics::GetViewProjectionMatrix(
		CaptureView, ViewMatrix, ProjectionMatrix, ViewProjectionMatrix);
	const float NearPlane = CaptureView.GetFinalPerspectiveNearClipPlane();
	TArray<FVector> Corners;
	Corners.Reserve(8);
	for (const double X : {-1.0, 1.0})
	{
		for (const double Y : {-1.0, 1.0})
		{
			for (const double Z : {-1.0, 1.0})
			{
				Corners.Add(Center + BoundsRotation.RotateVector(
					FVector(X * Extent.X, Y * Extent.Y, Z * Extent.Z)));
			}
		}
	}
	bool bBehindCamera = false;
	bool bNearPlaneCrossing = false;
	float MinimumX = TNumericLimits<float>::Max();
	float MinimumY = TNumericLimits<float>::Max();
	float MaximumX = TNumericLimits<float>::Lowest();
	float MaximumY = TNumericLimits<float>::Lowest();
	for (const FVector& Corner : Corners)
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
		Result->SetStringField(
			TEXT("code"), bBehindCamera ? TEXT("behind_camera") : TEXT("near_plane_crossing"));
		Result->SetStringField(
			TEXT("message"),
			bBehindCamera
				? TEXT("At least one subject-bounds corner is behind the transient capture camera.")
				: TEXT("At least one subject-bounds corner crosses the transient capture near plane."));
		return Result;
	}

	const bool bFullyOutside = MaximumX < 0.0f || MinimumX > 1.0f
		|| MaximumY < 0.0f || MinimumY > 1.0f;
	const bool bFullyWithin = MinimumX >= 0.0f && MaximumX <= 1.0f
		&& MinimumY >= 0.0f && MaximumY <= 1.0f;
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
	Result->SetStringField(
		TEXT("viewportStatus"),
		bFullyWithin ? TEXT("fully_within_viewport")
			: bFullyOutside ? TEXT("fully_outside_viewport")
			: TEXT("partially_outside_viewport"));
	Result->SetObjectField(TEXT("normalizedBounds"), Bounds);
	Result->SetObjectField(TEXT("margins"), Margins);
	return Result;
}

TSharedRef<FJsonObject> AssessVisibility(
	UWorld* World,
	AActor* SubjectActor,
	const FVector& CameraLocation,
	const FVector& Center,
	const FVector& Extent,
	const FRotator& BoundsRotation,
	const FString& Method,
	const FString& SamplePreset,
	const TSharedRef<FJsonObject>& Projection,
	bool bIncludeClassification,
	USceneCaptureComponent2D* CaptureComponent,
	int32 CaptureWidth,
	int32 CaptureHeight)
{
	const double StartedSeconds = FPlatformTime::Seconds();
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	if (SubjectActor == nullptr)
	{
		Result->SetStringField(TEXT("status"), TEXT("not_assessed"));
		Result->SetStringField(
			TEXT("reason"),
			TEXT("Oriented-area visibility needs a render-truthful region method."));
		Result->SetArrayField(TEXT("limitations"), {
			MakeShared<FJsonValueString>(
				TEXT("Area contents are review subject matter and are not treated as blockers."))
		});
		return Result;
	}
	FString ProjectionStatus;
	FString ViewportStatus;
	Projection->TryGetStringField(TEXT("status"), ProjectionStatus);
	Projection->TryGetStringField(TEXT("viewportStatus"), ViewportStatus);
	if (!bIncludeClassification
		&& (ProjectionStatus == TEXT("unprojectable")
			|| ViewportStatus == TEXT("fully_outside_viewport")))
	{
		Result->SetStringField(TEXT("status"), TEXT("not_assessed"));
		Result->SetStringField(
			TEXT("reason"),
			TEXT("The subject is outside the effective capture projection, so visibility has no valid image-space denominator."));
		Result->SetArrayField(TEXT("limitations"), {
			MakeShared<FJsonValueString>(
				TEXT("Inspect subjectProjection for behind-camera, near-plane, or viewport-clipping evidence."))
		});
		return Result;
	}
	if (!bIncludeClassification
		&& (Method == TEXT("automatic") || Method == TEXT("depth_compare")))
	{
		const int32 Width = FMath::Max(
			1, FMath::RoundToInt(CaptureWidth * FMath::Min(
				1.0, FMath::Min(320.0 / CaptureWidth, 180.0 / CaptureHeight))));
		const int32 Height = FMath::Max(
			1, FMath::RoundToInt(CaptureHeight * FMath::Min(
				1.0, FMath::Min(320.0 / CaptureWidth, 180.0 / CaptureHeight))));
		UTextureRenderTarget2D* SceneDepthTarget = NewObject<UTextureRenderTarget2D>(
			CaptureComponent, NAME_None, RF_Transient);
		UTextureRenderTarget2D* SubjectDepthTarget = NewObject<UTextureRenderTarget2D>(
			CaptureComponent, NAME_None, RF_Transient);
		for (UTextureRenderTarget2D* Target : { SceneDepthTarget, SubjectDepthTarget })
		{
			Target->RenderTargetFormat = RTF_RGBA32f;
			Target->ClearColor = FLinearColor::Black;
			Target->InitAutoFormat(Width, Height);
			Target->UpdateResourceImmediate(true);
		}

		UTextureRenderTarget2D* PreviousTarget = CaptureComponent->TextureTarget;
		const ESceneCaptureSource PreviousSource = CaptureComponent->CaptureSource;
		const ESceneCapturePrimitiveRenderMode PreviousPrimitiveMode =
			CaptureComponent->PrimitiveRenderMode;
		ON_SCOPE_EXIT
		{
			CaptureComponent->ClearShowOnlyComponents();
			CaptureComponent->PrimitiveRenderMode = PreviousPrimitiveMode;
			CaptureComponent->CaptureSource = PreviousSource;
			CaptureComponent->TextureTarget = PreviousTarget;
		};

		CaptureComponent->CaptureSource = ESceneCaptureSource::SCS_SceneDepth;
		CaptureComponent->PrimitiveRenderMode =
			ESceneCapturePrimitiveRenderMode::PRM_RenderScenePrimitives;
		CaptureComponent->TextureTarget = SceneDepthTarget;
		CaptureComponent->CaptureScene();
		TArray<FLinearColor> SceneDepth;
		const bool bReadScene = SceneDepthTarget->GameThread_GetRenderTargetResource()
			->ReadLinearColorPixels(SceneDepth);

		CaptureComponent->ClearShowOnlyComponents();
		CaptureComponent->PrimitiveRenderMode =
			ESceneCapturePrimitiveRenderMode::PRM_UseShowOnlyList;
		CaptureComponent->ShowOnlyActorComponents(SubjectActor, true);
		CaptureComponent->TextureTarget = SubjectDepthTarget;
		CaptureComponent->CaptureScene();
		TArray<FLinearColor> SubjectDepth;
		const bool bReadSubject = SubjectDepthTarget->GameThread_GetRenderTargetResource()
			->ReadLinearColorPixels(SubjectDepth);

		if (!bReadScene || !bReadSubject
			|| SceneDepth.Num() != Width * Height
			|| SubjectDepth.Num() != Width * Height)
		{
			Result->SetStringField(TEXT("status"), TEXT("assessment_failed"));
			const TSharedRef<FJsonObject> Failure = MakeShared<FJsonObject>();
			Failure->SetStringField(TEXT("code"), TEXT("visibility_readback_failed"));
			Failure->SetStringField(
				TEXT("message"), TEXT("Unreal could not read the bounded depth captures."));
			Failure->SetStringField(
				TEXT("recovery"), TEXT("Retry or request diagnostic ray sampling."));
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
			if (!FMath::IsFinite(SubjectValue)
				|| SubjectValue <= 0.0f
				|| SubjectValue > MaximumSubjectDepth)
			{
				continue;
			}
			++SubjectPixels;
			const float SceneValue = SceneDepth[Index].R;
			if (FMath::IsFinite(SceneValue)
				&& SceneValue > 0.0f
				&& SubjectValue <= SceneValue + DepthTolerance)
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
		Result->SetNumberField(
			TEXT("visibleFraction"),
			static_cast<double>(VisiblePixels) / SubjectPixels);
		Result->SetNumberField(TEXT("sampleCount"), SubjectPixels);
		Result->SetNumberField(
			TEXT("assessmentDurationMs"),
			(FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
		Result->SetArrayField(TEXT("limitations"), {
			MakeShared<FJsonValueString>(
				TEXT("Depth comparison covers rendered depth-writing subject pixels; translucent or non-depth-writing material coverage is unsupported.")),
			MakeShared<FJsonValueString>(
				TEXT("Assessment is bounded to at most 320x180 pixels, masks empty depth outside the resolved subject bounds, and uses a 1 cm depth tolerance."))
		});
		Result->SetArrayField(TEXT("occluders"), {});
		return Result;
	}
	if (Method == TEXT("subject_mask") || Method == TEXT("depth_compare"))
	{
		Result->SetStringField(TEXT("status"), TEXT("assessment_failed"));
		const TSharedRef<FJsonObject> Failure = MakeShared<FJsonObject>();
		Failure->SetStringField(TEXT("code"), TEXT("visibility_method_unavailable"));
		Failure->SetStringField(
			TEXT("message"),
			TEXT("The requested render-truthful visibility method is unavailable."));
		Failure->SetStringField(
			TEXT("recovery"),
			TEXT("Use automatic or ray_samples until the negotiated method is available."));
		Failure->SetBoolField(TEXT("retrySafe"), false);
		Result->SetObjectField(TEXT("failure"), Failure);
		return Result;
	}

	if (ProjectionStatus == TEXT("unprojectable")
		|| ViewportStatus == TEXT("fully_outside_viewport"))
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
		Result->SetNumberField(
			TEXT("assessmentDurationMs"),
			(FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
		Result->SetArrayField(TEXT("limitations"), {
			MakeShared<FJsonValueString>(
				TEXT("Collision rays are diagnostic and may differ from rendered visibility."))
		});
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
				if (SamplePreset == TEXT("sparse") && Points.Num() >= 5) break;
				const FVector Local(
					AxisSamples == 2 ? (X == 0 ? -Extent.X : Extent.X)
						: (X - 1) * Extent.X,
					AxisSamples == 2 ? (Y == 0 ? -Extent.Y : Extent.Y)
						: (Y - 1) * Extent.Y,
					AxisSamples == 2 ? (Z == 0 ? -Extent.Z : Extent.Z)
						: (Z - 1) * Extent.Z);
				Points.Add(Center + BoundsRotation.RotateVector(Local));
			}
		}
	}

	int32 VisibleSamples = 0;
	TMap<FString, int32> OccluderCounts;
	FCollisionQueryParams QueryParams(SCENE_QUERY_STAT(UEShedReviewVisibility), true);
	for (const FVector& Point : Points)
	{
		FHitResult Hit;
		const bool bHit = World->LineTraceSingleByChannel(
			Hit, CameraLocation, Point, ECC_Visibility, QueryParams);
		AActor* HitActor = bHit ? Hit.GetActor() : nullptr;
		if (!bHit || HitActor == SubjectActor || (HitActor != nullptr
			&& HitActor->IsAttachedTo(SubjectActor)))
		{
			++VisibleSamples;
		}
		else if (HitActor != nullptr && OccluderCounts.Num() < 32)
		{
			OccluderCounts.FindOrAdd(HitActor->GetPathName()) += 1;
		}
	}

	const double VisibleFraction = Points.IsEmpty()
		? 0.0
		: static_cast<double>(VisibleSamples) / Points.Num();
	Result->SetStringField(TEXT("status"), TEXT("assessed"));
	if (bIncludeClassification)
	{
		Result->SetStringField(
			TEXT("classification"),
			VisibleFraction >= 0.95 ? TEXT("clear")
				: VisibleFraction <= 0.05 ? TEXT("blocked")
				: TEXT("partial"));
	}
	const TSharedRef<FJsonObject> EffectiveMethod = MakeShared<FJsonObject>();
	EffectiveMethod->SetStringField(TEXT("method"), TEXT("ray_samples"));
	EffectiveMethod->SetNumberField(TEXT("version"), 1);
	Result->SetObjectField(TEXT("method"), EffectiveMethod);
	Result->SetNumberField(TEXT("visibleFraction"), VisibleFraction);
	Result->SetNumberField(TEXT("sampleCount"), Points.Num());
	Result->SetNumberField(
		TEXT("assessmentDurationMs"),
		(FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
	Result->SetArrayField(TEXT("limitations"), {
		MakeShared<FJsonValueString>(
			TEXT("Collision rays are diagnostic and may differ from rendered visibility, especially for translucent materials."))
	});
	TArray<TSharedPtr<FJsonValue>> Occluders;
	for (const TPair<FString, int32>& Entry : OccluderCounts)
	{
		const TSharedRef<FJsonObject> Evidence = MakeShared<FJsonObject>();
		Evidence->SetNumberField(
			TEXT("confidence"),
			static_cast<double>(Entry.Value) / Points.Num());
		const TSharedRef<FJsonObject> Locator = MakeShared<FJsonObject>();
		Locator->SetStringField(TEXT("kind"), TEXT("actor_path"));
		Locator->SetStringField(TEXT("actorPath"), Entry.Key);
		Evidence->SetObjectField(TEXT("locator"), Locator);
		Evidence->SetStringField(
			TEXT("reason"),
			TEXT("The actor blocked one or more bounded visibility rays."));
		Occluders.Add(MakeShared<FJsonValueObject>(Evidence));
	}
	Result->SetArrayField(TEXT("occluders"), Occluders);
	return Result;
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
	AddSelectionResult(Result, Actor, true);
	ResultJson = JsonString(Result);
}

void UUEShedCameraReviewLibrary::InspectReviewSubject(
	const FString& ActorPath,
	FString& ResultJson)
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
	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (World == nullptr)
	{
		Fail(TEXT("map_mismatch"), TEXT("No editor world is open."),
			TEXT("Open the expected Review Set map and resume again."));
		return;
	}
	AActor* Actor = FindActorByPath(World, ActorPath);
	if (Actor == nullptr)
	{
		Fail(TEXT("subject_not_found"), TEXT("The persisted review subject was not found."),
			TEXT("Restore the subject or discard this authoring session."));
		return;
	}
	AddSelectionResult(Result, Actor, false);
	ResultJson = JsonString(Result);
}

void UUEShedCameraReviewLibrary::GetReviewAssessmentCapabilities(FString& ResultJson)
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
	auto AddSupported = [&Methods](
		const TCHAR* RequestedMethod,
		const TCHAR* EffectiveMethod,
		const TCHAR* Limitation)
	{
		const TSharedRef<FJsonObject> Method = MakeShared<FJsonObject>();
		Method->SetStringField(TEXT("requestedMethod"), RequestedMethod);
		Method->SetStringField(TEXT("status"), TEXT("supported"));
		const TSharedRef<FJsonObject> Effective = MakeShared<FJsonObject>();
		Effective->SetStringField(TEXT("method"), EffectiveMethod);
		Effective->SetNumberField(TEXT("version"), 1);
		Method->SetObjectField(TEXT("effectiveMethod"), Effective);
		Method->SetArrayField(TEXT("limitations"), {
			MakeShared<FJsonValueString>(Limitation)
		});
		Methods.Add(MakeShared<FJsonValueObject>(Method));
	};
	auto AddUnsupported = [&Methods](const TCHAR* RequestedMethod, const TCHAR* Reason)
	{
		const TSharedRef<FJsonObject> Method = MakeShared<FJsonObject>();
		Method->SetStringField(TEXT("requestedMethod"), RequestedMethod);
		Method->SetStringField(TEXT("status"), TEXT("unsupported"));
		Method->SetStringField(TEXT("reason"), Reason);
		Methods.Add(MakeShared<FJsonValueObject>(Method));
	};
	AddSupported(
		TEXT("automatic"),
		TEXT("depth_compare"),
		TEXT("Automatic uses bounded depth comparison for depth-writing actor subjects."));
	AddSupported(
		TEXT("depth_compare"),
		TEXT("depth_compare"),
		TEXT("Depth comparison requires depth-writing actor subject pixels."));
	AddSupported(
		TEXT("ray_samples"),
		TEXT("ray_samples"),
		TEXT("Collision-ray samples are diagnostic and can disagree with rendered visibility."));
	AddUnsupported(
		TEXT("subject_mask"),
		TEXT("A render-truthful subject-mask method is not available from this producer."));
	Result->SetArrayField(TEXT("methods"), Methods);
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
	double RequestMinor = 0;
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
	(*Version)->TryGetNumberField(TEXT("minor"), RequestMinor);
	if (RequestMinor < 0 || RequestMinor > 4 || RequestMinor != FMath::FloorToDouble(RequestMinor))
	{
		Fail(TEXT("unsupported_contract"), TEXT("Review capture contract minor is unsupported."),
			TEXT("Negotiate a supported UE Shed Cameras capability."), false);
		return;
	}
	const bool bProjectionRequested = RequestMinor >= 1;
	const bool bCurrentRequest = RequestMinor >= 2;
	const bool bRawVisibility = RequestMinor >= 3;
	const bool bClearCompanionRequested = RequestMinor >= 4;
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
	FVector SubjectCenter;
	FVector SubjectExtent;
	FRotator SubjectBoundsRotation = FRotator::ZeroRotator;
	AActor* SubjectActor = nullptr;
	if (!Request->TryGetObjectField(TEXT("subject"), Subject)
		|| !(*Subject)->TryGetStringField(TEXT("kind"), SubjectKind))
	{
		Fail(TEXT("unsupported_subject"), TEXT("The Review View subject is unsupported."),
			TEXT("Use an actor_path or oriented_bounds subject."), false);
		return;
	}
	if (SubjectKind == TEXT("actor_path"))
	{
		if (!(*Subject)->TryGetStringField(TEXT("actorPath"), ActorPath))
		{
			Fail(TEXT("invalid_subject"), TEXT("The actor subject has no actorPath."),
				TEXT("Validate the Review Set capture subject."), false);
			return;
		}
		SubjectActor = FindActorByPath(World, ActorPath);
		if (SubjectActor == nullptr)
		{
			Fail(TEXT("subject_not_found"), TEXT("The Review View subject was not found."),
				TEXT("Restore the actor or update the Review View subject."), true);
			return;
		}
		SubjectActor->GetActorBounds(false, SubjectCenter, SubjectExtent, true);
	}
	else if (SubjectKind == TEXT("oriented_bounds") && bCurrentRequest)
	{
		const TSharedPtr<FJsonObject>* Bounds;
		if (!(*Subject)->TryGetObjectField(TEXT("bounds"), Bounds)
			|| !ReadBounds(*Bounds, SubjectCenter, SubjectExtent, SubjectBoundsRotation))
		{
			Fail(TEXT("invalid_subject"), TEXT("The oriented bounds are invalid."),
				TEXT("Use finite center, non-negative extent, and rotation values."), false);
			return;
		}
	}
	else
	{
		Fail(TEXT("unsupported_subject"), TEXT("The Review View subject is unsupported."),
			TEXT("Use an actor_path or oriented_bounds subject."), false);
		return;
	}

	const TSharedPtr<FJsonObject>* Pose;
	FVector Location;
	FRotator Rotation;
	double FieldOfView;
	if (bCurrentRequest)
	{
		const TSharedPtr<FJsonObject>* Viewpoint;
		FString ViewpointKind;
		if (!Request->TryGetObjectField(TEXT("viewpoint"), Viewpoint)
			|| !(*Viewpoint)->TryGetStringField(TEXT("kind"), ViewpointKind))
		{
			Fail(TEXT("invalid_viewpoint"), TEXT("The capture viewpoint is invalid."),
				TEXT("Validate the world-fixed or target-relative viewpoint."), false);
			return;
		}
		if (ViewpointKind == TEXT("world_fixed"))
		{
			if (!(*Viewpoint)->TryGetObjectField(TEXT("approvedPose"), Pose)
				|| !ReadPose(*Pose, Location, Rotation, FieldOfView))
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
			if (!(*Viewpoint)->TryGetObjectField(TEXT("relativePose"), Pose)
				|| !ReadPose(*Pose, RelativeLocation, RelativeRotation, FieldOfView))
			{
				Fail(TEXT("invalid_pose"), TEXT("The relative camera pose is invalid."),
					TEXT("Validate the finite target-relative perspective pose."), false);
				return;
			}
			const FTransform TargetTransform(
				SubjectActor->GetActorRotation(),
				SubjectActor->GetActorLocation());
			Location = TargetTransform.TransformPosition(RelativeLocation);
			Rotation = (
				TargetTransform.GetRotation() * RelativeRotation.Quaternion()).Rotator();
		}
		else
		{
			Fail(TEXT("invalid_viewpoint"), TEXT("The capture viewpoint is incompatible."),
				TEXT("Use target-relative only with an actor subject."), false);
			return;
		}
	}
	else if (!Request->TryGetObjectField(TEXT("approvedPose"), Pose)
		|| !ReadPose(*Pose, Location, Rotation, FieldOfView))
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

	FString ClearCompanionStatus = TEXT("not_requested");
	FString ClearStrategy;
	TArray<FString> ExplicitClearActorPaths;
	if (bClearCompanionRequested)
	{
		const TSharedPtr<FJsonObject>* ClearCompanion;
		if (!Request->TryGetObjectField(TEXT("clearCompanion"), ClearCompanion)
			|| !(*ClearCompanion)->TryGetStringField(TEXT("status"), ClearCompanionStatus))
		{
			Fail(TEXT("invalid_clear_companion"),
				TEXT("The Clear companion instruction is invalid."),
				TEXT("Validate the optional Clear companion against capture contract 1.4."), false);
			return;
		}
		if (ClearCompanionStatus == TEXT("requested"))
		{
			if (!(*ClearCompanion)->TryGetStringField(TEXT("strategy"), ClearStrategy)
				|| (ClearStrategy != TEXT("isolate_target")
					&& ClearStrategy != TEXT("hide_explicit")))
			{
				Fail(TEXT("invalid_clear_companion"),
					TEXT("The Clear companion strategy is unsupported."),
					TEXT("Use isolate_target or hide_explicit for the optional Clear companion."), false);
				return;
			}
			if (SubjectActor == nullptr)
			{
				Fail(TEXT("invalid_clear_companion"),
					TEXT("Clear companion capture requires an actor subject."),
					TEXT("Use Natural-only capture for an oriented-area subject."), false);
				return;
			}
			if (ClearStrategy == TEXT("hide_explicit"))
			{
				const TArray<TSharedPtr<FJsonValue>>* ActorValues;
				if (!(*ClearCompanion)->TryGetArrayField(TEXT("actors"), ActorValues)
					|| ActorValues->IsEmpty() || ActorValues->Num() > 32)
				{
					Fail(TEXT("invalid_clear_companion"),
						TEXT("Explicit Clear capture requires one to 32 actor paths."),
						TEXT("Provide bounded unique actor paths for hide_explicit Clear capture."), false);
					return;
				}
				TSet<FString> UniqueActorPaths;
				for (const TSharedPtr<FJsonValue>& ActorValue : *ActorValues)
				{
					FString ActorPathValue;
					if (!ActorValue.IsValid() || !ActorValue->TryGetString(ActorPathValue)
						|| !ActorPathValue.StartsWith(TEXT("/Game/"))
						|| UniqueActorPaths.Contains(ActorPathValue))
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
		}
		else if (ClearCompanionStatus != TEXT("not_requested"))
		{
			Fail(TEXT("invalid_clear_companion"),
				TEXT("The Clear companion status is unsupported."),
				TEXT("Use not_requested or requested for the optional Clear companion."), false);
			return;
		}
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
	TSharedPtr<FJsonObject> SubjectProjection;
	if (bProjectionRequested)
	{
		SubjectProjection = ProjectSubjectBounds(
			SubjectCenter, SubjectExtent, SubjectBoundsRotation, CaptureComponent);
	}
	TSharedPtr<FJsonObject> Visibility;
	if (bCurrentRequest)
	{
		const TSharedPtr<FJsonObject>* Assessment;
		FString AssessmentMethod = TEXT("automatic");
		FString SamplePreset = TEXT("standard");
		if (Request->TryGetObjectField(TEXT("assessment"), Assessment))
		{
			(*Assessment)->TryGetStringField(TEXT("method"), AssessmentMethod);
			(*Assessment)->TryGetStringField(TEXT("samplePreset"), SamplePreset);
		}
		Visibility = AssessVisibility(
			World,
			SubjectActor,
			Location,
			SubjectCenter,
			SubjectExtent,
			SubjectBoundsRotation,
			AssessmentMethod,
			SamplePreset,
			SubjectProjection.ToSharedRef(),
			!bRawVisibility,
			CaptureComponent,
			Width,
			Height);
	}

	FBufferArchive PngBytes;
	const bool bExported = FImageUtils::ExportRenderTarget2DAsPNG(RenderTarget, PngBytes);
	const FString CaptureDirectory = FPaths::Combine(
		FPaths::ProjectSavedDir(), TEXT("UEShed"), TEXT("ReviewStaging"), OperationId, ViewId);
	const FString CapturePath = FPaths::Combine(CaptureDirectory, TEXT("pure.png"));
	IFileManager::Get().MakeDirectory(*CaptureDirectory, true);
	const bool bWritten = bExported && FFileHelper::SaveArrayToFile(PngBytes, *CapturePath);

	if (!bExported || !bWritten)
	{
		CaptureComponent->TextureTarget = nullptr;
		World->DestroyActor(CaptureActor, false, false);
		Fail(TEXT("capture_write_failed"), TEXT("Unreal could not write the staged PNG."),
			TEXT("Check the project Saved directory and retry."), true);
		return;
	}

	TSharedPtr<FJsonObject> ClearCompanionResult;
	TArray<TSharedPtr<FJsonValue>> StagedArtifacts;
	if (bClearCompanionRequested)
	{
		ClearCompanionResult = MakeShared<FJsonObject>();
		auto RestoredClearState = []()
		{
			const TSharedRef<FJsonObject> Restoration = MakeShared<FJsonObject>();
			Restoration->SetStringField(TEXT("status"), TEXT("restored"));
			Restoration->SetStringField(
				TEXT("method"), TEXT("transient_capture_component_lists"));
			return Restoration;
		};
		auto SetClearFailure = [&ClearCompanionResult, &RestoredClearState](
			const FString& Strategy,
			const TCHAR* Code,
			const TCHAR* Message,
			const TCHAR* Recovery,
			bool bRetrySafe)
		{
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
		else
		{
			TArray<AActor*> ClearActors;
			bool bClearActorsResolved = true;
			if (ClearStrategy == TEXT("isolate_target"))
			{
				ClearActors.Add(SubjectActor);
			}
			else
			{
				for (const FString& ExplicitActorPath : ExplicitClearActorPaths)
				{
					AActor* Actor = FindActorByPath(World, ExplicitActorPath);
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
				SetClearFailure(
					ClearStrategy,
					TEXT("clear_actor_not_found"),
					TEXT("A requested Clear actor was not found after Pure capture."),
					TEXT("Update the explicit Clear actors and retry."),
					true);
			}
			else
			{
				const ESceneCapturePrimitiveRenderMode PreviousPrimitiveMode =
					CaptureComponent->PrimitiveRenderMode;
				bool bClearStateRestored = false;
				auto RestoreClearState = [&CaptureComponent, PreviousPrimitiveMode]()
				{
					CaptureComponent->ClearShowOnlyComponents();
					CaptureComponent->ClearHiddenComponents();
					CaptureComponent->PrimitiveRenderMode = PreviousPrimitiveMode;
				};
				ON_SCOPE_EXIT
				{
					if (!bClearStateRestored) RestoreClearState();
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
					for (AActor* ClearActor : ClearActors)
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

				CaptureComponent->CaptureScene();
				FBufferArchive ClearPngBytes;
				const bool bClearExported = FImageUtils::ExportRenderTarget2DAsPNG(RenderTarget, ClearPngBytes);
				const FString ClearCapturePath = FPaths::Combine(CaptureDirectory, TEXT("clear.png"));
				const bool bClearWritten = bClearExported
					&& FFileHelper::SaveArrayToFile(ClearPngBytes, *ClearCapturePath);
				RestoreClearState();
				bClearStateRestored = true;

				if (!bClearExported || !bClearWritten)
				{
					IFileManager::Get().Delete(*ClearCapturePath, false, true, true);
					SetClearFailure(
						ClearStrategy,
						TEXT("clear_capture_write_failed"),
						TEXT("Unreal could not write the optional Clear companion PNG."),
						TEXT("Check the project Saved directory and retry Clear capture."),
						true);
				}
				else
				{
					ClearCompanionResult->SetStringField(TEXT("status"), TEXT("captured"));
					ClearCompanionResult->SetStringField(TEXT("strategy"), ClearStrategy);
					ClearCompanionResult->SetArrayField(TEXT("interventions"), Interventions);
					ClearCompanionResult->SetObjectField(TEXT("restoration"), RestoredClearState());
					const TSharedRef<FJsonObject> StagedClear = MakeShared<FJsonObject>();
					StagedClear->SetStringField(TEXT("variant"), TEXT("clear"));
					StagedClear->SetStringField(
						TEXT("stagingPath"), FPaths::ConvertRelativePathToFull(ClearCapturePath));
					StagedArtifacts.Add(MakeShared<FJsonValueObject>(StagedClear));
				}
			}
		}
	}

	CaptureComponent->TextureTarget = nullptr;
	World->DestroyActor(CaptureActor, false, false);
	const bool bDirtyAfter = MapPackage->IsDirty();

	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> ResultContract = MakeShared<FJsonObject>();
	ResultContract->SetStringField(TEXT("name"), TEXT("ue-shed-review-capture"));
	const TSharedRef<FJsonObject> ResultVersion = MakeShared<FJsonObject>();
	ResultVersion->SetNumberField(TEXT("major"), 1);
	ResultVersion->SetNumberField(
		TEXT("minor"),
		bClearCompanionRequested ? 4 : bRawVisibility ? 3 : bCurrentRequest ? 2
			: bProjectionRequested ? 1 : 0);
	ResultContract->SetObjectField(TEXT("version"), ResultVersion);
	Result->SetObjectField(TEXT("contract"), ResultContract);
	Result->SetStringField(TEXT("status"), TEXT("captured"));
	Result->SetStringField(TEXT("operationId"), OperationId);
	Result->SetStringField(TEXT("viewId"), ViewId);
	if (bCurrentRequest)
	{
		const TSharedRef<FJsonObject> ResolvedSubject = MakeShared<FJsonObject>();
		if (SubjectActor != nullptr)
		{
			ResolvedSubject->SetStringField(TEXT("kind"), TEXT("actor_path"));
			ResolvedSubject->SetStringField(TEXT("actorPath"), SubjectActor->GetPathName());
			const TSharedRef<FJsonObject> Transform = MakeShared<FJsonObject>();
			Transform->SetObjectField(
				TEXT("location"), VectorJson(SubjectActor->GetActorLocation()));
			Transform->SetObjectField(
				TEXT("rotation"), RotationJson(SubjectActor->GetActorRotation()));
			ResolvedSubject->SetObjectField(TEXT("transform"), Transform);
		}
		else
		{
			ResolvedSubject->SetStringField(TEXT("kind"), TEXT("oriented_bounds"));
			ResolvedSubject->SetObjectField(
				TEXT("bounds"),
				BoundsJson(SubjectCenter, SubjectExtent, SubjectBoundsRotation));
		}
		Result->SetObjectField(TEXT("resolvedSubject"), ResolvedSubject);
		Result->SetObjectField(
			TEXT("effectiveWorldPose"), PoseJson(Location, Rotation, FieldOfView));
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
		StagedPure->SetStringField(
			TEXT("stagingPath"), FPaths::ConvertRelativePathToFull(CapturePath));
		StagedArtifacts.Insert(MakeShared<FJsonValueObject>(StagedPure), 0);
		Result->SetArrayField(TEXT("stagedArtifacts"), StagedArtifacts);
		Result->SetObjectField(TEXT("clearCompanion"), ClearCompanionResult.ToSharedRef());
	}
	else
	{
		Result->SetStringField(TEXT("stagingPath"), FPaths::ConvertRelativePathToFull(CapturePath));
	}
	if (SubjectProjection.IsValid()) Result->SetObjectField(TEXT("subjectProjection"), SubjectProjection.ToSharedRef());
	Result->SetNumberField(TEXT("width"), Width);
	Result->SetNumberField(TEXT("height"), Height);
	Result->SetNumberField(
		TEXT("captureDurationMs"), (FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
	Result->SetBoolField(TEXT("mapPackageDirtyBefore"), bDirtyBefore);
	Result->SetBoolField(TEXT("mapPackageDirtyAfter"), bDirtyAfter);
	ResultJson = JsonString(Result);
}
