#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
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
#endif
