#pragma once

#include "CoreMinimal.h"

namespace UEShedCameraStreamPolicy
{
inline bool KeepEditorTicking(bool bRequested, bool bEditorAuthority, bool bPaused,
    bool bHasCameras, bool bFullPipeline, bool bConnected, double DeliveryAgeSeconds)
{
    return bRequested && bEditorAuthority && !bPaused && bHasCameras && bFullPipeline
        && bConnected && DeliveryAgeSeconds >= 0.0 && DeliveryAgeSeconds < 2.0;
}

inline int32 CandidateIndex(int32 Offset, int32 Count, int32 StartCursor, int32 Focused)
{
    const bool bHasFocus = Focused >= 0 && Focused < Count;
    if (bHasFocus && Offset == 0) return Focused;
    const int32 Index = (StartCursor + Offset - (bHasFocus ? 1 : 0)) % Count;
    return bHasFocus && Index == Focused ? INDEX_NONE : Index;
}
}
