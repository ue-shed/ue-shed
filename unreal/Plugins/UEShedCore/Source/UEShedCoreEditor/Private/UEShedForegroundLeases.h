#pragma once

#include "Containers/Array.h"
#include "Containers/UnrealString.h"
#include "Templates/UniquePtr.h"

/** One opened client process. The handle pins its process ID until it is closed. */
struct FUEShedForegroundClient
{
	uint32 ProcessId = 0;
	uint64 CreationTime = 0;
	void* Handle = nullptr;
};

/** OS access used by the lease table. Tests substitute a fake. */
class IUEShedForegroundPlatform
{
public:
	virtual ~IUEShedForegroundPlatform() = default;
	/** Opens a live process with the minimum rights needed; false when it cannot. */
	virtual bool Open(uint32 ProcessId, FUEShedForegroundClient& OutClient) = 0;
	virtual void Close(FUEShedForegroundClient& Client) = 0;
	virtual bool IsAlive(const FUEShedForegroundClient& Client) = 0;
	/** Creation time of whatever process has this ID now, or 0 when none can be opened. */
	virtual uint64 CurrentCreationTime(uint32 ProcessId) = 0;
	/** Process owning the foreground window, or 0. */
	virtual uint32 ForegroundProcessId() = 0;
	/** Monotonic seconds. */
	virtual double Now() = 0;

	/** Minimal-rights Win32 implementation; null on other platforms. */
	static TUniquePtr<IUEShedForegroundPlatform> CreateNative();
};

/**
 * Bounded client leases that exempt the editor from background throttling while a leaseholder owns
 * the foreground window. Game thread only: Unreal asks the throttle predicate from the engine tick,
 * and Remote Control invokes the library there too.
 */
class FUEShedForegroundLeases
{
public:
	static constexpr int32 MaxLeases = 8;
	static constexpr int32 MinTtlMs = 2000;
	static constexpr int32 DefaultTtlMs = 5000;
	static constexpr int32 MaxTtlMs = 30000;

	enum class EStatus : uint8 { Granted, Renewed, Released, Expired, Rejected };
	struct FOutcome
	{
		EStatus Status = EStatus::Rejected;
		/** Contract reason; empty on success. */
		const TCHAR* Reason = TEXT("");
		FString LeaseId;
		int32 TtlMs = 0;
	};

	FUEShedForegroundLeases(TUniquePtr<IUEShedForegroundPlatform> InPlatform, uint32 InOwnProcessId);
	~FUEShedForegroundLeases();

	FOutcome Acquire(uint32 ClientProcessId, int32 TtlMs);
	FOutcome Renew(const FString& LeaseId, uint32 ClientProcessId, int32 TtlMs);
	FOutcome Release(const FString& LeaseId, uint32 ClientProcessId);
	void ReleaseAll();

	/** The throttle predicate: expiry first, one foreground lookup, liveness of the match only. */
	bool DisablesThrottle();
	int32 Num();

private:
	struct FLease
	{
		FString Id;
		FUEShedForegroundClient Client;
		double Expires = 0;
	};
	void Prune(double Now);
	void Remove(int32 Index);
	int32 Find(const FString& LeaseId) const;

	TUniquePtr<IUEShedForegroundPlatform> Platform;
	TArray<FLease, TInlineAllocator<MaxLeases>> Leases;
	uint32 OwnProcessId = 0;
};

/** A request decoded strictly against foreground-lease-request.schema.json. */
struct FUEShedForegroundLeaseRequest
{
	FString Operation;
	uint32 ExpectedProcessId = 0;
	uint32 ClientProcessId = 0;
	FString LeaseId;
	int32 TtlMs = FUEShedForegroundLeases::DefaultTtlMs;
};

/** False for anything the shared schema rejects, including unknown fields. */
bool ParseUEShedForegroundLeaseRequest(const FString& Json, FUEShedForegroundLeaseRequest& Out);
/** Reads only `expectedProcessId`; false for anything foreground-state-request.schema.json rejects. */
bool ParseUEShedForegroundStateRequest(const FString& Json, uint32& OutExpectedProcessId);
