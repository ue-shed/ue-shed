#include "UEShedBuildFixtureCommandlet.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Engine/CompositeDataTable.h"
#include "Engine/DataTable.h"
#include "Engine/DirectionalLight.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Components/StaticMeshComponent.h"
#include "Factories/WorldFactory.h"
#include "HAL/FileManager.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
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
constexpr int32 LargeTableRowCount = 10000;

struct FFixtureTableDefinition
{
	const TCHAR* AssetName;
	const TCHAR* PackageName;
	const TCHAR* SourcePath;
	UScriptStruct* RowStruct;
	int32 GeneratedRowCount = 0;
};

struct FFixtureTextureDefinition
{
	FString Name;
	FString ObjectPath;
	int32 Width = 0;
	int32 Height = 0;
	FString Pattern;
	TextureGroup Group = TEXTUREGROUP_World;
	TextureCompressionSettings Compression = TC_Default;
	bool bSRGB = true;
	TextureMipGenSettings MipGeneration = TMGS_FromTextureGroup;
};

bool ParseTextureGroup(const FString& Value, TextureGroup& Result)
{
	if (Value == TEXT("TEXTUREGROUP_World")) Result = TEXTUREGROUP_World;
	else if (Value == TEXT("TEXTUREGROUP_UI")) Result = TEXTUREGROUP_UI;
	else if (Value == TEXT("TEXTUREGROUP_Effects")) Result = TEXTUREGROUP_Effects;
	else return false;
	return true;
}

bool ParseTextureCompression(const FString& Value, TextureCompressionSettings& Result)
{
	if (Value == TEXT("TC_Default")) Result = TC_Default;
	else if (Value == TEXT("TC_EditorIcon")) Result = TC_EditorIcon;
	else return false;
	return true;
}

bool ParseMipGeneration(const FString& Value, TextureMipGenSettings& Result)
{
	if (Value == TEXT("TMGS_FromTextureGroup")) Result = TMGS_FromTextureGroup;
	else if (Value == TEXT("TMGS_NoMipmaps")) Result = TMGS_NoMipmaps;
	else return false;
	return true;
}

bool LoadTextureDefinitions(TArray<FFixtureTextureDefinition>& Definitions)
{
	const FString Filename = FPaths::ConvertRelativePathToFull(
		FPaths::ProjectDir(), TEXT("FixtureSource/Audits/textures.json"));
	FString Json;
	if (!FFileHelper::LoadFileToString(Json, *Filename))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not read texture fixture source %s"), *Filename);
		return false;
	}
	TArray<TSharedPtr<FJsonValue>> Values;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Values)) return false;
	for (const TSharedPtr<FJsonValue>& Value : Values)
	{
		const TSharedPtr<FJsonObject> Object = Value->AsObject();
		FFixtureTextureDefinition Definition;
		FString Format;
		FString Group;
		FString Compression;
		FString MipGeneration;
		if (!Object.IsValid()
			|| !Object->TryGetStringField(TEXT("name"), Definition.Name)
			|| !Object->TryGetStringField(TEXT("objectPath"), Definition.ObjectPath)
			|| !Object->TryGetNumberField(TEXT("width"), Definition.Width)
			|| !Object->TryGetNumberField(TEXT("height"), Definition.Height)
			|| !Object->TryGetStringField(TEXT("sourceFormat"), Format)
			|| !Object->TryGetStringField(TEXT("pattern"), Definition.Pattern)
			|| !Object->TryGetStringField(TEXT("textureGroup"), Group)
			|| !Object->TryGetStringField(TEXT("compression"), Compression)
			|| !Object->TryGetBoolField(TEXT("sRGB"), Definition.bSRGB)
			|| !Object->TryGetStringField(TEXT("mipGeneration"), MipGeneration)
			|| Format != TEXT("TSF_BGRA8")
			|| (Definition.Pattern != TEXT("checker") && Definition.Pattern != TEXT("stripes"))
			|| !ParseTextureGroup(Group, Definition.Group)
			|| !ParseTextureCompression(Compression, Definition.Compression)
			|| !ParseMipGeneration(MipGeneration, Definition.MipGeneration)
			|| Definition.Width <= 0 || Definition.Height <= 0)
		{
			UE_LOG(LogTemp, Error, TEXT("Invalid or unsupported texture fixture definition"));
			return false;
		}
		Definitions.Add(MoveTemp(Definition));
	}
	return Definitions.Num() == 5;
}

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
			TEXT("FixtureSource/Authoring/DT_Opaque.json"), FUEShedFixtureOpaqueRow::StaticStruct() },
		{ TEXT("DT_LargeScalars"), TEXT("/Game/Fixture/Authoring/DT_LargeScalars"), nullptr,
			FUEShedFixtureScalarsRow::StaticStruct(), LargeTableRowCount }
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

TArray<uint8> GenerateTexturePixels(const FFixtureTextureDefinition& Definition)
{
	TArray<uint8> Pixels;
	Pixels.SetNumUninitialized(Definition.Width * Definition.Height * 4);
	for (int32 Y = 0; Y < Definition.Height; ++Y)
	{
		for (int32 X = 0; X < Definition.Width; ++X)
		{
			const bool bAccent = Definition.Pattern == TEXT("checker")
				? ((X / 16) + (Y / 16)) % 2 == 0
				: (X / 24) % 2 == 0;
			const int32 Offset = (Y * Definition.Width + X) * 4;
			Pixels[Offset] = bAccent ? 42 : 188;
			Pixels[Offset + 1] = bAccent ? 166 : 55;
			Pixels[Offset + 2] = bAccent ? 232 : 28;
			Pixels[Offset + 3] = 255;
		}
	}
	return Pixels;
}

bool GenerateAuditTextures()
{
	TArray<FFixtureTextureDefinition> Definitions;
	if (!LoadTextureDefinitions(Definitions)) return false;
	bool bSucceeded = true;
	for (const FFixtureTextureDefinition& Definition : Definitions)
	{
		const FString PackageName = FPackageName::ObjectPathToPackageName(Definition.ObjectPath);
		UPackage* Package = FindOrCreatePackage(*PackageName);
		if (Package == nullptr)
		{
			bSucceeded = false;
			continue;
		}
		UTexture2D* Texture = FindObject<UTexture2D>(Package, *Definition.Name);
		const bool bWasCreated = Texture == nullptr;
		if (bWasCreated)
		{
			Texture = NewObject<UTexture2D>(Package, *Definition.Name,
				RF_Public | RF_Standalone | RF_Transactional);
		}
		const TArray<uint8> Pixels = GenerateTexturePixels(Definition);
		Texture->PreEditChange(nullptr);
		Texture->Source.Init(Definition.Width, Definition.Height, 1, 1, TSF_BGRA8, Pixels.GetData());
		Texture->LODGroup = Definition.Group;
		Texture->CompressionSettings = Definition.Compression;
		Texture->SRGB = Definition.bSRGB;
		Texture->MipGenSettings = Definition.MipGeneration;
		Texture->PostEditChange();
		if (bWasCreated) FAssetRegistryModule::AssetCreated(Texture);
		Package->MarkPackageDirty();
		if (!SaveAsset(Package, Texture))
		{
			UE_LOG(LogTemp, Error, TEXT("Could not save %s"), *PackageName);
			bSucceeded = false;
		}
		else
		{
			UE_LOG(LogTemp, Display, TEXT("Generated %s (%dx%d)"),
				*Definition.ObjectPath, Definition.Width, Definition.Height);
		}
	}
	return bSucceeded;
}

bool VerifyAuditTextures()
{
	TArray<FFixtureTextureDefinition> Definitions;
	if (!LoadTextureDefinitions(Definitions)) return false;
	bool bSucceeded = true;
	for (const FFixtureTextureDefinition& Definition : Definitions)
	{
		const UTexture2D* Texture = LoadObject<UTexture2D>(nullptr, *Definition.ObjectPath);
		const bool bMatches = Texture != nullptr
			&& Texture->Source.GetSizeX() == Definition.Width
			&& Texture->Source.GetSizeY() == Definition.Height
			&& Texture->Source.GetNumSlices() == 1
			&& Texture->Source.GetNumMips() == 1
			&& Texture->Source.GetFormat() == TSF_BGRA8
			&& Texture->LODGroup == Definition.Group
			&& Texture->CompressionSettings == Definition.Compression
			&& Texture->SRGB == Definition.bSRGB
			&& Texture->MipGenSettings == Definition.MipGeneration;
		if (!bMatches)
		{
			UE_LOG(LogTemp, Error, TEXT("Texture fixture does not match: %s"),
				*Definition.ObjectPath);
			bSucceeded = false;
		}
	}
	UE_LOG(LogTemp, Display, TEXT("Texture fixture verification checked %d assets"),
		Definitions.Num());
	return bSucceeded;
}

bool GenerateTable(const FFixtureTableDefinition& Definition)
{
	FString Json;
	if (Definition.SourcePath != nullptr)
	{
		const FString SourceFilename = FPaths::ConvertRelativePathToFull(
			FPaths::ProjectDir(), Definition.SourcePath);
		if (!FFileHelper::LoadFileToString(Json, *SourceFilename))
		{
			UE_LOG(LogTemp, Error, TEXT("Could not read fixture source %s"), *SourceFilename);
			return false;
		}
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
	TArray<FString> Problems;
	if (Definition.GeneratedRowCount > 0)
	{
		for (int32 Index = 0; Index < Definition.GeneratedRowCount; ++Index)
		{
			FUEShedFixtureScalarsRow Row;
			Row.Enabled = Index % 2 == 0;
			Row.Count = Index % 101;
			Row.Ratio = static_cast<float>(Index % 101) / 100.0f;
			Row.Key = FName(*FString::Printf(TEXT("LoadKey_%05d"), Index));
			Row.Notes = FString::Printf(TEXT("Deterministic load fixture row %05d."), Index);
			Table->AddRow(FName(*FString::Printf(TEXT("Load_%05d"), Index)), Row);
		}
	}
	else
	{
		Problems = Table->CreateTableFromJSONString(Json);
	}
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

	if (Definition.GeneratedRowCount > 0)
	{
		const TArray<FName> RowNames = Table->GetRowNames();
		const FName FirstRowName(TEXT("Load_00000"));
		const FName LastRowName(*FString::Printf(
			TEXT("Load_%05d"), Definition.GeneratedRowCount - 1));
		const FName LastRowKey(*FString::Printf(
			TEXT("LoadKey_%05d"), Definition.GeneratedRowCount - 1));
		const FUEShedFixtureScalarsRow* FirstRow = Table->FindRow<FUEShedFixtureScalarsRow>(
			FirstRowName, TEXT("fixture verification"), false);
		const FUEShedFixtureScalarsRow* LastRow = Table->FindRow<FUEShedFixtureScalarsRow>(
			LastRowName, TEXT("fixture verification"), false);
		const bool bMatches = RowNames.Num() == Definition.GeneratedRowCount
			&& RowNames[0] == FirstRowName
			&& RowNames.Last() == LastRowName
			&& FirstRow != nullptr && FirstRow->Enabled && FirstRow->Count == 0
			&& LastRow != nullptr && !LastRow->Enabled
			&& LastRow->Key == LastRowKey;
		if (!bMatches)
		{
			UE_LOG(LogTemp, Error, TEXT("Generated load table does not match: %s"),
				*ObjectPath(Definition));
		}
		return bMatches;
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

bool GenerateGameTextCorpus()
{
	static const TCHAR* StringTablePackageName = TEXT("/Game/Fixture/Text/ST_Game");
	static const TCHAR* StringTableAssetName = TEXT("ST_Game");
	UPackage* StringTablePackage = FindOrCreatePackage(StringTablePackageName);
	if (StringTablePackage == nullptr) return false;
	UStringTable* StringTable = FindObject<UStringTable>(StringTablePackage, StringTableAssetName);
	const bool bStringTableCreated = StringTable == nullptr;
	if (bStringTableCreated)
	{
		StringTable = NewObject<UStringTable>(StringTablePackage, StringTableAssetName,
			RF_Public | RF_Standalone | RF_Transactional);
	}
	FStringTableRef MutableTable = StringTable->GetMutableStringTable();
	MutableTable->ClearSourceStrings();
	MutableTable->SetNamespace(FTextKey(TEXT("Fixture.StringTable")));
	MutableTable->SetSourceString(FTextKey(TEXT("PromptContinue")), TEXT("Continue"));
	MutableTable->SetSourceString(FTextKey(TEXT("StatusSaving")), TEXT("Saving progress…"));
	MutableTable->SetSourceString(FTextKey(TEXT("PromptHold")), TEXT("Hold to skip"));
	if (bStringTableCreated) FAssetRegistryModule::AssetCreated(StringTable);
	StringTablePackage->MarkPackageDirty();
	if (!SaveAsset(StringTablePackage, StringTable)) return false;

	static const TCHAR* TextAssetPackageName = TEXT("/Game/Fixture/Text/DA_TextOccurrences");
	static const TCHAR* TextAssetName = TEXT("DA_TextOccurrences");
	UPackage* TextAssetPackage = FindOrCreatePackage(TextAssetPackageName);
	if (TextAssetPackage == nullptr) return false;
	UUEShedFixtureTextAsset* TextAsset =
		FindObject<UUEShedFixtureTextAsset>(TextAssetPackage, TextAssetName);
	const bool bTextAssetCreated = TextAsset == nullptr;
	if (bTextAssetCreated)
	{
		TextAsset = NewObject<UUEShedFixtureTextAsset>(TextAssetPackage, TextAssetName,
			RF_Public | RF_Standalone | RF_Transactional);
	}
	const FText Shared = FText::ChangeKey(FTextKey(TEXT("Fixture.Shared")),
		FTextKey(TEXT("SharedHoldPrompt")), FText::FromString(TEXT("Hold to skip")));
	TextAsset->SharedPrimary = Shared;
	TextAsset->SharedSecondary = Shared;
	TextAsset->EqualSourceFirst = FText::ChangeKey(FTextKey(TEXT("Fixture.Context")),
		FTextKey(TEXT("ConfirmAction")), FText::FromString(TEXT("Confirm")));
	TextAsset->EqualSourceSecond = FText::ChangeKey(FTextKey(TEXT("Fixture.Context")),
		FTextKey(TEXT("ConfirmDeletion")), FText::FromString(TEXT("Confirm")));
	TextAsset->StringTableReference = FText::FromStringTable(
		StringTable->GetStringTableId(), FTextKey(TEXT("PromptContinue")));
	if (bTextAssetCreated) FAssetRegistryModule::AssetCreated(TextAsset);
	TextAssetPackage->MarkPackageDirty();
	return SaveAsset(TextAssetPackage, TextAsset);
}

bool VerifyGameTextCorpus()
{
	const UStringTable* StringTable = LoadObject<UStringTable>(
		nullptr, TEXT("/Game/Fixture/Text/ST_Game.ST_Game"));
	if (StringTable == nullptr || StringTable->GetStringTable()->GetNamespace()
		!= TEXT("Fixture.StringTable")) return false;
	FString ContinueSource;
	if (!StringTable->GetStringTable()->GetSourceString(
		FTextKey(TEXT("PromptContinue")), ContinueSource)
		|| ContinueSource != TEXT("Continue")) return false;

	const UUEShedFixtureTextAsset* TextAsset = LoadObject<UUEShedFixtureTextAsset>(
		nullptr, TEXT("/Game/Fixture/Text/DA_TextOccurrences.DA_TextOccurrences"));
	if (TextAsset == nullptr) return false;
	const TOptional<FString> SharedNamespace = FTextInspector::GetNamespace(TextAsset->SharedPrimary);
	const TOptional<FString> SharedKey = FTextInspector::GetKey(TextAsset->SharedPrimary);
	return SharedNamespace == FString(TEXT("Fixture.Shared"))
		&& SharedKey == FString(TEXT("SharedHoldPrompt"))
		&& FTextInspector::GetNamespace(TextAsset->SharedSecondary) == SharedNamespace
		&& FTextInspector::GetKey(TextAsset->SharedSecondary) == SharedKey
		&& TextAsset->EqualSourceFirst.ToString() == TEXT("Confirm")
		&& TextAsset->EqualSourceSecond.ToString() == TEXT("Confirm")
		&& FTextInspector::GetKey(TextAsset->EqualSourceFirst)
			!= FTextInspector::GetKey(TextAsset->EqualSourceSecond)
		&& TextAsset->StringTableReference.IsFromStringTable();
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
		bool bHasReviewSubject = false;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (Actor == nullptr) continue;
			ExistingMovers += Actor->IsA<AUEShedFixtureMover>() ? 1 : 0;
			ExistingCameras += Actor->IsA<AUEShedCameraSource>() ? 1 : 0;
			bHasReviewSubject = bHasReviewSubject || Actor->GetFName() == TEXT("ReviewSubject");
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
			&& bAllCamerasBound && bHasReviewSubject)
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

	FActorSpawnParameters ReviewSubjectSpawn;
	ReviewSubjectSpawn.Name = TEXT("ReviewSubject");
	ReviewSubjectSpawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
	AStaticMeshActor* ReviewSubject = World->SpawnActor<AStaticMeshActor>(
		FVector(0, 0, 220), FRotator::ZeroRotator, ReviewSubjectSpawn);
	if (ReviewSubject == nullptr) return false;
	ReviewSubject->Tags.Add(TEXT("UEShedCameraFixture"));
	ReviewSubject->Tags.Add(TEXT("UEShedReviewSubject"));
	ReviewSubject->SetActorLabel(TEXT("Review Subject"));
	ReviewSubject->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Cube.Cube")));
	ReviewSubject->SetActorScale3D(FVector(5.0, 3.0, 4.5));

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
	bool bHasReviewSubject = false;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor == nullptr) continue;
		Movers += Actor->IsA<AUEShedFixtureMover>() ? 1 : 0;
		Cameras += Actor->IsA<AUEShedCameraSource>() ? 1 : 0;
		bHasReviewSubject = bHasReviewSubject || Actor->GetFName() == TEXT("ReviewSubject");
		if (const AUEShedCameraSource* Camera = Cast<AUEShedCameraSource>(Actor))
		{
			BoundCameras += Camera->ObservationTarget != nullptr ? 1 : 0;
		}
	}
	UE_LOG(LogTemp, Display,
		TEXT("Camera fixture verification found %d movers, %d cameras, and %d POV bindings"),
		Movers, Cameras, BoundCameras);
	return Movers == CameraFixtureCount && Cameras == CameraFixtureCount
		&& BoundCameras == CameraFixtureCount && bHasReviewSubject;
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
		FString SecondApplyRequest;
		FString SecondApplyOutput;
		if (FParse::Value(*Params, TEXT("SecondApplyRequest="), SecondApplyRequest)
			&& FParse::Value(*Params, TEXT("SecondApplyOutput="), SecondApplyOutput))
		{
			FString SecondRequestJson;
			FString SecondResultJson;
			bSucceeded = FFileHelper::LoadFileToString(SecondRequestJson,
				*FPaths::ConvertRelativePathToFull(SecondApplyRequest)) && bSucceeded;
			UUEShedAuthoringLibrary::Apply(SecondRequestJson, SecondResultJson);
			bSucceeded = FFileHelper::SaveStringToFile(SecondResultJson,
				*FPaths::ConvertRelativePathToFull(SecondApplyOutput)) && bSucceeded;
		}
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
		Succeeded = GenerateGameTextCorpus() && Succeeded;
		Succeeded = GenerateCameraMap() && Succeeded;
		Succeeded = GenerateAuditTextures() && Succeeded;
	}
	else
	{
		for (const FFixtureTableDefinition& Definition : Definitions)
		{
			Succeeded = VerifyTable(Definition) && Succeeded;
		}
		Succeeded = VerifyComposite() && Succeeded;
		Succeeded = VerifyGameTextCorpus() && Succeeded;
		Succeeded = VerifyCameraMap() && Succeeded;
		Succeeded = VerifyAuditTextures() && Succeeded;
	}

	UE_LOG(LogTemp, Display, TEXT("UE Shed fixture %s %s"),
		VerifyOnly ? TEXT("verification") : TEXT("generation"),
		Succeeded ? TEXT("succeeded") : TEXT("failed"));
	return Succeeded ? 0 : 1;
}
