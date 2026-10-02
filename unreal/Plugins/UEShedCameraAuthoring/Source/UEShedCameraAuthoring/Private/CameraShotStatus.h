#pragma once
#include "CoreMinimal.h"
#include "UEShedCameraPreviewReview.h"

/** What a designer should know about one rendered shot, in the shot's own terms. */
struct FCameraShotStatus
{
    enum class ECategory : uint8
    {
        Shows,
        Partly,
        Missing,
        Unchecked
    };
    ECategory Category = ECategory::Unchecked;
    FString Label;
    FString Detail;
    FLinearColor Color = FLinearColor(.6f, .6f, .6f);
};

inline FCameraShotStatus DescribeShot(const FUEShedCameraSubjectVisibility *Visibility, bool bSubjectFound,
                                      bool bEditorPreviews)
{
    using EStatus = FUEShedCameraSubjectVisibility::EStatus;
    using ECategory = FCameraShotStatus::ECategory;
    const FLinearColor Good(.35f, .8f, .4f), Warn(1.f, .72f, .3f), Bad(1.f, .42f, .36f);
    FCameraShotStatus Shot;
    if (!bSubjectFound)
    {
        Shot.Label = TEXT("Subject not found in the level");
        Shot.Detail = TEXT("Load the subject actor, then refresh to check whether this shot shows it.");
        return Shot;
    }
    const int32 Percent = Visibility ? FMath::RoundToInt(Visibility->VisibleFraction * 100) : 0;
    switch (Visibility ? Visibility->Status : EStatus::NotChecked)
    {
    case EStatus::Visible:
        Shot.Category = Visibility->CutOff ? ECategory::Partly : ECategory::Shows;
        Shot.Label = Visibility->CutOff ? TEXT("Subject cut off by the frame edge") : TEXT("Subject visible");
        Shot.Detail = Visibility->CutOff ? TEXT("Nothing covers the subject, but part of it is outside the frame.")
                                         : TEXT("Nothing covers the subject in this shot.");
        Shot.Color = Visibility->CutOff ? Warn : Good;
        break;
    case EStatus::Partial:
        Shot.Category = ECategory::Partly;
        Shot.Label = FString::Printf(TEXT("Subject partly hidden · %d%% visible"), Percent);
        Shot.Detail = TEXT("Other actors cover part of the subject. Hide them on the Visibility tab, or move the camera.");
        Shot.Color = Warn;
        break;
    case EStatus::Blocked:
        Shot.Category = ECategory::Missing;
        Shot.Label = TEXT("Subject blocked from view");
        Shot.Detail = FString::Printf(TEXT("Other actors cover the subject (%d%% visible). Hide them on the "
                                           "Visibility tab, or move the camera."),
                                      Percent);
        Shot.Color = Bad;
        break;
    case EStatus::OutOfShot:
        Shot.Category = ECategory::Missing;
        Shot.Label = TEXT("Subject not in the shot");
        Shot.Detail = TEXT("The camera doesn't point at the subject.");
        Shot.Color = Bad;
        break;
    case EStatus::NotRendered:
        Shot.Category = ECategory::Missing;
        Shot.Label = TEXT("Subject didn't render");
        Shot.Detail = bEditorPreviews
                          ? TEXT("Nothing of the subject was drawn. It may be hidden, translucent or editor-only.")
                          : TEXT("Nothing of the subject was drawn. If it only shows an editor preview (for example a "
                                 "spawn volume), turn on Show editor-only previews on the Capture tab.");
        Shot.Color = Bad;
        break;
    case EStatus::Failed:
        Shot.Label = TEXT("Couldn't check the subject");
        Shot.Detail = Visibility->Message;
        break;
    default:
        Shot.Label = TEXT("Subject not checked");
        break;
    }
    return Shot;
}
