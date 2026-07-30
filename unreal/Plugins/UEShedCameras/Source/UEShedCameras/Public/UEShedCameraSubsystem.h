#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "UEShedCameraSubsystem.generated.h"

struct FUEShedCameraRuntime;
class AUEShedCameraSource;

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

enum class EUEShedCameraViewMode : uint8
{
	Overview,
	ActorPov,
	Posed
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
	EUEShedCameraViewMode ViewMode = EUEShedCameraViewMode::Overview;
	EUEShedCameraPipelineMode PipelineMode = EUEShedCameraPipelineMode::FullPipeline;
	EUEShedCameraRenderProfile RenderProfile = EUEShedCameraRenderProfile::FullFidelity;
	int32 CaptureWidth = 320;
	int32 CaptureHeight = 180;
};

USTRUCT()
struct FUEShedProvisionedCameraSpec
{
	GENERATED_BODY()

	FString CorrelationId;
	FString CorrelationType;
	FVector Location = FVector::ZeroVector;
	FRotator Rotation = FRotator::ZeroRotator;
	float FieldOfViewDegrees = 60.f;
	int32 Width = 320;
	int32 Height = 180;
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

	bool EnsureProvisionedCameras(
		const TArray<FUEShedProvisionedCameraSpec>& Specs,
		FString& Error);
	void ClearProvisionedCameras();
	bool IsProvisionedCameraSessionActive() const;

private:
	void DiscoverAuthoredCameras();
	void RegisterSource(AUEShedCameraSource* Source);
	void ResetCameraStates();

	TUniquePtr<FUEShedCameraRuntime> Runtime;
};
