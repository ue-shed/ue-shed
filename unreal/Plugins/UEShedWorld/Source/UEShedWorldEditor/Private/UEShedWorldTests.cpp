#if WITH_DEV_AUTOMATION_TESTS
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/StaticMeshActor.h"
#include "FileHelpers.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedWorldLibrary.h"
#include "UEShedWorldPreparation.h"
#include "UEShedWorldPreparationTest.h"
#include "WorldPartition/ActorDescContainerInstance.h"
#include "WorldPartition/WorldPartition.h"
#include "WorldPartition/WorldPartitionActorDescInstance.h"
#include "WorldPartition/WorldPartitionHandle.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedWorldPreparationTest, "UEShed.World.Preparation",
								 EAutomationTestFlags::EditorContext |
									 EAutomationTestFlags::EngineFilter)

bool FUEShedWorldPreparationTest::RunTest(const FString &Parameters)
{
	using FJson = TSharedPtr<FJsonObject>;
	auto Object = []() { return MakeShared<FJsonObject>(); };
	FString FixtureDirectory;
	if (!FParse::Value(FCommandLine::Get(), TEXT("UEShedWorldContractFixtures="), FixtureDirectory))
	{
		AddError(TEXT("Supply authoritative world contract fixtures."));
		return false;
	}
	TArray<FString> Fixtures;
	IFileManager::Get().FindFiles(Fixtures, *FPaths::Combine(FixtureDirectory, TEXT("*.json")),
								  true, false);
	TestEqual(TEXT("Authoritative fixture count"), Fixtures.Num(), 6);
	for (const auto &File : Fixtures)
	{
		FString Input, Output;
		FFileHelper::LoadFileToString(Input, *FPaths::Combine(FixtureDirectory, File));
		UUEShedWorldLibrary::ExecuteWorldPreparation(Input, Output);
		FJson Result;
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Output), Result);
		FString Code;
		if (Result)
			Result->TryGetStringField(TEXT("code"), Code);
		TestEqual(*File, Code == TEXT("invalid_request"), File.StartsWith(TEXT("invalid-")));
	}
	if (!GEditor || !GEditor->GetEditorWorldContext().World() || GEditor->PlayWorld)
		return false;
	const FString Previous = GEditor->GetEditorWorldContext().World()->GetOutermost()->GetName();
	if (GEditor->GetEditorWorldContext().World()->GetOutermost()->IsDirty())
	{
		AddError(TEXT("Run in a clean disposable automation project."));
		return false;
	}
	ON_SCOPE_EXIT
	{
		UEditorLoadingAndSavingUtils::LoadMap(Previous);
	};
	UWorld *World = GEditor->NewMap(true);
	if (!World || !World->GetWorldPartition())
		return false;
	World->GetWorldPartition()->SetEnableStreaming(true);
	const FString Map =
		TEXT("/Game/WorldPreparationFixture/L_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
	if (!UEditorLoadingAndSavingUtils::SaveMap(World, Map))
		return false;
	TArray<UPackage *> Packages;
	TArray<AStaticMeshActor *> FixtureActors;
	for (int32 Index = 0; Index < 4; ++Index)
	{
		FActorSpawnParameters Spawn;
		Spawn.bCreateActorPackage = true;
		auto *Actor = World->SpawnActor<AStaticMeshActor>(FVector(Index == 3   ? 50000
																  : Index == 2 ? 100000
																			   : Index * 3000,
																  0, 100),
														  FRotator::ZeroRotator, Spawn);
		Actor->SetActorLabel(Index == 0	  ? TEXT("ContextSubject")
							 : Index == 1 ? TEXT("ContextNeighbor")
							 : Index == 2 ? TEXT("DistantActor")
										  : TEXT("DependencyParent"));
		Actor->GetStaticMeshComponent()->SetStaticMesh(
			LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube")));
		Packages.Add(Actor->GetExternalPackage());
		FixtureActors.Add(Actor);
	}
	FixtureActors[0]->AttachToActor(FixtureActors[3],
									FAttachmentTransformRules::KeepWorldTransform);
	Packages.Add(World->GetOutermost());
	if (!UEditorLoadingAndSavingUtils::SavePackages(Packages, false))
		return false;
	GEditor->NewMap();
	World = UEditorLoadingAndSavingUtils::LoadMap(Map);
	if (!World)
		return false;
	auto Identity = FUEShedWorldPreparation::Describe();
	TestTrue(TEXT("Fixture has streaming enabled"),
			 Identity->GetBoolField(TEXT("streamingEnabled")));
	auto Contract = Object(), Version = Object();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-world-preparation"));
	Contract->SetObjectField(TEXT("version"), Version);
	auto Request = [&](const TCHAR *Action, const FString &Id = TEXT("first")) {
		auto O = Object();
		O->SetObjectField(TEXT("contract"), Contract);
		O->SetStringField(TEXT("action"), Action);
		if (FString(Action) != TEXT("plan"))
			O->SetStringField(TEXT("leaseId"), Id);
		if (FString(Action) == TEXT("release") || FString(Action) == TEXT("poll") ||
			FString(Action) == TEXT("replace"))
			O->SetStringField(TEXT("worldId"), Identity->GetStringField(TEXT("worldId")));
		return O;
	};
	auto Vector = [&](double X, double Y, double Z) {
		auto O = Object();
		O->SetNumberField(TEXT("x"), X);
		O->SetNumberField(TEXT("y"), Y);
		O->SetNumberField(TEXT("z"), Z);
		return O;
	};
	auto Requirements = Object(), Target = Object(), Region = Object();
	Region->SetObjectField(TEXT("center"), Vector(0, 0, 100));
	Region->SetObjectField(TEXT("extent"), Vector(5000, 5000, 1000));
	Target->SetStringField(TEXT("kind"), TEXT("region"));
	Target->SetObjectField(TEXT("region"), Region);
	Requirements->SetObjectField(TEXT("world"), Identity);
	Requirements->SetNumberField(TEXT("maximumActors"), 100);
	Requirements->SetArrayField(TEXT("targets"), {MakeShared<FJsonValueObject>(Target)});
	Requirements->SetArrayField(TEXT("dataLayers"), {});
	auto Plan = Request(TEXT("plan"));
	Plan->SetObjectField(TEXT("requirements"), Requirements);
	auto Planned = FUEShedWorldPreparation::Execute(Plan);
	if (!TestEqual(TEXT("Plan succeeds"), Planned->GetStringField(TEXT("status")),
				   FString(TEXT("planned"))))
		return false;
	FJson Subject;
	for (const auto &V : Planned->GetArrayField(TEXT("actors")))
	{
		auto A = V->AsObject();
		if (A->GetStringField(TEXT("label")) == TEXT("ContextSubject"))
			Subject = A;
		TestNotEqual(TEXT("Distant actor excluded"), A->GetStringField(TEXT("label")),
					 FString(TEXT("DistantActor")));
	}
	if (!TestTrue(TEXT("Unloaded actor discoverable by bounds"), Subject.IsValid()))
		return false;
	TestFalse(TEXT("Plan does not load subject"), Subject->GetBoolField(TEXT("loaded")));
	auto ActorIdentity = Object();
	ActorIdentity->SetStringField(TEXT("actorGuid"), Subject->GetStringField(TEXT("actorGuid")));
	ActorIdentity->SetStringField(TEXT("containerId"),
								  Subject->GetStringField(TEXT("containerId")));
	Target = Object();
	Target->SetStringField(TEXT("kind"), TEXT("actor"));
	Target->SetObjectField(TEXT("actor"), ActorIdentity);
	Target->SetObjectField(TEXT("contextExtent"), Vector(5000, 5000, 1000));
	Requirements->SetArrayField(TEXT("targets"), {MakeShared<FJsonValueObject>(Target)});
	auto Acquire = [&](const FString &Id) {
		auto O = Request(TEXT("acquire"), Id);
		O->SetObjectField(TEXT("requirements"), Requirements);
		O->SetNumberField(TEXT("leaseMs"), 120000);
		return FUEShedWorldPreparation::Execute(O);
	};
	ON_SCOPE_EXIT
	{
		FUEShedWorldPreparation::Execute(Request(TEXT("release"), TEXT("first")));
		FUEShedWorldPreparation::Execute(Request(TEXT("release"), TEXT("second")));
	};
	auto Acquired = Acquire(TEXT("first"));
	TestEqual(TEXT("Actor context loads"), Acquired->GetStringField(TEXT("status")),
			  FString(TEXT("ready")));
	bool Neighbor = false, Dependency = false;
	for (const auto &V : Acquired->GetArrayField(TEXT("actors")))
		if (V->AsObject()->GetStringField(TEXT("label")) == TEXT("ContextNeighbor"))
			Neighbor = V->AsObject()->GetBoolField(TEXT("loaded"));
	for (const auto &V : Acquired->GetArrayField(TEXT("actors")))
		if (V->AsObject()->GetStringField(TEXT("label")) == TEXT("DependencyParent"))
			Dependency = V->AsObject()->GetBoolField(TEXT("loaded")) &&
						 V->AsObject()->GetBoolField(TEXT("dependency"));
	TestTrue(TEXT("Actor capture includes its surrounding neighbor"), Neighbor);
	TestTrue(TEXT("Hard dependency outside the region is loaded and identified"), Dependency);
	TestEqual(TEXT("Overlapping lease loads"),
			  Acquire(TEXT("second"))->GetStringField(TEXT("status")), FString(TEXT("ready")));
	FUEShedWorldPreparation::Execute(Request(TEXT("release")));
	TestEqual(TEXT("Releasing first preserves second"),
			  FUEShedWorldPreparation::Execute(Request(TEXT("poll"), TEXT("second")))
				  ->GetStringField(TEXT("status")),
			  FString(TEXT("ready")));
	auto Replace = Request(TEXT("replace"), TEXT("second"));
	Replace->SetNumberField(TEXT("revision"), 1);
	Replace->SetArrayField(TEXT("targets"), {});
	TestEqual(TEXT("Replacement frees bounded working set"),
			  FUEShedWorldPreparation::Execute(Replace)->GetArrayField(TEXT("actors")).Num(), 0);
	TestEqual(TEXT("Replacement retry is idempotent"),
			  FUEShedWorldPreparation::Execute(Replace)->GetIntegerField(TEXT("revision")), 1);
	FGuid SubjectGuid;
	FGuid::Parse(Subject->GetStringField(TEXT("actorGuid")), SubjectGuid);
	{
		FWorldPartitionHandle Handle(World->GetWorldPartition(), SubjectGuid);
		if (AActor *Resident = Handle->GetActor(false))
			TestFalse(TEXT("Released subject is unregistered before GC"),
					  Resident->HasActorRegisteredAllComponents());
	}
	CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS);
	const auto After = FUEShedWorldPreparation::Execute(Plan);
	for (const auto &V : After->GetArrayField(TEXT("actors")))
		if (V->AsObject()->GetStringField(TEXT("label")) == TEXT("ContextSubject"))
			TestFalse(TEXT("Last owner unloaded subject"),
					  V->AsObject()->GetBoolField(TEXT("loaded")));
	TestFalse(TEXT("Preparation does not dirty map"), World->GetOutermost()->IsDirty());
	auto Limited = Request(TEXT("acquire"), TEXT("budget"));
	auto Small = MakeShared<FJsonObject>(*Requirements);
	Small->SetNumberField(TEXT("maximumActors"), 1);
	Limited->SetObjectField(TEXT("requirements"), Small);
	Limited->SetNumberField(TEXT("leaseMs"), 1000);
	TestEqual(TEXT("Budget failure precedes loading"),
			  FUEShedWorldPreparation::Execute(Limited)->GetStringField(TEXT("code")),
			  FString(TEXT("budget_exceeded")));
	auto Expiring = Request(TEXT("acquire"), TEXT("expiring"));
	Expiring->SetObjectField(TEXT("requirements"), Requirements);
	Expiring->SetNumberField(TEXT("leaseMs"), 1000);
	TestEqual(TEXT("Expiring lease acquired"),
			  FUEShedWorldPreparation::Execute(Expiring)->GetStringField(TEXT("status")),
			  FString(TEXT("ready")));
	FPlatformProcess::Sleep(1.05f);
	TestEqual(TEXT("Abandoned lease expires"),
			  FUEShedWorldPreparation::Execute(Request(TEXT("poll"), TEXT("expiring")))
				  ->GetStringField(TEXT("status")),
			  FString(TEXT("released")));
	TestEqual(TEXT("Cancellation retained before acquisition"),
			  FUEShedWorldPreparation::Execute(Request(TEXT("release"), TEXT("cancelled")))
				  ->GetStringField(TEXT("status")),
			  FString(TEXT("released")));
	TestEqual(TEXT("Delayed acquisition cannot revive cancelled ownership"),
			  Acquire(TEXT("cancelled"))->GetStringField(TEXT("code")),
			  FString(TEXT("lease_released")));
	TestEqual(TEXT("World change lease acquired"),
			  Acquire(TEXT("changing-world"))->GetStringField(TEXT("status")),
			  FString(TEXT("ready")));
	GEditor->NewMap();
	TestEqual(TEXT("World change releases owned references"),
			  FUEShedWorldPreparation::Execute(Request(TEXT("poll"), TEXT("changing-world")))
				  ->GetStringField(TEXT("status")),
			  FString(TEXT("released")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedWorldLeaseLifecycleTest, "UEShed.World.LeaseLifecycle",
								 EAutomationTestFlags::EditorContext |
									 EAutomationTestFlags::EngineFilter)

bool FUEShedWorldLeaseLifecycleTest::RunTest(const FString &Parameters)
{
	using FJson = TSharedPtr<FJsonObject>;
	auto Object = []() { return MakeShared<FJsonObject>(); };
	auto Identity = FUEShedWorldPreparation::Describe();
	if (!TestTrue(TEXT("An editor world is available"), Identity.IsValid()))
		return false;
	auto Contract = Object(), Version = Object();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-world-preparation"));
	Contract->SetObjectField(TEXT("version"), Version);
	auto Requirements = Object();
	Requirements->SetObjectField(TEXT("world"), Identity);
	Requirements->SetArrayField(TEXT("targets"), {});
	Requirements->SetArrayField(TEXT("dataLayers"), {});
	Requirements->SetNumberField(TEXT("maximumActors"), 1);
	auto Request = [&](const TCHAR *Action, const FString &Id = TEXT("slow")) {
		auto O = Object();
		O->SetObjectField(TEXT("contract"), Contract);
		O->SetStringField(TEXT("action"), Action);
		if (FString(Action) == TEXT("describe"))
			return O;
		O->SetStringField(TEXT("leaseId"), Id);
		if (FString(Action) == TEXT("acquire"))
		{
			O->SetObjectField(TEXT("requirements"), Requirements);
			O->SetNumberField(TEXT("leaseMs"), 1000);
		}
		else
			O->SetStringField(TEXT("worldId"), Identity->GetStringField(TEXT("worldId")));
		return O;
	};
	auto Execute = [&](const TCHAR *Action, const FString &Id = TEXT("slow")) {
		return FUEShedWorldPreparation::Execute(Request(Action, Id));
	};
	double Now = FPlatformTime::Seconds();
	UEShedWorldPreparationTest::Clock = [&]() { return Now; };
	auto Drain = [&]() {
		// Expire live leases first, then let their complete recovery window elapse.
		Now += 121;
		Execute(TEXT("describe"));
		Now += 121;
		Execute(TEXT("describe"));
	};
	ON_SCOPE_EXIT
	{
		UEShedWorldPreparationTest::BeforeLoad = nullptr;
		Drain();
		UEShedWorldPreparationTest::Clock = nullptr;
	};
	Drain();
	UEShedWorldPreparationTest::BeforeLoad = [&]() { Now += 2; };
	TestEqual(TEXT("Slow acquisition returns ready"),
			  Execute(TEXT("acquire"))->GetStringField(TEXT("status")), FString(TEXT("ready")));
	TestEqual(TEXT("Loading did not consume the one-second lease"),
			  Execute(TEXT("poll"))->GetStringField(TEXT("status")), FString(TEXT("ready")));
	auto Replace = Request(TEXT("replace"));
	Replace->SetNumberField(TEXT("revision"), 1);
	Replace->SetArrayField(TEXT("targets"), {});
	TestEqual(TEXT("Slow replacement returns ready"),
			  FUEShedWorldPreparation::Execute(Replace)->GetStringField(TEXT("status")),
			  FString(TEXT("ready")));
	TestEqual(TEXT("Replacement loading did not consume the lease"),
			  Execute(TEXT("poll"))->GetStringField(TEXT("status")), FString(TEXT("ready")));
	UEShedWorldPreparationTest::BeforeLoad = nullptr;
	Now += 1.01;
	TestEqual(TEXT("Lease still expires after caller inactivity"),
			  Execute(TEXT("poll"))->GetStringField(TEXT("status")), FString(TEXT("released")));
	Drain();

	for (int32 I = 0; I < 129; ++I)
	{
		const FString Id = FString::Printf(TEXT("batch-%d"), I);
		if (!TestEqual(TEXT("Completed history does not occupy active capacity"),
					   Execute(TEXT("acquire"), Id)->GetStringField(TEXT("status")),
					   FString(TEXT("ready"))))
			return false;
		TestEqual(TEXT("Batch release succeeds"),
				  Execute(TEXT("release"), Id)->GetStringField(TEXT("status")),
				  FString(TEXT("released")));
	}
	for (int32 I = 0; I < 128; ++I)
		TestEqual(TEXT("Active lease slot admitted"),
				  Execute(TEXT("acquire"), FString::Printf(TEXT("active-%d"), I))
					  ->GetStringField(TEXT("status")),
				  FString(TEXT("ready")));
	TestEqual(TEXT("Concurrent ownership stays bounded"),
			  Execute(TEXT("acquire"), TEXT("active-overflow"))->GetStringField(TEXT("code")),
			  FString(TEXT("active_lease_limit")));
	for (int32 I = 1; I < 128; ++I)
		Execute(TEXT("release"), FString::Printf(TEXT("active-%d"), I));
	// 129 completed + 128 acquired identities occupy 257 reserved recovery slots.
	for (int32 I = 257; I < 4096; ++I)
		if (!TestEqual(TEXT("Recovery identity admitted within its separate budget"),
					   Execute(TEXT("release"), FString::Printf(TEXT("cancel-%d"), I))
						   ->GetStringField(TEXT("status")),
					   FString(TEXT("released"))))
			return false;
	auto Full = Execute(TEXT("acquire"), TEXT("retention-overflow"));
	TestEqual(TEXT("Recovery budget is bounded"), Full->GetStringField(TEXT("code")),
			  FString(TEXT("retention_budget_exceeded")));
	TestTrue(TEXT("Recovery exhaustion provides retry timing"),
			 Full->GetStringField(TEXT("message")).Contains(TEXT("Retry in at least")));
	TestEqual(TEXT("Unknown cancellation cannot evict recovery evidence"),
			  Execute(TEXT("release"), TEXT("cancel-overflow"))->GetStringField(TEXT("code")),
			  FString(TEXT("retention_budget_exceeded")));
	TestEqual(TEXT("Full recovery budget still permits renewal"),
			  Execute(TEXT("poll"), TEXT("active-0"))->GetStringField(TEXT("status")),
			  FString(TEXT("ready")));
	auto RetainedReplace = Request(TEXT("replace"), TEXT("active-0"));
	RetainedReplace->SetNumberField(TEXT("revision"), 1);
	RetainedReplace->SetArrayField(TEXT("targets"), {});
	TestEqual(TEXT("Full recovery budget still permits replacement"),
			  FUEShedWorldPreparation::Execute(RetainedReplace)->GetStringField(TEXT("status")),
			  FString(TEXT("ready")));
	TestEqual(TEXT("Release uses its reserved recovery slot"),
			  Execute(TEXT("release"), TEXT("active-0"))->GetStringField(TEXT("status")),
			  FString(TEXT("released")));
	TestEqual(TEXT("Old completed identity cannot reacquire"),
			  Execute(TEXT("acquire"), TEXT("batch-0"))->GetStringField(TEXT("status")),
			  FString(TEXT("released")));
	TestEqual(TEXT("Old cancellation cannot be revived"),
			  Execute(TEXT("acquire"), TEXT("cancel-257"))->GetStringField(TEXT("code")),
			  FString(TEXT("lease_released")));
	Now += 121;
	TestEqual(TEXT("Capacity recovers after retention expires"),
			  Execute(TEXT("acquire"), TEXT("after-retention"))->GetStringField(TEXT("status")),
			  FString(TEXT("ready")));
	Execute(TEXT("release"), TEXT("after-retention"));
	return true;
}
#endif
