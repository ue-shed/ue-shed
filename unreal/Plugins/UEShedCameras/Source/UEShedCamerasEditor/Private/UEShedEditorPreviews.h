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
 */
class FUEShedEditorPreviews
{
public:
	/** Reveals newly qualifying children and flushes their render state. Returns the revealed count. */
	int32 Apply(UWorld* World);
	/** Restores every flag this owner cleared. World teardown skips render-state recreation. */
	void Restore(bool bRecreateRenderState);
	/** Writes the original flag back before a revealed actor is serialized. */
	void PreSave(UObject* Object);
	/** Re-reveals actors suspended for this package after it was saved. */
	void PostSave(const UPackage* Package);
	int32 Num() const;

private:
	TArray<TWeakObjectPtr<AActor>> Revealed;
	TArray<TWeakObjectPtr<AActor>> Suspended;
};
