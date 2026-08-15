#include "UEShedTransientCapture.h"

#include "Camera/CameraTypes.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/SceneCapture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "SceneUtils.h"

namespace
{
// PNG quality values -1 through -9 select the corresponding zlib compression level. Level one
// retains lossless pixels while favoring an interactive editor workflow over minimum file size.
constexpr int32 MapCapturePngZlibLevel = -1;

int32 RendererSetting(const TCHAR* Name, int32 Fallback, int32 Maximum)
{
	const IConsoleVariable* Variable = IConsoleManager::Get().FindConsoleVariable(Name);
	if (Variable == nullptr) return Fallback;
	return FMath::Clamp(Variable->GetInt(), 0, Maximum);
}
}

TUniquePtr<FUEShedTransientCapture> FUEShedTransientCapture::Create(
	UWorld* World,
	const FVector& Location,
	const FRotator& Rotation,
	int32 Width,
	int32 Height,
	const TCHAR* NameBase)
{
	if (World == nullptr || Width <= 0 || Height <= 0) return nullptr;
	FActorSpawnParameters SpawnParameters;
	SpawnParameters.Name = MakeUniqueObjectName(
		World->PersistentLevel, ASceneCapture2D::StaticClass(), FName(NameBase));
	SpawnParameters.ObjectFlags = RF_Transient;
	SpawnParameters.OverrideLevel = World->PersistentLevel;
	SpawnParameters.SpawnCollisionHandlingOverride =
		ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	SpawnParameters.bTemporaryEditorActor = true;
	SpawnParameters.bHideFromSceneOutliner = true;
	SpawnParameters.bCreateActorPackage = false;
	ASceneCapture2D* CaptureActor = World->SpawnActor<ASceneCapture2D>(
		Location, Rotation, SpawnParameters);
	if (CaptureActor == nullptr) return nullptr;

	UTextureRenderTarget2D* RenderTarget = NewObject<UTextureRenderTarget2D>(
		CaptureActor, NAME_None, RF_Transient);
	if (RenderTarget == nullptr)
	{
		World->DestroyActor(CaptureActor, false, false);
		return nullptr;
	}
	RenderTarget->RenderTargetFormat = RTF_RGBA8_SRGB;
	RenderTarget->ClearColor = FLinearColor::Black;
	RenderTarget->InitAutoFormat(Width, Height);
	RenderTarget->UpdateResourceImmediate(true);
	USceneCaptureComponent2D* CaptureComponent = CaptureActor->GetCaptureComponent2D();
	CaptureComponent->bCaptureEveryFrame = false;
	CaptureComponent->bCaptureOnMovement = false;
	CaptureComponent->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
	CaptureComponent->TextureTarget = RenderTarget;
	return TUniquePtr<FUEShedTransientCapture>(
		new FUEShedTransientCapture(World, CaptureActor, RenderTarget));
}

FUEShedTransientCapture::FUEShedTransientCapture(
	UWorld* InWorld,
	ASceneCapture2D* InActor,
	UTextureRenderTarget2D* InRenderTarget)
	: World(InWorld)
	, Actor(InActor)
	, Target(InRenderTarget)
{
}

FUEShedTransientCapture::~FUEShedTransientCapture()
{
	if (Actor != nullptr)
	{
		Actor->GetCaptureComponent2D()->TextureTarget = nullptr;
		if (World != nullptr) World->DestroyActor(Actor, false, false);
	}
	Actor = nullptr;
	Target = nullptr;
	World = nullptr;
}

USceneCaptureComponent2D* FUEShedTransientCapture::Component() const
{
	return Actor == nullptr ? nullptr : Actor->GetCaptureComponent2D();
}

UTextureRenderTarget2D* FUEShedTransientCapture::RenderTarget() const
{
	return Target;
}

void FUEShedTransientCapture::SetLocation(const FVector& Location)
{
	if (Actor != nullptr) Actor->SetActorLocation(Location);
}

void FUEShedTransientCapture::ConfigurePerspective(float FieldOfViewDegrees)
{
	USceneCaptureComponent2D* CaptureComponent = Component();
	CaptureComponent->ProjectionType = ECameraProjectionMode::Perspective;
	CaptureComponent->FOVAngle = FieldOfViewDegrees;
}

void FUEShedTransientCapture::ConfigureOrthographic(float OrthoWidth)
{
	USceneCaptureComponent2D* CaptureComponent = Component();
	CaptureComponent->ProjectionType = ECameraProjectionMode::Orthographic;
	CaptureComponent->OrthoWidth = OrthoWidth;
}

void FUEShedTransientCapture::ConfigureRenderPolicy(
	bool bFog,
	bool bVolumetricFog,
	float LodDistanceScale)
{
	USceneCaptureComponent2D* CaptureComponent = Component();
	CaptureComponent->LODDistanceFactor = LodDistanceScale;
	TArray<FEngineShowFlagsSetting> Settings;
	FEngineShowFlagsSetting Fog;
	Fog.ShowFlagName = TEXT("Fog");
	Fog.Enabled = bFog;
	Settings.Add(Fog);
	FEngineShowFlagsSetting VolumetricFog;
	VolumetricFog.ShowFlagName = TEXT("VolumetricFog");
	VolumetricFog.Enabled = bVolumetricFog;
	Settings.Add(VolumetricFog);
	CaptureComponent->SetShowFlagSettings(Settings);
}

void FUEShedTransientCapture::ConfigureFullFidelityRenderer()
{
	USceneCaptureComponent2D* CaptureComponent = Component();
	const EDynamicGlobalIlluminationMethod::Type GlobalIlluminationMethod =
		static_cast<EDynamicGlobalIlluminationMethod::Type>(RendererSetting(
			TEXT("r.DynamicGlobalIlluminationMethod"),
			static_cast<int32>(EDynamicGlobalIlluminationMethod::None),
			static_cast<int32>(EDynamicGlobalIlluminationMethod::Plugin)));
	const EReflectionMethod::Type ReflectionMethod =
		static_cast<EReflectionMethod::Type>(RendererSetting(
			TEXT("r.ReflectionMethod"),
			static_cast<int32>(EReflectionMethod::None),
			static_cast<int32>(EReflectionMethod::ScreenSpace)));
	const EAntiAliasingMethod AntiAliasingMethod =
		GetDefaultAntiAliasingMethod(World->GetFeatureLevel());

	// Scene captures intentionally start from reduced rendering defaults. Full fidelity restores the
	// active project's renderer choices so this independent view does not silently drop the lighting
	// and post-processing features used by the game and Level Editor viewport.
	CaptureComponent->ShowFlags.SetLighting(true);
	CaptureComponent->ShowFlags.SetPostProcessing(true);
	CaptureComponent->ShowFlags.SetTonemapper(true);
	CaptureComponent->ShowFlags.SetGlobalIllumination(true);
	CaptureComponent->ShowFlags.SetReflectionEnvironment(true);
	CaptureComponent->ShowFlags.SetLumenGlobalIllumination(
		GlobalIlluminationMethod == EDynamicGlobalIlluminationMethod::Lumen);
	CaptureComponent->ShowFlags.SetLumenReflections(
		ReflectionMethod == EReflectionMethod::Lumen);
	CaptureComponent->ShowFlags.SetAntiAliasing(AntiAliasingMethod != AAM_None);
	CaptureComponent->ShowFlags.SetTemporalAA(
		IsTemporalAccumulationBasedMethod(AntiAliasingMethod));
	CaptureComponent->bUseRayTracingIfEnabled = true;

	FPostProcessSettings& PostProcessSettings = CaptureComponent->PostProcessSettings;
	PostProcessSettings.bOverride_DynamicGlobalIlluminationMethod = true;
	PostProcessSettings.DynamicGlobalIlluminationMethod = GlobalIlluminationMethod;
	PostProcessSettings.bOverride_ReflectionMethod = true;
	PostProcessSettings.ReflectionMethod = ReflectionMethod;
	PostProcessSettings.bOverride_LumenSurfaceCacheResolution = true;
	PostProcessSettings.LumenSurfaceCacheResolution = 1.0f;
	CaptureComponent->PostProcessBlendWeight = 1.0f;
}

void FUEShedTransientCapture::ConfigureSeamStableRenderer()
{
	ConfigureFullFidelityRenderer();
	USceneCaptureComponent2D* CaptureComponent = Component();

	// These effects derive their result from one tile's pixels or temporal history. Keep the
	// project renderer, but force view-independent fallbacks so adjacent tiles see the same world.
	CaptureComponent->ShowFlags.SetTemporalAA(false);
	CaptureComponent->ShowFlags.SetMotionBlur(false);
	CaptureComponent->ShowFlags.SetEyeAdaptation(false);
	CaptureComponent->ShowFlags.SetLocalExposure(false);
	CaptureComponent->ShowFlags.SetScreenSpaceReflections(false);
	CaptureComponent->ShowFlags.SetScreenSpaceAO(false);
	CaptureComponent->ShowFlags.SetLumenScreenTraces(false);
	CaptureComponent->ShowFlags.SetLensFlares(false);

	FPostProcessSettings& PostProcessSettings = CaptureComponent->PostProcessSettings;
	PostProcessSettings.bOverride_LumenFinalGatherScreenTraces = true;
	PostProcessSettings.LumenFinalGatherScreenTraces = false;
	PostProcessSettings.bOverride_LumenReflectionsScreenTraces = true;
	PostProcessSettings.LumenReflectionsScreenTraces = false;
	PostProcessSettings.bOverride_VignetteIntensity = true;
	PostProcessSettings.VignetteIntensity = 0.0f;
	PostProcessSettings.bOverride_SceneFringeIntensity = true;
	PostProcessSettings.SceneFringeIntensity = 0.0f;
}

void FUEShedTransientCapture::BeginPersistentCameraCut()
{
	USceneCaptureComponent2D* CaptureComponent = Component();
	CaptureComponent->bAlwaysPersistRenderingState = true;
	CaptureComponent->bCameraCutThisFrame = true;
}

void FUEShedTransientCapture::Capture() const
{
	Component()->CaptureScene();
}

bool FUEShedTransientCapture::ExportPng(const FString& Path, const FIntRect* Crop) const
{
	FImage Image;
	return ReadImage(Image, Crop) && WritePng(Path, Image);
}

bool FUEShedTransientCapture::ReadImage(FImage& Image, const FIntRect* Crop) const
{
	return Crop == nullptr
		? FImageUtils::GetRenderTargetImage(Target, Image)
		: FImageUtils::GetRenderTargetImage(Target, Image, *Crop);
}

bool FUEShedTransientCapture::WritePng(const FString& Path, const FImage& Image)
{
	TArray64<uint8> PngBytes;
	if (!FImageUtils::CompressImage(PngBytes, TEXT("png"), Image, MapCapturePngZlibLevel))
		return false;
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
	return FFileHelper::SaveArrayToFile(PngBytes, *Path);
}
