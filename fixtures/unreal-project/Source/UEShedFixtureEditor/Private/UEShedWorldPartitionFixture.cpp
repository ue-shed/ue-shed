#include "UEShedWorldPartitionFixture.h"

#include "Components/StaticMeshComponent.h"
#include "DataLayer/DataLayerEditorSubsystem.h"
#include "Editor.h"
#include "Engine/DirectionalLight.h"
#include "Engine/StaticMeshActor.h"
#include "EngineUtils.h"
#include "FileHelpers.h"
#include "Misc/PackageName.h"
#include "Misc/ScopeExit.h"
#include "UObject/Package.h"
#include "WorldPartition/ActorDescContainerInstance.h"
#include "WorldPartition/DataLayer/DataLayerAsset.h"
#include "WorldPartition/DataLayer/DataLayerInstance.h"
#include "WorldPartition/LoaderAdapter/LoaderAdapterActorList.h"
#include "WorldPartition/WorldPartition.h"
#include "WorldPartition/WorldPartitionActorDescInstance.h"

namespace
{
constexpr TCHAR Map[] = TEXT("/Game/Fixture/WorldPartition/L_WorldPartitionStress");
constexpr int32 Side = 32;
constexpr int32 MeshCount = Side * Side * 5;

bool Verify()
{
	UWorld *World = UEditorLoadingAndSavingUtils::LoadMap(Map);
	if (!World || !World->GetWorldPartition() || !World->GetWorldPartition()->IsStreamingEnabled())
		return false;
	UWorldPartition *Partition = World->GetWorldPartition();
	int32 Count = 0;
	int32 Layered = 0;
	for (FActorDescContainerInstanceCollection::TIterator<> It(Partition); It; ++It)
	{
		if (It->GetActorLabel().ToString().StartsWith(TEXT("WP_")))
		{
			++Count;
			if (!It->GetDataLayers().IsEmpty())
				++Layered;
		}
	}
	if (Count != MeshCount || Layered != Side * Side * 4)
	{
		UE_LOG(LogTemp, Error, TEXT("WP fixture inventory mismatch: %d meshes, %d layered"), Count,
			   Layered);
		return false;
	}
	// Each pass starts with the previous loader released. Descriptor queries must not load actors.
	for (const FVector Center :
		 {FVector(0, 0, 0), FVector(150000, 150000, 0), FVector(-150000, -150000, 0)})
	{
		const FBox Region(Center - FVector(20000, 20000, 10000),
						  Center + FVector(20000, 20000, 10000));
		TArray<FWorldPartitionHandle> Selected;
		TArray<FWorldPartitionHandle> Distant;
		for (FActorDescContainerInstanceCollection::TIterator<> It(Partition); It; ++It)
		{
			if (!It->GetActorLabel().ToString().StartsWith(TEXT("WP_")))
				continue;
			FWorldPartitionHandle Handle(It->GetContainerInstance(), It->GetGuid());
			if (It->GetEditorBounds().Intersect(Region))
				Selected.Add(Handle);
			else
				Distant.Add(Handle);
		}
		if (Selected.Num() != 61)
			return false;
		for (const auto &Handle : Selected)
		{
			const AActor *Actor = Handle->GetActor(false);
			if (Actor && Actor->HasActorRegisteredAllComponents())
				return false;
		}
		FLoaderAdapterActorList Loader(World);
		ON_SCOPE_EXIT
		{
			Loader.Unload();
		};
		Loader.AddActors(Selected);
		for (const auto &Handle : Selected)
		{
			const AActor *Actor = Handle->GetActor(false);
			if (!Actor || !Actor->HasActorRegisteredAllComponents())
				return false;
		}
		for (const auto &Handle : Distant)
		{
			const AActor *Actor = Handle->GetActor(false);
			if (Actor && Actor->HasActorRegisteredAllComponents())
				return false;
		}
		Loader.Unload();
		for (const auto &Handle : Selected)
		{
			const AActor *Actor = Handle->GetActor(false);
			if (Actor && Actor->HasActorRegisteredAllComponents())
				return false;
		}
		UE_LOG(LogTemp, Display,
			   TEXT("WP fixture selective load/unload passed: center=%s selected=%d total=%d"),
			   *Center.ToString(), Selected.Num(), Count);
	}
	return !World->GetOutermost()->IsDirty();
}
} // namespace

bool BuildWorldPartitionStressFixture(bool bVerifyOnly)
{
	if (!GEditor)
		return false;
	if (bVerifyOnly)
		return Verify();
	if (FPackageName::DoesPackageExist(Map))
	{
		UE_LOG(LogTemp, Display,
			   TEXT("World Partition stress fixture exists; verifying without overwriting."));
		return Verify();
	}
	UWorld *World = GEditor->NewMap(true);
	if (!World || !World->GetWorldPartition())
		return false;
	World->GetWorldPartition()->SetEnableStreaming(true);
	if (!UEditorLoadingAndSavingUtils::SaveMap(World, Map))
		return false;
	TArray<UPackage *> Packages;
	auto *Layers = GEditor->GetEditorSubsystem<UDataLayerEditorSubsystem>();
	TArray<UDataLayerInstance *> Instances;
	for (const TCHAR *Name : {TEXT("Buildings"), TEXT("Vegetation"), TEXT("Props")})
	{
		const FString AssetName = FString(TEXT("DL_")) + Name;
		UPackage *Package =
			CreatePackage(*(FString(TEXT("/Game/Fixture/WorldPartition/")) + AssetName));
		auto *Asset = NewObject<UDataLayerAsset>(Package, *AssetName, RF_Public | RF_Standalone);
		FDataLayerCreationParameters Creation;
		Creation.DataLayerAsset = Asset;
		auto *Layer = Layers->CreateDataLayerInstance(Creation);
		if (!Layer)
			return false;
		Instances.Add(Layer);
		Package->MarkPackageDirty();
		Packages.Add(Package);
	}
	UStaticMesh *Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	UStaticMesh *Cone = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cone.Cone"));
	UStaticMesh *Sphere =
		LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	if (!Cube || !Cone || !Sphere)
		return false;
	for (int32 Y = 0; Y < Side; ++Y)
		for (int32 X = 0; X < Side; ++X)
		{
			const double Height = 500 * FMath::Sin(X * 0.4) * FMath::Cos(Y * 0.3);
			const FVector Center((X - Side / 2) * 12500, (Y - Side / 2) * 12500, Height);
			for (int32 Kind = 0; Kind < 5; ++Kind)
			{
				FActorSpawnParameters Spawn;
				Spawn.bCreateActorPackage = true;
				const FVector Offset =
					Kind == 0 ? FVector(0, 0, -500)
							  : FVector(Kind % 2 ? -2500 : 2500, Kind < 3 ? -2500 : 2500, 1000);
				auto *Actor = World->SpawnActor<AStaticMeshActor>(Center + Offset,
																  FRotator::ZeroRotator, Spawn);
				if (!Actor)
					return false;
				Actor->SetActorLabel(FString::Printf(TEXT("WP_%02d_%02d_%s"), X, Y,
													 Kind == 0	 ? TEXT("Ground")
													 : Kind == 3 ? TEXT("Tree")
													 : Kind == 4 ? TEXT("Prop")
													 : Kind == 1 ? TEXT("BuildingA")
																 : TEXT("BuildingB")));
				Actor->Tags.Add(TEXT("UEShedWorldPartitionStress"));
				Actor->GetStaticMeshComponent()->SetStaticMesh(Kind == 3   ? Cone
															   : Kind == 4 ? Sphere
																		   : Cube);
				Actor->SetActorScale3D(Kind == 0   ? FVector(125, 125, 10)
									   : Kind == 3 ? FVector(8, 8, 20)
									   : Kind == 4 ? FVector(10)
												   : FVector(12, 16, 20));
				if (Kind &&
					!Layers->AddActorToDataLayer(Actor, Instances[Kind <= 2 ? 0 : Kind - 2]))
					return false;
			}
		}
	FActorSpawnParameters LightSpawn;
	LightSpawn.bCreateActorPackage = true;
	auto *Sun = World->SpawnActor<ADirectionalLight>(FVector(0, 0, 100000), FRotator(-50, -35, 0),
													 LightSpawn);
	if (!Sun)
		return false;
	Sun->SetIsSpatiallyLoaded(false);
	Sun->SetActorLabel(TEXT("StressFixtureSun"));
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		UPackage *Package = It->GetExternalPackage();
		if (Package)
		{
			Package->MarkPackageDirty();
			Packages.AddUnique(Package);
		}
	}
	World->GetOutermost()->MarkPackageDirty();
	Packages.Add(World->GetOutermost());
	if (!UEditorLoadingAndSavingUtils::SavePackages(Packages, false))
		return false;
	UE_LOG(LogTemp, Display,
		   TEXT("Generated %s: %d mesh actors across 4 km x 4 km, three Data Layers."), Map,
		   MeshCount);
	return true;
}
