#if WITH_DEV_AUTOMATION_TESTS
#include "UEShedAutomationLibrary.h"

#include "UEShedAutomationJson.h"
#include "UEShedAutomationProfiler.h"
#include "Async/Async.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EnhancedPlayerInput.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/PlayerInput.h"
#include "HAL/FileManager.h"
#include "InputAction.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "ProfilingDebugging/CsvProfiler.h"

namespace
{
TSharedPtr<FJsonObject> Decode(const FString& Json)
{
	TSharedPtr<FJsonObject> Value;
	FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Value);
	return Value;
}

FString ErrorCode(const FString& Json)
{
	auto Result = Decode(Json);
	if (!Result.IsValid()) return TEXT("invalid_json");
	const TArray<TSharedPtr<FJsonValue>>* Errors = nullptr;
	if (!Result->TryGetArrayField(TEXT("errors"), Errors) || Errors->IsEmpty()) return TEXT("");
	return (*Errors)[0]->AsObject()->GetStringField(TEXT("code"));
}

FString Envelope(const TCHAR* Name, const FString& Fields)
{
	return FString::Printf(TEXT("{\"contract\":{\"name\":\"%s\",\"version\":{\"major\":1,\"minor\":0}},%s}"),
		Name, *Fields);
}

FString CsvRequest(const TCHAR* Command)
{
	return Envelope(TEXT("unreal-automation-csv"),
		FString::Printf(TEXT("\"command\":\"%s\""), Command));
}

TSharedPtr<FJsonObject> SharedFixture(FAutomationTestBase* Test, const TCHAR* Filename,
	const TCHAR* Contract)
{
	FString Directory;
	if (!FParse::Value(FCommandLine::Get(), TEXT("UEShedAutomationContractFixtures="), Directory))
		return nullptr;
	FString Json;
	if (!Test->TestTrue(TEXT("Shared automation fixture loads"),
		FFileHelper::LoadFileToString(Json, *(Directory / Filename)))) return nullptr;
	auto Result = UEShedAutomation::Result(Contract);
	TSharedPtr<FJsonObject> Request;
	Test->TestTrue(TEXT("Native boundary accepts shared versioned envelope"),
		UEShedAutomation::Parse(Json, Contract, Result, Request));
	return Request;
}

struct FInputFixture
{
	UWorld* World = UWorld::CreateWorld(EWorldType::Game, false);
	UGameInstance* Instance = nullptr;
	APlayerController* Controller = nullptr;
	ULocalPlayer* Player = nullptr;
	UEnhancedPlayerInput* Input = nullptr;
	UInputAction* Action = nullptr;

	FInputFixture()
	{
		Instance = NewObject<UGameInstance>(GEngine);
		World->SetGameInstance(Instance);
		Player = NewObject<ULocalPlayer>(GEngine);
		Instance->AddLocalPlayer(Player, FPlatformUserId::CreateFromInternalId(0));
		Controller = World->SpawnActor<APlayerController>();
		// A fixture-owned local association avoids initializing online sessions or physical input.
		Controller->Player = Player;
		Player->PlayerController = Controller;
		// This world has not started gameplay, so actor PostInitializeComponents has not
		// registered its controller. Use the same idempotent world registration API here.
		World->AddController(Controller);
		Input = NewObject<UEnhancedPlayerInput>(Controller);
		Controller->PlayerInput = Input;
		Action = NewObject<UInputAction>(Instance);
		Action->ValueType = EInputActionValueType::Axis2D;
	}

	~FInputFixture()
	{
		Player->PlayerController = nullptr;
		Controller->Player = nullptr;
		Instance->RemoveLocalPlayer(Player);
		World->DestroyWorld(false);
	}

	FString InputRequest(const FString& Value, const FString& ControllerPath = TEXT("")) const
	{
		return Envelope(TEXT("unreal-automation-input"), FString::Printf(
			TEXT("\"worldObjectPath\":\"%s\",\"playerControllerObjectPath\":\"%s\",\"actionObjectPath\":\"%s\",\"value\":%s"),
			*World->GetPathName(), *(ControllerPath.IsEmpty() ? Controller->GetPathName() : ControllerPath),
			*Action->GetPathName(), *Value));
	}
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedAutomationInputTest, "UEShed.Automation.Input",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedAutomationInputTest::RunTest(const FString& Parameters)
{
	SharedFixture(this, TEXT("players-request.json"), TEXT("unreal-automation-players"));
	const auto SharedInput = SharedFixture(this, TEXT("input-request.json"),
		TEXT("unreal-automation-input"));
	FString Json;
	UUEShedAutomationLibrary::InjectInput(TEXT("{\"contract\":false}"), Json);
	TestEqual(TEXT("Wrong nested JSON type is a typed rejection"), ErrorCode(Json),
		FString(TEXT("unsupported_contract")));
	UUEShedAutomationLibrary::InjectInput(TEXT("[1,2,3]"), Json);
	TestEqual(TEXT("Array envelope rejected"), ErrorCode(Json), FString(TEXT("invalid_request")));
	UUEShedAutomationLibrary::InjectInput(FString::ChrN(16385, TEXT(' ')), Json);
	TestEqual(TEXT("Request byte bound"), ErrorCode(Json), FString(TEXT("payload_too_large")));
	UUEShedAutomationLibrary::InjectInput(FString::ChrN(8193, static_cast<TCHAR>(0x03bb)), Json);
	TestEqual(TEXT("Bound uses UTF-8 bytes rather than character count"), ErrorCode(Json),
		FString(TEXT("payload_too_large")));
	Json = Async(EAsyncExecution::ThreadPool, []
	{
		FString Result;
		UUEShedAutomationLibrary::InjectInput(TEXT("{}"), Result);
		return Result;
	}).Get();
	TestEqual(TEXT("Worker-thread call rejected before UObject access"), ErrorCode(Json),
		FString(TEXT("game_thread_required")));

	FInputFixture Fixture;
	const FString MissingWorld = Envelope(TEXT("unreal-automation-input"), FString::Printf(
		TEXT("\"worldObjectPath\":\"/Engine/Transient.MissingAutomationWorld\",\"playerControllerObjectPath\":\"%s\",\"actionObjectPath\":\"%s\",\"value\":{\"kind\":\"axis2d\",\"x\":1,\"y\":0}"),
		*Fixture.Controller->GetPathName(), *Fixture.Action->GetPathName()));
	UUEShedAutomationLibrary::InjectInput(MissingWorld, Json);
	TestEqual(TEXT("Missing explicitly selected world rejected"), ErrorCode(Json),
		FString(TEXT("world_not_found")));
	TestEqual(TEXT("Rejected result echoes requested controller"),
		Decode(Json)->GetStringField(TEXT("playerControllerObjectPath")), Fixture.Controller->GetPathName());
	TestEqual(TEXT("Rejected result echoes requested action"),
		Decode(Json)->GetStringField(TEXT("actionObjectPath")), Fixture.Action->GetPathName());
	if (SharedInput.IsValid())
	{
		SharedInput->SetStringField(TEXT("worldObjectPath"), Fixture.World->GetPathName());
		SharedInput->SetStringField(TEXT("playerControllerObjectPath"), Fixture.Controller->GetPathName());
		SharedInput->SetStringField(TEXT("actionObjectPath"), Fixture.Action->GetPathName());
		FString SharedJson;
		UEShedAutomation::Encode(SharedInput.ToSharedRef(), SharedJson);
		UUEShedAutomationLibrary::InjectInput(SharedJson, Json);
		TestEqual(TEXT("Shared protocol input value accepted by native implementation"),
			Decode(Json)->GetStringField(TEXT("status")), FString(TEXT("injected")));
		Fixture.Input->ProcessInputStack({}, 1.0f / 60, false);
		TestTrue(TEXT("Shared fixture coordinates reach Enhanced Input"),
			Fixture.Input->GetActionValue(Fixture.Action).Get<FVector2D>().Equals(FVector2D(0.25, -0.5)));
		Fixture.Input->ProcessInputStack({}, 1.0f / 60, false);
	}
	const FString Players = Envelope(TEXT("unreal-automation-players"),
		FString::Printf(TEXT("\"worldObjectPath\":\"%s\""), *Fixture.World->GetPathName()));
	UUEShedAutomationLibrary::ListPlayers(Players, Json);
	auto Result = Decode(Json);
	TestEqual(TEXT("Explicit world players returned"), Result->GetStringField(TEXT("status")),
		FString(TEXT("ok")));
	const auto& LocalPlayers = Result->GetArrayField(TEXT("players"));
	if (TestEqual(TEXT("Exactly one fixture local player"), LocalPlayers.Num(), 1))
	{
		auto Player = LocalPlayers[0]->AsObject();
		TestEqual(TEXT("Explicit controller path"), Player->GetStringField(TEXT("controllerObjectPath")),
			Fixture.Controller->GetPathName());
		TestEqual(TEXT("Local player index"), Player->GetIntegerField(TEXT("localPlayerIndex")), 0);
	}
	Fixture.World->WorldType = EWorldType::Editor;
	UUEShedAutomationLibrary::ListPlayers(Players, Json);
	TestEqual(TEXT("Editor world rejected"), ErrorCode(Json), FString(TEXT("unsupported_world")));
	Fixture.World->WorldType = EWorldType::Game;
	Fixture.World->bIsTearingDown = true;
	UUEShedAutomationLibrary::ListPlayers(Players, Json);
	TestEqual(TEXT("Tearing-down world rejected"), ErrorCode(Json),
		FString(TEXT("world_tearing_down")));
	Fixture.World->bIsTearingDown = false;
	UUEShedAutomationLibrary::ListPlayers(Envelope(TEXT("unreal-automation-players"),
		TEXT("\"worldObjectPath\":\"relative.World\"")), Json);
	TestEqual(TEXT("Relative object path rejected"), ErrorCode(Json), FString(TEXT("invalid_request")));
	UUEShedAutomationLibrary::ListPlayers(Envelope(TEXT("unreal-automation-players"),
		TEXT("\"worldObjectPath\":\"/Engine/Transient.World\\n\"")), Json);
	TestEqual(TEXT("Control characters in object path rejected"), ErrorCode(Json),
		FString(TEXT("invalid_request")));

	const FString Axis = TEXT("{\"kind\":\"axis2d\",\"x\":0.5,\"y\":-0.25}");
	UWorld* OtherWorld = UWorld::CreateWorld(EWorldType::Game, false);
	APlayerController* OtherController = OtherWorld->SpawnActor<APlayerController>();
	UUEShedAutomationLibrary::InjectInput(Fixture.InputRequest(Axis, OtherController->GetPathName()), Json);
	TestEqual(TEXT("No cross-world controller fallback"), ErrorCode(Json),
		FString(TEXT("controller_not_local")));
	OtherWorld->DestroyWorld(false);

	UUEShedAutomationLibrary::InjectInput(Fixture.InputRequest(TEXT("{\"kind\":\"boolean\",\"value\":true}")), Json);
	TestEqual(TEXT("Exact action value type required"), ErrorCode(Json),
		FString(TEXT("value_type_mismatch")));
	UUEShedAutomationLibrary::InjectInput(Fixture.InputRequest(TEXT("{\"kind\":\"axis2d\",\"x\":\"NaN\",\"y\":1}")), Json);
	TestEqual(TEXT("Invalid coordinate rejected"), ErrorCode(Json), FString(TEXT("invalid_value")));
	UUEShedAutomationLibrary::InjectInput(Fixture.InputRequest(TEXT("{\"kind\":\"axis2d\",\"x\":1e100,\"y\":1}")), Json);
	TestEqual(TEXT("Float overflow rejected"), ErrorCode(Json), FString(TEXT("invalid_value")));
	Fixture.Controller->PlayerInput = NewObject<UPlayerInput>(Fixture.Controller);
	UUEShedAutomationLibrary::InjectInput(Fixture.InputRequest(Axis), Json);
	TestEqual(TEXT("Standard input is explicit capability failure"), ErrorCode(Json),
		FString(TEXT("enhanced_input_unavailable")));
	Fixture.Controller->PlayerInput = Fixture.Input;
	UUEShedAutomationLibrary::InjectInput(Fixture.InputRequest(Axis), Json);
	TestEqual(TEXT("One-shot request injected"), Decode(Json)->GetStringField(TEXT("status")),
		FString(TEXT("injected")));
	Fixture.Input->ProcessInputStack({}, 1.0f / 60, false);
	TestTrue(TEXT("Real Enhanced Input evaluation consumes injected coordinates"),
		Fixture.Input->GetActionValue(Fixture.Action).Get<FVector2D>().Equals(FVector2D(0.5, -0.25)));
	Fixture.Input->ProcessInputStack({}, 1.0f / 60, false);
	TestTrue(TEXT("Injection releases on the next evaluation"),
		Fixture.Input->GetActionValue(Fixture.Action).Get<FVector2D>().IsNearlyZero());
	return true;
}

#if CSV_PROFILER
namespace
{
class FProfilingLifecycle : public IAutomationLatentCommand
{
	FAutomationTestBase* Test;
	int32 Phase = 0;
	double Deadline = FPlatformTime::Seconds() + 30;
	FString ExternalFile;
	TSharedFuture<FString> ExternalCompletion;

public:
	explicit FProfilingLifecycle(FAutomationTestBase* InTest) : Test(InTest) {}

	virtual bool Update() override
	{
		FString Json;
		UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("status")), Json);
		auto Result = Decode(Json);
		const FString State = Result->GetStringField(TEXT("state"));
		if (FPlatformTime::Seconds() > Deadline)
		{
			Test->AddError(TEXT("CSV lifecycle failed to complete within 30 seconds."));
			UEShedAutomation::GetProfiler().Shutdown();
			// This test created the external capture in the isolated project, so it may clean it.
			if (!ExternalFile.IsEmpty() && FCsvProfiler::Get()->IsCapturing()
				&& FPaths::IsSamePath(FCsvProfiler::Get()->GetOutputFilename(), ExternalFile))
				FCsvProfiler::Get()->EndCapture();
			return true;
		}
		if (Phase == 0 && State == TEXT("idle"))
		{
			Test->TestEqual(TEXT("Pending stop completes successfully"),
				Result->GetStringField(TEXT("status")), FString(TEXT("ok")));
			FString Filename;
			Test->TestTrue(TEXT("Completed capture has real file evidence"),
				Result->TryGetStringField(TEXT("outputFile"), Filename)
				&& IFileManager::Get().FileExists(*Filename));
			UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("start")), Json);
			Phase = 1;
		}
		else if (Phase == 1 && State == TEXT("capturing"))
		{
			UEShedAutomation::GetProfiler().Shutdown();
			UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("status")), Json);
			Test->TestEqual(TEXT("Shutdown stops its owned active capture asynchronously"),
				Decode(Json)->GetStringField(TEXT("state")), FString(TEXT("stopping")));
			Phase = 2;
		}
		else if (Phase == 2 && State == TEXT("idle"))
		{
			const FString Directory = Result->GetStringField(TEXT("outputDirectory"));
			const FString Filename = TEXT("ExternalFixture-") + FGuid::NewGuid().ToString() + TEXT(".csv");
			ExternalFile = Directory / Filename;
			FCsvProfiler::Get()->BeginCapture(-1, Directory, Filename);
			Phase = 3;
		}
		else if (Phase == 3 && FCsvProfiler::Get()->IsCapturing())
		{
			UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("start")), Json);
			Test->TestEqual(TEXT("Cannot steal outside capture"), ErrorCode(Json),
				FString(TEXT("capture_not_owned")));
			UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("stop")), Json);
			Test->TestEqual(TEXT("Cannot stop outside capture"), ErrorCode(Json),
				FString(TEXT("capture_not_owned")));
			UEShedAutomation::GetProfiler().Shutdown();
			Test->TestFalse(TEXT("Shutdown does not stop outside capture"),
				FCsvProfiler::Get()->IsEndCapturePending());
			ExternalCompletion = FCsvProfiler::Get()->EndCapture();
			Phase = 4;
		}
		else if (Phase == 4 && ExternalCompletion.IsValid() && ExternalCompletion.IsReady()
			&& !FCsvProfiler::Get()->IsWritingFile())
		{
			Test->TestTrue(TEXT("External fixture finished"),
				IFileManager::Get().FileExists(*ExternalCompletion.Get()));
			UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("stop")), Json);
			Test->TestEqual(TEXT("Idle stop remains idempotent"),
				Decode(Json)->GetStringField(TEXT("state")), FString(TEXT("idle")));
			return true;
		}
		return false;
	}
};
}
#endif

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedAutomationProfilingTest, "UEShed.Automation.Profiling",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedAutomationProfilingTest::RunTest(const FString& Parameters)
{
	SharedFixture(this, TEXT("csv-status-request.json"), TEXT("unreal-automation-csv"));
	FString Json;
	UUEShedAutomationLibrary::CsvProfiler(Envelope(TEXT("unreal-automation-csv"), TEXT("\"command\":false")), Json);
	TestEqual(TEXT("Malformed command is typed rejection"), ErrorCode(Json), FString(TEXT("invalid_request")));
#if CSV_PROFILER
	// A real user's profiler is never touched. Capture tests run only in the disposable test host.
	if (FPaths::GetBaseFilename(FPaths::GetProjectFilePath()) != TEXT("UEShedPluginCompatibility"))
	{
		AddError(TEXT("Run profiling via test:unreal-plugins in its isolated compatibility project."));
		return false;
	}
	if (FCsvProfiler::Get()->IsCapturing() || FCsvProfiler::Get()->IsWritingFile()
		|| FCsvProfiler::Get()->IsEndCapturePending())
	{
		AddError(TEXT("Refusing to run profiling lifecycle while an existing CSV capture is active."));
		return false;
	}
	UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("start")), Json);
	TestEqual(TEXT("Start is honestly pending"), Decode(Json)->GetStringField(TEXT("state")),
		FString(TEXT("starting")));
	TestTrue(TEXT("Pending capture does not invent an output file"),
		Decode(Json)->GetField<EJson::None>(TEXT("outputFile"))->IsNull());
	UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("start")), Json);
	TestEqual(TEXT("Repeated start is idempotent"), Decode(Json)->GetStringField(TEXT("state")),
		FString(TEXT("starting")));
	UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("stop")), Json);
	TestEqual(TEXT("Stop while queued is retained"), Decode(Json)->GetStringField(TEXT("state")),
		FString(TEXT("stopping")));
	UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("stop")), Json);
	TestEqual(TEXT("Repeated pending stop is idempotent"), Decode(Json)->GetStringField(TEXT("state")),
		FString(TEXT("stopping")));
	ADD_LATENT_AUTOMATION_COMMAND(FProfilingLifecycle(this));
#else
	UUEShedAutomationLibrary::CsvProfiler(CsvRequest(TEXT("status")), Json);
	TestEqual(TEXT("Disabled profiler capability has typed unavailability"), ErrorCode(Json),
		FString(TEXT("profiler_unavailable")));
#endif
	return true;
}
#endif
