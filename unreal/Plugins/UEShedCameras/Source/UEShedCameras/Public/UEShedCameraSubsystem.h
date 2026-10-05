#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "UEShedCameraSubsystem.generated.h"

struct FUEShedCameraRuntime;
class AUEShedCameraSource;
class FJsonObject;
DECLARE_DELEGATE_RetVal_FourParams(bool, FUEShedResolvePreviewVisibility, UWorld*, const TSharedPtr<FJsonObject>&, TArray<TWeakObjectPtr<AActor>>&, FString&);
UESHEDCAMERAS_API FUEShedResolvePreviewVisibility& UEShedPreviewVisibilityResolver();
/**
 * Editor hook for the provisioned feed's editor previews. Enabled reveals (and rescans) child
 * actors of editor-only owners in the world and returns how many are shown; disabled releases the
 * feed's reveal. Unbound outside the editor, where provisioning rejects editorPreviews.
 */
DECLARE_DELEGATE_RetVal_TwoParams(int32, FUEShedProvisionedEditorPreviews, UWorld*, bool);
UESHEDCAMERAS_API FUEShedProvisionedEditorPreviews& UEShedProvisionedEditorPreviewsHook();

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
	bool bKeepEditorTickingWhileStreaming = false;
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

	TArray<TWeakObjectPtr<AActor>> HiddenActors;
	FString CorrelationId;
	FString CorrelationType;
	FVector Location = FVector::ZeroVector;
	FRotator Rotation = FRotator::ZeroRotator;
	bool bOrthographic = false;
	float FieldOfViewDegrees = 60.f;
	float OrthoWidth = 512.f;
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
	virtual bool IsTickableInEditor() const override { return true; }
	virtual bool IsTickableWhenPaused() const override { return true; }

	bool ApplyConfigJson(const FString& ConfigJson, FString& Error);
	FString StatusJson() const;

	bool EnsureProvisionedCameras(
		const TArray<FUEShedProvisionedCameraSpec>& Specs,
		FString& Error,
		bool bEditorPreviews = false);
	void ClearProvisionedCameras();
	bool IsProvisionedCameraSessionActive() const;
	bool ShouldKeepEditorTicking() const;

private:
	void DiscoverAuthoredCameras();
	void RegisterSource(AUEShedCameraSource* Source);
	void ResetCameraStates();
	void ReleaseEditorPreviews();

	TUniquePtr<FUEShedCameraRuntime> Runtime;
};
