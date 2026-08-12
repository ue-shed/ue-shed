#include "UEShedTransientCapture.h"

#include "Camera/CameraTypes.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Engine/SceneCapture2D.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

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

void FUEShedTransientCapture::Capture() const
{
	Component()->CaptureScene();
}

bool FUEShedTransientCapture::ExportPng(const FString& Path, const FIntRect* Crop) const
{
	FImage Image;
	const bool bRead = Crop == nullptr
		? FImageUtils::GetRenderTargetImage(Target, Image)
		: FImageUtils::GetRenderTargetImage(Target, Image, *Crop);
	if (!bRead) return false;
	TArray64<uint8> PngBytes;
	if (!FImageUtils::CompressImage(PngBytes, TEXT("png"), Image)) return false;
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
	return FFileHelper::SaveArrayToFile(PngBytes, *Path);
}
