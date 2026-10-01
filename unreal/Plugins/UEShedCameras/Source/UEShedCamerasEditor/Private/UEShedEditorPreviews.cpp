#include "UEShedEditorPreviews.h"

#include "Components/ChildActorComponent.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "UObject/Package.h"

namespace
{
// Mirrors UChildActorComponent::CreateChildActor, which marks the child editor-only when the
// component or its owner is. An owner revealed by this session was editor-only before it began.
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
	Revealed.RemoveAll([](const TWeakObjectPtr<AActor>& Actor) { return !Actor.IsValid(); });
	if (World == nullptr) return Num();
	TSet<const AActor*> Known;
	for (const auto& Actor : Revealed) Known.Add(Actor.Get());
	bool bChanged = false;
	// Rescanned per frame so children respawned by a construction script are also revealed.
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		AActor* Actor = *It;
		const bool bTracked = Known.Contains(Actor);
		// A tracked actor is editor-only again only after a save suspended it.
		if (bTracked ? !Actor->bIsEditorOnlyActor : !IsEditorPreview(Actor, Known)) continue;
		Actor->bIsEditorOnlyActor = false;
		if (Actor->IsEditorOnly())
		{
			// The class itself reports editor-only; it cannot be revealed by its flag.
			Actor->bIsEditorOnlyActor = true;
			continue;
		}
		if (!bTracked)
		{
			Revealed.Add(Actor);
			Known.Add(Actor);
		}
		Suspended.Remove(Actor);
		Actor->MarkComponentsRenderStateDirty();
		bChanged = true;
	}
	// Proxies cache owner editor-only state when created. Recreate them before the next render.
	if (bChanged) World->SendAllEndOfFrameUpdates();
	return Num();
}

void FUEShedEditorPreviews::Restore(bool bRecreateRenderState)
{
	for (const auto& Weak : Revealed)
		if (AActor* Actor = Weak.Get())
		{
			Actor->bIsEditorOnlyActor = true;
			if (bRecreateRenderState) Actor->MarkComponentsRenderStateDirty();
		}
	Revealed.Reset();
	Suspended.Reset();
}

void FUEShedEditorPreviews::PreSave(UObject* Object)
{
	AActor* Actor = Cast<AActor>(Object);
	if (Actor == nullptr || Actor->bIsEditorOnlyActor || !Revealed.Contains(Actor)) return;
	// Existing proxies keep rendering the revealed state; only serialized data sees the original.
	Actor->bIsEditorOnlyActor = true;
	Suspended.AddUnique(Actor);
}

void FUEShedEditorPreviews::PostSave(const UPackage* Package)
{
	for (int32 Index = Suspended.Num() - 1; Index >= 0; --Index)
	{
		AActor* Actor = Suspended[Index].Get();
		if (Actor != nullptr && Actor->GetPackage() != Package) continue;
		Suspended.RemoveAt(Index);
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
