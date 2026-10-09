#if WITH_DEV_AUTOMATION_TESTS
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedEditorResponsivenessLibrary.h"
#include "UEShedForegroundLeases.h"

namespace
{
struct FFakeOs
{
	TMap<uint32, uint64> Processes;
	TSet<uint32> Exited;
	uint32 Foreground = 0;
	double Now = 100;
	int32 Opened = 0;
	int32 Closed = 0;
	int32 ForegroundLookups = 0;
};

class FFakePlatform final : public IUEShedForegroundPlatform
{
public:
	explicit FFakePlatform(TSharedRef<FFakeOs> InOs) : Os(InOs) {}
	virtual bool Open(uint32 ProcessId, FUEShedForegroundClient& OutClient) override
	{
		const uint64* Created = Os->Processes.Find(ProcessId);
		if (!Created || Os->Exited.Contains(ProcessId)) return false;
		OutClient = { ProcessId, *Created, reinterpret_cast<void*>(UPTRINT(++Os->Opened)) };
		return true;
	}
	virtual void Close(FUEShedForegroundClient& Client) override
	{
		if (Client.Handle) ++Os->Closed;
		Client.Handle = nullptr;
	}
	virtual bool IsAlive(const FUEShedForegroundClient& Client) override
	{
		return Client.Handle && !Os->Exited.Contains(Client.ProcessId);
	}
	virtual uint64 CurrentCreationTime(uint32 ProcessId) override { return Os->Processes.FindRef(ProcessId); }
	virtual uint32 ForegroundProcessId() override
	{
		++Os->ForegroundLookups;
		return Os->Foreground;
	}
	virtual double Now() override { return Os->Now; }
private:
	TSharedRef<FFakeOs> Os;
};

constexpr uint32 EditorPid = 1000;
using EStatus = FUEShedForegroundLeases::EStatus;

TSharedPtr<FJsonObject> Decode(const FString& Json)
{
	TSharedPtr<FJsonObject> Value;
	FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Value);
	return Value;
}

FString Field(const FString& Json, const TCHAR* Name)
{
	const TSharedPtr<FJsonObject> Value = Decode(Json);
	FString Result;
	if (Value.IsValid()) Value->TryGetStringField(Name, Result);
	return Result;
}

FString LeaseRequest(const TCHAR* Operation, uint32 Expected, uint32 Client, const FString& LeaseId = FString())
{
	return LeaseId.IsEmpty()
		? FString::Printf(TEXT("{\"operation\":\"%s\",\"expectedProcessId\":%u,\"clientProcessId\":%u}"), Operation, Expected, Client)
		: FString::Printf(TEXT("{\"operation\":\"%s\",\"expectedProcessId\":%u,\"clientProcessId\":%u,\"leaseId\":\"%s\"}"),
			Operation, Expected, Client, *LeaseId);
}

/** A hidden, windowless child the test owns; it can never own the foreground window. */
struct FChildProcess
{
	FProcHandle Handle;
	uint32 ProcessId = 0;
	FChildProcess()
	{
		const FString Shell = FPlatformMisc::GetEnvironmentVariable(TEXT("ComSpec"));
		Handle = FPlatformProcess::CreateProc(*Shell, TEXT("/c ping -n 120 127.0.0.1 > nul"), true, true, true,
			&ProcessId, 0, nullptr, nullptr);
	}
	void Stop()
	{
		if (!Handle.IsValid()) return;
		FPlatformProcess::TerminateProc(Handle, true);
		FPlatformProcess::WaitForProc(Handle);
		FPlatformProcess::CloseProc(Handle);
	}
	~FChildProcess() { Stop(); }
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedForegroundLeaseLogicTest, "UEShed.Core.ForegroundResponsiveness.Leases",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedForegroundLeaseLogicTest::RunTest(const FString& Parameters)
{
	auto Os = MakeShared<FFakeOs>();
	Os->Processes = { { 7, 70 }, { 8, 80 }, { EditorPid, 10 } };
	{
		FUEShedForegroundLeases Leases(MakeUnique<FFakePlatform>(Os), EditorPid);
		Os->Foreground = 7;
		TestFalse(TEXT("No lease never exempts"), Leases.DisablesThrottle());
		TestEqual(TEXT("No lease does no OS lookup"), Os->ForegroundLookups, 0);

		const auto Granted = Leases.Acquire(7, 5000);
		TestTrue(TEXT("Grant"), Granted.Status == EStatus::Granted);
		TestEqual(TEXT("Lease ID is 32 lowercase hex digits"), Granted.LeaseId, Granted.LeaseId.ToLower());
		TestEqual(TEXT("Lease ID length"), Granted.LeaseId.Len(), 32);
		TestTrue(TEXT("Foreground leaseholder exempts"), Leases.DisablesThrottle());
		Os->Foreground = 8;
		TestFalse(TEXT("Live lease whose process is not foreground does not exempt"), Leases.DisablesThrottle());
		Os->Foreground = 0;
		TestFalse(TEXT("No foreground window does not exempt"), Leases.DisablesThrottle());

		Os->Foreground = 7;
		Os->Now += 4.9;
		TestTrue(TEXT("Still exempt before expiry"), Leases.DisablesThrottle());
		Os->Now += 0.2;
		TestFalse(TEXT("Expired lease does not exempt"), Leases.DisablesThrottle());
		TestEqual(TEXT("Expired lease is dropped"), Leases.Num(), 0);
		TestEqual(TEXT("Expired lease closes its handle"), Os->Closed, 1);
		const auto Late = Leases.Renew(Granted.LeaseId, 7, 5000);
		TestTrue(TEXT("Renew after expiry ends"), Late.Status == EStatus::Expired && FString(Late.Reason) == TEXT("lease_ended"));

		const auto Second = Leases.Acquire(7, 2000);
		Os->Now += 1.5;
		const auto Renewed = Leases.Renew(Second.LeaseId, 7, 3000);
		TestTrue(TEXT("Renew"), Renewed.Status == EStatus::Renewed && Renewed.TtlMs == 3000);
		Os->Now += 2.5;
		TestTrue(TEXT("Renewal moved the expiry"), Leases.DisablesThrottle());
		const auto Wrong = Leases.Renew(Second.LeaseId, 8, 3000);
		TestTrue(TEXT("Another client cannot renew"), Wrong.Status == EStatus::Rejected && FString(Wrong.Reason) == TEXT("lease_mismatch"));
		TestTrue(TEXT("Another client cannot release"),
			Leases.Release(Second.LeaseId, 8).Status == EStatus::Rejected);
		TestTrue(TEXT("Release"), Leases.Release(Second.LeaseId, 7).Status == EStatus::Released);
		TestFalse(TEXT("Released lease does not exempt"), Leases.DisablesThrottle());
		TestTrue(TEXT("Release is idempotent"), Leases.Release(Second.LeaseId, 7).Status == EStatus::Released);

		const auto Exiting = Leases.Acquire(7, 5000);
		Os->Exited.Add(7);
		TestFalse(TEXT("Exited client does not exempt"), Leases.DisablesThrottle());
		const auto Gone = Leases.Renew(Exiting.LeaseId, 7, 5000);
		TestTrue(TEXT("Renewing an exited client ends"), Gone.Status == EStatus::Expired && FString(Gone.Reason) == TEXT("client_exited"));
		TestTrue(TEXT("Exited client cannot acquire"),
			FString(Leases.Acquire(7, 5000).Reason) == TEXT("client_unavailable"));
		Os->Exited.Remove(7);

		const auto Reused = Leases.Acquire(8, 5000);
		Os->Processes.Add(8, 81);
		const auto Changed = Leases.Renew(Reused.LeaseId, 8, 5000);
		TestTrue(TEXT("A reused process ID never inherits a lease"),
			Changed.Status == EStatus::Expired && FString(Changed.Reason) == TEXT("client_changed"));
		TestEqual(TEXT("PID reuse drops the lease"), Leases.Num(), 0);

		TestTrue(TEXT("Own process refused"), FString(Leases.Acquire(EditorPid, 5000).Reason) == TEXT("own_process"));
		TestTrue(TEXT("Unknown process refused"), FString(Leases.Acquire(99, 5000).Reason) == TEXT("client_unavailable"));
		TestEqual(TEXT("TTL is clamped to the contract"), Leases.Acquire(7, 100000).TtlMs, FUEShedForegroundLeases::MaxTtlMs);
		for (int32 Index = 1; Index < FUEShedForegroundLeases::MaxLeases; ++Index) Leases.Acquire(7, 5000);
		TestEqual(TEXT("Bounded table is full"), Leases.Num(), FUEShedForegroundLeases::MaxLeases);
		TestTrue(TEXT("Limit refuses another lease"), FString(Leases.Acquire(8, 5000).Reason) == TEXT("lease_limit"));
		Os->Foreground = 8;
		Os->ForegroundLookups = 0;
		TestFalse(TEXT("Full table, no foreground match"), Leases.DisablesThrottle());
		TestEqual(TEXT("One foreground lookup per decision"), Os->ForegroundLookups, 1);
	}
	TestEqual(TEXT("Destruction closes every handle"), Os->Closed, Os->Opened);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedForegroundContractTest, "UEShed.Core.ForegroundResponsiveness.Contract",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedForegroundContractTest::RunTest(const FString& Parameters)
{
	FString Directory;
	if (!FParse::Value(FCommandLine::Get(), TEXT("UEShedCoreContractFixtures="), Directory))
	{
		AddError(TEXT("Pass -UEShedCoreContractFixtures=<packages/protocol/contracts/core/v1/fixtures>."));
		return false;
	}
	Directory /= TEXT("foreground-responsiveness");
	TArray<FString> Names;
	IFileManager::Get().FindFiles(Names, *(Directory / TEXT("request-*.json")), true, false);
	TestTrue(TEXT("Shared request fixtures exist"), Names.Num() >= 8);
	for (const FString& Name : Names)
	{
		FString Json;
		if (!TestTrue(*FString::Printf(TEXT("Load %s"), *Name), FFileHelper::LoadFileToString(Json, *(Directory / Name)))) continue;
		FUEShedForegroundLeaseRequest Request;
		TestEqual(*FString::Printf(TEXT("Native parse matches schema for %s"), *Name),
			ParseUEShedForegroundLeaseRequest(Json, Request), Name.StartsWith(TEXT("request-valid-")));
	}

	const uint32 Self = FPlatformProcess::GetCurrentProcessId();
	FString Result;
	UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(LeaseRequest(TEXT("acquire"), Self + 1, 4), Result);
	TestEqual(TEXT("Stale editor identity is rejected"), Field(Result, TEXT("reason")), FString(TEXT("target_changed")));
	UUEShedEditorResponsivenessLibrary::GetForegroundResponsivenessState(FString::Printf(TEXT("{\"expectedProcessId\":%u}"), Self + 1), Result);
	TestEqual(TEXT("Stale state identity is rejected"), Field(Result, TEXT("reason")), FString(TEXT("target_changed")));
	UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(TEXT("not json"), Result);
	TestEqual(TEXT("Malformed request"), Field(Result, TEXT("reason")), FString(TEXT("invalid_request")));
#if PLATFORM_WINDOWS
	UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(LeaseRequest(TEXT("acquire"), Self, Self), Result);
	TestEqual(TEXT("The editor cannot lease itself"), Field(Result, TEXT("reason")), FString(TEXT("own_process")));
	UUEShedEditorResponsivenessLibrary::GetForegroundResponsivenessState(FString::Printf(TEXT("{\"expectedProcessId\":%u}"), Self), Result);
	const TSharedPtr<FJsonObject> State = Decode(Result);
	TestEqual(TEXT("State reported"), Field(Result, TEXT("status")), FString(TEXT("reported")));
	TestTrue(TEXT("Throttle entry registered"), State.IsValid() && State->GetBoolField(TEXT("registered")));
	TestEqual(TEXT("Lease limit"), State.IsValid() ? int32(State->GetNumberField(TEXT("maxLeases"))) : 0, FUEShedForegroundLeases::MaxLeases);
#else
	UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(LeaseRequest(TEXT("acquire"), Self, 4), Result);
	TestEqual(TEXT("Unsupported platform"), Field(Result, TEXT("status")), FString(TEXT("unsupported")));
#endif
	return true;
}

#if PLATFORM_WINDOWS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedForegroundNativeTest, "UEShed.Core.ForegroundResponsiveness.NativeProcess",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedForegroundNativeTest::RunTest(const FString& Parameters)
{
	FChildProcess Child;
	if (!TestTrue(TEXT("Start a windowless child process"), Child.Handle.IsValid() && Child.ProcessId != 0)) return false;
	const uint32 Self = FPlatformProcess::GetCurrentProcessId();
	FString Result;
	UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(LeaseRequest(TEXT("acquire"), Self, Child.ProcessId), Result);
	TestEqual(TEXT("Minimal rights open a same-user process"), Field(Result, TEXT("status")), FString(TEXT("granted")));
	const FString LeaseId = Field(Result, TEXT("leaseId"));
	UUEShedEditorResponsivenessLibrary::GetForegroundResponsivenessState(FString::Printf(TEXT("{\"expectedProcessId\":%u}"), Self), Result);
	const TSharedPtr<FJsonObject> State = Decode(Result);
	TestTrue(TEXT("A windowless leaseholder is never foreground"), State.IsValid() && !State->GetBoolField(TEXT("exemptionActive")));
	TestTrue(TEXT("Lease counted"), State.IsValid() && State->GetNumberField(TEXT("activeLeases")) >= 1);
	UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(LeaseRequest(TEXT("renew"), Self, Child.ProcessId, LeaseId), Result);
	TestEqual(TEXT("Renew a live client"), Field(Result, TEXT("status")), FString(TEXT("renewed")));
	Child.Stop();
	UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(LeaseRequest(TEXT("renew"), Self, Child.ProcessId, LeaseId), Result);
	TestEqual(TEXT("Exited client lease ends"), Field(Result, TEXT("reason")), FString(TEXT("client_exited")));
	UUEShedEditorResponsivenessLibrary::UpdateForegroundLease(LeaseRequest(TEXT("release"), Self, Child.ProcessId, LeaseId), Result);
	TestEqual(TEXT("Release after the lease ended"), Field(Result, TEXT("status")), FString(TEXT("released")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedForegroundCostTest, "UEShed.Core.ForegroundResponsiveness.PredicateCost",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedForegroundCostTest::RunTest(const FString& Parameters)
{
	constexpr int32 Calls = 200000;
	volatile int32 Sink = 0;
	auto NanosecondsPerCall = [&](TFunctionRef<bool()> Predicate)
	{
		const double Start = FPlatformTime::Seconds();
		for (int32 Index = 0; Index < Calls; ++Index) Sink = Sink + (Predicate() ? 1 : 0);
		return (FPlatformTime::Seconds() - Start) * 1e9 / Calls;
	};
	// The registered predicate as Unreal calls it; the isolated compatibility project holds no lease.
	const double None = NanosecondsPerCall([] { return UUEShedEditorResponsivenessLibrary::ShouldKeepEditorResponsive(); });
	FChildProcess Child;
	if (!TestTrue(TEXT("Start a windowless child process"), Child.Handle.IsValid())) return false;
	FUEShedForegroundLeases Full(IUEShedForegroundPlatform::CreateNative(), FPlatformProcess::GetCurrentProcessId());
	for (int32 Index = 0; Index < FUEShedForegroundLeases::MaxLeases; ++Index) Full.Acquire(Child.ProcessId, 30000);
	TestEqual(TEXT("Eight real leases"), Full.Num(), FUEShedForegroundLeases::MaxLeases);
	const double Eight = NanosecondsPerCall([&] { return Full.DisablesThrottle(); });
	AddInfo(FString::Printf(TEXT("Foreground predicate cost: no lease %.1f ns/call; 8 leases, none foreground %.1f ns/call (%d calls each)"),
		None, Eight, Calls));
	// Unreal asks about 200 times a second while throttled: even 50 us a call is 1% of one core.
	TestTrue(TEXT("No-lease decision is trivially cheap"), None < 1000);
	TestTrue(TEXT("Full-table decision stays cheap"), Eight < 50000);
	return true;
}
#endif

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedForegroundEntryTest, "UEShed.Core.ForegroundResponsiveness.DelegateEntry",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedForegroundEntryTest::RunTest(const FString& Parameters)
{
	if (!TestNotNull(TEXT("Editor"), GEditor)) return false;
#if PLATFORM_WINDOWS
	TestTrue(TEXT("Registered at startup"), UUEShedEditorResponsivenessLibrary::IsForegroundResponsivenessRegistered());
#endif
	auto Other = UEditorEngine::FShouldDisableCPUThrottling::CreateLambda([] { return false; });
	const FDelegateHandle OtherHandle = Other.GetHandle();
	GEditor->ShouldDisableCPUThrottlingDelegates.Add(MoveTemp(Other));
	const int32 Before = GEditor->ShouldDisableCPUThrottlingDelegates.Num();
	UUEShedEditorResponsivenessLibrary::ShutdownForegroundResponsiveness();
	auto HasOther = [&] { return GEditor->ShouldDisableCPUThrottlingDelegates.ContainsByPredicate(
		[&](const UEditorEngine::FShouldDisableCPUThrottling& Delegate) { return Delegate.GetHandle() == OtherHandle; }); };
	TestFalse(TEXT("Our entry is removed"), UUEShedEditorResponsivenessLibrary::IsForegroundResponsivenessRegistered());
	TestTrue(TEXT("Another entry stays"), HasOther());
#if PLATFORM_WINDOWS
	TestEqual(TEXT("Exactly one entry removed"), GEditor->ShouldDisableCPUThrottlingDelegates.Num(), Before - 1);
#endif
	UUEShedEditorResponsivenessLibrary::ShutdownForegroundResponsiveness();
	TestTrue(TEXT("Shutting down twice removes nothing else"), HasOther());
	UUEShedEditorResponsivenessLibrary::StartForegroundResponsiveness();
	UUEShedEditorResponsivenessLibrary::StartForegroundResponsiveness();
#if PLATFORM_WINDOWS
	TestTrue(TEXT("Registered again"), UUEShedEditorResponsivenessLibrary::IsForegroundResponsivenessRegistered());
	TestEqual(TEXT("Starting twice registers once"), GEditor->ShouldDisableCPUThrottlingDelegates.Num(), Before);
#endif
	GEditor->ShouldDisableCPUThrottlingDelegates.RemoveAll(
		[&](const UEditorEngine::FShouldDisableCPUThrottling& Delegate) { return Delegate.GetHandle() == OtherHandle; });
	return true;
}
#endif
