#pragma once

#include "CoreMinimal.h"
#include "Async/Future.h"

namespace UEShedAutomation
{
/** Game-thread-owned control state. Never ends a capture with an unrelated filename. */
class FProfiler
{
public:
	void Request(const FString& Json, FString& ResultJson);
	void Tick();
	void Shutdown();

private:
	FString ExpectedFile;
	FString CompletedFile;
	FString FailureCode;
	FString FailureMessage;
	TSharedFuture<FString> Completion;
	uint64 StartFrame = 0;
	bool bStartPending = false;
	bool bStopRequested = false;
	bool bCaptureObserved = false;

	void ResetOwnership();
};

FProfiler& GetProfiler();
}
