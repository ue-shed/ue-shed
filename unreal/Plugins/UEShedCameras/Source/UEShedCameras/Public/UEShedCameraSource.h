#pragma once

#include "CoreMinimal.h"
#include "Engine/SceneCapture2D.h"
#include "UEShedCameraSource.generated.h"

UCLASS()
class UESHEDCAMERAS_API AUEShedCameraSource : public ASceneCapture2D
{
	GENERATED_BODY()

public:
	AUEShedCameraSource();
	virtual void BeginPlay() override;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "UE Shed Camera")
	int32 CameraIndex = 0;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "UE Shed Camera")
	FGuid CameraId;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "UE Shed Camera", meta = (ClampMin = "64", ClampMax = "2560"))
	int32 CaptureWidth = 320;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "UE Shed Camera", meta = (ClampMin = "64", ClampMax = "1440"))
	int32 CaptureHeight = 180;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "UE Shed Camera")
	TObjectPtr<AActor> ObservationTarget;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "UE Shed Camera")
	FVector ActorPovOffset = FVector(160.0, 0.0, 90.0);
};
