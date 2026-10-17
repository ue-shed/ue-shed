#pragma once

#include "CoreMinimal.h"
#include "TickableEditorObject.h"

class UWorld;
class AActor;

/**
 * Demand-driven actor transform stream for the Observatory control plane.
 *
 * FTickableEditorObject ticks on the editor game thread (see EditorEngine.cpp), which is the same
 * thread that owns UObjects and GEditor. ObservedWorld() prefers GEditor->PlayWorld during PIE and
 * otherwise uses the editor world, so sampling stays aligned with GetActorSnapshot/FocusActor
 * whether the operator is editing or simulating.
 */
class FUEShedObservatoryStreamService final : public FTickableEditorObject
{
public:
	FUEShedObservatoryStreamService();
	~FUEShedObservatoryStreamService() override;

	void StartActorObservation(const FString& RequestJson, FString& ResultJson);
	void StopActorObservation(FString& ResultJson);
	void SetActorObservationCadence(const FString& RequestJson, FString& ResultJson);
	void GetActorObservationStatus(FString& ResultJson) const;

	void Tick(float DeltaTime) override;
	bool IsTickable() const override;
	ETickableTickType GetTickableTickType() const override;
	TStatId GetStatId() const override;

private:
	struct FCatalogActorEntry;

	void BindDelegates();
	void UnbindDelegates();
	void StopActorObservationInternal();
	void RequestCatalogInvalidation();
	void RebuildCatalogIfNeeded(UWorld* World, bool bIsPie);
	void EmitResetPacket(UWorld* World);
	void SampleIfDue(UWorld* World, bool bIsPie);
	TArray<uint8> BuildPacketBytes(
		UWorld* World,
		uint16 Flags,
		const TArray<FCatalogActorEntry*>& ChangedEntries,
		uint32 ActorsSampled,
		uint32 ActorsChanged,
		uint32 SamplingDurationMicros) const;
	FString BuildPipeName() const;
	TSharedRef<FJsonObject> BuildCatalogSnapshotJson(UWorld* World, bool bIsPie) const;
	bool PassesActorFilter(const AActor* Actor, FBox& OutBounds);
	static UWorld* ObservedWorld(bool& bOutIsPie);

	void OnMapChanged(uint32 MapChangeFlags);
	void OnPieTransition(bool bIsSimulating);
	void OnLevelActorAdded(AActor* Actor);
	void OnLevelActorDeleted(AActor* Actor);

	static constexpr int32 MaxActors = 16384;
	static constexpr int32 MaxCadenceHz = 60;
	static constexpr int32 HeaderBytes = 96;
	static constexpr int32 RecordBytes = 48;
	static constexpr uint16 FlagReset = 0x0001;

	bool bActive = false;
	bool bCatalogDirty = true;
	bool bDelegatesBound = false;
	int32 CadenceHz = 5;
	double NextSampleSeconds = 0;
	uint64 CatalogRevision = 0;
	uint64 PacketSequence = 0;
	uint64 ResetCount = 0;
	FGuid SessionId;
	FString ObservedWorldPath;
	FString ObservedWorldKind;

	TArray<FCatalogActorEntry> Catalog;
	TUniquePtr<struct FObservatoryStreamWriterImpl> WriterImpl;

	uint64 SamplesAttempted = 0;
	uint64 SamplesDelivered = 0;
	uint64 ActorsSampledTotal = 0;
	uint64 ActorsChangedTotal = 0;
	uint64 CatalogRebuilds = 0;
	uint64 BoundsCalculations = 0;
	uint64 TotalSamplingMicros = 0;
	uint64 MaxSamplingMicros = 0;
	uint64 SamplingSamples = 0;

	FDelegateHandle MapChangeHandle;
	FDelegateHandle BeginPieHandle;
	FDelegateHandle EndPieHandle;
	FDelegateHandle ActorAddedHandle;
	FDelegateHandle ActorDeletedHandle;
};

/** Module-owned singleton; created at startup and torn down at shutdown. */
FUEShedObservatoryStreamService& GetObservatoryStreamService();
/** The stream service, or null outside the module's lifetime (a Remote Control call during shutdown). */
FUEShedObservatoryStreamService* FindObservatoryStreamService();
