#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "UEShedCameraSubsystem.generated.h"

struct FUEShedCameraRuntime;

enum class EUEShedCameraRenderProfile : uint8
{
	FullFidelity,
	Observation
};

enum class EUEShedCameraPipelineMode : uint8
{
	FullPipeline,
	RenderOnly,
	ScheduleOnly
};

USTRUCT()
struct FUEShedCameraScheduleConfig
{
	GENERATED_BODY()

	int32 ActiveCameraCount = 8;
	double BackgroundFps = 2.0;
	int32 CaptureBudgetPerTick = 2;
	int32 FocusedCameraIndex = 0;
	double FocusedFps = 8.0;
	bool bPaused = false;
	bool bActorPov = false;
	EUEShedCameraPipelineMode PipelineMode = EUEShedCameraPipelineMode::FullPipeline;
	EUEShedCameraRenderProfile RenderProfile = EUEShedCameraRenderProfile::FullFidelity;
	int32 CaptureWidth = 320;
	int32 CaptureHeight = 180;
};

UCLASS()
class UESHEDCAMERAS_API UUEShedCameraSubsystem : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;
	virtual void OnWorldBeginPlay(UWorld& InWorld) override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;
	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;

	bool ApplyConfigJson(const FString& ConfigJson, FString& Error);
	FString StatusJson() const;

private:
	TUniquePtr<FUEShedCameraRuntime> Runtime;
};
