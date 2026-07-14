#include "UEShedCameraSubsystem.h"

#include "Async/Async.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Dom/JsonObject.h"
#include "Engine/TextureRenderTarget2D.h"
#include "EngineUtils.h"
#include "HAL/CriticalSection.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HAL/Runnable.h"
#include "HAL/RunnableThread.h"
#include "Misc/ScopeLock.h"
#include "TextureResource.h"
#include "RHIGPUReadback.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UEShedCameraSource.h"

#if PLATFORM_WINDOWS
#include "Windows/WindowsPlatformNamedPipe.h"
#endif

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEShedCameraSubsystem)

namespace
{
constexpr int32 FrameHeaderBytes = 128;
constexpr TCHAR PipeName[] = TEXT("\\\\.\\pipe\\ue-shed-cameras-v1");

struct FReadbackSlot
{
	TAtomic<int32> State{ 0 }; // idle, enqueued, ready
	TUniquePtr<FRHIGPUTextureReadback> Readback;
	TArray<uint8> Pixels;
	double CaptureMonotonicMs = 0;
	double ReadbackLatencyMs = 0;
	double WorldSeconds = 0;
	int32 Width = 0;
	int32 Height = 0;
	uint64 Sequence = 0;
};

struct FCameraState
{
	TWeakObjectPtr<AUEShedCameraSource> Source;
	FTransform OverviewTransform;
	double NextCaptureSeconds = 0;
	uint64 Sequence = 0;
	TStaticArray<TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe>, 2> Slots;
};

struct FFramePacket
{
	int32 CameraIndex = 0;
	TArray<uint8> Bytes;
};

template <typename T>
void WriteValue(TArray<uint8>& Bytes, int32 Offset, const T& Value)
{
	static_assert(TIsTriviallyCopyConstructible<T>::Value);
	FMemory::Memcpy(Bytes.GetData() + Offset, &Value, sizeof(T));
}

void WriteGuid(TArray<uint8>& Bytes, int32 Offset, const FGuid& Value)
{
	WriteValue(Bytes, Offset, Value.A);
	WriteValue(Bytes, Offset + 4, Value.B);
	WriteValue(Bytes, Offset + 8, Value.C);
	WriteValue(Bytes, Offset + 12, Value.D);
}

class FCameraPipeWriter final : public FRunnable
{
public:
	FCameraPipeWriter()
	{
		Thread.Reset(FRunnableThread::Create(this, TEXT("UEShedCameraPipeWriter")));
	}

	~FCameraPipeWriter() override
	{
		Stop();
		if (Thread)
		{
			Thread->WaitForCompletion();
		}
	}

	void Submit(TSharedRef<FFramePacket, ESPMode::ThreadSafe> Packet)
	{
		FScopeLock Lock(&Mutex);
		if (Latest.Contains(Packet->CameraIndex))
		{
			TransportReplacements++;
		}
		Latest.Add(Packet->CameraIndex, Packet);
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
				bCreated = Pipe.Create(PipeName, false, false);
				bConnected.Store(bCreated);
				if (!bCreated)
				{
					FPlatformProcess::Sleep(0.1f);
					continue;
				}
			}

			TSharedPtr<FFramePacket, ESPMode::ThreadSafe> Packet;
			{
				FScopeLock Lock(&Mutex);
				if (!Latest.IsEmpty())
				{
					auto Iterator = Latest.CreateIterator();
					Packet = Iterator.Value();
					Iterator.RemoveCurrent();
				}
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
			FramesDelivered++;
			BytesSent += Packet->Bytes.Num();
		}
		if (bCreated) Pipe.Destroy();
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
	TAtomic<uint64> FramesDelivered{ 0 };
	TAtomic<uint64> TransportReplacements{ 0 };

private:
	TAtomic<bool> bStopping{ false };
	TUniquePtr<FRunnableThread> Thread;
	FCriticalSection Mutex;
	TMap<int32, TSharedPtr<FFramePacket, ESPMode::ThreadSafe>> Latest;
};

FString GuidString(const FGuid& Guid)
{
	return Guid.ToString(EGuidFormats::Digits).ToLower();
}
}

struct FUEShedCameraRuntime
{
	FUEShedCameraScheduleConfig Config;
	TArray<FCameraState> Cameras;
	TUniquePtr<FCameraPipeWriter> Writer;
	FGuid ProducerId = FGuid::NewGuid();
	FGuid SessionId = FGuid::NewGuid();
	uint64 CapturesRequested = 0;
	uint64 ReadbackDrops = 0;
	int32 SchedulerCursor = 0;
};

bool UUEShedCameraSubsystem::ShouldCreateSubsystem(UObject* Outer) const
{
	const UWorld* World = Cast<UWorld>(Outer);
	return World != nullptr && (World->WorldType == EWorldType::PIE || World->WorldType == EWorldType::Game);
}

void UUEShedCameraSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	Runtime = MakeUnique<FUEShedCameraRuntime>();
	Runtime->Writer = MakeUnique<FCameraPipeWriter>();
}

void UUEShedCameraSubsystem::OnWorldBeginPlay(UWorld& InWorld)
{
	Super::OnWorldBeginPlay(InWorld);
}

void UUEShedCameraSubsystem::Deinitialize()
{
	if (Runtime)
	{
		Runtime->Writer.Reset();
		FlushRenderingCommands();
		Runtime.Reset();
	}
	Super::Deinitialize();
}

void UUEShedCameraSubsystem::Tick(float DeltaTime)
{
	if (!Runtime) return;
	if (Runtime->Cameras.IsEmpty())
	{
		TArray<AUEShedCameraSource*> Sources;
		for (TActorIterator<AUEShedCameraSource> It(GetWorld()); It; ++It) Sources.Add(*It);
		Sources.Sort([](const AUEShedCameraSource& Left, const AUEShedCameraSource& Right)
		{
			return Left.CameraIndex < Right.CameraIndex;
		});
		for (AUEShedCameraSource* Source : Sources)
		{
			FCameraState& State = Runtime->Cameras.AddDefaulted_GetRef();
			State.Source = Source;
			State.OverviewTransform = Source->GetActorTransform();
			for (TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe>& Slot : State.Slots)
			{
				Slot = MakeShared<FReadbackSlot, ESPMode::ThreadSafe>();
			}
		}
	}
	for (FCameraState& Camera : Runtime->Cameras)
	{
		AUEShedCameraSource* Source = Camera.Source.Get();
		if (Source == nullptr) continue;
		if (Runtime->Config.bActorPov && Source->ObservationTarget != nullptr)
		{
			const FTransform TargetTransform = Source->ObservationTarget->GetActorTransform();
			Source->SetActorLocationAndRotation(
				TargetTransform.TransformPosition(Source->ActorPovOffset),
				TargetTransform.GetRotation());
		}
		else if (!Source->GetActorTransform().Equals(Camera.OverviewTransform))
		{
			Source->SetActorTransform(Camera.OverviewTransform);
		}
	}

	for (FCameraState& Camera : Runtime->Cameras)
	{
		for (const TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe>& Slot : Camera.Slots)
		{
			if (Slot->State.Load() == 1)
			{
				ENQUEUE_RENDER_COMMAND(UEShedPollCameraReadback)(
					[Slot](FRHICommandListImmediate& RHICmdList)
					{
						if (!Slot->Readback || !Slot->Readback->IsReady()) return;
						int32 RowPitchPixels = 0;
						int32 BufferHeight = 0;
						const uint8* Source = static_cast<const uint8*>(
							Slot->Readback->Lock(RowPitchPixels, &BufferHeight));
						const int32 Width = Slot->Width;
						if (Source != nullptr && Width > 0)
						{
							uint8* Destination = Slot->Pixels.GetData();
							for (int32 Row = 0; Row < Slot->Height; ++Row)
							{
								FMemory::Memcpy(Destination + Row * Width * 4,
									Source + Row * RowPitchPixels * 4, Width * 4);
							}
						}
						Slot->Readback->Unlock();
						Slot->Readback.Reset();
						Slot->ReadbackLatencyMs = FPlatformTime::Seconds() * 1000.0
							- Slot->CaptureMonotonicMs;
						Slot->State.Store(2);
					});
			}
			if (Slot->State.Load() != 2) continue;
			AUEShedCameraSource* Source = Camera.Source.Get();
			if (Source == nullptr)
			{
				Slot->State.Store(0);
				continue;
			}
			TSharedRef<FFramePacket, ESPMode::ThreadSafe> Packet =
				MakeShared<FFramePacket, ESPMode::ThreadSafe>();
			Packet->CameraIndex = Source->CameraIndex;
			Packet->Bytes.SetNumUninitialized(FrameHeaderBytes + Slot->Pixels.Num());
			FMemory::Memzero(Packet->Bytes.GetData(), FrameHeaderBytes);
			FMemory::Memcpy(Packet->Bytes.GetData(), "USCF", 4);
			const uint16 Version = 1;
			const uint16 HeaderSize = FrameHeaderBytes;
			const uint32 Flags = 3;
			const uint32 Width = Source->CaptureWidth;
			const uint32 Height = Source->CaptureHeight;
			const uint32 RowPitch = Width * 4;
			const uint32 PayloadSize = Slot->Pixels.Num();
			const uint32 CameraIndex = Source->CameraIndex;
			const uint32 Drops = FMath::Min<uint64>(Runtime->ReadbackDrops, MAX_uint32);
			const uint32 Replacements = FMath::Min<uint64>(
				Runtime->Writer->TransportReplacements.Load(), MAX_uint32);
			WriteValue(Packet->Bytes, 4, Version);
			WriteValue(Packet->Bytes, 6, HeaderSize);
			WriteValue(Packet->Bytes, 8, Flags);
			WriteValue(Packet->Bytes, 12, Width);
			WriteValue(Packet->Bytes, 16, Height);
			WriteValue(Packet->Bytes, 20, RowPitch);
			WriteValue(Packet->Bytes, 24, PayloadSize);
			WriteValue(Packet->Bytes, 28, CameraIndex);
			WriteValue(Packet->Bytes, 32, Slot->Sequence);
			WriteValue(Packet->Bytes, 40, Slot->WorldSeconds);
			WriteValue(Packet->Bytes, 48, Slot->CaptureMonotonicMs);
			WriteValue(Packet->Bytes, 56, Slot->ReadbackLatencyMs);
			WriteGuid(Packet->Bytes, 64, Runtime->ProducerId);
			WriteGuid(Packet->Bytes, 80, Runtime->SessionId);
			WriteGuid(Packet->Bytes, 96, Source->CameraId);
			WriteValue(Packet->Bytes, 112, Drops);
			WriteValue(Packet->Bytes, 116, Replacements);
			FMemory::Memcpy(Packet->Bytes.GetData() + FrameHeaderBytes,
				Slot->Pixels.GetData(), Slot->Pixels.Num());
			Runtime->Writer->Submit(Packet);
			Slot->State.Store(0);
		}
	}
	for (FCameraState& Camera : Runtime->Cameras)
	{
		AUEShedCameraSource* Source = Camera.Source.Get();
		if (Source == nullptr || (Source->CaptureWidth == Runtime->Config.CaptureWidth
			&& Source->CaptureHeight == Runtime->Config.CaptureHeight)) continue;
		bool bReadbacksIdle = true;
		for (const TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe>& Slot : Camera.Slots)
		{
			bReadbacksIdle = bReadbacksIdle && Slot->State.Load() == 0;
		}
		if (!bReadbacksIdle) continue;
		if (UTextureRenderTarget2D* Target = Source->GetCaptureComponent2D()->TextureTarget)
		{
			Target->ResizeTarget(Runtime->Config.CaptureWidth, Runtime->Config.CaptureHeight);
			Source->CaptureWidth = Runtime->Config.CaptureWidth;
			Source->CaptureHeight = Runtime->Config.CaptureHeight;
		}
	}

	if (Runtime->Config.bPaused || !Runtime->Writer->bConnected.Load()
		|| Runtime->Cameras.IsEmpty()) return;

	const double Now = GetWorld()->GetTimeSeconds();
	const int32 ActiveCameraCount = FMath::Min(
		Runtime->Config.ActiveCameraCount, Runtime->Cameras.Num());
	Runtime->SchedulerCursor %= ActiveCameraCount;
	int32 Captured = 0;
	for (int32 Offset = 0; Offset < ActiveCameraCount
		&& Captured < Runtime->Config.CaptureBudgetPerTick; ++Offset)
	{
		const int32 Index = (Runtime->SchedulerCursor + Offset) % ActiveCameraCount;
		FCameraState& Camera = Runtime->Cameras[Index];
		AUEShedCameraSource* Source = Camera.Source.Get();
		if (Source == nullptr || Now < Camera.NextCaptureSeconds) continue;
		const double Fps = Source->CameraIndex == Runtime->Config.FocusedCameraIndex
			? Runtime->Config.FocusedFps : Runtime->Config.BackgroundFps;
		TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe> Available;
		for (const TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe>& Slot : Camera.Slots)
		{
			if (Slot->State.Load() == 0)
			{
				Available = Slot;
				break;
			}
		}
		Camera.NextCaptureSeconds = Now + 1.0 / FMath::Max(0.1, Fps);
		if (!Available)
		{
			Runtime->ReadbackDrops++;
			continue;
		}
		UTextureRenderTarget2D* Target = Source->GetCaptureComponent2D()->TextureTarget;
		if (Target == nullptr) continue;
		Available->CaptureMonotonicMs = FPlatformTime::Seconds() * 1000.0;
		Available->WorldSeconds = Now;
		Available->Pixels.SetNumUninitialized(Source->CaptureWidth * Source->CaptureHeight * 4);
		Available->Width = Source->CaptureWidth;
		Available->Height = Source->CaptureHeight;
		Available->Sequence = Camera.Sequence++;
		Available->State.Store(1);
		Source->GetCaptureComponent2D()->CaptureScene();
		FTextureRenderTargetResource* Resource = Target->GameThread_GetRenderTargetResource();
		ENQUEUE_RENDER_COMMAND(UEShedStartCameraReadback)(
			[Available, Resource](FRHICommandListImmediate& RHICmdList)
			{
				Available->Readback = MakeUnique<FRHIGPUTextureReadback>(TEXT("UEShedCameraReadback"));
				Available->Readback->EnqueueCopy(RHICmdList, Resource->GetRenderTargetTexture());
			});
		Runtime->CapturesRequested++;
		Captured++;
		Runtime->SchedulerCursor = (Index + 1) % ActiveCameraCount;
	}
}

TStatId UUEShedCameraSubsystem::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(UUEShedCameraSubsystem, STATGROUP_Tickables);
}

bool UUEShedCameraSubsystem::ApplyConfigJson(const FString& ConfigJson, FString& Error)
{
	if (!Runtime) return false;
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ConfigJson);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		Error = TEXT("invalid-json");
		return false;
	}
	double BackgroundFps;
	double FocusedFps;
	double CaptureBudget;
	double ActiveCameraCount;
	bool bPaused;
	if (!Root->TryGetNumberField(TEXT("activeCameraCount"), ActiveCameraCount)
		|| !Root->TryGetNumberField(TEXT("backgroundFps"), BackgroundFps)
		|| !Root->TryGetNumberField(TEXT("focusedFps"), FocusedFps)
		|| !Root->TryGetNumberField(TEXT("captureBudgetPerTick"), CaptureBudget)
		|| !Root->TryGetBoolField(TEXT("paused"), bPaused))
	{
		Error = TEXT("missing-required-field");
		return false;
	}
	FString ViewMode;
	bool bActorPov = Runtime->Config.bActorPov;
	if (Root->TryGetStringField(TEXT("viewMode"), ViewMode))
	{
		if (ViewMode != TEXT("overview") && ViewMode != TEXT("actor_pov"))
		{
			Error = TEXT("invalid-view-mode");
			return false;
		}
		bActorPov = ViewMode == TEXT("actor_pov");
	}
	int32 CaptureWidth = Runtime->Config.CaptureWidth;
	int32 CaptureHeight = Runtime->Config.CaptureHeight;
	FString Resolution;
	if (Root->TryGetStringField(TEXT("resolution"), Resolution))
	{
		if (Resolution == TEXT("160x90")) { CaptureWidth = 160; CaptureHeight = 90; }
		else if (Resolution == TEXT("320x180")) { CaptureWidth = 320; CaptureHeight = 180; }
		else if (Resolution == TEXT("640x360")) { CaptureWidth = 640; CaptureHeight = 360; }
		else if (Resolution == TEXT("960x540")) { CaptureWidth = 960; CaptureHeight = 540; }
		else if (Resolution == TEXT("1280x720")) { CaptureWidth = 1280; CaptureHeight = 720; }
		else if (Resolution == TEXT("1920x1080")) { CaptureWidth = 1920; CaptureHeight = 1080; }
		else if (Resolution == TEXT("2560x1440")) { CaptureWidth = 2560; CaptureHeight = 1440; }
		else
		{
			Error = TEXT("invalid-resolution");
			return false;
		}
	}
	Runtime->Config.ActiveCameraCount = FMath::Clamp(FMath::RoundToInt(ActiveCameraCount), 1, 32);
	Runtime->Config.BackgroundFps = FMath::Clamp(BackgroundFps, 0.1, 30.0);
	Runtime->Config.FocusedFps = FMath::Clamp(FocusedFps, 0.1, 60.0);
	Runtime->Config.CaptureBudgetPerTick = FMath::Clamp(FMath::RoundToInt(CaptureBudget), 1, 32);
	Runtime->Config.bPaused = bPaused;
	Runtime->Config.bActorPov = bActorPov;
	Runtime->Config.CaptureWidth = CaptureWidth;
	Runtime->Config.CaptureHeight = CaptureHeight;
	Runtime->Config.FocusedCameraIndex = -1;
	if (const TSharedPtr<FJsonValue>* Focused = Root->Values.Find(TEXT("focusedCameraIndex"));
		Focused != nullptr && (*Focused)->Type == EJson::Number)
	{
		Runtime->Config.FocusedCameraIndex = FMath::Clamp(
			FMath::RoundToInt((*Focused)->AsNumber()), 0,
			Runtime->Config.ActiveCameraCount - 1);
	}
	return true;
}

FString UUEShedCameraSubsystem::StatusJson() const
{
	if (!Runtime) return TEXT("{\"schemaVersion\":1,\"error\":\"not-initialized\"}");
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetNumberField(TEXT("schemaVersion"), 1);
	Root->SetStringField(TEXT("pipeName"), PipeName);
	const TSharedRef<FJsonObject> Config = MakeShared<FJsonObject>();
	Config->SetNumberField(TEXT("activeCameraCount"), Runtime->Config.ActiveCameraCount);
	Config->SetNumberField(TEXT("backgroundFps"), Runtime->Config.BackgroundFps);
	Config->SetNumberField(TEXT("captureBudgetPerTick"), Runtime->Config.CaptureBudgetPerTick);
	if (Runtime->Config.FocusedCameraIndex >= 0)
		Config->SetNumberField(TEXT("focusedCameraIndex"), Runtime->Config.FocusedCameraIndex);
	else Config->SetField(TEXT("focusedCameraIndex"), MakeShared<FJsonValueNull>());
	Config->SetNumberField(TEXT("focusedFps"), Runtime->Config.FocusedFps);
	Config->SetBoolField(TEXT("paused"), Runtime->Config.bPaused);
	Config->SetStringField(TEXT("resolution"), FString::Printf(TEXT("%dx%d"),
		Runtime->Config.CaptureWidth, Runtime->Config.CaptureHeight));
	Config->SetStringField(TEXT("viewMode"),
		Runtime->Config.bActorPov ? TEXT("actor_pov") : TEXT("overview"));
	Root->SetObjectField(TEXT("config"), Config);
	TArray<TSharedPtr<FJsonValue>> Cameras;
	for (const FCameraState& State : Runtime->Cameras)
	{
		const AUEShedCameraSource* Source = State.Source.Get();
		if (Source == nullptr) continue;
		const TSharedRef<FJsonObject> Camera = MakeShared<FJsonObject>();
		Camera->SetStringField(TEXT("cameraId"), GuidString(Source->CameraId));
		Camera->SetStringField(TEXT("displayName"), Source->GetActorNameOrLabel());
		Camera->SetNumberField(TEXT("index"), Source->CameraIndex);
		Camera->SetNumberField(TEXT("width"), Source->CaptureWidth);
		Camera->SetNumberField(TEXT("height"), Source->CaptureHeight);
		Cameras.Add(MakeShared<FJsonValueObject>(Camera));
	}
	Root->SetArrayField(TEXT("cameras"), Cameras);
	const TSharedRef<FJsonObject> Stats = MakeShared<FJsonObject>();
	Stats->SetNumberField(TEXT("bytesSent"), Runtime->Writer->BytesSent.Load());
	Stats->SetNumberField(TEXT("capturesRequested"), Runtime->CapturesRequested);
	Stats->SetNumberField(TEXT("framesDelivered"), Runtime->Writer->FramesDelivered.Load());
	Stats->SetBoolField(TEXT("pipeConnected"), Runtime->Writer->bConnected.Load());
	Stats->SetNumberField(TEXT("readbackDrops"), Runtime->ReadbackDrops);
	Stats->SetNumberField(TEXT("transportReplacements"),
		Runtime->Writer->TransportReplacements.Load());
	Root->SetObjectField(TEXT("stats"), Stats);
	FString Result;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Result);
	FJsonSerializer::Serialize(Root, Writer);
	return Result;
}
