#include "UEShedScenarioExecution.h"

#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/GameInstance.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "EnhancedInputSubsystems.h"
#include "Framework/Application/IInputProcessor.h"
#include "Framework/Application/SlateApplication.h"
#include "FileHelpers.h"
#include "GameFramework/PlayerController.h"
#include "InputAction.h"
#include "InputActionValue.h"
#include "Misc/PackageName.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UEShedEditorPlaySessionLibrary.h"
#include "UEShedScenarioStateProvider.h"
#include "UEShedScenariosModule.h"

namespace
{
constexpr int32 MaxActions = 8;
constexpr int32 MaxDurationMs = 30000;
constexpr int32 MaxEvidence = 8;
constexpr int32 MaxKeyframes = 32;

class FScenarioInputBlocker final : public IInputProcessor
{
public:
	virtual void Tick(const float, FSlateApplication&, TSharedRef<ICursor>) override {}
	virtual bool HandleKeyDownEvent(FSlateApplication&, const FKeyEvent&) override { return true; }
	virtual bool HandleKeyUpEvent(FSlateApplication&, const FKeyEvent&) override { return true; }
	virtual bool HandleAnalogInputEvent(FSlateApplication&, const FAnalogInputEvent&) override { return true; }
	virtual bool HandleMouseMoveEvent(FSlateApplication&, const FPointerEvent&) override { return true; }
	virtual bool HandleMouseButtonDownEvent(FSlateApplication&, const FPointerEvent&) override { return true; }
	virtual bool HandleMouseButtonUpEvent(FSlateApplication&, const FPointerEvent&) override { return true; }
	virtual bool HandleMouseButtonDoubleClickEvent(FSlateApplication&, const FPointerEvent&) override { return true; }
	virtual bool HandleMouseWheelOrGestureEvent(FSlateApplication&, const FPointerEvent&,
		const FPointerEvent*) override { return true; }
	virtual bool HandleMotionDetectedEvent(FSlateApplication&, const FMotionEvent&) override { return true; }
	virtual const TCHAR* GetDebugName() const override { return TEXT("UEShedScenarioInputIsolation"); }
};

struct FScenarioKeyframe
{
	int32 AtMs = 0;
	FVector Value = FVector::ZeroVector;
	bool bBoolean = false;
};

struct FScenarioActionClip
{
	FName ActionId;
	FString ActionPath;
	EUEShedScenarioActionValueType ValueType = EUEShedScenarioActionValueType::Boolean;
	UInputAction* Action = nullptr;
	TArray<FScenarioKeyframe> Keyframes;
	int32 InjectedFrames = 0;
};

TSharedRef<FJsonObject> ContractJson()
{
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-scenario-execution"));
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}

void Serialize(const TSharedRef<FJsonObject>& Root, FString& Output)
{
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
	FJsonSerializer::Serialize(Root, Writer);
}

TSharedRef<FJsonObject> Rejected(const FString& Code, const FString& Message,
	const FString& Recovery)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("_tag"), TEXT("Rejected"));
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("code"), Code);
	Root->SetStringField(TEXT("message"), Message);
	Root->SetStringField(TEXT("recovery"), Recovery);
	return Root;
}

bool ReadContract(const TSharedPtr<FJsonObject>& Root)
{
	const TSharedPtr<FJsonObject>* Contract = nullptr;
	const TSharedPtr<FJsonObject>* Version = nullptr;
	FString Name;
	double Major = -1;
	double Minor = -1;
	return Root.IsValid() && Root->TryGetObjectField(TEXT("contract"), Contract)
		&& (*Contract)->TryGetStringField(TEXT("name"), Name)
		&& Name == TEXT("ue-shed-scenario-execution")
		&& (*Contract)->TryGetObjectField(TEXT("version"), Version)
		&& (*Version)->TryGetNumberField(TEXT("major"), Major)
		&& (*Version)->TryGetNumberField(TEXT("minor"), Minor)
		&& Major == 1 && Minor == 0;
}

AActor* StateProvider(UWorld* World)
{
	if (World == nullptr) return nullptr;
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		if (It->GetClass()->ImplementsInterface(UUEShedScenarioStateProvider::StaticClass()))
		{
			return *It;
		}
	}
	return nullptr;
}

bool Condition(UWorld* World, FName ConditionId)
{
	AActor* Provider = StateProvider(World);
	return Provider != nullptr
		&& IUEShedScenarioStateProvider::Execute_EvaluateScenarioCondition(Provider, ConditionId);
}

FString StateSummary(UWorld* World)
{
	AActor* Provider = StateProvider(World);
	if (Provider == nullptr) return TEXT("Scenario state provider is unavailable.");
	return IUEShedScenarioStateProvider::Execute_GetScenarioStateJson(Provider);
}

FVector InterpolatedValue(const FScenarioActionClip& Clip, int32 AtMs)
{
	if (Clip.Keyframes.Num() == 0) return FVector::ZeroVector;
	const FScenarioKeyframe* Previous = &Clip.Keyframes[0];
	for (int32 Index = 1; Index < Clip.Keyframes.Num(); ++Index)
	{
		const FScenarioKeyframe& Next = Clip.Keyframes[Index];
		if (AtMs <= Next.AtMs)
		{
			const int32 Span = FMath::Max(1, Next.AtMs - Previous->AtMs);
			const float Alpha = FMath::Clamp(static_cast<float>(AtMs - Previous->AtMs)
				/ static_cast<float>(Span), 0.0f, 1.0f);
			return FMath::Lerp(Previous->Value, Next.Value, Alpha);
		}
		Previous = &Next;
	}
	return Previous->Value;
}

bool BooleanValue(const FScenarioActionClip& Clip, int32 AtMs)
{
	bool Value = false;
	for (const FScenarioKeyframe& Keyframe : Clip.Keyframes)
	{
		if (Keyframe.AtMs > AtMs) break;
		Value = Keyframe.bBoolean;
	}
	return Value;
}
}

struct FUEShedScenarioExecution::FRunState
{
	FString RunId;
	FString ScenarioId;
	FString PieSessionId;
	FString MapPath;
	TWeakObjectPtr<UWorld> World;
	double StartWorldSeconds = 0.0;
	double PausedWorldSeconds = 0.0;
	double WaitBeganWorldSeconds = 0.0;
	int32 DurationMs = 0;
	int32 EvidenceLimit = 0;
	int32 WaitAtMs = 0;
	int32 WaitTimeoutMs = 0;
	int32 ProbeAtMs = 0;
	bool bWaiting = false;
	bool bWaitHandled = false;
	bool bProbeHandled = false;
	bool bTerminal = false;
	bool bIsolationEstablished = false;
	bool bIsolationRestored = false;
	FString State = TEXT("accepted");
	TSharedPtr<FScenarioInputBlocker> InputBlocker;
	TArray<FScenarioActionClip> Actions;
	TArray<TSharedPtr<FJsonValue>> Evidence;
	TArray<TSharedPtr<FJsonValue>> Divergences;
	TArray<TSharedPtr<FJsonValue>> Lifecycle;
	TSharedPtr<FJsonObject> Result;

	int32 ScenarioTimeMs() const
	{
		const UWorld* CurrentWorld = World.Get();
		if (CurrentWorld == nullptr) return 0;
		const double ActiveSeconds = CurrentWorld->GetTimeSeconds() - StartWorldSeconds
			- PausedWorldSeconds - (bWaiting ? CurrentWorld->GetTimeSeconds() - WaitBeganWorldSeconds : 0.0);
		return FMath::Max(0, FMath::RoundToInt(ActiveSeconds * 1000.0));
	}

	void AddLifecycle(const FString& NewState)
	{
		State = NewState;
		const TSharedRef<FJsonObject> Event = MakeShared<FJsonObject>();
		Event->SetStringField(TEXT("state"), NewState);
		Event->SetNumberField(TEXT("atGameTimeMs"), ScenarioTimeMs());
		Lifecycle.Add(MakeShared<FJsonValueObject>(Event));
	}

	void AddEvidence(const FString& Id, const FString& MarkerId, int32 AtMs,
		const FString& Label, const FString& Summary, const FString& Status)
	{
		if (Evidence.Num() >= EvidenceLimit) return;
		const TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
		Item->SetStringField(TEXT("id"), Id);
		Item->SetStringField(TEXT("markerId"), MarkerId);
		Item->SetNumberField(TEXT("atMs"), FMath::Max(0, AtMs));
		Item->SetStringField(TEXT("type"), TEXT("world_state"));
		Item->SetStringField(TEXT("label"), Label);
		Item->SetStringField(TEXT("summary"), Summary);
		Item->SetStringField(TEXT("status"), Status);
		Evidence.Add(MakeShared<FJsonValueObject>(Item));
	}
};

void FUEShedScenarioExecution::Startup()
{
	TickHandle = FWorldDelegates::OnWorldTickStart.AddRaw(this, &FUEShedScenarioExecution::Tick);
	EndPieHandle = FEditorDelegates::EndPIE.AddRaw(this, &FUEShedScenarioExecution::OnEndPie);
}

void FUEShedScenarioExecution::Shutdown()
{
	if (Run.IsValid() && !Run->bTerminal)
	{
		Finish(TEXT("cancelled"), TEXT("module_shutdown"),
			TEXT("The scenario capability shut down during execution."),
			TEXT("Restart the editor and execute the scenario again."));
	}
	RestoreIsolation();
	if (TickHandle.IsValid()) FWorldDelegates::OnWorldTickStart.Remove(TickHandle);
	if (EndPieHandle.IsValid()) FEditorDelegates::EndPIE.Remove(EndPieHandle);
	TickHandle.Reset();
	EndPieHandle.Reset();
}

void FUEShedScenarioExecution::Prepare(const FString& ScenarioId, const FString& MapPath,
	FString& ResultJson)
{
	const FUEShedScenarioRegistration* Registration =
		IUEShedScenariosModule::Get().FindScenario(FName(*ScenarioId));
	if (Registration == nullptr || Registration->MapPath != MapPath)
	{
		Serialize(Rejected(TEXT("unsupported_scenario"),
			TEXT("The requested scenario and map are not registered by this producer."),
			TEXT("Use the advertised generic Movement Gym fixture.")), ResultJson);
		return;
	}
	if (GEditor == nullptr)
	{
		Serialize(Rejected(TEXT("editor_unavailable"), TEXT("The Unreal Editor is unavailable."),
			TEXT("Run the scenario against an interactive Unreal Editor.")), ResultJson);
		return;
	}
	UWorld* CurrentWorld = GEditor->PlayWorld != nullptr
		? GEditor->PlayWorld.Get() : GEditor->GetEditorWorldContext().World();
	const FString CurrentMap = CurrentWorld == nullptr ? FString()
		: UWorld::RemovePIEPrefix(CurrentWorld->GetOutermost()->GetName());
	if (GEditor->PlayWorld != nullptr && CurrentMap != MapPath)
	{
		Serialize(Rejected(TEXT("pie_active_wrong_world"),
			TEXT("PIE is already running a different world."),
			TEXT("Stop PIE so the registered scenario map can be loaded.")), ResultJson);
		return;
	}
	if (GEditor->PlayWorld == nullptr && CurrentMap != MapPath)
	{
		if (CurrentWorld != nullptr && CurrentWorld->GetOutermost()->IsDirty())
		{
			Serialize(Rejected(TEXT("dirty_editor_world"),
				TEXT("The current editor world has unsaved changes."),
				TEXT("Save or discard the current map changes before running the scenario.")), ResultJson);
			return;
		}
		const FString Filename = FPackageName::LongPackageNameToFilename(
			MapPath, FPackageName::GetMapPackageExtension());
		if (!FEditorFileUtils::LoadMap(Filename, false, false))
		{
			Serialize(Rejected(TEXT("map_load_failed"),
				TEXT("The registered scenario map could not be loaded."),
				TEXT("Regenerate the fixture and retry.")), ResultJson);
			return;
		}
	}
	const TSharedRef<FJsonObject> Prepared = MakeShared<FJsonObject>();
	Prepared->SetStringField(TEXT("_tag"), TEXT("Prepared"));
	Prepared->SetObjectField(TEXT("contract"), ContractJson());
	Prepared->SetStringField(TEXT("mapPath"), MapPath);
	Prepared->SetStringField(TEXT("scenarioId"), ScenarioId);
	Serialize(Prepared, ResultJson);
}

void FUEShedScenarioExecution::Start(const FString& RequestJson, FString& ResultJson)
{
	if (Run.IsValid() && !Run->bTerminal)
	{
		Serialize(Rejected(TEXT("run_active"), TEXT("A scenario run is already active."),
			TEXT("Cancel or await the active run before starting another.")), ResultJson);
		return;
	}

	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !ReadContract(Root))
	{
		Serialize(Rejected(TEXT("invalid_request"), TEXT("The scenario request contract is invalid."),
			TEXT("Send a ue-shed-scenario-execution v1.0 request.")), ResultJson);
		return;
	}

	FString InjectionLayer;
	FString LiveInputPolicy;
	FString ExpectedSessionId;
	FString ScenarioId;
	FString MapPath;
	double Duration = 0;
	double EvidenceLimit = 0;
	if (!Root->TryGetStringField(TEXT("injectionLayer"), InjectionLayer)
		|| InjectionLayer != TEXT("pre_evaluation")
		|| !Root->TryGetStringField(TEXT("liveInputPolicy"), LiveInputPolicy)
		|| LiveInputPolicy != TEXT("isolated")
		|| !Root->TryGetStringField(TEXT("expectedPieSessionId"), ExpectedSessionId)
		|| !Root->TryGetStringField(TEXT("scenarioId"), ScenarioId)
		|| !Root->TryGetStringField(TEXT("mapPath"), MapPath)
		|| !Root->TryGetNumberField(TEXT("durationMs"), Duration)
		|| !Root->TryGetNumberField(TEXT("evidenceLimit"), EvidenceLimit)
		|| Duration < 1 || Duration > MaxDurationMs || EvidenceLimit < 1
		|| EvidenceLimit > MaxEvidence)
	{
		Serialize(Rejected(TEXT("unsupported_request"),
			TEXT("Only bounded, isolated pre-evaluation execution is supported."),
			TEXT("Use the shipped Movement Gym execution request and advertised limits.")), ResultJson);
		return;
	}
	const FUEShedScenarioRegistration* ScenarioRegistration =
		IUEShedScenariosModule::Get().FindScenario(FName(*ScenarioId));
	if (ScenarioRegistration == nullptr || ScenarioRegistration->MapPath != MapPath)
	{
		Serialize(Rejected(TEXT("unsupported_scenario"),
			TEXT("The requested scenario and map are not registered by this producer."),
			TEXT("Use the advertised generic Movement Gym fixture.")), ResultJson);
		return;
	}

	if (GEditor == nullptr || GEditor->PlayWorld == nullptr || GEditor->IsSimulatingInEditor())
	{
		Serialize(Rejected(TEXT("pie_unavailable"), TEXT("A Play In Editor world is not running."),
			TEXT("Start PIE in play mode for the requested map, then retry.")), ResultJson);
		return;
	}
	UWorld* World = GEditor->PlayWorld;
	FString ActiveSessionId;
	if (!UUEShedEditorPlaySessionLibrary::GetActiveSessionId(ActiveSessionId)
		|| ActiveSessionId != ExpectedSessionId)
	{
		Serialize(Rejected(TEXT("stale_session"),
			TEXT("The requested PIE session is no longer active."),
			TEXT("Read the current editor play-session state and start a fresh run.")), ResultJson);
		return;
	}
	if (UWorld::RemovePIEPrefix(World->GetOutermost()->GetName()) != MapPath)
	{
		Serialize(Rejected(TEXT("wrong_world"), TEXT("The active PIE world does not match the scenario map."),
			TEXT("Open the Movement Gym map and start a fresh PIE session.")), ResultJson);
		return;
	}
	UGameInstance* GameInstance = World->GetGameInstance();
	if (GameInstance == nullptr || GameInstance->GetLocalPlayers().Num() != 1
		|| World->GetFirstPlayerController() == nullptr || StateProvider(World) == nullptr)
	{
		Serialize(Rejected(TEXT("fixture_unavailable"),
			TEXT("Movement Gym requires one local player and one scenario state provider."),
			TEXT("Regenerate the generic fixture and restart PIE.")), ResultJson);
		return;
	}

	const TArray<TSharedPtr<FJsonValue>>* ActionValues = nullptr;
	const TSharedPtr<FJsonObject>* Wait = nullptr;
	const TSharedPtr<FJsonObject>* Probe = nullptr;
	if (!Root->TryGetArrayField(TEXT("actions"), ActionValues) || ActionValues == nullptr
		|| ActionValues->Num() < 1 || ActionValues->Num() > MaxActions
		|| !Root->TryGetObjectField(TEXT("wait"), Wait)
		|| !Root->TryGetObjectField(TEXT("probe"), Probe))
	{
		Serialize(Rejected(TEXT("invalid_timeline"), TEXT("The live scenario timeline is invalid."),
			TEXT("Use the bounded Movement Gym action, wait, and probe tracks.")), ResultJson);
		return;
	}

	TUniquePtr<FRunState> Candidate = MakeUnique<FRunState>();
	Candidate->RunId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower);
	Candidate->ScenarioId = ScenarioId;
	Candidate->PieSessionId = ActiveSessionId;
	Candidate->MapPath = MapPath;
	Candidate->World = World;
	Candidate->StartWorldSeconds = World->GetTimeSeconds();
	Candidate->DurationMs = FMath::RoundToInt(Duration);
	Candidate->EvidenceLimit = FMath::RoundToInt(EvidenceLimit);
	double WaitAt = 0;
	double WaitTimeout = 0;
	double ProbeAt = 0;
	FString WaitCondition;
	FString ProbeCondition;
	if (!(*Wait)->TryGetNumberField(TEXT("atMs"), WaitAt)
		|| !(*Wait)->TryGetNumberField(TEXT("timeoutMs"), WaitTimeout)
		|| !(*Wait)->TryGetStringField(TEXT("condition"), WaitCondition)
		|| WaitCondition != TEXT("landing_ready")
		|| !(*Probe)->TryGetNumberField(TEXT("atMs"), ProbeAt)
		|| !(*Probe)->TryGetStringField(TEXT("condition"), ProbeCondition)
		|| ProbeCondition != TEXT("cache_open") || WaitAt < 0 || WaitTimeout < 1 || ProbeAt < 0
		|| WaitAt > Duration || ProbeAt > Duration)
	{
		Serialize(Rejected(TEXT("unsupported_condition"),
			TEXT("Only landing_ready wait and cache_open probe are supported."),
			TEXT("Use the shipped Movement Gym world-condition track.")), ResultJson);
		return;
	}
	Candidate->WaitAtMs = FMath::RoundToInt(WaitAt);
	Candidate->WaitTimeoutMs = FMath::RoundToInt(WaitTimeout);
	Candidate->ProbeAtMs = FMath::RoundToInt(ProbeAt);

	int32 KeyframeCount = 0;
	int32 MoveClipCount = 0;
	int32 JumpClipCount = 0;
	int32 InteractClipCount = 0;
	for (const TSharedPtr<FJsonValue>& ActionValue : *ActionValues)
	{
		const TSharedPtr<FJsonObject> ActionObject = ActionValue->AsObject();
		if (!ActionObject.IsValid())
		{
			Serialize(Rejected(TEXT("invalid_action"), TEXT("A scenario action is not an object."),
				TEXT("Use the shipped Movement Gym action clips.")), ResultJson);
			return;
		}
		FString ActionIdString;
		FString ActionPath;
		FString ValueType;
		const TArray<TSharedPtr<FJsonValue>>* Keyframes = nullptr;
		if (!ActionObject->TryGetStringField(TEXT("actionId"), ActionIdString)
			|| !ActionObject->TryGetStringField(TEXT("actionPath"), ActionPath)
			|| !ActionObject->TryGetStringField(TEXT("valueType"), ValueType)
			|| !ActionObject->TryGetArrayField(TEXT("keyframes"), Keyframes)
			|| Keyframes == nullptr || Keyframes->Num() < 1)
		{
			Serialize(Rejected(TEXT("invalid_action"), TEXT("A scenario action contract is invalid."),
				TEXT("Use registered action IDs, paths, value types, and keyframes.")), ResultJson);
			return;
		}
		const FName ActionId(*ActionIdString);
		const bool bSupportedActionId = ActionId == TEXT("Move")
			|| ActionId == TEXT("Jump") || ActionId == TEXT("Interact");
		const FUEShedScenarioActionRegistration* Registration =
			IUEShedScenariosModule::Get().FindAction(ActionId);
		const bool bAxis2D = ValueType == TEXT("Axis2D");
		if ((ValueType != TEXT("Axis2D") && ValueType != TEXT("Boolean"))
			|| !bSupportedActionId || Registration == nullptr
			|| Registration->PublicPath != ActionPath
			|| (bAxis2D ? EUEShedScenarioActionValueType::Axis2D
				: EUEShedScenarioActionValueType::Boolean) != Registration->ValueType)
		{
			Serialize(Rejected(TEXT("unsupported_action"),
				FString::Printf(TEXT("Action %s is not registered for this producer."), *ActionIdString),
				TEXT("Use the advertised Movement Gym Move, Jump, and Interact registry.")), ResultJson);
			return;
		}
		UInputAction* InputAction = Cast<UInputAction>(Registration->ObjectPath.TryLoad());
		if (InputAction == nullptr)
		{
			Serialize(Rejected(TEXT("action_unavailable"), TEXT("A registered action asset could not be loaded."),
				TEXT("Regenerate the fixture input assets and retry.")), ResultJson);
			return;
		}
		FScenarioActionClip& Clip = Candidate->Actions.AddDefaulted_GetRef();
		Clip.ActionId = ActionId;
		Clip.ActionPath = ActionPath;
		Clip.ValueType = Registration->ValueType;
		Clip.Action = InputAction;
		if (ActionId == TEXT("Move")) ++MoveClipCount;
		else if (ActionId == TEXT("Jump")) ++JumpClipCount;
		else if (ActionId == TEXT("Interact")) ++InteractClipCount;
		for (const TSharedPtr<FJsonValue>& KeyframeValue : *Keyframes)
		{
			const TSharedPtr<FJsonObject> KeyframeObject = KeyframeValue->AsObject();
			const TSharedPtr<FJsonObject>* InputValue = nullptr;
			double AtMs = 0;
			if (!KeyframeObject.IsValid() || !KeyframeObject->TryGetNumberField(TEXT("atMs"), AtMs)
				|| !KeyframeObject->TryGetObjectField(TEXT("value"), InputValue)
				|| AtMs < 0 || AtMs > Duration)
			{
				Serialize(Rejected(TEXT("invalid_keyframe"), TEXT("A scenario keyframe is invalid."),
					TEXT("Use non-negative game-time keyframes with typed values.")), ResultJson);
				return;
			}
			FString Tag;
			if (!(*InputValue)->TryGetStringField(TEXT("_tag"), Tag)
				|| (bAxis2D && Tag != TEXT("Axis2D")) || (!bAxis2D && Tag != TEXT("Boolean")))
			{
				Serialize(Rejected(TEXT("action_type_mismatch"),
					TEXT("A keyframe value does not match its registered action type."),
					TEXT("Use Axis2D for Move and Boolean for Jump/Interact.")), ResultJson);
				return;
			}
			FScenarioKeyframe& Keyframe = Clip.Keyframes.AddDefaulted_GetRef();
			Keyframe.AtMs = FMath::RoundToInt(AtMs);
			if (bAxis2D)
			{
				double X = 0;
				double Y = 0;
				if (!(*InputValue)->TryGetNumberField(TEXT("x"), X)
					|| !(*InputValue)->TryGetNumberField(TEXT("y"), Y)
					|| FMath::Abs(X) > 1.0 || FMath::Abs(Y) > 1.0)
				{
					Serialize(Rejected(TEXT("invalid_keyframe"), TEXT("Move requires x and y values."),
						TEXT("Use finite Axis2D Movement Gym values.")), ResultJson);
					return;
				}
				Keyframe.Value = FVector(X, Y, 0);
			}
			else if (!(*InputValue)->TryGetBoolField(TEXT("value"), Keyframe.bBoolean))
			{
				Serialize(Rejected(TEXT("invalid_keyframe"), TEXT("Boolean action value is missing."),
					TEXT("Use true/false Jump and Interact values.")), ResultJson);
				return;
			}
			++KeyframeCount;
			if (KeyframeCount > MaxKeyframes)
			{
				Serialize(Rejected(TEXT("limit_exceeded"), TEXT("The scenario has too many keyframes."),
					TEXT("Reduce the request to the advertised keyframe limit.")), ResultJson);
				return;
			}
		}
		Clip.Keyframes.Sort([](const FScenarioKeyframe& Left, const FScenarioKeyframe& Right)
		{
			return Left.AtMs < Right.AtMs;
		});
	}
	if (Candidate->Actions.Num() != 4 || MoveClipCount != 2 || JumpClipCount != 1
		|| InteractClipCount != 1 || KeyframeCount != 11)
	{
		Serialize(Rejected(TEXT("unsupported_timeline"),
			TEXT("The action schedule is not the registered Movement Gym v1 slice."),
			TEXT("Use the shipped four-clip Move, Jump, and Interact schedule.")), ResultJson);
		return;
	}

	if (!FSlateApplication::IsInitialized())
	{
		Serialize(Rejected(TEXT("isolation_unavailable"), TEXT("Slate input isolation is unavailable."),
			TEXT("Run the scenario in an interactive Unreal Editor session.")), ResultJson);
		return;
	}
	Candidate->InputBlocker = MakeShared<FScenarioInputBlocker>();
	FSlateApplication& Slate = FSlateApplication::Get();
	const bool bRegistered = Slate.RegisterInputPreProcessor(
		Candidate->InputBlocker, EInputPreProcessorType::PreGame);
	if (!bRegistered || Slate.FindInputPreProcessor(
		Candidate->InputBlocker, EInputPreProcessorType::PreGame) == INDEX_NONE)
	{
		if (bRegistered) Slate.UnregisterInputPreProcessor(Candidate->InputBlocker);
		Serialize(Rejected(TEXT("isolation_unavailable"),
			TEXT("Live-device input isolation could not be verified."),
			TEXT("Resolve conflicting Slate input preprocessors and retry.")), ResultJson);
		return;
	}
	World->GetFirstPlayerController()->FlushPressedKeys();
	Candidate->bIsolationEstablished = true;
	Candidate->AddLifecycle(TEXT("accepted"));
	Candidate->AddLifecycle(TEXT("isolating"));
	Candidate->AddLifecycle(TEXT("running"));
	Run = MoveTemp(Candidate);

	const TSharedRef<FJsonObject> Accepted = MakeShared<FJsonObject>();
	Accepted->SetStringField(TEXT("_tag"), TEXT("Accepted"));
	Accepted->SetObjectField(TEXT("contract"), ContractJson());
	Accepted->SetStringField(TEXT("pieSessionId"), Run->PieSessionId);
	Accepted->SetStringField(TEXT("runId"), Run->RunId);
	Accepted->SetStringField(TEXT("state"), TEXT("accepted"));
	Serialize(Accepted, ResultJson);
}

void FUEShedScenarioExecution::Status(const FString& RunId, FString& ResultJson)
{
	if (!Run.IsValid() || Run->RunId != RunId)
	{
		Serialize(Rejected(TEXT("run_not_found"), TEXT("The scenario run is not available in this editor."),
			TEXT("The editor may have restarted; negotiate a fresh PIE session and start again.")), ResultJson);
		return;
	}
	if (Run->bTerminal && Run->Result.IsValid())
	{
		const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("_tag"), TEXT("Terminal"));
		Root->SetObjectField(TEXT("contract"), ContractJson());
		Root->SetObjectField(TEXT("result"), Run->Result.ToSharedRef());
		Serialize(Root, ResultJson);
		return;
	}
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("_tag"), TEXT("Active"));
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetNumberField(TEXT("gameTimeMs"), Run->ScenarioTimeMs());
	Root->SetStringField(TEXT("pieSessionId"), Run->PieSessionId);
	Root->SetStringField(TEXT("runId"), Run->RunId);
	Root->SetStringField(TEXT("state"), Run->State);
	Serialize(Root, ResultJson);
}

void FUEShedScenarioExecution::Cancel(const FString& RunId, FString& ResultJson)
{
	if (!Run.IsValid() || Run->RunId != RunId)
	{
		Serialize(Rejected(TEXT("run_not_found"), TEXT("The scenario run cannot be cancelled."),
			TEXT("Read current run status before retrying cancellation.")), ResultJson);
		return;
	}
	if (!Run->bTerminal)
	{
		Run->AddLifecycle(TEXT("cancelling"));
		Finish(TEXT("cancelled"), TEXT("cancelled"), TEXT("Scenario execution was cancelled."),
			TEXT("Start a fresh run when ready."));
	}
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("_tag"), TEXT("Accepted"));
	Root->SetObjectField(TEXT("contract"), ContractJson());
	Root->SetStringField(TEXT("runId"), Run->RunId);
	Serialize(Root, ResultJson);
}

void FUEShedScenarioExecution::Tick(UWorld* World, ELevelTick, float)
{
	if (!Run.IsValid() || Run->bTerminal || World != Run->World.Get()) return;
	FString ActiveSessionId;
	if (GEditor == nullptr || GEditor->PlayWorld != World
		|| !UUEShedEditorPlaySessionLibrary::GetActiveSessionId(ActiveSessionId)
		|| ActiveSessionId != Run->PieSessionId)
	{
		Finish(TEXT("failed"), TEXT("stale_session"),
			TEXT("The bound PIE session or world was replaced during execution."),
			TEXT("Start a fresh run against the current PIE session."));
		return;
	}

	if (Run->bWaiting)
	{
		if (Condition(World, TEXT("landing_ready")))
		{
			const double WaitSeconds = World->GetTimeSeconds() - Run->WaitBeganWorldSeconds;
			Run->PausedWorldSeconds += WaitSeconds;
			Run->bWaiting = false;
			Run->bWaitHandled = true;
			Run->AddEvidence(TEXT("evidence_landing_ready"), TEXT("wait_landing_ready"),
				Run->WaitAtMs, TEXT("Landing ready"), StateSummary(World), TEXT("captured"));
			if (WaitSeconds > 0.1)
			{
				const TSharedRef<FJsonObject> Divergence = MakeShared<FJsonObject>();
				Divergence->SetStringField(TEXT("id"), TEXT("divergence_landing_wait"));
				Divergence->SetNumberField(TEXT("atMs"), Run->WaitAtMs);
				Divergence->SetStringField(TEXT("severity"), TEXT("info"));
				Divergence->SetStringField(TEXT("source"), TEXT("timing"));
				Divergence->SetStringField(TEXT("expected"), TEXT("Landing ready at authored wait time"));
				Divergence->SetStringField(TEXT("observed"),
					FString::Printf(TEXT("Waited %.0f ms of game time"), WaitSeconds * 1000.0));
				Divergence->SetStringField(TEXT("explanation"),
					TEXT("Scenario time paused while the world condition became ready."));
				Run->Divergences.Add(MakeShared<FJsonValueObject>(Divergence));
			}
			Run->AddLifecycle(TEXT("running"));
		}
		else if ((World->GetTimeSeconds() - Run->WaitBeganWorldSeconds) * 1000.0
			> Run->WaitTimeoutMs)
		{
			Run->AddEvidence(TEXT("evidence_landing_missing"), TEXT("wait_landing_ready"),
				Run->WaitAtMs, TEXT("Landing ready"), StateSummary(World), TEXT("missing"));
			Finish(TEXT("failed"), TEXT("wait_timeout"),
				TEXT("landing_ready did not resolve before its game-time timeout."),
				TEXT("Inspect Movement Gym pawn movement and fixture state, then retry."));
		}
		return;
	}

	const int32 ScenarioTime = Run->ScenarioTimeMs();
	if (!Run->bWaitHandled && ScenarioTime >= Run->WaitAtMs)
	{
		if (!Condition(World, TEXT("landing_ready")))
		{
			Run->bWaiting = true;
			Run->WaitBeganWorldSeconds = World->GetTimeSeconds();
			Run->AddLifecycle(TEXT("waiting"));
			return;
		}
		Run->bWaitHandled = true;
		Run->AddEvidence(TEXT("evidence_landing_ready"), TEXT("wait_landing_ready"),
			Run->WaitAtMs, TEXT("Landing ready"), StateSummary(World), TEXT("captured"));
	}

	ULocalPlayer* LocalPlayer = World->GetFirstLocalPlayerFromController();
	UEnhancedInputLocalPlayerSubsystem* InputSubsystem = LocalPlayer == nullptr ? nullptr
		: LocalPlayer->GetSubsystem<UEnhancedInputLocalPlayerSubsystem>();
	if (InputSubsystem == nullptr)
	{
		Finish(TEXT("failed"), TEXT("input_unavailable"),
			TEXT("The selected local player's Enhanced Input subsystem is unavailable."),
			TEXT("Use the fixture Enhanced Player Input configuration and restart PIE."));
		return;
	}
	for (FScenarioActionClip& Clip : Run->Actions)
	{
		if (Clip.Keyframes.Num() == 0 || ScenarioTime < Clip.Keyframes[0].AtMs
			|| ScenarioTime > Clip.Keyframes.Last().AtMs) continue;
		if (Clip.ValueType == EUEShedScenarioActionValueType::Axis2D)
		{
			const FVector Value = InterpolatedValue(Clip, ScenarioTime);
			InputSubsystem->InjectInputForAction(Clip.Action,
				FInputActionValue(FVector2D(Value.X, Value.Y)), {}, {});
		}
		else
		{
			InputSubsystem->InjectInputForAction(Clip.Action,
				FInputActionValue(BooleanValue(Clip, ScenarioTime)), {}, {});
		}
		++Clip.InjectedFrames;
	}

	if (!Run->bProbeHandled && ScenarioTime >= Run->ProbeAtMs)
	{
		Run->bProbeHandled = true;
		const bool bCaptured = Condition(World, TEXT("cache_open"));
		Run->AddEvidence(TEXT("evidence_cache_open"), TEXT("probe_cache_open"), Run->ProbeAtMs,
			TEXT("Cache open"), StateSummary(World), bCaptured ? TEXT("captured") : TEXT("missing"));
		if (!bCaptured)
		{
			const TSharedRef<FJsonObject> Divergence = MakeShared<FJsonObject>();
			Divergence->SetStringField(TEXT("id"), TEXT("divergence_cache_not_open"));
			Divergence->SetNumberField(TEXT("atMs"), Run->ProbeAtMs);
			Divergence->SetStringField(TEXT("severity"), TEXT("warning"));
			Divergence->SetStringField(TEXT("source"), TEXT("unknown"));
			Divergence->SetStringField(TEXT("expected"), TEXT("cache_open was true"));
			Divergence->SetStringField(TEXT("observed"), TEXT("cache_open was false"));
			Divergence->SetStringField(TEXT("explanation"),
				TEXT("The world-state probe retained explicit missing evidence."));
			Run->Divergences.Add(MakeShared<FJsonValueObject>(Divergence));
		}
	}
	if (ScenarioTime >= Run->DurationMs)
	{
		Finish(Run->Divergences.Num() > 0 ? TEXT("completed_with_divergence") : TEXT("completed"));
	}
}

void FUEShedScenarioExecution::OnEndPie(bool)
{
	if (Run.IsValid() && !Run->bTerminal)
	{
		Finish(TEXT("failed"), TEXT("stale_session"),
			TEXT("PIE ended before the scenario reached a terminal result."),
			TEXT("Start a fresh PIE session and rerun the scenario."));
	}
}

void FUEShedScenarioExecution::Finish(const FString& Status, const FString& FailureCode,
	const FString& Message, const FString& Recovery)
{
	if (!Run.IsValid() || Run->bTerminal) return;
	const int32 AtMs = FMath::Max(1, Run->ScenarioTimeMs());
	const FString FailureAtState = Run->State;
	if (Run->Evidence.Num() < Run->EvidenceLimit && Run->World.IsValid())
	{
		Run->AddEvidence(TEXT("evidence_final_state"), TEXT("scenario_final_state"), AtMs,
			TEXT("Final world state"), StateSummary(Run->World.Get()), TEXT("captured"));
	}
	const bool bIsolationRestored = RestoreIsolation();
	Run->AddLifecycle(TEXT("terminal"));
	Run->bTerminal = true;
	const FString FinalStatus = bIsolationRestored ? Status : TEXT("failed");
	const FString FinalFailureCode = bIsolationRestored
		? FailureCode : TEXT("isolation_restore_failed");
	const FString FinalMessage = bIsolationRestored
		? Message : TEXT("Live-device input isolation could not be removed.");
	const FString FinalRecovery = bIsolationRestored
		? Recovery : TEXT("Stop PIE or restart the editor before accepting live input again.");

	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("schemaVersion"), 1);
	Result->SetStringField(TEXT("id"), Run->RunId);
	Result->SetStringField(TEXT("scenarioId"), Run->ScenarioId);
	Result->SetStringField(TEXT("label"), TEXT("Movement Gym live PIE run"));
	Result->SetStringField(TEXT("status"), FinalStatus);
	Result->SetStringField(TEXT("recordedAt"), FDateTime::UtcNow().ToIso8601());
	Result->SetNumberField(TEXT("durationMs"), AtMs);
	Result->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
	Result->SetStringField(TEXT("world"), Run->MapPath);
	Result->SetStringField(TEXT("pieSessionId"), Run->PieSessionId);
	Result->SetArrayField(TEXT("evidence"), Run->Evidence);
	Result->SetArrayField(TEXT("divergences"), Run->Divergences);
	Result->SetArrayField(TEXT("lifecycle"), Run->Lifecycle);
	const TSharedRef<FJsonObject> Isolation = MakeShared<FJsonObject>();
	Isolation->SetBoolField(TEXT("established"), Run->bIsolationEstablished);
	Isolation->SetBoolField(TEXT("restored"), Run->bIsolationRestored);
	Isolation->SetStringField(TEXT("method"), TEXT("slate_input_preprocessor"));
	Result->SetObjectField(TEXT("inputIsolation"), Isolation);
	if (!FinalFailureCode.IsEmpty())
	{
		const TSharedRef<FJsonObject> Failure = MakeShared<FJsonObject>();
		Failure->SetStringField(TEXT("code"), FinalFailureCode);
		Failure->SetStringField(TEXT("message"), FinalMessage);
		Failure->SetStringField(TEXT("recovery"), FinalRecovery);
		Failure->SetStringField(TEXT("atState"), FailureAtState);
		Result->SetObjectField(TEXT("failure"), Failure);
	}
	Run->Result = Result;
}

bool FUEShedScenarioExecution::RestoreIsolation()
{
	if (!Run.IsValid() || !Run->InputBlocker.IsValid()) return true;
	if (!FSlateApplication::IsInitialized())
	{
		Run->bIsolationRestored = true;
		Run->InputBlocker.Reset();
		return true;
	}
	FSlateApplication& Slate = FSlateApplication::Get();
	Slate.UnregisterInputPreProcessor(Run->InputBlocker);
	Run->bIsolationRestored = Slate.FindInputPreProcessor(
		Run->InputBlocker, EInputPreProcessorType::PreGame) == INDEX_NONE;
	if (Run->bIsolationRestored) Run->InputBlocker.Reset();
	return Run->bIsolationRestored;
}

FUEShedScenarioExecution& GetUEShedScenarioExecution()
{
	static FUEShedScenarioExecution Instance;
	return Instance;
}
