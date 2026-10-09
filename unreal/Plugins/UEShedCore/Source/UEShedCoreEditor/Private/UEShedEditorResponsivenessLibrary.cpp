#include "UEShedEditorResponsivenessLibrary.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Editor/EditorPerformanceSettings.h"
#include "HAL/PlatformProcess.h"
#include "Misc/CoreDelegates.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UEShedForegroundLeases.h"

namespace
{
// Game thread only. Unreal evaluates throttle delegates from the engine tick and Slate, and Remote
// Control runs library calls from its game-thread HTTP tick, so no lock is needed.
TUniquePtr<FUEShedForegroundLeases> Leases;
FDelegateHandle ThrottleHandle;
FDelegateHandle PostEngineInitHandle;

void RegisterThrottleEntry()
{
	if (!GEditor || ThrottleHandle.IsValid()) return;
	auto Delegate = UEditorEngine::FShouldDisableCPUThrottling::CreateStatic(
		&UUEShedEditorResponsivenessLibrary::ShouldKeepEditorResponsive);
	ThrottleHandle = Delegate.GetHandle();
	GEditor->ShouldDisableCPUThrottlingDelegates.Add(MoveTemp(Delegate));
}

TSharedRef<FJsonObject> Result(const TCHAR* Status)
{
	auto Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("status"), Status);
	Json->SetNumberField(TEXT("schemaVersion"), 1);
	Json->SetNumberField(TEXT("processId"), FPlatformProcess::GetCurrentProcessId());
	Json->SetStringField(TEXT("message"), TEXT(""));
	Json->SetStringField(TEXT("recovery"), TEXT(""));
	return Json;
}

FString Finish(const TSharedRef<FJsonObject>& Json, const TCHAR* Message = TEXT(""), const TCHAR* Recovery = TEXT(""))
{
	Json->SetStringField(TEXT("message"), Message);
	Json->SetStringField(TEXT("recovery"), Recovery);
	FString Encoded;
	FJsonSerializer::Serialize(Json, TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Encoded));
	return Encoded;
}

FString Refusal(const TCHAR* Status, const TCHAR* Reason, const TCHAR* Message, const TCHAR* Recovery)
{
	auto Json = Result(Status);
	Json->SetStringField(TEXT("reason"), Reason);
	return Finish(Json, Message, Recovery);
}

FString InvalidRequest()
{
	return Refusal(TEXT("rejected"), TEXT("invalid_request"), TEXT("The request does not match the foreground lease contract."),
		TEXT("Update the UE Shed client to match this editor's UE Shed Core plugin."));
}

FString TargetChanged()
{
	return Refusal(TEXT("rejected"), TEXT("target_changed"), TEXT("The connected editor identity changed."),
		TEXT("Reconnect to the intended editor and retry."));
}

/** False with an `unsupported` result when this process cannot answer; leases also need the entry. */
bool Available(bool bRequireEntry, FString& OutRefusal)
{
	if (!Leases.IsValid())
	{
		OutRefusal = Refusal(TEXT("unsupported"), TEXT("platform"),
			TEXT("Foreground responsiveness is not implemented on this platform."),
			TEXT("Unreal's normal background policy applies."));
		return false;
	}
	if (!GEditor || !IsInGameThread() || (bRequireEntry && !ThrottleHandle.IsValid()))
	{
		OutRefusal = Refusal(TEXT("unsupported"), TEXT("editor_unavailable"),
			TEXT("This process has no interactive editor game thread to keep responsive."),
			TEXT("Connect to an interactive Unreal Editor through Remote Control."));
		return false;
	}
	return true;
}

FString Describe(const FUEShedForegroundLeases::FOutcome& Outcome)
{
	using EStatus = FUEShedForegroundLeases::EStatus;
	const FString Reason = Outcome.Reason;
	if (Outcome.Status == EStatus::Rejected)
	{
		if (Reason == TEXT("own_process"))
			return Refusal(TEXT("rejected"), Outcome.Reason, TEXT("The editor cannot lease its own process."),
				TEXT("Name the client process that owns the UE Shed window."));
		if (Reason == TEXT("lease_limit"))
			return Refusal(TEXT("rejected"), Outcome.Reason, TEXT("This editor already holds the maximum number of leases."),
				TEXT("Release an unused lease or wait for one to expire."));
		if (Reason == TEXT("lease_mismatch"))
			return Refusal(TEXT("rejected"), Outcome.Reason, TEXT("The lease belongs to a different client process."),
				TEXT("Use the lease ID this client acquired."));
		return Refusal(TEXT("rejected"), Outcome.Reason, TEXT("The client process could not be opened or has exited."),
			TEXT("Name a running local process that this user can query."));
	}
	auto Json = Result(Outcome.Status == EStatus::Granted ? TEXT("granted")
		: Outcome.Status == EStatus::Renewed ? TEXT("renewed")
		: Outcome.Status == EStatus::Released ? TEXT("released") : TEXT("expired"));
	Json->SetNumberField(TEXT("activeLeases"), Leases->Num());
	Json->SetStringField(TEXT("leaseId"), Outcome.LeaseId);
	if (Outcome.Status == EStatus::Granted || Outcome.Status == EStatus::Renewed)
	{
		Json->SetNumberField(TEXT("ttlMs"), Outcome.TtlMs);
		return Finish(Json);
	}
	if (Outcome.Status == EStatus::Released) return Finish(Json);
	Json->SetStringField(TEXT("reason"), Outcome.Reason);
	if (Reason == TEXT("client_exited"))
		return Finish(Json, TEXT("The client process exited."), TEXT("Acquire a lease from the running client."));
	if (Reason == TEXT("client_changed"))
		return Finish(Json, TEXT("The client process ID now belongs to a different process."),
			TEXT("Acquire a lease from the running client."));
	return Finish(Json, TEXT("The lease ended before it was renewed."), TEXT("Acquire a new lease."));
}
}

void UUEShedEditorResponsivenessLibrary::StartForegroundResponsiveness()
{
	if (!Leases.IsValid())
	{
		if (TUniquePtr<IUEShedForegroundPlatform> Platform = IUEShedForegroundPlatform::CreateNative())
			Leases = MakeUnique<FUEShedForegroundLeases>(MoveTemp(Platform), FPlatformProcess::GetCurrentProcessId());
	}
	if (!Leases.IsValid()) return;
	if (GEditor) RegisterThrottleEntry();
	else if (!PostEngineInitHandle.IsValid())
		PostEngineInitHandle = FCoreDelegates::OnPostEngineInit.AddStatic(&RegisterThrottleEntry);
}

void UUEShedEditorResponsivenessLibrary::ShutdownForegroundResponsiveness()
{
	FCoreDelegates::OnPostEngineInit.Remove(PostEngineInitHandle);
	PostEngineInitHandle.Reset();
	if (GEditor && ThrottleHandle.IsValid())
	{
		// The array is shared with the engine and other plugins: remove only this entry.
		GEditor->ShouldDisableCPUThrottlingDelegates.RemoveAll(
			[](const UEditorEngine::FShouldDisableCPUThrottling& Delegate) { return Delegate.GetHandle() == ThrottleHandle; });
	}
	ThrottleHandle.Reset();
	Leases.Reset();
}

bool UUEShedEditorResponsivenessLibrary::ShouldKeepEditorResponsive()
{
	return IsInGameThread() && Leases.IsValid() && Leases->DisablesThrottle();
}

bool UUEShedEditorResponsivenessLibrary::IsForegroundResponsivenessRegistered()
{
	return GEditor && ThrottleHandle.IsValid()
		&& GEditor->ShouldDisableCPUThrottlingDelegates.ContainsByPredicate(
			[](const UEditorEngine::FShouldDisableCPUThrottling& Delegate) { return Delegate.GetHandle() == ThrottleHandle; });
}

void UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(const FString& RequestJson, FString& ResultJson)
{
	FUEShedForegroundLeaseRequest Request;
	if (!ParseUEShedForegroundLeaseRequest(RequestJson, Request))
	{
		ResultJson = InvalidRequest();
		return;
	}
	if (Request.ExpectedProcessId != FPlatformProcess::GetCurrentProcessId())
	{
		ResultJson = TargetChanged();
		return;
	}
	if (!Available(true, ResultJson)) return;
	ResultJson = Describe(Request.Operation == TEXT("acquire") ? Leases->Acquire(Request.ClientProcessId, Request.TtlMs)
		: Request.Operation == TEXT("renew") ? Leases->Renew(Request.LeaseId, Request.ClientProcessId, Request.TtlMs)
		: Leases->Release(Request.LeaseId, Request.ClientProcessId));
}

void UUEShedEditorResponsivenessLibrary::GetForegroundResponsivenessState(const FString& RequestJson, FString& ResultJson)
{
	uint32 ExpectedProcessId = 0;
	if (!ParseUEShedForegroundStateRequest(RequestJson, ExpectedProcessId))
	{
		ResultJson = InvalidRequest();
		return;
	}
	if (ExpectedProcessId != FPlatformProcess::GetCurrentProcessId())
	{
		ResultJson = TargetChanged();
		return;
	}
	if (!Available(false, ResultJson)) return;
	auto Json = Result(TEXT("reported"));
	Json->SetBoolField(TEXT("registered"), IsForegroundResponsivenessRegistered());
	Json->SetNumberField(TEXT("activeLeases"), Leases->Num());
	Json->SetNumberField(TEXT("maxLeases"), FUEShedForegroundLeases::MaxLeases);
	Json->SetBoolField(TEXT("exemptionActive"), Leases->DisablesThrottle());
	Json->SetBoolField(TEXT("editorThrottling"), GEditor->ShouldThrottleCPUUsage());
	Json->SetBoolField(TEXT("throttleWhenNotForeground"), GetDefault<UEditorPerformanceSettings>()->bThrottleCPUWhenNotForeground);
	Json->SetNumberField(TEXT("minTtlMs"), FUEShedForegroundLeases::MinTtlMs);
	Json->SetNumberField(TEXT("defaultTtlMs"), FUEShedForegroundLeases::DefaultTtlMs);
	Json->SetNumberField(TEXT("maxTtlMs"), FUEShedForegroundLeases::MaxTtlMs);
	ResultJson = Finish(Json);
}
