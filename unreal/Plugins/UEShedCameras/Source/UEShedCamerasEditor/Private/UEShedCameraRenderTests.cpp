#if WITH_DEV_AUTOMATION_TESTS
#include "Camera/CameraActor.h"
#include "Components/SceneCaptureComponent2D.h"
#include "DataLayer/DataLayerEditorSubsystem.h"
#include "Editor.h"
#include "FileHelpers.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "HighResScreenshot.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Misc/App.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "UEShedCameraRenderSession.h"
#include "UEShedCameraReviewLibrary.h"
#include "UnrealClient.h"
#include "WorldPartition/DataLayer/DataLayerAsset.h"
#include "WorldPartition/DataLayer/DataLayerInstance.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraRenderLifecycleTest,
								 "UEShed.Cameras.Rendering.LifecycleAndReference",
								 EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraRenderLifecycleTest::RunTest(const FString &Parameters)
{
	UWorld *World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	auto *Client = GCurrentLevelEditingViewportClient;
	if (!World || !Client || !Client->Viewport || GEditor->PlayWorld)
	{
		AddError(TEXT("Open a rendering editor fixture without Play or Simulate."));
		return false;
	}
	const FVector BeforeLocation = Client->GetViewLocation();
	const FRotator BeforeRotation = Client->GetViewRotation();
	const auto BeforeType = Client->GetViewportType();
	const auto BeforeFlags = Client->EngineShowFlags.ToString();
	const auto BeforeExposure = Client->ExposureSettings;
	const bool BeforeGame = Client->IsInGameView(), BeforeInput = Client->bDisableInput;
	const bool BeforeRealtime = Client->IsRealtime(), BeforeDirty = World->GetOutermost()->IsDirty();
	const auto Screenshot = GetHighResScreenshotConfig();
	auto Restored = [&]() {
		TestEqual(TEXT("Viewport location restored"), Client->GetViewLocation(), BeforeLocation);
		TestEqual(TEXT("Viewport rotation restored"), Client->GetViewRotation(), BeforeRotation);
		TestEqual(TEXT("Viewport type restored"), Client->GetViewportType(), BeforeType);
		TestEqual(TEXT("Show flags restored"), Client->EngineShowFlags.ToString(), BeforeFlags);
		TestEqual(TEXT("Exposure mode restored"), Client->ExposureSettings.bFixed, BeforeExposure.bFixed);
		TestEqual(TEXT("Exposure value restored"), Client->ExposureSettings.FixedEV100,
				  BeforeExposure.FixedEV100);
		TestEqual(TEXT("Game view restored"), Client->IsInGameView(), BeforeGame);
		TestEqual(TEXT("Input restored"), Client->bDisableInput, BeforeInput);
		TestEqual(TEXT("Realtime restored"), Client->IsRealtime(), BeforeRealtime);
		TestFalse(TEXT("Transient actor lock released"), Client->IsAnyActorLocked());
		TestEqual(TEXT("Map dirty state preserved"), World->GetOutermost()->IsDirty(), BeforeDirty);
		TestEqual(TEXT("Screenshot filename restored"), GetHighResScreenshotConfig().FilenameOverride,
				  Screenshot.FilenameOverride);
	};
	const FString Directory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed/RenderingValidation"));
	IFileManager::Get().MakeDirectory(*Directory, true);
	TArray<TSharedPtr<FJsonValue>> Comparisons;
	for (bool Ortho : {false, true})
	{
		FImage Reference;
		const FString Projection = Ortho ? TEXT("orthographic") : TEXT("perspective");
		const FVector Location(1000, 1000, 900);
		const FRotator Rotation(-30, -135, 0);
		const auto Camera = UEShedCameraPose(Location, Rotation, Ortho ? 2400 : 60, Ortho);
		const FIntPoint Size = Client->Viewport->GetSizeXY();
		for (bool Viewport : {true, false})
		{
			const FString Backend = Viewport ? TEXT("editor_viewport") : TEXT("scene_capture");
			auto Request = UEShedLegacyRenderRequest(FGuid::NewGuid().ToString(EGuidFormats::Digits), World,
													 Viewport, TEXT("full_fidelity"));
			auto Policy = Request->GetObjectField(TEXT("policy"));
			Policy->SetObjectField(
				TEXT("exposure"),
				UEShedCameraJson(
					TEXT("{\"mode\":\"fixed_ev100\",\"ev100\":1,\"compensation\":\"project\"}")));
			Policy->GetObjectField(TEXT("settling"))->SetNumberField(TEXT("minimumFrames"), 32);
			if (Viewport)
				Policy->GetObjectField(TEXT("renderer"))->SetStringField(TEXT("vignette"), TEXT("project"));
			TSharedPtr<FJsonObject> Error;
			auto Session = FUEShedCameraRenderSession::Open(Request, Error);
			if (!Session)
			{
				AddError(UEShedCameraJsonText(Error));
				return false;
			}
			auto Contender = UEShedLegacyRenderRequest(TEXT("contender"), World, !Viewport);
			TestEqual(TEXT("Cross-backend contention rejected"),
					  FUEShedCameraRenderSession::Preflight(Contender)->GetStringField(TEXT("status")),
					  FString(TEXT("blocked")));
			auto Frame = UEShedRenderFrame(Session->Id(), TEXT("frame"), Camera, Size.X, Size.Y);
			auto Result = Session->RenderBlocking(Frame);
			if (Result->GetStringField(TEXT("status")) != TEXT("captured"))
			{
				AddError(UEShedCameraJsonText(Result));
				Session->Close();
				return false;
			}
			if (Viewport)
			{
				TestEqual(TEXT("Actual viewport camera position"),
						  Client->GetActorLock().GetLockedActor()->GetActorLocation(), Location);
				TestTrue(TEXT("Actual viewport camera rotation"),
						 Client->GetActorLock().GetLockedActor()->GetActorRotation().Equals(Rotation, .001));
			}
			else
			{
				TestEqual(TEXT("Actual SceneCapture position"),
						  Session->SceneComponent()->GetComponentLocation(), Location);
				TestTrue(TEXT("Actual SceneCapture rotation"),
						 Session->SceneComponent()->GetComponentRotation().Equals(Rotation, .001));
			}
			const FString Raw = FPaths::Combine(
				FPaths::ProjectSavedDir(), TEXT("UEShed/CameraRenderStaging"),
				Result->GetObjectField(TEXT("artifact"))->GetStringField(TEXT("relativePath")));
			FImage Captured;
			TestTrue(TEXT("Decode captured PNG"), FImageUtils::LoadImage(*Raw, Captured));
			Captured.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
			IFileManager::Get().Copy(
				*FPaths::Combine(Directory, Backend + TEXT("-") + Projection + TEXT(".png")), *Raw);
			if (Viewport)
			{
				// Read ordinary editor viewport pixels, independently of the high-resolution
				// screenshot.
				for (int32 I = 0; I < 32; ++I)
					Client->Viewport->Draw(false);
				TArray<FColor> Pixels;
				TestTrue(TEXT("Read matching editor reference"),
						 GetViewportScreenShot(Client->Viewport, Pixels));
				for (auto &Pixel : Pixels)
					Pixel.A = 255;
				const FString Path =
					FPaths::Combine(Directory, TEXT("editor-reference-") + Projection + TEXT(".png"));
				TestTrue(
					TEXT("Write editor reference"),
					FImageUtils::SaveImageByExtension(*Path, FImageView(Pixels.GetData(), Size.X, Size.Y)));
				FImageUtils::LoadImage(*Path, Reference);
				Reference.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
			}
			if (Captured.SizeX == Reference.SizeX && Captured.SizeY == Reference.SizeY)
			{
				double Absolute = 0, Squared = 0;
				for (int64 I = 0; I < Captured.RawData.Num(); ++I)
					if (I % 4 != 3)
					{
						const double D = (double(Captured.RawData[I]) - Reference.RawData[I]) / 255.0;
						Absolute += FMath::Abs(D);
						Squared += D * D;
					}
				const double Samples = double(Captured.SizeX) * Captured.SizeY * 3;
				auto Comparison = MakeShared<FJsonObject>();
				Comparison->SetStringField(TEXT("renderer"), Backend);
				Comparison->SetStringField(TEXT("projection"), Projection);
				Comparison->SetNumberField(TEXT("width"), Size.X);
				Comparison->SetNumberField(TEXT("height"), Size.Y);
				Comparison->SetNumberField(TEXT("meanAbsoluteError"), Absolute / Samples);
				Comparison->SetNumberField(TEXT("rootMeanSquareError"), FMath::Sqrt(Squared / Samples));
				Comparison->SetObjectField(TEXT("renderEvidence"), Result->GetObjectField(TEXT("evidence")));
				Comparisons.Add(MakeShared<FJsonValueObject>(Comparison));
			}
			TestEqual(TEXT("Same operation is pollable"),
					  Session->Start(Frame)->GetStringField(TEXT("status")), FString(TEXT("captured")));
			auto Conflict = UEShedCameraJson(UEShedCameraJsonText(Frame));
			Conflict->GetObjectField(TEXT("size"))->SetNumberField(TEXT("width"), 160);
			TestEqual(TEXT("Changed input cannot reuse operation ID"),
					  Session->Start(Conflict)->GetStringField(TEXT("code")),
					  FString(TEXT("operation_conflict")));
			TestEqual(TEXT("Successful restoration"), Session->Close()->GetStringField(TEXT("status")),
					  FString(TEXT("closed")));
			Restored();
		}
	}
	for (const FString Mode : {TEXT("cancel"), TEXT("lease"), TEXT("shutdown")})
	{
		auto Request =
			UEShedLegacyRenderRequest(FGuid::NewGuid().ToString(EGuidFormats::Digits), World, true);
		Request->SetNumberField(TEXT("leaseMs"), 1000);
		Request->GetObjectField(TEXT("policy"))
			->SetStringField(TEXT("time"), TEXT("freeze_materials_and_ticks"));
		TSharedPtr<FJsonObject> Error;
		auto Session = FUEShedCameraRenderSession::Open(Request, Error);
		if (!Session)
		{
			AddError(UEShedCameraJsonText(Error));
			return false;
		}
		Session->Start(UEShedRenderFrame(
			Session->Id(), TEXT("interrupted"),
			UEShedCameraPose(FVector(1000, 1000, 900), FRotator(-30, -135, 0), 60, false), 320, 180));
		Session->Tick(true);
		if (Mode == TEXT("lease"))
		{
			FPlatformProcess::Sleep(1.05f);
			Session->Tick();
			TestEqual(TEXT("Lease expiry is explicit"),
					  Session->Poll(TEXT("interrupted"))->GetStringField(TEXT("code")),
					  FString(TEXT("lease_expired")));
		}
		else if (Mode == TEXT("shutdown"))
			FUEShedCameraRenderSession::Shutdown();
		else
			Session->Close();
		TestTrue(TEXT("Interrupted owner is closed"), Session->IsClosed());
		Restored();
	}
	auto Evidence = MakeShared<FJsonObject>();
	Evidence->SetArrayField(TEXT("comparisons"), Comparisons);
	Evidence->SetStringField(TEXT("qualityStatus"), TEXT("requires_visual_review"));
	FFileHelper::SaveStringToFile(UEShedCameraJsonText(Evidence),
								  *FPaths::Combine(Directory, TEXT("comparison.json")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraScreenshotOwnershipTest,
								 "UEShed.Cameras.Rendering.ScreenshotOwnership",
								 EAutomationTestFlags::EditorContext |
									 EAutomationTestFlags::EngineFilter)

bool FUEShedCameraScreenshotOwnershipTest::RunTest(const FString &Parameters)
{
	auto *World = GEditor->GetEditorWorldContext().World();
	auto *Client = GCurrentLevelEditingViewportClient;
	const auto BeforeConfig = GetHighResScreenshotConfig();
	const uint32 BeforeX = GScreenshotResolutionX, BeforeY = GScreenshotResolutionY;
	ON_SCOPE_EXIT
	{
		FScreenshotRequest::Reset();
		GIsHighResScreenshot = false;
		GetHighResScreenshotConfig() = BeforeConfig;
		GScreenshotResolutionX = BeforeX;
		GScreenshotResolutionY = BeforeY;
	};
	for (const FString Stage : {TEXT("warmup"), TEXT("pending"), TEXT("completed")})
	{
		auto Request =
			UEShedLegacyRenderRequest(FGuid::NewGuid().ToString(EGuidFormats::Digits), World, true);
		TSharedPtr<FJsonObject> Error;
		auto Session = FUEShedCameraRenderSession::Open(Request, Error);
		if (!Session)
		{
			AddError(UEShedCameraJsonText(Error));
			return false;
		}
		auto Frame = UEShedRenderFrame(
			Session->Id(), TEXT("ownership"),
			UEShedCameraPose(FVector(1000, 1000, 900), FRotator(-30, -135, 0), 60, false), 160, 90);
		Session->Start(Frame);
		if (Stage == TEXT("pending"))
		{
			Session->Tick(true);
			TestTrue(TEXT("Own screenshot pending before takeover"), GIsHighResScreenshot);
		}
		else if (Stage == TEXT("completed"))
			TestEqual(TEXT("Complete owned frame"),
					  Session->RenderBlocking(Frame)->GetStringField(TEXT("status")),
					  FString(TEXT("captured")));
		auto &Config = GetHighResScreenshotConfig();
		Config.SetFilename(FPaths::Combine(FPaths::ProjectSavedDir(),
										   TEXT("UEShed/RenderingValidation/other-tool.png")));
		Config.SetResolution(128, 128);
		Config.SetMaskEnabled(true);
		Config.bDateTimeBasedNaming = true;
		FScreenshotRequest::RequestScreenshot(Config.FilenameOverride, true, false);
		const FString OtherFilename = FScreenshotRequest::GetFilename();
		const FString OtherConfigFilename = Config.FilenameOverride;
		if (Stage == TEXT("warmup"))
			Session->Tick(true);
		const auto Closed = Session->Close();
		TestEqual(TEXT("Ownership loss is reported"), Closed->GetStringField(TEXT("status")),
				  FString(Stage == TEXT("pending") ? TEXT("failed") : TEXT("closed")));
		TestTrue(TEXT("Other screenshot request survives cleanup"),
				 FScreenshotRequest::IsScreenshotRequested());
		TestTrue(TEXT("Other high-resolution request survives cleanup"), GIsHighResScreenshot);
		TestEqual(TEXT("Other request filename preserved"), FScreenshotRequest::GetFilename(),
				  OtherFilename);
		TestEqual(TEXT("Other config filename preserved"), Config.FilenameOverride,
				  OtherConfigFilename);
		TestEqual(TEXT("Other resolution preserved"), GScreenshotResolutionX, uint32(128));
		TestTrue(TEXT("Other mask preserved"), Config.bMaskEnabled);
		TestTrue(TEXT("Other naming preserved"), Config.bDateTimeBasedNaming);
		// Consume the viewport's queued screenshot only after asserting the external owner's state.
		if (Stage == TEXT("pending"))
			Client->Viewport->Draw(false);
		FScreenshotRequest::Reset();
		GIsHighResScreenshot = false;
		Config = BeforeConfig;
		GScreenshotResolutionX = BeforeX;
		GScreenshotResolutionY = BeforeY;
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedMapMinorCompatibilityTest,
								 "UEShed.Cameras.Rendering.MapMinorCompatibility",
								 EAutomationTestFlags::EditorContext |
									 EAutomationTestFlags::EngineFilter)

bool FUEShedMapMinorCompatibilityTest::RunTest(const FString &Parameters)
{
	auto *World = GEditor->GetEditorWorldContext().World();
	for (const FString Backend :
		 {TEXT("scene_capture_tiles"), TEXT("viewport_high_resolution"), TEXT("lit_camera_tiles")})
		for (int32 Minor : {0, 1})
		{
			auto Request = UEShedCameraJson(TEXT(
				R"({"contract":{"name":"ue-shed-map-tile-capture","version":{"major":1,"minor":0}},"operationId":"compatibility","correlationId":"compatibility","planId":"compatibility","runId":"compatibility","tilePixelSize":64,"gutterPixels":0,"capture":{"z":2000,"orientation":{"pitch":-90,"yaw":0,"roll":0},"dataLayers":{"mode":"unchanged"},"render":{"profile":"full_fidelity","lodPolicy":"natural","effects":{"fog":false,"volumetricFog":false}}},"tiles":[{"key":{"zoom":0,"row":0,"column":0},"unitsPerPixel":32,"worldBounds":{"minX":0,"minY":0,"maxX":2048,"maxY":2048}}]})"));
			Request->SetStringField(TEXT("runId"), FGuid::NewGuid().ToString(EGuidFormats::Digits));
			Request->SetStringField(TEXT("expectedMapPath"), World->GetOutermost()->GetName());
			Request->SetStringField(TEXT("captureBackend"), Backend);
			Request->GetObjectField(TEXT("contract"))
				->GetObjectField(TEXT("version"))
				->SetNumberField(TEXT("minor"), Minor);
			FString Text;
			if (Backend == TEXT("lit_camera_tiles"))
			{
				UUEShedCameraReviewLibrary::BeginMapTileCapture(UEShedCameraJsonText(Request), Text);
				const double Deadline = FPlatformTime::Seconds() + 120;
				while (UEShedCameraJson(Text)->GetStringField(TEXT("state")) == TEXT("running") &&
					   FPlatformTime::Seconds() < Deadline)
				{
					FSlateApplication::Get().Tick();
					UUEShedCameraReviewLibrary::PollMapTileCapture(
						Request->GetStringField(TEXT("runId")), TEXT("compatibility"), Text);
				}
				Text = UEShedCameraJsonText(UEShedCameraJson(Text)->GetObjectField(TEXT("response")));
				FString Release;
				UUEShedCameraReviewLibrary::EndMapTileCapture(Request->GetStringField(TEXT("runId")),
															  Release);
				TestEqual(TEXT("Map session restored"),
						  UEShedCameraJson(Release)->GetStringField(TEXT("restoration")),
						  FString(TEXT("restored")));
			}
			else
				UUEShedCameraReviewLibrary::CaptureMapTiles(UEShedCameraJsonText(Request), Text);
			const auto Response = UEShedCameraJson(Text);
			TestEqual(*Text, Response->GetStringField(TEXT("status")), FString(TEXT("completed")));
			TestEqual(TEXT("Response honors requested minor"),
					  Response->GetObjectField(TEXT("contract"))
						  ->GetObjectField(TEXT("version"))
						  ->GetIntegerField(TEXT("minor")),
					  Minor);
			for (const auto &Tile : Response->GetArrayField(TEXT("results")))
				TestEqual(TEXT("Evidence is emitted only for minor 1"),
						  Tile->AsObject()->HasField(TEXT("renderEvidence")), Minor == 1);
			Request->SetStringField(TEXT("expectedMapPath"), TEXT("/Game/Unavailable"));
			UUEShedCameraReviewLibrary::CaptureMapTiles(UEShedCameraJsonText(Request), Text);
			TestEqual(TEXT("Failure honors requested minor"),
					  UEShedCameraJson(Text)
						  ->GetObjectField(TEXT("contract"))
						  ->GetObjectField(TEXT("version"))
						  ->GetIntegerField(TEXT("minor")),
					  Minor);
		}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraRenderPreparationTest,
								 "UEShed.Cameras.Rendering.PreparationAndWorldChange",
								 EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraRenderPreparationTest::RunTest(const FString &Parameters)
{
	// This test intentionally changes maps in the disposable, generic fixture editor.
	if (FString(FApp::GetProjectName()) != TEXT("UEShedFixture"))
	{
		AddError(TEXT("Run preparation validation in UEShedFixture."));
		return false;
	}
	UWorld *Original = GEditor->GetEditorWorldContext().World();
	const FString OriginalMap = Original->GetOutermost()->GetName();
	TSharedPtr<FJsonObject> Error;
	auto Session = FUEShedCameraRenderSession::Open(
		UEShedLegacyRenderRequest(TEXT("world-change-validation"), Original, true), Error);
	if (!Session)
	{
		AddError(UEShedCameraJsonText(Error));
		return false;
	}
	TestTrue(TEXT("Open partitioned generic fixture"),
			 FEditorFileUtils::LoadMap(TEXT("/Game/Fixture/Offline/L_OfflineWorld"), false, false));
	TestTrue(TEXT("World change closes render owner"), Session->IsClosed());
	TestEqual(TEXT("World change restores ownership"), Session->Close()->GetStringField(TEXT("status")),
			  FString(TEXT("closed")));
	UWorld *World = GEditor->GetEditorWorldContext().World();
	if (!World->GetWorldPartition())
	{
		AddError(TEXT("Expected a partitioned fixture world."));
		return false;
	}
	auto *Layers = GEditor->GetEditorSubsystem<UDataLayerEditorSubsystem>();
	FDataLayerCreationParameters Creation;
	Creation.DataLayerAsset = NewObject<UDataLayerAsset>(
		GetTransientPackage(), FName(*FGuid::NewGuid().ToString(EGuidFormats::Digits)), RF_Transient);
	auto *Layer = Layers->CreateDataLayerInstance(Creation);
	if (!Layer)
	{
		AddError(TEXT("Could not create a transient fixture Data Layer."));
		return false;
	}
	Layers->SetDataLayerIsLoadedInEditor(Layer, false, false);
	Layers->SetDataLayerVisibility(Layer, false);
	for (bool Viewport : {false, true})
	{
		auto Request =
			UEShedLegacyRenderRequest(FGuid::NewGuid().ToString(EGuidFormats::Digits), World, Viewport);
		auto Prep = Request->GetObjectField(TEXT("policy"))->GetObjectField(TEXT("preparation"));
		Prep->SetObjectField(TEXT("geometry"),
							 UEShedCameraJson(TEXT("{\"mode\":\"camera_regions\",\"maximumRegions\":1,"
												   "\"extent\":{\"x\":2000,\"y\":2000,\"z\":2000}}")));
		auto Requirement = MakeShared<FJsonObject>();
		Requirement->SetStringField(TEXT("assetPath"), Creation.DataLayerAsset->GetPathName());
		Requirement->SetBoolField(TEXT("loaded"), true);
		Requirement->SetBoolField(TEXT("visible"), true);
		Prep->SetArrayField(TEXT("dataLayers"), {MakeShared<FJsonValueObject>(Requirement)});
		Session = FUEShedCameraRenderSession::Open(Request, Error);
		if (!Session)
		{
			AddError(UEShedCameraJsonText(Error));
			break;
		}
		TestTrue(TEXT("Required layer effectively loaded"), Layer->IsEffectiveLoadedInEditor());
		TestTrue(TEXT("Required layer effectively visible"), Layer->IsEffectiveVisible());
		auto Frame = UEShedRenderFrame(Session->Id(), TEXT("region"),
									   UEShedCameraPose(FVector(0, 0, 1000), FRotator(-90, 0, 0), 2000, true),
									   160, 90);
		auto Result = Session->RenderBlocking(Frame);
		TestEqual(TEXT("Prepared frame captured"), Result->GetStringField(TEXT("status")),
				  FString(TEXT("captured")));
		if (Result->HasField(TEXT("evidence")))
			TestEqual(TEXT("One region held"),
					  Result->GetObjectField(TEXT("evidence"))
						  ->GetObjectField(TEXT("preparation"))
						  ->GetIntegerField(TEXT("regionsHeld")),
					  1);
		Frame->SetStringField(TEXT("operationId"), TEXT("over-budget"));
		Frame->GetObjectField(TEXT("camera"))
			->GetObjectField(TEXT("location"))
			->SetNumberField(TEXT("x"), 10000);
		TestEqual(TEXT("Region budget enforced"), Session->Start(Frame)->GetStringField(TEXT("code")),
				  FString(TEXT("preparation_budget_exceeded")));
		TestEqual(TEXT("Prepared session restored"), Session->Close()->GetStringField(TEXT("status")),
				  FString(TEXT("closed")));
		TestFalse(TEXT("Layer loading restored"), Layer->IsLoadedInEditor());
		TestFalse(TEXT("Layer visibility restored"), Layer->IsVisible());
	}
	Layers->DeleteDataLayer(Layer);
	TestTrue(TEXT("Return to original fixture without saving"),
			 FEditorFileUtils::LoadMap(OriginalMap, false, false));
	return true;
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraRenderContractTest, "UEShed.Cameras.Rendering.WireConformance",
								 EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraRenderContractTest::RunTest(const FString &Parameters)
{
	const FString Directory =
		Parameters.IsEmpty()
			? FPaths::ConvertRelativePathToFull(FPaths::Combine(
				  FPaths::ProjectDir(), TEXT("../../packages/protocol/contracts/cameras/render/v1/fixtures")))
			: Parameters;
	TArray<FString> Files;
	IFileManager::Get().FindFiles(Files, *FPaths::Combine(Directory, TEXT("*.json")), true, false);
	if (Files.IsEmpty())
	{
		AddError(
			TEXT("Pass the camera render wire fixture directory or run in the repository fixture project."));
		return false;
	}
	for (const FString &File : Files)
	{
		FString Text;
		FFileHelper::LoadFileToString(Text, *FPaths::Combine(Directory, File));
		auto Input = UEShedCameraJson(Text);
		const bool Invalid = File.StartsWith(TEXT("invalid-"));
		if (File.Contains(TEXT("session-")))
		{
			auto Result = FUEShedCameraRenderSession::Preflight(Input);
			bool InvalidPolicy = false;
			for (const auto &Issue : Result->GetArrayField(TEXT("issues")))
				InvalidPolicy |= Issue->AsObject()->GetStringField(TEXT("code")) == TEXT("invalid_policy");
			TestEqual(*File, InvalidPolicy, Invalid);
		}
		else
		{
			TSharedPtr<FJsonObject> Error;
			auto Session = FUEShedCameraRenderSession::Open(
				UEShedLegacyRenderRequest(FGuid::NewGuid().ToString(EGuidFormats::Digits),
										  GEditor->GetEditorWorldContext().World(), false),
				Error);
			if (!Session)
			{
				AddError(UEShedCameraJsonText(Error));
				return false;
			}
			Input->SetStringField(TEXT("sessionId"), Session->Id());
			const auto Result = Session->Start(Input);
			TestEqual(*File, Result->GetStringField(TEXT("status")),
					  FString(Invalid ? TEXT("failed") : TEXT("running")));
			Session->Close();
		}
	}
	return true;
}
#endif
