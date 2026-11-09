#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "UEShedCameraReadbackOwnership.h"
#include "UEShedCameraStreamPolicy.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraStreamPolicyTest,
    "UEShed.Cameras.Streaming.BoundedLifecycle",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraStreamPolicyTest::RunTest(const FString& Parameters)
{
    using namespace UEShedCameraStreamPolicy;
    TestTrue(TEXT("Active editor consumer can request ticks"), KeepEditorTicking(true, true, false, true, true, true, 0.1));
    TestFalse(TEXT("Opt in required"), KeepEditorTicking(false, true, false, true, true, true, 0.1));
    TestFalse(TEXT("Play world owns rendering"), KeepEditorTicking(true, false, false, true, true, true, 0.1));
    TestFalse(TEXT("Pause releases override"), KeepEditorTicking(true, true, true, true, true, true, 0.1));
    TestFalse(TEXT("Clear releases override"), KeepEditorTicking(true, true, false, false, true, true, 0.1));
    TestFalse(TEXT("No delivery pipeline"), KeepEditorTicking(true, true, false, true, false, true, 0.1));
    TestFalse(TEXT("Disconnect releases override"), KeepEditorTicking(true, true, false, true, true, false, 0.1));
    TestFalse(TEXT("Blocked consumer expires"), KeepEditorTicking(true, true, false, true, true, true, 2.0));
    TestFalse(TEXT("No consumer yet"), KeepEditorTicking(true, true, false, true, true, true, -1.0));
    for (int32 Cursor = 0; Cursor < 6; ++Cursor)
    {
        for (int32 Focus = -1; Focus < 6; ++Focus)
        {
            TSet<int32> Visited;
            for (int32 Offset = 0; Offset < 6 + (Focus >= 0 ? 1 : 0); ++Offset)
            {
                const int32 Index = CandidateIndex(Offset, 6, Cursor, Focus);
                if (Index == INDEX_NONE) continue;
                TestFalse(TEXT("No duplicate captures within a batch"), Visited.Contains(Index));
                Visited.Add(Index);
                if (Offset == 0 && Focus >= 0) TestEqual(TEXT("Selected camera first"), Index, Focus);
            }
            TestEqual(TEXT("Every camera gets a turn"), Visited.Num(), 6);
        }
    }
    return true;
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraDeliveryScopeTest,
    "UEShed.Cameras.Streaming.DeliveryScope",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraDeliveryScopeTest::RunTest(const FString& Parameters)
{
    using namespace UEShedCameraStreamPolicy;
    FDeliveryScope Editor;
    auto BeforeClear = Editor.Current(1);
    BeforeClear->LastDeliveryCycles.Store(100);
    TestEqual(TEXT("Current stream records delivery"),
        Editor.Current(1)->LastDeliveryCycles.Load(), uint64(100));
    Editor.Reset(1);
    BeforeClear->LastDeliveryCycles.Store(200);
    TestEqual(TEXT("Late delivery after clear cannot refresh replacement"),
        Editor.Current(1)->LastDeliveryCycles.Load(), uint64(0));

    auto BeforeReprovision = Editor.Current(1);
    Editor.Reset(1);
    BeforeReprovision->LastDeliveryCycles.Store(300);
    TestEqual(TEXT("Reprovision does not inherit an in-flight write"),
        Editor.Current(1)->LastDeliveryCycles.Load(), uint64(0));

    auto BeforePlay = Editor.Current(1);
    BeforePlay->LastDeliveryCycles.Store(400);
    FDeliveryScope Play;
    Play.Current(2)->LastDeliveryCycles.Store(500);
    TestEqual(TEXT("PIE delivery cannot refresh editor"),
        Editor.Current(2)->LastDeliveryCycles.Load(), uint64(0));
    BeforePlay->LastDeliveryCycles.Store(600);
    TestEqual(TEXT("Returning editor cannot inherit pre-PIE or PIE frames"),
        Editor.Current(3)->LastDeliveryCycles.Load(), uint64(0));
    Editor.Current(3)->LastDeliveryCycles.Store(700);
    TestEqual(TEXT("New editor frame restores freshness"),
        Editor.Current(3)->LastDeliveryCycles.Load(), uint64(700));

    auto Pending = MakeShared<FDeliveryReceipt, ESPMode::ThreadSafe>();
    {
        FDeliveryScope Temporary;
        Pending = Temporary.Current(3);
    }
    Pending->LastDeliveryCycles.Store(800);
    TestEqual(TEXT("In-flight receipt safely outlives runtime"),
        Pending->LastDeliveryCycles.Load(), uint64(800));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraCadenceUpdateTest,
    "UEShed.Cameras.Streaming.CadenceUpdates",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraCadenceUpdateTest::RunTest(const FString& Parameters)
{
    using namespace UEShedCameraStreamPolicy;
    TestEqual(TEXT("Background rate increase removes old ten-second wait"),
        ReconcileDeadline(110.0, 0.1, 30.0, 100.1, false), 100.1);
    TestEqual(TEXT("Background rate decrease postpones next capture"),
        ReconcileDeadline(100.0 + 1.0 / 30.0, 30.0, 0.1, 100.01, false), 110.0);
    TestEqual(TEXT("Focused rate increase applies promptly"),
        ReconcileDeadline(110.0, 0.1, 60.0, 100.1, false), 100.1);
    TestEqual(TEXT("Focused rate decrease postpones next capture"),
        ReconcileDeadline(100.0 + 1.0 / 60.0, 60.0, 0.1, 100.01, false), 110.0);
    TestEqual(TEXT("Unchanged effective rate preserves deadline"),
        ReconcileDeadline(110.0, 0.1, 0.1, 100.1, false), 110.0);
    TestEqual(TEXT("Newly focused camera remains immediately due"),
        ReconcileDeadline(110.0, 0.1, 4.0, 100.1, true), 0.0);
    TestEqual(TEXT("Former focus adopts background cadence"),
        ReconcileDeadline(100.25, 4.0, 0.5, 100.1, false), 102.0);
    TestEqual(TEXT("Never-captured camera stays immediately due"),
        ReconcileDeadline(0.0, 0.1, 30.0, 100.1, false), 0.0);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraReadbackOwnershipTest,
    "UEShed.Cameras.Streaming.ReadbackOwnership",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

namespace
{
// The parts of the runtime readback slot that the game thread and a queued poll both touch.
struct FModelSlot
{
    UEShedCameraReadback::FSlotOwnership Ownership;
    TArray<uint8> Pixels;
    uint64 Sequence = 0;
};

// The game thread's capture step: write metadata while available, then claim the slot.
uint64 BeginModelCapture(FModelSlot& Slot, uint64 Sequence, int32 PixelCount)
{
    Slot.Sequence = Sequence;
    Slot.Pixels.Init(0, PixelCount);
    return Slot.Ownership.BeginCapture();
}

// The render-thread poll body, with the GPU readback's current contents as Source.
void RunModelPoll(FModelSlot& Slot, uint64 Generation, const TArray<uint8>& Source, bool bReadbackReady)
{
    if (!Slot.Ownership.OwnsCapture(Generation) || !bReadbackReady)
    {
        Slot.Ownership.FinishPoll(Generation, false);
        return;
    }
    Slot.Pixels = Source;
    Slot.Ownership.FinishPoll(Generation, true);
}
}

bool FUEShedCameraReadbackOwnershipTest::RunTest(const FString& Parameters)
{
    using EState = UEShedCameraReadback::FSlotOwnership::EState;
    const TArray<uint8> PixelsA = { 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A' };
    const TArray<uint8> PixelsB = { 'B', 'B', 'B', 'B' };
    FModelSlot Slot;
    TestTrue(TEXT("A new slot is available"), Slot.Ownership.IsAvailable());

    // Capture A. Two game ticks see it copying before the render thread runs any poll.
    const uint64 CaptureA = BeginModelCapture(Slot, 1, PixelsA.Num());
    uint64 FirstPoll = 0, SecondPoll = 0;
    TestTrue(TEXT("The first tick queues a poll for capture A"), Slot.Ownership.TryQueuePoll(FirstPoll));
    TestEqual(TEXT("The poll is bound to capture A"), FirstPoll, CaptureA);
    TestFalse(TEXT("A second tick queues no further poll while one is outstanding"),
        Slot.Ownership.TryQueuePoll(SecondPoll));

    // The first poll copies A; the game thread packages it and reuses the slot for a smaller B.
    RunModelPoll(Slot, FirstPoll, PixelsA, true);
    TestTrue(TEXT("Capture A is ready"), Slot.Ownership.IsReady());
    TestEqual(TEXT("A's packet carries A's sequence"), Slot.Sequence, uint64(1));
    TestTrue(TEXT("A's packet carries A's pixels"), Slot.Pixels == PixelsA);
    Slot.Ownership.Consume();
    TestTrue(TEXT("A consumed slot whose poll finished is available"), Slot.Ownership.IsAvailable());
    const uint64 CaptureB = BeginModelCapture(Slot, 2, PixelsB.Num());
    TestTrue(TEXT("Reuse starts a new capture generation"), CaptureB != CaptureA);

    // A poll queued for A runs after the reuse, before B's GPU copy, while the readback still
    // holds A. Whatever queued it, it must not own B's slot.
    TestFalse(TEXT("A poll for capture A does not own the slot reused for B"),
        Slot.Ownership.OwnsCapture(CaptureA));
    RunModelPoll(Slot, CaptureA, PixelsA, true);
    TestTrue(TEXT("A stale poll cannot publish B as ready"), Slot.Ownership.State() == EState::Copying);
    TestTrue(TEXT("A stale poll leaves B's buffer and size alone"), Slot.Pixels == TArray<uint8>{ 0, 0, 0, 0 });
    TestEqual(TEXT("B keeps its own sequence"), Slot.Sequence, uint64(2));

    // B's own poll: first before its copy finished, then after.
    uint64 PollB = 0;
    TestTrue(TEXT("B gets its own poll"), Slot.Ownership.TryQueuePoll(PollB));
    TestEqual(TEXT("B's poll is bound to B"), PollB, CaptureB);
    RunModelPoll(Slot, PollB, PixelsB, false);
    TestTrue(TEXT("A poll that finds the copy unfinished keeps B copying"), Slot.Ownership.State() == EState::Copying);
    TestTrue(TEXT("The next tick may poll B again"), Slot.Ownership.TryQueuePoll(PollB));
    RunModelPoll(Slot, PollB, PixelsB, true);
    TestTrue(TEXT("Capture B is ready"), Slot.Ownership.IsReady());
    TestTrue(TEXT("B's packet carries B's pixels"), Slot.Pixels == PixelsB);
    TestEqual(TEXT("B's packet carries B's sequence"), Slot.Sequence, uint64(2));
    Slot.Ownership.Consume();

    // A capture abandoned before submission returns the slot, but never under a queued poll.
    const uint64 CaptureC = BeginModelCapture(Slot, 3, PixelsB.Num());
    Slot.Ownership.AbandonCapture(CaptureC);
    TestTrue(TEXT("An unsubmitted capture returns the slot"), Slot.Ownership.IsAvailable());
    const uint64 CaptureD = BeginModelCapture(Slot, 4, PixelsB.Num());
    uint64 PollD = 0;
    TestTrue(TEXT("D queues a poll"), Slot.Ownership.TryQueuePoll(PollD));
    Slot.Ownership.AbandonCapture(CaptureD);
    TestFalse(TEXT("A slot with a queued poll is not available"), Slot.Ownership.IsAvailable());
    RunModelPoll(Slot, PollD, PixelsA, true);
    TestTrue(TEXT("The abandoned capture's poll copies nothing"), Slot.Pixels == TArray<uint8>{ 0, 0, 0, 0 });
    TestTrue(TEXT("The slot is available once its poll finished"), Slot.Ownership.IsAvailable());
    return true;
}
#endif
