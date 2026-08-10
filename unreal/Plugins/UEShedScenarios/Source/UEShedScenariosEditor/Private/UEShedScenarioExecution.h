#pragma once

#include "CoreMinimal.h"

class FUEShedScenarioExecution
{
public:
	void Startup();
	void Shutdown();
	void Prepare(const FString& ScenarioId, const FString& MapPath, FString& ResultJson);
	void Start(const FString& RequestJson, FString& ResultJson);
	void Status(const FString& RunId, FString& ResultJson);
	void Cancel(const FString& RunId, FString& ResultJson);

private:
	void Tick(UWorld* World, ELevelTick TickType, float DeltaSeconds);
	void OnEndPie(bool bSimulating);
	void Finish(const FString& Status, const FString& FailureCode = FString(),
		const FString& Message = FString(), const FString& Recovery = FString());
	bool RestoreIsolation();

	FDelegateHandle TickHandle;
	FDelegateHandle EndPieHandle;
	struct FRunState;
	TUniquePtr<FRunState> Run;
};

FUEShedScenarioExecution& GetUEShedScenarioExecution();
