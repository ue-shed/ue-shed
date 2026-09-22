#include "UEShedWorldPreparation.h"
#include "Containers/Ticker.h"
#include "DataLayer/DataLayerEditorSubsystem.h"
#include "Editor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Misc/App.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UEShedWorldLibrary.h"
#include "UEShedWorldPreparationTest.h"
#include "WorldPartition/ActorDescContainerInstance.h"
#include "WorldPartition/DataLayer/DataLayerAsset.h"
#include "WorldPartition/DataLayer/DataLayerInstance.h"
#include "WorldPartition/DataLayer/DataLayerManager.h"
#include "WorldPartition/LoaderAdapter/LoaderAdapterActorList.h"
#include "WorldPartition/WorldPartition.h"
#include "WorldPartition/WorldPartitionActorDescInstance.h"

#if WITH_DEV_AUTOMATION_TESTS
namespace UEShedWorldPreparationTest
{
TFunction<double()> Clock;
TFunction<void()> BeforeLoad;
} // namespace UEShedWorldPreparationTest
#endif

namespace
{
constexpr int32 MaximumActiveLeases = 128;
// Active leases reserve a recovery slot so release never needs new capacity.
constexpr int32 MaximumRecoverySlots = 4096;
constexpr double RetentionSeconds = 120;
double NowSeconds()
{
#if WITH_DEV_AUTOMATION_TESTS
	if (UEShedWorldPreparationTest::Clock)
		return UEShedWorldPreparationTest::Clock();
#endif
	return FPlatformTime::Seconds();
}
using FJson = TSharedPtr<FJsonObject>;
using FValues = TArray<TSharedPtr<FJsonValue>>;
FJson Obj()
{
	return MakeShared<FJsonObject>();
}
FJson Child(const FJson &O, const TCHAR *Key)
{
	const FJson *Value = nullptr;
	return O && O->TryGetObjectField(Key, Value) ? *Value : nullptr;
}
FString Str(const FJson &O, const TCHAR *Key)
{
	FString Value;
	if (O)
		O->TryGetStringField(Key, Value);
	return Value;
}
const FValues &Array(const FJson &O, const TCHAR *Key)
{
	static const FValues Empty;
	const FValues *Value = nullptr;
	return O && O->TryGetArrayField(Key, Value) ? *Value : Empty;
}
FString JsonText(const FJson &O)
{
	FString Text;
	FJsonSerializer::Serialize(
		O.ToSharedRef(),
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text));
	return Text;
}
bool Fields(const FJson &O, std::initializer_list<const TCHAR *> Keys)
{
	if (!O || O->Values.Num() != static_cast<int32>(Keys.size()))
		return false;
	for (const TCHAR *Key : Keys)
		if (!O->HasField(Key))
			return false;
	return true;
}
bool Text(const FJson &O, const TCHAR *Key, int32 Maximum = 1024)
{
	FString Value;
	return O && O->TryGetStringField(Key, Value) && !Value.IsEmpty() && Value.Len() <= Maximum;
}
bool Identifier(const FJson &O, const TCHAR *Key)
{
	if (!Text(O, Key, 128))
		return false;
	const FString Value = Str(O, Key);
	for (int32 I = 0; I < Value.Len(); ++I)
	{
		const TCHAR C = Value[I];
		const bool Alnum =
			(C >= 'a' && C <= 'z') || (C >= 'A' && C <= 'Z') || (C >= '0' && C <= '9');
		if (!Alnum && (I == 0 || (C != '-' && C != '_' && C != '.')))
			return false;
	}
	return true;
}
bool Number(const FJson &O, const TCHAR *Key, double Min, double Max, bool Integer = true)
{
	double N;
	return O && O->TryGetNumberField(Key, N) && FMath::IsFinite(N) && N >= Min && N <= Max &&
		   (!Integer || FMath::FloorToDouble(N) == N);
}
bool Bool(const FJson &O, const TCHAR *Key)
{
	bool B;
	return O && O->TryGetBoolField(Key, B);
}
bool Vector(const FJson &O, bool Extent = false)
{
	if (!Fields(O, {TEXT("x"), TEXT("y"), TEXT("z")}))
		return false;
	for (const TCHAR *K : {TEXT("x"), TEXT("y"), TEXT("z")})
		if (!Number(O, K, Extent ? 0 : -DBL_MAX, Extent ? 1e7 : DBL_MAX, false))
			return false;
	return true;
}
FVector ReadVector(const FJson &O)
{
	return FVector(O->GetNumberField(TEXT("x")), O->GetNumberField(TEXT("y")),
				   O->GetNumberField(TEXT("z")));
}
FJson WriteVector(const FVector &V)
{
	auto O = Obj();
	O->SetNumberField(TEXT("x"), V.X);
	O->SetNumberField(TEXT("y"), V.Y);
	O->SetNumberField(TEXT("z"), V.Z);
	return O;
}
FJson WriteBox(const FBox &B)
{
	auto O = Obj();
	O->SetObjectField(TEXT("center"), WriteVector(B.GetCenter()));
	O->SetObjectField(TEXT("extent"), WriteVector(B.GetExtent()));
	return O;
}
FBox ReadBox(const FJson &O)
{
	const FVector Center = ReadVector(Child(O, TEXT("center"))),
				  Extent = ReadVector(Child(O, TEXT("extent")));
	return FBox(Center - Extent, Center + Extent);
}
bool ValidTargets(const FJson &O)
{
	const FValues *Targets;
	if (!O || !O->TryGetArrayField(TEXT("targets"), Targets) || Targets->Num() > 64)
		return false;
	for (const auto &V : *Targets)
	{
		const FJson *Target;
		if (!V || !V->TryGetObject(Target))
			return false;
		if (Str(*Target, TEXT("kind")) == TEXT("region"))
		{
			auto R = Child(*Target, TEXT("region"));
			if (!Fields(*Target, {TEXT("kind"), TEXT("region")}) ||
				!Fields(R, {TEXT("center"), TEXT("extent")}) || !Vector(Child(R, TEXT("center"))) ||
				!Vector(Child(R, TEXT("extent")), true))
				return false;
			const FBox Box = ReadBox(R);
			if (Box.Min.ContainsNaN() || Box.Max.ContainsNaN() ||
				!FMath::IsFinite(Box.GetCenter().X) || !FMath::IsFinite(Box.GetCenter().Y) ||
				!FMath::IsFinite(Box.GetCenter().Z))
				return false;
		}
		else if (Str(*Target, TEXT("kind")) == TEXT("actor"))
		{
			auto A = Child(*Target, TEXT("actor"));
			FGuid Guid;
			if (!Fields(*Target, {TEXT("kind"), TEXT("actor"), TEXT("contextExtent")}) ||
				!Fields(A, {TEXT("actorGuid"), TEXT("containerId")}) ||
				!Text(A, TEXT("actorGuid")) || !FGuid::Parse(Str(A, TEXT("actorGuid")), Guid) ||
				Guid.ToString(EGuidFormats::DigitsWithHyphensLower) != Str(A, TEXT("actorGuid")) ||
				!Text(A, TEXT("containerId")) ||
				!Vector(Child(*Target, TEXT("contextExtent")), true))
				return false;
		}
		else
			return false;
	}
	return true;
}
bool ValidRequirements(const FJson &O)
{
	if (!Fields(O, {TEXT("world"), TEXT("targets"), TEXT("dataLayers"), TEXT("maximumActors")}) ||
		!ValidTargets(O) || !Number(O, TEXT("maximumActors"), 1, 100000))
		return false;
	auto W = Child(O, TEXT("world"));
	if (!Fields(W, {TEXT("worldId"), TEXT("mapPath"), TEXT("projectName"), TEXT("partitioned"),
					TEXT("streamingEnabled")}) ||
		!Identifier(W, TEXT("worldId")) || !Text(W, TEXT("mapPath")) ||
		!Text(W, TEXT("projectName")) || !Bool(W, TEXT("partitioned")) ||
		!Bool(W, TEXT("streamingEnabled")))
		return false;
	const FValues *Layers;
	if (!O->TryGetArrayField(TEXT("dataLayers"), Layers) || Layers->Num() > 64)
		return false;
	for (const auto &V : *Layers)
	{
		const FJson *L;
		if (!V || !V->TryGetObject(L) ||
			!Fields(*L, {TEXT("assetPath"), TEXT("loaded"), TEXT("visible")}) ||
			!Text(*L, TEXT("assetPath")) || !Bool(*L, TEXT("loaded")) || !Bool(*L, TEXT("visible")))
			return false;
	}
	return true;
}
FJson Fail(const FString &Code, const FString &Message)
{
	auto O = Obj();
	O->SetStringField(TEXT("status"), TEXT("failed"));
	O->SetStringField(TEXT("code"), Code);
	O->SetStringField(TEXT("message"), Message);
	O->SetStringField(
		TEXT("recovery"),
		TEXT("Inspect the requested world, actors, layers and existing lease before retrying."));
	return O;
}
void Issue(FValues &Issues, const FString &Code, const FString &Subject, const FString &Message)
{
	if (Issues.Num() >= 128)
		return;
	auto O = Obj();
	O->SetStringField(TEXT("code"), Code);
	O->SetStringField(TEXT("subject"), Subject);
	O->SetStringField(TEXT("message"), Message);
	Issues.Add(MakeShared<FJsonValueObject>(O));
}
TWeakObjectPtr<UWorld> CurrentWorld;
FString CurrentWorldId;
UWorld *EditorWorld()
{
	return GEditor && !GEditor->PlayWorld ? GEditor->GetEditorWorldContext().World() : nullptr;
}
FJson WorldIdentity(UWorld *World)
{
	if (CurrentWorld.Get() != World)
	{
		CurrentWorld = World;
		CurrentWorldId = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower);
	}
	auto O = Obj();
	O->SetStringField(TEXT("worldId"), CurrentWorldId);
	O->SetStringField(TEXT("mapPath"), World->GetOutermost()->GetName());
	O->SetStringField(TEXT("projectName"), FApp::GetProjectName());
	O->SetBoolField(TEXT("partitioned"), World->GetWorldPartition() != nullptr);
	O->SetBoolField(TEXT("streamingEnabled"),
					World->GetWorldPartition() &&
						World->GetWorldPartition()->IsStreamingEnabledInEditor());
	return O;
}
FString ContainerId(const FWorldPartitionHandle &H)
{
	return H->GetContainerInstance()->GetContainerPackage().ToString() + TEXT(":") +
		   H->GetContainerInstance()->GetContainerID().ToString();
}
struct FActor
{
	FWorldPartitionHandle Handle;
	TWeakObjectPtr<AActor> Direct;
	bool Dependency = false;
	AActor *Loaded() const
	{
		return Handle.IsValid() ? Handle->GetActor(false) : Direct.Get();
	}
	FString Guid() const
	{
		return (Handle.IsValid()   ? Handle->GetGuid()
				: Direct.IsValid() ? Direct->GetActorGuid()
								   : FGuid())
			.ToString(EGuidFormats::DigitsWithHyphensLower);
	}
	FString Container() const
	{
		return Handle.IsValid() ? ContainerId(Handle) : TEXT("persistent");
	}
	FBox Bounds() const
	{
		return Handle.IsValid()	  ? Handle->GetEditorBounds()
			   : Direct.IsValid() ? Direct->GetComponentsBoundingBox(true)
								  : FBox(ForceInit);
	}
};
struct FLayer
{
	TWeakObjectPtr<UDataLayerInstance> Layer;
	bool Loaded, Visible, AppliedLoaded, AppliedVisible;
};
struct FLease
{
	FString Id;
	FJson Requirements, World, Input, LastReplacement;
	TWeakObjectPtr<UWorld> WorldPtr;
	TArray<FActor> Actors;
	TArray<FBox> Regions;
	TArray<FLayer> Layers;
	TUniquePtr<FLoaderAdapterActorList> Loader;
	FValues Issues;
	int32 Revision = 0;
	double Touched = NowSeconds(), LeaseSeconds = 120, ClosedAt = 0;
	bool Closed = false;
};
TMap<FString, TSharedPtr<FLease>> Leases;
FTSTicker::FDelegateHandle TickHandle;
FDelegateHandle WorldHandle, PIEHandle;

FJson AdmissionFailure(bool NeedsActiveLease)
{
	int32 Active = 0;
	double EarliestExpiry = DBL_MAX;
	for (const auto &Pair : Leases)
	{
		if (!Pair.Value->Closed)
			++Active;
		else
			EarliestExpiry = FMath::Min(EarliestExpiry, Pair.Value->ClosedAt + RetentionSeconds);
	}
	if (NeedsActiveLease && Active >= MaximumActiveLeases)
		return Fail(TEXT("active_lease_limit"),
					TEXT("All 128 active lease slots are in use. Release an active lease before "
						 "acquiring another."));
	if (Leases.Num() >= MaximumRecoverySlots)
		return Fail(TEXT("retention_budget_exceeded"),
					FString::Printf(
						TEXT("All 4096 recovery slots are reserved or retained. Retry in at least "
							 "%.0f seconds; existing leases can still poll, replace and release."),
						FMath::Max(1.0, FMath::CeilToDouble(EarliestExpiry - NowSeconds()) + 1.0)));
	return nullptr;
}

FJson Snapshot(FLease &Lease, bool Planned = false)
{
	FValues Actors, Issues = Lease.Issues, Regions;
	if (!Lease.Closed)
	{
		for (const auto &A : Lease.Actors)
		{
			auto O = Obj();
			auto *Loaded = A.Loaded();
			const FBox Bounds = A.Bounds();
			O->SetStringField(TEXT("actorGuid"), A.Guid());
			O->SetStringField(TEXT("containerId"), A.Container());
			O->SetStringField(TEXT("label"), A.Handle.IsValid()
												 ? A.Handle->GetActorLabel().ToString()
											 : Loaded ? Loaded->GetActorLabel()
													  : TEXT(""));
			const UClass *Class = A.Handle.IsValid() ? A.Handle->GetActorNativeClass()
								  : Loaded			 ? Loaded->GetClass()
													 : nullptr;
			O->SetStringField(TEXT("classPath"), Class ? Class->GetPathName() : TEXT("unknown"));
			if (Bounds.IsValid)
				O->SetObjectField(TEXT("region"), WriteBox(Bounds));
			else
				O->SetField(TEXT("region"), MakeShared<FJsonValueNull>());
			O->SetBoolField(TEXT("spatiallyLoaded"),
							A.Handle.IsValid() && A.Handle->GetIsSpatiallyLoaded());
			O->SetBoolField(TEXT("loaded"), Loaded != nullptr);
			O->SetBoolField(TEXT("registered"),
							Loaded && Loaded->HasActorRegisteredAllComponents());
			O->SetBoolField(TEXT("visible"),
							Loaded && !Loaded->IsHiddenEd() && !Loaded->IsHidden());
			O->SetBoolField(TEXT("dependency"), A.Dependency);
			Actors.Add(MakeShared<FJsonValueObject>(O));
			if (!Loaded)
				Issue(Issues, TEXT("actor_unloaded"), A.Guid(),
					  A.Handle.IsValid() && !A.Handle->GetUnloadedReason().IsEmpty()
						  ? A.Handle->GetUnloadedReason().ToString()
						  : TEXT("The requested actor is not loaded."));
			else if (!Loaded->HasActorRegisteredAllComponents())
				Issue(Issues, TEXT("actor_unregistered"), A.Guid(),
					  TEXT("Actor components are not registered."));
		}
		for (const auto &L : Lease.Layers)
			if (!L.Layer.IsValid() || L.Layer->IsEffectiveLoadedInEditor() != L.AppliedLoaded ||
				L.Layer->IsEffectiveVisible() != L.AppliedVisible)
				Issue(Issues, TEXT("layer_blocked"),
					  L.Layer.IsValid() ? L.Layer->GetPathName() : TEXT("removed"),
					  TEXT("The required effective Data Layer state is unavailable."));
	}
	for (const auto &R : Lease.Regions)
		Regions.Add(MakeShared<FJsonValueObject>(WriteBox(R)));
	auto O = Obj();
	O->SetStringField(TEXT("status"), Lease.Closed		 ? TEXT("released")
									  : Planned			 ? TEXT("planned")
									  : Issues.IsEmpty() ? TEXT("ready")
														 : TEXT("blocked"));
	O->SetObjectField(TEXT("world"), Lease.World);
	O->SetStringField(TEXT("leaseId"), Lease.Id);
	O->SetNumberField(TEXT("revision"), Lease.Revision);
	O->SetArrayField(TEXT("regions"), Regions);
	O->SetArrayField(TEXT("actors"), Actors);
	O->SetArrayField(TEXT("issues"), Issues);
	O->SetStringField(TEXT("renderReadiness"), TEXT("not_assessed"));
	return O;
}
FJson RenewedSnapshot(FLease &Lease)
{
	auto Result = Snapshot(Lease);
	// Selection, synchronous loading and evidence construction do not consume the
	// caller's renewal window. A short lease is still usable when loading was slow.
	Lease.Touched = NowSeconds();
	return Result;
}
bool Close(FLease &Lease)
{
	if (Lease.Closed)
		return Lease.Issues.IsEmpty();
	if (Lease.Loader && Lease.WorldPtr.IsValid())
		Lease.Loader->Unload();
	Lease.Loader.Reset();
	Lease.Actors.Reset();
	auto *Subsystem = GEditor ? GEditor->GetEditorSubsystem<UDataLayerEditorSubsystem>() : nullptr;
	for (auto &L : Lease.Layers)
	{
		if (!L.Layer.IsValid() || !Subsystem)
		{
			Issue(Lease.Issues, TEXT("restoration_conflict"), Lease.Id,
				  TEXT("The owned Data Layer is no longer available."));
			continue;
		}
		if (L.Layer->IsLoadedInEditor() != L.AppliedLoaded ||
			L.Layer->IsVisible() != L.AppliedVisible)
		{
			Issue(Lease.Issues, TEXT("restoration_conflict"), L.Layer->GetPathName(),
				  TEXT("Data Layer changed outside this lease; preserved that change."));
			continue;
		}
		Subsystem->SetDataLayerIsLoadedInEditor(L.Layer.Get(), L.Loaded, false);
		Subsystem->SetDataLayerVisibility(L.Layer.Get(), L.Visible);
		if (L.Layer->IsLoadedInEditor() != L.Loaded || L.Layer->IsVisible() != L.Visible)
			Issue(Lease.Issues, TEXT("restoration_conflict"), L.Layer->GetPathName(),
				  TEXT("The editor did not restore the original layer state."));
	}
	Lease.Layers.Reset();
	Lease.Closed = true;
	Lease.ClosedAt = NowSeconds();
	Lease.Requirements.Reset();
	Lease.LastReplacement.Reset();
	return Lease.Issues.IsEmpty();
}
FJson Select(FLease &Lease)
{
	UWorld *World = Lease.WorldPtr.Get();
	const int32 Budget = Lease.Requirements->GetIntegerField(TEXT("maximumActors"));
	TArray<FActor> Inventory;
	if (auto *WP = World->GetWorldPartition())
	{
		for (FActorDescContainerInstanceCollection::TIterator<> It(WP); It; ++It)
		{
			if (!It->IsEditorRelevant())
				continue;
			FActor A;
			A.Handle = FWorldPartitionHandle(It->GetContainerInstance(), It->GetGuid());
			Inventory.Add(MoveTemp(A));
			if (Inventory.Num() > 100000)
				return Fail(TEXT("budget_exceeded"),
							TEXT("Descriptor inventory exceeds the native scan limit."));
		}
	}
	else
		for (TActorIterator<AActor> It(World); It; ++It)
		{
			if (It->HasAnyFlags(RF_Transient))
				continue;
			FActor A;
			A.Direct = *It;
			Inventory.Add(MoveTemp(A));
			if (Inventory.Num() > 100000)
				return Fail(TEXT("budget_exceeded"),
							TEXT("Actor inventory exceeds the native scan limit."));
		}
	TSet<FString> Selected;
	auto Add = [&](const FActor &A, bool Dependency) {
		const FString Key = A.Container() + TEXT(":") + A.Guid();
		if (!Selected.Contains(Key))
		{
			Selected.Add(Key);
			FActor Copy = A;
			Copy.Dependency = Dependency;
			Lease.Actors.Add(MoveTemp(Copy));
		}
	};
	for (const auto &V : Array(Lease.Requirements, TEXT("targets")))
	{
		auto T = V->AsObject();
		FBox B(ForceInit);
		if (Str(T, TEXT("kind")) == TEXT("region"))
			B = ReadBox(Child(T, TEXT("region")));
		else
		{
			auto Identity = Child(T, TEXT("actor"));
			FGuid Guid;
			FGuid::Parse(Str(Identity, TEXT("actorGuid")), Guid);
			const FString Canonical = Guid.ToString(EGuidFormats::DigitsWithHyphensLower);
			const FActor *Actor = Inventory.FindByPredicate([&](const FActor &A) {
				return A.Guid() == Canonical && A.Container() == Str(Identity, TEXT("containerId"));
			});
			if (!Actor)
				return Fail(
					TEXT("actor_missing"),
					TEXT("The actor instance is absent from the supported editor inventory."));
			Add(*Actor, false);
			B = Actor->Bounds();
			if (!B.IsValid)
				return Fail(TEXT("bounds_unavailable"),
							TEXT("Actor context requires valid actor bounds."));
			B = B.ExpandBy(ReadVector(Child(T, TEXT("contextExtent"))));
			if (B.GetExtent().GetMax() > 1e7)
				return Fail(TEXT("budget_exceeded"),
							TEXT("Actor context exceeds the region extent limit."));
		}
		Lease.Regions.Add(B);
	}
	for (const FActor &A : Inventory)
		for (const FBox &B : Lease.Regions)
			if (A.Bounds().IsValid && A.Bounds().Intersect(B))
			{
				Add(A, false);
				break;
			}
	for (int32 I = 0; I < Lease.Actors.Num(); ++I)
	{
		if (Lease.Actors.Num() > Budget)
			return Fail(TEXT("budget_exceeded"),
						TEXT("Actor and dependency count exceeds maximumActors before loading."));
		// Copy before Add can reallocate the selected array.
		FWorldPartitionHandle Handle = Lease.Actors[I].Handle;
		if (!Handle.IsValid())
			continue;
		if (Handle->IsChildContainerInstance())
			return Fail(TEXT("container_unavailable"),
						TEXT("Nested actor containers require a future preparation capability; no "
							 "partial area was loaded."));
		for (const FGuid &Reference : Handle->GetReferences())
		{
			FActor A;
			A.Handle = FWorldPartitionHandle(Handle->GetContainerInstance(), Reference);
			if (!A.Handle.IsValid())
				return Fail(TEXT("actor_missing"),
							TEXT("A required actor dependency has no descriptor."));
			Add(A, true);
		}
	}
	// Unreal stores a recursive reference map for every root. Bound that expansion as well as
	// unique actors, and reject graphs deeper than the native recursive loader can safely visit.
	int32 ReferenceCount = 0, EdgeCount = 0;
	for (const auto &Root : Lease.Actors)
	{
		if (Root.Dependency || !Root.Handle.IsValid())
			continue;
		TSet<FGuid> Visited;
		TArray<TPair<FWorldPartitionHandle, int32>> Pending;
		Pending.Emplace(Root.Handle, 0);
		while (!Pending.IsEmpty())
		{
			auto Entry = Pending.Pop();
			if (Visited.Contains(Entry.Key->GetGuid()))
				continue;
			Visited.Add(Entry.Key->GetGuid());
			if (++ReferenceCount > 100000 || Entry.Value > 512)
				return Fail(TEXT("dependency_budget_exceeded"),
							TEXT("Native recursive reference storage or depth exceeds the "
								 "preparation limit."));
			const auto &References = Entry.Key->GetReferences();
			for (int32 J = References.Num() - 1; J >= 0; --J)
			{
				if (++EdgeCount > 250000)
					return Fail(TEXT("dependency_budget_exceeded"),
								TEXT("Dependency graph traversal exceeds the preparation limit."));
				FWorldPartitionHandle Reference(Entry.Key->GetContainerInstance(), References[J]);
				if (Reference.IsValid())
					Pending.Emplace(MoveTemp(Reference), Entry.Value + 1);
			}
		}
	}
	return nullptr;
}
FJson ApplyLayers(FLease &Lease, bool Planned = false)
{
	auto *Manager = UDataLayerManager::GetDataLayerManager(Lease.WorldPtr.Get());
	auto *Subsystem = GEditor->GetEditorSubsystem<UDataLayerEditorSubsystem>();
	TSet<UDataLayerInstance *> Seen;
	for (const auto &V : Array(Lease.Requirements, TEXT("dataLayers")))
	{
		auto L = V->AsObject();
		UDataLayerInstance *Found = nullptr;
		if (Manager)
			Manager->ForEachDataLayerInstance([&](UDataLayerInstance *Candidate) {
				if (Candidate->GetAsset() &&
					Candidate->GetAsset()->GetPathName() == Str(L, TEXT("assetPath")))
					Found = Candidate;
				return true;
			});
		if (!Found || !Subsystem)
			return Fail(TEXT("layer_missing"),
						TEXT("The requested Data Layer asset has no instance in this world."));
		if (Seen.Contains(Found))
			return Fail(TEXT("layer_conflict"), TEXT("A Data Layer was requested more than once."));
		Seen.Add(Found);
		for (const auto &Pair : Leases)
			if (!Pair.Value->Closed && Pair.Value->Id != Lease.Id)
				if (!Pair.Value->Layers.IsEmpty())
					return Fail(
						TEXT("layer_conflict"),
						TEXT(
							"Another world preparation lease owns Data Layer state. Layer-changing "
							"leases are serialized to protect hierarchy restoration."));
	}
	if (Planned)
		return nullptr;
	for (const auto &V : Array(Lease.Requirements, TEXT("dataLayers")))
	{
		auto L = V->AsObject();
		for (auto *Found : Seen)
			if (Found->GetAsset()->GetPathName() == Str(L, TEXT("assetPath")))
			{
				Lease.Layers.Add({Found, Found->IsLoadedInEditor(), Found->IsVisible(),
								  L->GetBoolField(TEXT("loaded")),
								  L->GetBoolField(TEXT("visible"))});
				Subsystem->SetDataLayerIsLoadedInEditor(Found, L->GetBoolField(TEXT("loaded")),
														false);
				Subsystem->SetDataLayerVisibility(Found, L->GetBoolField(TEXT("visible")));
			}
	}
	return nullptr;
}
void Load(FLease &Lease)
{
#if WITH_DEV_AUTOMATION_TESTS
	if (UEShedWorldPreparationTest::BeforeLoad)
		UEShedWorldPreparationTest::BeforeLoad();
#endif
	if (!Lease.WorldPtr->GetWorldPartition())
		return;
	TArray<FWorldPartitionHandle> Handles;
	for (const auto &A : Lease.Actors)
		if (!A.Dependency && A.Handle.IsValid())
			Handles.Add(A.Handle);
	Lease.Loader = MakeUnique<FLoaderAdapterActorList>(Lease.WorldPtr.Get());
	Lease.Loader->AddActors(Handles);
}
void Sweep()
{
	const double Now = NowSeconds();
	for (auto It = Leases.CreateIterator(); It; ++It)
	{
		auto &L = *It.Value();
		if (!L.Closed && (Now - L.Touched > L.LeaseSeconds || !L.WorldPtr.IsValid() ||
						  L.WorldPtr.Get() != EditorWorld()))
			Close(L);
		if (!L.Closed && (L.WorldPtr->GetOutermost()->GetName() != Str(L.World, TEXT("mapPath")) ||
						  (L.WorldPtr->GetWorldPartition() &&
						   L.WorldPtr->GetWorldPartition()->IsStreamingEnabledInEditor()) !=
							  L.World->GetBoolField(TEXT("streamingEnabled"))))
			Close(L);
		if (L.Closed && Now - L.ClosedAt > RetentionSeconds)
			It.RemoveCurrent();
	}
}
} // namespace

TSharedPtr<FJsonObject> FUEShedWorldPreparation::Describe()
{
	if (auto *World = EditorWorld())
		return WorldIdentity(World);
	return nullptr;
}
TSharedPtr<FJsonObject> FUEShedWorldPreparation::Execute(const FJson &Request)
{
	if (!IsInGameThread())
		return Fail(TEXT("editor_required"),
					TEXT("World preparation must run on the editor game thread."));
	Sweep();
	auto C = Child(Request, TEXT("contract")), V = Child(C, TEXT("version"));
	if (!Fields(C, {TEXT("name"), TEXT("version")}) ||
		Str(C, TEXT("name")) != TEXT("ue-shed-world-preparation") ||
		!Fields(V, {TEXT("major"), TEXT("minor")}) || !Number(V, TEXT("major"), 1, 1) ||
		!Number(V, TEXT("minor"), 0, 0))
		return Fail(TEXT("invalid_request"), TEXT("Expected world preparation contract 1.0."));
	const FString Action = Str(Request, TEXT("action"));
	if (Action == TEXT("release") || Action == TEXT("poll") || Action == TEXT("replace"))
	{
		const bool Replace = Action == TEXT("replace");
		if (!(Replace ? Fields(Request, {TEXT("contract"), TEXT("action"), TEXT("leaseId"),
										 TEXT("worldId"), TEXT("revision"), TEXT("targets")})
					  : Fields(Request, {TEXT("contract"), TEXT("action"), TEXT("leaseId"),
										 TEXT("worldId")})) ||
			!Identifier(Request, TEXT("leaseId")) || !Identifier(Request, TEXT("worldId")) ||
			(Replace && (!Number(Request, TEXT("revision"), 1, 1000000) || !ValidTargets(Request))))
			return Fail(TEXT("invalid_request"), TEXT("Invalid lease request."));
		auto *Found = Leases.Find(Str(Request, TEXT("leaseId")));
		if (!Found && Action == TEXT("release"))
		{
			// Retain cancellation before acquisition too: a delayed request must not revive
			// ownership after the caller has successfully completed its cleanup.
			auto *World = EditorWorld();
			auto Identity = World ? WorldIdentity(World) : nullptr;
			if (!Identity || Str(Identity, TEXT("worldId")) != Str(Request, TEXT("worldId")))
				return Fail(TEXT("lease_unknown"),
							TEXT("No retained lease or matching editor world has this identity."));
			if (auto Error = AdmissionFailure(false))
				return Error;
			auto Cancelled = MakeShared<FLease>();
			Cancelled->Id = Str(Request, TEXT("leaseId"));
			Cancelled->World = Identity;
			Cancelled->WorldPtr = World;
			Cancelled->Closed = true;
			Cancelled->ClosedAt = NowSeconds();
			Leases.Add(Cancelled->Id, Cancelled);
			return Snapshot(*Cancelled);
		}
		if (!Found)
			return Fail(TEXT("lease_unknown"), TEXT("No retained lease has this identity."));
		auto &L = **Found;
		if (Str(L.World, TEXT("worldId")) != Str(Request, TEXT("worldId")))
			return Fail(TEXT("world_changed"), TEXT("Lease world identity does not match."));
		if (Action == TEXT("release"))
			return Close(L) ? Snapshot(L)
							: Fail(TEXT("restoration_conflict"),
								   TEXT("An external layer change prevented full restoration; it "
										"was preserved."));
		if (L.Closed)
			return Snapshot(L);
		L.Touched = NowSeconds();
		if (Replace)
		{
			const int32 Revision = Request->GetIntegerField(TEXT("revision"));
			if (Revision == L.Revision && L.LastReplacement &&
				FJsonValue::CompareEqual(FJsonValueObject(Request),
										 FJsonValueObject(L.LastReplacement)))
				return RenewedSnapshot(L);
			if (Revision != L.Revision + 1)
				return Fail(TEXT("revision_conflict"),
							TEXT("Replacement must follow the active revision."));
			FLease Next;
			Next.Id = L.Id;
			Next.World = L.World;
			Next.WorldPtr = L.WorldPtr;
			Next.Requirements = MakeShared<FJsonObject>(*L.Requirements);
			Next.Requirements->SetArrayField(TEXT("targets"), Array(Request, TEXT("targets")));
			if (auto Error = Select(Next))
				return Error;
			TSet<FString> TransitionalActors;
			for (const auto &A : L.Actors)
				TransitionalActors.Add(A.Container() + TEXT(":") + A.Guid());
			for (const auto &A : Next.Actors)
				TransitionalActors.Add(A.Container() + TEXT(":") + A.Guid());
			if (TransitionalActors.Num() > L.Requirements->GetIntegerField(TEXT("maximumActors")))
				return Fail(TEXT("budget_exceeded"),
							TEXT("Replacement overlap exceeds maximumActors. Replace with an empty "
								 "selection before moving to a disjoint area, or increase the "
								 "initial budget."));
			// Keep the old region available during admission/loading, then release only this
			// owner's references.
			Load(Next);
			if (L.Loader)
				L.Loader->Unload();
			L.Loader = MoveTemp(Next.Loader);
			L.Actors = MoveTemp(Next.Actors);
			L.Regions = MoveTemp(Next.Regions);
			L.Requirements = Next.Requirements;
			L.Revision = Revision;
			L.LastReplacement = MakeShared<FJsonObject>(*Request);
		}
		return RenewedSnapshot(L);
	}
	auto *World = EditorWorld();
	if (!World)
		return Fail(TEXT("editor_required"),
					TEXT("An editor world is required with Play and Simulate stopped."));
	auto Identity = WorldIdentity(World);
	if (Action == TEXT("describe"))
	{
		if (!Fields(Request, {TEXT("contract"), TEXT("action")}))
			return Fail(TEXT("invalid_request"),
						TEXT("Describe takes only its action and contract."));
		auto O = Obj();
		O->SetStringField(TEXT("status"), TEXT("described"));
		O->SetObjectField(TEXT("world"), Identity);
		return O;
	}
	const bool Acquire = Action == TEXT("acquire"), Plan = Action == TEXT("plan");
	if ((!Acquire && !Plan) ||
		!(Acquire ? Fields(Request, {TEXT("contract"), TEXT("action"), TEXT("leaseId"),
									 TEXT("leaseMs"), TEXT("requirements")})
				  : Fields(Request, {TEXT("contract"), TEXT("action"), TEXT("requirements")})) ||
		!ValidRequirements(Child(Request, TEXT("requirements"))) ||
		(Acquire && (!Identifier(Request, TEXT("leaseId")) ||
					 !Number(Request, TEXT("leaseMs"), 1000, 120000))))
		return Fail(TEXT("invalid_request"),
					TEXT("Invalid world requirements or acquisition limits."));
	auto Requirements = Child(Request, TEXT("requirements")),
		 Expected = Child(Requirements, TEXT("world"));
	for (const TCHAR *Key : {TEXT("worldId"), TEXT("mapPath"), TEXT("projectName")})
		if (Str(Expected, Key) != Str(Identity, Key))
			return Fail(TEXT("world_changed"),
						TEXT("Describe the current editor world before preparing it."));
	if (Expected->GetBoolField(TEXT("partitioned")) !=
			Identity->GetBoolField(TEXT("partitioned")) ||
		Expected->GetBoolField(TEXT("streamingEnabled")) !=
			Identity->GetBoolField(TEXT("streamingEnabled")))
		return Fail(TEXT("world_changed"), TEXT("World streaming policy changed."));
	const FString Id = Acquire ? Str(Request, TEXT("leaseId")) : TEXT("plan");
	if (Acquire)
	{
		if (auto *Existing = Leases.Find(Id))
		{
			if (!(*Existing)->Input)
				return Fail(TEXT("lease_released"),
							TEXT("This lease was cancelled before acquisition. Use a new identity "
								 "for new work."));
			if (!FJsonValue::CompareEqual(FJsonValueObject((*Existing)->Input),
										  FJsonValueObject(Request)))
				return Fail(TEXT("lease_conflict"),
							TEXT("Lease identity already belongs to different requirements."));
			return (*Existing)->Closed ? Snapshot(**Existing) : RenewedSnapshot(**Existing);
		}
		if (auto Error = AdmissionFailure(true))
			return Error;
	}
	auto L = MakeShared<FLease>();
	L->Id = Id;
	L->Requirements = Requirements;
	L->World = Identity;
	L->WorldPtr = World;
	L->Input = MakeShared<FJsonObject>(*Request);
	if (auto Error = Select(*L))
		return Error;
	if (Plan)
	{
		if (auto Error = ApplyLayers(*L, true))
			return Error;
		return Snapshot(*L, true);
	}
	if (auto Error = ApplyLayers(*L))
	{
		Close(*L);
		return Error;
	}
	L->LeaseSeconds = Request->GetNumberField(TEXT("leaseMs")) / 1000;
	Load(*L);
	Leases.Add(Id, L);
	return RenewedSnapshot(*L);
}
void FUEShedWorldPreparation::Startup()
{
	TickHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([](float) {
														  Sweep();
														  return true;
													  }),
													  0.25f);
	WorldHandle = FWorldDelegates::OnWorldCleanup.AddLambda([](UWorld *W, bool, bool) {
		for (auto &Pair : Leases)
			if (Pair.Value->WorldPtr.Get() == W)
				Close(*Pair.Value);
		if (CurrentWorld.Get() == W)
		{
			CurrentWorld.Reset();
			CurrentWorldId.Empty();
		}
	});
	PIEHandle = FEditorDelegates::PreBeginPIE.AddLambda([](bool) {
		for (auto &Pair : Leases)
			Close(*Pair.Value);
	});
}
void FUEShedWorldPreparation::Shutdown()
{
	FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
	FWorldDelegates::OnWorldCleanup.Remove(WorldHandle);
	FEditorDelegates::PreBeginPIE.Remove(PIEHandle);
	for (auto &Pair : Leases)
		Close(*Pair.Value);
	Leases.Empty();
	CurrentWorld.Reset();
	CurrentWorldId.Empty();
}
void UUEShedWorldLibrary::ExecuteWorldPreparation(const FString &RequestJson, FString &ResultJson)
{
	FJson Request;
	const bool Parsed =
		RequestJson.Len() <= 1024 * 1024 &&
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RequestJson), Request);
	ResultJson =
		JsonText(Parsed ? FUEShedWorldPreparation::Execute(Request)
						: Fail(TEXT("invalid_request"),
							   TEXT("Expected a JSON object no larger than one megacharacter.")));
}
