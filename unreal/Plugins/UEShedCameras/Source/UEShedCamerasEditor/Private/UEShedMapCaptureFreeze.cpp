#include "UEShedMapCaptureFreeze.h"

#include "Components/ActorComponent.h"
#include "Containers/Ticker.h"
#include "Editor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "HAL/IConsoleManager.h"
#include "SceneView.h"
#include "SceneViewExtension.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Components/SceneComponent.h"
#include "Misc/AutomationTest.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogUEShedMapCaptureFreeze, Log, All);

namespace
{
// A world-scoped extension also holds the editor view at the same instant. It does not
// alter FApp time, engine frame counters, exposure, or other worlds' render families.
class FFrozenMapView final : public FWorldSceneViewExtension
{
public:
	FFrozenMapView(const FAutoRegister& AutoRegister, UWorld* World)
		: FWorldSceneViewExtension(AutoRegister, World), Time(World->GetTime())
	{
	}

	virtual void SetupViewFamily(FSceneViewFamily& Family) override
	{
		// Preserve render deltas so temporal rendering can continue at a fixed scene instant.
		Family.Time = FGameTime::CreateDilated(
			Time.GetRealTimeSeconds(), Family.Time.GetDeltaRealTimeSeconds(),
			Time.GetWorldTimeSeconds(), Family.Time.GetDeltaWorldTimeSeconds());
	}

	const FGameTime Time;
};

struct FFrozenMapScene
{
	explicit FFrozenMapScene(UWorld* InWorld, bool bSuspendTicks)
		: World(InWorld), StartedSeconds(FPlatformTime::Seconds())
		, LastActivitySeconds(StartedSeconds)
	{
		View = FSceneViewExtensions::NewExtension<FFrozenMapView>(InWorld);
		if (bSuspendTicks)
		{
			for (TActorIterator<AActor> It(InWorld); It; ++It)
			{
				if (It->IsActorTickEnabled())
				{
					Actors.Add(*It);
					It->SetActorTickEnabled(false);
				}
				TInlineComponentArray<UActorComponent*> ActorComponents(*It);
				for (UActorComponent* Component : ActorComponents)
				{
					if (Component->IsComponentTickEnabled())
					{
						Components.Add(Component);
						Component->SetComponentTickEnabled(false);
					}
				}
			}
		}
		UE_LOG(LogUEShedMapCaptureFreeze, Display,
			TEXT("freeze.begin world=%s mode=%s actors=%d components=%d realTime=%.6f worldTime=%.6f leaseSeconds=600"),
			*InWorld->GetPathName(), bSuspendTicks ? TEXT("scene") : TEXT("time"),
			Actors.Num(), Components.Num(), View->Time.GetRealTimeSeconds(),
			View->Time.GetWorldTimeSeconds());
	}

	~FFrozenMapScene()
	{
		View.Reset();
		for (const TWeakObjectPtr<AActor>& Actor : Actors)
		{
			if (Actor.IsValid()) Actor->SetActorTickEnabled(true);
		}
		for (const TWeakObjectPtr<UActorComponent>& Component : Components)
		{
			if (Component.IsValid()) Component->SetComponentTickEnabled(true);
		}
		UE_LOG(LogUEShedMapCaptureFreeze, Display,
			TEXT("freeze.end actors=%d components=%d elapsedSeconds=%.3f"),
			Actors.Num(), Components.Num(), FPlatformTime::Seconds() - StartedSeconds);
	}

	TWeakObjectPtr<UWorld> World;
	double StartedSeconds;
	double LastActivitySeconds;
	TSharedPtr<FFrozenMapView, ESPMode::ThreadSafe> View;
	TArray<TWeakObjectPtr<AActor>> Actors;
	TArray<TWeakObjectPtr<UActorComponent>> Components;
};

TUniquePtr<FFrozenMapScene> FrozenScene;
FString FreezeOwner;
IConsoleObject* FreezeCommand = nullptr;
IConsoleObject* ResumeCommand = nullptr;
IConsoleObject* KeepAliveCommand = nullptr;
FDelegateHandle CleanupHandle;
FDelegateHandle BeginPIEHandle;
FTSTicker::FDelegateHandle WatchdogHandle;

void Resume()
{
	FrozenScene.Reset();
	FreezeOwner.Reset();
}

void KeepFreezeAlive()
{
	if (FrozenScene && FrozenScene->World.IsValid())
	{
		FrozenScene->LastActivitySeconds = FPlatformTime::Seconds();
		UE_LOG(LogUEShedMapCaptureFreeze, Display,
			TEXT("freeze.renew elapsedSeconds=%.3f"),
			FrozenScene->LastActivitySeconds - FrozenScene->StartedSeconds);
	}
	else
	{
		UE_LOG(LogUEShedMapCaptureFreeze, Warning, TEXT("freeze.renew_rejected reason=no_session"));
	}
}

void FreezeMapScene(const TArray<FString>& Arguments)
{
	if (Arguments.Num() != 1
		|| (Arguments[0] != TEXT("time") && Arguments[0] != TEXT("scene")))
	{
		UE_LOG(LogUEShedMapCaptureFreeze, Warning,
			TEXT("Use UEShed.MapCapture.Freeze time|scene, then UEShed.MapCapture.Resume."));
		return;
	}
	if (GEditor == nullptr || GEditor->PlayWorld != nullptr
		|| GEditor->GetEditorWorldContext().World() == nullptr)
	{
		UE_LOG(LogUEShedMapCaptureFreeze, Warning, TEXT("freeze.rejected reason=editor_world_required"));
		return;
	}
	if (FrozenScene)
	{
		UE_LOG(LogUEShedMapCaptureFreeze, Warning, TEXT("freeze.rejected reason=already_frozen"));
		return;
	}
	FrozenScene = MakeUnique<FFrozenMapScene>(
		GEditor->GetEditorWorldContext().World(), Arguments[0] == TEXT("scene"));
}
}

bool BeginUEShedOwnedMapFreeze(UWorld* World, const FString& Owner)
{
	if (FrozenScene || !World || Owner.IsEmpty()) return false;
	FrozenScene = MakeUnique<FFrozenMapScene>(World, true);
	FreezeOwner = Owner;
	return true;
}

bool RenewUEShedOwnedMapFreeze(const FString& Owner)
{
	if (!FrozenScene || FreezeOwner != Owner || !FrozenScene->World.IsValid()) return false;
	FrozenScene->LastActivitySeconds = FPlatformTime::Seconds();
	return true;
}

void EndUEShedOwnedMapFreeze(const FString& Owner)
{
	if (FreezeOwner == Owner) Resume();
}

void RegisterUEShedMapCaptureFreeze()
{
	FreezeCommand = IConsoleManager::Get().RegisterConsoleCommand(
		TEXT("UEShed.MapCapture.Freeze"),
		TEXT("Experimental editor freeze: time holds material clocks; scene also suspends existing primary actor/component ticks. Resume explicitly after capture. Expires after 600 seconds without KeepAlive. Custom tickers and particle managers are not suspended."),
		FConsoleCommandWithArgsDelegate::CreateStatic(&FreezeMapScene), ECVF_Default);
	ResumeCommand = IConsoleManager::Get().RegisterConsoleCommand(
		TEXT("UEShed.MapCapture.Resume"), TEXT("Restore the state held by UEShed.MapCapture.Freeze."),
		FConsoleCommandDelegate::CreateStatic(&Resume), ECVF_Default);
	KeepAliveCommand = IConsoleManager::Get().RegisterConsoleCommand(
		TEXT("UEShed.MapCapture.KeepAlive"),
		TEXT("Renew the active freeze's 600-second lease without changing its scene timestamps or tick snapshot."),
		FConsoleCommandDelegate::CreateStatic(&KeepFreezeAlive), ECVF_Default);
	CleanupHandle = FWorldDelegates::OnWorldCleanup.AddLambda(
		[](UWorld* World, bool, bool)
		{
			if (FrozenScene && FrozenScene->World.Get() == World) Resume();
		});
	BeginPIEHandle = FEditorDelegates::PreBeginPIE.AddLambda([](bool) { Resume(); });
	WatchdogHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda(
		[](float)
		{
			if (FrozenScene && (!FrozenScene->World.IsValid()
				|| FPlatformTime::Seconds() - FrozenScene->LastActivitySeconds >= 600.0))
			{
				UE_LOG(LogUEShedMapCaptureFreeze, Warning, TEXT("freeze.expired"));
				Resume();
			}
			return true;
		}), 1.0f);
}

void UnregisterUEShedMapCaptureFreeze()
{
	FTSTicker::GetCoreTicker().RemoveTicker(WatchdogHandle);
	FWorldDelegates::OnWorldCleanup.Remove(CleanupHandle);
	FEditorDelegates::PreBeginPIE.Remove(BeginPIEHandle);
	Resume();
	IConsoleManager::Get().UnregisterConsoleObject(FreezeCommand);
	IConsoleManager::Get().UnregisterConsoleObject(ResumeCommand);
	IConsoleManager::Get().UnregisterConsoleObject(KeepAliveCommand);
}

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedMapFreezeStateTest,
	"UEShed.Cameras.MapCapture.FreezeState",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedMapFreezeStateTest::RunTest(const FString& Parameters)
{
	UWorld* World = UWorld::CreateWorld(EWorldType::EditorPreview, false);
	UWorld* OtherWorld = UWorld::CreateWorld(EWorldType::EditorPreview, false);
	AActor* Actor = World->SpawnActor<AActor>();
	Actor->PrimaryActorTick.bCanEverTick = true;
	Actor->SetActorTickEnabled(true);
	UActorComponent* Enabled = NewObject<USceneComponent>(Actor);
	UActorComponent* Disabled = NewObject<USceneComponent>(Actor);
	for (UActorComponent* Component : { Enabled, Disabled })
	{
		Component->PrimaryComponentTick.bCanEverTick = true;
		Component->RegisterComponent();
	}
	Enabled->SetComponentTickEnabled(true);
	Disabled->SetComponentTickEnabled(false);
	{
		FFrozenMapScene FreezeState(World, true);
		TestFalse(TEXT("Actor suspended"), Actor->IsActorTickEnabled());
		TestFalse(TEXT("Enabled component suspended"), Enabled->IsComponentTickEnabled());
		TestFalse(TEXT("Disabled component stays disabled"), Disabled->IsComponentTickEnabled());
		TestTrue(TEXT("Extension applies to target world"),
			FreezeState.View->IsActiveThisFrame(FSceneViewExtensionContext(World->Scene)));
		TestFalse(TEXT("Extension excludes another world"),
			FreezeState.View->IsActiveThisFrame(FSceneViewExtensionContext(OtherWorld->Scene)));
		FSceneViewFamily Family(FSceneViewFamily::ConstructionValues(
			nullptr, World->Scene, FEngineShowFlags(ESFIM_Game)));
		Family.Time = FGameTime::CreateDilated(200.0, 0.02f, 100.0, 0.01f);
		FreezeState.View->SetupViewFamily(Family);
		TestEqual(TEXT("Frozen real time"), Family.Time.GetRealTimeSeconds(),
			FreezeState.View->Time.GetRealTimeSeconds());
		TestEqual(TEXT("Frozen world time"), Family.Time.GetWorldTimeSeconds(),
			FreezeState.View->Time.GetWorldTimeSeconds());
		TestEqual(TEXT("Render delta continues"), Family.Time.GetDeltaRealTimeSeconds(), 0.02f);
	}
	TestTrue(TEXT("Actor restored"), Actor->IsActorTickEnabled());
	TestTrue(TEXT("Enabled component restored"), Enabled->IsComponentTickEnabled());
	TestFalse(TEXT("Originally disabled component preserved"), Disabled->IsComponentTickEnabled());
	{
		FFrozenMapScene TimeOnly(World, false);
		TestTrue(TEXT("Time-only mode leaves actor ticking"), Actor->IsActorTickEnabled());
		TestTrue(TEXT("Time-only mode leaves component ticking"), Enabled->IsComponentTickEnabled());
	}
	World->DestroyWorld(false);
	OtherWorld->DestroyWorld(false);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedMapFreezeOwnershipTest,
	"UEShed.Cameras.MapCapture.FreezeOwnership",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedMapFreezeOwnershipTest::RunTest(const FString& Parameters)
{
	UWorld* World = UWorld::CreateWorld(EWorldType::EditorPreview, false);
	AActor* Actor = World->SpawnActor<AActor>();
	Actor->PrimaryActorTick.bCanEverTick = true; Actor->SetActorTickEnabled(true);
	TestTrue(TEXT("Run acquires freeze"), BeginUEShedOwnedMapFreeze(World, TEXT("owner")));
	TestFalse(TEXT("Concurrent owner rejected"), BeginUEShedOwnedMapFreeze(World, TEXT("other")));
	EndUEShedOwnedMapFreeze(TEXT("other"));
	TestFalse(TEXT("Other owner cannot resume actor"), Actor->IsActorTickEnabled());
	TestFalse(TEXT("Other owner cannot renew"), RenewUEShedOwnedMapFreeze(TEXT("other")));
	TestTrue(TEXT("Owner renews original snapshot"), RenewUEShedOwnedMapFreeze(TEXT("owner")));
	EndUEShedOwnedMapFreeze(TEXT("owner"));
	TestTrue(TEXT("Owner restores actor tick"), Actor->IsActorTickEnabled());
	World->DestroyWorld(false);
	return true;
}
#endif
