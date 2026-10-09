#include "UEShedForegroundLeases.h"

#include "Dom/JsonObject.h"
#include "HAL/PlatformTime.h"
#include "Misc/Guid.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#endif

namespace
{
#if PLATFORM_WINDOWS
uint64 CreationTimeOf(HANDLE Process)
{
	FILETIME Created, Exited, Kernel, User;
	if (!::GetProcessTimes(Process, &Created, &Exited, &Kernel, &User)) return 0;
	return (uint64(Created.dwHighDateTime) << 32) | Created.dwLowDateTime;
}

/** Only SYNCHRONIZE (liveness) and PROCESS_QUERY_LIMITED_INFORMATION (creation time). */
class FWindowsForegroundPlatform final : public IUEShedForegroundPlatform
{
public:
	virtual bool Open(uint32 ProcessId, FUEShedForegroundClient& OutClient) override
	{
		const HANDLE Process = ::OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, ProcessId);
		if (!Process) return false;
		const uint64 Created = CreationTimeOf(Process);
		if (!Created || ::WaitForSingleObject(Process, 0) != WAIT_TIMEOUT)
		{
			::CloseHandle(Process);
			return false;
		}
		OutClient = { ProcessId, Created, Process };
		return true;
	}
	virtual void Close(FUEShedForegroundClient& Client) override
	{
		if (Client.Handle) ::CloseHandle(static_cast<HANDLE>(Client.Handle));
		Client.Handle = nullptr;
	}
	virtual bool IsAlive(const FUEShedForegroundClient& Client) override
	{
		return Client.Handle && ::WaitForSingleObject(static_cast<HANDLE>(Client.Handle), 0) == WAIT_TIMEOUT;
	}
	virtual uint64 CurrentCreationTime(uint32 ProcessId) override
	{
		const HANDLE Process = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, ProcessId);
		if (!Process) return 0;
		const uint64 Created = CreationTimeOf(Process);
		::CloseHandle(Process);
		return Created;
	}
	virtual uint32 ForegroundProcessId() override
	{
		const HWND Window = ::GetForegroundWindow();
		DWORD Owner = 0;
		if (Window) ::GetWindowThreadProcessId(Window, &Owner);
		return Owner;
	}
	virtual double Now() override { return FPlatformTime::Seconds(); }
};
#endif

int32 ClampTtl(int32 TtlMs)
{
	return FMath::Clamp(TtlMs, FUEShedForegroundLeases::MinTtlMs, FUEShedForegroundLeases::MaxTtlMs);
}

/** A JSON integer in [Minimum, Maximum]. Strings that look like numbers are refused. */
bool ReadInteger(const FJsonObject& Object, const TCHAR* Name, double Minimum, double Maximum, double& Out)
{
	const TSharedPtr<FJsonValue> Value = Object.TryGetField(Name);
	if (!Value.IsValid() || Value->Type != EJson::Number) return false;
	Out = Value->AsNumber();
	return FMath::IsFinite(Out) && FMath::FloorToDouble(Out) == Out && Out >= Minimum && Out <= Maximum;
}

bool ReadProcessId(const FJsonObject& Object, const TCHAR* Name, uint32& Out)
{
	double Value = 0;
	if (!ReadInteger(Object, Name, 1, 4294967294.0, Value)) return false;
	Out = uint32(Value);
	return true;
}

bool IsLeaseId(const FString& Value)
{
	if (Value.Len() != 32) return false;
	for (const TCHAR Character : Value)
		if (!((Character >= TEXT('0') && Character <= TEXT('9')) || (Character >= TEXT('a') && Character <= TEXT('f'))))
			return false;
	return true;
}

TSharedPtr<FJsonObject> ReadObject(const FString& Json)
{
	TSharedPtr<FJsonObject> Object;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Object)) return nullptr;
	return Object;
}

bool OnlyKeys(const FJsonObject& Object, std::initializer_list<const TCHAR*> Allowed)
{
	for (const auto& Entry : Object.Values)
	{
		bool bKnown = false;
		for (const TCHAR* Key : Allowed) bKnown |= Entry.Key == Key;
		if (!bKnown) return false;
	}
	return true;
}
}

TUniquePtr<IUEShedForegroundPlatform> IUEShedForegroundPlatform::CreateNative()
{
#if PLATFORM_WINDOWS
	return MakeUnique<FWindowsForegroundPlatform>();
#else
	return nullptr;
#endif
}

FUEShedForegroundLeases::FUEShedForegroundLeases(TUniquePtr<IUEShedForegroundPlatform> InPlatform, uint32 InOwnProcessId)
	: Platform(MoveTemp(InPlatform)), OwnProcessId(InOwnProcessId)
{
	check(Platform.IsValid());
}

FUEShedForegroundLeases::~FUEShedForegroundLeases() { ReleaseAll(); }

void FUEShedForegroundLeases::Remove(int32 Index)
{
	Platform->Close(Leases[Index].Client);
	Leases.RemoveAt(Index, EAllowShrinking::No);
}

void FUEShedForegroundLeases::Prune(double Now)
{
	for (int32 Index = Leases.Num() - 1; Index >= 0; --Index)
		if (Now >= Leases[Index].Expires) Remove(Index);
}

int32 FUEShedForegroundLeases::Find(const FString& LeaseId) const
{
	return Leases.IndexOfByPredicate([&LeaseId](const FLease& Lease) { return Lease.Id == LeaseId; });
}

void FUEShedForegroundLeases::ReleaseAll()
{
	for (int32 Index = Leases.Num() - 1; Index >= 0; --Index) Remove(Index);
}

int32 FUEShedForegroundLeases::Num()
{
	Prune(Platform->Now());
	return Leases.Num();
}

FUEShedForegroundLeases::FOutcome FUEShedForegroundLeases::Acquire(uint32 ClientProcessId, int32 TtlMs)
{
	const double Now = Platform->Now();
	Prune(Now);
	if (ClientProcessId == OwnProcessId) return { EStatus::Rejected, TEXT("own_process") };
	if (Leases.Num() >= MaxLeases) return { EStatus::Rejected, TEXT("lease_limit") };
	FLease Lease;
	if (!Platform->Open(ClientProcessId, Lease.Client)) return { EStatus::Rejected, TEXT("client_unavailable") };
	Lease.Id = FGuid::NewGuid().ToString(EGuidFormats::Digits).ToLower();
	TtlMs = ClampTtl(TtlMs);
	Lease.Expires = Now + TtlMs / 1000.0;
	const FString Id = Lease.Id;
	Leases.Add(MoveTemp(Lease));
	return { EStatus::Granted, TEXT(""), Id, TtlMs };
}

FUEShedForegroundLeases::FOutcome FUEShedForegroundLeases::Renew(const FString& LeaseId, uint32 ClientProcessId, int32 TtlMs)
{
	const double Now = Platform->Now();
	Prune(Now);
	const int32 Index = Find(LeaseId);
	if (Index == INDEX_NONE) return { EStatus::Expired, TEXT("lease_ended"), LeaseId };
	FLease& Lease = Leases[Index];
	if (Lease.Client.ProcessId != ClientProcessId) return { EStatus::Rejected, TEXT("lease_mismatch") };
	if (!Platform->IsAlive(Lease.Client))
	{
		Remove(Index);
		return { EStatus::Expired, TEXT("client_exited"), LeaseId };
	}
	// The held handle keeps this ID from being reused; checking a fresh handle's creation time
	// still refuses to carry a lease over to any other process.
	if (Platform->CurrentCreationTime(ClientProcessId) != Lease.Client.CreationTime)
	{
		Remove(Index);
		return { EStatus::Expired, TEXT("client_changed"), LeaseId };
	}
	TtlMs = ClampTtl(TtlMs);
	Lease.Expires = Now + TtlMs / 1000.0;
	return { EStatus::Renewed, TEXT(""), LeaseId, TtlMs };
}

FUEShedForegroundLeases::FOutcome FUEShedForegroundLeases::Release(const FString& LeaseId, uint32 ClientProcessId)
{
	Prune(Platform->Now());
	const int32 Index = Find(LeaseId);
	if (Index == INDEX_NONE) return { EStatus::Released, TEXT(""), LeaseId };
	if (Leases[Index].Client.ProcessId != ClientProcessId) return { EStatus::Rejected, TEXT("lease_mismatch") };
	Remove(Index);
	return { EStatus::Released, TEXT(""), LeaseId };
}

bool FUEShedForegroundLeases::DisablesThrottle()
{
	// Unreal asks about 200 times a second while throttled; with no lease this is one branch.
	if (Leases.IsEmpty()) return false;
	const double Now = Platform->Now();
	uint32 Foreground = 0;
	bool bLookedUp = false;
	for (int32 Index = Leases.Num() - 1; Index >= 0; --Index)
	{
		if (Now >= Leases[Index].Expires)
		{
			Remove(Index);
			continue;
		}
		if (!bLookedUp)
		{
			Foreground = Platform->ForegroundProcessId();
			bLookedUp = true;
		}
		if (Foreground != 0 && Leases[Index].Client.ProcessId == Foreground && Platform->IsAlive(Leases[Index].Client))
			return true;
	}
	return false;
}

bool ParseUEShedForegroundLeaseRequest(const FString& Json, FUEShedForegroundLeaseRequest& Out)
{
	const TSharedPtr<FJsonObject> Object = ReadObject(Json);
	if (!Object.IsValid() || !Object->TryGetStringField(TEXT("operation"), Out.Operation)) return false;
	const bool bAcquire = Out.Operation == TEXT("acquire");
	const bool bRenew = Out.Operation == TEXT("renew");
	const bool bRelease = Out.Operation == TEXT("release");
	if (bAcquire && !OnlyKeys(*Object, { TEXT("operation"), TEXT("expectedProcessId"), TEXT("clientProcessId"), TEXT("ttlMs") })) return false;
	if (bRenew && !OnlyKeys(*Object, { TEXT("operation"), TEXT("expectedProcessId"), TEXT("clientProcessId"), TEXT("leaseId"), TEXT("ttlMs") })) return false;
	if (bRelease && !OnlyKeys(*Object, { TEXT("operation"), TEXT("expectedProcessId"), TEXT("clientProcessId"), TEXT("leaseId") })) return false;
	if (!(bAcquire || bRenew || bRelease)) return false;
	if (!ReadProcessId(*Object, TEXT("expectedProcessId"), Out.ExpectedProcessId)
		|| !ReadProcessId(*Object, TEXT("clientProcessId"), Out.ClientProcessId)) return false;
	if (!bAcquire && (!Object->TryGetStringField(TEXT("leaseId"), Out.LeaseId) || !IsLeaseId(Out.LeaseId))) return false;
	Out.TtlMs = FUEShedForegroundLeases::DefaultTtlMs;
	if (Object->HasField(TEXT("ttlMs")))
	{
		double Ttl = 0;
		if (!ReadInteger(*Object, TEXT("ttlMs"), FUEShedForegroundLeases::MinTtlMs, FUEShedForegroundLeases::MaxTtlMs, Ttl)) return false;
		Out.TtlMs = int32(Ttl);
	}
	return true;
}

bool ParseUEShedForegroundStateRequest(const FString& Json, uint32& OutExpectedProcessId)
{
	const TSharedPtr<FJsonObject> Object = ReadObject(Json);
	return Object.IsValid() && OnlyKeys(*Object, { TEXT("expectedProcessId") })
		&& ReadProcessId(*Object, TEXT("expectedProcessId"), OutExpectedProcessId);
}
