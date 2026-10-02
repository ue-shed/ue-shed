#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class AActor;
class UWorld;
class USceneCaptureComponent2D;
struct FMinimalViewInfo;

/**
 * Review capture's subject projection and visibility assessment, shared with the editor review
 * snapshots so both report the same evidence. Results use the review/v1 subjectProjection and
 * visibility shapes; neither function classifies, moves actors or changes the capture's output.
 */
TSharedRef<FJsonObject> UEShedProjectReviewSubject(const FVector &Center, const FVector &Extent,
												   const FRotator &BoundsRotation, const FMinimalViewInfo &View);

/** Raw measurement (bIncludeClassification false). Method is automatic, depth_compare or ray_samples. */
TSharedRef<FJsonObject> UEShedAssessReviewVisibility(UWorld *World, AActor *Subject, const FVector &CameraLocation,
													 const FVector &Center, const FVector &Extent,
													 const FRotator &BoundsRotation, const FString &Method,
													 const TSharedRef<FJsonObject> &Projection,
													 USceneCaptureComponent2D *Capture, int32 Width, int32 Height);
