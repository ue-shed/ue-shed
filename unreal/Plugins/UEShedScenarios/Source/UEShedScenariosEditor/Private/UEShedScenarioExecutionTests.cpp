#if WITH_DEV_AUTOMATION_TESTS
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/World.h"
#include "Misc/AutomationTest.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedScenarioExecution.h"

namespace
{
TSharedPtr<FJsonObject> ParseScenarioJson(const FString& Text)
{
	TSharedPtr<FJsonObject> Value;
	FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Value);
	return Value;
}

FString ScenarioString(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field)
{
	FString Value;
	if (Object.IsValid()) Object->TryGetStringField(Field, Value);
	return Value;
}

int32 TerminalEvents(const TSharedPtr<FJsonObject>& Result)
{
	int32 Count = 0;
	for (const TSharedPtr<FJsonValue>& Event : Result->GetArrayField(TEXT("lifecycle")))
		Count += ScenarioString(Event->AsObject(), TEXT("state")) == TEXT("terminal") ? 1 : 0;
	return Count;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedScenarioOwnershipWatchdogTest,
	"UEShed.Scenarios.OwnershipWatchdog",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedScenarioOwnershipWatchdogTest::RunTest(const FString& Parameters)
{
	UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	if (World == nullptr)
	{
		AddError(TEXT("Open an editor world."));
		return false;
	}
	// The world is not ticked during this test, so its game time stands still exactly as in a
	// paused PIE session. Only the ownership clock advances.
	FUEShedScenarioExecution Execution;
	ON_SCOPE_EXIT { Execution.Shutdown(); };
	double Now = 1000.0;
	const double GameSecondsBefore = World->GetTimeSeconds();
	FString Accepted;
	const FString RunId = Execution.StartIsolatedRunForTest(
		World, 6000, 1250, [&Now] { return Now; }, Accepted);
	if (!TestFalse(TEXT("The run is admitted: ") + Accepted, RunId.IsEmpty())) return false;
	TestTrue(TEXT("Admission installs the Slate input blocker"), Execution.IsInputIsolatedForTest());
	const double Limit = FUEShedScenarioExecution::OwnershipLimitSeconds(6000, 1250);
	TestTrue(TEXT("The limit covers the authored duration and wait"), Limit > 7.25);

	auto Status = [&Execution, &RunId] {
		FString Json;
		Execution.Status(RunId, Json);
		return ParseScenarioJson(Json);
	};
	Now += Limit - 1.0;
	Execution.CheckOwnershipForTest();
	TestEqual(TEXT("Inside the limit the run stays active"), ScenarioString(Status(), TEXT("_tag")),
		FString(TEXT("Active")));
	TestTrue(TEXT("Inside the limit the blocker stays"), Execution.IsInputIsolatedForTest());
	FString Busy;
	Execution.StartIsolatedRunForTest(World, 6000, 1250, [&Now] { return Now; }, Busy);
	TestEqual(TEXT("A second run is refused while the first owns isolation"),
		ScenarioString(ParseScenarioJson(Busy), TEXT("code")), FString(TEXT("run_active")));

	// Game time has not moved, so no game-time deadline can end the run.
	Now += 2.0;
	Execution.CheckOwnershipForTest();
	TestEqual(TEXT("Game time stood still"), World->GetTimeSeconds(), GameSecondsBefore);
	const TSharedPtr<FJsonObject> Terminal = Status();
	if (!TestEqual(TEXT("The real-time limit ends the run"), ScenarioString(Terminal, TEXT("_tag")),
		FString(TEXT("Terminal"))))
	{
		return false;
	}
	TestFalse(TEXT("The watchdog removes the blocker"), Execution.IsInputIsolatedForTest());
	const TSharedPtr<FJsonObject> Result = Terminal->GetObjectField(TEXT("result"));
	TestEqual(TEXT("The run ends cancelled"), ScenarioString(Result, TEXT("status")), FString(TEXT("cancelled")));
	TestEqual(TEXT("The failure names the ownership timeout"),
		ScenarioString(Result->GetObjectField(TEXT("failure")), TEXT("code")), FString(TEXT("ownership_timeout")));
	TestTrue(TEXT("The result reports isolation restored"),
		Result->GetObjectField(TEXT("inputIsolation"))->GetBoolField(TEXT("restored")));
	TestEqual(TEXT("The run ends once"), TerminalEvents(Result), 1);

	// Later passes, a late cancel and module shutdown neither end the run again nor touch Slate.
	Now += 60.0;
	Execution.CheckOwnershipForTest();
	FString Cancelled;
	Execution.Cancel(RunId, Cancelled);
	const TSharedPtr<FJsonObject> Later = Status()->GetObjectField(TEXT("result"));
	TestEqual(TEXT("Later passes keep the first result"), ScenarioString(Later, TEXT("status")),
		FString(TEXT("cancelled")));
	TestEqual(TEXT("Later passes do not end the run again"), TerminalEvents(Later), 1);

	FString Next;
	const FString NextRunId = Execution.StartIsolatedRunForTest(
		World, 6000, 1250, [&Now] { return Now; }, Next);
	TestFalse(TEXT("A fresh run is admitted after the watchdog: ") + Next, NextRunId.IsEmpty());
	TestTrue(TEXT("The fresh run owns its own blocker"), Execution.IsInputIsolatedForTest());
	FString CancelNext;
	Execution.Cancel(NextRunId, CancelNext);
	TestFalse(TEXT("Cancel removes the fresh run's blocker"), Execution.IsInputIsolatedForTest());
	return true;
}
#endif
