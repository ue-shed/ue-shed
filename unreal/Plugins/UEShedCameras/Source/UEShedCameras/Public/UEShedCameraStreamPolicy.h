#pragma once

#include "CoreMinimal.h"

namespace UEShedCameraStreamPolicy
{
// A receipt can outlive its runtime while a readback or pipe write is in flight.
struct FDeliveryReceipt
{
    TAtomic<uint64> LastDeliveryCycles{ 0 };
};

class FDeliveryScope
{
public:
    TSharedRef<FDeliveryReceipt, ESPMode::ThreadSafe> Current(uint64 AuthorityEpoch)
    {
        if (!Receipt || Epoch != AuthorityEpoch) Reset(AuthorityEpoch);
        return Receipt.ToSharedRef();
    }

    void Reset(uint64 AuthorityEpoch)
    {
        Epoch = AuthorityEpoch;
        Receipt = MakeShared<FDeliveryReceipt, ESPMode::ThreadSafe>();
    }

private:
    uint64 Epoch = 0;
    TSharedPtr<FDeliveryReceipt, ESPMode::ThreadSafe> Receipt;
};

inline double ReconcileDeadline(double Deadline, double PreviousFps, double Fps,
    double Now, bool bNewlyFocused)
{
    if (bNewlyFocused) return 0.0;
    if (PreviousFps == Fps || Deadline <= 0.0) return Deadline;
    return FMath::Max(Now, Deadline - 1.0 / PreviousFps + 1.0 / Fps);
}

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
