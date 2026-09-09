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
#endif
