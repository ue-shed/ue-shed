#include "UEShedNiagaraCapture.h"

#include "AdvancedPreviewScene.h"
#include "AssetCompilingManager.h"
#include "CanvasItem.h"
#include "CanvasTypes.h"
#include "ContentStreaming.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Components/SkyLightComponent.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/PostProcessComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/TextureCube.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Dom/JsonObject.h"
#include "Engine/TextureRenderTarget2D.h"
#include "FXSystem.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Modules/ModuleManager.h"
#include "NiagaraBakerSettings.h"
#include "NiagaraBatchedElements.h"
#include "NiagaraComponent.h"
#include "NiagaraEmitter.h"
#include "NiagaraEmitterInstance.h"
#include "NiagaraSystemInstance.h"
#include "NiagaraSystemInstanceController.h"
#include "NiagaraRendererProperties.h"
#include "NiagaraSystem.h"
#include "NiagaraWorldManager.h"
#include "RenderingThread.h"
#include "SceneInterface.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"

namespace UEShedNiagaraCapturePrivate
{
class FNeutralPreviewScene : public FAdvancedPreviewScene
{
  public:
	explicit FNeutralPreviewScene(bool bShowFloor, const FString& Background)
		: FAdvancedPreviewScene(FPreviewScene::ConstructionValues())
	{
		// A uniform cubemap gives a reproducible studio background without project assets.
		UTextureCube* Cube = UTextureCube::CreateTransient(1, 1, PF_FloatRGBA);
		Cube->SRGB = false;
		FTexture2DMipMap& Mip = Cube->GetPlatformData()->Mips[0];
		auto* Pixels = static_cast<FFloat16Color*>(Mip.BulkData.Lock(LOCK_READ_WRITE));
		for (int32 Face = 0; Face < 6; ++Face)
			Pixels[Face] = FFloat16Color(FLinearColor(0.025f, 0.025f, 0.025f));
		Mip.BulkData.Unlock();
		Cube->UpdateResource();
		InstancedSkyMaterial->SetTextureParameterValueEditorOnly(TEXT("SkyBox"), Cube);
		// Backdrop brightness is separate from the unchanged lighting cubemap.
		InstancedSkyMaterial->SetScalarParameterValueEditorOnly(
			TEXT("Intensity"), Background == TEXT("light")	? 100.0f
							   : Background == TEXT("dark") ? 0.0f
															: 1.0f);
		InstancedSkyMaterial->PostEditChange();
		SetSkyCubemap(Cube);
		SkyComponent->SetVisibility(true, true);
		SkyLight->SetVisibility(true);
		DirectionalLight->SetVisibility(true);
		FloorMeshComponent->SetStaticMesh(LoadObject<UStaticMesh>(
			nullptr, TEXT("/Engine/EditorMeshes/AssetViewer/Floor_Mesh.Floor_Mesh")));
		FloorMeshComponent->SetMaterial(
			0, LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/EngineMaterials/M_Grid.M_Grid")));
		SetFloorOffset(0);
		FloorMeshComponent->SetRelativeScale3D(FVector(4, 4, 1));
		FloorMeshComponent->SetRelativeRotation(FRotator::ZeroRotator);
		FloorMeshComponent->SetVisibility(bShowFloor, true);
		if (Background != TEXT("default"))
			FloorMeshComponent->SetStaticMesh(nullptr);
		bRotateLighting = false;
		PostProcessComponent->bEnabled = false;
	}
};

TSharedRef<FJsonObject> Contract(const TCHAR* Name)
{
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 2);
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("name"), Name);
	Result->SetObjectField(TEXT("version"), Version);
	return Result;
}

TSharedRef<FJsonObject> VectorToJson(const FVector& Value)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetNumberField(TEXT("x"), Value.X);
	Json->SetNumberField(TEXT("y"), Value.Y);
	Json->SetNumberField(TEXT("z"), Value.Z);
	return Json;
}

TSharedRef<FJsonObject> RotatorToJson(const FRotator& Value)
{
	const TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetNumberField(TEXT("pitch"), Value.Pitch);
	Json->SetNumberField(TEXT("yaw"), Value.Yaw);
	Json->SetNumberField(TEXT("roll"), Value.Roll);
	return Json;
}
} // namespace UEShedNiagaraCapturePrivate

FUEShedNiagaraCapture::~FUEShedNiagaraCapture()
{
	DestroyPreviewScene();
}

bool FUEShedNiagaraCapture::Initialize(UNiagaraSystem* InSystem,
									   const FUEShedNiagaraPreviewOptions& InOptions,
									   FString& OutError)
{
	if (!InSystem)
	{
		OutError = TEXT("The Niagara System is null.");
		return false;
	}

	System = InSystem;
	Options = InOptions;
	BakerSettings = System->GetBakerSettings();
	if (!BakerSettings || BakerSettings->CameraSettings.IsEmpty())
	{
		OutError = TEXT("The Niagara System has no valid saved Baker camera.");
		return false;
	}

	System->WaitForCompilationComplete(true, false);

	PreviewComponent = NewObject<UNiagaraComponent>(GetTransientPackage(), NAME_None, RF_Transient);
	PreviewComponent->AddToRoot();
	PreviewComponent->CastShadow = true;
	PreviewComponent->bCastDynamicShadow = true;
	PreviewComponent->SetAllowScalability(false);
	PreviewComponent->SetAsset(System);
	PreviewComponent->SetForceSolo(true);
	PreviewComponent->SetAgeUpdateMode(ENiagaraAgeUpdateMode::DesiredAge);
	PreviewComponent->SetCanRenderWhileSeeking(true);
	PreviewComponent->SetMaxSimTime(0.0f);
	PreviewComponent->Activate(true);

	if (Options.RenderMode == TEXT("scene"))
		PreviewScene = MakeShared<UEShedNiagaraCapturePrivate::FNeutralPreviewScene>(
			Options.SceneProfile == TEXT("ground_impact") && Options.Background == TEXT("default"),
			Options.Background);
	else
		PreviewScene = MakeShared<FAdvancedPreviewScene>(FPreviewScene::ConstructionValues());
	if (Options.RenderMode != TEXT("scene"))
		PreviewScene->SetFloorVisibility(false, true);
	if (Options.RenderMode == TEXT("scene"))
	{
		PreviewScene->SetLightBrightness(3.0f);
		PreviewScene->SetLightColor(FColor::White);
		PreviewScene->SetLightDirection(FRotator(-45, -45, 0));
		PreviewScene->SetSkyBrightness(1.0f);
	}
	PreviewScene->AddComponent(PreviewComponent, PreviewComponent->GetRelativeTransform());
	PreviewComponent->Activate(true);

	UWorld* World = PreviewComponent->GetWorld();
	if (!World)
	{
		OutError = TEXT("Failed to create the Niagara preview world.");
		return false;
	}

	// Commandlet worlds omit their FX system. Niagara requires one even for CPU simulations.
	if (World->Scene && !World->Scene->GetFXSystem())
	{
		World->FXSystem = FFXSystemInterface::Create(World->GetFeatureLevel(), World->Scene);
		// The world owns the system (a shared pointer in 5.8, a raw pointer in 5.7).
		CommandletFXSystem = World->Scene->GetFXSystem();
	}
	if (!PreviewComponent->IsWorldReadyToRun())
	{
		OutError = TEXT("The Niagara preview world could not initialize its FX system.");
		return false;
	}
	PreviewComponent->Activate(true);

	// The first tick creates renderer instances; activation alone can expose no materials.
	SetAbsoluteTime(0.0f);
	// Finish renderer resources before capturing or measuring the animation.
	FAssetCompilingManager::Get().FinishAllCompilation();
	if (GShaderCompilingManager)
	{
		GShaderCompilingManager->FinishAllCompilation();
	}
	PreviewComponent->MarkRenderStateDirty();
	PreviewComponent->DoDeferredRenderUpdates_Concurrent();
	FlushRenderingCommands();

	// Commandlets have no viewport to request texture mips before the first capture.
	TArray<UMaterialInterface*> Materials;
	PreviewComponent->GetUsedMaterials(Materials);
	// Include authored renderer materials even before emitters have spawned particles.
	if (Materials.IsEmpty())
	{
		for (const FNiagaraEmitterHandle& Handle : System->GetEmitterHandles())
		{
			const FVersionedNiagaraEmitterData* Emitter = Handle.GetEmitterData();
			if (!Handle.GetIsEnabled() || !Emitter)
				continue;
			for (const UNiagaraRendererProperties* Renderer : Emitter->GetRenderers())
			{
				if (Renderer && Renderer->GetIsEnabled())
					Renderer->GetUsedMaterials(nullptr, Materials);
			}
		}
	}
	for (UMaterialInterface* Material : Materials)
	{
		if (Material)
		{
			Material->SetForceMipLevelsToBeResident(true, true, 0.0f);
			UE_LOG(LogTemp, Display, TEXT("Niagara preview material: %s"),
				   *Material->GetPathName());
		}
	}
	// GetUsedMaterials can include disabled emitter instances. Diagnose enabled
	// emitters and renderers, resolving user-material bindings against the solo instance.
	const auto InspectRenderer = [this](const UNiagaraRendererProperties* Renderer,
										const FNiagaraEmitterInstance* EmitterInstance)
	{
		if (!Renderer || !Renderer->GetIsEnabled())
			return;
		TArray<UMaterialInterface*> RendererMaterials;
		Renderer->GetUsedMaterials(EmitterInstance, RendererMaterials);
		for (int32 Index = 0; Index < RendererMaterials.Num(); ++Index)
		{
			if (!RendererMaterials[Index])
			{
				++MissingMaterialCount;
				UE_LOG(LogTemp, Warning, TEXT("Niagara preview missing material: %s slot %d"),
					   *Renderer->GetPathName(), Index);
			}
		}
	};
	const auto Controller = PreviewComponent->GetSystemInstanceController();
	FNiagaraSystemInstance* Instance =
		Controller && Controller->IsValid() ? Controller->GetSoloSystemInstance() : nullptr;
	if (Instance)
	{
		for (const FNiagaraEmitterInstanceRef& EmitterInstance : Instance->GetEmitters())
		{
			if (!EmitterInstance->GetEmitterHandle().GetIsEnabled())
				continue;
			EmitterInstance->ForEachEnabledRenderer(
				[&](const UNiagaraRendererProperties* Renderer)
				{ InspectRenderer(Renderer, &EmitterInstance.Get()); });
		}
	}
	else
	{
		for (const FNiagaraEmitterHandle& Handle : System->GetEmitterHandles())
		{
			const FVersionedNiagaraEmitterData* Emitter = Handle.GetEmitterData();
			if (!Handle.GetIsEnabled() || !Emitter)
				continue;
			for (const UNiagaraRendererProperties* Renderer : Emitter->GetRenderers())
				InspectRenderer(Renderer, nullptr);
		}
	}
	if (MissingMaterialCount > 0)
	{
		UE_LOG(LogTemp, Warning,
			   TEXT("Niagara preview has %d unbound material slots at initialization; inspect "
					"renderer assignments and user parameters."),
			   MissingMaterialCount);
	}
	IStreamingManager::Get().StreamAllResources(0.0f);
	IStreamingManager::Get().BlockTillAllRequestsFinished();
	FlushRenderingCommands();

	RenderTarget =
		NewObject<UTextureRenderTarget2D>(GetTransientPackage(), NAME_None, RF_Transient);
	RenderTarget->AddToRoot();
	RenderTarget->ClearColor = FLinearColor::Transparent;
	RenderTarget->TargetGamma = 1.0f;
	RenderTarget->InitCustomFormat(Options.Width, Options.Height, PF_FloatRGBA, false);
	RenderTarget->UpdateResourceImmediate(true);

	SceneCaptureComponent =
		NewObject<USceneCaptureComponent2D>(GetTransientPackage(), NAME_None, RF_Transient);
	SceneCaptureComponent->AddToRoot();
	SceneCaptureComponent->bTickInEditor = false;
	SceneCaptureComponent->SetComponentTickEnabled(false);
	SceneCaptureComponent->SetVisibility(true);
	SceneCaptureComponent->bCaptureEveryFrame = false;
	SceneCaptureComponent->bCaptureOnMovement = false;
	SceneCaptureComponent->CaptureSource = ESceneCaptureSource::SCS_SceneColorHDR;
	if (Options.RenderMode == TEXT("scene"))
	{
		SceneCaptureComponent->CaptureSource = ESceneCaptureSource::SCS_FinalToneCurveHDR;
		// Offline frames use fixed exposure and no temporal history. In a commandlet there
		// is no editor frame loop to retire per-frame Lumen/temporal allocations.
		SceneCaptureComponent->bAlwaysPersistRenderingState = false;
		SceneCaptureComponent->ShowFlags.SetTemporalAA(false);
		auto& Post = SceneCaptureComponent->PostProcessSettings;
		Post.bOverride_AutoExposureMethod = true;
		Post.AutoExposureMethod = EAutoExposureMethod::AEM_Manual;
		Post.bOverride_AutoExposureApplyPhysicalCameraExposure = true;
		Post.AutoExposureApplyPhysicalCameraExposure = false;
		Post.bOverride_AutoExposureBias = true;
		Post.AutoExposureBias = Options.ExposureCompensation;
		Post.bOverride_DynamicGlobalIlluminationMethod = true;
		Post.DynamicGlobalIlluminationMethod = EDynamicGlobalIlluminationMethod::None;
		Post.bOverride_ReflectionMethod = true;
		Post.ReflectionMethod = EReflectionMethod::None;
		Post.bOverride_MotionBlurAmount = true;
		Post.MotionBlurAmount = 0;
		Post.bOverride_VignetteIntensity = true;
		Post.VignetteIntensity = 0;
		SceneCaptureComponent->PostProcessBlendWeight = 1.0f;
		USkyLightComponent::UpdateSkyCaptureContents(World);
	}

	ConfigureCaptureCamera();
	if (!Options.CameraOverride && Options.CameraMode == TEXT("auto_fit") &&
		!FitCaptureCamera(OutError))
	{
		return false;
	}
	if (Options.RenderMode == TEXT("scene"))
	{
		PreviewComponent->SetVisibility(false, true);
		PreviewComponent->DoDeferredRenderUpdates_Concurrent();
		CaptureScene();
		FlushRenderingCommands();
		if (!RenderTarget->GameThread_GetRenderTargetResource()->ReadFloat16Pixels(
				BackgroundPixels))
		{
			OutError = TEXT("Could not capture the empty scene reference.");
			return false;
		}
		PreviewComponent->SetVisibility(true, true);
		PreviewComponent->DoDeferredRenderUpdates_Concurrent();
	}
	return true;
}

bool FUEShedNiagaraCapture::CaptureFrame(int32 FrameIndex, float AbsoluteTime,
										 const FString& FilePath,
										 FUEShedNiagaraPreviewFrame& OutFrame, FString& OutError)
{
	if (!PreviewComponent || !SceneCaptureComponent || !RenderTarget)
	{
		OutError = TEXT("The Niagara capture session is not initialized.");
		return false;
	}

	SetAbsoluteTime(AbsoluteTime);
	CaptureScene();

	TArray<FFloat16Color> FramePixels;
	if (!RenderTarget->GameThread_GetRenderTargetResource()->ReadFloat16Pixels(FramePixels))
	{
		OutError =
			FString::Printf(TEXT("Failed to read render-target pixels for frame %d."), FrameIndex);
		return false;
	}

	const int32 ExpectedPixelCount = Options.Width * Options.Height;
	if (FramePixels.Num() != ExpectedPixelCount)
	{
		OutError = FString::Printf(TEXT("Frame %d returned %d pixels; expected %d."), FrameIndex,
								   FramePixels.Num(), ExpectedPixelCount);
		return false;
	}

	OutFrame.Index = FrameIndex;
	OutFrame.TimeSeconds = AbsoluteTime;
	return ExportPng(FilePath, FramePixels, OutFrame, OutError);
}

bool FUEShedNiagaraCapture::WriteProducerReceipt(const FString& FilePath,
												 const TArray<FUEShedNiagaraPreviewFrame>& Frames,
												 FString& OutError) const
{
	using namespace UEShedNiagaraCapturePrivate;

	if (!System || !BakerSettings || !Options.RequestedSettings.IsValid())
	{
		OutError = TEXT("Cannot write a receipt for an uninitialized capture session.");
		return false;
	}

	const FNiagaraBakerCameraSettings& Camera = BakerSettings->GetCurrentCamera();
	const float FrameIntervalSeconds =
		Options.DurationSeconds / static_cast<float>(Options.FrameCount);
	const float PlaybackFramesPerSecond =
		static_cast<float>(Options.FrameCount) / Options.DurationSeconds;

	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("alphaPolicy"), Options.RenderMode == TEXT("scene")
												  ? TEXT("opaque_scene_v1")
												  : TEXT("scene_opacity_or_emissive_coverage_v1"));

	const TSharedRef<FJsonObject> CameraJson = MakeShared<FJsonObject>();
	CameraJson->SetNumberField(TEXT("aspectRatio"),
							   (Options.CameraOverride || Options.CameraMode == TEXT("auto_fit"))
								   ? static_cast<float>(Options.Width) / Options.Height
								   : Camera.AspectRatio);
	CameraJson->SetNumberField(TEXT("fieldOfViewDegrees"), SceneCaptureComponent->FOVAngle);
	CameraJson->SetObjectField(TEXT("location"), VectorToJson(ResolvedCameraLocation));
	CameraJson->SetNumberField(TEXT("orthoWidth"), SceneCaptureComponent->OrthoWidth);
	CameraJson->SetStringField(TEXT("projection"), SceneCaptureComponent->ProjectionType ==
														   ECameraProjectionMode::Orthographic
													   ? TEXT("orthographic")
													   : TEXT("perspective"));
	CameraJson->SetObjectField(TEXT("rotation"), RotatorToJson(ResolvedCameraRotation));
	CameraJson->SetBoolField(TEXT("usesCustomAspectRatio"),
							 !Options.CameraOverride && Options.CameraMode == TEXT("saved") &&
								 Camera.bUseAspectRatio);
	Root->SetObjectField(TEXT("camera"), CameraJson);

	Root->SetStringField(TEXT("colorSpace"), TEXT("srgb"));
	Root->SetNumberField(TEXT("missingMaterialCount"), MissingMaterialCount);
	Root->SetObjectField(TEXT("contract"), Contract(TEXT("ue-shed-niagara-preview-receipt")));

	const TSharedRef<FJsonObject> Effective = MakeShared<FJsonObject>();
	Effective->SetStringField(TEXT("renderMode"), Options.RenderMode);
	Effective->SetStringField(TEXT("background"), Options.Background);
	if (Options.CameraOverride)
		Effective->SetObjectField(TEXT("cameraOverride"), Options.CameraOverride.ToSharedRef());
	Effective->SetStringField(TEXT("cameraMode"), Options.CameraMode);
	Effective->SetStringField(TEXT("sceneProfile"), Options.SceneProfile);
	Effective->SetNumberField(TEXT("exposureCompensation"), Options.ExposureCompensation);
	Effective->SetNumberField(TEXT("cameraPadding"), Options.CameraPadding);
	Effective->SetStringField(TEXT("captureMode"), Options.bRenderComponentOnly
													   ? TEXT("component_only")
													   : TEXT("full_scene"));
	Effective->SetNumberField(TEXT("durationSeconds"), Options.DurationSeconds);
	Effective->SetNumberField(TEXT("frameCount"), Options.FrameCount);
	Effective->SetNumberField(TEXT("frameIntervalSeconds"), FrameIntervalSeconds);
	Effective->SetNumberField(TEXT("height"), Options.Height);
	Effective->SetNumberField(TEXT("playbackFramesPerSecond"), PlaybackFramesPerSecond);
	Effective->SetNumberField(TEXT("simulationFramesPerSecond"), Options.SimulationFramesPerSecond);
	Effective->SetNumberField(TEXT("startSeconds"), Options.StartSeconds);
	Effective->SetNumberField(TEXT("width"), Options.Width);
	Root->SetObjectField(TEXT("effectiveSettings"), Effective);

	Root->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
	TArray<TSharedPtr<FJsonValue>> FrameValues;
	FrameValues.Reserve(Frames.Num());
	for (const FUEShedNiagaraPreviewFrame& Frame : Frames)
	{
		const TSharedRef<FJsonObject> FrameJson = MakeShared<FJsonObject>();
		FrameJson->SetNumberField(TEXT("index"), Frame.Index);
		FrameJson->SetNumberField(TEXT("maximumRgb"), Frame.MaximumRgb);
		FrameJson->SetNumberField(TEXT("activityScore"), Frame.ActivityScore);
		FrameJson->SetNumberField(TEXT("edgePixelFraction"), Frame.EdgePixelFraction);
		FrameJson->SetNumberField(TEXT("nonTransparentPixelFraction"),
								  Frame.NonTransparentPixelFraction);
		FrameJson->SetStringField(TEXT("relativePath"), Frame.RelativePath);
		FrameJson->SetNumberField(TEXT("timeSeconds"), Frame.TimeSeconds);
		FrameValues.Add(MakeShared<FJsonValueObject>(FrameJson));
	}
	Root->SetArrayField(TEXT("frames"), FrameValues);
	Root->SetStringField(TEXT("generatedAtUtc"), FDateTime::UtcNow().ToIso8601());
	Root->SetObjectField(TEXT("requestedSettings"), Options.RequestedSettings.ToSharedRef());
	Root->SetStringField(TEXT("runId"), Options.RunId);
	Root->SetStringField(TEXT("status"), TEXT("complete"));
	Root->SetStringField(TEXT("systemObjectPath"), Options.SystemObjectPath);

	FString JsonText;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&JsonText);
	if (!FJsonSerializer::Serialize(Root, Writer))
	{
		OutError = TEXT("Failed to serialize the Niagara producer receipt.");
		return false;
	}
	if (!FFileHelper::SaveStringToFile(JsonText, *FilePath,
									   FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
	{
		OutError = FString::Printf(TEXT("Failed to write producer receipt '%s'."), *FilePath);
		return false;
	}
	return true;
}

void FUEShedNiagaraCapture::FlushPendingWork() const
{
	if (!PreviewComponent)
	{
		return;
	}
	if (FNiagaraWorldManager* WorldManager =
			FNiagaraWorldManager::Get(PreviewComponent->GetWorld()))
	{
		WorldManager->FlushComputeAndDeferredQueues(true);
	}
}

void FUEShedNiagaraCapture::SetAbsoluteTime(float AbsoluteTime)
{
	if (!PreviewComponent)
	{
		return;
	}

	if (!PreviewComponent->IsActive() && AbsoluteTime < PreviewComponent->GetDesiredAge())
	{
		PreviewComponent->ReinitializeSystem();
	}

	const float SeekDelta = 1.0f / static_cast<float>(Options.SimulationFramesPerSecond);
	PreviewComponent->SetSeekDelta(SeekDelta);
	PreviewComponent->SeekToDesiredAge(AbsoluteTime);

	UWorld* World = PreviewComponent->GetWorld();
	if (World)
	{
		World->TimeSeconds = AbsoluteTime;
		World->UnpausedTimeSeconds = AbsoluteTime;
		World->RealTimeSeconds = AbsoluteTime;
		World->DeltaRealTimeSeconds = SeekDelta;
		World->DeltaTimeSeconds = SeekDelta;
		World->Tick(ELevelTick::LEVELTICK_PauseTick, 0.0f);
	}

	PreviewComponent->TickComponent(SeekDelta, ELevelTick::LEVELTICK_All, nullptr);
	if (PreviewComponent->GetSceneProxy())
	{
		PreviewComponent->MarkRenderDynamicDataDirty();
	}
	else
	{
		PreviewComponent->MarkRenderStateDirty();
	}
	PreviewComponent->DoDeferredRenderUpdates_Concurrent();
	if (CommandletFXSystem && World)
	{
		CommandletFXSystem->Tick(World, SeekDelta);
	}
	if (World)
	{
		World->SendAllEndOfFrameUpdates();
		if (FNiagaraWorldManager* WorldManager = FNiagaraWorldManager::Get(World))
		{
			WorldManager->FlushComputeAndDeferredQueues(false);
		}
	}
	FlushRenderingCommands();
}

void FUEShedNiagaraCapture::ConfigureCaptureCamera()
{
	if (Options.CameraOverride)
	{
		const auto& Location = Options.CameraOverride->GetObjectField(TEXT("location"));
		const auto& Rotation = Options.CameraOverride->GetObjectField(TEXT("rotation"));
		ResolvedCameraLocation =
			FVector(Location->GetNumberField(TEXT("x")), Location->GetNumberField(TEXT("y")),
					Location->GetNumberField(TEXT("z")));
		ResolvedCameraRotation =
			FRotator(Rotation->GetNumberField(TEXT("pitch")), Rotation->GetNumberField(TEXT("yaw")),
					 Rotation->GetNumberField(TEXT("roll")));
		SceneCaptureComponent->ProjectionType = ECameraProjectionMode::Perspective;
		SceneCaptureComponent->FOVAngle =
			Options.CameraOverride->GetNumberField(TEXT("fieldOfViewDegrees"));
		SceneCaptureComponent->bUseCustomProjectionMatrix = false;
		SceneCaptureComponent->SetWorldLocationAndRotation(ResolvedCameraLocation,
														   ResolvedCameraRotation);
		return;
	}
	check(BakerSettings);
	check(SceneCaptureComponent);

	const FNiagaraBakerCameraSettings& Camera = BakerSettings->GetCurrentCamera();
	if (Camera.IsOrthographic())
	{
		SceneCaptureComponent->ProjectionType = ECameraProjectionMode::Orthographic;
		SceneCaptureComponent->OrthoWidth = Camera.OrthoWidth;
	}
	else
	{
		SceneCaptureComponent->ProjectionType = ECameraProjectionMode::Perspective;
		SceneCaptureComponent->FOVAngle = Camera.FOV;
	}

	const FMatrix SceneCaptureMatrix(FPlane(0, 0, 1, 0), FPlane(1, 0, 0, 0), FPlane(0, 1, 0, 0),
									 FPlane(0, 0, 0, 1));
	const FMatrix ViewMatrix = SceneCaptureMatrix * BakerSettings->GetViewportMatrix().Inverse() *
							   FRotationTranslationMatrix(BakerSettings->GetCameraRotation(),
														  BakerSettings->GetCameraLocation());

	ResolvedCameraLocation = ViewMatrix.GetOrigin();
	ResolvedCameraRotation = ViewMatrix.Rotator();
	SceneCaptureComponent->SetWorldLocationAndRotation(ResolvedCameraLocation,
													   ResolvedCameraRotation);
	SceneCaptureComponent->bUseCustomProjectionMatrix = true;
	SceneCaptureComponent->CustomProjectionMatrix = BakerSettings->GetProjectionMatrix();
}

bool FUEShedNiagaraCapture::FitCaptureCamera(FString& OutError)
{
	// Sample the whole requested interval, then lock the camera for the final pass.
	// GPU emitters can supply fixed/conservative bounds; saved cameras remain an explicit override.
	FBox Bounds(ForceInit);
	for (int32 Index = 0; Index < Options.FrameCount; ++Index)
	{
		SetAbsoluteTime(Options.StartSeconds +
						Index * Options.DurationSeconds / Options.FrameCount);
		CaptureScene();
		FlushRenderingCommands();
		PreviewComponent->UpdateBounds();
		const FBox Box = PreviewComponent->Bounds.GetBox();
		if (Box.IsValid && !Box.Min.ContainsNaN() && !Box.Max.ContainsNaN())
			Bounds += Box;
	}
	if (Bounds.IsValid)
	{
		const float Radius = FMath::Max(10.0f, static_cast<float>(Bounds.GetExtent().Size()));
		const float Aspect = static_cast<float>(Options.Width) / Options.Height;
		const float HalfFov =
			FMath::Atan(FMath::Tan(FMath::DegreesToRadians(22.5f)) * FMath::Min(1.0f, Aspect));
		const float Distance = Radius * Options.CameraPadding / FMath::Sin(HalfFov);
		ResolvedCameraRotation =
			FRotator(Options.SceneProfile == TEXT("ground_impact") ? -20.0f : -10.0f, 90, 0);
		ResolvedCameraLocation = Bounds.GetCenter() - ResolvedCameraRotation.Vector() * Distance;
		SceneCaptureComponent->ProjectionType = ECameraProjectionMode::Perspective;
		SceneCaptureComponent->FOVAngle = 45;
		SceneCaptureComponent->bUseCustomProjectionMatrix = false;
		SceneCaptureComponent->SetWorldLocationAndRotation(ResolvedCameraLocation,
														   ResolvedCameraRotation);

		// Niagara's fixed GPU bounds can be much larger than visible particles. Refine using
		// rendered coverage across time, excluding the identical empty scene.
		PreviewComponent->SetVisibility(false, true);
		PreviewComponent->DoDeferredRenderUpdates_Concurrent();
		CaptureScene();
		TArray<FFloat16Color> Empty;
		if (!RenderTarget->GameThread_GetRenderTargetResource()->ReadFloat16Pixels(Empty) ||
			Empty.Num() != Options.Width * Options.Height)
		{
			OutError = TEXT("Could not read the camera fitting background.");
			return false;
		}
		PreviewComponent->SetVisibility(true, true);
		PreviewComponent->ReinitializeSystem();
		PreviewComponent->Activate(true);
		FIntPoint Min(Options.Width, Options.Height), Max(-1, -1);
		TArray<float> Coverage;
		Coverage.Init(0.0f, Options.Width * Options.Height);
		float PeakCoverage = 0;
		for (int32 Index = 0; Index < Options.FrameCount; ++Index)
		{
			SetAbsoluteTime(Options.StartSeconds +
							Index * Options.DurationSeconds / Options.FrameCount);
			CaptureScene();
			TArray<FFloat16Color> Pixels;
			if (!RenderTarget->GameThread_GetRenderTargetResource()->ReadFloat16Pixels(Pixels) ||
				Pixels.Num() != Empty.Num())
			{
				OutError = TEXT("Could not read a camera fitting frame.");
				return false;
			}
			for (int32 Pixel = 0; Pixel < Pixels.Num(); ++Pixel)
			{
				const FLinearColor C = Pixels[Pixel].GetFloats(), B = Empty[Pixel].GetFloats();
				const float Difference = FMath::Max3(FMath::Abs(C.R - B.R), FMath::Abs(C.G - B.G),
													 FMath::Abs(C.B - B.B));
				Coverage[Pixel] = FMath::Max(Coverage[Pixel], Difference);
				PeakCoverage = FMath::Max(PeakCoverage, Difference);
			}
		}
		const float CoverageThreshold = FMath::Max(0.000001f, PeakCoverage * 0.01f);
		for (int32 Pixel = 0; Pixel < Coverage.Num(); ++Pixel)
		{
			if (Coverage[Pixel] < CoverageThreshold)
				continue;
			const int32 X = Pixel % Options.Width, Y = Pixel / Options.Width;
			Min.X = FMath::Min(Min.X, X);
			Min.Y = FMath::Min(Min.Y, Y);
			Max.X = FMath::Max(Max.X, X);
			Max.Y = FMath::Max(Max.Y, Y);
		}
		if (Max.X >= Min.X && Max.Y >= Min.Y)
		{
			const float Scale = FMath::Max(static_cast<float>(Max.X - Min.X + 1) / Options.Width,
										   static_cast<float>(Max.Y - Min.Y + 1) / Options.Height);
			const float HalfWidth = Distance * FMath::Tan(FMath::DegreesToRadians(22.5f));
			const FVector Right = FRotationMatrix(ResolvedCameraRotation).GetUnitAxis(EAxis::Y);
			const FVector Up = FRotationMatrix(ResolvedCameraRotation).GetUnitAxis(EAxis::Z);
			const FVector Target =
				Bounds.GetCenter() +
				Right * ((Min.X + Max.X + 1.0f) / Options.Width - 1.0f) * HalfWidth +
				Up * (1.0f - (Min.Y + Max.Y + 1.0f) / Options.Height) * HalfWidth / Aspect;
			ResolvedCameraLocation =
				Target - ResolvedCameraRotation.Vector() * Distance *
							 FMath::Clamp(Scale * Options.CameraPadding, 0.02f, 1.0f);
			SceneCaptureComponent->SetWorldLocationAndRotation(ResolvedCameraLocation,
															   ResolvedCameraRotation);
		}
	}
	PreviewComponent->ReinitializeSystem();
	PreviewComponent->Activate(true);
	return true;
}

void FUEShedNiagaraCapture::CaptureScene() const
{
	check(SceneCaptureComponent);
	check(RenderTarget);
	check(PreviewComponent);

	UWorld* World = PreviewComponent->GetWorld();
	check(World);

	if (!SceneCaptureComponent->IsRegistered())
		SceneCaptureComponent->RegisterComponentWithWorld(World);
	SceneCaptureComponent->TextureTarget = RenderTarget;

	if (Options.bRenderComponentOnly && Options.RenderMode != TEXT("scene"))
	{
		const TArray<TObjectPtr<USceneComponent>>& AttachChildren =
			PreviewComponent->GetAttachChildren();
		SceneCaptureComponent->PrimitiveRenderMode =
			ESceneCapturePrimitiveRenderMode::PRM_UseShowOnlyList;
		SceneCaptureComponent->ShowOnlyComponents.Empty(1 + AttachChildren.Num());
		SceneCaptureComponent->ShowOnlyComponents.Add(PreviewComponent);
		for (const TWeakObjectPtr<USceneComponent> WeakChildComponent : AttachChildren)
		{
			if (UPrimitiveComponent* ChildComponent =
					Cast<UPrimitiveComponent>(WeakChildComponent.Get()))
			{
				SceneCaptureComponent->ShowOnlyComponents.Add(ChildComponent);
			}
		}
	}
	else
	{
		SceneCaptureComponent->PrimitiveRenderMode =
			ESceneCapturePrimitiveRenderMode::PRM_RenderScenePrimitives;
	}

	const float WorldTime = PreviewComponent->GetDesiredAge();
	FCanvas Canvas(RenderTarget->GameThread_GetRenderTargetResource(), nullptr,
				   FGameTime::CreateUndilated(WorldTime, FApp::GetDeltaTime()),
				   World->Scene->GetFeatureLevel());
	Canvas.Clear(FLinearColor::Black);

	SceneCaptureComponent->CaptureScene();
	SceneCaptureComponent->TextureTarget = nullptr;
	// Keep one registered component for the run; teardown owns unregistration.
	if (Options.RenderMode == TEXT("scene"))
	{
		Canvas.Flush_GameThread();
		return;
	}

	// SceneColorHDR stores inverse opacity. Convert it before readback.
	FCanvasTileItem TileItem(
		FVector2D::ZeroVector,
		FVector2D(RenderTarget->GetSurfaceWidth(), RenderTarget->GetSurfaceHeight()),
		FLinearColor::White);
	TileItem.BlendMode = SE_BLEND_Opaque;
	TileItem.BatchedElementParameters = new FBatchedElementNiagaraInvertColorChannel(0);
	Canvas.DrawItem(TileItem);
	Canvas.Flush_GameThread();
}

bool FUEShedNiagaraCapture::ExportPng(const FString& FilePath,
									  TArrayView<const FFloat16Color> ImageData,
									  FUEShedNiagaraPreviewFrame& OutFrame, FString& OutError) const
{
	TArray<FColor> ColorData;
	ColorData.Reserve(ImageData.Num());
	int64 NonTransparentPixels = 0;
	float MaximumRgb = 0.0f;
	double Activity = 0;
	int32 PixelIndex = 0;
	int32 EdgePixels = 0;
	for (const FFloat16Color& HalfColor : ImageData)
	{
		FLinearColor LinearColor = HalfColor.GetFloats();
		const FLinearColor Background = BackgroundPixels.IsValidIndex(PixelIndex)
											? BackgroundPixels[PixelIndex].GetFloats()
											: FLinearColor::Black;
		const float Difference = FMath::Clamp(FMath::Max3(FMath::Abs(LinearColor.R - Background.R),
														  FMath::Abs(LinearColor.G - Background.G),
														  FMath::Abs(LinearColor.B - Background.B)),
											  0.0f, 1.0f);
		Activity += Difference;
		const int32 X = PixelIndex % Options.Width;
		const int32 Y = PixelIndex / Options.Width;
		if (Difference > 0.01f &&
			(X < 2 || Y < 2 || X >= Options.Width - 2 || Y >= Options.Height - 2))
			++EdgePixels;
		++PixelIndex;
		if (Options.RenderMode == TEXT("scene"))
		{
			LinearColor.A = 1.0f;
			MaximumRgb = FMath::Max(
				MaximumRgb,
				FMath::Clamp(FMath::Max3(LinearColor.R, LinearColor.G, LinearColor.B), 0.0f, 1.0f));
			++NonTransparentPixels;
			ColorData.Add(LinearColor.ToFColor(true));
			continue;
		}
		const float SceneOpacity = FMath::Clamp(LinearColor.A, 0.0f, 1.0f);
		const float EmissiveCoverage =
			FMath::Clamp(FMath::Max3(LinearColor.R, LinearColor.G, LinearColor.B), 0.0f, 1.0f);
		const float OutputAlpha = FMath::Max(SceneOpacity, EmissiveCoverage);
		if (OutputAlpha > UE_SMALL_NUMBER)
		{
			LinearColor.R /= OutputAlpha;
			LinearColor.G /= OutputAlpha;
			LinearColor.B /= OutputAlpha;
		}
		else
		{
			LinearColor.R = 0.0f;
			LinearColor.G = 0.0f;
			LinearColor.B = 0.0f;
		}
		LinearColor.A = OutputAlpha;
		if (OutputAlpha > 1.0f / 255.0f)
		{
			++NonTransparentPixels;
		}
		MaximumRgb = FMath::Max(
			MaximumRgb,
			FMath::Clamp(FMath::Max3(LinearColor.R, LinearColor.G, LinearColor.B), 0.0f, 1.0f));
		ColorData.Add(LinearColor.ToFColor(true));
	}

	IImageWrapperModule& ImageWrapperModule =
		FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
	const TSharedPtr<IImageWrapper> ImageWrapper =
		ImageWrapperModule.CreateImageWrapper(EImageFormat::PNG);
	if (!ImageWrapper.IsValid() ||
		!ImageWrapper->SetRaw(ColorData.GetData(), ColorData.Num() * ColorData.GetTypeSize(),
							  Options.Width, Options.Height, ERGBFormat::BGRA, 8))
	{
		OutError = TEXT("Failed to encode captured pixels as PNG.");
		return false;
	}

	const TArray64<uint8> CompressedData = ImageWrapper->GetCompressed();
	if (!FFileHelper::SaveArrayToFile(CompressedData, *FilePath))
	{
		OutError = FString::Printf(TEXT("Failed to write PNG frame '%s'."), *FilePath);
		return false;
	}

	OutFrame.MaximumRgb = MaximumRgb;
	OutFrame.ActivityScore =
		ImageData.IsEmpty() ? 0.0f : static_cast<float>(Activity / ImageData.Num());
	OutFrame.EdgePixelFraction = static_cast<float>(EdgePixels) / FMath::Max(1, ImageData.Num());
	OutFrame.NonTransparentPixelFraction =
		ImageData.IsEmpty()
			? 0.0f
			: static_cast<float>(NonTransparentPixels) / static_cast<float>(ImageData.Num());
	return true;
}

void FUEShedNiagaraCapture::DestroyPreviewScene()
{
	if (SceneCaptureComponent)
	{
		SceneCaptureComponent->TextureTarget = nullptr;
		if (SceneCaptureComponent->IsRegistered())
		{
			SceneCaptureComponent->UnregisterComponent();
		}
		SceneCaptureComponent->RemoveFromRoot();
		SceneCaptureComponent->MarkAsGarbage();
		SceneCaptureComponent = nullptr;
	}
	if (RenderTarget)
	{
		RenderTarget->RemoveFromRoot();
		RenderTarget->MarkAsGarbage();
		RenderTarget = nullptr;
	}
	if (PreviewScene && PreviewComponent)
	{
		PreviewScene->RemoveComponent(PreviewComponent);
	}
	PreviewScene.Reset();
	CommandletFXSystem = nullptr;
	if (PreviewComponent)
	{
		PreviewComponent->RemoveFromRoot();
		PreviewComponent->DestroyComponent();
		PreviewComponent = nullptr;
	}
	BakerSettings = nullptr;
	System = nullptr;
}
