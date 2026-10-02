#pragma once
#include "CoreMinimal.h"

/** Names shown where a designer looks for the panel: the tab, its tooltip and the Window menu. */
namespace UEShedCameraAuthoringTab
{
inline FName Id()
{
    return TEXT("UEShedCameraAuthoring");
}
inline FName PreviewId()
{
    return TEXT("UEShedCameraPreviews");
}
inline FName Icon()
{
    return TEXT("ClassIcon.CameraComponent");
}
/** Short enough for a docked tab. */
inline FText Label()
{
    return FText::FromString(TEXT("Cameras"));
}
/** Menu search matches only the visible label, so it names both the domain and the toolkit. */
inline FText MenuLabel()
{
    return FText::FromString(TEXT("Cameras (UE Shed)"));
}
inline FText ToolTip()
{
    return FText::FromString(TEXT("Set up camera views around an actor: framing, hidden actors and capture "
                                  "settings. Part of UE Shed."));
}
} // namespace UEShedCameraAuthoringTab
