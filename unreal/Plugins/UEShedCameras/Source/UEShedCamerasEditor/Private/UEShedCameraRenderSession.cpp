#include "UEShedCameraRenderSession.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/SceneCaptureComponent2D.h"
#include "DataLayer/DataLayerEditorSubsystem.h"
#include "Editor.h"
#include "Engine/LevelStreaming.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "HighResScreenshot.h"
#include "ImageUtils.h"
#include "Interfaces/IPluginManager.h"
#include "LevelEditorViewport.h"
#include "Misc/App.h"
#include "Misc/EngineVersion.h"
#include "Misc/Paths.h"
#include "RHIGlobals.h"
#include "SceneManagement.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedCameraRenderingLibrary.h"
#include "UEShedMapCaptureFreeze.h"
#include "UEShedTransientCapture.h"
#include "UnrealClient.h"
#include "WorldPartition/DataLayer/DataLayerAsset.h"
#include "WorldPartition/DataLayer/DataLayerInstance.h"
#include "WorldPartition/DataLayer/DataLayerManager.h"
#include "WorldPartition/LoaderAdapter/LoaderAdapterShape.h"
#include "WorldPartition/WorldPartition.h"

namespace
{
TSharedPtr<FUEShedCameraRenderSession> Owner;
struct FClosedSession
{
	TSharedPtr<FUEShedCameraRenderSession> Session;
	double At;
};
TArray<FClosedSession> ClosedSessions;
FDelegateHandle TickHandle, WorldHandle, PIEHandle;
const FText RealtimeOwner = NSLOCTEXT("UEShed", "CameraRenderRealtime", "UE Shed Camera Rendering");
constexpr int32 RetainedOperations = 64;
constexpr double RetentionSeconds = 120;

TSharedPtr<FJsonObject> Object()
{
	return MakeShared<FJsonObject>();
}
FString PluginVersion()
{
	const auto Plugin = IPluginManager::Get().FindPlugin(TEXT("UEShedCameras"));
	return Plugin ? Plugin->GetDescriptor().VersionName : TEXT("unknown");
}
bool Fields(const TSharedPtr<FJsonObject> &Value, std::initializer_list<const TCHAR *> Required,
			std::initializer_list<const TCHAR *> Optional = {})
{
	if (!Value)
		return false;
	TSet<FString> Allowed;
	for (auto Key : Required)
	{
		if (!Value->HasField(Key))
			return false;
		Allowed.Add(Key);
	}
	for (auto Key : Optional)
		Allowed.Add(Key);
	for (const auto &Entry : Value->Values)
		if (!Allowed.Contains(Entry.Key))
			return false;
	return true;
}
TSharedPtr<FJsonObject> Child(const TSharedPtr<FJsonObject> &Value, const TCHAR *Key)
{
	const TSharedPtr<FJsonObject> *Out;
	return Value && Value->TryGetObjectField(Key, Out) ? *Out : nullptr;
}
FString String(const TSharedPtr<FJsonObject> &Value, const TCHAR *Key)
{
	FString Out;
	if (Value)
		Value->TryGetStringField(Key, Out);
	return Out;
}
bool Number(const TSharedPtr<FJsonObject> &Value, const TCHAR *Key, double Minimum, double Maximum,
			bool Integer = false)
{
	double N;
	return Value && Value->TryGetNumberField(Key, N) && FMath::IsFinite(N) && N >= Minimum && N <= Maximum &&
		   (!Integer || N == FMath::FloorToDouble(N));
}
bool Boolean(const TSharedPtr<FJsonObject> &Value, const TCHAR *Key)
{
	bool Out;
	return Value && Value->TryGetBoolField(Key, Out);
}
bool Identifier(const FString &Value)
{
	if (Value.IsEmpty() || Value.Len() > 128 ||
		!((Value[0] >= 'A' && Value[0] <= 'Z') || (Value[0] >= 'a' && Value[0] <= 'z') ||
		  (Value[0] >= '0' && Value[0] <= '9')))
		return false;
	for (TCHAR C : Value)
		if (!((C >= 'A' && C <= 'Z') || (C >= 'a' && C <= 'z') || (C >= '0' && C <= '9')) && C != '_' &&
			C != '-' && C != '.')
			return false;
	return true;
}
bool MapPath(const FString &Value)
{
	if (!Value.StartsWith(TEXT("/")) || (Value.Len() < 2 || Value.Len() > 1024))
		return false;
	for (TCHAR C : Value)
		if (!((C >= 'A' && C <= 'Z') || (C >= 'a' && C <= 'z') || (C >= '0' && C <= '9')) && C != '/' &&
			C != '_' && C != '-' && C != '.')
			return false;
	return true;
}
bool Vector(const TSharedPtr<FJsonObject> &Value, bool Extent = false)
{
	return Fields(Value, {TEXT("x"), TEXT("y"), TEXT("z")}) &&
		   Number(Value, TEXT("x"), Extent ? 0 : -TNumericLimits<double>::Max(),
				  Extent ? 1e7 : TNumericLimits<double>::Max()) &&
		   Number(Value, TEXT("y"), Extent ? 0 : -TNumericLimits<double>::Max(),
				  Extent ? 1e7 : TNumericLimits<double>::Max()) &&
		   Number(Value, TEXT("z"), Extent ? 0 : -TNumericLimits<double>::Max(),
				  Extent ? 1e7 : TNumericLimits<double>::Max());
}
FVector ReadVector(const TSharedPtr<FJsonObject> &Value)
{
	return FVector(Value->GetNumberField(TEXT("x")), Value->GetNumberField(TEXT("y")),
				   Value->GetNumberField(TEXT("z")));
}
bool Camera(const TSharedPtr<FJsonObject> &Value)
{
	const auto R = Child(Value, TEXT("rotation")), P = Child(Value, TEXT("projection"));
	return Fields(Value, {TEXT("location"), TEXT("rotation"), TEXT("projection")}) &&
		   Vector(Child(Value, TEXT("location"))) && Fields(R, {TEXT("pitch"), TEXT("roll"), TEXT("yaw")}) &&
		   Number(R, TEXT("pitch"), -TNumericLimits<double>::Max(), TNumericLimits<double>::Max()) &&
		   Number(R, TEXT("roll"), -TNumericLimits<double>::Max(), TNumericLimits<double>::Max()) &&
		   Number(R, TEXT("yaw"), -TNumericLimits<double>::Max(), TNumericLimits<double>::Max()) &&
		   ((String(P, TEXT("kind")) == TEXT("perspective") &&
			 Fields(P, {TEXT("kind"), TEXT("horizontalFieldOfView")}) &&
			 Number(P, TEXT("horizontalFieldOfView"), 5, 170)) ||
			(String(P, TEXT("kind")) == TEXT("orthographic") && Fields(P, {TEXT("kind"), TEXT("width")}) &&
			 Number(P, TEXT("width"), 0, 1e9) && P->GetNumberField(TEXT("width")) > 0));
}
bool Size(const TSharedPtr<FJsonObject> &Value)
{
	return Fields(Value, {TEXT("width"), TEXT("height")}) && Number(Value, TEXT("width"), 16, 16384, true) &&
		   Number(Value, TEXT("height"), 16, 16384, true);
}
bool Contract(const TSharedPtr<FJsonObject> &Value)
{
	auto Version = Child(Value, TEXT("version"));
	return Fields(Value, {TEXT("name"), TEXT("version")}) &&
		   String(Value, TEXT("name")) == TEXT("ue-shed-camera-render") &&
		   Fields(Version, {TEXT("major"), TEXT("minor")}) && Number(Version, TEXT("major"), 1, 1) &&
		   Number(Version, TEXT("minor"), 0, 0);
}
TSharedPtr<FJsonObject> Failure(const FString &Session, const FString &Code, const FString &Message,
								const FString &Restoration = TEXT("not_acquired"),
								const FString &Operation = FString())
{
	auto Out = Object();
	Out->SetStringField(TEXT("status"), TEXT("failed"));
	Out->SetStringField(TEXT("sessionId"), Identifier(Session) ? Session : TEXT("unknown"));
	Out->SetStringField(TEXT("code"), Code);
	Out->SetStringField(TEXT("message"), Message);
	Out->SetStringField(TEXT("recovery"), TEXT("Inspect the policy and editor state; use the existing "
											   "operation identity to query an uncertain capture."));
	Out->SetStringField(TEXT("restoration"), Restoration);
	Out->SetArrayField(TEXT("issues"), {});
	if (Identifier(Operation))
		Out->SetStringField(TEXT("operationId"), Operation);
	return Out;
}
void Issue(TArray<TSharedPtr<FJsonValue>> &Issues, const TCHAR *Code, const TCHAR *Path, const TCHAR *Message)
{
	auto Out = Object();
	Out->SetStringField(TEXT("code"), Code);
	Out->SetStringField(TEXT("path"), Path);
	Out->SetStringField(TEXT("message"), Message);
	Out->SetStringField(
		TEXT("recovery"),
		TEXT("Correct the specified policy or prepare an unlocked "
											   "editor world before opening a session."));
	Issues.Add(MakeShared<FJsonValueObject>(Out));
}
bool ValidPolicy(const TSharedPtr<FJsonObject> &P)
{
	if (!Fields(P, {TEXT("renderer"), TEXT("exposure"), TEXT("settling"), TEXT("time"), TEXT("preparation")}))
		return false;
	const auto R = Child(P, TEXT("renderer")), E = Child(P, TEXT("exposure")), S = Child(P, TEXT("settling")),
			   Prep = Child(P, TEXT("preparation"));
	const FString Kind = String(R, TEXT("kind")), Mode = String(E, TEXT("mode"));
	if (Kind == TEXT("editor_viewport"))
	{
		if (!Fields(R, {TEXT("kind"), TEXT("strategy"), TEXT("profile"), TEXT("vignette"), TEXT("fog"),
						TEXT("volumetricFog")}) ||
			String(R, TEXT("strategy")) != TEXT("high_resolution_screenshot") ||
			(String(R, TEXT("profile")) != TEXT("lit") &&
			 String(R, TEXT("profile")) != TEXT("observation")) ||
			(String(R, TEXT("vignette")) != TEXT("project") &&
			 String(R, TEXT("vignette")) != TEXT("disabled")))
			return false;
	}
	else if (Kind == TEXT("scene_capture"))
	{
		if (!Fields(R, {TEXT("kind"), TEXT("profile"), TEXT("lodDistanceScale"), TEXT("fog"),
						TEXT("volumetricFog")}) ||
			!Number(R, TEXT("lodDistanceScale"), .1, 100))
			return false;
		const FString Profile = String(R, TEXT("profile"));
		if (Profile != TEXT("full_fidelity") && Profile != TEXT("seam_stable") &&
			Profile != TEXT("scene_capture_defaults") && Profile != TEXT("observation"))
			return false;
	}
	else
		return false;
	if (!Boolean(R, TEXT("fog")) || !Boolean(R, TEXT("volumetricFog")))
		return false;
	if (Mode == TEXT("project_auto"))
	{
		if (!Fields(E, {TEXT("mode")}))
			return false;
	}
	else if (Mode == TEXT("fixed_ev100"))
	{
		if (!Fields(E, {TEXT("mode"), TEXT("ev100"), TEXT("compensation")}) ||
			!Number(E, TEXT("ev100"), -20, 30) || String(E, TEXT("compensation")) != TEXT("project"))
			return false;
	}
	else if (Mode == TEXT("meter_once"))
	{
		if (!Fields(E,
					{TEXT("mode"), TEXT("referenceCamera"), TEXT("referenceSize"), TEXT("minimumFrames")}) ||
			!Camera(Child(E, TEXT("referenceCamera"))) || !Size(Child(E, TEXT("referenceSize"))) ||
			!Number(E, TEXT("minimumFrames"), 1, 4096, true))
			return false;
	}
	else
		return false;
	if (!Fields(S, {TEXT("minimumFrames"), TEXT("timeoutMs")}, {TEXT("initialView")}) ||
		!Number(S, TEXT("minimumFrames"), 1, 4096, true) || !Number(S, TEXT("timeoutMs"), 1000, 900000, true))
		return false;
	if (S->HasField(TEXT("initialView")))
	{
		const auto Initial = Child(S, TEXT("initialView"));
		if (!Fields(Initial, {TEXT("camera"), TEXT("size"), TEXT("minimumFrames")}) ||
			!Camera(Child(Initial, TEXT("camera"))) || !Size(Child(Initial, TEXT("size"))) ||
			!Number(Initial, TEXT("minimumFrames"), 1, 4096, true))
			return false;
	}
	if (String(P, TEXT("time")) != TEXT("live_editor") &&
		String(P, TEXT("time")) != TEXT("freeze_materials_and_ticks"))
		return false;
	if (!Fields(Prep, {TEXT("geometry"), TEXT("dataLayers")}))
		return false;
	const auto G = Child(Prep, TEXT("geometry"));
	if (String(G, TEXT("mode")) == TEXT("preserve_loading"))
	{
		if (!Fields(G, {TEXT("mode")}))
			return false;
	}
	else if (String(G, TEXT("mode")) == TEXT("camera_regions"))
	{
		if (!Fields(G, {TEXT("mode"), TEXT("maximumRegions"), TEXT("extent")}) ||
			!Vector(Child(G, TEXT("extent")), true) || !Number(G, TEXT("maximumRegions"), 1, 64, true))
			return false;
	}
	else
		return false;
	const TArray<TSharedPtr<FJsonValue>> *Layers;
	if (!Prep->TryGetArrayField(TEXT("dataLayers"), Layers) || Layers->Num() > 64)
		return false;
	TSet<FString> Paths;
	for (const auto &V : *Layers)
	{
		const TSharedPtr<FJsonObject> *L;
		if (!V->TryGetObject(L) || !Fields(*L, {TEXT("assetPath"), TEXT("loaded"), TEXT("visible")}) ||
			!MapPath(String(*L, TEXT("assetPath"))) || !Boolean(*L, TEXT("loaded")) ||
			!Boolean(*L, TEXT("visible")))
			return false;
		if (Paths.Contains(String(*L, TEXT("assetPath"))))
			return false;
		Paths.Add(String(*L, TEXT("assetPath")));
	}
	return true;
}
UDataLayerInstance *FindLayer(const UDataLayerManager *Manager, const FString &Path)
{
	if (!Manager)
		return nullptr;
	UDataLayerInstance *Found = nullptr;
	Manager->ForEachDataLayerInstance([&](UDataLayerInstance *Instance) {
		const auto *Asset = Instance->GetAsset();
		if (Asset && (Asset->GetPathName() == Path || Asset->GetOutermost()->GetName() == Path))
		{
			Found = Instance;
			return false;
		}
		return true;
	});
	return Found;
}
} // namespace

TSharedPtr<FJsonObject> UEShedCameraJson(const FString &Text)
{
	TSharedPtr<FJsonObject> Out;
	if (Text.Len() <= 65536)
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Out);
	return Out;
}
FString UEShedCameraJsonText(const TSharedPtr<FJsonObject> &Value)
{
	FString Text;
	FJsonSerializer::Serialize(Value.ToSharedRef(), TJsonWriterFactory<>::Create(&Text));
	return Text;
}
TSharedPtr<FJsonObject> UEShedCameraContract()
{
	return UEShedCameraJson(
		TEXT("{\"name\":\"ue-shed-camera-render\",\"version\":{\"major\":1,\"minor\":0}}"));
}
TSharedPtr<FJsonObject> UEShedCameraPose(const FVector &Location, const FRotator &Rotation,
										 double ProjectionValue, bool bOrthographic)
{
	auto Out = Object(), L = Object(), R = Object(), P = Object();
	L->SetNumberField(TEXT("x"), Location.X);
	L->SetNumberField(TEXT("y"), Location.Y);
	L->SetNumberField(TEXT("z"), Location.Z);
	R->SetNumberField(TEXT("pitch"), Rotation.Pitch);
	R->SetNumberField(TEXT("yaw"), Rotation.Yaw);
	R->SetNumberField(TEXT("roll"), Rotation.Roll);
	P->SetStringField(TEXT("kind"), bOrthographic ? TEXT("orthographic") : TEXT("perspective"));
	P->SetNumberField(bOrthographic ? TEXT("width") : TEXT("horizontalFieldOfView"), ProjectionValue);
	Out->SetObjectField(TEXT("location"), L);
	Out->SetObjectField(TEXT("rotation"), R);
	Out->SetObjectField(TEXT("projection"), P);
	return Out;
}
TSharedPtr<FJsonObject> UEShedLegacyRenderRequest(const FString &Id, UWorld *World, bool bViewport,
												  const FString &Profile)
{
	auto Out = UEShedCameraJson(
		TEXT("{\"leaseMs\":120000,\"maximumFrames\":1000000,\"policy\":{\"renderer\":{\"kind\":\"scene_"
			 "capture\",\"profile\":\"scene_capture_defaults\",\"lodDistanceScale\":1,\"fog\":true,"
			 "\"volumetricFog\":true},\"exposure\":{\"mode\":\"project_auto\"},\"settling\":{"
			 "\"minimumFrames\":1,\"timeoutMs\":120000},\"time\":\"live_editor\",\"preparation\":{"
			 "\"geometry\":{\"mode\":\"preserve_loading\"},\"dataLayers\":[]}}}"));
	Out->SetObjectField(TEXT("contract"), UEShedCameraContract());
	Out->SetStringField(TEXT("sessionId"), Id);
	Out->SetStringField(TEXT("expectedMapPath"), World->GetOutermost()->GetName());
	Out->SetStringField(TEXT("expectedProjectName"), FApp::GetProjectName());
	if (bViewport)
		Out->GetObjectField(TEXT("policy"))
			->SetObjectField(
				TEXT("renderer"),
				UEShedCameraJson(TEXT("{\"kind\":\"editor_viewport\",\"strategy\":\"high_resolution_screenshot\","
						 "\"profile\":"
						 "\"lit\",\"vignette\":\"disabled\",\"fog\":true,\"volumetricFog\":true}")));
	else
		Out->GetObjectField(TEXT("policy"))
			->GetObjectField(TEXT("renderer"))
			->SetStringField(TEXT("profile"), Profile);
	return Out;
}
TSharedPtr<FJsonObject> UEShedRenderFrame(const FString &Session, const FString &Operation,
										  const TSharedPtr<FJsonObject> &Camera, int32 Width, int32 Height)
{
	auto Out = Object(), Size = Object();
	Size->SetNumberField(TEXT("width"), Width);
	Size->SetNumberField(TEXT("height"), Height);
	Out->SetObjectField(TEXT("contract"), UEShedCameraContract());
	Out->SetStringField(TEXT("sessionId"), Session);
	Out->SetStringField(TEXT("operationId"), Operation);
	Out->SetObjectField(TEXT("camera"), Camera);
	Out->SetObjectField(TEXT("size"), Size);
	return Out;
}

struct FUEShedCameraRenderSession::FState
{
	FString Id, Operation, RawPath;
	TSharedPtr<FJsonObject> Request, Frame, Result;
	TWeakObjectPtr<UWorld> World;
	TWeakObjectPtr<ACameraActor> CameraActor;
	TUniquePtr<FUEShedTransientCapture> Capture;
	FLevelEditorViewportClient *Client = nullptr;
	ELevelViewportType ViewportType;
	FViewportCameraTransform PerspectiveTransform, OrthographicTransform;
	FEngineShowFlags LastShowFlags{ESFIM_Editor}, ShowFlags{ESFIM_Editor};
	float SavedViewFOV = 0, SavedAspectRatio = 0, OrthoZoom = 0;
	FVector ViewLocation;
	FRotator ViewRotation;
	EViewModeIndex PerspectiveMode, OrthoMode;
	FExposureSettings Exposure;
	FHighResScreenshotConfig ScreenshotConfig, AppliedScreenshotConfig;
	uint32 ResolutionX = 0, ResolutionY = 0;
	uint32 AppliedResolutionX = 0, AppliedResolutionY = 0;
	bool ScreenshotApplied = false;
	bool GameView = false, LockedCamera = false, DisableInput = false, EnableFading = false, DrawAxes = false,
		 DrawAxesGame = false;
	bool Closed = false, Restored = true, Pending = false, Frozen = false, Metering = false,
		 InitialWarmup = false, FrameConfigured = false, DirtyBefore = false;
	double LastPoll = FPlatformTime::Seconds(), Started = LastPoll;
	int32 Frames = 0, CompletedFrames = 0;
	TOptional<double> EV;
	struct FLayer
	{
		TWeakObjectPtr<UDataLayerInstance> Layer;
		bool Loaded, Visible, AppliedLoaded, AppliedVisible;
	};
	TArray<FLayer> Layers;
	TArray<TUniquePtr<FLoaderAdapterShape>> Regions;
	TArray<FString> RegionInputs;
	struct FRetained
	{
		FString Input;
		TSharedPtr<FJsonObject> Result;
		double At;
	};
	TMap<FString, FRetained> Retained;
	TSet<FString> UsedOperations;
	void Prune(double Now)
	{
		for (auto It = Retained.CreateIterator(); It; ++It)
			if (Now - It.Value().At > RetentionSeconds)
			{
				IFileManager::Get().Delete(*FPaths::Combine(FPaths::ProjectSavedDir(),
															TEXT("UEShed/CameraRenderStaging"), Id,
															It.Key() + TEXT(".png")));
				if (It.Key() == Operation)
					Result = Failure(Id, TEXT("operation_expired"),
									 TEXT("The completed frame and its staged artifact expired."),
									 Closed ? (Restored ? TEXT("restored") : TEXT("failed"))
											: TEXT("not_acquired"),
									 Operation);
				It.RemoveCurrent();
			}
	}

	bool ClientAlive() const
	{
		return GEditor && Client && GEditor->GetLevelViewportClients().Contains(Client) && Client->Viewport;
	}
	bool Viewport() const
	{
		return String(Child(Child(Request, TEXT("policy")), TEXT("renderer")), TEXT("kind")) ==
			   TEXT("editor_viewport");
	}
	TSharedPtr<FJsonObject> Policy() const
	{
		return Child(Request, TEXT("policy"));
	}
	bool OwnsScreenshot() const
	{
		if (!ScreenshotApplied)
			return false;
		const auto &C = GetHighResScreenshotConfig(), &A = AppliedScreenshotConfig;
		return C.FilenameOverride == A.FilenameOverride &&
			   C.UnscaledCaptureRegion == A.UnscaledCaptureRegion &&
			   C.CaptureRegion == A.CaptureRegion && C.ResolutionMultiplier == A.ResolutionMultiplier &&
			   C.ResolutionMultiplierScale == A.ResolutionMultiplierScale &&
			   C.bMaskEnabled == A.bMaskEnabled && C.bCaptureHDR == A.bCaptureHDR &&
			   C.bForce128BitRendering == A.bForce128BitRendering &&
			   C.bDateTimeBasedNaming == A.bDateTimeBasedNaming &&
			   C.bDumpBufferVisualizationTargets == A.bDumpBufferVisualizationTargets &&
			   C.TargetViewport == A.TargetViewport &&
			   C.bDisplayCaptureRegion == A.bDisplayCaptureRegion &&
			   GScreenshotResolutionX == AppliedResolutionX &&
			   GScreenshotResolutionY == AppliedResolutionY &&
			   (!FScreenshotRequest::IsScreenshotRequested() ||
				FScreenshotRequest::GetFilename() == C.FilenameOverride);
	}
	void RestoreScreenshot()
	{
		if (!ScreenshotApplied)
			return;
		if (OwnsScreenshot())
		{
			if (Pending)
			{
				FScreenshotRequest::Reset();
				GIsHighResScreenshot = false;
			}
			// Restore only fields this session changed; other config has independent owners.
			auto &C = GetHighResScreenshotConfig();
			C.UnscaledCaptureRegion = ScreenshotConfig.UnscaledCaptureRegion;
			C.CaptureRegion = ScreenshotConfig.CaptureRegion;
			C.FilenameOverride = ScreenshotConfig.FilenameOverride;
			C.bMaskEnabled = ScreenshotConfig.bMaskEnabled;
			C.bCaptureHDR = ScreenshotConfig.bCaptureHDR;
			C.bDumpBufferVisualizationTargets = ScreenshotConfig.bDumpBufferVisualizationTargets;
			C.bDateTimeBasedNaming = ScreenshotConfig.bDateTimeBasedNaming;
			GScreenshotResolutionX = ResolutionX;
			GScreenshotResolutionY = ResolutionY;
		}
		else
			Restored = false;
		ScreenshotApplied = false;
	}
	bool Restore()
	{
		if (Closed)
			return Restored;
		Closed = true;
		RestoreScreenshot();
		// Snapshot/restore extracted from the Lit map renderer. No second viewport manager.
		if (Client)
		{
			if (ClientAlive() && Client->GetActorLock().GetLockedActor() == CameraActor.Get())
			{
				Client->SetActorLock(nullptr);
				Client->bLockedCameraView = LockedCamera;
				Client->UpdateViewForLockedActor();
				Client->SetViewportType(ViewportType);
				Client->SetViewLocation(ViewLocation);
				Client->SetViewRotation(ViewRotation);
				Client->SetOrthoZoom(OrthoZoom);
				Client->ViewTransformPerspective = PerspectiveTransform;
				Client->ViewTransformOrthographic = OrthographicTransform;
				Client->ViewFOV = SavedViewFOV;
				Client->AspectRatio = SavedAspectRatio;
				Client->SetGameView(GameView);
				Client->SetViewModes(PerspectiveMode, OrthoMode);
				Client->DisableOverrideEngineShowFlags();
				Client->EngineShowFlags = ShowFlags;
				Client->LastEngineShowFlags = LastShowFlags;
				Client->ExposureSettings = Exposure;
				Client->bDisableInput = DisableInput;
				Client->bEnableFading = EnableFading;
				Client->bDrawAxes = DrawAxes;
				Client->bDrawAxesGame = DrawAxesGame;
				Client->RemoveRealtimeOverride(RealtimeOwner, false);
			}
			else
				Restored = false;
		}
		EndUEShedOwnedMapFreeze(Id);
		Capture.Reset();
		if (CameraActor.IsValid())
			CameraActor->Destroy();
		Regions.Reset();
		auto *Subsystem = GEditor ? GEditor->GetEditorSubsystem<UDataLayerEditorSubsystem>() : nullptr;
		for (int32 I = Layers.Num() - 1; I >= 0; --I)
		{
			auto &Saved = Layers[I];
			if (!Saved.Layer.IsValid())
				continue;
			if (!Subsystem)
			{
				Restored = false;
				continue;
			}
			if (Saved.Layer->IsLoadedInEditor() == Saved.AppliedLoaded &&
				Saved.Layer->IsVisible() == Saved.AppliedVisible)
			{
				Subsystem->SetDataLayerIsLoadedInEditor(Saved.Layer.Get(), Saved.Loaded, false);
				Subsystem->SetDataLayerVisibility(Saved.Layer.Get(), Saved.Visible);
				if (Saved.Layer->IsLoadedInEditor() != Saved.Loaded ||
					Saved.Layer->IsVisible() != Saved.Visible)
					Restored = false;
			}
			else
				Restored = false;
		}
		if (World.IsValid() && World->GetOutermost()->IsDirty() != DirtyBefore)
			Restored = false;
		return Restored;
	}
	void Fail(const FString &Code, const FString &Message)
	{
		const bool Clean = Restore();
		Result = Failure(Id, Code, Message, Clean ? TEXT("restored") : TEXT("failed"), Operation);
		if (Frame)
			Retained.Add(Operation, {UEShedCameraJsonText(Frame), Result, FPlatformTime::Seconds()});
	}
	void ApplyExposure(FPostProcessSettings &PP)
	{
		const auto E = Child(Policy(), TEXT("exposure"));
		if (String(E, TEXT("mode")) != TEXT("fixed_ev100"))
			return;
		EV = E->GetNumberField(TEXT("ev100"));
		PP.bOverride_AutoExposureMinBrightness = true;
		PP.bOverride_AutoExposureMaxBrightness = true;
		const auto *Extended = IConsoleManager::Get().FindConsoleVariable(
			TEXT("r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange"));
		const auto *Lens =
			IConsoleManager::Get().FindConsoleVariable(TEXT("r.EyeAdaptation.LensAttenuation"));
		const float LuminanceMax = .78f / FMath::Max(.01f, Lens ? Lens->GetFloat() : .78f);
		PP.AutoExposureMinBrightness = PP.AutoExposureMaxBrightness =
			Extended && Extended->GetInt() ? EV.GetValue() : LuminanceMax * FMath::Pow(2.0, EV.GetValue());
	}
	bool Configure(const TSharedPtr<FJsonObject> &C, const TSharedPtr<FJsonObject> &Size)
	{
		const auto R = Child(C, TEXT("rotation")), P = Child(C, TEXT("projection")),
				   Render = Child(Policy(), TEXT("renderer"));
		const FVector L = ReadVector(Child(C, TEXT("location")));
		const FRotator Rotation(R->GetNumberField(TEXT("pitch")), R->GetNumberField(TEXT("yaw")),
								R->GetNumberField(TEXT("roll")));
		const bool Ortho = String(P, TEXT("kind")) == TEXT("orthographic");
		const double ProjectionValue =
			P->GetNumberField(Ortho ? TEXT("width") : TEXT("horizontalFieldOfView"));
		if (Viewport())
		{
			CameraActor->SetActorLocationAndRotation(L, Rotation);
			auto *Component = CameraActor->GetCameraComponent();
			Component->SetProjectionMode(Ortho ? ECameraProjectionMode::Orthographic
											   : ECameraProjectionMode::Perspective);
			if (Ortho)
				Component->SetOrthoWidth(ProjectionValue);
			else
				Component->SetFieldOfView(ProjectionValue);
			Component->SetAspectRatio(Size->GetNumberField(TEXT("width")) /
									  Size->GetNumberField(TEXT("height")));
			Client->SetActorLock(CameraActor.Get());
			Client->UpdateViewForLockedActor();
		}
		else
		{
			Capture.Reset();
			Capture = FUEShedTransientCapture::Create(
				World.Get(), L, Rotation, Size->GetIntegerField(TEXT("width")),
				Size->GetIntegerField(TEXT("height")), TEXT("UEShedCameraRender"));
			if (!Capture)
				return false;
			if (Ortho)
				Capture->ConfigureOrthographic(ProjectionValue);
			else
				Capture->ConfigurePerspective(ProjectionValue);
			const FString Profile = String(Render, TEXT("profile"));
			if (Profile == TEXT("full_fidelity"))
				Capture->ConfigureFullFidelityRenderer();
			else if (Profile == TEXT("seam_stable"))
				Capture->ConfigureSeamStableRenderer();
			else if (Profile == TEXT("observation"))
			{
				Capture->Component()->ShowFlags.DisableAdvancedFeatures();
				Capture->Component()->ShowFlags.SetPostProcessing(false);
			}
			Capture->ConfigureRenderPolicy(Render->GetBoolField(TEXT("fog")),
										   Render->GetBoolField(TEXT("volumetricFog")),
										   Render->GetNumberField(TEXT("lodDistanceScale")));
			if (Profile != TEXT("scene_capture_defaults"))
				Capture->BeginPersistentCameraCut();
			ApplyExposure(Capture->Component()->PostProcessSettings);
			if (EV.IsSet())
				Capture->Component()->PostProcessBlendWeight = 1;
		}
		Frames = 0;
		Pending = false;
		return true;
	}
};

FUEShedCameraRenderSession::FUEShedCameraRenderSession() : State(MakeUnique<FState>())
{
}
FUEShedCameraRenderSession::~FUEShedCameraRenderSession()
{
	State->Restore();
	for (const auto &Item : State->Retained)
		IFileManager::Get().Delete(*FPaths::Combine(FPaths::ProjectSavedDir(),
													TEXT("UEShed/CameraRenderStaging"), State->Id,
													Item.Key + TEXT(".png")));
}
bool FUEShedCameraRenderSession::IsBusy()
{
	return Owner && !Owner->IsClosed();
}
TSharedPtr<FUEShedCameraRenderSession> FUEShedCameraRenderSession::Find(const FString &SessionId)
{
	return Owner && Owner->Id() == SessionId && !Owner->IsClosed() ? Owner : nullptr;
}
bool FUEShedCameraRenderSession::IsClosed() const
{
	return State->Closed;
}
const FString &FUEShedCameraRenderSession::Id() const
{
	return State->Id;
}
void FUEShedCameraRenderSession::Touch()
{
	State->LastPoll = FPlatformTime::Seconds();
}
USceneCaptureComponent2D *FUEShedCameraRenderSession::SceneComponent() const
{
	return State->Capture ? State->Capture->Component() : nullptr;
}
UWorld *FUEShedCameraRenderSession::World() const
{
	return State->World.Get();
}
TSharedPtr<FJsonObject> FUEShedCameraRenderSession::CurrentFrame() const
{
	return State->Frame;
}

TSharedPtr<FJsonObject> FUEShedCameraRenderSession::Preflight(const TSharedPtr<FJsonObject> &Request)
{
	TArray<TSharedPtr<FJsonValue>> Issues;
	if (!Fields(Request,
				{TEXT("contract"), TEXT("sessionId"), TEXT("expectedMapPath"), TEXT("expectedProjectName"),
				 TEXT("policy"), TEXT("leaseMs"), TEXT("maximumFrames")}) ||
		!Contract(Child(Request, TEXT("contract"))) || !Identifier(String(Request, TEXT("sessionId"))) ||
		!MapPath(String(Request, TEXT("expectedMapPath"))) ||
		(String(Request, TEXT("expectedProjectName")).IsEmpty() ||
		 String(Request, TEXT("expectedProjectName")).Len() > 1024) ||
		!Number(Request, TEXT("leaseMs"), 1000, 120000, true) ||
		!Number(Request, TEXT("maximumFrames"), 1, 1000000, true) ||
		!ValidPolicy(Child(Request, TEXT("policy"))))
		Issue(Issues, TEXT("invalid_policy"), TEXT("request"),
			  TEXT("The request does not match camera render contract 1.0."));
	else
	{
		const auto Policy = Child(Request, TEXT("policy"));
		UWorld *World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (!GEditor || GEditor->PlayWorld || !World)
			Issue(Issues, TEXT("editor_required"), TEXT("world"),
				  TEXT("Use an editor world with Play and Simulate stopped."));
		if (!FApp::CanEverRender() || !FSlateApplication::IsInitialized())
			Issue(Issues, TEXT("rendering_unavailable"), TEXT("renderer"),
				  TEXT("A rendering editor is required."));
		if (World && World->GetOutermost()->GetName() != String(Request, TEXT("expectedMapPath")))
			Issue(Issues, TEXT("map_mismatch"), TEXT("expectedMapPath"),
				  TEXT("Open the expected map separately."));
		if (String(Request, TEXT("expectedProjectName")) != FApp::GetProjectName())
			Issue(Issues, TEXT("project_mismatch"), TEXT("expectedProjectName"),
				  TEXT("The connected editor belongs to a different project."));
		if (IsBusy())
			Issue(Issues, TEXT("editor_busy"), TEXT("sessionId"),
				  TEXT("Another render session owns the editor world."));
		const bool Viewport =
			String(Child(Policy, TEXT("renderer")), TEXT("kind")) == TEXT("editor_viewport");
		auto *Client = GCurrentLevelEditingViewportClient;
		if (Viewport && (!Client || !Client->Viewport))
			Issue(Issues, TEXT("viewport_unavailable"), TEXT("renderer"),
				  TEXT("Open a Level Editor viewport."));
		else if (Viewport && (Client->IsAnyActorLocked() || Client->IsEngineShowFlagsOverrideEnabled()))
			Issue(Issues, TEXT("viewport_locked"), TEXT("renderer"),
				  TEXT("Unlock the viewport and finish existing show-flag overrides."));
		if (Viewport && (GIsHighResScreenshot || FScreenshotRequest::IsScreenshotRequested()))
			Issue(Issues, TEXT("editor_busy"), TEXT("renderer.strategy"),
				  TEXT("An unrelated screenshot is active."));
		if (!Viewport && String(Child(Policy, TEXT("exposure")), TEXT("mode")) == TEXT("meter_once"))
			Issue(Issues, TEXT("unsupported_policy"), TEXT("exposure.mode"),
				  TEXT("Meter-once exposure is implemented only for the editor viewport."));
		if (String(Child(Policy, TEXT("renderer")), TEXT("profile")) == TEXT("observation") &&
			String(Child(Policy, TEXT("exposure")), TEXT("mode")) != TEXT("project_auto"))
			Issue(Issues, TEXT("unsupported_policy"), TEXT("exposure.mode"),
				  TEXT("Observation disables post processing and does not support exposure overrides."));
		const auto Prep = Child(Policy, TEXT("preparation"));
		const auto *Manager = World ? UDataLayerManager::GetDataLayerManager(World) : nullptr;
		TSet<UDataLayerInstance *> SeenLayers;
		for (const auto &V : Prep->GetArrayField(TEXT("dataLayers")))
		{
			auto *Layer = FindLayer(Manager, String(V->AsObject(), TEXT("assetPath")));
			if (!Layer)
				Issue(Issues, TEXT("preparation_failed"), TEXT("preparation.dataLayers"),
					  TEXT("A required Data Layer asset is absent from this editor world."));
			else if (SeenLayers.Contains(Layer))
				Issue(Issues, TEXT("invalid_policy"), TEXT("preparation.dataLayers"),
					  TEXT("Each Data Layer may be requested only once, including asset path aliases."));
			else
				SeenLayers.Add(Layer);
		}
	}
	auto Out = Object();
	Out->SetStringField(TEXT("status"), Issues.IsEmpty() ? TEXT("ready") : TEXT("blocked"));
	Out->SetArrayField(TEXT("issues"), Issues);
	return Out;
}

TSharedPtr<FUEShedCameraRenderSession> FUEShedCameraRenderSession::Open(
	const TSharedPtr<FJsonObject> &Request, TSharedPtr<FJsonObject> &Error)
{
	const auto Check = Preflight(Request);
	if (String(Check, TEXT("status")) != TEXT("ready"))
	{
		const auto First = Check->GetArrayField(TEXT("issues"))[0]->AsObject();
		Error = Failure(String(Request, TEXT("sessionId")), String(First, TEXT("code")),
						String(First, TEXT("message")));
		Error->SetArrayField(TEXT("issues"), Check->GetArrayField(TEXT("issues")));
		return nullptr;
	}
	auto Session = TSharedPtr<FUEShedCameraRenderSession>(new FUEShedCameraRenderSession());
	auto &S = *Session->State;
	S.Request = Request;
	S.Id = String(Request, TEXT("sessionId"));
	S.World = GEditor->GetEditorWorldContext().World();
	S.DirtyBefore = S.World->GetOutermost()->IsDirty();
	if (Owner)
	{
		ClosedSessions.Add({Owner, FPlatformTime::Seconds()});
		if (ClosedSessions.Num() > 8)
			ClosedSessions.RemoveAt(0);
	}
	Owner = Session;
	const auto Prep = Child(S.Policy(), TEXT("preparation"));
	auto *Subsystem = GEditor->GetEditorSubsystem<UDataLayerEditorSubsystem>();
	const auto *Manager = UDataLayerManager::GetDataLayerManager(S.World.Get());
	for (const auto &V : Prep->GetArrayField(TEXT("dataLayers")))
	{
		const auto L = V->AsObject();
		auto *Layer = FindLayer(Manager, String(L, TEXT("assetPath")));
		S.Layers.Add({Layer, Layer->IsLoadedInEditor(), Layer->IsVisible(), L->GetBoolField(TEXT("loaded")),
					  L->GetBoolField(TEXT("visible"))});
		Subsystem->SetDataLayerIsLoadedInEditor(Layer, L->GetBoolField(TEXT("loaded")), false);
		Subsystem->SetDataLayerVisibility(Layer, L->GetBoolField(TEXT("visible")));
	}
	for (const auto &L : S.Layers)
	{
		if (L.Layer->IsEffectiveLoadedInEditor() != L.AppliedLoaded ||
			L.Layer->IsEffectiveVisible() != L.AppliedVisible)
		{
			S.Fail(TEXT("preparation_failed"), TEXT("Data Layer hierarchy prevents the required effective "
													"state. Specify the required parent layers explicitly."));
			Error = S.Result;
			return nullptr;
		}
	}
	if (S.Viewport())
	{
		auto *C = GCurrentLevelEditingViewportClient;
		S.Client = C;
		S.PerspectiveTransform = C->ViewTransformPerspective;
		S.OrthographicTransform = C->ViewTransformOrthographic;
		S.LastShowFlags = C->LastEngineShowFlags;
		S.SavedViewFOV = C->ViewFOV;
		S.SavedAspectRatio = C->AspectRatio;
		S.ViewportType = C->GetViewportType();
		S.ViewLocation = C->GetViewLocation();
		S.ViewRotation = C->GetViewRotation();
		S.OrthoZoom = C->GetOrthoZoom();
		S.PerspectiveMode = C->GetPerspViewMode();
		S.OrthoMode = C->GetOrthoViewMode();
		S.ShowFlags = C->EngineShowFlags;
		S.Exposure = C->ExposureSettings;
		S.GameView = C->IsInGameView();
		S.LockedCamera = C->bLockedCameraView;
		S.DisableInput = C->bDisableInput;
		S.EnableFading = C->bEnableFading;
		S.DrawAxes = C->bDrawAxes;
		S.DrawAxesGame = C->bDrawAxesGame;
		S.ScreenshotConfig = GetHighResScreenshotConfig();
		S.ResolutionX = GScreenshotResolutionX;
		S.ResolutionY = GScreenshotResolutionY;
		FActorSpawnParameters Spawn;
		Spawn.ObjectFlags = RF_Transient;
		Spawn.bHideFromSceneOutliner = true;
		Spawn.bTemporaryEditorActor = true;
		Spawn.bCreateActorPackage = false;
		S.CameraActor = S.World->SpawnActor<ACameraActor>(FVector::ZeroVector, FRotator::ZeroRotator, Spawn);
		if (!S.CameraActor.IsValid())
		{
			S.Fail(TEXT("capture_failed"), TEXT("Could not create the transient camera."));
			Error = S.Result;
			return nullptr;
		}
		auto *Component = S.CameraActor->GetCameraComponent();
		Component->SetConstraintAspectRatio(false);
		Component->PostProcessBlendWeight = 1;
		const auto R = Child(S.Policy(), TEXT("renderer"));
		if (String(R, TEXT("vignette")) == TEXT("disabled"))
		{
			Component->PostProcessSettings.bOverride_VignetteIntensity = true;
			Component->PostProcessSettings.VignetteIntensity = 0;
		}
		S.ApplyExposure(Component->PostProcessSettings);
		C->SetViewportType(LVT_Perspective);
		C->SetGameView(true);
		C->SetViewModes(VMI_Lit, VMI_Lit);
		C->ExposureSettings.bFixed = false;
		C->bLockedCameraView = true;
		C->bDisableInput = true;
		C->bEnableFading = false;
		C->bDrawAxes = false;
		C->bDrawAxesGame = false;
		const bool Fog = R->GetBoolField(TEXT("fog")), VolumetricFog = R->GetBoolField(TEXT("volumetricFog"));
		const bool Observation = String(R, TEXT("profile")) == TEXT("observation");
		C->EnableOverrideEngineShowFlags([Fog, VolumetricFog, Observation](FEngineShowFlags &Flags) {
			Flags.SetFog(Fog);
			Flags.SetVolumetricFog(VolumetricFog);
			Flags.SetSelection(false);
			Flags.SetSelectionOutline(false);
			Flags.SetModeWidgets(false);
			if (Observation)
			{
				Flags.DisableAdvancedFeatures();
				Flags.SetPostProcessing(false);
				Flags.SetMotionBlur(false);
				Flags.SetBloom(false);
				Flags.SetAntiAliasing(false);
			}
		});
		C->AddRealtimeOverride(true, RealtimeOwner);
		C->SetActorLock(S.CameraActor.Get());
		C->UpdateViewForLockedActor();
	}
	S.Metering = String(Child(S.Policy(), TEXT("exposure")), TEXT("mode")) == TEXT("meter_once");
	S.InitialWarmup = Child(S.Policy(), TEXT("settling"))->HasField(TEXT("initialView"));
	if (!TickHandle.IsValid())
	{
		TickHandle = FSlateApplication::Get().OnPostTick().AddLambda([](float) {
			if (Owner)
				Owner->Tick();
			for (auto &Closed : ClosedSessions)
				Closed.Session->Tick();
			const double Now = FPlatformTime::Seconds();
			ClosedSessions.RemoveAll(
				[Now](const FClosedSession &Closed) { return Now - Closed.At > RetentionSeconds; });
		});
		WorldHandle = FWorldDelegates::OnWorldCleanup.AddLambda([](UWorld *World, bool, bool) {
			if (Owner && Owner->State->World.Get() == World && !Owner->IsClosed())
				Owner->State->Fail(TEXT("world_changed"), TEXT("The render world was unloaded."));
		});
		PIEHandle = FEditorDelegates::PreBeginPIE.AddLambda([](bool) {
			if (Owner && !Owner->IsClosed())
				Owner->State->Fail(TEXT("editor_required"),
								   TEXT("Play or Simulate started during rendering."));
		});
	}
	return Session;
}

TSharedPtr<FJsonObject> FUEShedCameraRenderSession::Start(const TSharedPtr<FJsonObject> &Frame)
{
	const double PreparationStarted = FPlatformTime::Seconds();
	auto &S = *State;
	const FString Op = String(Frame, TEXT("operationId"));
	if (!Fields(Frame,
				{TEXT("contract"), TEXT("sessionId"), TEXT("operationId"), TEXT("camera"), TEXT("size")},
				{TEXT("region")}) ||
		!Contract(Child(Frame, TEXT("contract"))) || String(Frame, TEXT("sessionId")) != S.Id ||
		!Identifier(Op) || !Camera(Child(Frame, TEXT("camera"))) || !Size(Child(Frame, TEXT("size"))))
		return Failure(S.Id, TEXT("invalid_frame"),
					   TEXT("The frame request does not match camera render contract 1.0."));
	if (Child(Frame, TEXT("size"))->GetIntegerField(TEXT("width")) > GMaxTextureDimensions ||
		Child(Frame, TEXT("size"))->GetIntegerField(TEXT("height")) > GMaxTextureDimensions)
		return Failure(S.Id, TEXT("unsupported_size"),
					   TEXT("The frame exceeds the connected RHI texture limit."));
	const FString Input = UEShedCameraJsonText(Frame);
	if (const auto *Previous = S.Retained.Find(Op))
		return Previous->Input == Input
				   ? Previous->Result
				   : Failure(S.Id, TEXT("operation_conflict"),
							 TEXT("This operation ID already describes different input."));
	if (S.Frame && S.Operation == Op)
		return UEShedCameraJsonText(S.Frame) == Input
				   ? Poll(Op)
				   : Failure(S.Id, TEXT("operation_conflict"),
							 TEXT("The in-flight operation has different input."));
	if (S.Closed)
		return Failure(S.Id, TEXT("session_closed"), TEXT("The render session has ended."),
					   S.Restored ? TEXT("restored") : TEXT("failed"), Op);
	if (S.Frame && !S.Result)
		return Failure(S.Id, TEXT("editor_busy"),
					   TEXT("Wait for the current frame before starting another."));
	if (S.UsedOperations.Contains(Op))
		return Failure(
			S.Id, TEXT("operation_expired"),
			TEXT("This operation was completed but its result retention expired. Use a new "
							"operation ID."));
	if (S.CompletedFrames >= S.Request->GetIntegerField(TEXT("maximumFrames")))
		return Failure(S.Id, TEXT("frame_budget_exceeded"), TEXT("The session frame budget is exhausted."));
	auto Region = Child(Frame, TEXT("region"));
	const auto Geometry = Child(Child(S.Policy(), TEXT("preparation")), TEXT("geometry"));
	const bool Load = String(Geometry, TEXT("mode")) == TEXT("camera_regions");
	if (Load && !Region)
	{
		Region = Object();
		Region->SetObjectField(TEXT("center"), Child(Child(Frame, TEXT("camera")), TEXT("location")));
		Region->SetObjectField(TEXT("extent"), Child(Geometry, TEXT("extent")));
	}
	if ((!Load && Frame->HasField(TEXT("region"))) ||
		(Region && (!Fields(Region, {TEXT("center"), TEXT("extent")}) ||
					!Vector(Child(Region, TEXT("center"))) || !Vector(Child(Region, TEXT("extent")), true))))
		return Failure(S.Id, TEXT("invalid_region"),
					   TEXT("Camera-region preparation requires explicit finite bounds; preserve-loading "
							"frames omit them."));
	if (Region && !S.RegionInputs.Contains(UEShedCameraJsonText(Region)))
	{
		if (S.RegionInputs.Num() >= Geometry->GetIntegerField(TEXT("maximumRegions")))
			return Failure(S.Id, TEXT("preparation_budget_exceeded"),
						   TEXT("The session region budget is exhausted."));
		S.RegionInputs.Add(UEShedCameraJsonText(Region));
		if (S.World->GetWorldPartition())
		{
			const FVector Center = ReadVector(Child(Region, TEXT("center"))),
						  Extent = ReadVector(Child(Region, TEXT("extent")));
			auto Loader = MakeUnique<FLoaderAdapterShape>(
				S.World.Get(), FBox(Center - Extent, Center + Extent), TEXT("UE Shed Camera Region"));
			Loader->Load();
			S.Regions.Add(MoveTemp(Loader));
		}
	}
	S.UsedOperations.Add(Op);
	S.Frame = Frame;
	S.Operation = Op;
	S.Result.Reset();
	S.Frames = 0;
	S.Pending = false;
	S.FrameConfigured = false;
	S.Started = PreparationStarted;
	Touch();
	S.RawPath = FPaths::ConvertRelativePathToFull(FPaths::Combine(
		FPaths::ProjectSavedDir(), TEXT("UEShed/CameraRenderStaging"), S.Id, Op + TEXT(".png")));
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(S.RawPath), true);
	return Poll(Op);
}

void FUEShedCameraRenderSession::Tick(bool bDrawViewport)
{
	auto &S = *State;
	const double Now = FPlatformTime::Seconds();
	S.Prune(Now);
	if (S.Closed)
		return;
	if (!S.World.IsValid() || !GEditor || GEditor->PlayWorld ||
		GEditor->GetEditorWorldContext().World() != S.World.Get() ||
		(S.Viewport() &&
		 (!S.ClientAlive() || S.Client->GetActorLock().GetLockedActor() != S.CameraActor.Get())))
	{
		S.Fail(TEXT("world_changed"), TEXT("The editor world or owned viewport changed."));
		return;
	}
	if (Now - S.LastPoll > S.Request->GetNumberField(TEXT("leaseMs")) / 1000)
	{
		S.Fail(TEXT("lease_expired"), TEXT("The render client stopped renewing its lease."));
		return;
	}
	if (S.Frozen && !RenewUEShedOwnedMapFreeze(S.Id))
	{
		S.Fail(TEXT("restoration_failed"), TEXT("The owned scene freeze was lost."));
		return;
	}
	if (!S.Frame || S.Result)
		return;
	if (S.Viewport() &&
		((S.Pending && !S.OwnsScreenshot()) ||
		 (!S.Pending && (GIsHighResScreenshot || FScreenshotRequest::IsScreenshotRequested()))))
	{
		S.Fail(TEXT("editor_busy"), TEXT("Another operation owns the screenshot state."));
		return;
	}
	const auto Settling = Child(S.Policy(), TEXT("settling"));
	if ((Now - S.Started) * 1000 > Settling->GetNumberField(TEXT("timeoutMs")))
	{
		S.Fail(TEXT("settling_timeout"), TEXT("The frame did not finish within its bounded deadline."));
		return;
	}
	for (auto *L : S.World->GetStreamingLevels())
		if (L && L->IsStreamingStatePending())
			return;
	if (!S.FrameConfigured)
	{
		const auto E = Child(S.Policy(), TEXT("exposure"));
		const auto Initial = Child(Settling, TEXT("initialView"));
		if (!S.Configure(S.InitialWarmup ? Child(Initial, TEXT("camera"))
						 : S.Metering	 ? Child(E, TEXT("referenceCamera"))
										 : Child(S.Frame, TEXT("camera")),
						 S.InitialWarmup ? Child(Initial, TEXT("size"))
						 : S.Metering	 ? Child(E, TEXT("referenceSize"))
										 : Child(S.Frame, TEXT("size"))))
		{
			S.Fail(TEXT("capture_failed"), TEXT("Could not realize the requested camera."));
			return;
		}
		S.FrameConfigured = true;
	}
	if (S.Viewport())
		S.Client->Viewport->Draw(false);
	if (!S.Viewport())
		S.Capture->Capture();
	++S.Frames;
	if (S.InitialWarmup)
	{
		if (S.Frames >= Child(Settling, TEXT("initialView"))->GetIntegerField(TEXT("minimumFrames")))
		{
			S.InitialWarmup = false;
			S.FrameConfigured = false;
		}
		return;
	}
	if (S.Metering)
	{
		if (S.Frames < Child(S.Policy(), TEXT("exposure"))->GetIntegerField(TEXT("minimumFrames")))
			return;
		auto *ViewState = S.Client->ViewState.GetReference();
		const float Adapted = ViewState ? ViewState->GetLastEyeAdaptationExposure() : 0;
		if (!FMath::IsFinite(Adapted) || Adapted <= 0)
		{
			S.Fail(TEXT("exposure_unavailable"),
				   TEXT("The viewport did not expose a valid adapted exposure."));
			return;
		}
		const auto *Lens =
			IConsoleManager::Get().FindConsoleVariable(TEXT("r.EyeAdaptation.LensAttenuation"));
		const float MaxLuminance = .78f / FMath::Max(.01f, Lens ? Lens->GetFloat() : .78f);
		S.EV = FMath::Log2(1.0f / (Adapted * MaxLuminance));
		S.Client->ExposureSettings.bFixed = true;
		S.Client->ExposureSettings.FixedEV100 = S.EV.GetValue();
		S.Metering = false;
		S.FrameConfigured = false;
		return;
	}
	if (!S.Frozen && String(S.Policy(), TEXT("time")) == TEXT("freeze_materials_and_ticks"))
	{
		if (!BeginUEShedOwnedMapFreeze(S.World.Get(), S.Id))
		{
			S.Fail(TEXT("editor_busy"), TEXT("Another operation owns the editor time freeze."));
			return;
		}
		S.Frozen = true;
		S.Frames = 0;
		return;
	}
	if (S.Frames < Settling->GetIntegerField(TEXT("minimumFrames")))
		return;
	const auto Size = Child(S.Frame, TEXT("size"));
	const int32 Width = Size->GetIntegerField(TEXT("width")), Height = Size->GetIntegerField(TEXT("height"));
	if (S.Viewport())
	{
		if (!S.Pending)
		{
			// Settling can yield to editor tools. Recheck immediately before mutating global state.
			if (GIsHighResScreenshot || FScreenshotRequest::IsScreenshotRequested())
			{
				S.Fail(TEXT("editor_busy"),
					   TEXT("Another operation requested a screenshot during settling."));
				return;
			}
			auto &Config = GetHighResScreenshotConfig();
			S.ScreenshotConfig = Config;
			S.ResolutionX = GScreenshotResolutionX;
			S.ResolutionY = GScreenshotResolutionY;
			if (!Config.SetResolution(Width, Height))
			{
				S.Fail(TEXT("unsupported_size"),
					   TEXT("The requested output exceeds the native screenshot limit."));
				return;
			}
			Config.SetFilename(S.RawPath);
			Config.SetMaskEnabled(false);
			Config.SetHDRCapture(false);
			Config.bDumpBufferVisualizationTargets = false;
			Config.bDateTimeBasedNaming = false;
			S.AppliedScreenshotConfig = Config;
			S.AppliedResolutionX = GScreenshotResolutionX;
			S.AppliedResolutionY = GScreenshotResolutionY;
			S.ScreenshotApplied = true;
			S.Pending = true;
			if (!S.Client->Viewport->TakeHighResScreenShot())
			{
				S.Fail(TEXT("capture_failed"), TEXT("The viewport rejected the screenshot."));
				return;
			}
			S.Pending = true;
			return;
		}
		if (GIsHighResScreenshot || FScreenshotRequest::IsScreenshotRequested() ||
			!FPaths::FileExists(S.RawPath))
			return;
	}
	else if (!S.Capture->ExportPng(S.RawPath))
	{
		S.Fail(TEXT("capture_failed"), TEXT("The SceneCapture PNG could not be staged."));
		return;
	}
	FImage Image;
	if (!FImageUtils::LoadImage(*S.RawPath, Image))
		return;
	if (Image.SizeX != Width || Image.SizeY != Height)
	{
		S.Fail(TEXT("artifact_invalid"), TEXT("The produced image has different dimensions than requested."));
		return;
	}
	auto Out = Object(), Artifact = Object(), Evidence = Object(), Preparation = Object(), Settled = Object();
	Out->SetStringField(TEXT("status"), TEXT("captured"));
	Out->SetStringField(TEXT("sessionId"), S.Id);
	Out->SetStringField(TEXT("operationId"), S.Operation);
	Artifact->SetStringField(TEXT("relativePath"), S.Id + TEXT("/") + S.Operation + TEXT(".png"));
	Artifact->SetNumberField(TEXT("bytes"), IFileManager::Get().FileSize(*S.RawPath));
	Artifact->SetNumberField(TEXT("width"), Width);
	Artifact->SetNumberField(TEXT("height"), Height);
	Out->SetObjectField(TEXT("artifact"), Artifact);
	auto EditorState = Object();
	EditorState->SetBoolField(TEXT("mapPackageDirtyBefore"), S.DirtyBefore);
	EditorState->SetBoolField(TEXT("mapPackageDirtyAfter"), S.World->GetOutermost()->IsDirty());
	Evidence->SetObjectField(TEXT("editorState"), EditorState);
	Evidence->SetObjectField(TEXT("camera"), Child(S.Frame, TEXT("camera")));
	Evidence->SetObjectField(TEXT("size"), Size);
	Evidence->SetObjectField(TEXT("policy"), S.Policy());
	if (S.EV.IsSet())
		Evidence->SetNumberField(TEXT("exposureEV100"), S.EV.GetValue());
	else
		Evidence->SetField(TEXT("exposureEV100"), MakeShared<FJsonValueNull>());
	Preparation->SetStringField(
		TEXT("status"), S.RegionInputs.IsEmpty() && S.Layers.IsEmpty() ? TEXT("preserved") : TEXT("partial"));
	Preparation->SetNumberField(TEXT("regionsHeld"), S.RegionInputs.Num());
	Preparation->SetNumberField(TEXT("dataLayersApplied"), S.Layers.Num());
	Preparation->SetArrayField(
		TEXT("limitations"),
		{MakeShared<FJsonValueString>(TEXT("Explicit editor loading does not certify frustum completeness, "
										   "shader convergence, or gameplay initialization."))});
	Evidence->SetObjectField(TEXT("preparation"), Preparation);
	Settled->SetNumberField(TEXT("renderedFrames"), S.Frames);
	Settled->SetNumberField(TEXT("elapsedMs"), (FPlatformTime::Seconds() - S.Started) * 1000);
	Settled->SetStringField(TEXT("convergence"), TEXT("not_assessed"));
	Evidence->SetObjectField(TEXT("settling"), Settled);
	Evidence->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
	Evidence->SetStringField(TEXT("pluginVersion"), PluginVersion());
	Out->SetObjectField(TEXT("evidence"), Evidence);
	S.Pending = false;
	S.RestoreScreenshot();
	S.Result = Out;
	++S.CompletedFrames;
	S.Prune(Now);
	if (S.Retained.Num() >= RetainedOperations)
	{
		FString Oldest;
		double At = TNumericLimits<double>::Max();
		for (const auto &Item : S.Retained)
			if (Item.Value.At < At)
			{
				At = Item.Value.At;
				Oldest = Item.Key;
			}
		IFileManager::Get().Delete(*FPaths::Combine(
			FPaths::ProjectSavedDir(), TEXT("UEShed/CameraRenderStaging"), S.Id, Oldest + TEXT(".png")));
		S.Retained.Remove(Oldest);
	}
	S.Retained.Add(S.Operation, {UEShedCameraJsonText(S.Frame), Out, Now});
}

TSharedPtr<FJsonObject> FUEShedCameraRenderSession::Poll(const FString &OperationId, bool bRenewLease)
{
	auto &S = *State;
	S.Prune(FPlatformTime::Seconds());
	if (bRenewLease)
		Touch();
	if (const auto *R = S.Retained.Find(OperationId))
		return R->Result;
	if (!S.Frame || S.Operation != OperationId)
		return Failure(S.Id, TEXT("operation_unknown"), TEXT("No retained frame has this operation ID."));
	if (S.Result)
		return S.Result;
	auto Out = Object();
	Out->SetStringField(TEXT("status"), TEXT("running"));
	Out->SetStringField(TEXT("sessionId"), S.Id);
	Out->SetStringField(TEXT("operationId"), S.Operation);
	Out->SetStringField(TEXT("phase"), !S.FrameConfigured ? TEXT("preparing")
									   : S.Metering		  ? TEXT("exposure_warmup")
									   : S.Pending		  ? TEXT("capturing")
														  : TEXT("frame_warmup"));
	Out->SetNumberField(TEXT("renderedFrames"), S.Frames);
	Out->SetNumberField(TEXT("elapsedMs"), (FPlatformTime::Seconds() - S.Started) * 1000);
	return Out;
}
TSharedPtr<FJsonObject> FUEShedCameraRenderSession::Close()
{
	auto &S = *State;
	if (!S.Closed && S.Frame && !S.Result)
		S.Fail(TEXT("cancelled"), TEXT("The session was closed during capture."));
	if (!S.Restore())
		return Failure(S.Id, TEXT("restoration_failed"),
					   TEXT("Some editor state changed ownership and could not be restored."),
					   TEXT("failed"));
	auto Out = Object();
	Out->SetStringField(TEXT("status"), TEXT("closed"));
	Out->SetStringField(TEXT("sessionId"), S.Id);
	Out->SetStringField(TEXT("restoration"), TEXT("restored"));
	return Out;
}
TSharedPtr<FJsonObject> FUEShedCameraRenderSession::RenderBlocking(const TSharedPtr<FJsonObject> &Frame)
{
	auto Result = Start(Frame);
	while (String(Result, TEXT("status")) == TEXT("running"))
	{
		Tick(true);
		Result = Poll(String(Frame, TEXT("operationId")));
	}
	return Result;
}
TSharedPtr<FJsonObject> FUEShedCameraRenderSession::RenderConfiguredFrameBlocking(const FString &OperationId)
{
	auto Frame = UEShedCameraJson(UEShedCameraJsonText(State->Frame));
	Frame->SetStringField(TEXT("operationId"), OperationId);
	auto Result = Start(Frame);
	State->FrameConfigured = true;
	while (String(Result, TEXT("status")) == TEXT("running"))
	{
		Tick(true);
		Result = Poll(OperationId);
	}
	return Result;
}
void FUEShedCameraRenderSession::Shutdown()
{
	if (Owner)
		Owner->Close();
	Owner.Reset();
	ClosedSessions.Reset();
	if (FSlateApplication::IsInitialized())
		FSlateApplication::Get().OnPostTick().Remove(TickHandle);
	FWorldDelegates::OnWorldCleanup.Remove(WorldHandle);
	FEditorDelegates::PreBeginPIE.Remove(PIEHandle);
	TickHandle.Reset();
	WorldHandle.Reset();
	PIEHandle.Reset();
}
TSharedPtr<FJsonObject> FUEShedCameraRenderSession::Capabilities()
{
	auto Out = UEShedCameraJson(
		TEXT("{\"renderers\":[{\"kind\":\"editor_viewport\",\"projections\":[\"perspective\","
			 "\"orthographic\"],\"strategies\":[\"high_resolution_screenshot\"],\"exposure\":[\"project_"
		"auto\",\"fixed_ev100\",\"meter_once\"],\"maximumDimension\":16384},{\"kind\":\"scene_"
		"capture\","
		"\"projections\":[\"perspective\",\"orthographic\"],\"strategies\":[\"render_target\"],"
		"\"exposure\":[\"project_auto\",\"fixed_ev100\"],\"maximumDimension\":16384}],\"preparation\":["
		"\"preserve_loading\",\"camera_regions\",\"editor_data_layers\"],\"freeze\":[\"freeze_"
		"materials_"
		"and_ticks\"],\"maximumRetainedOperations\":64,\"retentionMs\":120000}"));
	Out->SetNumberField(TEXT("maximumRetainedSessions"), 9);
	for (const auto &Value : Out->GetArrayField(TEXT("renderers")))
	{
		auto R = Value->AsObject();
		R->SetNumberField(TEXT("maximumDimension"), FMath::Min<uint32>(16384, GMaxTextureDimensions));
		const bool Viewport = R->GetStringField(TEXT("kind")) == TEXT("editor_viewport");
		TArray<TSharedPtr<FJsonValue>> Profiles, Assessment, Clear;
		if (Viewport)
		{
			Profiles.Add(MakeShared<FJsonValueString>(TEXT("lit")));
			Profiles.Add(MakeShared<FJsonValueString>(TEXT("observation")));
		}
		else
		{
			for (auto P : {TEXT("full_fidelity"), TEXT("seam_stable"), TEXT("scene_capture_defaults"),
						   TEXT("observation")})
				Profiles.Add(MakeShared<FJsonValueString>(P));
			for (auto A : {TEXT("depth_compare"), TEXT("ray_samples")})
				Assessment.Add(MakeShared<FJsonValueString>(A));
			for (auto C : {TEXT("isolate_target"), TEXT("hide_explicit")})
				Clear.Add(MakeShared<FJsonValueString>(C));
		}
		R->SetArrayField(TEXT("profiles"), Profiles);
		R->SetArrayField(TEXT("reviewAssessment"), Assessment);
		R->SetArrayField(TEXT("reviewClear"), Clear);
	}
	Out->SetObjectField(TEXT("contract"), UEShedCameraContract());
	Out->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
	Out->SetStringField(TEXT("pluginVersion"), PluginVersion());
	Out->SetStringField(TEXT("projectName"), FApp::GetProjectName());
	return Out;
}
void UUEShedCameraRenderingLibrary::GetCameraRenderCapabilities(FString &ResultJson)
{
	ResultJson = UEShedCameraJsonText(FUEShedCameraRenderSession::Capabilities());
}
void UUEShedCameraRenderingLibrary::PreflightCameraRender(const FString &RequestJson, FString &ResultJson)
{
	ResultJson = UEShedCameraJsonText(FUEShedCameraRenderSession::Preflight(UEShedCameraJson(RequestJson)));
}
void UUEShedCameraRenderingLibrary::BeginCameraRender(const FString &RequestJson, FString &ResultJson)
{
	const auto Request = UEShedCameraJson(RequestJson);
	TSharedPtr<FJsonObject> Error;
	if (Owner && Owner->Id() == String(Request, TEXT("sessionId")))
	{
		ResultJson = UEShedCameraJsonText(Owner->Reopen(Request));
		return;
	}
	for (const auto &Closed : ClosedSessions)
		if (Closed.Session->Id() == String(Request, TEXT("sessionId")))
		{
			ResultJson =
				UEShedCameraJsonText(Failure(Closed.Session->Id(), TEXT("session_conflict"),
											 TEXT("This session identity is retained after closure.")));
			return;
		}
	const auto Session = FUEShedCameraRenderSession::Open(Request, Error);
	if (!Session)
	{
		ResultJson = UEShedCameraJsonText(Error);
		return;
	}
	auto Out = Object();
	Out->SetStringField(TEXT("status"), TEXT("opened"));
	Out->SetStringField(TEXT("sessionId"), Session->Id());
	Out->SetObjectField(TEXT("resolvedPolicy"), Child(Request, TEXT("policy")));
	ResultJson = UEShedCameraJsonText(Out);
}
TSharedPtr<FUEShedCameraRenderSession> RetainedSession(const FString &Id)
{
	if (Owner && Owner->Id() == Id)
		return Owner;
	for (const auto &Item : ClosedSessions)
		if (Item.Session->Id() == Id)
			return Item.Session;
	return nullptr;
}
void UUEShedCameraRenderingLibrary::StartCameraFrame(const FString &RequestJson, FString &ResultJson)
{
	auto Frame = UEShedCameraJson(RequestJson);
	const FString Id = String(Frame, TEXT("sessionId"));
	auto Session = RetainedSession(Id);
	ResultJson = UEShedCameraJsonText(
		Session ? Session->Start(Frame)
				: Failure(Id, TEXT("session_unknown"), TEXT("This client does not own the renderer.")));
}
void UUEShedCameraRenderingLibrary::PollCameraFrame(const FString &SessionId, const FString &OperationId,
													FString &ResultJson)
{
	auto Session = RetainedSession(SessionId);
	ResultJson = UEShedCameraJsonText(Session ? Session->Poll(OperationId)
											  : Failure(SessionId, TEXT("session_unknown"),
														TEXT("This client does not own the renderer.")));
}
void UUEShedCameraRenderingLibrary::EndCameraRender(const FString &SessionId, FString &ResultJson)
{
	auto Session = RetainedSession(SessionId);
	ResultJson = UEShedCameraJsonText(Session ? Session->Close()
											  : Failure(SessionId, TEXT("session_unknown"),
														TEXT("This client does not own the renderer.")));
}

TSharedPtr<FJsonObject> FUEShedCameraRenderSession::Reopen(const TSharedPtr<FJsonObject> &Request)
{
	if (IsClosed() || UEShedCameraJsonText(State->Request) != UEShedCameraJsonText(Request))
		return Failure(Id(), TEXT("session_conflict"),
					   TEXT("The session identity is closed or describes different input."));
	Touch();
	auto Out = Object();
	Out->SetStringField(TEXT("status"), TEXT("opened"));
	Out->SetStringField(TEXT("sessionId"), Id());
	Out->SetObjectField(TEXT("resolvedPolicy"), State->Policy());
	return Out;
}
