#pragma once

#include "CoreMinimal.h"

class AActor;
class UObject;
class UPackage;
class UWorld;

/**
 * Reversible reveal of child actors that ChildActorComponents spawn for editor-only owners.
 *
 * UChildActorComponent marks those children editor-only, and a primitive proxy whose owner is
 * editor-only is hidden whenever the Game show flag is set, which both the game-view viewport and
 * SceneCapture use. Only the child actors' own bIsEditorOnlyActor flag changes. Owners, other
 * editor-only actors and every component keep their state, so billboards, volumes and the owner's
 * visualization stay hidden. The flag is serialized: saves see the original value.
 *
 * Each instance is one holder. Holders share a reference-counted ledger, so a render session, the
 * camera panel's review and the provisioned live feed can reveal the same child at once: the child
 * stays revealed while any holder holds it, and its flag is restored only when the last releases it.
 */
class FUEShedEditorPreviews
{
public:
	FUEShedEditorPreviews() = default;
	FUEShedEditorPreviews(const FUEShedEditorPreviews&) = delete;
	FUEShedEditorPreviews& operator=(const FUEShedEditorPreviews&) = delete;

	/** Reveals newly qualifying children and flushes their render state. Returns the held count. */
	int32 Apply(UWorld* World);
	/** Releases this holder. Flags return once no holder remains. World teardown skips render state. */
	void Restore(bool bRecreateRenderState);
	/** Writes the original flag back before any revealed actor is serialized. Shared by all holders. */
	static void PreSave(UObject* Object);
	/** Re-reveals actors suspended for this package after it was saved. Shared by all holders. */
	static void PostSave(const UPackage* Package);
	/** Actors this holder keeps revealed. */
	int32 Num() const;

private:
	TArray<TWeakObjectPtr<AActor>> Revealed;
};
