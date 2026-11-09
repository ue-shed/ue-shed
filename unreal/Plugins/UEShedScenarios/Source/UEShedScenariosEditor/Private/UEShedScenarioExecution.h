#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"

class FUEShedScenarioExecution
{
public:
	// Out of line: FRunState is complete only in the implementation.
	FUEShedScenarioExecution();
	~FUEShedScenarioExecution();
	void Startup();
	void Shutdown();
	void Prepare(const FString& ScenarioId, const FString& MapPath, FString& ResultJson);
	void Start(const FString& RequestJson, FString& ResultJson);
	void Status(const FString& RunId, FString& ResultJson);
	void Cancel(const FString& RunId, FString& ResultJson);

	/**
	 * Real seconds a run may hold live-input isolation. Authored progress runs on game time, which
	 * stops while PIE is paused; this bound does not, so a paused or abandoned run cannot keep the
	 * editor's input blocked after its host has given up.
	 */
	static double OwnershipLimitSeconds(int32 DurationMs, int32 WaitTimeoutMs);

#if WITH_DEV_AUTOMATION_TESTS
	/** Admits an isolated run bound to World without PIE or a timeline, on the given clock. */
	FString StartIsolatedRunForTest(UWorld* World, int32 DurationMs, int32 WaitTimeoutMs,
		TFunction<double()> InClock, FString& ResultJson);
	/** One watchdog pass, as the core ticker runs it. */
	void CheckOwnershipForTest() { CheckOwnership(0.f); }
	/** True while this execution's run has its input preprocessor registered with Slate. */
	bool IsInputIsolatedForTest() const;
#endif

private:
	struct FRunState;
	bool Admit(TUniquePtr<FRunState> Candidate, FString& ResultJson);
	void Tick(UWorld* World, ELevelTick TickType, float DeltaSeconds);
	bool CheckOwnership(float DeltaSeconds);
	void OnEndPie(bool bSimulating);
	void Finish(const FString& Status, const FString& FailureCode = FString(),
		const FString& Message = FString(), const FString& Recovery = FString());
	bool RestoreIsolation();

	FDelegateHandle TickHandle;
	FDelegateHandle EndPieHandle;
	FTSTicker::FDelegateHandle OwnershipHandle;
	// Monotonic real time in seconds. Replaced only by ownership tests.
	TFunction<double()> Clock;
	TUniquePtr<FRunState> Run;
};

FUEShedScenarioExecution& GetUEShedScenarioExecution();
