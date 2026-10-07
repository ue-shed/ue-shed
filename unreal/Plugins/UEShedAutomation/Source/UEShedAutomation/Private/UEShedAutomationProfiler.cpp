#include "UEShedAutomationProfiler.h"

#include "UEShedAutomationJson.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "ProfilingDebugging/CsvProfiler.h"

namespace UEShedAutomation
{
namespace
{
FString OutputDirectory()
{
	return FPaths::ConvertRelativePathToFull(FPaths::ProfilingDir() / TEXT("CSV/UEShed"));
}

#if CSV_PROFILER
bool SameFile(const FString& Left, const FString& Right)
{
	return FPaths::IsSamePath(FPaths::ConvertRelativePathToFull(Left), Right);
}
#endif
}

FProfiler& GetProfiler()
{
	static FProfiler Profiler;
	return Profiler;
}

void FProfiler::ResetOwnership()
{
	ExpectedFile.Reset();
	Completion = {};
	bStartPending = false;
	bStopRequested = false;
	bCaptureObserved = false;
}

void FProfiler::Tick()
{
	if (!IsInGameThread()) return;
#if CSV_PROFILER
	FCsvProfiler* Profiler = FCsvProfiler::Get();
	if (Completion.IsValid() && Completion.IsReady())
	{
		const FString Filename = Completion.Get();
		if (!Filename.IsEmpty() && SameFile(Filename, ExpectedFile)) CompletedFile = ExpectedFile;
		else
		{
			FailureCode = TEXT("capture_failed");
			FailureMessage = TEXT("CSV capture did not produce its owned output file.");
		}
		ResetOwnership();
		return;
	}
	if (ExpectedFile.IsEmpty()) return;
	if (Profiler->IsCapturing())
	{
		if (!SameFile(Profiler->GetOutputFilename(), ExpectedFile))
		{
			// BeginCapture is queued and can be ignored when another caller queued first.
			// Never infer ownership from our request alone, or stop that caller's capture.
			FailureCode = TEXT("capture_not_owned");
			FailureMessage = TEXT("Another caller owns the active CSV capture.");
			ResetOwnership();
			return;
		}
		bStartPending = false;
		bCaptureObserved = true;
		if ((bStopRequested || Profiler->IsEndCapturePending()) && !Completion.IsValid())
		{
			bStopRequested = true;
			Completion = Profiler->EndCapture();
		}
	}
	else if (!Completion.IsValid() && !Profiler->IsWritingFile())
	{
		if (bCaptureObserved)
		{
			// Another caller can end our capture. Retain evidence only after writing completes.
			if (IFileManager::Get().FileExists(*ExpectedFile)) CompletedFile = ExpectedFile;
			ResetOwnership();
		}
		else if (GFrameCounter > StartFrame + 2)
		{
			FailureCode = TEXT("capture_failed");
			FailureMessage = TEXT("The queued CSV capture did not start.");
			ResetOwnership();
		}
	}
#endif
}

void FProfiler::Request(const FString& Json, FString& ResultJson)
{
	auto Result = UEShedAutomation::Result(TEXT("unreal-automation-csv"));
	Result->SetStringField(TEXT("state"), TEXT("unavailable"));
	Result->SetStringField(TEXT("outputDirectory"), OutputDirectory());
	Result->SetField(TEXT("outputFile"), MakeShared<FJsonValueNull>());
	TSharedPtr<FJsonObject> Request;
	if (!Parse(Json, TEXT("unreal-automation-csv"), Result, Request))
	{
		Encode(Result, ResultJson);
		return;
	}
	FString Command;
	if (!Request->TryGetStringField(TEXT("command"), Command)
		|| (Command != TEXT("status") && Command != TEXT("start") && Command != TEXT("stop")))
	{
		Error(Result, TEXT("invalid_request"), TEXT("Expected status, start, or stop command."));
		Encode(Result, ResultJson);
		return;
	}
#if CSV_PROFILER
	Tick();
	FCsvProfiler* Profiler = FCsvProfiler::Get();
	bool bAccepted = true;
	if (Command == TEXT("start"))
	{
		if (bStopRequested || Profiler->IsEndCapturePending() || Profiler->IsWritingFile())
		{
			Error(Result, TEXT("capture_busy"), TEXT("Wait until the current CSV capture finishes."));
			bAccepted = false;
		}
		else if (ExpectedFile.IsEmpty() && Profiler->IsCapturing())
		{
			Error(Result, TEXT("capture_not_owned"), TEXT("Another caller owns the active CSV capture."));
			bAccepted = false;
		}
		else if (ExpectedFile.IsEmpty())
		{
			if (!IFileManager::Get().MakeDirectory(*OutputDirectory(), true))
			{
				Error(Result, TEXT("output_unavailable"), TEXT("Could not create the profiling directory."));
				bAccepted = false;
			}
			else
			{
				FailureCode.Reset();
				FailureMessage.Reset();
				CompletedFile.Reset();
				const FString Filename = TEXT("UEShed-") + FGuid::NewGuid().ToString() + TEXT(".csv");
				ExpectedFile = OutputDirectory() / Filename;
				StartFrame = GFrameCounter;
				bStartPending = true;
				Profiler->BeginCapture(-1, OutputDirectory(), Filename);
			}
		}
	}
	else if (Command == TEXT("stop"))
	{
		if (!ExpectedFile.IsEmpty())
		{
			bStopRequested = true;
			Tick(); // EndCapture refuses pending starts; wait for an owned active capture.
		}
		else if (Profiler->IsCapturing() || Profiler->IsEndCapturePending() || Profiler->IsWritingFile())
		{
			Error(Result, TEXT("capture_not_owned"), TEXT("Only a capture started by UE Shed can be stopped."));
			bAccepted = false;
		}
	}
	if (bAccepted && !FailureCode.IsEmpty())
	{
		Error(Result, *FailureCode, *FailureMessage);
		bAccepted = false;
	}
	if (bAccepted) Result->SetStringField(TEXT("status"), TEXT("ok"));
	const TCHAR* State = TEXT("idle");
	if (bStopRequested || Completion.IsValid()
		|| Profiler->IsEndCapturePending() || Profiler->IsWritingFile())
		State = TEXT("stopping");
	else if (bStartPending) State = TEXT("starting");
	else if (Profiler->IsCapturing()) State = TEXT("capturing");
	Result->SetStringField(TEXT("state"), State);
	if (!CompletedFile.IsEmpty() && !Profiler->IsCapturing())
		Result->SetStringField(TEXT("outputFile"), CompletedFile);
	else if (bCaptureObserved && !ExpectedFile.IsEmpty())
		Result->SetStringField(TEXT("outputFile"), ExpectedFile);
#else
	Error(Result, TEXT("profiler_unavailable"), TEXT("This engine build disables CSV_PROFILER."));
#endif
	Encode(Result, ResultJson);
}

void FProfiler::Shutdown()
{
	if (!IsInGameThread()) return;
#if CSV_PROFILER
	Tick();
	FCsvProfiler* Profiler = FCsvProfiler::Get();
	if (!ExpectedFile.IsEmpty() && Profiler->IsCapturing()
		&& SameFile(Profiler->GetOutputFilename(), ExpectedFile) && !Completion.IsValid())
	{
		bStopRequested = true;
		Completion = Profiler->EndCapture();
	}
	// The engine owns its command queue and writer during process exit. There is no public
	// cancellation API for queued starts. Dynamic module unloading is disabled accordingly.
#endif
}
}
