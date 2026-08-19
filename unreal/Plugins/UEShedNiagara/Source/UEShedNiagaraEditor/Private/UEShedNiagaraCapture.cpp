#include "UEShedNiagaraCapture.h"

#include "AdvancedPreviewScene.h"
#include "AssetCompilingManager.h"
#include "CanvasItem.h"
#include "CanvasTypes.h"
#include "Components/SceneCaptureComponent2D.h"
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
#include "NiagaraSystem.h"
#include "NiagaraWorldManager.h"
#include "RenderingThread.h"
#include "SceneInterface.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"

namespace UEShedNiagaraCapturePrivate
{
TSharedRef<FJsonObject> Contract(const TCHAR* Name)
{
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
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
}

FUEShedNiagaraCapture::~FUEShedNiagaraCapture()
{
	DestroyPreviewScene();
}

bool FUEShedNiagaraCapture::Initialize(
	UNiagaraSystem* InSystem,
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

	PreviewScene = MakeShared<FAdvancedPreviewScene>(FPreviewScene::ConstructionValues());
	PreviewScene->SetFloorVisibility(false);
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
		CommandletFXSystem = FFXSystemInterface::Create(World->GetFeatureLevel(), World->Scene);
		World->FXSystem = CommandletFXSystem;
	}
	if (!PreviewComponent->IsWorldReadyToRun())
	{
		OutError = TEXT("The Niagara preview world could not initialize its FX system.");
		return false;
	}
	PreviewComponent->Activate(true);

	// Activation discovers renderer resources. Finish their queued work before the first frame.
	FAssetCompilingManager::Get().FinishAllCompilation();
	if (GShaderCompilingManager)
	{
		GShaderCompilingManager->FinishAllCompilation();
	}
	PreviewComponent->MarkRenderStateDirty();
	PreviewComponent->DoDeferredRenderUpdates_Concurrent();
	FlushRenderingCommands();

	RenderTarget = NewObject<UTextureRenderTarget2D>(GetTransientPackage(), NAME_None, RF_Transient);
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

	ConfigureCaptureCamera();
	return true;
}

bool FUEShedNiagaraCapture::CaptureFrame(
	int32 FrameIndex,
	float AbsoluteTime,
	const FString& FilePath,
	FUEShedNiagaraPreviewFrame& OutFrame,
	FString& OutError)
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
		OutError = FString::Printf(
			TEXT("Failed to read render-target pixels for frame %d."), FrameIndex);
		return false;
	}

	const int32 ExpectedPixelCount = Options.Width * Options.Height;
	if (FramePixels.Num() != ExpectedPixelCount)
	{
		OutError = FString::Printf(
			TEXT("Frame %d returned %d pixels; expected %d."),
			FrameIndex,
			FramePixels.Num(),
			ExpectedPixelCount);
		return false;
	}

	OutFrame.Index = FrameIndex;
	OutFrame.TimeSeconds = AbsoluteTime;
	return ExportPng(FilePath, FramePixels, OutFrame, OutError);
}

bool FUEShedNiagaraCapture::WriteProducerReceipt(
	const FString& FilePath,
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
	Root->SetStringField(TEXT("alphaPolicy"), TEXT("scene_opacity_or_emissive_coverage_v1"));

	const TSharedRef<FJsonObject> CameraJson = MakeShared<FJsonObject>();
	CameraJson->SetNumberField(TEXT("aspectRatio"), Camera.AspectRatio);
	CameraJson->SetNumberField(TEXT("fieldOfViewDegrees"), Camera.FOV);
	CameraJson->SetObjectField(TEXT("location"), VectorToJson(ResolvedCameraLocation));
	CameraJson->SetNumberField(TEXT("orthoWidth"), Camera.OrthoWidth);
	CameraJson->SetStringField(
		TEXT("projection"), Camera.IsOrthographic() ? TEXT("orthographic") : TEXT("perspective"));
	CameraJson->SetObjectField(TEXT("rotation"), RotatorToJson(ResolvedCameraRotation));
	CameraJson->SetBoolField(TEXT("usesCustomAspectRatio"), Camera.bUseAspectRatio);
	Root->SetObjectField(TEXT("camera"), CameraJson);

	Root->SetStringField(TEXT("colorSpace"), TEXT("srgb"));
	Root->SetObjectField(TEXT("contract"), Contract(TEXT("ue-shed-niagara-preview-receipt")));

	const TSharedRef<FJsonObject> Effective = MakeShared<FJsonObject>();
	Effective->SetStringField(
		TEXT("captureMode"), Options.bRenderComponentOnly ? TEXT("component_only") : TEXT("full_scene"));
	Effective->SetNumberField(TEXT("durationSeconds"), Options.DurationSeconds);
	Effective->SetNumberField(TEXT("frameCount"), Options.FrameCount);
	Effective->SetNumberField(TEXT("frameIntervalSeconds"), FrameIntervalSeconds);
	Effective->SetNumberField(TEXT("height"), Options.Height);
	Effective->SetNumberField(TEXT("playbackFramesPerSecond"), PlaybackFramesPerSecond);
	Effective->SetNumberField(
		TEXT("simulationFramesPerSecond"), Options.SimulationFramesPerSecond);
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
		FrameJson->SetNumberField(
			TEXT("nonTransparentPixelFraction"), Frame.NonTransparentPixelFraction);
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
	if (!FFileHelper::SaveStringToFile(
			JsonText,
			*FilePath,
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

	const FMatrix SceneCaptureMatrix(
		FPlane(0, 0, 1, 0),
		FPlane(1, 0, 0, 0),
		FPlane(0, 1, 0, 0),
		FPlane(0, 0, 0, 1));
	const FMatrix ViewMatrix =
		SceneCaptureMatrix * BakerSettings->GetViewportMatrix().Inverse()
		* FRotationTranslationMatrix(
			BakerSettings->GetCameraRotation(), BakerSettings->GetCameraLocation());

	ResolvedCameraLocation = ViewMatrix.GetOrigin();
	ResolvedCameraRotation = ViewMatrix.Rotator();
	SceneCaptureComponent->SetWorldLocationAndRotation(
		ResolvedCameraLocation, ResolvedCameraRotation);
	SceneCaptureComponent->bUseCustomProjectionMatrix = true;
	SceneCaptureComponent->CustomProjectionMatrix = BakerSettings->GetProjectionMatrix();
}

void FUEShedNiagaraCapture::CaptureScene() const
{
	check(SceneCaptureComponent);
	check(RenderTarget);
	check(PreviewComponent);

	UWorld* World = PreviewComponent->GetWorld();
	check(World);

	SceneCaptureComponent->RegisterComponentWithWorld(World);
	SceneCaptureComponent->TextureTarget = RenderTarget;

	if (Options.bRenderComponentOnly)
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
	FCanvas Canvas(
		RenderTarget->GameThread_GetRenderTargetResource(),
		nullptr,
		FGameTime::CreateUndilated(WorldTime, FApp::GetDeltaTime()),
		World->Scene->GetFeatureLevel());
	Canvas.Clear(FLinearColor::Black);

	SceneCaptureComponent->CaptureScene();
	SceneCaptureComponent->TextureTarget = nullptr;
	SceneCaptureComponent->UnregisterComponent();

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

bool FUEShedNiagaraCapture::ExportPng(
	const FString& FilePath,
	TArrayView<const FFloat16Color> ImageData,
	FUEShedNiagaraPreviewFrame& OutFrame,
	FString& OutError) const
{
	TArray<FColor> ColorData;
	ColorData.Reserve(ImageData.Num());
	int64 NonTransparentPixels = 0;
	float MaximumRgb = 0.0f;
	for (const FFloat16Color& HalfColor : ImageData)
	{
		FLinearColor LinearColor = HalfColor.GetFloats();
		const float SceneOpacity = FMath::Clamp(LinearColor.A, 0.0f, 1.0f);
		const float EmissiveCoverage = FMath::Clamp(
			FMath::Max3(LinearColor.R, LinearColor.G, LinearColor.B), 0.0f, 1.0f);
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
	if (!ImageWrapper.IsValid()
		|| !ImageWrapper->SetRaw(
			ColorData.GetData(),
			ColorData.Num() * ColorData.GetTypeSize(),
			Options.Width,
			Options.Height,
			ERGBFormat::BGRA,
			8))
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
	OutFrame.NonTransparentPixelFraction = ImageData.IsEmpty()
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
