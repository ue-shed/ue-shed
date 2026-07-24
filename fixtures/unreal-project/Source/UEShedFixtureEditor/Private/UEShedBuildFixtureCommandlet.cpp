#include "UEShedBuildFixtureCommandlet.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Engine/CompositeDataTable.h"
#include "Engine/DataTable.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Factories/WorldFactory.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "HAL/FileManager.h"
#include "InputAction.h"
#include "InputActionValue.h"
#include "InputCoreTypes.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/Text.h"
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
/** Dense World Scout catalog; cameras stay at CameraFixtureCount and bind to movers 0..31. */
constexpr int32 ObservationMoverCount = 4096;
constexpr int32 StationaryMoverCount = 3278;
constexpr int32 FlyingMoverCount = 409;
constexpr int32 IntermittentMoverCount = 409;
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

FString TextureGroupName(const TextureGroup Value)
{
	switch (Value)
	{
	case TEXTUREGROUP_World: return TEXT("TEXTUREGROUP_World");
	case TEXTUREGROUP_UI: return TEXT("TEXTUREGROUP_UI");
	case TEXTUREGROUP_Effects: return TEXT("TEXTUREGROUP_Effects");
	default: return FString::Printf(TEXT("unsupported:%d"), static_cast<int32>(Value));
	}
}

FString TextureCompressionName(const TextureCompressionSettings Value)
{
	switch (Value)
	{
	case TC_Default: return TEXT("TC_Default");
	case TC_EditorIcon: return TEXT("TC_EditorIcon");
	default: return FString::Printf(TEXT("unsupported:%d"), static_cast<int32>(Value));
	}
}

FString MipGenerationName(const TextureMipGenSettings Value)
{
	switch (Value)
	{
	case TMGS_FromTextureGroup: return TEXT("TMGS_FromTextureGroup");
	case TMGS_NoMipmaps: return TEXT("TMGS_NoMipmaps");
	default: return FString::Printf(TEXT("unsupported:%d"), static_cast<int32>(Value));
	}
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

TSharedRef<FJsonObject> EvidenceContract()
{
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-unreal-asset-evidence"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}


TSharedRef<FJsonObject> EvidenceRoot(const TCHAR* AssetType, const UObject* Asset)
{
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), EvidenceContract());
	Root->SetStringField(TEXT("assetType"), AssetType);
	Root->SetStringField(TEXT("objectPath"), Asset->GetPathName());
	Root->SetStringField(TEXT("classPath"), Asset->GetClass()->GetPathName());
	return Root;
}

bool WriteJsonEvidence(const FString& Filename, const TSharedRef<FJsonObject>& Evidence)
{
	FString Json;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
	if (!FJsonSerializer::Serialize(Evidence, Writer)) return false;
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
	return FFileHelper::SaveStringToFile(Json + LINE_TERMINATOR, *Filename,
		FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
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

TSharedRef<FJsonObject> TextEvidence(const FText& Text)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("kind"), TEXT("text"));
	Result->SetStringField(TEXT("displayString"), Text.ToString());
	if (const FString* Source = FTextInspector::GetSourceString(Text))
	{
		Result->SetStringField(TEXT("sourceString"), *Source);
	}

	FName TableId;
	FString TableKey;
	const TSharedRef<FJsonObject> Identity = MakeShared<FJsonObject>();
	if (FTextInspector::GetTableIdAndKey(Text, TableId, TableKey))
	{
		Identity->SetStringField(TEXT("kind"), TEXT("string_table"));
		Identity->SetStringField(TEXT("tableId"), TableId.ToString());
		Identity->SetStringField(TEXT("key"), TableKey);
	}
	else
	{
		Identity->SetStringField(TEXT("kind"), TEXT("localized"));
		Identity->SetStringField(TEXT("namespace"),
			FTextInspector::GetNamespace(Text).Get(FString()));
		Identity->SetStringField(TEXT("key"), FTextInspector::GetKey(Text).Get(FString()));
	}
	Result->SetObjectField(TEXT("identity"), Identity);
	return Result;
}

bool WriteStringTableEvidence(const FString& OutputDirectory)
{
	const UStringTable* StringTable = LoadObject<UStringTable>(
		nullptr, TEXT("/Game/Fixture/Text/ST_Game.ST_Game"));
	if (StringTable == nullptr) return false;

	TArray<TPair<FString, FString>> SourceStrings;
	StringTable->GetStringTable()->EnumerateSourceStrings(
		[&SourceStrings](const FString& Key, const FString& Source)
		{
			SourceStrings.Emplace(Key, Source);
			return true;
		});
	SourceStrings.Sort([](const TPair<FString, FString>& Left,
		const TPair<FString, FString>& Right) { return Left.Key < Right.Key; });

	const TSharedRef<FJsonObject> Root = EvidenceRoot(TEXT("string_table"), StringTable);
	Root->SetStringField(TEXT("namespace"), StringTable->GetStringTable()->GetNamespace());
	TArray<TSharedPtr<FJsonValue>> Entries;
	for (const TPair<FString, FString>& SourceString : SourceStrings)
	{
		const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("key"), SourceString.Key);
		Entry->SetStringField(TEXT("source"), SourceString.Value);
		Entries.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Root->SetArrayField(TEXT("entries"), Entries);
	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/string-table.json")), Root);
}

bool WriteTextAssetEvidence(const FString& OutputDirectory)
{
	const UUEShedFixtureTextAsset* TextAsset = LoadObject<UUEShedFixtureTextAsset>(
		nullptr, TEXT("/Game/Fixture/Text/DA_TextOccurrences.DA_TextOccurrences"));
	if (TextAsset == nullptr) return false;

	const TSharedRef<FJsonObject> Root = EvidenceRoot(TEXT("text_data_asset"), TextAsset);
	TArray<TSharedPtr<FJsonValue>> Properties;
	const TArray<TPair<FString, const FText*>> Values = {
		{ TEXT("SharedPrimary"), &TextAsset->SharedPrimary },
		{ TEXT("SharedSecondary"), &TextAsset->SharedSecondary },
		{ TEXT("EqualSourceFirst"), &TextAsset->EqualSourceFirst },
		{ TEXT("EqualSourceSecond"), &TextAsset->EqualSourceSecond },
		{ TEXT("StringTableReference"), &TextAsset->StringTableReference }
	};
	for (const TPair<FString, const FText*>& Value : Values)
	{
		const TSharedRef<FJsonObject> Property = MakeShared<FJsonObject>();
		Property->SetStringField(TEXT("name"), Value.Key);
		Property->SetStringField(TEXT("typeName"), TEXT("TextProperty"));
		Property->SetObjectField(TEXT("value"), TextEvidence(*Value.Value));
		Properties.Add(MakeShared<FJsonValueObject>(Property));
	}
	Root->SetArrayField(TEXT("properties"), Properties);
	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/text-data-asset.json")), Root);
}

bool WriteTextureEvidence(const FString& OutputDirectory)
{
	TArray<FFixtureTextureDefinition> Definitions;
	if (!LoadTextureDefinitions(Definitions)) return false;
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), EvidenceContract());
	Root->SetStringField(TEXT("assetType"), TEXT("texture2d"));
	TArray<TSharedPtr<FJsonValue>> Assets;
	for (const FFixtureTextureDefinition& Definition : Definitions)
	{
		const UTexture2D* Texture = LoadObject<UTexture2D>(nullptr, *Definition.ObjectPath);
		if (Texture == nullptr) return false;
		const TSharedRef<FJsonObject> Asset = MakeShared<FJsonObject>();
		Asset->SetStringField(TEXT("objectPath"), Texture->GetPathName());
		Asset->SetStringField(TEXT("classPath"), Texture->GetClass()->GetPathName());
		const TSharedRef<FJsonObject> Source = MakeShared<FJsonObject>();
		Source->SetNumberField(TEXT("width"), Texture->Source.GetSizeX());
		Source->SetNumberField(TEXT("height"), Texture->Source.GetSizeY());
		Source->SetNumberField(TEXT("slices"), Texture->Source.GetNumSlices());
		Source->SetNumberField(TEXT("mips"), Texture->Source.GetNumMips());
		Source->SetStringField(TEXT("format"), Texture->Source.GetFormat() == TSF_BGRA8
			? TEXT("TSF_BGRA8") : TEXT("unsupported"));
		Asset->SetObjectField(TEXT("source"), Source);
		Asset->SetStringField(TEXT("textureGroup"), TextureGroupName(Texture->LODGroup));
		Asset->SetStringField(TEXT("compression"),
			TextureCompressionName(Texture->CompressionSettings));
		Asset->SetBoolField(TEXT("sRGB"), Texture->SRGB);
		Asset->SetStringField(TEXT("mipGeneration"), MipGenerationName(Texture->MipGenSettings));
		Assets.Add(MakeShared<FJsonValueObject>(Asset));
	}
	Root->SetArrayField(TEXT("assets"), Assets);
	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/texture2d.json")), Root);
}

FString InputActionValueTypeName(const EInputActionValueType ValueType)
{
	switch (ValueType)
	{
	case EInputActionValueType::Boolean: return TEXT("EInputActionValueType::Boolean");
	case EInputActionValueType::Axis1D: return TEXT("EInputActionValueType::Axis1D");
	case EInputActionValueType::Axis2D: return TEXT("EInputActionValueType::Axis2D");
	case EInputActionValueType::Axis3D: return TEXT("EInputActionValueType::Axis3D");
	default: return FString::Printf(TEXT("unsupported:%d"), static_cast<int32>(ValueType));
	}
}

UInputAction* FindOrCreateInputAction(const TCHAR* PackageName, const TCHAR* AssetName)
{
	UPackage* Package = FindOrCreatePackage(PackageName);
	if (Package == nullptr) return nullptr;
	UInputAction* Action = FindObject<UInputAction>(Package, AssetName);
	if (Action == nullptr)
	{
		Action = NewObject<UInputAction>(Package, AssetName,
			RF_Public | RF_Standalone | RF_Transactional);
		FAssetRegistryModule::AssetCreated(Action);
	}
	return Action;
}

bool GenerateEnhancedInputFixtures()
{
	UInputAction* Jump = FindOrCreateInputAction(
		TEXT("/Game/Fixture/Input/IA_Jump"), TEXT("IA_Jump"));
	UInputAction* Move = FindOrCreateInputAction(
		TEXT("/Game/Fixture/Input/IA_Move"), TEXT("IA_Move"));
	if (Jump == nullptr || Move == nullptr) return false;

	Jump->ActionDescription = FText::FromString(TEXT("Fixture jump action"));
	Jump->bConsumeInput = false;
	Jump->ValueType = EInputActionValueType::Boolean;
	Jump->MarkPackageDirty();
	if (!SaveAsset(Jump->GetOutermost(), Jump)) return false;

	Move->ActionDescription = FText::FromString(TEXT("Fixture move action"));
	Move->ValueType = EInputActionValueType::Axis2D;
	Move->MarkPackageDirty();
	if (!SaveAsset(Move->GetOutermost(), Move)) return false;

	static const TCHAR* MappingPackageName = TEXT("/Game/Fixture/Input/IMC_Fixture");
	static const TCHAR* MappingAssetName = TEXT("IMC_Fixture");
	UPackage* MappingPackage = FindOrCreatePackage(MappingPackageName);
	if (MappingPackage == nullptr) return false;
	UInputMappingContext* MappingContext =
		FindObject<UInputMappingContext>(MappingPackage, MappingAssetName);
	const bool bCreated = MappingContext == nullptr;
	if (bCreated)
	{
		MappingContext = NewObject<UInputMappingContext>(MappingPackage, MappingAssetName,
			RF_Public | RF_Standalone | RF_Transactional);
	}
	MappingContext->ContextDescription = FText::FromString(TEXT("Fixture mapping context"));
	MappingContext->UnmapAll();
	MappingContext->MapKey(Jump, EKeys::SpaceBar);
	FEnhancedActionKeyMapping& MoveMapping = MappingContext->MapKey(Move, EKeys::A);
	UInputModifierNegate* Negate = NewObject<UInputModifierNegate>(MappingContext,
		TEXT("InputModifierNegate_0"));
	Negate->bX = false;
	MoveMapping.Modifiers.Add(Negate);
	if (bCreated) FAssetRegistryModule::AssetCreated(MappingContext);
	MappingPackage->MarkPackageDirty();
	return SaveAsset(MappingPackage, MappingContext);
}

bool VerifyEnhancedInputFixtures()
{
	const UInputAction* Jump = LoadObject<UInputAction>(
		nullptr, TEXT("/Game/Fixture/Input/IA_Jump.IA_Jump"));
	const UInputAction* Move = LoadObject<UInputAction>(
		nullptr, TEXT("/Game/Fixture/Input/IA_Move.IA_Move"));
	const UInputMappingContext* MappingContext = LoadObject<UInputMappingContext>(
		nullptr, TEXT("/Game/Fixture/Input/IMC_Fixture.IMC_Fixture"));
	if (Jump == nullptr || Move == nullptr || MappingContext == nullptr) return false;
	if (Jump->ValueType != EInputActionValueType::Boolean || Jump->bConsumeInput) return false;
	if (Jump->ActionDescription.ToString() != TEXT("Fixture jump action")) return false;
	if (Move->ValueType != EInputActionValueType::Axis2D) return false;
	if (Move->ActionDescription.ToString() != TEXT("Fixture move action")) return false;
	if (MappingContext->ContextDescription.ToString() != TEXT("Fixture mapping context"))
	{
		return false;
	}
	const TArray<FEnhancedActionKeyMapping>& Mappings = MappingContext->GetMappings();
	if (Mappings.Num() != 2) return false;
	if (Mappings[0].Action != Jump || Mappings[0].Key != EKeys::SpaceBar) return false;
	if (Mappings[1].Action != Move || Mappings[1].Key != EKeys::A) return false;
	if (Mappings[1].Modifiers.Num() != 1) return false;
	const UInputModifierNegate* Negate = Cast<UInputModifierNegate>(Mappings[1].Modifiers[0]);
	return Negate != nullptr && !Negate->bX && Negate->bY && Negate->bZ;
}

bool WriteEnhancedInputEvidence(const FString& OutputDirectory)
{
	const UInputAction* Jump = LoadObject<UInputAction>(
		nullptr, TEXT("/Game/Fixture/Input/IA_Jump.IA_Jump"));
	const UInputAction* Move = LoadObject<UInputAction>(
		nullptr, TEXT("/Game/Fixture/Input/IA_Move.IA_Move"));
	const UInputMappingContext* MappingContext = LoadObject<UInputMappingContext>(
		nullptr, TEXT("/Game/Fixture/Input/IMC_Fixture.IMC_Fixture"));
	if (Jump == nullptr || Move == nullptr || MappingContext == nullptr) return false;

	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetObjectField(TEXT("contract"), EvidenceContract());
	Root->SetStringField(TEXT("assetType"), TEXT("enhanced_input"));

	auto ActionEvidence = [](const UInputAction* Action) -> TSharedRef<FJsonObject>
	{
		const TSharedRef<FJsonObject> Asset = MakeShared<FJsonObject>();
		Asset->SetStringField(TEXT("objectPath"), Action->GetPathName());
		Asset->SetStringField(TEXT("classPath"), Action->GetClass()->GetPathName());
		Asset->SetStringField(TEXT("actionDescription"), Action->ActionDescription.ToString());
		Asset->SetStringField(TEXT("valueType"), InputActionValueTypeName(Action->ValueType));
		Asset->SetBoolField(TEXT("consumeInput"), Action->bConsumeInput);
		return Asset;
	};

	TArray<TSharedPtr<FJsonValue>> Actions;
	Actions.Add(MakeShared<FJsonValueObject>(ActionEvidence(Jump)));
	Actions.Add(MakeShared<FJsonValueObject>(ActionEvidence(Move)));
	Root->SetArrayField(TEXT("actions"), Actions);

	const TSharedRef<FJsonObject> Context = MakeShared<FJsonObject>();
	Context->SetStringField(TEXT("objectPath"), MappingContext->GetPathName());
	Context->SetStringField(TEXT("classPath"), MappingContext->GetClass()->GetPathName());
	Context->SetStringField(TEXT("contextDescription"),
		MappingContext->ContextDescription.ToString());
	Context->SetStringField(TEXT("mappingsProperty"), TEXT("DefaultKeyMappings"));
	TArray<TSharedPtr<FJsonValue>> Mappings;
	for (const FEnhancedActionKeyMapping& Mapping : MappingContext->GetMappings())
	{
		const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("action"),
			Mapping.Action != nullptr ? Mapping.Action->GetPathName() : FString());
		Entry->SetStringField(TEXT("keyName"), Mapping.Key.GetFName().ToString());
		TArray<TSharedPtr<FJsonValue>> Triggers;
		for (const TObjectPtr<UInputTrigger>& Trigger : Mapping.Triggers)
		{
			if (Trigger == nullptr) continue;
			const TSharedRef<FJsonObject> TriggerObject = MakeShared<FJsonObject>();
			TriggerObject->SetStringField(TEXT("objectPath"), Trigger->GetPathName());
			TriggerObject->SetStringField(TEXT("classPath"), Trigger->GetClass()->GetPathName());
			Triggers.Add(MakeShared<FJsonValueObject>(TriggerObject));
		}
		Entry->SetArrayField(TEXT("triggers"), Triggers);
		TArray<TSharedPtr<FJsonValue>> Modifiers;
		for (const TObjectPtr<UInputModifier>& Modifier : Mapping.Modifiers)
		{
			if (Modifier == nullptr) continue;
			const TSharedRef<FJsonObject> ModifierObject = MakeShared<FJsonObject>();
			ModifierObject->SetStringField(TEXT("objectPath"), Modifier->GetPathName());
			ModifierObject->SetStringField(TEXT("classPath"), Modifier->GetClass()->GetPathName());
			Modifiers.Add(MakeShared<FJsonValueObject>(ModifierObject));
		}
		Entry->SetArrayField(TEXT("modifiers"), Modifiers);
		Mappings.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Context->SetArrayField(TEXT("mappings"), Mappings);
	TArray<TSharedPtr<FJsonValue>> Contexts;
	Contexts.Add(MakeShared<FJsonValueObject>(Context));
	Root->SetArrayField(TEXT("mappingContexts"), Contexts);

	return WriteJsonEvidence(
		FPaths::Combine(OutputDirectory, TEXT("parser-targets/enhanced-input.json")), Root);
}

bool WriteAuthoringEvidence(const FString& OutputDirectory)
{
	bool bSucceeded = true;
	for (const FFixtureTableDefinition& Definition : GetTableDefinitions())
	{
		FString SnapshotJson;
		UUEShedAuthoringLibrary::GetTableSnapshot(ObjectPath(Definition), SnapshotJson);
		const FString Filename = FPaths::Combine(
			OutputDirectory, TEXT("authoring"), FString(Definition.AssetName) + TEXT(".json"));
		IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
		bSucceeded = FFileHelper::SaveStringToFile(SnapshotJson, *Filename,
			FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) && bSucceeded;
	}
	FString CompositeJson;
	UUEShedAuthoringLibrary::GetTableSnapshot(
		TEXT("/Game/Fixture/Authoring/CDT_Scalars.CDT_Scalars"), CompositeJson);
	const FString CompositeFilename = FPaths::Combine(
		OutputDirectory, TEXT("authoring/CDT_Scalars.json"));
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(CompositeFilename), true);
	return FFileHelper::SaveStringToFile(CompositeJson, *CompositeFilename,
		FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) && bSucceeded;
}

bool WriteConformanceEvidence(const FString& OutputDirectory)
{
	return WriteAuthoringEvidence(OutputDirectory)
		&& WriteStringTableEvidence(OutputDirectory)
		&& WriteTextAssetEvidence(OutputDirectory)
		&& WriteTextureEvidence(OutputDirectory)
		&& WriteEnhancedInputEvidence(OutputDirectory);
}

void ApplySolidColor(UStaticMeshComponent* Mesh, const FLinearColor& Color)
{
	if (Mesh == nullptr) return;
	UMaterialInterface* Parent = LoadObject<UMaterialInterface>(nullptr,
		TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (Parent == nullptr) return;
	UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Parent, Mesh);
	if (Mid == nullptr) return;
	Mid->SetVectorParameterValue(TEXT("Color"), Color);
	Mesh->SetMaterial(0, Mid);
}

UStaticMeshComponent* AddChildShape(AStaticMeshActor* Owner, const TCHAR* Name,
	const TCHAR* MeshPath, const FVector& RelativeLocation, const FVector& RelativeScale,
	const FLinearColor& Color)
{
	if (Owner == nullptr) return nullptr;
	UStaticMeshComponent* Child = NewObject<UStaticMeshComponent>(Owner, Name);
	Child->SetupAttachment(Owner->GetRootComponent());
	Child->SetMobility(EComponentMobility::Static);
	Child->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, MeshPath));
	Child->SetRelativeLocation(RelativeLocation);
	Child->SetRelativeScale3D(RelativeScale);
	Child->RegisterComponent();
	Owner->AddInstanceComponent(Child);
	ApplySolidColor(Child, Color);
	return Child;
}

const TCHAR* MotionFamilyLabel(const EUEShedFixtureMotion Motion)
{
	switch (Motion)
	{
	case EUEShedFixtureMotion::Flying:
		return TEXT("Flying");
	case EUEShedFixtureMotion::Intermittent:
		return TEXT("Intermittent");
	case EUEShedFixtureMotion::Stationary:
	default:
		return TEXT("Stationary");
	}
}

float MotionBaseHeight(const EUEShedFixtureMotion Motion)
{
	switch (Motion)
	{
	case EUEShedFixtureMotion::Flying:
		return 380.0f;
	case EUEShedFixtureMotion::Intermittent:
		return 160.0f;
	case EUEShedFixtureMotion::Stationary:
	default:
		return 40.0f;
	}
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
		int32 StationaryMovers = 0;
		int32 FlyingMovers = 0;
		int32 IntermittentMovers = 0;
		bool bMoverMotionsMatch = true;
		bool bHasReviewSubject = false;
		bool bHasAtmosphere = false;
		bool bAllCamerasBound = true;
		for (AActor* Actor : World->PersistentLevel->Actors)
		{
			if (Actor == nullptr) continue;
			bHasAtmosphere = bHasAtmosphere || Actor->IsA<ASkyAtmosphere>();
			bHasReviewSubject = bHasReviewSubject || Actor->GetFName() == TEXT("ReviewSubject");
			if (const AUEShedFixtureMover* Mover = Cast<AUEShedFixtureMover>(Actor))
			{
				++ExistingMovers;
				StationaryMovers += Mover->IsA<AUEShedFixtureStationary>() ? 1 : 0;
				FlyingMovers += Mover->IsA<AUEShedFixtureFlying>() ? 1 : 0;
				IntermittentMovers += Mover->IsA<AUEShedFixtureIntermittent>() ? 1 : 0;
				bMoverMotionsMatch = bMoverMotionsMatch
					&& (!Mover->IsA<AUEShedFixtureStationary>()
						|| Mover->Motion == EUEShedFixtureMotion::Stationary)
					&& (!Mover->IsA<AUEShedFixtureFlying>()
						|| Mover->Motion == EUEShedFixtureMotion::Flying)
					&& (!Mover->IsA<AUEShedFixtureIntermittent>()
						|| Mover->Motion == EUEShedFixtureMotion::Intermittent);
			}
			if (const AUEShedCameraSource* Camera = Cast<AUEShedCameraSource>(Actor))
			{
				++ExistingCameras;
				bAllCamerasBound = bAllCamerasBound && Camera->ObservationTarget != nullptr;
			}
		}
		const bool bFamiliesMatch = StationaryMovers == StationaryMoverCount
			&& FlyingMovers == FlyingMoverCount
			&& IntermittentMovers == IntermittentMoverCount;
		if (ExistingMovers == ObservationMoverCount && ExistingCameras == CameraFixtureCount
			&& bAllCamerasBound && bHasReviewSubject && bHasAtmosphere && bFamiliesMatch
			&& bMoverMotionsMatch)
		{
			UE_LOG(LogTemp, Display, TEXT("Camera fixture map already matches its contract"));
			return true;
		}
	}

	TArray<AActor*> Existing;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor == nullptr) continue;
		if (Actor->ActorHasTag(TEXT("UEShedCameraFixture"))
			|| Actor->IsA<AUEShedFixtureMover>()
			|| Actor->IsA<AUEShedCameraSource>()
			|| Actor->IsA<ASkyAtmosphere>()
			|| Actor->IsA<AExponentialHeightFog>()
			|| Actor->IsA<ADirectionalLight>()
			|| Actor->IsA<ASkyLight>()
			|| Actor->GetFName() == TEXT("ReviewSubject")
			|| Actor->ActorHasTag(TEXT("UEShedReviewSubject")))
		{
			Existing.Add(Actor);
		}
	}
	for (AActor* Actor : Existing)
	{
		Actor->Rename(nullptr, Actor->GetOuter(),
			REN_ForceNoResetLoaders | REN_DontCreateRedirectors | REN_NonTransactional);
		World->EditorDestroyActor(Actor, true);
	}

	AStaticMeshActor* Floor = World->SpawnActor<AStaticMeshActor>(FVector(0, 0, -80), FRotator::ZeroRotator);
	Floor->Tags.Add(TEXT("UEShedCameraFixture"));
	Floor->SetActorLabel(TEXT("Observation Floor"));
	Floor->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Plane.Plane")));
	Floor->SetActorScale3D(FVector(55, 55, 1));
	ApplySolidColor(Floor->GetStaticMeshComponent(), FLinearColor(0.18f, 0.22f, 0.17f, 1.0f));

	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector::ZeroVector,
		FRotator(-48, -35, 0));
	Sun->Tags.Add(TEXT("UEShedCameraFixture"));
	Sun->SetActorLabel(TEXT("Fixture Sun"));
	if (UDirectionalLightComponent* SunLight = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		SunLight->SetAtmosphereSunLight(true);
		SunLight->SetIntensity(8.0f);
		SunLight->SetLightColor(FLinearColor(1.0f, 0.96f, 0.90f));
	}

	ASkyAtmosphere* Atmosphere = World->SpawnActor<ASkyAtmosphere>();
	Atmosphere->Tags.Add(TEXT("UEShedCameraFixture"));
	Atmosphere->SetActorLabel(TEXT("Fixture Atmosphere"));

	ASkyLight* Sky = World->SpawnActor<ASkyLight>();
	Sky->Tags.Add(TEXT("UEShedCameraFixture"));
	Sky->SetActorLabel(TEXT("Fixture Sky"));
	if (USkyLightComponent* SkyLight = Sky->GetLightComponent())
	{
		SkyLight->bRealTimeCapture = true;
		SkyLight->SetIntensity(1.0f);
		SkyLight->RecaptureSky();
	}

	AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>(
		FVector(0, 0, -80), FRotator::ZeroRotator);
	Fog->Tags.Add(TEXT("UEShedCameraFixture"));
	Fog->SetActorLabel(TEXT("Fixture Fog"));
	if (UExponentialHeightFogComponent* FogComponent = Fog->GetComponent())
	{
		FogComponent->SetFogDensity(0.018f);
		FogComponent->SetFogHeightFalloff(0.18f);
		FogComponent->SetFogInscatteringColor(FLinearColor(0.45f, 0.58f, 0.78f));
	}

	FActorSpawnParameters ReviewSubjectSpawn;
	ReviewSubjectSpawn.Name = TEXT("ReviewSubject");
	ReviewSubjectSpawn.NameMode = FActorSpawnParameters::ESpawnActorNameMode::Required_ErrorAndReturnNull;
	AStaticMeshActor* ReviewSubject = World->SpawnActor<AStaticMeshActor>(
		FVector(0, 0, 140), FRotator::ZeroRotator, ReviewSubjectSpawn);
	if (ReviewSubject == nullptr) return false;
	ReviewSubject->Tags.Add(TEXT("UEShedCameraFixture"));
	ReviewSubject->Tags.Add(TEXT("UEShedReviewSubject"));
	ReviewSubject->SetActorLabel(TEXT("Review Subject"));
	ReviewSubject->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Cube.Cube")));
	ReviewSubject->SetActorScale3D(FVector(4.5, 2.8, 3.6));
	ApplySolidColor(ReviewSubject->GetStaticMeshComponent(),
		FLinearColor(0.62f, 0.56f, 0.48f, 1.0f));
	AddChildShape(ReviewSubject, TEXT("Roof"), TEXT("/Engine/BasicShapes/Cube.Cube"),
		FVector(0, 0, 70), FVector(1.15, 1.2, 0.22), FLinearColor(0.32f, 0.28f, 0.26f, 1.0f));
	AddChildShape(ReviewSubject, TEXT("FacadeWing"), TEXT("/Engine/BasicShapes/Cube.Cube"),
		FVector(70, 0, -10), FVector(0.55, 0.9, 0.7), FLinearColor(0.72f, 0.64f, 0.52f, 1.0f));
	AddChildShape(ReviewSubject, TEXT("Tower"), TEXT("/Engine/BasicShapes/Cylinder.Cylinder"),
		FVector(-55, 35, 35), FVector(0.45, 0.45, 1.1), FLinearColor(0.48f, 0.52f, 0.58f, 1.0f));

	AStaticMeshActor* Occluder = World->SpawnActor<AStaticMeshActor>(
		FVector(420, -280, 80), FRotator(0, 25, 0));
	Occluder->Tags.Add(TEXT("UEShedCameraFixture"));
	Occluder->SetActorLabel(TEXT("Review Occluder"));
	Occluder->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr,
		TEXT("/Engine/BasicShapes/Cube.Cube")));
	Occluder->SetActorScale3D(FVector(1.8, 6.0, 3.2));
	ApplySolidColor(Occluder->GetStaticMeshComponent(), FLinearColor(0.22f, 0.24f, 0.26f, 1.0f));

	TArray<AUEShedFixtureMover*> Movers;
	Movers.Reserve(ObservationMoverCount);
	constexpr int32 GridSide = 64; // 64 * 64 == ObservationMoverCount
	constexpr double GridSpacing = 220.0;
	const double GridOrigin = -0.5 * (GridSide - 1) * GridSpacing;

	for (int32 Index = 0; Index < ObservationMoverCount; ++Index)
	{
		const int32 GridX = Index % GridSide;
		const int32 GridY = Index / GridSide;
		// Exact 80% stationary / 10% flying / 10% intermittent split after rounding.
		const EUEShedFixtureMotion Motion = Index < StationaryMoverCount
			? EUEShedFixtureMotion::Stationary
			: Index < StationaryMoverCount + FlyingMoverCount
				? EUEShedFixtureMotion::Flying
				: EUEShedFixtureMotion::Intermittent;
		const FVector Origin(
			GridOrigin + GridX * GridSpacing,
			GridOrigin + GridY * GridSpacing,
			MotionBaseHeight(Motion));
		UClass* MoverClass = Motion == EUEShedFixtureMotion::Stationary
			? AUEShedFixtureStationary::StaticClass()
			: Motion == EUEShedFixtureMotion::Flying
				? AUEShedFixtureFlying::StaticClass()
				: AUEShedFixtureIntermittent::StaticClass();
		AUEShedFixtureMover* Mover = World->SpawnActor<AUEShedFixtureMover>(
			MoverClass, Origin, FRotator::ZeroRotator);
		Mover->Tags.Add(TEXT("UEShedCameraFixture"));
		Mover->LogicalIndex = Index;
		const int32 MotionVariant = Index % 32;
		Mover->Radius = Motion == EUEShedFixtureMotion::Flying
			? 220.0f + MotionVariant * 12.0f
			: 180.0f + MotionVariant * 18.0f;
		Mover->Speed = Motion == EUEShedFixtureMotion::Flying
			? 0.35f + MotionVariant * 0.04f
			: 0.45f + MotionVariant * 0.055f;
		Mover->IntermittentPeriod = 2.6f + (Index % 5) * 0.35f;
		Mover->IntermittentDutyCycle = 0.45f + (Index % 4) * 0.08f;
		Mover->ApplyVisualIdentity();
		Mover->SetActorLabel(FString::Printf(TEXT("%s %04d"), MotionFamilyLabel(Motion), Index + 1));
		Movers.Add(Mover);
	}

	for (int32 Index = 0; Index < CameraFixtureCount; ++Index)
	{
		AUEShedFixtureMover* Mover = Movers[Index];
		const double Angle = UE_TWO_PI * Index / CameraFixtureCount;
		const FVector CameraLocation(FMath::Cos(Angle) * 2600.0,
			FMath::Sin(Angle) * 2600.0, 1150.0 + (Index % 2) * 250.0);
		const FRotator CameraRotation = (Mover->GetActorLocation() - CameraLocation).Rotation();
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
		PackageName, ObservationMoverCount, CameraFixtureCount);
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
	int32 StationaryMovers = 0;
	int32 FlyingMovers = 0;
	int32 IntermittentMovers = 0;
	bool bMoverMotionsMatch = true;
	bool bHasReviewSubject = false;
	bool bHasAtmosphere = false;
	for (AActor* Actor : World->PersistentLevel->Actors)
	{
		if (Actor == nullptr) continue;
		bHasAtmosphere = bHasAtmosphere || Actor->IsA<ASkyAtmosphere>();
		bHasReviewSubject = bHasReviewSubject || Actor->GetFName() == TEXT("ReviewSubject");
		if (const AUEShedFixtureMover* Mover = Cast<AUEShedFixtureMover>(Actor))
		{
			++Movers;
			StationaryMovers += Mover->IsA<AUEShedFixtureStationary>() ? 1 : 0;
			FlyingMovers += Mover->IsA<AUEShedFixtureFlying>() ? 1 : 0;
			IntermittentMovers += Mover->IsA<AUEShedFixtureIntermittent>() ? 1 : 0;
			bMoverMotionsMatch = bMoverMotionsMatch
				&& (!Mover->IsA<AUEShedFixtureStationary>()
					|| Mover->Motion == EUEShedFixtureMotion::Stationary)
				&& (!Mover->IsA<AUEShedFixtureFlying>()
					|| Mover->Motion == EUEShedFixtureMotion::Flying)
				&& (!Mover->IsA<AUEShedFixtureIntermittent>()
					|| Mover->Motion == EUEShedFixtureMotion::Intermittent);
		}
		if (const AUEShedCameraSource* Camera = Cast<AUEShedCameraSource>(Actor))
		{
			++Cameras;
			BoundCameras += Camera->ObservationTarget != nullptr ? 1 : 0;
		}
	}
	UE_LOG(LogTemp, Display,
		TEXT("Camera fixture verification found %d movers (%d stationary / %d flying / %d intermittent), %d cameras, atmosphere=%s"),
		Movers, StationaryMovers, FlyingMovers, IntermittentMovers, Cameras,
		bHasAtmosphere ? TEXT("yes") : TEXT("no"));
	return Movers == ObservationMoverCount && Cameras == CameraFixtureCount
		&& BoundCameras == CameraFixtureCount && bHasReviewSubject && bHasAtmosphere
		&& StationaryMovers == StationaryMoverCount && FlyingMovers == FlyingMoverCount
		&& IntermittentMovers == IntermittentMoverCount && bMoverMotionsMatch;
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

	FString ConformanceDirectory;
	if (FParse::Value(*Params, TEXT("ConformanceDirectory="), ConformanceDirectory))
	{
		const FString OutputDirectory = FPaths::ConvertRelativePathToFull(ConformanceDirectory);
		IFileManager::Get().MakeDirectory(*OutputDirectory, true);
		return WriteConformanceEvidence(OutputDirectory) ? 0 : 1;
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
		Succeeded = GenerateEnhancedInputFixtures() && Succeeded;
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
		Succeeded = VerifyEnhancedInputFixtures() && Succeeded;
	}

	UE_LOG(LogTemp, Display, TEXT("UE Shed fixture %s %s"),
		VerifyOnly ? TEXT("verification") : TEXT("generation"),
		Succeeded ? TEXT("succeeded") : TEXT("failed"));
	return Succeeded ? 0 : 1;
}
