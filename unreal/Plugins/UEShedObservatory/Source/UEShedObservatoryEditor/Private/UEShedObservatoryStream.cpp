#include "UEShedObservatoryStream.h"
#include "UEShedActorMetadata.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/Engine.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "HAL/CriticalSection.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HAL/Runnable.h"
#include "HAL/RunnableThread.h"
#include "Misc/ScopeLock.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Stats/Stats.h"

#if PLATFORM_WINDOWS
#include "Windows/WindowsPlatformNamedPipe.h"
#endif

namespace
{
DECLARE_STATS_GROUP(TEXT("UEShedObservatory"), STATGROUP_UEShedObservatory, STATCAT_Advanced);
DECLARE_CYCLE_STAT(TEXT("ObservatoryStreamTick"), STAT_ObservatoryStreamTick, STATGROUP_UEShedObservatory);

template <typename T>
void WriteValue(TArray<uint8>& Bytes, int32 Offset, const T& Value)
{
	static_assert(TIsTriviallyCopyConstructible<T>::Value);
	FMemory::Memcpy(Bytes.GetData() + Offset, &Value, sizeof(T));
}

void WriteSessionId(TArray<uint8>& Bytes, int32 Offset, const FGuid& SessionGuid)
{
	const FString SessionHex = SessionGuid.ToString(EGuidFormats::Digits).ToLower();
	const auto HexNibble = [](const TCHAR Character) -> uint8
	{
		return Character >= TEXT('0') && Character <= TEXT('9')
			? static_cast<uint8>(Character - TEXT('0'))
			: static_cast<uint8>(Character - TEXT('a') + 10);
	};
	for (int32 ByteIndex = 0; ByteIndex < 16; ++ByteIndex)
	{
		Bytes[Offset + ByteIndex] = static_cast<uint8>(
			(HexNibble(SessionHex[ByteIndex * 2]) << 4)
			| HexNibble(SessionHex[ByteIndex * 2 + 1]));
	}
}

FString SessionIdHexLower(const FGuid& Guid)
{
	return Guid.ToString(EGuidFormats::Digits).ToLower();
}

TSharedRef<FJsonObject> VectorJson(const FVector& Value)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("x"), Value.X);
	Result->SetNumberField(TEXT("y"), Value.Y);
	Result->SetNumberField(TEXT("z"), Value.Z);
	return Result;
}

TSharedRef<FJsonObject> RotationJson(const FRotator& Value)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("x"), Value.Roll);
	Result->SetNumberField(TEXT("y"), Value.Pitch);
	Result->SetNumberField(TEXT("z"), Value.Yaw);
	return Result;
}

void SerializeJson(const TSharedRef<FJsonObject>& Root, FString& ResultJson)
{
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ResultJson);
	FJsonSerializer::Serialize(Root, Writer);
}

bool TransformChanged(
	const FVector& Location,
	const FRotator& Rotation,
	const FVector& LastLocation,
	const FRotator& LastRotation)
{
	constexpr double LocationTolerance = 0.01;
	constexpr double RotationTolerance = 0.01;
	return !Location.Equals(LastLocation, LocationTolerance)
		|| !Rotation.Equals(LastRotation, RotationTolerance);
}

bool HasFiniteTransform(const FVector& Location, const FRotator& Rotation)
{
	return !Location.ContainsNaN() && !Rotation.ContainsNaN();
}

struct FStreamPacket
{
	TArray<uint8> Bytes;
	uint64 Sequence = 0;
};
}

class FObservatoryActorStreamPipeWriter final : public FRunnable
{
public:
	explicit FObservatoryActorStreamPipeWriter(FString InPipeName)
		: PipeName(MoveTemp(InPipeName))
	{
		Thread.Reset(FRunnableThread::Create(this, TEXT("UEShedObservatoryPipeWriter")));
	}

	~FObservatoryActorStreamPipeWriter() override
	{
		Stop();
		if (Thread)
		{
			Thread->WaitForCompletion();
		}
	}

	void Submit(TSharedRef<FStreamPacket, ESPMode::ThreadSafe> Packet)
	{
		FScopeLock Lock(&Mutex);
		if (Latest.IsValid())
		{
			ProducerReplacements++;
		}
		Latest = Packet;
	}

	uint32 Run() override
	{
#if PLATFORM_WINDOWS
		FPlatformNamedPipe Pipe;
		bool bCreated = false;
		while (!bStopping.Load())
		{
			if (!bCreated)
			{
				bCreated = Pipe.Create(*PipeName, false, false);
				bConnected.Store(bCreated);
				if (!bCreated)
				{
					FPlatformProcess::Sleep(0.1f);
					continue;
				}
			}

			TSharedPtr<FStreamPacket, ESPMode::ThreadSafe> Packet;
			{
				FScopeLock Lock(&Mutex);
				Packet = Latest;
				Latest.Reset();
			}
			if (!Packet)
			{
				FPlatformProcess::Sleep(0.002f);
				continue;
			}
			if (!Pipe.WriteBytes(Packet->Bytes.Num(), Packet->Bytes.GetData()))
			{
				Pipe.Destroy();
				bCreated = false;
				bConnected.Store(false);
				continue;
			}
			PacketsDelivered++;
			LastDeliveredSequence.Store(Packet->Sequence);
			BytesSent += Packet->Bytes.Num();
		}
		if (bCreated)
		{
			Pipe.Destroy();
		}
#endif
		bConnected.Store(false);
		return 0;
	}

	void Stop() override
	{
		bStopping.Store(true);
	}

	TAtomic<bool> bConnected{ false };
	TAtomic<uint64> BytesSent{ 0 };
	TAtomic<uint64> LastDeliveredSequence{ 0 };
	TAtomic<uint64> PacketsDelivered{ 0 };
	TAtomic<uint64> ProducerReplacements{ 0 };

private:
	TAtomic<bool> bStopping{ false };
	FString PipeName;
	TUniquePtr<FRunnableThread> Thread;
	FCriticalSection Mutex;
	TSharedPtr<FStreamPacket, ESPMode::ThreadSafe> Latest;
};

struct FObservatoryStreamWriterImpl
{
	explicit FObservatoryStreamWriterImpl(FString InPipeName)
		: Writer(MakeUnique<FObservatoryActorStreamPipeWriter>(MoveTemp(InPipeName)))
	{
	}

	TUniquePtr<FObservatoryActorStreamPipeWriter> Writer;
};

struct FUEShedObservatoryStreamService::FCatalogActorEntry
{
	TWeakObjectPtr<AActor> Actor;
	uint32 StreamIndex = 0;
	FString Id;
	FString Path;
	FString DisplayName;
	FString ClassName;
	FVector Location = FVector::ZeroVector;
	FRotator Rotation = FRotator::ZeroRotator;
	FBox Bounds = FBox(EForceInit::ForceInit);
	FVector CatalogScale = FVector::OneVector;
	FVector LastSentLocation = FVector::ZeroVector;
	FRotator LastSentRotation = FRotator::ZeroRotator;
	uint64 LastIncludedSequence = 0;
	bool bHasLastSent = false;
};

static FUEShedObservatoryStreamService* GStreamServiceInstance = nullptr;

FUEShedObservatoryStreamService& GetObservatoryStreamService()
{
	check(GStreamServiceInstance != nullptr);
	return *GStreamServiceInstance;
}

FUEShedObservatoryStreamService::FUEShedObservatoryStreamService()
{
	check(GStreamServiceInstance == nullptr);
	GStreamServiceInstance = this;
}

FUEShedObservatoryStreamService::~FUEShedObservatoryStreamService()
{
	StopActorObservationInternal();
	UnbindDelegates();
	check(GStreamServiceInstance == this);
	GStreamServiceInstance = nullptr;
}

UWorld* FUEShedObservatoryStreamService::ObservedWorld(bool& bOutIsPie)
{
	bOutIsPie = false;
	if (GEditor == nullptr)
	{
		return nullptr;
	}
	if (GEditor->PlayWorld != nullptr)
	{
		bOutIsPie = true;
		return GEditor->PlayWorld;
	}
	return GEditor->GetEditorWorldContext().World();
}

FString FUEShedObservatoryStreamService::BuildPipeName() const
{
	return FString::Printf(
		TEXT("\\\\.\\pipe\\ue-shed-observatory-v1-%u"),
		FPlatformProcess::GetCurrentProcessId());
}

bool FUEShedObservatoryStreamService::PassesActorFilter(const AActor* Actor, FBox& OutBounds)
{
	if (Actor == nullptr || Actor->HasAnyFlags(RF_ClassDefaultObject | RF_Transient)
		|| Actor->IsHiddenEd() || Actor->GetRootComponent() == nullptr)
	{
		return false;
	}
	OutBounds = Actor->GetComponentsBoundingBox(true, true);
	BoundsCalculations++;
	return OutBounds.IsValid != 0;
}

void FUEShedObservatoryStreamService::BindDelegates()
{
	if (bDelegatesBound)
	{
		return;
	}
	MapChangeHandle = FEditorDelegates::MapChange.AddRaw(
		this, &FUEShedObservatoryStreamService::OnMapChanged);
	BeginPieHandle = FEditorDelegates::BeginPIE.AddRaw(
		this, &FUEShedObservatoryStreamService::OnPieTransition);
	EndPieHandle = FEditorDelegates::EndPIE.AddRaw(
		this, &FUEShedObservatoryStreamService::OnPieTransition);
	if (GEngine != nullptr)
	{
		ActorAddedHandle = GEngine->OnLevelActorAdded().AddRaw(
			this, &FUEShedObservatoryStreamService::OnLevelActorAdded);
		ActorDeletedHandle = GEngine->OnLevelActorDeleted().AddRaw(
			this, &FUEShedObservatoryStreamService::OnLevelActorDeleted);
	}
	bDelegatesBound = true;
}

void FUEShedObservatoryStreamService::UnbindDelegates()
{
	if (!bDelegatesBound)
	{
		return;
	}
	FEditorDelegates::MapChange.Remove(MapChangeHandle);
	FEditorDelegates::BeginPIE.Remove(BeginPieHandle);
	FEditorDelegates::EndPIE.Remove(EndPieHandle);
	if (GEngine != nullptr)
	{
		GEngine->OnLevelActorAdded().Remove(ActorAddedHandle);
		GEngine->OnLevelActorDeleted().Remove(ActorDeletedHandle);
	}
	bDelegatesBound = false;
}

void FUEShedObservatoryStreamService::RequestCatalogInvalidation()
{
	if (!bActive)
	{
		return;
	}
	bCatalogDirty = true;
}

void FUEShedObservatoryStreamService::OnMapChanged(uint32 MapChangeFlags)
{
	(void)MapChangeFlags;
	RequestCatalogInvalidation();
}

void FUEShedObservatoryStreamService::OnPieTransition(bool bIsSimulating)
{
	(void)bIsSimulating;
	RequestCatalogInvalidation();
}

void FUEShedObservatoryStreamService::OnLevelActorAdded(AActor* Actor)
{
	(void)Actor;
	RequestCatalogInvalidation();
}

void FUEShedObservatoryStreamService::OnLevelActorDeleted(AActor* Actor)
{
	(void)Actor;
	RequestCatalogInvalidation();
}

TSharedRef<FJsonObject> FUEShedObservatoryStreamService::BuildCatalogSnapshotJson(
	UWorld* World,
	bool bIsPie) const
{
	TArray<TSharedPtr<FJsonValue>> ActorsJson;
	ActorsJson.Reserve(Catalog.Num());
	for (const FCatalogActorEntry& Entry : Catalog)
	{
		const TSharedRef<FJsonObject> Record = MakeShared<FJsonObject>();
		Record->SetNumberField(TEXT("streamIndex"), Entry.StreamIndex);
		Record->SetStringField(TEXT("id"), Entry.Id);
		Record->SetStringField(TEXT("path"), Entry.Path);
		Record->SetStringField(TEXT("displayName"), Entry.DisplayName);
		Record->SetStringField(TEXT("className"), Entry.ClassName);
 AddUEShedActorMetadata(Record, Entry.Actor.Get());
		Record->SetObjectField(TEXT("location"), VectorJson(Entry.Location));
		Record->SetObjectField(TEXT("rotation"), RotationJson(Entry.Rotation));
		const TSharedRef<FJsonObject> Bounds = MakeShared<FJsonObject>();
		Bounds->SetObjectField(TEXT("center"), VectorJson(Entry.Bounds.GetCenter()));
		Bounds->SetObjectField(TEXT("extent"), VectorJson(Entry.Bounds.GetExtent()));
		Record->SetObjectField(TEXT("bounds"), Bounds);
		ActorsJson.Add(MakeShared<FJsonValueObject>(Record));
	}

	const TSharedRef<FJsonObject> Snapshot = MakeShared<FJsonObject>();
	Snapshot->SetArrayField(TEXT("actors"), ActorsJson);
	Snapshot->SetStringField(TEXT("capturedAt"), FDateTime::UtcNow().ToIso8601());
	Snapshot->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
	Snapshot->SetStringField(TEXT("worldKind"), bIsPie ? TEXT("pie") : TEXT("editor"));
	Snapshot->SetNumberField(TEXT("worldSeconds"), World->GetTimeSeconds());
	return Snapshot;
}

void FUEShedObservatoryStreamService::RebuildCatalogIfNeeded(UWorld* World, bool bIsPie)
{
	if (!bCatalogDirty || World == nullptr)
	{
		return;
	}

	const bool bReplacingCatalog = CatalogRevision > 0;
	Catalog.Reset();
	uint32 StreamIndex = 0;
	for (TActorIterator<AActor> It(World); It && Catalog.Num() < MaxActors; ++It)
	{
		AActor* Actor = *It;
		FBox Bounds;
		if (!PassesActorFilter(Actor, Bounds))
		{
			continue;
		}

		FCatalogActorEntry Entry;
		Entry.Actor = Actor;
		Entry.StreamIndex = StreamIndex++;
		Entry.Id = Actor->GetPathName();
		Entry.Path = Entry.Id;
		Entry.DisplayName = Actor->GetActorLabel();
		Entry.ClassName = Actor->GetClass()->GetName();
		Entry.Location = Actor->GetActorLocation();
		Entry.Rotation = Actor->GetActorRotation();
		Entry.Bounds = Bounds;
		Entry.CatalogScale = Actor->GetActorScale3D();
		const FTransform Transform = Actor->GetActorTransform();
		Entry.LastSentLocation = Transform.GetLocation();
		Entry.LastSentRotation = Transform.Rotator();
		Entry.bHasLastSent = true;
		Catalog.Add(MoveTemp(Entry));
	}

	CatalogRevision++;
	CatalogRebuilds++;
	bCatalogDirty = false;
	ObservedWorldPath = World->GetOutermost()->GetName();
	ObservedWorldKind = bIsPie ? TEXT("pie") : TEXT("editor");
	if (bReplacingCatalog)
	{
		EmitResetPacket(World);
	}
}

TArray<uint8> FUEShedObservatoryStreamService::BuildPacketBytes(
	UWorld* World,
	uint16 Flags,
	const TArray<FCatalogActorEntry*>& ChangedEntries,
	uint32 ActorsSampled,
	uint32 ActorsChanged,
	uint32 SamplingDurationMicros) const
{
	const int32 RecordCount = ChangedEntries.Num();
	const int32 PayloadBytes = RecordCount * RecordBytes;
	TArray<uint8> Bytes;
	Bytes.SetNumZeroed(HeaderBytes + PayloadBytes);
	FMemory::Memcpy(Bytes.GetData(), "USOT", 4);
	const uint16 Version = 1;
	const uint16 HeaderLength = HeaderBytes;
	const uint16 RecordLength = RecordBytes;
	WriteValue(Bytes, 4, Version);
	WriteValue(Bytes, 6, HeaderLength);
	WriteValue(Bytes, 8, RecordLength);
	WriteValue(Bytes, 10, Flags);
	WriteValue(Bytes, 12, static_cast<uint32>(RecordCount));
	WriteValue(Bytes, 16, static_cast<uint32>(PayloadBytes));
	WriteValue(Bytes, 20, static_cast<uint32>(0));
	WriteValue(Bytes, 24, PacketSequence);
	const double WorldSeconds = World != nullptr ? World->GetTimeSeconds() : 0.0;
	WriteValue(Bytes, 32, WorldSeconds);
	const double ProducerMonotonicMs = FPlatformTime::Seconds() * 1000.0;
	WriteValue(Bytes, 40, ProducerMonotonicMs);
	WriteSessionId(Bytes, 48, SessionId);
	WriteValue(Bytes, 64, CatalogRevision);
	WriteValue(Bytes, 72, ActorsSampled);
	WriteValue(Bytes, 76, ActorsChanged);
	const uint32 Replacements = WriterImpl.IsValid()
		? static_cast<uint32>(FMath::Min<uint64>(
			WriterImpl->Writer->ProducerReplacements.Load(),
			MAX_uint32))
		: 0;
	WriteValue(Bytes, 80, Replacements);
	WriteValue(Bytes, 84, SamplingDurationMicros);
	WriteValue(Bytes, 88, static_cast<uint64>(0));

	for (int32 Index = 0; Index < RecordCount; ++Index)
	{
		const FCatalogActorEntry* Entry = ChangedEntries[Index];
		if (Entry == nullptr)
		{
			continue;
		}
		const int32 Offset = HeaderBytes + Index * RecordBytes;
		WriteValue(Bytes, Offset, Entry->StreamIndex);
		WriteValue(Bytes, Offset + 4, static_cast<uint32>(0));
		WriteValue(Bytes, Offset + 8, Entry->LastSentLocation.X);
		WriteValue(Bytes, Offset + 16, Entry->LastSentLocation.Y);
		WriteValue(Bytes, Offset + 24, Entry->LastSentLocation.Z);
		// USOT reserves four bytes for each angle. UE's FRotator uses doubles in
		// large-world builds, so writing the fields directly would overwrite the
		// adjacent slots and corrupt the wire record.
		WriteValue(Bytes, Offset + 32, static_cast<float>(Entry->LastSentRotation.Roll));
		WriteValue(Bytes, Offset + 36, static_cast<float>(Entry->LastSentRotation.Pitch));
		WriteValue(Bytes, Offset + 40, static_cast<float>(Entry->LastSentRotation.Yaw));
		WriteValue(Bytes, Offset + 44, static_cast<uint32>(0));
	}
	return Bytes;
}

void FUEShedObservatoryStreamService::EmitResetPacket(UWorld* World)
{
	if (!WriterImpl.IsValid() || World == nullptr)
	{
		return;
	}
	PacketSequence++;
	ResetCount++;
	SamplesAttempted++;
	const TArray<FCatalogActorEntry*> Empty;
	TArray<uint8> Bytes = BuildPacketBytes(
		World,
		FlagReset,
		Empty,
		0,
		0,
		0);
	TSharedRef<FStreamPacket, ESPMode::ThreadSafe> Packet =
		MakeShared<FStreamPacket, ESPMode::ThreadSafe>();
	Packet->Bytes = MoveTemp(Bytes);
	Packet->Sequence = PacketSequence;
	WriterImpl->Writer->Submit(Packet);
}

void FUEShedObservatoryStreamService::SampleIfDue(UWorld* World, bool bIsPie)
{
	(void)bIsPie;
	if (!WriterImpl.IsValid() || World == nullptr || !bActive)
	{
		return;
	}

	const double Now = FPlatformTime::Seconds();
	if (NextSampleSeconds > 0.0 && Now < NextSampleSeconds)
	{
		return;
	}
	const double IntervalSeconds = 1.0 / static_cast<double>(FMath::Max(1, CadenceHz));
	if (NextSampleSeconds <= 0.0)
	{
		NextSampleSeconds = Now;
	}
	const int64 IntervalsAdvanced = FMath::Max<int64>(
		1,
		FMath::FloorToInt64((Now - NextSampleSeconds) / IntervalSeconds) + 1);
	NextSampleSeconds += static_cast<double>(IntervalsAdvanced) * IntervalSeconds;

	const double SampleStart = FPlatformTime::Seconds();
	SamplesAttempted++;

	TArray<FCatalogActorEntry*> ChangedEntries;
	ChangedEntries.Reserve(Catalog.Num());
	uint32 ActorsSampled = 0;
	uint32 ActorsChanged = 0;
	const uint64 LastDeliveredSequence = WriterImpl->Writer->LastDeliveredSequence.Load();

	for (FCatalogActorEntry& Entry : Catalog)
	{
		AActor* Actor = Entry.Actor.Get();
		if (Actor == nullptr)
		{
			RequestCatalogInvalidation();
			return;
		}

		const FVector CurrentScale = Actor->GetActorScale3D();
		if (!CurrentScale.Equals(Entry.CatalogScale, KINDA_SMALL_NUMBER))
		{
			RequestCatalogInvalidation();
			return;
		}

		ActorsSampled++;
		const FTransform Transform = Actor->GetActorTransform();
		const FVector Location = Transform.GetLocation();
		const FRotator Rotation = Transform.Rotator();
		if (!HasFiniteTransform(Location, Rotation))
		{
			continue;
		}
		if (!Entry.bHasLastSent || Entry.LastIncludedSequence > LastDeliveredSequence
			|| TransformChanged(Location, Rotation, Entry.LastSentLocation, Entry.LastSentRotation))
		{
			Entry.LastSentLocation = Location;
			Entry.LastSentRotation = Rotation;
			Entry.bHasLastSent = true;
			ChangedEntries.Add(&Entry);
			ActorsChanged++;
		}
	}

	const double SampleDurationSeconds = FPlatformTime::Seconds() - SampleStart;
	const uint32 SamplingDurationMicros = static_cast<uint32>(FMath::Min<uint64>(
		static_cast<uint64>(SampleDurationSeconds * 1000000.0),
		static_cast<uint64>(MAX_uint32)));

	TotalSamplingMicros += SamplingDurationMicros;
	MaxSamplingMicros = FMath::Max(MaxSamplingMicros, static_cast<uint64>(SamplingDurationMicros));
	SamplingSamples++;
	ActorsSampledTotal += ActorsSampled;
	ActorsChangedTotal += ActorsChanged;

	PacketSequence++;
	for (FCatalogActorEntry* Entry : ChangedEntries)
	{
		if (Entry != nullptr)
		{
			Entry->LastIncludedSequence = PacketSequence;
		}
	}
	TArray<uint8> Bytes = BuildPacketBytes(
		World,
		0,
		ChangedEntries,
		ActorsSampled,
		ActorsChanged,
		SamplingDurationMicros);
	TSharedRef<FStreamPacket, ESPMode::ThreadSafe> Packet =
		MakeShared<FStreamPacket, ESPMode::ThreadSafe>();
	Packet->Bytes = MoveTemp(Bytes);
	Packet->Sequence = PacketSequence;
	WriterImpl->Writer->Submit(Packet);
}

void FUEShedObservatoryStreamService::StartActorObservation(
	const FString& RequestJson,
	FString& ResultJson)
{
#if !PLATFORM_WINDOWS
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("status"), TEXT("not_supported"));
	Root->SetStringField(
		TEXT("message"),
		TEXT("Actor transform streaming requires Windows named pipes."));
	Root->SetStringField(
		TEXT("recovery"),
		TEXT("Use bounded snapshot polling fallback at ≤10 Hz."));
	SerializeJson(Root, ResultJson);
	return;
#else
	TSharedPtr<FJsonObject> Request;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Request) || !Request.IsValid())
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("status"), TEXT("failed"));
		Root->SetStringField(TEXT("message"), TEXT("RequestJson is not valid JSON."));
		Root->SetStringField(TEXT("recovery"), TEXT("Provide {\"cadenceHz\": 1-60}."));
		SerializeJson(Root, ResultJson);
		return;
	}

	double CadenceField = 0.0;
	if (!Request->TryGetNumberField(TEXT("cadenceHz"), CadenceField))
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("status"), TEXT("failed"));
		Root->SetStringField(TEXT("message"), TEXT("Missing cadenceHz."));
		Root->SetStringField(TEXT("recovery"), TEXT("Provide an integer cadenceHz between 1 and 60."));
		SerializeJson(Root, ResultJson);
		return;
	}
	const int32 RequestedCadence = FMath::RoundToInt(CadenceField);
	if (RequestedCadence < 1 || RequestedCadence > MaxCadenceHz
		|| !FMath::IsNearlyEqual(CadenceField, static_cast<double>(RequestedCadence), KINDA_SMALL_NUMBER))
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("status"), TEXT("failed"));
		Root->SetStringField(TEXT("message"), TEXT("cadenceHz must be an integer between 1 and 60."));
		Root->SetStringField(TEXT("recovery"), TEXT("Provide an integer cadenceHz between 1 and 60."));
		SerializeJson(Root, ResultJson);
		return;
	}

	bool bIsPie = false;
	UWorld* World = ObservedWorld(bIsPie);
	if (World == nullptr)
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("status"), TEXT("failed"));
		Root->SetStringField(TEXT("message"), TEXT("No editor world is available."));
		Root->SetStringField(TEXT("recovery"), TEXT("Open a map in the Unreal editor and retry."));
		SerializeJson(Root, ResultJson);
		return;
	}

	StopActorObservationInternal();

	SessionId = FGuid::NewGuid();
	PacketSequence = 0;
	ResetCount = 0;
	CatalogRevision = 0;
	Catalog.Reset();
	bCatalogDirty = true;
	CadenceHz = RequestedCadence;
	NextSampleSeconds = 0;
	SamplesAttempted = 0;
	SamplesDelivered = 0;
	ActorsSampledTotal = 0;
	ActorsChangedTotal = 0;
	CatalogRebuilds = 0;
	BoundsCalculations = 0;
	TotalSamplingMicros = 0;
	MaxSamplingMicros = 0;
	SamplingSamples = 0;

	WriterImpl = MakeUnique<FObservatoryStreamWriterImpl>(BuildPipeName());
	BindDelegates();
	bActive = true;
	RebuildCatalogIfNeeded(World, bIsPie);

	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("status"), TEXT("ready"));
	Root->SetStringField(TEXT("sessionId"), SessionIdHexLower(SessionId));
	Root->SetStringField(TEXT("catalogRevision"), FString::Printf(TEXT("%llu"), CatalogRevision));
	Root->SetNumberField(TEXT("cadenceHz"), CadenceHz);
	Root->SetStringField(TEXT("pipeName"), BuildPipeName());
	const TSharedRef<FJsonObject> Limits = MakeShared<FJsonObject>();
	Limits->SetNumberField(TEXT("maxActors"), MaxActors);
	Limits->SetNumberField(TEXT("maxCadenceHz"), MaxCadenceHz);
	Root->SetObjectField(TEXT("limits"), Limits);
	Root->SetStringField(TEXT("capability"), TEXT("stream"));
	Root->SetObjectField(TEXT("catalog"), BuildCatalogSnapshotJson(World, bIsPie));
	SerializeJson(Root, ResultJson);
#endif
}

void FUEShedObservatoryStreamService::StopActorObservationInternal()
{
	bActive = false;
	bCatalogDirty = true;
	NextSampleSeconds = 0;
	Catalog.Reset();
	WriterImpl.Reset();
}

void FUEShedObservatoryStreamService::StopActorObservation(FString& ResultJson)
{
	StopActorObservationInternal();
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("status"), TEXT("stopped"));
	SerializeJson(Root, ResultJson);
}

void FUEShedObservatoryStreamService::SetActorObservationCadence(
	const FString& RequestJson,
	FString& ResultJson)
{
#if !PLATFORM_WINDOWS
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("status"), TEXT("failed"));
	Root->SetStringField(
		TEXT("message"),
		TEXT("Actor transform streaming requires Windows named pipes."));
	Root->SetStringField(TEXT("recovery"), TEXT("Use bounded snapshot polling fallback at \u226410 Hz."));
	SerializeJson(Root, ResultJson);
	return;
#else
	if (!bActive || !WriterImpl.IsValid())
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("status"), TEXT("failed"));
		Root->SetStringField(TEXT("message"), TEXT("No actor observation stream is active."));
		Root->SetStringField(
			TEXT("recovery"),
			TEXT("Start actor observation before changing its sampling cadence."));
		SerializeJson(Root, ResultJson);
		return;
	}

	TSharedPtr<FJsonObject> Request;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Request) || !Request.IsValid())
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("status"), TEXT("failed"));
		Root->SetStringField(TEXT("message"), TEXT("RequestJson is not valid JSON."));
		Root->SetStringField(TEXT("recovery"), TEXT("Provide {\"cadenceHz\": 1-60}."));
		SerializeJson(Root, ResultJson);
		return;
	}

	double CadenceField = 0.0;
	if (!Request->TryGetNumberField(TEXT("cadenceHz"), CadenceField))
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("status"), TEXT("failed"));
		Root->SetStringField(TEXT("message"), TEXT("Missing cadenceHz."));
		Root->SetStringField(TEXT("recovery"), TEXT("Provide an integer cadenceHz between 1 and 60."));
		SerializeJson(Root, ResultJson);
		return;
	}
	const int32 RequestedCadence = FMath::RoundToInt(CadenceField);
	if (RequestedCadence < 1 || RequestedCadence > MaxCadenceHz
		|| !FMath::IsNearlyEqual(CadenceField, static_cast<double>(RequestedCadence), KINDA_SMALL_NUMBER))
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("status"), TEXT("failed"));
		Root->SetStringField(TEXT("message"), TEXT("cadenceHz must be an integer between 1 and 60."));
		Root->SetStringField(TEXT("recovery"), TEXT("Provide an integer cadenceHz between 1 and 60."));
		SerializeJson(Root, ResultJson);
		return;
	}

	// Preserve the current session, catalog, and writer. The next tick samples immediately
	// at the new rate, so the host never has to reconnect its named-pipe reader.
	CadenceHz = RequestedCadence;
	NextSampleSeconds = 0;

	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("status"), TEXT("ready"));
	Root->SetNumberField(TEXT("cadenceHz"), CadenceHz);
	SerializeJson(Root, ResultJson);
#endif
}

void FUEShedObservatoryStreamService::GetActorObservationStatus(FString& ResultJson) const
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("status"), bActive ? TEXT("live") : TEXT("stopped"));
	Root->SetStringField(TEXT("capability"), TEXT("stream"));
	Root->SetNumberField(TEXT("cadenceHz"), CadenceHz);
	Root->SetNumberField(TEXT("effectiveCadenceHz"), bActive ? CadenceHz : 0);
	Root->SetStringField(TEXT("sessionId"), SessionIdHexLower(SessionId));
	Root->SetStringField(TEXT("catalogRevision"), FString::Printf(TEXT("%llu"), CatalogRevision));
	Root->SetStringField(TEXT("pipeName"), BuildPipeName());

	const TSharedRef<FJsonObject> Counters = MakeShared<FJsonObject>();
	Counters->SetNumberField(TEXT("samplesAttempted"), SamplesAttempted);
	const uint64 Delivered = WriterImpl.IsValid()
		? WriterImpl->Writer->PacketsDelivered.Load()
		: 0;
	Counters->SetNumberField(TEXT("samplesDelivered"), Delivered);
	Counters->SetNumberField(TEXT("actorsSampled"), ActorsSampledTotal);
	Counters->SetNumberField(TEXT("actorsChanged"), ActorsChangedTotal);
	Counters->SetNumberField(TEXT("catalogRebuilds"), CatalogRebuilds);
	Counters->SetNumberField(TEXT("boundsCalculations"), BoundsCalculations);
	const double AvgSamplingMicros = SamplingSamples > 0
		? static_cast<double>(TotalSamplingMicros) / static_cast<double>(SamplingSamples)
		: 0.0;
	Counters->SetNumberField(TEXT("samplingAvgMicros"), AvgSamplingMicros);
	Counters->SetNumberField(TEXT("samplingMaxMicros"), static_cast<double>(MaxSamplingMicros));
	const uint64 Bytes = WriterImpl.IsValid() ? WriterImpl->Writer->BytesSent.Load() : 0;
	Counters->SetNumberField(TEXT("bytesSent"), Bytes);
	const uint64 Replacements = WriterImpl.IsValid()
		? WriterImpl->Writer->ProducerReplacements.Load()
		: 0;
	Counters->SetNumberField(TEXT("producerReplacements"), Replacements);
	Counters->SetBoolField(
		TEXT("pipeConnected"),
		WriterImpl.IsValid() && WriterImpl->Writer->bConnected.Load());
	Counters->SetNumberField(TEXT("resetCount"), ResetCount);
	Root->SetObjectField(TEXT("counters"), Counters);

	SerializeJson(Root, ResultJson);
}

void FUEShedObservatoryStreamService::Tick(float DeltaTime)
{
	SCOPE_CYCLE_COUNTER(STAT_ObservatoryStreamTick);
	(void)DeltaTime;
	if (!bActive)
	{
		return;
	}

	bool bIsPie = false;
	UWorld* World = ObservedWorld(bIsPie);
	if (World == nullptr)
	{
		return;
	}

	const FString CurrentWorldPath = World->GetOutermost()->GetName();
	const FString CurrentWorldKind = bIsPie ? TEXT("pie") : TEXT("editor");
	if (!ObservedWorldPath.IsEmpty()
		&& (CurrentWorldPath != ObservedWorldPath || CurrentWorldKind != ObservedWorldKind))
	{
		RequestCatalogInvalidation();
	}

	if (bCatalogDirty)
	{
		RebuildCatalogIfNeeded(World, bIsPie);
	}

	SampleIfDue(World, bIsPie);

	if (WriterImpl.IsValid())
	{
		SamplesDelivered = WriterImpl->Writer->PacketsDelivered.Load();
	}
}

bool FUEShedObservatoryStreamService::IsTickable() const
{
	return bActive;
}

ETickableTickType FUEShedObservatoryStreamService::GetTickableTickType() const
{
	return ETickableTickType::Conditional;
}

TStatId FUEShedObservatoryStreamService::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(FUEShedObservatoryStreamService, STATGROUP_UEShedObservatory);
}
