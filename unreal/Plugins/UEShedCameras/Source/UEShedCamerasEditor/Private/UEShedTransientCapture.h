#pragma once

#include "CoreMinimal.h"

class ASceneCapture2D;
class USceneCaptureComponent2D;
class UTextureRenderTarget2D;
class UWorld;
struct FImage;

/** Editor-only, map-clean transient capture realization shared by Review and map tiles. */
class FUEShedTransientCapture
{
public:
	static TUniquePtr<FUEShedTransientCapture> Create(
		UWorld* World,
		const FVector& Location,
		const FRotator& Rotation,
		int32 Width,
		int32 Height,
		const TCHAR* NameBase);

	~FUEShedTransientCapture();

	USceneCaptureComponent2D* Component() const;
	UTextureRenderTarget2D* RenderTarget() const;
	void SetLocation(const FVector& Location);
	void ConfigurePerspective(float FieldOfViewDegrees);
	void ConfigureOrthographic(float OrthoWidth);
	void ConfigureRenderPolicy(bool bFog, bool bVolumetricFog, float LodDistanceScale);
	void ConfigureFullFidelityRenderer();
	void ConfigureSeamStableRenderer();
	void BeginPersistentCameraCut();
	void Capture() const;
	bool ReadImage(FImage& Image, const FIntRect* Crop = nullptr) const;
	static bool WritePng(const FString& Path, const FImage& Image);
	bool ExportPng(const FString& Path, const FIntRect* Crop = nullptr) const;

private:
	FUEShedTransientCapture(
		UWorld* InWorld,
		ASceneCapture2D* InActor,
		UTextureRenderTarget2D* InRenderTarget);

	UWorld* World;
	ASceneCapture2D* Actor;
	UTextureRenderTarget2D* Target;
};
