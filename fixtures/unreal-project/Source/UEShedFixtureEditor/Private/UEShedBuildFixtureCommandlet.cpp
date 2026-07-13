#include "UEShedBuildFixtureCommandlet.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Engine/CompositeDataTable.h"
#include "Engine/DataTable.h"
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
#include "UEShedFixtureTypes.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEShedBuildFixtureCommandlet)

namespace
{
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
		Package->GetName(), FPackageName::GetAssetPackageExtension());
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
	const bool VerifyOnly = FParse::Param(*Params, TEXT("VerifyOnly"));
	const TArray<FFixtureTableDefinition> Definitions = GetTableDefinitions();

	bool Succeeded = true;
	if (!VerifyOnly)
	{
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			Succeeded = GenerateTable(Definition) && Succeeded;
		}
		Succeeded = GenerateComposite() && Succeeded;
	}
	else
	{
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			Succeeded = VerifyTable(Definition) && Succeeded;
		}
		Succeeded = VerifyComposite() && Succeeded;
	}

	UE_LOG(LogTemp, Display, TEXT("UE Shed fixture %s %s"),
		VerifyOnly ? TEXT("verification") : TEXT("generation"),
		Succeeded ? TEXT("succeeded") : TEXT("failed"));
	return Succeeded ? 0 : 1;
}
