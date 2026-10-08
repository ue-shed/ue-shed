#include "UEShedLegacyFixtureCommandlets.h"
#include "UEShedLegacyFixtureTypes.h"
#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/TextPackageNamespaceUtil.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Runtime/Launch/Resources/Version.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/PackageFileSummary.h"
#include "UObject/SavePackage.h"

namespace
{
FString PackageName(const TCHAR* AssetName)
{
	return FString(TEXT("/Game/Legacy/")) + AssetName;
}

FString PackageFilename(const TCHAR* AssetName)
{
	return FPackageName::LongPackageNameToFilename(
		PackageName(AssetName), FPackageName::GetAssetPackageExtension());
}

template <typename T>
T* CreateAsset(const TCHAR* AssetName)
{
	UPackage* Package = CreatePackage(*PackageName(AssetName));
	TextNamespaceUtil::ForcePackageNamespace(Package, FString(TEXT("UEShedLegacyFixture_")) + AssetName);
	return NewObject<T>(Package, AssetName, RF_Public | RF_Standalone);
}

bool SaveAsset(UObject* Asset)
{
	UPackage* Package = Asset->GetOutermost();
	const FString Filename = PackageFilename(*Asset->GetName());
	if (!IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true)) return false;
	Package->MarkPackageDirty();
// UE 5.3 Package.h uses FSavePackageArgs; UE 4.27 uses positional save arguments.
#if ENGINE_MAJOR_VERSION >= 5
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	const bool bSaved = UPackage::SavePackage(Package, Asset, *Filename, Args);
#else
	const bool bSaved = UPackage::SavePackage(Package, Asset, RF_Public | RF_Standalone,
		*Filename, GError, nullptr, false, true, SAVE_NoError);
#endif
	UE_LOG(LogTemp, Display, TEXT("Legacy fixture %s: %s -> %s"),
		bSaved ? TEXT("saved") : TEXT("SAVE FAILED"), *Asset->GetPathName(), *Filename);
	return bSaved;
}

FText BaseText(const FString& Key, const TCHAR* Source)
{
	return FText::ChangeKey(TEXT("LegacyFixture"), Key, FText::FromString(Source));
}

FUEShedLegacyNested NestedText(const FString& Prefix, const FName TableId)
{
	FUEShedLegacyNested Nested;
	Nested.Text = BaseText(Prefix + TEXT("Nested"), TEXT("Nested greeting"));
	Nested.Texts.Add(FText::AsCultureInvariant(TEXT("Nested invariant")));
	Nested.Texts.Add(FText::FromStringTable(TableId, TEXT("Continue")));
	return Nested;
}

FUEShedLegacyFixtureRow Row(const FString& Prefix, const FName TableId, bool bEmptyContainers)
{
	FUEShedLegacyFixtureRow Result;
	Result.BaseText = BaseText(Prefix + TEXT("Base"), TEXT("Legacy greeting"));
	Result.InvariantText = FText::AsCultureInvariant(TEXT("Invariant greeting"));
	Result.TableText = FText::FromStringTable(TableId, TEXT("Greeting"));
	Result.Nested = NestedText(Prefix, TableId);
	if (bEmptyContainers)
	{
		Result.Nested.Texts.Empty();
		return Result;
	}
	Result.Texts.Add(BaseText(Prefix + TEXT("Array"), TEXT("Array greeting")));
	Result.Texts.Add(FText::AsCultureInvariant(TEXT("Array invariant")));
	Result.Texts.Add(FText::FromStringTable(TableId, TEXT("Continue")));
	Result.Texts.Add(FText());
	Result.TextMap.Add(TEXT("Localized"), BaseText(Prefix + TEXT("Map"), TEXT("Map greeting")));
	Result.TextMap.Add(TEXT("Table"), FText::FromStringTable(TableId, TEXT("Farewell")));
	Result.Vectors.Add(FVector(1.25, -2.5, 3.75));
	Result.Vectors.Add(FVector(-4.5, 5.25, -6.75));
	Result.NestedMap.Add(TEXT("First"), NestedText(Prefix + TEXT("First"), TableId));
	Result.NestedMap.Add(TEXT("Second"), NestedText(Prefix + TEXT("Second"), TableId));
	Result.NativeVectors.Add(TEXT("UnknownWidth"), FVector(1.25, -2.5, 3.75));
	return Result;
}

bool BuildFixtures()
{
	UStringTable* Table = CreateAsset<UStringTable>(TEXT("ST_LegacyText"));
	const FStringTableRef Strings = Table->GetMutableStringTable();
	Strings->SetNamespace(TEXT("LegacyStringTable"));
	Strings->SetSourceString(TEXT("Continue"), TEXT("Continue onward"));
	Strings->SetSourceString(TEXT("Farewell"), TEXT("Until next time"));
	Strings->SetSourceString(TEXT("Greeting"), TEXT("Welcome back"));
	Strings->SetMetaData(TEXT("Continue"), TEXT("Comment"), TEXT("Navigation prompt"));
	Strings->SetMetaData(TEXT("Farewell"), TEXT("Comment"), TEXT("Closing greeting"));
	Strings->SetMetaData(TEXT("Greeting"), TEXT("Comment"), TEXT("Opening greeting"));
	Strings->SetMetaData(TEXT("Greeting"), TEXT("Context"), TEXT("Menu"));
	if (!SaveAsset(Table)) return false;

	UDataTable* Rows = CreateAsset<UDataTable>(TEXT("DT_LegacyText"));
	Rows->RowStruct = FUEShedLegacyFixtureRow::StaticStruct();
	Rows->AddRow(TEXT("EmptyContainers"), Row(TEXT("Empty"), Table->GetStringTableId(), true));
	Rows->AddRow(TEXT("Full"), Row(TEXT("Full"), Table->GetStringTableId(), false));
	if (!SaveAsset(Rows)) return false;

	UUEShedLegacyFixtureTextAsset* Asset =
		CreateAsset<UUEShedLegacyFixtureTextAsset>(TEXT("DA_LegacyText"));
	Asset->Text = BaseText(TEXT("Asset"), TEXT("Asset greeting"));
	Asset->Texts.Add(FText::AsCultureInvariant(TEXT("Asset invariant")));
	Asset->Texts.Add(FText::FromStringTable(Table->GetStringTableId(), TEXT("Greeting")));
	Asset->Nested = NestedText(TEXT("Asset"), Table->GetStringTableId());
	return SaveAsset(Asset);
}

void SetOptionalString(const TSharedRef<FJsonObject>& Object, const TCHAR* Field,
	const TOptional<FString>& Value)
{
	if (Value.IsSet()) Object->SetStringField(Field, Value.GetValue());
	else Object->SetField(Field, MakeShared<FJsonValueNull>());
}

TSharedPtr<FJsonValue> TextEvidence(const FText& Text, const FString& Path, const FString& RowName)
{
	// FText::SerializeText is private in UE 4.27 and 5.3, so the history kind comes from the public
	// inspector: a table reference, then culture-invariant or empty text (None), otherwise Base.
	FName TableId;
	FString TableKey;
	const bool bTableEntry = FTextInspector::GetTableIdAndKey(Text, TableId, TableKey);
	const TCHAR* History = bTableEntry ? TEXT("string_table_entry")
		: Text.IsCultureInvariant() || Text.IsEmpty() ? TEXT("none") : TEXT("base");
	if (!bTableEntry && FCString::Strcmp(History, TEXT("base")) == 0
		&& !FTextInspector::GetKey(Text).IsSet())
	{
		UE_LOG(LogTemp, Error, TEXT("Text at %s has no table, invariant, or key identity"), *Path);
		return nullptr;
	}
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("property_path"), Path);
	SetOptionalString(Result, TEXT("row"),
		RowName.IsEmpty() ? TOptional<FString>() : TOptional<FString>(RowName));
	const FString* Source = FTextInspector::GetSourceString(Text);
	Result->SetStringField(TEXT("source"), Source ? *Source : FString());
	Result->SetBoolField(TEXT("culture_invariant"), Text.IsCultureInvariant());
	Result->SetStringField(TEXT("history"), History);
	SetOptionalString(Result, TEXT("namespace"), FTextInspector::GetNamespace(Text));
	SetOptionalString(Result, TEXT("key"), FTextInspector::GetKey(Text));
	if (bTableEntry)
	{
		Result->SetStringField(TEXT("table_id"), TableId.ToString());
		Result->SetStringField(TEXT("key"), TableKey);
	}
	else Result->SetField(TEXT("table_id"), MakeShared<FJsonValueNull>());
	return MakeShared<FJsonValueObject>(Result);
}

void AddTextArray(TArray<TSharedPtr<FJsonValue>>& Out, const TArray<FText>& Texts,
	const FString& Path, const FString& RowName)
{
	for (int32 Index = 0; Index < Texts.Num(); ++Index)
		Out.Add(TextEvidence(Texts[Index], FString::Printf(TEXT("%s[%d]"), *Path, Index), RowName));
}

void AddNested(TArray<TSharedPtr<FJsonValue>>& Out, const FUEShedLegacyNested& Nested,
	const FString& Path, const FString& RowName)
{
	Out.Add(TextEvidence(Nested.Text, Path + TEXT(".Text"), RowName));
	AddTextArray(Out, Nested.Texts, Path + TEXT(".Texts"), RowName);
}

TSharedRef<FJsonObject> RowEvidence(const FUEShedLegacyFixtureRow& Value, const FString& Name)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	TArray<TSharedPtr<FJsonValue>> Texts;
	Texts.Add(TextEvidence(Value.BaseText, TEXT("BaseText"), Name));
	Texts.Add(TextEvidence(Value.InvariantText, TEXT("InvariantText"), Name));
	Texts.Add(TextEvidence(Value.TableText, TEXT("TableText"), Name));
	Texts.Add(TextEvidence(Value.EmptyText, TEXT("EmptyText"), Name));
	AddTextArray(Texts, Value.Texts, TEXT("Texts"), Name);
	int32 Index = 0;
	for (const TPair<FName, FText>& Pair : Value.TextMap)
		Texts.Add(TextEvidence(Pair.Value, FString::Printf(TEXT("TextMap{%d}.value"), Index++), Name));
	AddNested(Texts, Value.Nested, TEXT("Nested"), Name);
	Index = 0;
	for (const TPair<FName, FUEShedLegacyNested>& Pair : Value.NestedMap)
		AddNested(Texts, Pair.Value, FString::Printf(TEXT("NestedMap{%d}.value"), Index++), Name);
	Result->SetStringField(TEXT("name"), Name);
	Result->SetArrayField(TEXT("texts"), Texts);
	TArray<TSharedPtr<FJsonValue>> Vectors;
	for (const FVector& Vector : Value.Vectors)
	{
		TArray<TSharedPtr<FJsonValue>> Components;
		Components.Add(MakeShared<FJsonValueNumber>(Vector.X));
		Components.Add(MakeShared<FJsonValueNumber>(Vector.Y));
		Components.Add(MakeShared<FJsonValueNumber>(Vector.Z));
		Vectors.Add(MakeShared<FJsonValueArray>(Components));
	}
	Result->SetArrayField(TEXT("vectors"), Vectors);
	return Result;
}

TSharedPtr<FJsonObject> PackageEvidence(const TCHAR* Name, UObject* Asset)
{
	TUniquePtr<FArchive> Reader(IFileManager::Get().CreateFileReader(*PackageFilename(Name)));
	if (!Reader) return nullptr;
	FPackageFileSummary Summary;
	*Reader << Summary;
	if (Reader->IsError()) return nullptr;
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("asset_name"), Name);
	Result->SetStringField(TEXT("object_path"), Asset->GetPathName());
	Result->SetStringField(TEXT("class_path"), Asset->GetClass()->GetPathName());
	TSharedRef<FJsonObject> Versions = MakeShared<FJsonObject>();
// UE 5.3 PackageFileSummary.h has a UE4/UE5 pair; UE 4.27 has only UE4 and licensee.
#if ENGINE_MAJOR_VERSION >= 5
	Result->SetStringField(TEXT("serialized_package_name"), Summary.PackageName);
	Versions->SetNumberField(TEXT("ue4"), Summary.GetFileVersionUE().FileVersionUE4);
	Versions->SetNumberField(TEXT("ue5"), Summary.GetFileVersionUE().FileVersionUE5);
	Versions->SetNumberField(TEXT("licensee"), Summary.GetFileVersionLicenseeUE());
#else
	Result->SetStringField(TEXT("serialized_package_name"), Summary.FolderName);
	Versions->SetNumberField(TEXT("ue4"), Summary.GetFileVersionUE4());
	Versions->SetField(TEXT("ue5"), MakeShared<FJsonValueNull>());
	Versions->SetNumberField(TEXT("licensee"), Summary.GetFileVersionLicenseeUE4());
#endif
	Result->SetObjectField(TEXT("versions"), Versions);
	return Result;
}

bool SortJson(const TSharedPtr<FJsonValue>& Value)
{
	if (!Value.IsValid()) return false;
	if (Value->Type == EJson::Object)
	{
		const TSharedPtr<FJsonObject> Object = Value->AsObject();
		Object->Values.KeySort([](const FString& A, const FString& B) { return A < B; });
		for (const auto& Pair : Object->Values)
			if (!SortJson(Pair.Value)) return false;
	}
	else if (Value->Type == EJson::Array)
	{
		for (const auto& Item : Value->AsArray())
			if (!SortJson(Item)) return false;
	}
	return true;
}

bool WriteEvidence(const FString& Filename)
{
	UStringTable* Table = LoadObject<UStringTable>(nullptr,
		TEXT("/Game/Legacy/ST_LegacyText.ST_LegacyText"));
	UDataTable* Rows = LoadObject<UDataTable>(nullptr,
		TEXT("/Game/Legacy/DT_LegacyText.DT_LegacyText"));
	UUEShedLegacyFixtureTextAsset* Asset = LoadObject<UUEShedLegacyFixtureTextAsset>(nullptr,
		TEXT("/Game/Legacy/DA_LegacyText.DA_LegacyText"));
	if (!Table || !Rows || !Asset)
	{
		UE_LOG(LogTemp, Error, TEXT("Could not load all three saved /Game/Legacy/ fixtures"));
		return false;
	}
	const auto DataEvidence = PackageEvidence(TEXT("DA_LegacyText"), Asset);
	const auto RowPackage = PackageEvidence(TEXT("DT_LegacyText"), Rows);
	const auto StringPackage = PackageEvidence(TEXT("ST_LegacyText"), Table);
	if (!DataEvidence || !RowPackage || !StringPackage) return false;
	TArray<TSharedPtr<FJsonValue>> Texts;
	Texts.Add(TextEvidence(Asset->Text, TEXT("Text"), FString()));
	AddTextArray(Texts, Asset->Texts, TEXT("Texts"), FString());
	AddNested(Texts, Asset->Nested, TEXT("Nested"), FString());
	DataEvidence->SetArrayField(TEXT("texts"), Texts);

	TArray<FName> Names = Rows->GetRowNames();
	Names.Sort([](const FName A, const FName B) { return A.ToString() < B.ToString(); });
	TArray<TSharedPtr<FJsonValue>> RowValues;
	for (const FName Name : Names)
	{
		const auto* Value = Rows->FindRow<FUEShedLegacyFixtureRow>(Name, TEXT("Legacy evidence"));
		if (!Value) return false;
		RowValues.Add(MakeShared<FJsonValueObject>(RowEvidence(*Value, Name.ToString())));
	}
	RowPackage->SetArrayField(TEXT("rows"), RowValues);

	const FStringTableConstRef Strings = Table->GetStringTable();
	TMap<FString, FString> Sources;
	Strings->EnumerateSourceStrings([&Sources](const FString& Key, const FString& Source)
	{
		Sources.Add(Key, Source);
		return true;
	});
	Sources.KeySort([](const FString& A, const FString& B) { return A < B; });
	TArray<TSharedPtr<FJsonValue>> Entries;
	for (const auto& Pair : Sources)
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("key"), Pair.Key);
		Entry->SetStringField(TEXT("source"), Pair.Value);
		TSharedRef<FJsonObject> Metadata = MakeShared<FJsonObject>();
		Strings->EnumerateMetaData(Pair.Key, [&Metadata](FName Id, const FString& Value)
		{
			Metadata->SetStringField(Id.ToString(), Value);
			return true;
		});
		Entry->SetObjectField(TEXT("metadata"), Metadata);
		Entries.Add(MakeShared<FJsonValueObject>(Entry));
	}
	StringPackage->SetStringField(TEXT("namespace"), Strings->GetNamespace());
	StringPackage->SetArrayField(TEXT("entries"), Entries);
	TArray<TSharedPtr<FJsonValue>> Packages;
	Packages.Add(MakeShared<FJsonValueObject>(DataEvidence));
	Packages.Add(MakeShared<FJsonValueObject>(RowPackage));
	Packages.Add(MakeShared<FJsonValueObject>(StringPackage));
	TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetNumberField(TEXT("schema_version"), 1);
	Root->SetStringField(TEXT("engine_version"),
		FString::Printf(TEXT("%d.%d"), ENGINE_MAJOR_VERSION, ENGINE_MINOR_VERSION));
	Root->SetArrayField(TEXT("packages"), Packages);
	if (!SortJson(MakeShared<FJsonValueObject>(Root))) return false;
	FString Json;
	if (!FJsonSerializer::Serialize(Root, TJsonWriterFactory<>::Create(&Json))) return false;
	if (!IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true)) return false;
	if (!FFileHelper::SaveStringToFile(Json + TEXT("\n"), *Filename,
		FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return false;
	UE_LOG(LogTemp, Display, TEXT("Legacy fixture evidence: %d packages -> %s"), Packages.Num(), *Filename);
	return true;
}
}

UUEShedLegacyFixtureBuildCommandlet::UUEShedLegacyFixtureBuildCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

int32 UUEShedLegacyFixtureBuildCommandlet::Main(const FString&)
{
	return BuildFixtures() ? 0 : 1;
}

UUEShedLegacyFixtureEvidenceCommandlet::UUEShedLegacyFixtureEvidenceCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

int32 UUEShedLegacyFixtureEvidenceCommandlet::Main(const FString& Params)
{
	FString Filename;
	if (!FParse::Value(*Params, TEXT("Evidence="), Filename))
	{
		UE_LOG(LogTemp, Error, TEXT("Legacy evidence requires -Evidence=<json filename>"));
		return 1;
	}
	return WriteEvidence(FPaths::ConvertRelativePathToFull(Filename)) ? 0 : 1;
}
