#include "UEShedLitMapTileCapture.h"
#include "UEShedCameraReviewLibrary.h"
#include "UEShedMapCaptureFreeze.h"

#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "HighResScreenshot.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Misc/Paths.h"
#include "SceneManagement.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UnrealClient.h"

DEFINE_LOG_CATEGORY_STATIC(LogUEShedLitMapCapture, Log, All);

namespace
{
constexpr int32 SettleFrames = 128;
constexpr int32 OverviewFrames = 512;
constexpr double LeaseSeconds = 120.0;
const FText RealtimeOwner = NSLOCTEXT("UEShed", "MapCaptureRealtime", "UE Shed Map Capture");

FString Json(const TSharedPtr<FJsonObject>& Value)
{
	FString Text;
	FJsonSerializer::Serialize(Value.ToSharedRef(), TJsonWriterFactory<>::Create(&Text));
	return Text;
}

TSharedPtr<FJsonObject> Failure(const FString& Code, const FString& Message)
{
	auto Value = MakeShared<FJsonObject>();
	Value->SetStringField(TEXT("code"), Code);
	Value->SetStringField(TEXT("message"), Message);
	Value->SetStringField(TEXT("recovery"), TEXT("Inspect the editor state and retry the capture. Use a visible, unlocked Level Editor viewport."));
	Value->SetBoolField(TEXT("retrySafe"), Code != TEXT("invalid_request"));
	return Value;
}

TSharedPtr<FJsonObject> Response(const FString& Operation, const FString& Correlation,
	const FString& Map, bool Dirty, const TSharedPtr<FJsonObject>& Error)
{
	auto Value = MakeShared<FJsonObject>();
	auto Contract = MakeShared<FJsonObject>();
	auto Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1); Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-map-tile-capture"));
	Contract->SetObjectField(TEXT("version"), Version);
	Value->SetObjectField(TEXT("contract"), Contract);
	Value->SetStringField(TEXT("operationId"), Operation);
	Value->SetStringField(TEXT("correlationId"), Correlation);
	if (!Map.IsEmpty()) Value->SetStringField(TEXT("actualMapPath"), Map);
	auto DirtyState = MakeShared<FJsonObject>();
	DirtyState->SetBoolField(TEXT("before"), Dirty); DirtyState->SetBoolField(TEXT("after"), Dirty);
	Value->SetObjectField(TEXT("dirtyState"), DirtyState);
	Value->SetNumberField(TEXT("durationMs"), 0);
	Value->SetArrayField(TEXT("results"), {});
	auto Counts = MakeShared<FJsonObject>();
	Counts->SetNumberField(TEXT("requested"), 0); Counts->SetNumberField(TEXT("succeeded"), 0); Counts->SetNumberField(TEXT("failed"), 0);
	Value->SetObjectField(TEXT("tileCounts"), Counts);
	Value->SetStringField(TEXT("status"), Error ? TEXT("failed") : TEXT("completed"));
	if (Error) Value->SetObjectField(TEXT("failure"), Error);
	return Value;
}

FString Finished(const TSharedPtr<FJsonObject>& Value)
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

bool Number(const TSharedPtr<FJsonObject>& Object, const TCHAR* Name, double& Out)
{
	return Object->TryGetNumberField(Name, Out) && FMath::IsFinite(Out);
}

bool Bounds(const TSharedPtr<FJsonObject>& Value, FBox2D& Out)
{
	double MinX, MaxX, MinY, MaxY;
	if (!Number(Value, TEXT("minX"), MinX) || !Number(Value, TEXT("maxX"), MaxX)
		|| !Number(Value, TEXT("minY"), MinY) || !Number(Value, TEXT("maxY"), MaxY)
		|| MaxX <= MinX || MaxY <= MinY
		|| !FMath::IsFinite(MaxX - MinX) || !FMath::IsFinite(MaxY - MinY)
		|| MaxX - MinX > MAX_flt || MaxY - MinY > MAX_flt
		|| !FMath::IsFinite(MinX + MaxX) || !FMath::IsFinite(MinY + MaxY)) return false;
	Out = FBox2D(FVector2D(MinX, MinY), FVector2D(MaxX, MaxY));
	return true;
}

bool ReadTiles(const TSharedPtr<FJsonObject>& Request, TArray<FTile>& Out, FBox2D& Overview)
{
	const int32 Pixels = Request->GetIntegerField(TEXT("tilePixelSize"));
	const int32 Gutter = Request->GetIntegerField(TEXT("gutterPixels"));
	const double Z = Request->GetObjectField(TEXT("capture"))->GetNumberField(TEXT("z"));
	TSet<FString> Keys;
	for (const auto& Value : Request->GetArrayField(TEXT("tiles")))
	{
		const TSharedPtr<FJsonObject>* Tile; const TSharedPtr<FJsonObject>* Key; const TSharedPtr<FJsonObject>* Box;
		double Zoom, Row, Column, Units; FBox2D WorldBounds;
		if (!Value->TryGetObject(Tile) || !(*Tile)->TryGetObjectField(TEXT("key"), Key)
			|| !(*Tile)->TryGetObjectField(TEXT("worldBounds"), Box) || !Bounds(*Box, WorldBounds)
			|| !Number(*Tile, TEXT("unitsPerPixel"), Units) || Units <= 0
			|| !Number(*Key, TEXT("zoom"), Zoom) || !Number(*Key, TEXT("row"), Row) || !Number(*Key, TEXT("column"), Column)) return false;
		for (double Index : {Zoom, Row, Column})
			if (Index < 0 || Index > MAX_int32 || Index != FMath::FloorToDouble(Index)) return false;
		if (!FMath::IsFinite((Pixels + Gutter * 2) * Units)
			|| (Pixels + Gutter * 2) * Units > MAX_flt) return false;
		if (Zoom > 23 || !FMath::IsNearlyEqual(WorldBounds.GetSize().X, Pixels * Units, .01)
			|| !FMath::IsNearlyEqual(WorldBounds.GetSize().Y, Pixels * Units, .01)) return false;
		FString Path = FString::Printf(TEXT("Z%02d/R%03d_C%03d.png"), int32(Zoom), int32(Row), int32(Column));
		if (Keys.Contains(Path)) return false;
		Keys.Add(Path);
		Out.Add({*Key, FVector(WorldBounds.GetCenter(), Z), (Pixels + Gutter * 2) * Units, Path});
		Overview += WorldBounds;
	}
	const TSharedPtr<FJsonObject>* RequestedOverview;
	if (Request->HasField(TEXT("overviewBounds")) && !Request->TryGetObjectField(TEXT("overviewBounds"), RequestedOverview)) return false;
	if (Request->TryGetObjectField(TEXT("overviewBounds"), RequestedOverview))
	{
		FBox2D Box;
		if (!Bounds(*RequestedOverview, Box) || !Box.IsInsideOrOn(Overview.Min) || !Box.IsInsideOrOn(Overview.Max)) return false;
		Overview = Box;
	}
	return true;
}

struct FLitRun
{
	FString RunId, OperationId, CorrelationId, Policy, MapPath;
	TWeakObjectPtr<UWorld> World;
	TWeakObjectPtr<ACameraActor> Camera;
	FLevelEditorViewportClient* Client = nullptr;
	ELevelViewportType ViewportType;
	FViewportCameraTransform PerspectiveTransform, OrthographicTransform;
	FEngineShowFlags LastShowFlags{ESFIM_Editor};
	float SavedViewFOV, SavedAspectRatio;
	FVector ViewLocation; FRotator ViewRotation; float OrthoZoom;
	EViewModeIndex PerspectiveMode, OrthoMode;
	FEngineShowFlags ShowFlags{ESFIM_Editor};
	FExposureSettings Exposure;
	FHighResScreenshotConfig ScreenshotConfig;
	uint32 ResolutionX, ResolutionY;
	bool GameView, LockedCamera, DisableInput, EnableFading, DrawAxes, DrawAxesGame;
	bool DirtyBefore = false, Frozen = false, Initializing = true, Pending = false, Done = false, Restored = false;
	double LastPoll = FPlatformTime::Seconds(), TileStarted = LastPoll, BatchStarted = LastPoll;
	int32 Frames = 0, TileIndex = 0, Pixels = 0, Gutter = 0;
	TArray<FTile> Tiles;
	TArray<TSharedPtr<FJsonValue>> Results;
	TSharedPtr<FJsonObject> BatchResponse;
	FString RawPath;
	TOptional<double> ExplicitEV;

	bool ClientAlive() const
	{
		return GEditor && GEditor->GetLevelViewportClients().Contains(Client) && Client->Viewport;
	}

	void Restore()
	{
		if (Restored) return;
		Restored = true;
		if (Pending) { FScreenshotRequest::Reset(); GIsHighResScreenshot = false; }
		if (ClientAlive())
		{
			Client->SetActorLock(nullptr); Client->bLockedCameraView = LockedCamera;
			Client->UpdateViewForLockedActor();
			Client->SetViewportType(ViewportType); Client->SetViewLocation(ViewLocation);
			Client->SetViewRotation(ViewRotation); Client->SetOrthoZoom(OrthoZoom);
			Client->ViewTransformPerspective = PerspectiveTransform;
			Client->ViewTransformOrthographic = OrthographicTransform;
			Client->ViewFOV = SavedViewFOV; Client->AspectRatio = SavedAspectRatio;
			Client->SetGameView(GameView); Client->SetViewModes(PerspectiveMode, OrthoMode);
			Client->DisableOverrideEngineShowFlags(); Client->EngineShowFlags = ShowFlags;
			Client->LastEngineShowFlags = LastShowFlags;
			Client->ExposureSettings = Exposure; Client->bDisableInput = DisableInput;
			Client->bEnableFading = EnableFading; Client->bDrawAxes = DrawAxes; Client->bDrawAxesGame = DrawAxesGame;
			Client->RemoveRealtimeOverride(RealtimeOwner, false);
		}
		GetHighResScreenshotConfig() = ScreenshotConfig;
		GScreenshotResolutionX = ResolutionX; GScreenshotResolutionY = ResolutionY;
		EndUEShedOwnedMapFreeze(RunId);
		if (Camera.IsValid()) Camera->Destroy();
		UE_LOG(LogUEShedLitMapCapture, Display, TEXT("capture.restore run=%s"), *RunId);
	}

	~FLitRun() { Restore(); }

	void Finish(const FString& Code = FString(), const FString& Message = FString())
	{
		Done = true;
		BatchResponse = Response(OperationId, CorrelationId, MapPath, DirtyBefore,
			Code.IsEmpty() ? nullptr : Failure(Code, Message));
		BatchResponse->SetArrayField(TEXT("results"), Results);
		auto Counts = BatchResponse->GetObjectField(TEXT("tileCounts"));
		Counts->SetNumberField(TEXT("requested"), Results.Num());
		Counts->SetNumberField(TEXT("succeeded"), Results.Num());
		BatchResponse->SetNumberField(TEXT("durationMs"), (FPlatformTime::Seconds() - BatchStarted) * 1000);
		BatchResponse->GetObjectField(TEXT("dirtyState"))->SetBoolField(TEXT("after"), World.IsValid() && World->GetOutermost()->IsDirty());
		if (Code == TEXT("cancelled")) BatchResponse->SetStringField(TEXT("status"), TEXT("cancelled"));
		if (!Code.IsEmpty()) Restore();
		UE_LOG(LogUEShedLitMapCapture, Display, TEXT("capture.batch_finished run=%s operation=%s tiles=%d failure=%s"), *RunId, *OperationId, Results.Num(), *Code);
	}

	void PrepareTile()
	{
		const auto& Tile = Tiles[TileIndex];
		Camera->SetActorLocation(Tile.Location);
		Camera->GetCameraComponent()->SetOrthoWidth(Tile.Width);
		Client->SetActorLock(Camera.Get()); Client->UpdateViewForLockedActor();
		Frames = 0; Pending = false; TileStarted = FPlatformTime::Seconds();
		RawPath = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/MapTileStaging"), RunId,
			TEXT("raw"), OperationId + FString::Printf(TEXT("_%d.png"), TileIndex));
	}

	void Tick()
	{
		if (Restored) return;
		if (!World.IsValid() || !ClientAlive() || GEditor->PlayWorld
			|| GEditor->GetEditorWorldContext().World() != World.Get())
		{ Finish(TEXT("cancelled"), TEXT("The editor world or capture viewport changed.")); return; }
		if (FPlatformTime::Seconds() - LastPoll > LeaseSeconds)
		{ Finish(TEXT("cancelled"), TEXT("The capture client stopped renewing its lease.")); return; }
		if (Frozen && !RenewUEShedOwnedMapFreeze(RunId))
		{ Finish(TEXT("cancelled"), TEXT("The capture scene freeze was released.")); return; }
		if (Done) return;
		if (World->GetOutermost()->IsDirty() != DirtyBefore)
		{ Finish(TEXT("dirty_state_changed"), TEXT("The map dirty state changed during capture.")); return; }
		if (FPlatformTime::Seconds() - TileStarted > LeaseSeconds)
		{ Finish(TEXT("capture_failed"), TEXT("The viewport did not complete capture within 120 seconds.")); return; }
		++Frames;
		if (Initializing)
		{
			if (Frames < OverviewFrames) return;
			if (!ExplicitEV.IsSet())
			{
				auto* State = Client->ViewState.GetReference();
				const float Adapted = State ? State->GetLastEyeAdaptationExposure() : 0;
				if (!FMath::IsFinite(Adapted) || Adapted <= 0)
				{ Finish(TEXT("capture_failed"), TEXT("Whole-map exposure is unavailable; provide exposureEV100 or retry after viewport warmup.")); return; }
				const auto* Lens = IConsoleManager::Get().FindConsoleVariable(TEXT("r.EyeAdaptation.LensAttenuation"));
				const float MaxLuminance = .78f / FMath::Max(.01f, Lens ? Lens->GetFloat() : .78f);
				Client->ExposureSettings.bFixed = true;
				Client->ExposureSettings.FixedEV100 = FMath::Log2(1.0f / (Adapted * MaxLuminance));
				UE_LOG(LogUEShedLitMapCapture, Display, TEXT("capture.exposure_locked run=%s ev100=%.6f"), *RunId, Client->ExposureSettings.FixedEV100);
			}
			if (!BeginUEShedOwnedMapFreeze(World.Get(), RunId))
			{ Finish(TEXT("capture_failed"), TEXT("Another scene freeze owns the editor world.")); return; }
			Frozen = true; Initializing = false; PrepareTile(); return;
		}
		if (!Pending)
		{
			if (Frames < SettleFrames) return;
			IFileManager::Get().MakeDirectory(*FPaths::GetPath(RawPath), true);
			auto& Config = GetHighResScreenshotConfig();
			Config.SetResolution(Pixels + Gutter * 2, Pixels + Gutter * 2);
			Config.SetFilename(RawPath); Config.SetMaskEnabled(false); Config.SetHDRCapture(false);
			Config.bDumpBufferVisualizationTargets = false; Config.bDateTimeBasedNaming = false;
			Client->Viewport->TakeHighResScreenShot(); Pending = true; return;
		}
		if (GIsHighResScreenshot || FScreenshotRequest::IsScreenshotRequested() || !FPaths::FileExists(RawPath)) return;
		FImage Image;
		if (!FImageUtils::LoadImage(*RawPath, Image)) return; // Image queue may still be closing the file.
		if (Image.SizeX != Pixels + Gutter * 2 || Image.SizeY != Pixels + Gutter * 2)
		{ Finish(TEXT("capture_failed"), TEXT("Viewport screenshot dimensions differ from the tile request.")); return; }
		Image.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
		TArray<FColor> Crop; Crop.SetNumUninitialized(Pixels * Pixels);
		for (int32 Row = 0; Row < Pixels; ++Row)
			FMemory::Memcpy(Crop.GetData() + Row * Pixels,
				Image.RawData.GetData() + ((Row + Gutter) * Image.SizeX + Gutter) * sizeof(FColor), Pixels * sizeof(FColor));
		const FString Path = FPaths::ConvertRelativePathToFull(FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/MapTileStaging"), RunId, Tiles[TileIndex].RelativePath));
		IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
		if (!FImageUtils::SaveImageByExtension(*Path, FImageView(Crop.GetData(), Pixels, Pixels)))
		{ Finish(TEXT("write_failed"), TEXT("The cropped map tile could not be written.")); return; }
		IFileManager::Get().Delete(*RawPath);
		auto Result = MakeShared<FJsonObject>();
		Result->SetObjectField(TEXT("key"), Tiles[TileIndex].Key);
		Result->SetStringField(TEXT("status"), TEXT("captured")); Result->SetStringField(TEXT("stagedPath"), Path);
		Result->SetNumberField(TEXT("width"), Pixels); Result->SetNumberField(TEXT("height"), Pixels);
		Result->SetNumberField(TEXT("bytes"), IFileManager::Get().FileSize(*Path));
		Result->SetNumberField(TEXT("captureDurationMs"), (FPlatformTime::Seconds() - TileStarted) * 1000);
		Results.Add(MakeShared<FJsonValueObject>(Result)); Pending = false;
		if (++TileIndex == Tiles.Num()) Finish(); else PrepareTile();
	}
};

TUniquePtr<FLitRun> Run;
FDelegateHandle TickHandle, WorldHandle, PIEHandle;

FString Status()
{
	if (Run->Done) return Finished(Run->BatchResponse);
	auto Value = MakeShared<FJsonObject>();
	Value->SetStringField(TEXT("state"), TEXT("running"));
	Value->SetStringField(TEXT("operationId"), Run->OperationId);
	Value->SetNumberField(TEXT("completedTiles"), Run->Results.Num());
	return Json(Value);
}
}

void BeginUEShedLitMapTileCapture(const TSharedPtr<FJsonObject>& Request, UWorld* World, FString& ResultJson)
{
	const FString RunId = Request->GetStringField(TEXT("runId"));
	const FString OperationId = Request->GetStringField(TEXT("operationId"));
	const FString CorrelationId = Request->GetStringField(TEXT("correlationId"));
	auto Reject = [&](const FString& Message)
	{
		ResultJson = Finished(Response(OperationId, CorrelationId, World->GetOutermost()->GetName(), World->GetOutermost()->IsDirty(), Failure(TEXT("invalid_request"), Message)));
	};
	if (Run && Run->Restored) Run.Reset();
	if (Run && (Run->RunId != RunId || !Run->Done)) { Reject(TEXT("Another map capture batch owns the viewport.")); return; }
	const auto Capture = Request->GetObjectField(TEXT("capture"));
	const auto Render = Capture->GetObjectField(TEXT("render"));
	if (Render->GetStringField(TEXT("lodPolicy")) != TEXT("natural") || Render->GetStringField(TEXT("profile")) != TEXT("full_fidelity"))
	{ Reject(TEXT("Lit camera tiles require full_fidelity with natural LOD policy. Use an explicit SceneCapture backend for other profiles.")); return; }
	const FString Policy = Json(Capture);
	if (Run && (Run->World.Get() != World || Run->Policy != Policy)) { Reject(TEXT("Capture policy or world changed within a run.")); return; }
	TArray<FTile> Tiles; FBox2D Overview(ForceInit);
	if (!ReadTiles(Request, Tiles, Overview)) { Reject(TEXT("Tile keys, coverage or overview bounds are invalid.")); return; }
	double EV = 0;
	if (Render->HasField(TEXT("exposureEV100")) && (!Number(Render, TEXT("exposureEV100"), EV) || EV < -20 || EV > 30))
	{ Reject(TEXT("exposureEV100 must be finite and between -20 and 30.")); return; }
	if (!Run)
	{
		auto* Client = GCurrentLevelEditingViewportClient;
		if (!FSlateApplication::IsInitialized() || GEditor->PlayWorld || !Client || !Client->Viewport
			|| Client->IsAnyActorLocked() || Client->IsEngineShowFlagsOverrideEnabled()
			|| GIsHighResScreenshot || FScreenshotRequest::IsScreenshotRequested())
		{ Reject(TEXT("Lit capture requires an available unlocked editor viewport with no screenshot or show-flag override in progress.")); return; }
		Run = MakeUnique<FLitRun>();
		Run->RunId = RunId; Run->World = World; Run->MapPath = World->GetOutermost()->GetName(); Run->Policy = Policy;
		Run->Client = Client; Run->DirtyBefore = World->GetOutermost()->IsDirty();
		Run->PerspectiveTransform = Client->ViewTransformPerspective; Run->OrthographicTransform = Client->ViewTransformOrthographic;
		Run->LastShowFlags = Client->LastEngineShowFlags; Run->SavedViewFOV = Client->ViewFOV; Run->SavedAspectRatio = Client->AspectRatio;
		Run->ViewportType = Client->GetViewportType(); Run->ViewLocation = Client->GetViewLocation(); Run->ViewRotation = Client->GetViewRotation(); Run->OrthoZoom = Client->GetOrthoZoom();
		Run->PerspectiveMode = Client->GetPerspViewMode(); Run->OrthoMode = Client->GetOrthoViewMode(); Run->ShowFlags = Client->EngineShowFlags;
		Run->Exposure = Client->ExposureSettings; Run->GameView = Client->IsInGameView(); Run->LockedCamera = Client->bLockedCameraView;
		Run->DisableInput = Client->bDisableInput; Run->EnableFading = Client->bEnableFading; Run->DrawAxes = Client->bDrawAxes; Run->DrawAxesGame = Client->bDrawAxesGame;
		Run->ScreenshotConfig = GetHighResScreenshotConfig(); Run->ResolutionX = GScreenshotResolutionX; Run->ResolutionY = GScreenshotResolutionY;
		FActorSpawnParameters Spawn; Spawn.ObjectFlags = RF_Transient; Spawn.bHideFromSceneOutliner = true;
		auto* Camera = World->SpawnActor<ACameraActor>(FVector(Overview.GetCenter(), Capture->GetNumberField(TEXT("z"))), FRotator(-90, 0, 0), Spawn);
		if (!Camera) { Run.Reset(); Reject(TEXT("Could not create the transient capture camera.")); return; }
		Run->Camera = Camera;
		auto* Component = Camera->GetCameraComponent(); Component->SetProjectionMode(ECameraProjectionMode::Orthographic);
		Component->SetAspectRatio(1); Component->SetConstraintAspectRatio(false);
		Component->SetOrthoWidth(FMath::Max(Overview.GetSize().X, Overview.GetSize().Y));
		Component->PostProcessBlendWeight = 1;
		Component->PostProcessSettings.bOverride_VignetteIntensity = true; Component->PostProcessSettings.VignetteIntensity = 0;
		if (Render->HasField(TEXT("exposureEV100")))
		{
			Run->ExplicitEV = EV;
			auto& PP = Component->PostProcessSettings;
			PP.bOverride_AutoExposureMinBrightness = true; PP.bOverride_AutoExposureMaxBrightness = true;
			const auto* Extended = IConsoleManager::Get().FindConsoleVariable(TEXT("r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange"));
			const auto* Lens = IConsoleManager::Get().FindConsoleVariable(TEXT("r.EyeAdaptation.LensAttenuation"));
			const float LuminanceMax = .78f / FMath::Max(.01f, Lens ? Lens->GetFloat() : .78f);
			PP.AutoExposureMinBrightness = PP.AutoExposureMaxBrightness = Extended && Extended->GetInt() ? EV : LuminanceMax * FMath::Pow(2.0, EV);
		}
		Client->SetViewportType(LVT_Perspective); Client->SetGameView(true); Client->SetViewModes(VMI_Lit, VMI_Lit);
		Client->ExposureSettings.bFixed = false; Client->bLockedCameraView = true; Client->bDisableInput = true; Client->bEnableFading = false;
		Client->bDrawAxes = false; Client->bDrawAxesGame = false;
		const auto Effects = Render->GetObjectField(TEXT("effects"));
		const bool Fog = Effects->GetBoolField(TEXT("fog")), VolumetricFog = Effects->GetBoolField(TEXT("volumetricFog"));
		Client->EnableOverrideEngineShowFlags([Fog, VolumetricFog](FEngineShowFlags& Flags) { Flags.SetFog(Fog); Flags.SetVolumetricFog(VolumetricFog); Flags.SetSelection(false); Flags.SetSelectionOutline(false); Flags.SetModeWidgets(false); });
		Client->AddRealtimeOverride(true, RealtimeOwner); Client->SetActorLock(Camera); Client->UpdateViewForLockedActor();
		if (!TickHandle.IsValid())
		{
			TickHandle = FSlateApplication::Get().OnPostTick().AddLambda([](float) { if (Run) Run->Tick(); });
			WorldHandle = FWorldDelegates::OnWorldCleanup.AddLambda([](UWorld* Target, bool, bool) { if (Run && !Run->Restored && Run->World.Get() == Target) Run->Finish(TEXT("cancelled"), TEXT("The capture world was unloaded.")); });
			PIEHandle = FEditorDelegates::PreBeginPIE.AddLambda([](bool) { if (Run && !Run->Restored) Run->Finish(TEXT("cancelled"), TEXT("PIE started during map capture.")); });
		}
	}
	Run->OperationId = OperationId; Run->CorrelationId = CorrelationId; Run->Tiles = MoveTemp(Tiles);
	Run->Pixels = Request->GetIntegerField(TEXT("tilePixelSize")); Run->Gutter = Request->GetIntegerField(TEXT("gutterPixels"));
	Run->LastPoll = Run->BatchStarted = Run->TileStarted = FPlatformTime::Seconds(); Run->TileIndex = 0; Run->Results.Reset(); Run->Done = false;
	if (!Run->Initializing) Run->PrepareTile();
	ResultJson = Status();
}

void UUEShedCameraReviewLibrary::PollMapTileCapture(const FString& RunId, const FString& OperationId, FString& ResultJson)
{
	if (!Run || Run->RunId != RunId || Run->OperationId != OperationId)
	{
		ResultJson = Finished(Response(TEXT("unknown"), TEXT("unknown"), FString(), false, Failure(TEXT("capture_failed"), TEXT("No matching map capture operation is active.")))); return;
	}
	Run->LastPoll = FPlatformTime::Seconds(); ResultJson = Status();
}

void UUEShedCameraReviewLibrary::EndMapTileCapture(const FString& RunId, FString& ResultJson)
{
	const bool Released = Run && Run->RunId == RunId;
	if (Released) Run.Reset();
	auto Value = MakeShared<FJsonObject>(); Value->SetBoolField(TEXT("released"), Released); ResultJson = Json(Value);
}

void ShutdownUEShedLitMapTileCapture()
{
	Run.Reset();
	if (FSlateApplication::IsInitialized()) FSlateApplication::Get().OnPostTick().Remove(TickHandle);
	FWorldDelegates::OnWorldCleanup.Remove(WorldHandle); FEditorDelegates::PreBeginPIE.Remove(PIEHandle);
	TickHandle.Reset(); WorldHandle.Reset(); PIEHandle.Reset();
}

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedLitMapValidationTest,
	"UEShed.Cameras.MapCapture.LitValidation",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedLitMapValidationTest::RunTest(const FString& Parameters)
{
	// FEngineShowFlags must use a real initial mode; its default constructor fatals outside hot reload.
	FLitRun State;
	State.Restored = true;
	State.OperationId = TEXT("cancelled-operation"); State.CorrelationId = TEXT("cancelled-correlation");
	State.Finish(TEXT("cancelled"), TEXT("The capture world was unloaded."));
	TestTrue(TEXT("Cancelled operation remains pollable"), State.Done);
	TestEqual(TEXT("Cancellation retains operation identity"), State.BatchResponse->GetStringField(TEXT("operationId")), State.OperationId);
	TestEqual(TEXT("Cancellation retains correlation identity"), State.BatchResponse->GetStringField(TEXT("correlationId")), State.CorrelationId);
	TestEqual(TEXT("Cancellation has terminal status"), State.BatchResponse->GetStringField(TEXT("status")), FString(TEXT("cancelled")));
	TSharedPtr<FJsonObject> Request;
	FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(FString(TEXT(
		"{\"tilePixelSize\":64,\"gutterPixels\":16,\"capture\":{\"z\":1000},\"tiles\":[{\"key\":{\"zoom\":0,\"row\":0,\"column\":0},\"unitsPerPixel\":1,\"worldBounds\":{\"minX\":-64,\"maxX\":0,\"minY\":0,\"maxY\":64}}]}"))), Request);
	TArray<FTile> Tiles; FBox2D Overview(ForceInit);
	TestTrue(TEXT("Valid tile accepted"), ReadTiles(Request, Tiles, Overview));
	TestEqual(TEXT("Top-down tile center"), Tiles[0].Location, FVector(-32, 32, 1000));
	TestEqual(TEXT("Gutter world coverage"), Tiles[0].Width, 96.0);
	const auto OriginalTiles = Request->GetArrayField(TEXT("tiles"));
	Request->SetArrayField(TEXT("tiles"), {OriginalTiles[0], OriginalTiles[0]}); Tiles.Reset(); Overview.Init();
	TestFalse(TEXT("Duplicate keys rejected"), ReadTiles(Request, Tiles, Overview));
	Request->SetArrayField(TEXT("tiles"), OriginalTiles);
	OriginalTiles[0]->AsObject()->SetNumberField(TEXT("unitsPerPixel"), 2); Tiles.Reset(); Overview.Init();
	TestFalse(TEXT("Mismatched pixel and world coverage rejected"), ReadTiles(Request, Tiles, Overview));
	OriginalTiles[0]->AsObject()->SetNumberField(TEXT("unitsPerPixel"), 1);
	OriginalTiles[0]->AsObject()->GetObjectField(TEXT("key"))->SetNumberField(TEXT("zoom"), 24); Tiles.Reset(); Overview.Init();
	TestFalse(TEXT("Out-of-contract zoom rejected"), ReadTiles(Request, Tiles, Overview));
	OriginalTiles[0]->AsObject()->GetObjectField(TEXT("key"))->SetNumberField(TEXT("zoom"), 0);
	Request->SetStringField(TEXT("overviewBounds"), TEXT("invalid")); Tiles.Reset(); Overview.Init();
	TestFalse(TEXT("Malformed overview rejected"), ReadTiles(Request, Tiles, Overview));
	return true;
}
#endif
