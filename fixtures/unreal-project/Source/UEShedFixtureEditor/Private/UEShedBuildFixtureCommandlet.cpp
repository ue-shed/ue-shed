#include "UEShedBuildFixtureCommandlet.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Engine/CompositeDataTable.h"
#include "Engine/DataTable.h"
#include "Engine/DirectionalLight.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Components/StaticMeshComponent.h"
#include "Factories/WorldFactory.h"
#include "HAL/FileManager.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UEShedAuthoringLibrary.h"
#include "UEShedFixtureTypes.h"
#include "UEShedFixtureMover.h"
#include "UEShedCameraSource.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEShedBuildFixtureCommandlet)

namespace
{
constexpr int32 CameraFixtureCount = 32;

struct FFixtureTableDefinition
{
	const TCHAR* AssetName;
	const TCHAR* PackageName;
	const TCHAR* SourcePath;
	UScriptStruct* RowStruct;
};

TArray<FFixtureTableDefinition> GetTableDefinitions()
{
	return {
		{ TEXT("DT_Scalars"), TEXT("/Game/Fixture/Authoring/DT_Scalars"),
			TEXT("FixtureSource/Authoring/DT_Scalars.json"),
			FUEShedFixtureScalarsRow::StaticStruct() },
		{ TEXT("DT_ScalarsOverride"), TEXT("/Game/Fixture/Authoring/DT_ScalarsOverride"),
			TEXT("FixtureSource/Authoring/DT_ScalarsOverride.json"),
			FUEShedFixtureScalarsRow::StaticStruct() },
		{ TEXT("DT_Enums"), TEXT("/Game/Fixture/Authoring/DT_Enums"),
			TEXT("FixtureSource/Authoring/DT_Enums.json"), FUEShedFixtureEnumRow::StaticStruct() },
		{ TEXT("DT_Structs"), TEXT("/Game/Fixture/Authoring/DT_Structs"),
			TEXT("FixtureSource/Authoring/DT_Structs.json"), FUEShedFixtureStructRow::StaticStruct() },
		{ TEXT("DT_Text"), TEXT("/Game/Fixture/Authoring/DT_Text"),
			TEXT("FixtureSource/Authoring/DT_Text.json"), FUEShedFixtureTextRow::StaticStruct() },
		{ TEXT("DT_AssetReferences"), TEXT("/Game/Fixture/Authoring/DT_AssetReferences"),
			TEXT("FixtureSource/Authoring/DT_AssetReferences.json"),
			FUEShedFixtureAssetReferenceRow::StaticStruct() },
		{ TEXT("DT_RightReferences"), TEXT("/Game/Fixture/Authoring/DT_RightReferences"),
			TEXT("FixtureSource/Authoring/DT_RightReferences.json"),
			FUEShedFixtureRightReferenceRow::StaticStruct() },
		{ TEXT("DT_LeftReferences"), TEXT("/Game/Fixture/Authoring/DT_LeftReferences"),
			TEXT("FixtureSource/Authoring/DT_LeftReferences.json"),
			FUEShedFixtureLeftReferenceRow::StaticStruct() },
		{ TEXT("DT_Containers"), TEXT("/Game/Fixture/Authoring/DT_Containers"),
			TEXT("FixtureSource/Authoring/DT_Containers.json"),
			FUEShedFixtureContainerRow::StaticStruct() },
		{ TEXT("DT_Opaque"), TEXT("/Game/Fixture/Authoring/DT_Opaque"),
			TEXT("FixtureSource/Authoring/DT_Opaque.json"), FUEShedFixtureOpaqueRow::StaticStruct() }
	};
}

FString ObjectPath(const FFixtureTableDefinition& Definition)
{
	return FString::Printf(TEXT("%s.%s"), Definition.PackageName, Definition.AssetName);
}

bool SaveAsset(UPackage* Package, UObject* Asset)
{
	const FString Filename = FPackageName::LongPackageNameToFilename(
		Package->GetName(), Asset->IsA<UWorld>()
			? FPackageName::GetMapPackageExtension()
			: FPackageName::GetAssetPackageExtension());
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);

	FSavePackageArgs SaveArgs;
	SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
	SaveArgs.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Asset, *Filename, SaveArgs);
}

UPackage* FindOrCreatePackage(const TCHAR* PackageName)
{
	FString ExistingFilename;
	if (FPackageName::DoesPackageExist(PackageName, &ExistingFilename))
	{
		return LoadPackage(nullptr, PackageName, LOAD_None);
	}

	return CreatePackage(PackageName);
}

bool GenerateTable(const FFixtureTableDefinition& Definition)
{
	const FString SourceFilename = FPaths::ConvertRelativePathToFull(
		FPaths::ProjectDir(), Definition.SourcePath);
	FString Json;
	if (!FFileHelper::LoadFileToString(Json, *SourceFilename))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not read fixture source %s"), *SourceFilename);
		return false;
	}

	UPackage* Package = FindOrCreatePackage(Definition.PackageName);
	if (Package == nullptr)
	{
		UE_LOG(LogTemp, Error, TEXT("Could not create package %s"), Definition.PackageName);
		return false;
	}

	UDataTable* Table = FindObject<UDataTable>(Package, Definition.AssetName);
	const bool WasCreated = Table == nullptr;
	if (WasCreated)
	{
		Table = NewObject<UDataTable>(
			Package, Definition.AssetName, RF_Public | RF_Standalone | RF_Transactional);
	}

	if (!WasCreated)
	{
		if (Table->RowStruct == nullptr)
		{
			Table->RowStruct = Definition.RowStruct;
		}
		Table->EmptyTable();
	}
	Table->RowStruct = Definition.RowStruct;
	const TArray<FString> Problems = Table->CreateTableFromJSONString(Json);
	for (const FString& Problem : Problems)
	{
		UE_LOG(LogTemp, Error, TEXT("%s: %s"), Definition.AssetName, *Problem);
	}
	if (!Problems.IsEmpty())
	{
		return false;
	}

	if (WasCreated)
	{
		FAssetRegistryModule::AssetCreated(Table);
	}
	Package->MarkPackageDirty();
	if (!SaveAsset(Package, Table))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not save %s"), Definition.PackageName);
		return false;
	}

	UE_LOG(LogTemp, Display, TEXT("Generated %s with %d rows"),
		*ObjectPath(Definition), Table->GetRowMap().Num());
	return true;
}

bool GenerateComposite()
{
	static const TCHAR* PackageName = TEXT("/Game/Fixture/Authoring/CDT_Scalars");
	static const TCHAR* AssetName = TEXT("CDT_Scalars");

	UDataTable* Base = LoadObject<UDataTable>(
		nullptr, TEXT("/Game/Fixture/Authoring/DT_Scalars.DT_Scalars"));
	UDataTable* Override = LoadObject<UDataTable>(
		nullptr, TEXT("/Game/Fixture/Authoring/DT_ScalarsOverride.DT_ScalarsOverride"));
	if (Base == nullptr || Override == nullptr)
	{
		UE_LOG(LogTemp, Error, TEXT("Could not load composite parent tables"));
		return false;
	}

	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr)
	{
		return false;
	}

	UCompositeDataTable* Composite = FindObject<UCompositeDataTable>(Package, AssetName);
	const bool WasCreated = Composite == nullptr;
	if (WasCreated)
	{
		Composite = NewObject<UCompositeDataTable>(
			Package, AssetName, RF_Public | RF_Standalone | RF_Transactional);
	}

	if (!WasCreated)
	{
		if (Composite->RowStruct == nullptr)
		{
			Composite->RowStruct = FUEShedFixtureScalarsRow::StaticStruct();
		}
		Composite->EmptyTable();
	}
	Composite->RowStruct = FUEShedFixtureScalarsRow::StaticStruct();
	Composite->AppendParentTables({ Base, Override });
	if (WasCreated)
	{
		FAssetRegistryModule::AssetCreated(Composite);
	}
	Package->MarkPackageDirty();
	if (!SaveAsset(Package, Composite))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not save %s"), PackageName);
		return false;
	}

	UE_LOG(LogTemp, Display, TEXT("Generated %s.%s with %d composed rows"),
		PackageName, AssetName, Composite->GetRowMap().Num());
	return true;
}

bool VerifyTable(const FFixtureTableDefinition& Definition)
{
	UDataTable* Table = LoadObject<UDataTable>(nullptr, *ObjectPath(Definition));
	if (Table == nullptr)
	{
		UE_LOG(LogTemp, Error, TEXT("Missing fixture table %s"), *ObjectPath(Definition));
		return false;
	}
	if (Table->GetRowStruct() != Definition.RowStruct)
	{
		UE_LOG(LogTemp, Error, TEXT("Unexpected row struct for %s: %s"),
			*ObjectPath(Definition), *GetNameSafe(Table->GetRowStruct()));
		return false;
	}
	if (Table->GetRowMap().IsEmpty())
	{
		UE_LOG(LogTemp, Error, TEXT("Fixture table %s has no rows"), *ObjectPath(Definition));
		return false;
	}

	const FString SourceFilename = FPaths::ConvertRelativePathToFull(
		FPaths::ProjectDir(), Definition.SourcePath);
	FString Json;
	if (!FFileHelper::LoadFileToString(Json, *SourceFilename))
	{
		return false;
	}
	TArray<TSharedPtr<FJsonValue>> SourceRows;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
	if (!FJsonSerializer::Deserialize(Reader, SourceRows))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not parse fixture source %s"), *SourceFilename);
		return false;
	}

	TArray<FName> ExpectedRowNames;
	for (const TSharedPtr<FJsonValue>& SourceRow : SourceRows)
	{
		const TSharedPtr<FJsonObject> RowObject = SourceRow->AsObject();
		FString RowName;
		if (!RowObject.IsValid() || !RowObject->TryGetStringField(TEXT("Name"), RowName))
		{
			return false;
		}
		ExpectedRowNames.Add(FName(RowName));
	}

	const TArray<FName> ActualRowNames = Table->GetRowNames();
	if (ActualRowNames != ExpectedRowNames)
	{
		UE_LOG(LogTemp, Error, TEXT("Unexpected row order for %s"), *ObjectPath(Definition));
		return false;
	}
	return true;
}

bool VerifyComposite()
{
	UCompositeDataTable* Composite = LoadObject<UCompositeDataTable>(
		nullptr, TEXT("/Game/Fixture/Authoring/CDT_Scalars.CDT_Scalars"));
	if (Composite == nullptr || Composite->GetRowStruct() != FUEShedFixtureScalarsRow::StaticStruct())
	{
		UE_LOG(LogTemp, Error, TEXT("Composite fixture table is missing or has the wrong row struct"));
		return false;
	}

	const TArray<FName> ExpectedRows = {
		TEXT("Scalar_Alpha"), TEXT("Scalar_Beta"), TEXT("Scalar_Gamma")
	};
	for (const FName RowName : ExpectedRows)
	{
		if (!Composite->GetRowMap().Contains(RowName))
		{
			UE_LOG(LogTemp, Error, TEXT("Composite fixture table is missing row %s"), *RowName.ToString());
			return false;
		}
	}
	return Composite->GetRowMap().Num() == ExpectedRows.Num();
}

bool GenerateCameraMap()
{
	static const TCHAR* PackageName = TEXT("/Game/Fixture/Cameras/L_CameraLoad");
	static const TCHAR* AssetName = TEXT("L_CameraLoad");
	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr) return false;
	UWorld* World = UWorld::FindWorldInPackage(Package);
	const bool bCreatedWorld = World == nullptr;
	if (World == nullptr)
	{
		UWorldFactory* Factory = NewObject<UWorldFactory>();
		Factory->WorldType = EWorldType::Editor;
		Factory->bCreateWorldPartition = false;
		World = Cast<UWorld>(Factory->FactoryCreateNew(UWorld::StaticClass(), Package, AssetName,
			RF_Public | RF_Standalone, nullptr, GWarn));
	}
	if (World == nullptr) return false;
	if (!bCreatedWorld)
	{
		int32 ExistingMovers = 0;
		int32 ExistingCameras = 0;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (Actor == nullptr) continue;
			ExistingMovers += Actor->IsA<AUEShedFixtureMover>() ? 1 : 0;
			ExistingCameras += Actor->IsA<AUEShedCameraSource>() ? 1 : 0;
		}
		bool bAllCamerasBound = true;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (const AUEShedCameraSource* Camera = Cast<AUEShedCameraSource>(Actor))
			{
				bAllCamerasBound = bAllCamerasBound && Camera->ObservationTarget != nullptr;
			}
		}
		if (ExistingMovers == CameraFixtureCount && ExistingCameras == CameraFixtureCount
			&& bAllCamerasBound)
		{
			UE_LOG(LogTemp, Display, TEXT("Camera fixture map already matches its contract"));
			return true;
		}
	}

	TArray<AActor*> Existing;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor != nullptr && (Actor->ActorHasTag(TEXT("UEShedCameraFixture"))
			|| Actor->IsA<AUEShedFixtureMover>() || Actor->IsA<AUEShedCameraSource>()))
			Existing.Add(Actor);
	}
	for (AActor* Actor : Existing) World->EditorDestroyActor(Actor, true);

	AStaticMeshActor* Floor = World->SpawnActor<AStaticMeshActor>(FVector(0, 0, -80), FRotator::ZeroRotator);
	Floor->Tags.Add(TEXT("UEShedCameraFixture"));
	Floor->SetActorLabel(TEXT("Observation Floor"));
	Floor->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Plane.Plane")));
	Floor->SetActorScale3D(FVector(45, 45, 1));

	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector::ZeroVector,
		FRotator(-45, -25, 0));
	Sun->Tags.Add(TEXT("UEShedCameraFixture"));
	Sun->SetActorLabel(TEXT("Fixture Sun"));
	ASkyLight* Sky = World->SpawnActor<ASkyLight>();
	Sky->Tags.Add(TEXT("UEShedCameraFixture"));
	Sky->SetActorLabel(TEXT("Fixture Sky"));

	for (int32 Index = 0; Index < CameraFixtureCount; ++Index)
	{
		const double Angle = UE_TWO_PI * Index / CameraFixtureCount;
		const double RingRadius = 850.0 + (Index % 4) * 260.0;
		const FVector Origin(FMath::Cos(Angle) * RingRadius,
			FMath::Sin(Angle) * RingRadius, 120.0);
		AUEShedFixtureMover* Mover = World->SpawnActor<AUEShedFixtureMover>(Origin, FRotator::ZeroRotator);
		Mover->Tags.Add(TEXT("UEShedCameraFixture"));
		Mover->LogicalIndex = Index;
		Mover->Motion = static_cast<EUEShedFixtureMotion>(Index % 3);
		Mover->Radius = 180.0f + Index * 18.0f;
		Mover->Speed = 0.45f + Index * 0.055f;
		Mover->SetActorLabel(FString::Printf(TEXT("Mover %02d"), Index + 1));

		const FVector CameraLocation(FMath::Cos(Angle) * 2600.0,
			FMath::Sin(Angle) * 2600.0, 1150.0 + (Index % 2) * 250.0);
		const FRotator CameraRotation = (Origin - CameraLocation).Rotation();
		AUEShedCameraSource* Camera = World->SpawnActor<AUEShedCameraSource>(
			CameraLocation, CameraRotation);
		Camera->Tags.Add(TEXT("UEShedCameraFixture"));
		Camera->CameraIndex = Index;
		Camera->CameraId = FGuid(0x55455348, 0x45444341, 0x4D000000 | Index, 0x00000001);
		Camera->ObservationTarget = Mover;
		Camera->SetActorLabel(FString::Printf(TEXT("Camera %02d"), Index + 1));
	}

	Package->MarkPackageDirty();
	const bool bSaved = SaveAsset(Package, World);
	if (bCreatedWorld) World->CleanupWorld();
	if (!bSaved) return false;
	UE_LOG(LogTemp, Display, TEXT("Generated %s with %d movers and %d camera sources"),
		PackageName, CameraFixtureCount, CameraFixtureCount);
	return true;
}

bool VerifyCameraMap()
{
	UPackage* Package = LoadPackage(nullptr, TEXT("/Game/Fixture/Cameras/L_CameraLoad"), LOAD_None);
	UWorld* World = Package == nullptr ? nullptr : UWorld::FindWorldInPackage(Package);
	if (World == nullptr) return false;
	int32 Movers = 0;
	int32 Cameras = 0;
	int32 BoundCameras = 0;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor == nullptr) continue;
		Movers += Actor->IsA<AUEShedFixtureMover>() ? 1 : 0;
		Cameras += Actor->IsA<AUEShedCameraSource>() ? 1 : 0;
		if (const AUEShedCameraSource* Camera = Cast<AUEShedCameraSource>(Actor))
		{
			BoundCameras += Camera->ObservationTarget != nullptr ? 1 : 0;
		}
	}
	UE_LOG(LogTemp, Display,
		TEXT("Camera fixture verification found %d movers, %d cameras, and %d POV bindings"),
		Movers, Cameras, BoundCameras);
	return Movers == CameraFixtureCount && Cameras == CameraFixtureCount
		&& BoundCameras == CameraFixtureCount;
}
}

UUEShedBuildFixtureCommandlet::UUEShedBuildFixtureCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UUEShedBuildFixtureCommandlet::Main(const FString& Params)
{
	const TArray<FFixtureTableDefinition> Definitions = GetTableDefinitions();
	FString ApplyRequestPath;
	FString ApplyOutputPath;
	if (FParse::Value(*Params, TEXT("ApplyRequest="), ApplyRequestPath)
		&& FParse::Value(*Params, TEXT("ApplyOutput="), ApplyOutputPath))
	{
		FString RequestJson;
		if (!FFileHelper::LoadFileToString(
			RequestJson, *FPaths::ConvertRelativePathToFull(ApplyRequestPath))) return 1;
		FString ResultJson;
		UUEShedAuthoringLibrary::Apply(RequestJson, ResultJson);
		bool bSucceeded = FFileHelper::SaveStringToFile(
			ResultJson, *FPaths::ConvertRelativePathToFull(ApplyOutputPath));
		FString LookupOperation;
		FString LookupOutput;
		if (FParse::Value(*Params, TEXT("LookupOperation="), LookupOperation)
			&& FParse::Value(*Params, TEXT("LookupOutput="), LookupOutput))
		{
			FString LookupJson;
			UUEShedAuthoringLibrary::LookupApplyResult(LookupOperation, LookupJson);
			bSucceeded = FFileHelper::SaveStringToFile(
				LookupJson, *FPaths::ConvertRelativePathToFull(LookupOutput)) && bSucceeded;
		}
		FString SaveAfterApplyRequest;
		FString SaveAfterApplyOutput;
		if (FParse::Value(*Params, TEXT("SaveAfterApplyRequest="), SaveAfterApplyRequest)
			&& FParse::Value(*Params, TEXT("SaveAfterApplyOutput="), SaveAfterApplyOutput))
		{
			FString SaveRequestJson;
			FString SaveResultJson;
			bSucceeded = FFileHelper::LoadFileToString(SaveRequestJson,
				*FPaths::ConvertRelativePathToFull(SaveAfterApplyRequest)) && bSucceeded;
			UUEShedAuthoringLibrary::Save(SaveRequestJson, SaveResultJson);
			bSucceeded = FFileHelper::SaveStringToFile(SaveResultJson,
				*FPaths::ConvertRelativePathToFull(SaveAfterApplyOutput)) && bSucceeded;
		}
		return bSucceeded ? 0 : 1;
	}

	FString SaveRequestPath;
	FString SaveOutputPath;
	if (FParse::Value(*Params, TEXT("SaveRequest="), SaveRequestPath)
		&& FParse::Value(*Params, TEXT("SaveOutput="), SaveOutputPath))
	{
		FString RequestJson;
		if (!FFileHelper::LoadFileToString(
			RequestJson, *FPaths::ConvertRelativePathToFull(SaveRequestPath))) return 1;
		FString ResultJson;
		UUEShedAuthoringLibrary::Save(RequestJson, ResultJson);
		return FFileHelper::SaveStringToFile(
			ResultJson, *FPaths::ConvertRelativePathToFull(SaveOutputPath)) ? 0 : 1;
	}

	FString SnapshotDirectory;
	if (FParse::Value(*Params, TEXT("SnapshotDirectory="), SnapshotDirectory))
	{
		const FString OutputDirectory = FPaths::ConvertRelativePathToFull(SnapshotDirectory);
		IFileManager::Get().MakeDirectory(*OutputDirectory, true);
		bool bSucceeded = true;
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			FString SnapshotJson;
			UUEShedAuthoringLibrary::GetTableSnapshot(ObjectPath(Definition), SnapshotJson);
			bSucceeded = FFileHelper::SaveStringToFile(
				SnapshotJson, *FPaths::Combine(OutputDirectory,
					FString(Definition.AssetName) + TEXT(".json"))) && bSucceeded;
		}
		FString CompositeJson;
		UUEShedAuthoringLibrary::GetTableSnapshot(
			TEXT("/Game/Fixture/Authoring/CDT_Scalars.CDT_Scalars"), CompositeJson);
		bSucceeded = FFileHelper::SaveStringToFile(
			CompositeJson, *FPaths::Combine(OutputDirectory, TEXT("CDT_Scalars.json")))
			&& bSucceeded;
		return bSucceeded ? 0 : 1;
	}

	FString SnapshotTable;
	FString SnapshotOutput;
	if (FParse::Value(*Params, TEXT("SnapshotTable="), SnapshotTable)
		&& FParse::Value(*Params, TEXT("SnapshotOutput="), SnapshotOutput))
	{
		FString SnapshotJson;
		UUEShedAuthoringLibrary::GetTableSnapshot(SnapshotTable, SnapshotJson);
		const FString OutputPath = FPaths::ConvertRelativePathToFull(SnapshotOutput);
		IFileManager::Get().MakeDirectory(*FPaths::GetPath(OutputPath), true);
		return FFileHelper::SaveStringToFile(SnapshotJson, *OutputPath) ? 0 : 1;
	}

	const bool VerifyOnly = FParse::Param(*Params, TEXT("VerifyOnly"));

	bool Succeeded = true;
	if (!VerifyOnly)
	{
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			Succeeded = GenerateTable(Definition) && Succeeded;
		}
		Succeeded = GenerateComposite() && Succeeded;
		Succeeded = GenerateCameraMap() && Succeeded;
	}
	else
	{
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			Succeeded = VerifyTable(Definition) && Succeeded;
		}
		Succeeded = VerifyComposite() && Succeeded;
		Succeeded = VerifyCameraMap() && Succeeded;
	}

	UE_LOG(LogTemp, Display, TEXT("UE Shed fixture %s %s"),
		VerifyOnly ? TEXT("verification") : TEXT("generation"),
		Succeeded ? TEXT("succeeded") : TEXT("failed"));
	return Succeeded ? 0 : 1;
}
