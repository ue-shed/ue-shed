#pragma once

#include "CoreMinimal.h"

class FAdvancedPreviewScene;
class FFXSystemInterface;
class FJsonObject;
class UNiagaraBakerSettings;
class UNiagaraComponent;
class UNiagaraSystem;
class USceneCaptureComponent2D;
class UTextureRenderTarget2D;

struct FUEShedNiagaraPreviewOptions
{
	FString RunId;
	FString SystemObjectPath;
	FString OutputDirectory;
	TSharedPtr<FJsonObject> RequestedSettings;
	int32 Width = 512;
	int32 Height = 512;
	int32 FrameCount = 64;
	int32 SimulationFramesPerSecond = 60;
	float StartSeconds = 0.0f;
	float DurationSeconds = 4.0f;
	bool bRenderComponentOnly = true;
};

struct FUEShedNiagaraPreviewFrame
{
	int32 Index = 0;
	float TimeSeconds = 0.0f;
	float MaximumRgb = 0.0f;
	float NonTransparentPixelFraction = 0.0f;
	FString RelativePath;
};

class FUEShedNiagaraCapture final
{
public:
	FUEShedNiagaraCapture() = default;
	~FUEShedNiagaraCapture();

	FUEShedNiagaraCapture(const FUEShedNiagaraCapture&) = delete;
	FUEShedNiagaraCapture& operator=(const FUEShedNiagaraCapture&) = delete;

	bool Initialize(
		UNiagaraSystem* InSystem,
		const FUEShedNiagaraPreviewOptions& InOptions,
		FString& OutError);
	bool CaptureFrame(
		int32 FrameIndex,
		float AbsoluteTime,
		const FString& FilePath,
		FUEShedNiagaraPreviewFrame& OutFrame,
		FString& OutError);
	bool WriteProducerReceipt(
		const FString& FilePath,
		const TArray<FUEShedNiagaraPreviewFrame>& Frames,
		FString& OutError) const;
	void FlushPendingWork() const;

private:
	void SetAbsoluteTime(float AbsoluteTime);
	void ConfigureCaptureCamera();
	void CaptureScene() const;
	bool ExportPng(
		const FString& FilePath,
		TArrayView<const FFloat16Color> ImageData,
		FUEShedNiagaraPreviewFrame& OutFrame,
		FString& OutError) const;
	void DestroyPreviewScene();

	UNiagaraSystem* System = nullptr;
	UNiagaraBakerSettings* BakerSettings = nullptr;
	UNiagaraComponent* PreviewComponent = nullptr;
	USceneCaptureComponent2D* SceneCaptureComponent = nullptr;
	UTextureRenderTarget2D* RenderTarget = nullptr;
	FFXSystemInterface* CommandletFXSystem = nullptr;
	TSharedPtr<FAdvancedPreviewScene> PreviewScene;
	FUEShedNiagaraPreviewOptions Options;
	FVector ResolvedCameraLocation = FVector::ZeroVector;
	FRotator ResolvedCameraRotation = FRotator::ZeroRotator;
};
