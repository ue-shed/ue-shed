#if WITH_DEV_AUTOMATION_TESTS
#include "UEShedNiagaraCapture.h"
#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "NiagaraBakerSettings.h"
#include "NiagaraSystem.h"
#include "UObject/StrongObjectPtr.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedNiagaraIndependentCameraTest,
	"UEShed.Niagara.IndependentCamera",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedNiagaraIndependentCameraTest::RunTest(const FString& Parameters)
{
	UNiagaraSystem* Template = LoadObject<UNiagaraSystem>(nullptr,
		TEXT("/Niagara/DefaultAssets/Templates/Systems/SimpleExplosion.SimpleExplosion"));
	if (!TestNotNull(TEXT("Engine Niagara fixture"), Template)) return false;
	TStrongObjectPtr<UNiagaraSystem> System(DuplicateObject<UNiagaraSystem>(Template, GetTransientPackage()));
	System->GetBakerSettings()->CameraSettings.Empty();
	FUEShedNiagaraPreviewOptions Options;
	Options.RequestedSettings = MakeShared<FJsonObject>();
	Options.Width = Options.Height = 64;
	Options.FrameCount = 2;
	Options.DurationSeconds = 1;
	FString Error;
	{
		FUEShedNiagaraCapture Capture;
		TestFalse(TEXT("Saved mode requires a Baker camera"), Capture.Initialize(System.Get(), Options, Error));
		TestTrue(TEXT("Saved camera failure remains actionable"), Error.Contains(TEXT("saved Baker camera")));
	}
	for (bool bOverride : {false, true})
	{
		Options.CameraMode = bOverride ? TEXT("saved") : TEXT("auto_fit");
		if (bOverride)
		{
			Options.CameraOverride = MakeShared<FJsonObject>();
			auto Vector = MakeShared<FJsonObject>();
			Vector->SetNumberField(TEXT("x"), 0); Vector->SetNumberField(TEXT("y"), -500); Vector->SetNumberField(TEXT("z"), 0);
			auto Rotation = MakeShared<FJsonObject>();
			Rotation->SetNumberField(TEXT("pitch"), 0); Rotation->SetNumberField(TEXT("yaw"), 90); Rotation->SetNumberField(TEXT("roll"), 0);
			Options.CameraOverride->SetObjectField(TEXT("location"), Vector);
			Options.CameraOverride->SetObjectField(TEXT("rotation"), Rotation);
			Options.CameraOverride->SetNumberField(TEXT("fieldOfViewDegrees"), 45);
		}
		FUEShedNiagaraCapture Capture;
		if (!TestTrue(bOverride ? TEXT("Explicit camera without Baker camera") : TEXT("Auto fit without Baker camera"),
			Capture.Initialize(System.Get(), Options, Error))) { AddError(Error); continue; }
		const FString Receipt = FPaths::Combine(FPaths::ProjectSavedDir(), FGuid::NewGuid().ToString() + TEXT(".json"));
		TestTrue(TEXT("Receipt does not dereference missing Baker camera"), Capture.WriteProducerReceipt(Receipt, {}, Error));
		IFileManager::Get().Delete(*Receipt);
		TestTrue(TEXT("Source camera array remains empty"), System->GetBakerSettings()->CameraSettings.IsEmpty());
	}
	return true;
}
#endif
