#include "UEShedCameraSource.h"

#include "Components/SceneCaptureComponent2D.h"
#include "Engine/TextureRenderTarget2D.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEShedCameraSource)

AUEShedCameraSource::AUEShedCameraSource()
{
	PrimaryActorTick.bCanEverTick = false;
	GetCaptureComponent2D()->bCaptureEveryFrame = false;
	GetCaptureComponent2D()->bCaptureOnMovement = false;
	GetCaptureComponent2D()->CaptureSource = ESceneCaptureSource::SCS_FinalColorLDR;
}

void AUEShedCameraSource::BeginPlay()
{
	Super::BeginPlay();
	if (!CameraId.IsValid())
	{
		CameraId = FGuid(0x55455348, 0x45444341, 0x4D000000 | CameraIndex, 0x00000001);
	}
	if (GetCaptureComponent2D()->TextureTarget == nullptr)
	{
		UTextureRenderTarget2D* RenderTarget = NewObject<UTextureRenderTarget2D>(this);
		RenderTarget->RenderTargetFormat = RTF_RGBA8_SRGB;
		RenderTarget->ClearColor = FLinearColor::Black;
		RenderTarget->InitAutoFormat(CaptureWidth, CaptureHeight);
		RenderTarget->UpdateResourceImmediate(true);
		GetCaptureComponent2D()->TextureTarget = RenderTarget;
	}
}
