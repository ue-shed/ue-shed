#pragma once

#include "Engine/Scene.h"
#include "HAL/IConsoleManager.h"

// Shared by native authoring cameras and their SceneCapture previews.
inline void UEShedApplyCameraExposure(FPostProcessSettings &Settings, TOptional<float> FixedEV100)
{
    Settings.bOverride_AutoExposureMinBrightness = FixedEV100.IsSet();
    Settings.bOverride_AutoExposureMaxBrightness = FixedEV100.IsSet();
    if (FixedEV100.IsSet())
    {
        const auto *Extended = IConsoleManager::Get().FindConsoleVariable(
            TEXT("r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange"));
        const auto *Lens = IConsoleManager::Get().FindConsoleVariable(TEXT("r.EyeAdaptation.LensAttenuation"));
        Settings.AutoExposureMinBrightness = Settings.AutoExposureMaxBrightness =
            Extended && Extended->GetInt() ? FixedEV100.GetValue()
            : .78f / FMath::Max(.01f, Lens ? Lens->GetFloat() : .78f) * FMath::Pow(2.f, FixedEV100.GetValue());
    }
}
