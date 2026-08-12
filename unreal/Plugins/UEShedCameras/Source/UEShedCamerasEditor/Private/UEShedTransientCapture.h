#pragma once

#include "CoreMinimal.h"

class ASceneCapture2D;
class USceneCaptureComponent2D;
class UTextureRenderTarget2D;
class UWorld;

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
	void ConfigurePerspective(float FieldOfViewDegrees);
	void ConfigureOrthographic(float OrthoWidth);
	void ConfigureRenderPolicy(bool bFog, bool bVolumetricFog, float LodDistanceScale);
	void Capture() const;
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
