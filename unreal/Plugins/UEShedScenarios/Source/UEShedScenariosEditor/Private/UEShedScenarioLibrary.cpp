#include "UEShedScenarioLibrary.h"

#include "UEShedScenarioExecution.h"

void UUEShedScenarioLibrary::PrepareScenarioWorld(const FString& ScenarioId,
	const FString& MapPath, FString& ResultJson)
{
	GetUEShedScenarioExecution().Prepare(ScenarioId, MapPath, ResultJson);
}

void UUEShedScenarioLibrary::StartScenarioRun(const FString& RequestJson, FString& ResultJson)
{
	GetUEShedScenarioExecution().Start(RequestJson, ResultJson);
}

void UUEShedScenarioLibrary::GetScenarioRunStatus(const FString& RunId, FString& ResultJson)
{
	GetUEShedScenarioExecution().Status(RunId, ResultJson);
}

void UUEShedScenarioLibrary::CancelScenarioRun(const FString& RunId, FString& ResultJson)
{
	GetUEShedScenarioExecution().Cancel(RunId, ResultJson);
}
