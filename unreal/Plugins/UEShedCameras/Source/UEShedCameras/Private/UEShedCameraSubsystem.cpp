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
#include "ProfilingDebugging/MiscTrace.h"
#include "TextureResource.h"
#include "RHIGPUReadback.h"
#include "SceneRenderBuilderInterface.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "ShowFlags.h"
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
	int32 StagingWidth = 0;
	int32 StagingHeight = 0;
	uint64 Sequence = 0;
};

struct FCameraState
{
	TWeakObjectPtr<AUEShedCameraSource> Source;
	FTransform OverviewTransform;
	FEngineShowFlags FullFidelityShowFlags{ ESFIM_Game };
	EUEShedCameraRenderProfile AppliedRenderProfile = EUEShedCameraRenderProfile::FullFidelity;
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
	uint64 CaptureBatchesSubmitted = 0;
	uint64 CadenceIntervalsSkipped = 0;
	uint64 CamerasDue = 0;
	uint64 CapturesRequested = 0;
	uint64 ExperimentBytesSentBaseline = 0;
	uint64 ExperimentCadenceIntervalsSkipped = 0;
	double ExperimentStartedSeconds = FPlatformTime::Seconds();
	uint64 ExperimentFramesDeliveredBaseline = 0;
	uint64 ExperimentReadbackDrops = 0;
	uint64 ExperimentReadbackResourcesCreatedBaseline = 0;
	uint64 ExperimentReadbacksEnqueued = 0;
	uint64 ExperimentRenderedCaptures = 0;
	uint64 ExperimentRevision = 0;
	uint64 ExperimentSchedulerTicks = 0;
	uint64 ExperimentScheduledCaptures = 0;
	uint64 ExperimentTransportReplacementsBaseline = 0;
	double LastCaptureBatchSubmissionMs = 0;
	int32 LastCaptureBatchSize = 0;
	double MaxCaptureBatchSubmissionMs = 0;
	int32 MaxCaptureBatchSize = 0;
	double MaxCaptureLatenessMs = 0;
	uint64 ReadbackDrops = 0;
	TAtomic<uint64> ReadbackResourcesCreated{ 0 };
	uint64 SchedulerTicks = 0;
	double TotalCaptureBatchSubmissionMs = 0;
	double TotalCaptureLatenessMs = 0;
	uint64 TraceRegionId = 0;
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
		if (Runtime->TraceRegionId != 0)
		{
			TRACE_END_REGION_WITH_ID(Runtime->TraceRegionId);
		}
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
			State.FullFidelityShowFlags = Source->GetCaptureComponent2D()->ShowFlags;
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
		if (Camera.AppliedRenderProfile != Runtime->Config.RenderProfile)
		{
			USceneCaptureComponent2D* Capture = Source->GetCaptureComponent2D();
			Capture->ShowFlags = Camera.FullFidelityShowFlags;
			if (Runtime->Config.RenderProfile == EUEShedCameraRenderProfile::Observation)
			{
				Capture->ShowFlags.DisableAdvancedFeatures();
				Capture->ShowFlags.SetPostProcessing(false);
				Capture->ShowFlags.SetMotionBlur(false);
				Capture->ShowFlags.SetBloom(false);
				Capture->ShowFlags.SetAntiAliasing(false);
			}
			Camera.AppliedRenderProfile = Runtime->Config.RenderProfile;
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

	if (Runtime->Config.bPaused || Runtime->Cameras.IsEmpty()) return;
	if (Runtime->Config.PipelineMode == EUEShedCameraPipelineMode::FullPipeline
		&& !Runtime->Writer->bConnected.Load()) return;

	UWorld* World = GetWorld();
	if (World == nullptr || World->Scene == nullptr) return;

	struct FPendingCapture
	{
		USceneCaptureComponent2D* Component = nullptr;
		TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe> Slot;
	};

	const double Now = World->GetTimeSeconds();
	const int32 ActiveCameraCount = FMath::Min(
		Runtime->Config.ActiveCameraCount, Runtime->Cameras.Num());
	Runtime->SchedulerCursor %= ActiveCameraCount;
	TArray<FPendingCapture> PendingCaptures;
	PendingCaptures.Reserve(Runtime->Config.CaptureBudgetPerTick);
	Runtime->SchedulerTicks++;
	Runtime->ExperimentSchedulerTicks++;
	int32 Captured = 0;
	for (int32 Offset = 0; Offset < ActiveCameraCount
		&& Captured < Runtime->Config.CaptureBudgetPerTick; ++Offset)
	{
		const int32 Index = (Runtime->SchedulerCursor + Offset) % ActiveCameraCount;
		FCameraState& Camera = Runtime->Cameras[Index];
		AUEShedCameraSource* Source = Camera.Source.Get();
		if (Source == nullptr) continue;
		const double Fps = Source->CameraIndex == Runtime->Config.FocusedCameraIndex
			? Runtime->Config.FocusedFps : Runtime->Config.BackgroundFps;
		const double CaptureIntervalSeconds = 1.0 / FMath::Max(0.1, Fps);
		if (Camera.NextCaptureSeconds <= 0)
		{
			Camera.NextCaptureSeconds = Now;
		}
		if (Now < Camera.NextCaptureSeconds) continue;

		const double CaptureLatenessSeconds = Now - Camera.NextCaptureSeconds;
		const int64 IntervalsAdvanced = FMath::Max<int64>(1,
			FMath::FloorToInt64(CaptureLatenessSeconds / CaptureIntervalSeconds) + 1);
		Camera.NextCaptureSeconds += IntervalsAdvanced * CaptureIntervalSeconds;
		Runtime->CadenceIntervalsSkipped += static_cast<uint64>(IntervalsAdvanced - 1);
		Runtime->ExperimentCadenceIntervalsSkipped +=
			static_cast<uint64>(IntervalsAdvanced - 1);
		Runtime->CamerasDue++;
		const double CaptureLatenessMs = CaptureLatenessSeconds * 1000.0;
		Runtime->TotalCaptureLatenessMs += CaptureLatenessMs;
		Runtime->MaxCaptureLatenessMs =
			FMath::Max(Runtime->MaxCaptureLatenessMs, CaptureLatenessMs);
		Runtime->ExperimentScheduledCaptures++;
		if (Runtime->Config.PipelineMode == EUEShedCameraPipelineMode::ScheduleOnly)
		{
			Captured++;
			Runtime->SchedulerCursor = (Index + 1) % ActiveCameraCount;
			continue;
		}
		TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe> Available;
		if (Runtime->Config.PipelineMode == EUEShedCameraPipelineMode::FullPipeline)
		{
			for (const TSharedPtr<FReadbackSlot, ESPMode::ThreadSafe>& Slot : Camera.Slots)
			{
				if (Slot->State.Load() == 0)
				{
					Available = Slot;
					break;
				}
			}
			if (!Available)
			{
				Runtime->ReadbackDrops++;
				Runtime->ExperimentReadbackDrops++;
				continue;
			}
		}
		UTextureRenderTarget2D* Target = Source->GetCaptureComponent2D()->TextureTarget;
		if (Target == nullptr) continue;
		if (Available)
		{
			Available->CaptureMonotonicMs = FPlatformTime::Seconds() * 1000.0;
			Available->WorldSeconds = Now;
			Available->Pixels.SetNumUninitialized(Source->CaptureWidth * Source->CaptureHeight * 4);
			Available->Width = Source->CaptureWidth;
			Available->Height = Source->CaptureHeight;
			Available->Sequence = Camera.Sequence++;
			Available->State.Store(1);
		}
		PendingCaptures.Add({ Source->GetCaptureComponent2D(), Available });
		Captured++;
		Runtime->SchedulerCursor = (Index + 1) % ActiveCameraCount;
	}

	if (PendingCaptures.IsEmpty()) return;

	// CaptureScene() creates and executes a render builder for every component. Collecting all due
	// cameras into one builder lets Unreal process them as one scene-render workload and avoids an
	// end-of-frame update flush per camera. Readbacks are interleaved after their corresponding
	// renderer so each copy observes the frame that was just rendered into that camera's target.
	const double BatchSubmissionStartSeconds = FPlatformTime::Seconds();
	World->SendAllEndOfFrameUpdates();
	TUniquePtr<ISceneRenderBuilder> SceneRenderBuilder = ISceneRenderBuilder::Create(World->Scene);
	int32 SubmittedCaptureCount = 0;
	for (FPendingCapture& Pending : PendingCaptures)
	{
		UTextureRenderTarget2D* PendingTarget = Pending.Component->TextureTarget;
		if (PendingTarget == nullptr)
		{
			if (Pending.Slot)
			{
				Pending.Slot->State.Store(0);
			}
			continue;
		}

		Pending.Component->UpdateSceneCaptureContents(World->Scene, *SceneRenderBuilder);
		if (Pending.Slot)
		{
			FTextureRenderTargetResource* Resource =
				PendingTarget->GameThread_GetRenderTargetResource();
			FUEShedCameraRuntime* RuntimePtr = Runtime.Get();
			SceneRenderBuilder->AddRenderCommand(
				[Slot = Pending.Slot, Resource, RuntimePtr](FRHICommandListImmediate& RHICmdList)
				{
					if (!Slot->Readback || Slot->StagingWidth != Slot->Width
						|| Slot->StagingHeight != Slot->Height)
					{
						Slot->Readback =
							MakeUnique<FRHIGPUTextureReadback>(TEXT("UEShedCameraReadback"));
						Slot->StagingWidth = Slot->Width;
						Slot->StagingHeight = Slot->Height;
						RuntimePtr->ReadbackResourcesCreated++;
					}
					Slot->Readback->EnqueueCopy(RHICmdList, Resource->GetRenderTargetTexture());
				});
			Runtime->ExperimentReadbacksEnqueued++;
		}
		Runtime->CapturesRequested++;
		Runtime->ExperimentRenderedCaptures++;
		SubmittedCaptureCount++;
	}
	SceneRenderBuilder->Execute();
	const double BatchSubmissionMs =
		(FPlatformTime::Seconds() - BatchSubmissionStartSeconds) * 1000.0;
	Runtime->CaptureBatchesSubmitted++;
	Runtime->LastCaptureBatchSize = SubmittedCaptureCount;
	Runtime->MaxCaptureBatchSize = FMath::Max(Runtime->MaxCaptureBatchSize, SubmittedCaptureCount);
	Runtime->LastCaptureBatchSubmissionMs = BatchSubmissionMs;
	Runtime->MaxCaptureBatchSubmissionMs =
		FMath::Max(Runtime->MaxCaptureBatchSubmissionMs, BatchSubmissionMs);
	Runtime->TotalCaptureBatchSubmissionMs += BatchSubmissionMs;
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
	FString PipelineMode;
	FString RenderProfile;
	if (!Root->TryGetNumberField(TEXT("activeCameraCount"), ActiveCameraCount)
		|| !Root->TryGetNumberField(TEXT("backgroundFps"), BackgroundFps)
		|| !Root->TryGetNumberField(TEXT("focusedFps"), FocusedFps)
		|| !Root->TryGetNumberField(TEXT("captureBudgetPerTick"), CaptureBudget)
		|| !Root->TryGetBoolField(TEXT("paused"), bPaused)
		|| !Root->TryGetStringField(TEXT("pipelineMode"), PipelineMode)
		|| !Root->TryGetStringField(TEXT("renderProfile"), RenderProfile))
	{
		Error = TEXT("missing-required-field");
		return false;
	}
	EUEShedCameraPipelineMode DesiredPipelineMode;
	if (PipelineMode == TEXT("full_pipeline"))
	{
		DesiredPipelineMode = EUEShedCameraPipelineMode::FullPipeline;
	}
	else if (PipelineMode == TEXT("render_only"))
	{
		DesiredPipelineMode = EUEShedCameraPipelineMode::RenderOnly;
	}
	else if (PipelineMode == TEXT("schedule_only"))
	{
		DesiredPipelineMode = EUEShedCameraPipelineMode::ScheduleOnly;
	}
	else
	{
		Error = TEXT("invalid-pipeline-mode");
		return false;
	}
	EUEShedCameraRenderProfile DesiredRenderProfile;
	if (RenderProfile == TEXT("full_fidelity"))
	{
		DesiredRenderProfile = EUEShedCameraRenderProfile::FullFidelity;
	}
	else if (RenderProfile == TEXT("observation"))
	{
		DesiredRenderProfile = EUEShedCameraRenderProfile::Observation;
	}
	else
	{
		Error = TEXT("invalid-render-profile");
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
	Runtime->Config.PipelineMode = DesiredPipelineMode;
	Runtime->Config.RenderProfile = DesiredRenderProfile;
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
	for (FCameraState& Camera : Runtime->Cameras)
	{
		Camera.NextCaptureSeconds = 0;
	}
	Runtime->ExperimentBytesSentBaseline = Runtime->Writer->BytesSent.Load();
	Runtime->ExperimentCadenceIntervalsSkipped = 0;
	Runtime->ExperimentFramesDeliveredBaseline = Runtime->Writer->FramesDelivered.Load();
	Runtime->ExperimentReadbackDrops = 0;
	Runtime->ExperimentReadbackResourcesCreatedBaseline =
		Runtime->ReadbackResourcesCreated.Load();
	Runtime->ExperimentReadbacksEnqueued = 0;
	Runtime->ExperimentRenderedCaptures = 0;
	Runtime->ExperimentRevision++;
	Runtime->ExperimentSchedulerTicks = 0;
	Runtime->ExperimentScheduledCaptures = 0;
	Runtime->ExperimentTransportReplacementsBaseline =
		Runtime->Writer->TransportReplacements.Load();
	Runtime->ExperimentStartedSeconds = FPlatformTime::Seconds();
	if (Runtime->TraceRegionId != 0)
	{
		TRACE_END_REGION_WITH_ID(Runtime->TraceRegionId);
	}
	const TCHAR* PipelineModeName = Runtime->Config.PipelineMode
		== EUEShedCameraPipelineMode::FullPipeline ? TEXT("FullPipeline")
		: Runtime->Config.PipelineMode == EUEShedCameraPipelineMode::RenderOnly
			? TEXT("RenderOnly") : TEXT("ScheduleOnly");
	const FString TraceRegionName = FString::Printf(TEXT("UEShedCameras_%02d_%dx%d_%s_%s"),
		Runtime->Config.ActiveCameraCount,
		Runtime->Config.CaptureWidth,
		Runtime->Config.CaptureHeight,
		PipelineModeName,
		Runtime->Config.RenderProfile == EUEShedCameraRenderProfile::Observation
			? TEXT("Observation") : TEXT("FullFidelity"));
	Runtime->TraceRegionId = TRACE_BEGIN_REGION_WITH_ID(*TraceRegionName, TEXT("UEShedCameras"));
	TRACE_BOOKMARK(TEXT("%s"), *TraceRegionName);
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
	Config->SetStringField(TEXT("pipelineMode"),
		Runtime->Config.PipelineMode == EUEShedCameraPipelineMode::FullPipeline
			? TEXT("full_pipeline")
			: Runtime->Config.PipelineMode == EUEShedCameraPipelineMode::RenderOnly
				? TEXT("render_only") : TEXT("schedule_only"));
	Config->SetStringField(TEXT("renderProfile"),
		Runtime->Config.RenderProfile == EUEShedCameraRenderProfile::Observation
			? TEXT("observation") : TEXT("full_fidelity"));
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
	Stats->SetNumberField(TEXT("captureBatchesSubmitted"), Runtime->CaptureBatchesSubmitted);
	Stats->SetNumberField(TEXT("cadenceIntervalsSkipped"), Runtime->CadenceIntervalsSkipped);
	Stats->SetNumberField(TEXT("camerasDue"), Runtime->CamerasDue);
	Stats->SetNumberField(TEXT("capturesRequested"), Runtime->CapturesRequested);
	Stats->SetNumberField(TEXT("experimentBytesSent"),
		Runtime->Writer->BytesSent.Load() - Runtime->ExperimentBytesSentBaseline);
	Stats->SetNumberField(TEXT("experimentCadenceIntervalsSkipped"),
		Runtime->ExperimentCadenceIntervalsSkipped);
	Stats->SetNumberField(TEXT("experimentElapsedMs"),
		(FPlatformTime::Seconds() - Runtime->ExperimentStartedSeconds) * 1000.0);
	Stats->SetNumberField(TEXT("experimentFramesDelivered"),
		Runtime->Writer->FramesDelivered.Load() - Runtime->ExperimentFramesDeliveredBaseline);
	Stats->SetNumberField(TEXT("experimentReadbackDrops"), Runtime->ExperimentReadbackDrops);
	Stats->SetNumberField(TEXT("experimentReadbackResourcesCreated"),
		Runtime->ReadbackResourcesCreated.Load()
			- Runtime->ExperimentReadbackResourcesCreatedBaseline);
	Stats->SetNumberField(TEXT("experimentReadbacksEnqueued"),
		Runtime->ExperimentReadbacksEnqueued);
	Stats->SetNumberField(TEXT("experimentRenderedCaptures"),
		Runtime->ExperimentRenderedCaptures);
	Stats->SetNumberField(TEXT("experimentRevision"), Runtime->ExperimentRevision);
	Stats->SetNumberField(TEXT("experimentSchedulerTicks"), Runtime->ExperimentSchedulerTicks);
	Stats->SetNumberField(TEXT("experimentScheduledCaptures"),
		Runtime->ExperimentScheduledCaptures);
	Stats->SetNumberField(TEXT("experimentTransportReplacements"),
		Runtime->Writer->TransportReplacements.Load()
			- Runtime->ExperimentTransportReplacementsBaseline);
	Stats->SetNumberField(TEXT("framesDelivered"), Runtime->Writer->FramesDelivered.Load());
	Stats->SetNumberField(TEXT("lastCaptureBatchSize"), Runtime->LastCaptureBatchSize);
	Stats->SetNumberField(TEXT("lastCaptureBatchSubmissionMs"),
		Runtime->LastCaptureBatchSubmissionMs);
	Stats->SetNumberField(TEXT("maxCaptureBatchSize"), Runtime->MaxCaptureBatchSize);
	Stats->SetNumberField(TEXT("maxCaptureBatchSubmissionMs"),
		Runtime->MaxCaptureBatchSubmissionMs);
	Stats->SetNumberField(TEXT("maxCaptureLatenessMs"), Runtime->MaxCaptureLatenessMs);
	Stats->SetBoolField(TEXT("pipeConnected"), Runtime->Writer->bConnected.Load());
	Stats->SetNumberField(TEXT("readbackDrops"), Runtime->ReadbackDrops);
	Stats->SetNumberField(TEXT("readbackResourcesCreated"),
		Runtime->ReadbackResourcesCreated.Load());
	Stats->SetNumberField(TEXT("schedulerTicks"), Runtime->SchedulerTicks);
	Stats->SetNumberField(TEXT("totalCaptureBatchSubmissionMs"),
		Runtime->TotalCaptureBatchSubmissionMs);
	Stats->SetNumberField(TEXT("totalCaptureLatenessMs"), Runtime->TotalCaptureLatenessMs);
	Stats->SetNumberField(TEXT("transportReplacements"),
		Runtime->Writer->TransportReplacements.Load());
	Root->SetObjectField(TEXT("stats"), Stats);
	FString Result;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Result);
	FJsonSerializer::Serialize(Root, Writer);
	return Result;
}
