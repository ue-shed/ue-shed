#include "UEShedLocalizationFixture.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Engine/DataTable.h"
#include "HAL/FileManager.h"
#include "Internationalization/InternationalizationArchive.h"
#include "Internationalization/Culture.h"
#include "Internationalization/Internationalization.h"
#include "Internationalization/TextFormatter.h"
#include "Internationalization/TextLocalizationResource.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/TextNamespaceUtil.h"
#include "LocalizationConfigurationScript.h"
#include "LocalizationSettings.h"
#include "LocTextHelper.h"
#include "Misc/EngineVersion.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/OutputDevice.h"
#include "Misc/OutputDeviceRedirector.h"
#include "PortableObjectPipeline.h"
#include "TextLocalizationResourceGenerator.h"
#include "PortableObjectFormatDOM.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UEShedFixtureTypes.h"

namespace
{
const TCHAR* TargetName = TEXT("FixtureGame");
const TCHAR* TablePath = TEXT("/Game/Fixture/Localization/ST_Localization.ST_Localization");
const TCHAR* DataTablePath = TEXT("/Game/Fixture/Localization/DT_Localization.DT_Localization");
const TCHAR* AssetPath = TEXT("/Game/Fixture/Localization/DA_Localization.DA_Localization");
const TCHAR* TableNamespace = TEXT("Fixture.Localization.Table");
const TCHAR* AssetNamespace = TEXT("Fixture.Localization.Asset");
const TCHAR* RowNamespace = TEXT("Fixture.Localization.Rows");
const TArray<FString> Cultures = { TEXT("en"), TEXT("de"), TEXT("fr") };

FString DataDirectory()
{
	return FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir() / TEXT("Localization") / TargetName);
}

FString POPath(const FString& Culture)
{
	return DataDirectory() / Culture / (FString(TargetName) + TEXT(".po"));
}

bool Save(UObject* Asset)
{
	UPackage* Package = Asset->GetOutermost();
	Package->MarkPackageDirty();
	const FString Filename = FPackageName::LongPackageNameToFilename(
		Package->GetName(), FPackageName::GetAssetPackageExtension());
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Asset, *Filename, Args);
}

template <typename T> T* CreateAsset(const TCHAR* ObjectPath)
{
	if (T* Existing = LoadObject<T>(nullptr, ObjectPath)) return Existing;
	const FString Path(ObjectPath);
	const FString PackageName = FPackageName::ObjectPathToPackageName(Path);
	UPackage* Package = CreatePackage(*PackageName);
	T* Asset = NewObject<T>(Package, *FPackageName::ObjectPathToObjectName(Path),
		RF_Public | RF_Standalone | RF_Transactional);
	FAssetRegistryModule::AssetCreated(Asset);
	return Asset;
}

FText Text(const TCHAR* Namespace, const TCHAR* Key, const TCHAR* Source)
{
	return FText::ChangeKey(FTextKey(Namespace), FTextKey(Key), FText::FromString(Source));
}

void SetString(const FStringTableRef& Table, const TCHAR* Key, const TCHAR* Source,
	const FString& Notes = FString())
{
#if UE_VERSION_OLDER_THAN(5, 8, 0)
	Table->SetSourceString(FTextKey(Key), Source);
#else
	Table->SetSourceString(FTextKey(Key), Source, Notes);
#endif
	if (!Notes.IsEmpty()) Table->SetMetaData(FTextKey(Key), TEXT("Comment"), Notes);
}

bool InitialAssets()
{
	UStringTable* Strings = CreateAsset<UStringTable>(TablePath);
	FStringTableRef Table = Strings->GetMutableStringTable();
	Table->ClearSourceStrings();
	Table->ClearMetaData();
	Table->SetNamespace(FTextKey(TableNamespace));
	SetString(Table, TEXT("Welcome"), TEXT("Welcome back"), TEXT("Greeting on the start screen."));
	SetString(Table, TEXT("NamedArgument"), TEXT("Talking with {PlayerName}"));
	SetString(Table, TEXT("OrderedArgument"), TEXT("Checkpoint {0}"));
	SetString(Table, TEXT("Plural"), TEXT("{Count} {Count}|plural(one=item,other=items)"));
	SetString(Table, TEXT("RichText"), TEXT("<Em>Continue</>"));
	SetString(Table, TEXT("Whitespace"), TEXT("Keep moving"));
	SetString(Table, TEXT("LineBreak"), TEXT("First\nSecond"));
	SetString(Table, TEXT("LiteralEscape"), TEXT("Type a slash"));
	SetString(Table, TEXT("Ordinal"), TEXT("{Rank}|ordinal(one=first,two=second,few=third,other=last)"));
	SetString(Table, TEXT("Gender"), TEXT("{Person}|gender(He,She,They)"));
	SetString(Table, TEXT("Hangul"), TEXT("{Name}|hpp(은,는)"));
	SetString(Table, TEXT("MissingPluralForm"), TEXT("{Count}|plural(one=item,other=items)"));
	SetString(Table, TEXT("MalformedModifier"), TEXT("{Count}|plural(one=item,other=items)"));
	SetString(Table, TEXT("NestedPlural"), TEXT("{Count}|plural(one=\"{Owner} has one item\",other=\"{Owner} has items\")"));
	SetString(Table, TEXT("Unsynced"), TEXT("Start a new session"));
	SetString(Table, TEXT("ChangedAfterGather"), TEXT("Gathered instruction"));
	SetString(Table, TEXT("RemovedAfterGather"), TEXT("Temporary instruction"));
	if (!Save(Strings)) return false;

	UDataTable* Rows = CreateAsset<UDataTable>(DataTablePath);
	Rows->RowStruct = FUEShedFixtureTextRow::StaticStruct();
	Rows->EmptyTable();
	FUEShedFixtureTextRow Row;
	Row.DisplayName = Text(RowNamespace, TEXT("MissingFrench"), TEXT("Save progress"));
	Rows->AddRow(TEXT("MissingFrench"), Row);
	Row.DisplayName = Text(RowNamespace, TEXT("EmptyFrench"), TEXT("Return to menu"));
	Rows->AddRow(TEXT("EmptyFrench"), Row);
	if (!Save(Rows)) return false;

	UUEShedFixtureTextAsset* Asset = CreateAsset<UUEShedFixtureTextAsset>(AssetPath);
	Asset->SharedPrimary = Text(AssetNamespace, TEXT("Outdated"), TEXT("Open the door"));
	Asset->SharedSecondary = FText::GetEmpty();
	Asset->EqualSourceFirst = Text(AssetNamespace, TEXT("DuplicateA"), TEXT("Confirm"));
	Asset->EqualSourceSecond = Text(AssetNamespace, TEXT("DuplicateB"), TEXT("Confirm"));
	Asset->StringTableReference = FText::GetEmpty();
	return Save(Asset);
}

bool GenerateConfigs()
{
	ULocalizationTargetSet* Targets = ULocalizationSettings::GetGameTargetSet();
	ULocalizationTarget* Target = nullptr;
	for (ULocalizationTarget* Candidate : Targets->TargetObjects)
	{
		if (Candidate && Candidate->Settings.Name == TargetName) Target = Candidate;
	}
	if (!Target)
	{
		Target = NewObject<ULocalizationTarget>(Targets);
		Targets->TargetObjects.Add(Target);
	}
	FLocalizationTargetSettings Settings;
	Settings.Name = TargetName;
	Settings.Guid = FGuid(0x05100000, 0x12345678, 0x90ABCDEF, 0x00000001);
	Settings.NativeCultureIndex = 0;
	for (const FString& Culture : Cultures) Settings.SupportedCulturesStatistics.Add(FCultureStatistics(Culture));
	Settings.RequiredModuleNames.Add(TEXT("UEShedFixture"));
	FGatherTextSearchDirectory Source;
	Source.Path = TEXT("Source/UEShedFixture");
	Settings.GatherFromTextFiles.SearchDirectories.Add(Source);
	FGatherTextIncludePath Content;
	Content.Pattern = TEXT("Content/Fixture/Localization/*");
	Settings.GatherFromPackages.IncludePathWildcards.Add(Content);
	Settings.GatherFromPackages.SkipGatherCache = true;
	Settings.ExportSettings.ShouldPersistCommentsOnExport = true;
	Target->Settings = Settings;
	// The Dashboard's own propagation saves +GameTargetsSettings to DefaultEditor.ini.
	GetMutableDefault<ULocalizationSettings>()->PostEditChange();
	if (!GetMutableDefault<ULocalizationSettings>()->TryUpdateDefaultConfigFile()) return false;
	IFileManager::Get().MakeDirectory(*LocalizationConfigurationScript::GetConfigDirectory(Target), true);
	// Use the generated FConfigFile directly; WriteWithSCC would invoke source-control hooks.
	return LocalizationConfigurationScript::GenerateGatherTextConfigFile(Target).Write(
		LocalizationConfigurationScript::GetGatherTextConfigPath(Target))
		&& LocalizationConfigurationScript::GenerateImportTextConfigFile(Target).Write(
			LocalizationConfigurationScript::GetImportTextConfigPath(Target))
		&& LocalizationConfigurationScript::GenerateExportTextConfigFile(Target).Write(
			LocalizationConfigurationScript::GetExportTextConfigPath(Target))
		&& LocalizationConfigurationScript::GenerateCompileTextConfigFile(Target).Write(
			LocalizationConfigurationScript::GetCompileTextConfigPath(Target))
		&& LocalizationConfigurationScript::GenerateWordCountReportConfigFile(Target).Write(
			LocalizationConfigurationScript::GetWordCountReportConfigPath(Target));
}

// UE 5.8 may key FJsonObject::Values by UE::FSharedString; both key types dereference to TCHAR.
template <typename KeyType> FString JsonKey(const KeyType& Key)
{
	return FString(*Key);
}

TSharedPtr<FJsonObject> LoadInputs()
{
	FString Contents;
	TSharedPtr<FJsonObject> Result;
	if (!FFileHelper::LoadFileToString(Contents, *(FPaths::ProjectDir()
		/ TEXT("FixtureSource/Localization/translations.json")))
		|| !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Contents), Result)) return nullptr;
	for (const TCHAR* Tree : { TEXT("translations"), TEXT("poOverrides") })
	{
		const TSharedPtr<FJsonObject>* CulturesObject = nullptr;
		if (!Result->TryGetObjectField(Tree, CulturesObject)) return nullptr;
		for (const auto& Culture : (*CulturesObject)->Values)
		{
			if ((JsonKey(Culture.Key) != TEXT("de") && JsonKey(Culture.Key) != TEXT("fr"))
				|| Culture.Value->Type != EJson::Object) return nullptr;
			for (const auto& Namespace : Culture.Value->AsObject()->Values)
			{
				if (Namespace.Value->Type != EJson::Object) return nullptr;
				for (const auto& Key : Namespace.Value->AsObject()->Values)
					if (Key.Value->Type != EJson::String) return nullptr;
			}
		}
	}
	return Result;
}

bool LoadPO(const FString& Culture, FPortableObjectFormatDOM& PO)
{
	FString Contents;
	return FFileHelper::LoadFileToString(Contents, *POPath(Culture)) && PO.FromString(Contents);
}

bool Translate()
{
	const TSharedPtr<FJsonObject> Inputs = LoadInputs();
	if (!Inputs) return false;
	FLocTextHelper Helper(DataDirectory(), TEXT("FixtureGame.manifest"), TEXT("FixtureGame.archive"),
		TEXT("en"), { TEXT("de"), TEXT("fr") }, nullptr);
	if (!Helper.LoadAll(ELocTextHelperLoadFlags::Load)) return false;
	for (const auto& Culture : Inputs->GetObjectField(TEXT("translations"))->Values)
	{
		const FString CultureName = JsonKey(Culture.Key);
		if (CultureName != TEXT("de") && CultureName != TEXT("fr")) return false;
		for (const auto& Namespace : Culture.Value->AsObject()->Values)
		{
			const FString NamespaceName = JsonKey(Namespace.Key);
			for (const auto& Key : Namespace.Value->AsObject()->Values)
			{
				const FString KeyName = JsonKey(Key.Key);
				const TSharedPtr<FManifestEntry> Entry = Helper.FindSourceText(FLocKey(NamespaceName), FLocKey(KeyName));
				if (!Entry) return false;
				const FManifestContext* Context = Entry->FindContextByKey(FLocKey(KeyName));
				if (!Context || !Helper.ImportTranslation(CultureName, Entry->Namespace, Context->Key,
					Context->KeyMetadataObj, Entry->Source, FLocItem(Key.Value->AsString()), Context->bIsOptional)) return false;
			}
		}
		if (!Helper.SaveArchive(CultureName)) return false;
	}
	return true;
}

bool Unsynced()
{
	const TSharedPtr<FJsonObject> Inputs = LoadInputs();
	if (!Inputs) return false;
	for (const auto& Culture : Inputs->GetObjectField(TEXT("poOverrides"))->Values)
	{
		const FString CultureName = JsonKey(Culture.Key);
		FPortableObjectFormatDOM PO;
		if (!LoadPO(CultureName, PO)) return false;
		for (const auto& Namespace : Culture.Value->AsObject()->Values)
		{
			for (const auto& Key : Namespace.Value->AsObject()->Values)
			{
				const FString Context = JsonKey(Namespace.Key) + TEXT(",") + JsonKey(Key.Key);
				TSharedPtr<FPortableObjectEntry> Match;
				for (auto It = PO.GetEntriesIterator(); It; ++It)
				{
					if (It.Value()->MsgCtxt == Context) Match = It.Value();
				}
				if (!Match || Match->MsgStr.Num() != 1) return false;
				Match->MsgStr[0] = Key.Value->AsString();
			}
		}
		// Unreal's PO DOM owns serialization, with the same encoding as PortableObjectPipeline.
		if (!FFileHelper::SaveStringToFile(PO.ToString(), *POPath(CultureName),
			FFileHelper::EEncodingOptions::ForceUTF8)) return false;
	}
	return true;
}

struct FCurrentText
{
	FString Namespace;
	FString Key;
	FString Source;
	FString Path;
	bool InTarget;
};

bool ReadAssets(TArray<FCurrentText>& Current, TArray<FString>& ReadablePackages)
{
	UStringTable* Strings = LoadObject<UStringTable>(nullptr, TablePath);
	UDataTable* Rows = LoadObject<UDataTable>(nullptr, DataTablePath);
	UUEShedFixtureTextAsset* Asset = LoadObject<UUEShedFixtureTextAsset>(nullptr, AssetPath);
	UStringTable* Outside = LoadObject<UStringTable>(nullptr, TEXT("/Game/Fixture/Text/ST_Game.ST_Game"));
	if (!Strings || !Rows || !Asset || !Outside
		|| Rows->GetRowStruct() != FUEShedFixtureTextRow::StaticStruct()) return false;
	for (UStringTable* TableAsset : { Strings, Outside })
	{
		ReadablePackages.Add(TableAsset->GetOutermost()->GetName());
		TableAsset->GetStringTable()->EnumerateSourceStrings(
			[&](const FString& Key, const FString& Source)
			{
				Current.Add({ TableAsset->GetStringTable()->GetNamespace(), Key, Source,
					TableAsset->GetPathName() + TEXT(":") + Key, TableAsset == Strings });
				return true;
			});
	}
	const auto AddText = [&Current](const FText& Value, const FString& Path)
	{
		const TOptional<FString> Namespace = FTextInspector::GetNamespace(Value);
		const TOptional<FString> Key = FTextInspector::GetKey(Value);
		const FString* Source = FTextInspector::GetSourceString(Value);
		if (Namespace.IsSet() && Key.IsSet() && Source)
			Current.Add({ TextNamespaceUtil::StripPackageNamespace(Namespace.GetValue()),
				Key.GetValue(), *Source, Path, true });
	};
	ReadablePackages.Add(Rows->GetOutermost()->GetName());
	for (const auto& Row : Rows->GetRowMap())
	{
		AddText(reinterpret_cast<const FUEShedFixtureTextRow*>(Row.Value)->DisplayName,
			Rows->GetPathName() + TEXT(":") + Row.Key.ToString() + TEXT(".DisplayName"));
	}
	ReadablePackages.Add(Asset->GetOutermost()->GetName());
	AddText(Asset->SharedPrimary, Asset->GetPathName() + TEXT(":SharedPrimary"));
	AddText(Asset->SharedSecondary, Asset->GetPathName() + TEXT(":SharedSecondary"));
	AddText(Asset->EqualSourceFirst, Asset->GetPathName() + TEXT(":EqualSourceFirst"));
	AddText(Asset->EqualSourceSecond, Asset->GetPathName() + TEXT(":EqualSourceSecond"));
	AddText(Asset->StringTableReference, Asset->GetPathName() + TEXT(":StringTableReference"));
	return true;
}

void Nullable(const TSharedRef<FJsonObject>& Object, const TCHAR* Name, const FString* Value)
{
	if (Value) Object->SetStringField(Name, *Value);
	else Object->SetField(Name, MakeShared<FJsonValueNull>());
}

FString RelativeLocation(FString Location)
{
	// Source gather can report absolute filenames in disposable projects. Retain line numbers.
	Location.ReplaceInline(TEXT("\\"), TEXT("/"));
	FString Project = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
	Project.ReplaceInline(TEXT("\\"), TEXT("/"));
	if (Location.StartsWith(Project)) Location.RightChopInline(Project.Len());
	return Location;
}

// Observe the actual compile validator through its public API. Never reproduce the private
// tag validator in the fixture oracle; the helper and generated resource stay in memory.
class FValidationWarnings final : public FOutputDevice
{
public:
	int32 Count = 0;
	FValidationWarnings() { GLog->AddOutputDevice(this); }
	~FValidationWarnings() override { GLog->RemoveOutputDevice(this); }
	void Serialize(const TCHAR*, ELogVerbosity::Type Verbosity, const FName& Category) override
	{
		if (Category == TEXT("LogTextLocalizationResourceGenerator")
			&& (Verbosity & ELogVerbosity::VerbosityMask) == ELogVerbosity::Warning) ++Count;
	}
};

bool CompileValidation(const FString& Source, const FString& Translation, EGenerateLocResFlags Flags, bool& Valid)
{
	// FLocTextHelper requires a target path; this helper is never saved, so a scratch path suffices.
	FLocTextHelper Single(FPaths::ProjectIntermediateDir() / TEXT("UEShedLocalizationValidation"),
		TEXT("Validation.manifest"), TEXT("Validation.archive"), TEXT("en"), { TEXT("de") }, nullptr);
	if (!Single.LoadAll(ELocTextHelperLoadFlags::Create)) return false;
	FManifestContext Site;
	Site.Key = FLocKey(TEXT("Validation"));
	Site.SourceLocation = TEXT("Validation");
	if (!Single.AddSourceText(FLocKey(TEXT("Validation")), FLocItem(Source), Site)
		|| !Single.AddTranslation(TEXT("en"), FLocKey(TEXT("Validation")), Site.Key, nullptr, FLocItem(Source), FLocItem(Source), false)
		|| !Single.AddTranslation(TEXT("de"), FLocKey(TEXT("Validation")), Site.Key, nullptr, FLocItem(Source), FLocItem(Translation), false)) return false;
	FTextLocalizationResource Resource;
	TMap<FName, TSharedRef<FTextLocalizationResource>> Platforms;
	FValidationWarnings Warnings;
	// Equal source/native text must still run the native compiler's whitespace validation.
	const FString ValidationCulture = Source == Translation ? TEXT("en") : TEXT("de");
	// Unreal derives the localization target directory from a LocRes path ID (<target>/<culture>/<name>.locres).
	const FString LocResID = Single.GetTargetPath() / ValidationCulture / TEXT("Validation.locres");
	if (!FTextLocalizationResourceGenerator::GenerateLocRes(Single, ValidationCulture, Flags, FTextKey(LocResID), Resource, Platforms)) return false;
	// Log records can be dispatched to output devices asynchronously; deliver them before counting.
	GLog->Flush();
	Valid = Warnings.Count == 0;
	return true;
}

TArray<TSharedPtr<FJsonValue>> JsonStrings(const TArray<FString>& Strings)
{
	TArray<TSharedPtr<FJsonValue>> Values;
	for (const FString& String : Strings) Values.Add(MakeShared<FJsonValueString>(String));
	return Values;
}

TSharedRef<FJsonObject> FormatValidation(const FString& Pattern, const FCulturePtr& Culture)
{
	const FTextFormat Format = FTextFormat::FromString(Pattern);
	TArray<FString> Errors;
	const bool Valid = Format.ValidatePattern(Culture, Errors);
	TArray<FString> Arguments;
	Format.GetFormatArgumentNames(Arguments);
	Arguments.Sort();
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("valid"), Valid);
	Result->SetArrayField(TEXT("errors"), JsonStrings(Errors));
	Result->SetArrayField(TEXT("arguments"), JsonStrings(Arguments));
	return Result;
}

TArray<TSharedPtr<FJsonValue>> PluralForms(const FCulturePtr& Culture, ETextPluralType Type)
{
	TArray<FString> Names;
	for (ETextPluralForm Form : Culture->GetValidPluralForms(Type))
	{
		switch (Form)
		{
		case ETextPluralForm::Zero: Names.Add(TEXT("zero")); break;
		case ETextPluralForm::One: Names.Add(TEXT("one")); break;
		case ETextPluralForm::Two: Names.Add(TEXT("two")); break;
		case ETextPluralForm::Few: Names.Add(TEXT("few")); break;
		case ETextPluralForm::Many: Names.Add(TEXT("many")); break;
		default: Names.Add(TEXT("other")); break;
		}
	}
	Names.Sort();
	return JsonStrings(Names);
}

bool ValidationEvidence(const FString& Source, const FString* Translation, const FString& CultureName, TSharedRef<FJsonObject> Result)
{
	const FCulturePtr Culture = FInternationalization::Get().GetCulture(CultureName);
	if (!Culture) return false;
	Result->SetObjectField(TEXT("sourceFormat"), FormatValidation(Source, Culture));
	Result->SetArrayField(TEXT("cardinalForms"), PluralForms(Culture, ETextPluralType::Cardinal));
	Result->SetArrayField(TEXT("ordinalForms"), PluralForms(Culture, ETextPluralType::Ordinal));
	bool SourceRichText = true;
	if (!CompileValidation(Source, Source, EGenerateLocResFlags::ValidateRichTextTags, SourceRichText)) return false;
	Result->SetBoolField(TEXT("sourceRichTextValid"), SourceRichText);
	bool SourceWhitespace = true;
	if (!CompileValidation(Source, Source, EGenerateLocResFlags::ValidateSafeWhitespace, SourceWhitespace)) return false;
	Result->SetBoolField(TEXT("sourceSafeWhitespaceValid"), SourceWhitespace);
	Nullable(Result, TEXT("checkedTranslation"), Translation);
	if (Translation)
	{
		Result->SetObjectField(TEXT("translationFormat"), FormatValidation(*Translation, Culture));
		bool RichText = true;
		if (!CompileValidation(Source, *Translation, EGenerateLocResFlags::ValidateRichTextTags, RichText)) return false;
		Result->SetBoolField(TEXT("translationRichTextValid"), RichText);
		bool Whitespace = true;
		if (!CompileValidation(Source, *Translation, EGenerateLocResFlags::ValidateSafeWhitespace, Whitespace)) return false;
		Result->SetBoolField(TEXT("translationSafeWhitespaceValid"), Whitespace);
		const FString RoundTrip = PortableObjectPipeline::ConditionPOStringForArchive(PortableObjectPipeline::ConditionArchiveStrForPO(*Translation));
		Result->SetStringField(TEXT("poRoundTripTranslation"), RoundTrip);
	}
	else
	{
		Result->SetField(TEXT("translationFormat"), MakeShared<FJsonValueNull>());
		Result->SetField(TEXT("translationRichTextValid"), MakeShared<FJsonValueNull>());
		Result->SetField(TEXT("translationSafeWhitespaceValid"), MakeShared<FJsonValueNull>());
		Result->SetField(TEXT("poRoundTripTranslation"), MakeShared<FJsonValueNull>());
	}
	return true;
}

bool Evidence(const FString& Output)
{
	TArray<FCurrentText> Current;
	TArray<FString> ReadablePackages;
	if (!ReadAssets(Current, ReadablePackages)) return false;
	FLocTextHelper Helper(DataDirectory(), TEXT("FixtureGame.manifest"), TEXT("FixtureGame.archive"),
		TEXT("en"), { TEXT("de"), TEXT("fr") }, nullptr);
	if (!Helper.LoadAll(ELocTextHelperLoadFlags::Load)) return false;
	TMap<FString, TPair<FString, FString>> Identities;
	Helper.EnumerateSourceTexts([&](TSharedRef<FManifestEntry> Entry)
	{
		for (const FManifestContext& Context : Entry->Contexts)
			Identities.Add(Entry->Namespace.GetString() + TEXT("\t") + Context.Key.GetString(),
				{ Entry->Namespace.GetString(), Context.Key.GetString() });
		return true;
	}, false);
	for (const FCurrentText& Value : Current)
		Identities.Add(Value.Namespace + TEXT("\t") + Value.Key, { Value.Namespace, Value.Key });
	TArray<FString> SortedIdentities;
	Identities.GetKeys(SortedIdentities);
	SortedIdentities.Sort();
	TArray<TSharedPtr<FJsonValue>> Entries;
	for (const FString& Culture : Cultures)
	{
		FPortableObjectFormatDOM PO;
		if (!LoadPO(Culture, PO)) return false;
		for (const FString& Id : SortedIdentities)
		{
			const auto& Identity = Identities[Id];
			const TSharedPtr<FManifestEntry> Manifest = Helper.FindSourceText(FLocKey(Identity.Key), FLocKey(Identity.Value));
			const FManifestContext* Context = Manifest ? Manifest->FindContextByKey(FLocKey(Identity.Value)) : nullptr;
			const TSharedPtr<FArchiveEntry> Archive = Helper.FindTranslation(Culture,
				FLocKey(Identity.Key), FLocKey(Identity.Value), Context ? Context->KeyMetadataObj : nullptr);
			const TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("culture"), Culture);
			Entry->SetStringField(TEXT("namespace"), Identity.Key);
			Entry->SetStringField(TEXT("key"), Identity.Value);
			Nullable(Entry, TEXT("manifestSource"), Manifest ? &Manifest->Source.Text : nullptr);
			Nullable(Entry, TEXT("archiveSource"), Archive ? &Archive->Source.Text : nullptr);
			Nullable(Entry, TEXT("archiveTranslation"), Archive ? &Archive->Translation.Text : nullptr);
			FLocItem Runtime;
			if (Manifest && Context)
				Helper.GetRuntimeText(Culture, Manifest->Namespace, Context->Key, Context->KeyMetadataObj,
					ELocTextExportSourceMethod::NativeText, Manifest->Source, Runtime, false);
			Nullable(Entry, TEXT("runtimeText"), Manifest ? &Runtime.Text : nullptr);
			TSharedPtr<FPortableObjectEntry> POEntry;
			for (auto It = PO.GetEntriesIterator(); It; ++It)
			{
				if (It.Value()->MsgCtxt == Identity.Key + TEXT(",") + Identity.Value) POEntry = It.Value();
			}
			Nullable(Entry, TEXT("poMsgid"), POEntry ? &POEntry->MsgId : nullptr);
			Nullable(Entry, TEXT("poMsgstr"), POEntry && POEntry->MsgStr.Num() ? &POEntry->MsgStr[0] : nullptr);
			// Keep the older raw fields; decode with the same replacement order used by import
			// and the browser reader, including Unreal's literal-backslash caveat.
			FString DecodedPO;
			const FString* DecodedPOPtr = nullptr;
			if (POEntry && POEntry->MsgStr.Num())
			{
				DecodedPO = PortableObjectPipeline::ConditionPOStringForArchive(POEntry->MsgStr[0]);
				DecodedPOPtr = &DecodedPO;
			}
			Nullable(Entry, TEXT("poDecodedMsgstr"), DecodedPOPtr);
			if (Manifest)
			{
				const FString* Checked = Archive ? &Archive->Translation.Text : nullptr;
				if (DecodedPOPtr && !DecodedPO.IsEmpty() && (!Checked || DecodedPO != *Checked)) Checked = DecodedPOPtr;
				const TSharedRef<FJsonObject> Validation = MakeShared<FJsonObject>();
				if (!ValidationEvidence(Manifest->Source.Text, Checked, Culture, Validation)) return false;
				Entry->SetObjectField(TEXT("validation"), Validation);
			}
			else Entry->SetField(TEXT("validation"), MakeShared<FJsonValueNull>());
			TArray<TSharedPtr<FJsonValue>> Comments;
			if (POEntry)
				for (const FString& Comment : POEntry->ExtractedComments)
					Comments.Add(MakeShared<FJsonValueString>(Comment));
			Entry->SetArrayField(TEXT("poExtractedComments"), Comments);
			TArray<TSharedPtr<FJsonValue>> Paths;
			TArray<TSharedPtr<FJsonValue>> Notes;
			bool SourceOnly = false;
			if (Manifest)
			{
				TArray<FString> Locations;
				for (const FManifestContext& Site : Manifest->Contexts)
				{
					if (Site.Key != FLocKey(Identity.Value)) continue;
					Locations.AddUnique(RelativeLocation(Site.SourceLocation));
					SourceOnly |= Site.SourceLocation.Contains(TEXT("UEShedLocalizationText.cpp"));
#if !UE_VERSION_OLDER_THAN(5, 8, 0)
					Notes.Add(MakeShared<FJsonValueString>(Site.DevNotes));
#endif
				}
				Locations.Sort();
				for (const FString& Location : Locations) Paths.Add(MakeShared<FJsonValueString>(Location));
			}
			Entry->SetArrayField(TEXT("manifestKeyPaths"), Paths);
#if !UE_VERSION_OLDER_THAN(5, 8, 0)
			Entry->SetArrayField(TEXT("manifestDevNotes"), Notes);
#endif
			Entry->SetBoolField(TEXT("gatheredOnly"), SourceOnly);
			const FCurrentText* Found = Current.FindByPredicate([&](const FCurrentText& Value)
				{ return Value.Namespace == Identity.Key && Value.Key == Identity.Value; });
			Nullable(Entry, TEXT("currentAssetSource"), Found ? &Found->Source : nullptr);
			Nullable(Entry, TEXT("currentAssetPath"), Found ? &Found->Path : nullptr);
			Entry->SetBoolField(TEXT("inTarget"), Found ? Found->InTarget : Manifest.IsValid());
			// A missing key is qualified by a fully loaded package, not by scan absence alone.
			bool Readable = Found != nullptr;
			if (Context && !SourceOnly)
			{
				for (const FString& Package : ReadablePackages)
					Readable |= Context->SourceLocation.Contains(Package);
			}
			Entry->SetBoolField(TEXT("packageReadable"), Readable);
			Entries.Add(MakeShared<FJsonValueObject>(Entry));
		}
	}
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetNumberField(TEXT("schemaVersion"), 1);
	Root->SetStringField(TEXT("target"), TargetName);
	Root->SetStringField(TEXT("nativeCulture"), TEXT("en"));
	Root->SetStringField(TEXT("engineVersion"), FString::Printf(TEXT("%d.%d"),
		FEngineVersion::Current().GetMajor(), FEngineVersion::Current().GetMinor()));
	Root->SetArrayField(TEXT("entries"), Entries);
	ReadablePackages.Sort();
	TArray<TSharedPtr<FJsonValue>> Packages;
	for (const FString& Package : ReadablePackages) Packages.Add(MakeShared<FJsonValueString>(Package));
	Root->SetArrayField(TEXT("readablePackages"), Packages);
	FString Contents;
	if (!FJsonSerializer::Serialize(Root, TJsonWriterFactory<>::Create(&Contents))) return false;
	IFileManager::Get().MakeDirectory(*Output, true);
	return FFileHelper::SaveStringToFile(Contents, *(Output / FString::Printf(TEXT("evidence.ue%d.%d.json"),
		FEngineVersion::Current().GetMajor(), FEngineVersion::Current().GetMinor())),
		FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
}
}

bool RunLocalizationFixture(const FString& Params)
{
	FString Stage;
	FString Output;
	if (FParse::Param(*Params, TEXT("VerifyOnly")))
	{
		if (!FParse::Value(*Params, TEXT("LocalizationEvidence="), Output))
		{
			UE_LOG(LogTemp, Error, TEXT("Localization verification requires -LocalizationEvidence=<directory>."));
			return false;
		}
		return Evidence(Output);
	}
	if (!FParse::Value(*Params, TEXT("LocalizationStage="), Stage)) return false;
	if (Stage == TEXT("Initial")) return InitialAssets() && GenerateConfigs();
	if (Stage == TEXT("Translate")) return Translate();
	if (Stage == TEXT("Unsynced")) return Unsynced();
	if (Stage == TEXT("Outdate"))
	{
		UUEShedFixtureTextAsset* Asset = LoadObject<UUEShedFixtureTextAsset>(nullptr, AssetPath);
		if (!Asset) return false;
		Asset->SharedPrimary = Text(AssetNamespace, TEXT("Outdated"), TEXT("Open the gate"));
		return Save(Asset);
	}
	if (Stage == TEXT("AfterGather"))
	{
		UStringTable* Strings = LoadObject<UStringTable>(nullptr, TablePath);
		if (!Strings) return false;
		FStringTableRef Table = Strings->GetMutableStringTable();
		SetString(Table, TEXT("AddedAfterGather"), TEXT("A new instruction"));
		SetString(Table, TEXT("ChangedAfterGather"), TEXT("Current instruction"));
		Table->RemoveSourceString(FTextKey(TEXT("RemovedAfterGather")));
		return Save(Strings);
	}
	UE_LOG(LogTemp, Error, TEXT("Unknown localization stage: %s"), *Stage);
	return false;
}
