#include "UEShedLitMapTileCapture.h"
#include "UEShedCameraRenderSession.h"
#include "UEShedCameraReviewLibrary.h"
#include "UEShedMapCaptureFreeze.h"

#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/LevelStreaming.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "HighResScreenshot.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Misc/App.h"
#include "Misc/Paths.h"
#include "SceneManagement.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UnrealClient.h"
#include "WorldPartition/WorldPartition.h"

DEFINE_LOG_CATEGORY_STATIC(LogUEShedLitMapCapture, Log, All);

namespace
{
constexpr int32 SettleFrames = 128;
constexpr int32 OverviewFrames = 512;
constexpr double LeaseSeconds = 120.0;
const FText RealtimeOwner = NSLOCTEXT("UEShed", "MapCaptureRealtime", "UE Shed Map Capture");

FString Json(const TSharedPtr<FJsonObject> &Value)
{
	FString Text;
	FJsonSerializer::Serialize(Value.ToSharedRef(), TJsonWriterFactory<>::Create(&Text));
	return Text;
}

TSharedPtr<FJsonObject> Failure(const FString &Code, const FString &Message)
{
	auto Value = MakeShared<FJsonObject>();
	Value->SetStringField(TEXT("code"), Code);
	Value->SetStringField(TEXT("message"), Message);
	Value->SetStringField(TEXT("recovery"), TEXT("Inspect the editor state and retry the capture. Use a "
												 "visible, unlocked Level Editor viewport."));
	Value->SetBoolField(TEXT("retrySafe"), Code != TEXT("invalid_request"));
	return Value;
}

TSharedPtr<FJsonObject> Response(const FString &Operation, const FString &Correlation, const FString &Map,
								 bool Dirty, const TSharedPtr<FJsonObject> &Error)
{
	auto Value = MakeShared<FJsonObject>();
	auto Contract = MakeShared<FJsonObject>();
	auto Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 1);
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-map-tile-capture"));
	Contract->SetObjectField(TEXT("version"), Version);
	Value->SetObjectField(TEXT("contract"), Contract);
	Value->SetStringField(TEXT("operationId"), Operation);
	Value->SetStringField(TEXT("correlationId"), Correlation);
	if (!Map.IsEmpty())
		Value->SetStringField(TEXT("actualMapPath"), Map);
	auto DirtyState = MakeShared<FJsonObject>();
	DirtyState->SetBoolField(TEXT("before"), Dirty);
	DirtyState->SetBoolField(TEXT("after"), Dirty);
	Value->SetObjectField(TEXT("dirtyState"), DirtyState);
	Value->SetNumberField(TEXT("durationMs"), 0);
	Value->SetArrayField(TEXT("results"), {});
	auto Counts = MakeShared<FJsonObject>();
	Counts->SetNumberField(TEXT("requested"), 0);
	Counts->SetNumberField(TEXT("succeeded"), 0);
	Counts->SetNumberField(TEXT("failed"), 0);
	Value->SetObjectField(TEXT("tileCounts"), Counts);
	Value->SetStringField(TEXT("status"), Error ? TEXT("failed") : TEXT("completed"));
	if (Error)
		Value->SetObjectField(TEXT("failure"), Error);
	return Value;
}

FString Finished(const TSharedPtr<FJsonObject> &Value)
{
	auto Envelope = MakeShared<FJsonObject>();
	Envelope->SetStringField(TEXT("state"), TEXT("finished"));
	Envelope->SetObjectField(TEXT("response"), Value);
	return Json(Envelope);
}

struct FTile
{
	TSharedPtr<FJsonObject> Key;
	FVector Location;
	double Width;
	FString RelativePath;
};

bool Number(const TSharedPtr<FJsonObject> &Object, const TCHAR *Name, double &Out)
{
	return Object->TryGetNumberField(Name, Out) && FMath::IsFinite(Out);
}

bool Bounds(const TSharedPtr<FJsonObject> &Value, FBox2D &Out)
{
	double MinX, MaxX, MinY, MaxY;
	if (!Number(Value, TEXT("minX"), MinX) || !Number(Value, TEXT("maxX"), MaxX) ||
		!Number(Value, TEXT("minY"), MinY) || !Number(Value, TEXT("maxY"), MaxY) || MaxX <= MinX ||
		MaxY <= MinY || !FMath::IsFinite(MaxX - MinX) || !FMath::IsFinite(MaxY - MinY) ||
		MaxX - MinX > MAX_flt || MaxY - MinY > MAX_flt || !FMath::IsFinite(MinX + MaxX) ||
		!FMath::IsFinite(MinY + MaxY))
		return false;
	Out = FBox2D(FVector2D(MinX, MinY), FVector2D(MaxX, MaxY));
	return true;
}

bool ReadTiles(const TSharedPtr<FJsonObject> &Request, TArray<FTile> &Out, FBox2D &Overview)
{
	const int32 Pixels = Request->GetIntegerField(TEXT("tilePixelSize"));
	const int32 Gutter = Request->GetIntegerField(TEXT("gutterPixels"));
	const double Z = Request->GetObjectField(TEXT("capture"))->GetNumberField(TEXT("z"));
	TSet<FString> Keys;
	for (const auto &Value : Request->GetArrayField(TEXT("tiles")))
	{
		const TSharedPtr<FJsonObject> *Tile;
		const TSharedPtr<FJsonObject> *Key;
		const TSharedPtr<FJsonObject> *Box;
		double Zoom, Row, Column, Units;
		FBox2D WorldBounds;
		if (!Value->TryGetObject(Tile) || !(*Tile)->TryGetObjectField(TEXT("key"), Key) ||
			!(*Tile)->TryGetObjectField(TEXT("worldBounds"), Box) || !Bounds(*Box, WorldBounds) ||
			!Number(*Tile, TEXT("unitsPerPixel"), Units) || Units <= 0 || !Number(*Key, TEXT("zoom"), Zoom) ||
			!Number(*Key, TEXT("row"), Row) || !Number(*Key, TEXT("column"), Column))
			return false;
		for (double Index : {Zoom, Row, Column})
			if (Index < 0 || Index > MAX_int32 || Index != FMath::FloorToDouble(Index))
				return false;
		if (!FMath::IsFinite((Pixels + Gutter * 2) * Units) || (Pixels + Gutter * 2) * Units > MAX_flt)
			return false;
		if (Zoom > 23 || !FMath::IsNearlyEqual(WorldBounds.GetSize().X, Pixels * Units, .01) ||
			!FMath::IsNearlyEqual(WorldBounds.GetSize().Y, Pixels * Units, .01))
			return false;
		FString Path = FString::Printf(TEXT("Z%02d/R%03d_C%03d.png"), int32(Zoom), int32(Row), int32(Column));
		if (Keys.Contains(Path))
			return false;
		Keys.Add(Path);
		Out.Add({*Key, FVector(WorldBounds.GetCenter(), Z), (Pixels + Gutter * 2) * Units, Path});
		Overview += WorldBounds;
	}
	const TSharedPtr<FJsonObject> *RequestedOverview;
	if (Request->HasField(TEXT("overviewBounds")) &&
		!Request->TryGetObjectField(TEXT("overviewBounds"), RequestedOverview))
		return false;
	if (Request->TryGetObjectField(TEXT("overviewBounds"), RequestedOverview))
	{
		FBox2D Box;
		if (!Bounds(*RequestedOverview, Box) || !Box.IsInsideOrOn(Overview.Min) ||
			!Box.IsInsideOrOn(Overview.Max))
			return false;
		Overview = Box;
	}
	return true;
}

struct FLitRun
{
	FString RunId, OperationId, CorrelationId, Policy, MapPath, FramePrefix;
	TWeakObjectPtr<UWorld> World;
	TSharedPtr<FUEShedCameraRenderSession> Renderer;
	bool DirtyBefore = false, Done = false, Restored = false;
	double BatchStarted = FPlatformTime::Seconds();
	int32 TileIndex = 0, Pixels = 0, Gutter = 0;
	TArray<FTile> Tiles;
	TArray<TSharedPtr<FJsonValue>> Results;
	TSharedPtr<FJsonObject> BatchResponse, FrameStatus;
	bool RestorationSucceeded = true;
	bool Restore()
	{
		if (Restored)
			return RestorationSucceeded;
		Restored = true;
		if (Renderer)
			RestorationSucceeded = Renderer->Close()->GetStringField(TEXT("status")) == TEXT("closed");
		return RestorationSucceeded;
	}
	~FLitRun()
	{
		Restore();
	}
	void Finish(const FString &Code = FString(), const FString &Message = FString())
	{
		Done = true;
		BatchResponse =
			Response(OperationId, CorrelationId, MapPath, DirtyBefore,
					 Code.IsEmpty() ? nullptr
									: Failure(Code == TEXT("cancelled") ? Code : TEXT("capture_failed"),
											  Code + TEXT(": ") + Message));
		const int32 Succeeded = Results.Num();
		if (!Code.IsEmpty())
			for (int32 I = Results.Num(); I < Tiles.Num(); ++I)
			{
				auto Failed = MakeShared<FJsonObject>();
				Failed->SetObjectField(TEXT("key"), Tiles[I].Key);
				Failed->SetStringField(TEXT("status"), TEXT("failed"));
				Failed->SetObjectField(TEXT("failure"),
									   Failure(Code == TEXT("cancelled") ? Code : TEXT("capture_failed"),
											   Code + TEXT(": ") + Message));
				Results.Add(MakeShared<FJsonValueObject>(Failed));
			}
		BatchResponse->SetArrayField(TEXT("results"), Results);
		auto Counts = BatchResponse->GetObjectField(TEXT("tileCounts"));
		Counts->SetNumberField(TEXT("requested"), Tiles.Num());
		Counts->SetNumberField(TEXT("succeeded"), Succeeded);
		Counts->SetNumberField(TEXT("failed"), Results.Num() - Succeeded);
		BatchResponse->SetNumberField(TEXT("durationMs"), (FPlatformTime::Seconds() - BatchStarted) * 1000);
		BatchResponse->GetObjectField(TEXT("dirtyState"))
			->SetBoolField(TEXT("after"), World.IsValid() && World->GetOutermost()->IsDirty());
		if (Code == TEXT("cancelled"))
			BatchResponse->SetStringField(TEXT("status"), TEXT("cancelled"));
		if (!Code.IsEmpty())
			Restore();
	}
	FString FrameId() const
	{
		return FramePrefix + FString::Printf(TEXT("-%d"), TileIndex);
	}
	void PrepareTile()
	{
		const auto &Tile = Tiles[TileIndex];
		FrameStatus = Renderer->Start(UEShedRenderFrame(
			RunId, FrameId(), UEShedCameraPose(Tile.Location, FRotator(-90, 0, 0), Tile.Width, true),
			Pixels + Gutter * 2, Pixels + Gutter * 2));
	}
	void Tick()
	{
		if (Restored || Done)
			return;
		if (!FrameStatus || FrameStatus->GetStringField(TEXT("status")) == TEXT("running"))
			FrameStatus = Renderer->Poll(FrameId(), false);
		const FString Status = FrameStatus->GetStringField(TEXT("status"));
		if (Status == TEXT("running"))
			return;
		if (Status == TEXT("failed"))
		{
			Finish(FrameStatus->GetStringField(TEXT("code")), FrameStatus->GetStringField(TEXT("message")));
			return;
		}
		const FString RawPath = FPaths::Combine(
			FPaths::ProjectSavedDir(), TEXT("UEShed/CameraRenderStaging"),
			FrameStatus->GetObjectField(TEXT("artifact"))->GetStringField(TEXT("relativePath")));
		FImage Image;
		if (!FImageUtils::LoadImage(*RawPath, Image))
		{
			Finish(TEXT("capture_failed"), TEXT("The shared renderer artifact could not be read."));
			return;
		}
		Image.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
		TArray<FColor> Crop;
		Crop.SetNumUninitialized(Pixels * Pixels);
		for (int32 Row = 0; Row < Pixels; ++Row)
			FMemory::Memcpy(Crop.GetData() + Row * Pixels,
							Image.RawData.GetData() +
								((Row + Gutter) * Image.SizeX + Gutter) * sizeof(FColor),
							Pixels * sizeof(FColor));
		const FString Path = FPaths::ConvertRelativePathToFull(FPaths::Combine(
			FPaths::ProjectSavedDir(), TEXT("UEShed/MapTileStaging"), RunId, Tiles[TileIndex].RelativePath));
		IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
		if (!FImageUtils::SaveImageByExtension(*Path, FImageView(Crop.GetData(), Pixels, Pixels)))
		{
			Finish(TEXT("write_failed"), TEXT("The cropped tile could not be staged."));
			return;
		}
		auto Result = MakeShared<FJsonObject>();
		Result->SetObjectField(TEXT("key"), Tiles[TileIndex].Key);
		Result->SetStringField(TEXT("status"), TEXT("captured"));
		Result->SetStringField(TEXT("stagedPath"), Path);
		Result->SetNumberField(TEXT("width"), Pixels);
		Result->SetNumberField(TEXT("height"), Pixels);
		Result->SetNumberField(TEXT("bytes"), IFileManager::Get().FileSize(*Path));
		Result->SetNumberField(TEXT("captureDurationMs"), FrameStatus->GetObjectField(TEXT("evidence"))
															  ->GetObjectField(TEXT("settling"))
															  ->GetNumberField(TEXT("elapsedMs")));
		Result->SetObjectField(TEXT("renderEvidence"), FrameStatus->GetObjectField(TEXT("evidence")));
		Results.Add(MakeShared<FJsonValueObject>(Result));
		if (++TileIndex == Tiles.Num())
			Finish();
		else
			PrepareTile();
	}
};

TUniquePtr<FLitRun> Run;
FDelegateHandle TickHandle, WorldHandle, PIEHandle;

TArray<TSharedPtr<FJsonValue>> Readiness(UWorld *World, const FString &ExpectedMap,
										 const FString &Owner = FString())
{
	TArray<TSharedPtr<FJsonValue>> Issues;
	auto Add = [&](const TCHAR *Code, const TCHAR *Message) {
		auto Issue = MakeShared<FJsonObject>();
		Issue->SetStringField(TEXT("code"), Code);
		Issue->SetStringField(TEXT("message"), Message);
		Issues.Add(MakeShared<FJsonValueObject>(Issue));
	};
	if (!FApp::CanEverRender())
		Add(TEXT("rendering_unavailable"), TEXT("Use a rendering-capable editor without NullRHI."));
	if (!World)
		Add(TEXT("world_unavailable"), TEXT("Open the target map in the editor."));
	else
	{
		for (const auto *Level : World->GetStreamingLevels())
			if (Level && Level->IsStreamingStatePending())
			{
				Add(TEXT("level_streaming_pending"), TEXT("Wait for level streaming to finish."));
				break;
			}
		if (World->GetOutermost()->GetName() != ExpectedMap)
			Add(TEXT("map_mismatch"), TEXT("Open the requested map before capture."));
		if (const auto *Partition = World->GetWorldPartition();
			Partition && !Partition->IsStreamingCompleted(nullptr))
			Add(TEXT("streaming_not_ready"),
				TEXT("Load the required region and wait for streaming to complete."));
	}
	if (Run && !Run->Restored && (Owner.IsEmpty() || Run->RunId != Owner || !Run->Done))
		Add(TEXT("capture_busy"), TEXT("Wait for or end the active capture."));
	if (!GEditor || GEditor->PlayWorld)
		Add(TEXT("editor_required"), TEXT("Stop PIE before capture."));
	auto *Client = GCurrentLevelEditingViewportClient;
	if (!FSlateApplication::IsInitialized() || !Client || !Client->Viewport)
		Add(TEXT("viewport_unavailable"), TEXT("Open a rendering Level Editor viewport."));
	else if (!Run || Run->Restored || Run->RunId != Owner)
	{
		if (Client->IsAnyActorLocked())
			Add(TEXT("viewport_locked"), TEXT("Unlock the viewport from its actor or cinematic camera."));
		if (Client->IsEngineShowFlagsOverrideEnabled())
			Add(TEXT("viewport_override"), TEXT("Finish the active viewport show-flag override."));
	}
	if (GIsHighResScreenshot || FScreenshotRequest::IsScreenshotRequested())
		Add(TEXT("screenshot_busy"), TEXT("Wait for the current screenshot to finish."));
	return Issues;
}

FString Status()
{
	if (Run->Done)
		return Finished(Run->BatchResponse);
	auto Value = MakeShared<FJsonObject>();
	Value->SetStringField(TEXT("state"), TEXT("running"));
	Value->SetStringField(TEXT("operationId"), Run->OperationId);
	Value->SetNumberField(TEXT("completedTiles"), Run->Results.Num());
	Value->SetNumberField(TEXT("totalTiles"), Run->Tiles.Num());
	Value->SetNumberField(TEXT("elapsedMs"), (FPlatformTime::Seconds() - Run->BatchStarted) * 1000);
	FString Phase = Run->FrameStatus && Run->FrameStatus->HasField(TEXT("phase"))
						? Run->FrameStatus->GetStringField(TEXT("phase"))
						: TEXT("capturing");
	Value->SetStringField(TEXT("phase"), Phase == TEXT("exposure_warmup") ? Phase
										 : Phase == TEXT("capturing")	  ? Phase
																		  : TEXT("tile_warmup"));
	if (Run->Tiles.IsValidIndex(Run->TileIndex))
		Value->SetObjectField(TEXT("currentTile"), Run->Tiles[Run->TileIndex].Key);
	return Json(Value);
}
} // namespace

void BeginUEShedLitMapTileCapture(const TSharedPtr<FJsonObject> &Request, UWorld *World, FString &ResultJson)
{
	const FString RunId = Request->GetStringField(TEXT("runId"));
	const FString OperationId = Request->GetStringField(TEXT("operationId"));
	const FString CorrelationId = Request->GetStringField(TEXT("correlationId"));
	auto Reject = [&](const FString &Message) {
		ResultJson =
			Finished(Response(OperationId, CorrelationId, World->GetOutermost()->GetName(),
							  World->GetOutermost()->IsDirty(), Failure(TEXT("invalid_request"), Message)));
	};
	if (Run && (Run->Restored || Run->Renderer->IsClosed()))
		Run.Reset();
	const auto Issues = Readiness(World, Request->GetStringField(TEXT("expectedMapPath")), RunId);
	if (!Issues.IsEmpty())
	{
		Reject(Issues[0]->AsObject()->GetStringField(TEXT("message")));
		return;
	}
	const auto Capture = Request->GetObjectField(TEXT("capture"));
	const auto Render = Capture->GetObjectField(TEXT("render"));
	if (Render->GetStringField(TEXT("lodPolicy")) != TEXT("natural") ||
		Render->GetStringField(TEXT("profile")) != TEXT("full_fidelity"))
	{
		Reject(TEXT("Lit camera tiles require full_fidelity with natural LOD policy. Use an explicit "
					"SceneCapture backend for other profiles."));
		return;
	}
	const FString Policy = Json(Capture);
	if (Run && (Run->World.Get() != World || Run->Policy != Policy))
	{
		Reject(TEXT("Capture policy or world changed within a run."));
		return;
	}
	TArray<FTile> Tiles;
	FBox2D Overview(ForceInit);
	if (!ReadTiles(Request, Tiles, Overview))
	{
		Reject(TEXT("Tile keys, coverage or overview bounds are invalid."));
		return;
	}
	double EV = 0;
	if (Render->HasField(TEXT("exposureEV100")) &&
		(!Number(Render, TEXT("exposureEV100"), EV) || EV < -20 || EV > 30))
	{
		Reject(TEXT("exposureEV100 must be finite and between -20 and 30."));
		return;
	}
	if (!Run)
	{
		auto RequestRender = UEShedLegacyRenderRequest(RunId, World, true);
		auto RenderPolicy = RequestRender->GetObjectField(TEXT("policy"));
		auto RendererPolicy = RenderPolicy->GetObjectField(TEXT("renderer"));
		RendererPolicy->SetBoolField(TEXT("fog"),
									 Render->GetObjectField(TEXT("effects"))->GetBoolField(TEXT("fog")));
		RendererPolicy->SetBoolField(
			TEXT("volumetricFog"),
			Render->GetObjectField(TEXT("effects"))->GetBoolField(TEXT("volumetricFog")));
		RenderPolicy->GetObjectField(TEXT("settling"))->SetNumberField(TEXT("minimumFrames"), SettleFrames);
		RenderPolicy->SetStringField(TEXT("time"), TEXT("freeze_materials_and_ticks"));
		auto Exposure = MakeShared<FJsonObject>();
		if (Render->HasField(TEXT("exposureEV100")))
		{
			Exposure->SetStringField(TEXT("mode"), TEXT("fixed_ev100"));
			Exposure->SetNumberField(TEXT("ev100"), EV);
			Exposure->SetStringField(TEXT("compensation"), TEXT("project"));
			auto Initial = MakeShared<FJsonObject>();
			Initial->SetNumberField(TEXT("minimumFrames"), OverviewFrames);
			Initial->SetObjectField(
				TEXT("camera"),
				UEShedCameraPose(FVector(Overview.GetCenter(), Capture->GetNumberField(TEXT("z"))),
								 FRotator(-90, 0, 0), FMath::Max(Overview.GetSize().X, Overview.GetSize().Y),
								 true));
			auto Size = MakeShared<FJsonObject>();
			Size->SetNumberField(TEXT("width"), Request->GetIntegerField(TEXT("tilePixelSize")));
			Size->SetNumberField(TEXT("height"), Request->GetIntegerField(TEXT("tilePixelSize")));
			Initial->SetObjectField(TEXT("size"), Size);
			RenderPolicy->GetObjectField(TEXT("settling"))->SetObjectField(TEXT("initialView"), Initial);
		}
		else
		{
			Exposure->SetStringField(TEXT("mode"), TEXT("meter_once"));
			Exposure->SetNumberField(TEXT("minimumFrames"), OverviewFrames);
			Exposure->SetObjectField(
				TEXT("referenceCamera"),
				UEShedCameraPose(FVector(Overview.GetCenter(), Capture->GetNumberField(TEXT("z"))),
								 FRotator(-90, 0, 0), FMath::Max(Overview.GetSize().X, Overview.GetSize().Y),
								 true));
			auto Size = MakeShared<FJsonObject>();
			Size->SetNumberField(TEXT("width"), Request->GetIntegerField(TEXT("tilePixelSize")));
			Size->SetNumberField(TEXT("height"), Request->GetIntegerField(TEXT("tilePixelSize")));
			Exposure->SetObjectField(TEXT("referenceSize"), Size);
		}
		RenderPolicy->SetObjectField(TEXT("exposure"), Exposure);
		TSharedPtr<FJsonObject> Error;
		auto Renderer = FUEShedCameraRenderSession::Open(RequestRender, Error);
		if (!Renderer)
		{
			Reject(Error->GetStringField(TEXT("message")));
			return;
		}
		Run = MakeUnique<FLitRun>();
		Run->Renderer = Renderer;
		Run->RunId = RunId;
		Run->World = World;
		Run->MapPath = World->GetOutermost()->GetName();
		Run->Policy = Policy;
		Run->DirtyBefore = World->GetOutermost()->IsDirty();
		if (!TickHandle.IsValid())
			TickHandle = FSlateApplication::Get().OnPostTick().AddLambda([](float) {
				if (Run)
					Run->Tick();
			});
	}
	Run->FramePrefix = FGuid::NewGuid().ToString(EGuidFormats::Digits);
	Run->OperationId = OperationId;
	Run->CorrelationId = CorrelationId;
	Run->Tiles = MoveTemp(Tiles);
	Run->Pixels = Request->GetIntegerField(TEXT("tilePixelSize"));
	Run->Gutter = Request->GetIntegerField(TEXT("gutterPixels"));
	Run->BatchStarted = FPlatformTime::Seconds();
	Run->TileIndex = 0;
	Run->Results.Reset();
	Run->Done = false;
	Run->PrepareTile();
	ResultJson = Status();
}

void UUEShedCameraReviewLibrary::PollMapTileCapture(const FString &RunId, const FString &OperationId,
													FString &ResultJson)
{
	if (!Run || Run->RunId != RunId || Run->OperationId != OperationId)
	{
		ResultJson = Finished(
			Response(TEXT("unknown"), TEXT("unknown"), FString(), false,
					 Failure(TEXT("capture_failed"), TEXT("No matching map capture operation is active."))));
		return;
	}
	Run->Renderer->Touch();
	ResultJson = Status();
}

void UUEShedCameraReviewLibrary::EndMapTileCapture(const FString &RunId, FString &ResultJson)
{
	const bool Released = Run && Run->RunId == RunId;
	const bool Restored = !Released || Run->Restore();
	if (Released && Restored)
		Run.Reset();
	auto Value = MakeShared<FJsonObject>();
	Value->SetBoolField(TEXT("released"), Released);
	Value->SetStringField(TEXT("restoration"), Restored ? TEXT("restored") : TEXT("failed"));
	ResultJson = Json(Value);
}

void ShutdownUEShedLitMapTileCapture()
{
	Run.Reset();
	if (FSlateApplication::IsInitialized())
		FSlateApplication::Get().OnPostTick().Remove(TickHandle);
	FWorldDelegates::OnWorldCleanup.Remove(WorldHandle);
	FEditorDelegates::PreBeginPIE.Remove(PIEHandle);
	TickHandle.Reset();
	WorldHandle.Reset();
	PIEHandle.Reset();
}

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedLitMapValidationTest, "UEShed.Cameras.MapCapture.LitValidation",
								 EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedLitMapValidationTest::RunTest(const FString &Parameters)
{
	// FEngineShowFlags must use a real initial mode; its default constructor fatals outside hot reload.
	FLitRun State;
	State.Restored = true;
	State.OperationId = TEXT("cancelled-operation");
	State.CorrelationId = TEXT("cancelled-correlation");
	State.Finish(TEXT("cancelled"), TEXT("The capture world was unloaded."));
	TestTrue(TEXT("Cancelled operation remains pollable"), State.Done);
	TestEqual(TEXT("Cancellation retains operation identity"),
			  State.BatchResponse->GetStringField(TEXT("operationId")), State.OperationId);
	TestEqual(TEXT("Cancellation retains correlation identity"),
			  State.BatchResponse->GetStringField(TEXT("correlationId")), State.CorrelationId);
	TestEqual(TEXT("Cancellation has terminal status"), State.BatchResponse->GetStringField(TEXT("status")),
			  FString(TEXT("cancelled")));
	TSharedPtr<FJsonObject> Request;
	FJsonSerializer::Deserialize(
		TJsonReaderFactory<>::Create(
			FString(TEXT("{\"tilePixelSize\":64,\"gutterPixels\":16,\"capture\":{\"z\":1000},\"tiles\":[{"
						 "\"key\":{\"zoom\":0,\"row\":0,\"column\":0},\"unitsPerPixel\":1,\"worldBounds\":{"
						 "\"minX\":-64,\"maxX\":0,\"minY\":0,\"maxY\":64}}]}"))),
		Request);
	TArray<FTile> Tiles;
	FBox2D Overview(ForceInit);
	TestTrue(TEXT("Valid tile accepted"), ReadTiles(Request, Tiles, Overview));
	TestEqual(TEXT("Top-down tile center"), Tiles[0].Location, FVector(-32, 32, 1000));
	TestEqual(TEXT("Gutter world coverage"), Tiles[0].Width, 96.0);
	const auto OriginalTiles = Request->GetArrayField(TEXT("tiles"));
	Request->SetArrayField(TEXT("tiles"), {OriginalTiles[0], OriginalTiles[0]});
	Tiles.Reset();
	Overview.Init();
	TestFalse(TEXT("Duplicate keys rejected"), ReadTiles(Request, Tiles, Overview));
	Request->SetArrayField(TEXT("tiles"), OriginalTiles);
	OriginalTiles[0]->AsObject()->SetNumberField(TEXT("unitsPerPixel"), 2);
	Tiles.Reset();
	Overview.Init();
	TestFalse(TEXT("Mismatched pixel and world coverage rejected"), ReadTiles(Request, Tiles, Overview));
	OriginalTiles[0]->AsObject()->SetNumberField(TEXT("unitsPerPixel"), 1);
	OriginalTiles[0]->AsObject()->GetObjectField(TEXT("key"))->SetNumberField(TEXT("zoom"), 24);
	Tiles.Reset();
	Overview.Init();
	TestFalse(TEXT("Out-of-contract zoom rejected"), ReadTiles(Request, Tiles, Overview));
	OriginalTiles[0]->AsObject()->GetObjectField(TEXT("key"))->SetNumberField(TEXT("zoom"), 0);
	Request->SetStringField(TEXT("overviewBounds"), TEXT("invalid"));
	Tiles.Reset();
	Overview.Init();
	TestFalse(TEXT("Malformed overview rejected"), ReadTiles(Request, Tiles, Overview));
	return true;
}
#endif

void UUEShedCameraReviewLibrary::InspectMapCaptureReadiness(const FString &ExpectedMapPath,
															FString &ResultJson)
{
	UWorld *World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	auto Value = MakeShared<FJsonObject>();
	const auto Issues = Readiness(World, ExpectedMapPath);
	Value->SetNumberField(TEXT("schemaVersion"), 1);
	Value->SetStringField(TEXT("backend"), TEXT("lit_camera_tiles"));
	Value->SetBoolField(TEXT("ready"), Issues.IsEmpty());
	Value->SetArrayField(TEXT("blockers"), Issues);
	if (World)
		Value->SetStringField(TEXT("actualMapPath"), World->GetOutermost()->GetName());
	ResultJson = Json(Value);
}
