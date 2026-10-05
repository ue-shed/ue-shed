#include "UEShedEditorPreviews.h"

#include "Components/ChildActorComponent.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "UObject/Package.h"

namespace
{
struct FHold
{
	int32 Holders = 0;
	bool bSuspended = false;
};

// Game-thread ledger of every revealed child, shared by all holders.
TMap<TWeakObjectPtr<AActor>, FHold>& Ledger()
{
	static TMap<TWeakObjectPtr<AActor>, FHold> Value;
	return Value;
}

// Mirrors UChildActorComponent::CreateChildActor, which marks the child editor-only when the
// component or its owner is. An owner revealed by any holder was editor-only before it began.
bool IsEditorPreview(const AActor* Actor, const TSet<const AActor*>& Revealed)
{
	if (Actor == nullptr || !Actor->bIsEditorOnlyActor) return false;
	const UChildActorComponent* Parent = Actor->GetParentComponent();
	if (Parent == nullptr || Parent->GetChildActor() != Actor) return false;
	const AActor* Owner = Parent->GetOwner();
	return Parent->IsEditorOnly() ||
		(Owner != nullptr && (Owner->IsEditorOnly() || Revealed.Contains(Owner)));
}
}

int32 FUEShedEditorPreviews::Apply(UWorld* World)
{
	check(IsInGameThread());
	auto& Shared = Ledger();
	for (auto It = Shared.CreateIterator(); It; ++It)
		if (!It.Key().IsValid()) It.RemoveCurrent();
	Revealed.RemoveAll([](const TWeakObjectPtr<AActor>& Actor) { return !Actor.IsValid(); });
	if (World == nullptr) return Num();
	TSet<const AActor*> Mine;
	for (const auto& Actor : Revealed) Mine.Add(Actor.Get());
	TSet<const AActor*> Known;
	for (const auto& Entry : Shared) Known.Add(Entry.Key.Get());
	bool bChanged = false;
	// Rescanned per frame so children respawned by a construction script are also revealed.
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		AActor* Actor = *It;
		if (Mine.Contains(Actor))
		{
			// A held actor is editor-only again only after a save suspended it.
			if (!Actor->bIsEditorOnlyActor) continue;
			Actor->bIsEditorOnlyActor = false;
			Shared.FindOrAdd(Actor).bSuspended = false;
			Actor->MarkComponentsRenderStateDirty();
			bChanged = true;
			continue;
		}
		const bool bShared = Known.Contains(Actor);
		if (!bShared && !IsEditorPreview(Actor, Known)) continue;
		if (Actor->bIsEditorOnlyActor)
		{
			Actor->bIsEditorOnlyActor = false;
			if (Actor->IsEditorOnly())
			{
				// The class itself reports editor-only; it cannot be revealed by its flag.
				Actor->bIsEditorOnlyActor = true;
				continue;
			}
			Actor->MarkComponentsRenderStateDirty();
			bChanged = true;
		}
		FHold& Hold = Shared.FindOrAdd(Actor);
		Hold.bSuspended = false;
		++Hold.Holders;
		Known.Add(Actor);
		Mine.Add(Actor);
		Revealed.Add(Actor);
	}
	// Proxies cache owner editor-only state when created. Recreate them before the next render.
	if (bChanged) World->SendAllEndOfFrameUpdates();
	return Num();
}

void FUEShedEditorPreviews::Restore(bool bRecreateRenderState)
{
	if (Revealed.IsEmpty()) return;
	check(IsInGameThread());
	auto& Shared = Ledger();
	for (const auto& Weak : Revealed)
	{
		FHold* Hold = Shared.Find(Weak);
		if (Hold == nullptr || --Hold->Holders > 0) continue;
		Shared.Remove(Weak);
		if (AActor* Actor = Weak.Get())
		{
			Actor->bIsEditorOnlyActor = true;
			if (bRecreateRenderState) Actor->MarkComponentsRenderStateDirty();
		}
	}
	Revealed.Reset();
}

void FUEShedEditorPreviews::PreSave(UObject* Object)
{
	AActor* Actor = Cast<AActor>(Object);
	if (Actor == nullptr || Actor->bIsEditorOnlyActor) return;
	FHold* Hold = Ledger().Find(Actor);
	if (Hold == nullptr) return;
	// Existing proxies keep rendering the revealed state; only serialized data sees the original.
	Actor->bIsEditorOnlyActor = true;
	Hold->bSuspended = true;
}

void FUEShedEditorPreviews::PostSave(const UPackage* Package)
{
	for (auto& Entry : Ledger())
	{
		if (!Entry.Value.bSuspended) continue;
		AActor* Actor = Entry.Key.Get();
		if (Actor != nullptr && Actor->GetPackage() != Package) continue;
		Entry.Value.bSuspended = false;
		if (Actor == nullptr) continue;
		Actor->bIsEditorOnlyActor = false;
		Actor->MarkComponentsRenderStateDirty();
	}
}

int32 FUEShedEditorPreviews::Num() const
{
	int32 Count = 0;
	for (const auto& Actor : Revealed) Count += Actor.IsValid() ? 1 : 0;
	return Count;
}
