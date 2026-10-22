#include "UEShedGameTextCorpusCommandlet.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetBlueprintGeneratedClass.h"
#include "Blueprint/WidgetTree.h"
#include "Components/TextBlock.h"
#include "Components/VerticalBox.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/DataTable.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "GameFramework/Actor.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformTime.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/TextNamespaceUtil.h"
#include "Internationalization/TextPackageNamespaceUtil.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Kismet/KismetTextLibrary.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/StructureEditorUtils.h"
#include "Math/RandomStream.h"
#include "Misc/EngineVersion.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Policies/PrettyJsonPrintPolicy.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "UObject/StructOnScope.h"
#include "UserDefinedStructure/UserDefinedStructEditorData.h"
#include "WidgetBlueprint.h"
#if __has_include("StructUtils/UserDefinedStruct.h")
#include "StructUtils/UserDefinedStruct.h"
#else
#include "Engine/UserDefinedStruct.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogUEShedCorpus, Log, All);

// The corpus is planned first, from one seeded FRandomStream, as plain data. Authoring then turns
// each planned package into an asset, and the manifest is written from the plan alone, so it is
// byte-identical for a given seed and line count on one engine version.
namespace
{
const TCHAR* ManifestName = TEXT("UEShedGameTextCorpus.json");
const TCHAR* ManifestFormat = TEXT("ue-shed-game-text-corpus");
constexpr int32 ManifestVersion = 1;
constexpr int32 MaximumLines = 1000000;
// Shares of the requested lines, in percent. String tables take the remainder.
constexpr int32 DataTablePercent = 30;
constexpr int32 VariablePercent = 10;
constexpr int32 PinPercent = 10;
constexpr int32 WidgetPercent = 10;
// Chance that a line reuses an earlier key in the same namespace with different source text.
constexpr float KeyConflictChance = 0.015f;

/** The DataTables' row struct, a User Defined Struct written into the corpus folder. */
const TCHAR* RowStructFolder = TEXT("Structs");
const TCHAR* RowStructName = TEXT("S_CorpusTextRow");
const TCHAR* DataTableColumns[] = { TEXT("DisplayName"), TEXT("Description") };

const TCHAR* KindStringTable = TEXT("stringTable");
const TCHAR* KindDataTable = TEXT("dataTable");
const TCHAR* KindBlueprint = TEXT("blueprint");
const TCHAR* KindWidget = TEXT("widgetBlueprint");

const TCHAR* TextStringTableEntry = TEXT("stringTableEntry");
const TCHAR* TextDataTableCell = TEXT("dataTableCell");
const TCHAR* TextBlueprintVariable = TEXT("blueprintVariable");
const TCHAR* TextBlueprintPin = TEXT("blueprintPin");
const TCHAR* TextWidget = TEXT("widgetText");

const FName BeginPlayName(TEXT("ReceiveBeginPlay"));
const FName PrintTextName(TEXT("PrintText"));
const FName TextToUpperName(TEXT("TextToUpper"));

const TCHAR* CorpusAreas[] = {
	TEXT("Menu"), TEXT("Quests"), TEXT("Dialogue"), TEXT("Items"), TEXT("Abilities"), TEXT("Tutorial"),
	TEXT("Achievements"), TEXT("Lore"), TEXT("Settings"), TEXT("Shop"), TEXT("Map"), TEXT("Social")
};

const TCHAR* CorpusWords[] = {
	TEXT("ancient"), TEXT("harbor"), TEXT("lantern"), TEXT("storm"), TEXT("keeper"), TEXT("crystal"),
	TEXT("shadow"), TEXT("forge"), TEXT("river"), TEXT("ember"), TEXT("tower"), TEXT("silver"),
	TEXT("compass"), TEXT("journey"), TEXT("signal"), TEXT("garden"), TEXT("bridge"), TEXT("cavern"),
	TEXT("merchant"), TEXT("captain"), TEXT("village"), TEXT("frozen"), TEXT("golden"), TEXT("hidden"),
	TEXT("broken"), TEXT("quiet"), TEXT("distant"), TEXT("bright"), TEXT("hollow"), TEXT("iron"),
	TEXT("wander"), TEXT("gather"), TEXT("defend"), TEXT("restore"), TEXT("unlock"), TEXT("follow"),
	TEXT("collect"), TEXT("return"), TEXT("discover"), TEXT("repair"), TEXT("travel"), TEXT("listen"),
	TEXT("the"), TEXT("a"), TEXT("of"), TEXT("to"), TEXT("before"), TEXT("after"), TEXT("with"),
	TEXT("beyond"), TEXT("under"), TEXT("near"), TEXT("every"), TEXT("your"), TEXT("their"),
	TEXT("map"), TEXT("door"), TEXT("key"), TEXT("ship"), TEXT("coin"), TEXT("blade"), TEXT("shield"),
	TEXT("potion"), TEXT("scroll"), TEXT("relic"), TEXT("beacon"), TEXT("market"), TEXT("lighthouse"),
	TEXT("night"), TEXT("dawn"), TEXT("winter"), TEXT("summer"), TEXT("tide"), TEXT("wind"),
	TEXT("caf\u00e9"), TEXT("na\u00efve"), TEXT("Stra\u00dfe"), TEXT("fa\u00e7ade"), TEXT("\u00e9clair"),
	TEXT("\u65c5"), TEXT("\u5149"), TEXT("se\u00f1or"), TEXT("sm\u00f6rg\u00e5sbord")
};

const TCHAR* SharedPhrases[] = {
	TEXT("Back"), TEXT("Continue"), TEXT("Cancel"), TEXT("Confirm"), TEXT("Yes"), TEXT("No"),
	TEXT("OK"), TEXT("Close"), TEXT("Settings"), TEXT("Quit"), TEXT("Resume"), TEXT("Loading..."),
	TEXT("Accept"), TEXT("Decline"), TEXT("Equip"), TEXT("Sell"), TEXT("Buy"), TEXT("Retry"),
	TEXT("Next"), TEXT("Previous"), TEXT("Locked"), TEXT("New!"), TEXT("Level {Level}"),
	TEXT("{Count} gold"), TEXT("Press <Key>E</> to interact")
};

const TCHAR* WhitespaceTexts[] = { TEXT(" "), TEXT("  "), TEXT("\t"), TEXT(" \n ") };

const TCHAR* FormatArguments[] = { TEXT("{PlayerName}"), TEXT("{Count}"), TEXT("{ItemName}"), TEXT("{Seconds}") };

const TCHAR* NoteTexts[] = {
	TEXT("Shown on the pause menu."), TEXT("Tooltip, keep under 40 characters."),
	TEXT("Spoken by the harbor master."), TEXT("Quest log entry."), TEXT("Button label.")
};

enum class EStyle : uint8
{
	Label,
	Line,
	Description
};

struct FCorpusText
{
	FString Kind;
	/** Entry key, row and column, variable, node or widget the text belongs to. */
	FString Field;
	FString Namespace;
	FString Key;
	FString Source;
	FString Notes;
};

struct FCorpusPackage
{
	FString Kind;
	FString Folder;
	FString Name;
	/** The package localization namespace, forced so saved packages do not get a random one. */
	FString PackageNamespace;
	FGuid PersistentGuid;
	/** String tables only. */
	FString TableNamespace;
	TArray<FCorpusText> Texts;

	FString PackagePath(const FString& Root) const { return Root / Folder / Name; }
};

struct FDuplicateCounts
{
	int32 SharedSource = 0;
	int32 KeyConflicts = 0;
	int32 Empty = 0;
	int32 Whitespace = 0;
};

FString HexId(FRandomStream& Rng)
{
	// Evaluate in a fixed order; argument evaluation order is unspecified in C++.
	const uint32 A = Rng.GetUnsignedInt();
	const uint32 B = Rng.GetUnsignedInt();
	const uint32 C = Rng.GetUnsignedInt();
	const uint32 D = Rng.GetUnsignedInt();
	return FString::Printf(TEXT("%08X%08X%08X%08X"), A, B, C, D);
}

FGuid NextGuid(FRandomStream& Rng)
{
	const uint32 A = Rng.GetUnsignedInt();
	const uint32 B = Rng.GetUnsignedInt();
	const uint32 C = Rng.GetUnsignedInt();
	const uint32 D = Rng.GetUnsignedInt();
	return FGuid(A, B, C, D);
}

template <typename T, int32 N> const TCHAR* Pick(FRandomStream& Rng, T (&Items)[N])
{
	return Items[Rng.RandRange(0, N - 1)];
}

class FTextFactory
{
public:
	FTextFactory(FRandomStream& InRng, FDuplicateCounts& InDuplicates) : Rng(InRng), Duplicates(InDuplicates) {}

	FString Next(EStyle Style)
	{
		const float Roll = Rng.FRand();
		if (Roll < 0.005f)
		{
			++Duplicates.Empty;
			return FString();
		}
		if (Roll < 0.01f)
		{
			++Duplicates.Whitespace;
			return Pick(Rng, WhitespaceTexts);
		}
		if (Roll < 0.05f)
		{
			++Duplicates.SharedSource;
			return Pick(Rng, SharedPhrases);
		}
		switch (Style)
		{
		case EStyle::Label: return Label();
		case EStyle::Line: return Sentence(4, 12);
		default: return Description();
		}
	}

	FString NextNotes() { return Rng.FRand() < 0.1f ? FString(Pick(Rng, NoteTexts)) : FString(); }

private:
	FString Word() { return Pick(Rng, CorpusWords); }

	static FString Capitalized(const FString& Value)
	{
		return Value.IsEmpty() ? Value : Value.Left(1).ToUpper() + Value.RightChop(1);
	}

	FString Label()
	{
		const int32 Count = Rng.RandRange(1, 3);
		TArray<FString> Parts;
		for (int32 Index = 0; Index < Count; ++Index) Parts.Add(Capitalized(Word()));
		return FString::Join(Parts, TEXT(" "));
	}

	FString Sentence(int32 Minimum, int32 Maximum)
	{
		const int32 Count = Rng.RandRange(Minimum, Maximum);
		TArray<FString> Parts;
		for (int32 Index = 0; Index < Count; ++Index) Parts.Add(Word());
		const float Decoration = Rng.FRand();
		if (Decoration < 0.08f)
		{
			const FString Argument = Pick(Rng, FormatArguments);
			Parts.Insert(Argument, Rng.RandRange(0, Parts.Num()));
		}
		else if (Decoration < 0.12f)
		{
			const int32 Index = Rng.RandRange(0, Parts.Num() - 1);
			Parts[Index] = TEXT("<Em>") + Parts[Index] + TEXT("</>");
		}
		const float End = Rng.FRand();
		const TCHAR* Ending = End < 0.7f ? TEXT(".") : End < 0.85f ? TEXT("!") : End < 0.95f ? TEXT("?") : TEXT("\u2026");
		return Capitalized(FString::Join(Parts, TEXT(" "))) + Ending;
	}

	FString Description()
	{
		const int32 Count = Rng.RandRange(1, 3);
		TArray<FString> Parts;
		for (int32 Index = 0; Index < Count; ++Index) Parts.Add(Sentence(6, 16));
		return FString::Join(Parts, Rng.FRand() < 0.15f ? TEXT("\n") : TEXT(" "));
	}

	FRandomStream& Rng;
	FDuplicateCounts& Duplicates;
};

/** "[PACKAGENAMESPACE]", the namespace the editor gives text typed into this package. */
FString PackageTextNamespace(const FString& PackageNamespace)
{
	return TextNamespaceUtil::BuildFullNamespace(FString(), PackageNamespace, true);
}

FCorpusPackage NewPackage(FRandomStream& Rng, const TCHAR* Kind, const TCHAR* Folder, const FString& Name)
{
	FCorpusPackage Package;
	Package.Kind = Kind;
	Package.Folder = Folder;
	Package.Name = Name;
	Package.PackageNamespace = HexId(Rng);
	Package.PersistentGuid = NextGuid(Rng);
	return Package;
}

/** A key reused from Earlier with new source: a deliberate conflict. Returns false when none applies. */
bool TryConflict(FRandomStream& Rng, const TArray<TPair<FString, FString>>& Earlier, FCorpusText& Text,
	FDuplicateCounts& Duplicates)
{
	if (Earlier.IsEmpty() || Rng.FRand() >= KeyConflictChance) return false;
	const TPair<FString, FString>& Previous = Earlier[Rng.RandRange(0, Earlier.Num() - 1)];
	Text.Key = Previous.Key;
	if (Text.Source == Previous.Value) Text.Source += TEXT(" (revised)");
	++Duplicates.KeyConflicts;
	return true;
}

TArray<FCorpusPackage> PlanCorpus(int32 Lines, int32 Seed, FDuplicateCounts& Duplicates)
{
	FRandomStream Rng(Seed);
	FTextFactory Factory(Rng, Duplicates);
	int32 Widgets = Lines * WidgetPercent / 100;
	int32 Variables = Lines * VariablePercent / 100;
	int32 Pins = Lines * PinPercent / 100;
	// Rows carry two text cells, so the cell budget is even.
	int32 Cells = (Lines * DataTablePercent / 100) & ~1;
	int32 Strings = Lines - Widgets - Variables - Pins - Cells;
	TArray<FCorpusPackage> Packages;

	// String tables. Tables of one area share a namespace, as studios often split one namespace
	// over several tables; that is where a reused key conflicts. The first table is a large one.
	TMap<FString, TArray<TPair<FString, FString>>> EntriesByNamespace;
	int32 KeyCounter = 0;
	for (int32 Index = 0; Strings > 0; ++Index)
	{
		const int32 Size = FMath::Min(Strings, Index == 0 ? 400 : Rng.RandRange(20, 60));
		const FString Area = Pick(Rng, CorpusAreas);
		FCorpusPackage Package = NewPackage(Rng, KindStringTable, TEXT("StringTables"),
			FString::Printf(TEXT("ST_%s_%03d"), *Area, Index));
		Package.TableNamespace = TEXT("Corpus.") + Area;
		const TArray<TPair<FString, FString>> Earlier = EntriesByNamespace.FindRef(Package.TableNamespace);
		TSet<FString> Keys;
		for (int32 Entry = 0; Entry < Size; ++Entry)
		{
			FCorpusText Text;
			Text.Kind = TextStringTableEntry;
			Text.Namespace = Package.TableNamespace;
			Text.Source = Factory.Next(Rng.FRand() < 0.3f ? EStyle::Label : Rng.FRand() < 0.7f ? EStyle::Line : EStyle::Description);
			Text.Notes = Factory.NextNotes();
			if (!TryConflict(Rng, Earlier, Text, Duplicates) || Keys.Contains(Text.Key))
			{
				if (Keys.Contains(Text.Key)) --Duplicates.KeyConflicts;
				Text.Key = FString::Printf(TEXT("%s_%05d"), *Area, KeyCounter++);
			}
			Keys.Add(Text.Key);
			Text.Field = Text.Key;
			Package.Texts.Add(MoveTemp(Text));
		}
		TArray<TPair<FString, FString>>& Known = EntriesByNamespace.FindOrAdd(Package.TableNamespace);
		for (const FCorpusText& Text : Package.Texts) Known.Emplace(Text.Key, Text.Source);
		Strings -= Size;
		Packages.Add(MoveTemp(Package));
	}

	// DataTables: two text cells per row, keyed as the editor keys typed text. A cell that reuses
	// an earlier key of the same table with other text conflicts within the package namespace.
	for (int32 Index = 0; Cells > 0; ++Index)
	{
		const int32 Rows = FMath::Min(Cells / 2, Rng.RandRange(8, 25));
		const FString Area = Pick(Rng, CorpusAreas);
		FCorpusPackage Package = NewPackage(Rng, KindDataTable, TEXT("DataTables"),
			FString::Printf(TEXT("DT_%s_%03d"), *Area, Index));
		const FString Namespace = PackageTextNamespace(Package.PackageNamespace);
		TArray<TPair<FString, FString>> Earlier;
		for (int32 Row = 0; Row < Rows; ++Row)
		{
			for (const TCHAR* Column : DataTableColumns)
			{
				FCorpusText Text;
				Text.Kind = TextDataTableCell;
				Text.Field = FString::Printf(TEXT("%s_%03d.%s"), *Area, Row, Column);
				Text.Namespace = Namespace;
				Text.Source = Factory.Next(FCString::Strcmp(Column, TEXT("DisplayName")) == 0 ? EStyle::Label : EStyle::Description);
				if (!TryConflict(Rng, Earlier, Text, Duplicates)) Text.Key = HexId(Rng);
				Earlier.Emplace(Text.Key, Text.Source);
				Package.Texts.Add(MoveTemp(Text));
			}
		}
		Cells -= Rows * 2;
		Packages.Add(MoveTemp(Package));
	}

	// Actor Blueprints: FText variables with class-default values, and text pin defaults on
	// Print Text (wired from BeginPlay) and To Upper (pure, unwired) nodes.
	for (int32 Index = 0; Variables > 0 || Pins > 0; ++Index)
	{
		const int32 VariableCount = FMath::Min(Variables, Rng.RandRange(1, 4));
		const int32 PinCount = FMath::Min(Pins, Rng.RandRange(1, 4));
		FCorpusPackage Package = NewPackage(Rng, KindBlueprint, TEXT("Blueprints"),
			FString::Printf(TEXT("BP_Corpus_%03d"), Index));
		const FString Namespace = PackageTextNamespace(Package.PackageNamespace);
		TArray<TPair<FString, FString>> EarlierVariables;
		for (int32 Variable = 0; Variable < VariableCount; ++Variable)
		{
			FCorpusText Text;
			Text.Kind = TextBlueprintVariable;
			Text.Field = FString::Printf(TEXT("Text_%02d"), Variable);
			Text.Namespace = Namespace;
			Text.Source = Factory.Next(Rng.FRand() < 0.5f ? EStyle::Label : EStyle::Line);
			if (!TryConflict(Rng, EarlierVariables, Text, Duplicates)) Text.Key = HexId(Rng);
			EarlierVariables.Emplace(Text.Key, Text.Source);
			Package.Texts.Add(MoveTemp(Text));
		}
		TArray<TPair<FString, FString>> EarlierPins;
		for (int32 Pin = 0; Pin < PinCount; ++Pin)
		{
			FCorpusText Text;
			Text.Kind = TextBlueprintPin;
			Text.Field = FString::Printf(TEXT("%s_%02d.InText"),
				Rng.FRand() < 0.7f ? *PrintTextName.ToString() : *TextToUpperName.ToString(), Pin);
			Text.Namespace = Namespace;
			Text.Source = Factory.Next(EStyle::Line);
			if (!TryConflict(Rng, EarlierPins, Text, Duplicates)) Text.Key = HexId(Rng);
			EarlierPins.Emplace(Text.Key, Text.Source);
			Package.Texts.Add(MoveTemp(Text));
		}
		Variables -= VariableCount;
		Pins -= PinCount;
		Packages.Add(MoveTemp(Package));
	}

	// Widget Blueprints: text blocks under a vertical box.
	for (int32 Index = 0; Widgets > 0; ++Index)
	{
		const int32 Blocks = FMath::Min(Widgets, Rng.RandRange(3, 10));
		FCorpusPackage Package = NewPackage(Rng, KindWidget, TEXT("Widgets"),
			FString::Printf(TEXT("WBP_Corpus_%03d"), Index));
		const FString Namespace = PackageTextNamespace(Package.PackageNamespace);
		TArray<TPair<FString, FString>> Earlier;
		for (int32 Block = 0; Block < Blocks; ++Block)
		{
			FCorpusText Text;
			Text.Kind = TextWidget;
			Text.Field = FString::Printf(TEXT("Text_%02d.Text"), Block);
			Text.Namespace = Namespace;
			Text.Source = Factory.Next(Rng.FRand() < 0.6f ? EStyle::Label : EStyle::Line);
			if (!TryConflict(Rng, Earlier, Text, Duplicates)) Text.Key = HexId(Rng);
			Earlier.Emplace(Text.Key, Text.Source);
			Package.Texts.Add(MoveTemp(Text));
		}
		Widgets -= Blocks;
		Packages.Add(MoveTemp(Package));
	}
	return Packages;
}

FText MakeText(const FCorpusText& Text)
{
	return FText::ChangeKey(FTextKey(Text.Namespace), FTextKey(Text.Key), FText::FromString(Text.Source));
}

/** The part of Field before the first dot: the row, variable, node or widget name. */
FString Owner(const FCorpusText& Text)
{
	FString Left;
	return Text.Field.Split(TEXT("."), &Left, nullptr) ? Left : Text.Field;
}

UPackage* CreateCorpusPackage(const FCorpusPackage& Planned, const FString& Root)
{
	UPackage* Package = CreatePackage(*Planned.PackagePath(Root));
	TextNamespaceUtil::ForcePackageNamespace(Package, Planned.PackageNamespace);
	Package->SetPersistentGuid(Planned.PersistentGuid);
	return Package;
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
	if (UPackage::SavePackage(Package, Asset, *Filename, Args)) return true;
	UE_LOG(LogUEShedCorpus, Error, TEXT("Could not save %s."), *Filename);
	return false;
}

/** Replace the random Blueprint and component GUIDs that creating a Blueprint assigns. */
void StabilizeBlueprintGuids(UBlueprint* Blueprint, FRandomStream& Rng)
{
	// BlueprintGuid is a private UPROPERTY without a setter; reflection writes it as loading would.
	if (FStructProperty* Property = FindFProperty<FStructProperty>(UBlueprintCore::StaticClass(), TEXT("BlueprintGuid")))
	{
		*Property->ContainerPtrToValuePtr<FGuid>(Blueprint) = NextGuid(Rng);
	}
	if (Blueprint->SimpleConstructionScript)
	{
		for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes()) Node->VariableGuid = NextGuid(Rng);
	}
}

/** Replace the editor's random graph, node and pin GUIDs so repeated runs save the same ids. */
void StabilizeGraphGuids(UBlueprint* Blueprint, FRandomStream& Rng)
{
	TArray<UEdGraph*> Graphs;
	Blueprint->GetAllGraphs(Graphs);
	for (UEdGraph* Graph : Graphs)
	{
		Graph->GraphGuid = NextGuid(Rng);
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			Node->NodeGuid = NextGuid(Rng);
			for (UEdGraphPin* Pin : Node->Pins) Pin->PinId = NextGuid(Rng);
		}
	}
}

bool AuthorStringTable(const FCorpusPackage& Planned, const FString& Root)
{
	UPackage* Package = CreateCorpusPackage(Planned, Root);
	UStringTable* Asset = NewObject<UStringTable>(Package, *Planned.Name, RF_Public | RF_Standalone | RF_Transactional);
	FAssetRegistryModule::AssetCreated(Asset);
	FStringTableRef Table = Asset->GetMutableStringTable();
	Table->ClearSourceStrings();
	Table->ClearMetaData();
	Table->SetNamespace(Planned.TableNamespace);
	for (const FCorpusText& Text : Planned.Texts)
	{
#if UE_VERSION_OLDER_THAN(5, 8, 0)
		Table->SetSourceString(FTextKey(Text.Key), Text.Source);
#else
		Table->SetSourceString(FTextKey(Text.Key), Text.Source, Text.Notes);
#endif
		if (!Text.Notes.IsEmpty()) Table->SetMetaData(FTextKey(Text.Key), TEXT("Comment"), Text.Notes);
	}
	return Save(Asset);
}

FString RowStructPath(const FString& Root)
{
	return Root / RowStructFolder / RowStructName;
}

/**
 * Writes the DataTables' row struct as a User Defined Struct with one FText member per column, so
 * the DataTables open in any editor without this plugin. Its GUIDs, which also name its members,
 * come from the seed.
 */
UUserDefinedStruct* AuthorRowStruct(const FString& Root, int32 Seed)
{
	FRandomStream Rng(static_cast<int32>(HashCombine(GetTypeHash(Seed), GetTypeHash(FString(RowStructName)))));
	UPackage* Package = CreatePackage(*RowStructPath(Root));
	Package->SetPersistentGuid(NextGuid(Rng));
	UUserDefinedStruct* Struct = FStructureEditorUtils::CreateUserDefinedStruct(Package, RowStructName,
		RF_Public | RF_Standalone | RF_Transactional);
	if (!Struct) return nullptr;
	FAssetRegistryModule::AssetCreated(Struct);

	// A new struct starts with one Boolean member; it is replaced by the text columns.
	const FGuid Placeholder = FStructureEditorUtils::GetVarDesc(Struct)[0].VarGuid;
	FEdGraphPinType TextType;
	TextType.PinCategory = UEdGraphSchema_K2::PC_Text;
	for (const TCHAR* Column : DataTableColumns)
	{
		if (!FStructureEditorUtils::AddVariable(Struct, TextType)) return nullptr;
		const FGuid Added = FStructureEditorUtils::GetVarDesc(Struct).Last().VarGuid;
		if (!FStructureEditorUtils::RenameVariable(Struct, Added, Column)) return nullptr;
	}
	if (!FStructureEditorUtils::RemoveVariable(Struct, Placeholder)) return nullptr;

	// Member names end in "_<member GUID>", as the editor names them; replace both with seeded ones.
	Struct->Guid = NextGuid(Rng);
	for (FStructVariableDescription& Variable : FStructureEditorUtils::GetVarDesc(Struct))
	{
		Variable.VarGuid = NextGuid(Rng);
		const FString Name = Variable.VarName.ToString();
		Variable.VarName = FName(Name.LeftChop(32) + Variable.VarGuid.ToString(EGuidFormats::Digits));
	}
	FStructureEditorUtils::OnStructureChanged(Struct);
	if (Struct->Status != EUserDefinedStructureStatus::UDSS_UpToDate) return nullptr;
	return Save(Struct) ? Struct : nullptr;
}

bool AuthorDataTable(const FCorpusPackage& Planned, const FString& Root, UUserDefinedStruct* RowStruct)
{
	TArray<FTextProperty*> Columns;
	for (const TCHAR* Column : DataTableColumns)
	{
		Columns.Add(CastField<FTextProperty>(FStructureEditorUtils::GetPropertyByFriendlyName(RowStruct, Column)));
		if (!Columns.Last()) return false;
	}
	UPackage* Package = CreateCorpusPackage(Planned, Root);
	UDataTable* Asset = NewObject<UDataTable>(Package, *Planned.Name, RF_Public | RF_Standalone | RF_Transactional);
	FAssetRegistryModule::AssetCreated(Asset);
	Asset->RowStruct = RowStruct;
	Asset->EmptyTable();
	for (int32 Index = 0; Index + Columns.Num() <= Planned.Texts.Num(); Index += Columns.Num())
	{
		FStructOnScope Row(RowStruct);
		for (int32 Column = 0; Column < Columns.Num(); ++Column)
		{
			*Columns[Column]->ContainerPtrToValuePtr<FText>(Row.GetStructMemory()) = MakeText(Planned.Texts[Index + Column]);
		}
		Asset->AddRow(FName(*Owner(Planned.Texts[Index])), Row.GetStructMemory(), RowStruct);
	}
	return Save(Asset);
}

bool AuthorBlueprint(const FCorpusPackage& Planned, const FString& Root, FRandomStream& GuidRng)
{
	UPackage* Package = CreateCorpusPackage(Planned, Root);
	UBlueprint* Blueprint = FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), Package,
		*Planned.Name, BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
	if (!Blueprint) return false;
	FAssetRegistryModule::AssetCreated(Blueprint);
	StabilizeBlueprintGuids(Blueprint, GuidRng);

	FEdGraphPinType TextType;
	TextType.PinCategory = UEdGraphSchema_K2::PC_Text;
	for (const FCorpusText& Text : Planned.Texts)
	{
		if (Text.Kind != TextBlueprintVariable) continue;
		if (!FBlueprintEditorUtils::AddMemberVariable(Blueprint, FName(*Owner(Text)), TextType)) return false;
	}
	for (FBPVariableDescription& Variable : Blueprint->NewVariables) Variable.VarGuid = NextGuid(GuidRng);

	// New actor Blueprints start with a ghost BeginPlay; wiring a node to it enables it.
	UK2Node_Event* BeginPlay = FBlueprintEditorUtils::FindOverrideForFunction(Blueprint, AActor::StaticClass(), BeginPlayName);
	UEdGraph* Graph = BeginPlay ? BeginPlay->GetGraph() : nullptr;
	if (!Graph) return false;
	const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
	UEdGraphPin* Then = BeginPlay->FindPin(UEdGraphSchema_K2::PN_Then);
	int32 Column = 0;
	for (const FCorpusText& Text : Planned.Texts)
	{
		if (Text.Kind != TextBlueprintPin) continue;
		const FString NodeName = Owner(Text);
		const bool bPrint = NodeName.StartsWith(PrintTextName.ToString());
		UFunction* Function = bPrint
			? UKismetSystemLibrary::StaticClass()->FindFunctionByName(PrintTextName)
			: UKismetTextLibrary::StaticClass()->FindFunctionByName(TextToUpperName);
		if (!Function) return false;
		UK2Node_CallFunction* Node = NewObject<UK2Node_CallFunction>(Graph, FName(*NodeName));
		Node->SetFromFunction(Function);
		Node->NodePosX = BeginPlay->NodePosX + 320 * ++Column;
		Node->NodePosY = BeginPlay->NodePosY + (bPrint ? 0 : 200);
		Graph->AddNode(Node, true, false);
		Node->CreateNewGuid();
		Node->PostPlacedNewNode();
		Node->AllocateDefaultPins();
		UEdGraphPin* Pin = Node->FindPin(TEXT("InText"));
		if (!Pin) return false;
		Pin->DefaultTextValue = MakeText(Text);
		if (bPrint)
		{
			if (!Then || !Schema->TryCreateConnection(Then, Node->GetExecPin())) return false;
			BeginPlay->SetEnabledState(ENodeEnabledState::Enabled, false);
			Then = Node->GetThenPin();
		}
	}
	FKismetEditorUtilities::CompileBlueprint(Blueprint);

	// The class defaults hold each variable's value, as editing it in Class Defaults does.
	UObject* Defaults = Blueprint->GeneratedClass ? Blueprint->GeneratedClass->GetDefaultObject() : nullptr;
	if (!Defaults) return false;
	for (const FCorpusText& Text : Planned.Texts)
	{
		if (Text.Kind != TextBlueprintVariable) continue;
		FTextProperty* Property = CastField<FTextProperty>(Blueprint->GeneratedClass->FindPropertyByName(FName(*Owner(Text))));
		if (!Property) return false;
		*Property->ContainerPtrToValuePtr<FText>(Defaults) = MakeText(Text);
	}
	FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	FKismetEditorUtilities::CompileBlueprint(Blueprint);
	StabilizeGraphGuids(Blueprint, GuidRng);
	return Save(Blueprint);
}

bool AuthorWidget(const FCorpusPackage& Planned, const FString& Root, FRandomStream& GuidRng)
{
	UPackage* Package = CreateCorpusPackage(Planned, Root);
	UWidgetBlueprint* Blueprint = Cast<UWidgetBlueprint>(FKismetEditorUtilities::CreateBlueprint(
		UUserWidget::StaticClass(), Package, *Planned.Name, BPTYPE_Normal, UWidgetBlueprint::StaticClass(),
		UWidgetBlueprintGeneratedClass::StaticClass()));
	if (!Blueprint || !Blueprint->WidgetTree) return false;
	FAssetRegistryModule::AssetCreated(Blueprint);
	StabilizeBlueprintGuids(Blueprint, GuidRng);
	UVerticalBox* Box = Blueprint->WidgetTree->ConstructWidget<UVerticalBox>(UVerticalBox::StaticClass(), TEXT("Root"));
	Blueprint->WidgetTree->RootWidget = Box;
	for (const FCorpusText& Text : Planned.Texts)
	{
		UTextBlock* Block = Blueprint->WidgetTree->ConstructWidget<UTextBlock>(UTextBlock::StaticClass(), FName(*Owner(Text)));
		Block->SetText(MakeText(Text));
		Box->AddChild(Block);
	}
	FKismetEditorUtilities::CompileBlueprint(Blueprint);
	StabilizeGraphGuids(Blueprint, GuidRng);
	TArray<FName> Names;
	Blueprint->WidgetVariableNameToGuidMap.GetKeys(Names);
	Names.Sort(FNameLexicalLess());
	for (const FName& Name : Names) Blueprint->WidgetVariableNameToGuidMap[Name] = NextGuid(GuidRng);
	return Save(Blueprint);
}

using FJsonWriterRef = TSharedRef<TJsonWriter<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>>;

FString WriteManifest(const TArray<FCorpusPackage>& Packages, const FDuplicateCounts& Duplicates, int32 Lines,
	int32 Seed, const FString& Root)
{
	TMap<FString, int32> Counts;
	for (const TCHAR* Kind : { TextStringTableEntry, TextDataTableCell, TextBlueprintVariable, TextBlueprintPin, TextWidget })
		Counts.Add(Kind, 0);
	for (const FCorpusPackage& Package : Packages)
		for (const FCorpusText& Text : Package.Texts) ++Counts.FindChecked(Text.Kind);

	FString Output;
	FJsonWriterRef Writer = TJsonWriterFactory<TCHAR, TPrettyJsonPrintPolicy<TCHAR>>::Create(&Output);
	Writer->WriteObjectStart();
	Writer->WriteValue(TEXT("format"), ManifestFormat);
	Writer->WriteValue(TEXT("version"), ManifestVersion);
	Writer->WriteValue(TEXT("seed"), Seed);
	Writer->WriteValue(TEXT("lines"), Lines);
	Writer->WriteValue(TEXT("root"), Root);
	Writer->WriteValue(TEXT("rowStruct"), RowStructPath(Root));
	Writer->WriteValue(TEXT("engineVersion"), FEngineVersion::Current().ToString());
	Writer->WriteObjectStart(TEXT("counts"));
	for (const TPair<FString, int32>& Count : Counts) Writer->WriteValue(Count.Key, Count.Value);
	Writer->WriteValue(TEXT("total"), Lines);
	Writer->WriteObjectEnd();
	Writer->WriteObjectStart(TEXT("duplicates"));
	Writer->WriteValue(TEXT("sharedSource"), Duplicates.SharedSource);
	Writer->WriteValue(TEXT("keyConflicts"), Duplicates.KeyConflicts);
	Writer->WriteValue(TEXT("empty"), Duplicates.Empty);
	Writer->WriteValue(TEXT("whitespace"), Duplicates.Whitespace);
	Writer->WriteObjectEnd();
	Writer->WriteArrayStart(TEXT("packages"));
	for (const FCorpusPackage& Package : Packages)
	{
		Writer->WriteObjectStart();
		Writer->WriteValue(TEXT("path"), Package.PackagePath(Root));
		Writer->WriteValue(TEXT("kind"), Package.Kind);
		Writer->WriteValue(TEXT("lines"), Package.Texts.Num());
		Writer->WriteArrayStart(TEXT("texts"));
		for (const FCorpusText& Text : Package.Texts)
		{
			Writer->WriteObjectStart();
			Writer->WriteValue(TEXT("kind"), Text.Kind);
			Writer->WriteValue(TEXT("field"), Text.Field);
			Writer->WriteValue(TEXT("namespace"), Text.Namespace);
			Writer->WriteValue(TEXT("key"), Text.Key);
			Writer->WriteValue(TEXT("source"), Text.Source);
			if (!Text.Notes.IsEmpty()) Writer->WriteValue(TEXT("notes"), Text.Notes);
			Writer->WriteObjectEnd();
		}
		Writer->WriteArrayEnd();
		Writer->WriteObjectEnd();
	}
	Writer->WriteArrayEnd();
	Writer->WriteObjectEnd();
	Writer->Close();
	// One line ending on every host, so manifests compare byte for byte.
	Output.ReplaceInline(TEXT("\r\n"), TEXT("\n"));
	return Output + TEXT("\n");
}

bool HasAnyFile(const FString& Directory)
{
	bool bFound = false;
	IFileManager::Get().IterateDirectoryRecursively(*Directory, [&bFound](const TCHAR*, bool bIsDirectory)
	{
		bFound = !bIsDirectory;
		return !bFound;
	});
	return bFound;
}
}

UUEShedGameTextCorpusCommandlet::UUEShedGameTextCorpusCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
	ShowErrorCount = true;
	// The host project may log its own startup errors; the exit code is this commandlet's result.
	UseCommandletResultAsExitCode = true;
}

int32 UUEShedGameTextCorpusCommandlet::Main(const FString& Params)
{
	int32 Lines = 10000;
	int32 Seed = 1;
	FString Root = FString(TEXT("/Game/Developers")) / FPaths::GameUserDeveloperFolderName() / TEXT("GameTextCorpus");
	FParse::Value(*Params, TEXT("Lines="), Lines);
	FParse::Value(*Params, TEXT("Seed="), Seed);
	FParse::Value(*Params, TEXT("Root="), Root);
	Root.RemoveFromEnd(TEXT("/"));

	if (Lines < 1 || Lines > MaximumLines)
	{
		UE_LOG(LogUEShedCorpus, Error, TEXT("-Lines must be between 1 and %d."), MaximumLines);
		return 1;
	}
	if (Seed < 0)
	{
		UE_LOG(LogUEShedCorpus, Error, TEXT("-Seed must be zero or more."));
		return 1;
	}
	FText Reason;
	if (!Root.StartsWith(TEXT("/Game/")) || !FPackageName::IsValidLongPackageName(Root, false, &Reason))
	{
		UE_LOG(LogUEShedCorpus, Error, TEXT("-Root must be a /Game/ folder: %s %s"), *Root, *Reason.ToString());
		return 1;
	}
	FString Directory;
	if (!FPackageName::TryConvertLongPackageNameToFilename(Root + TEXT("/"), Directory))
	{
		UE_LOG(LogUEShedCorpus, Error, TEXT("Could not map %s to a folder."), *Root);
		return 1;
	}
	Directory = FPaths::ConvertRelativePathToFull(Directory);
	if (HasAnyFile(Directory))
	{
		UE_LOG(LogUEShedCorpus, Error, TEXT("%s is not empty. The generator only writes into a new folder; remove the old corpus first."), *Directory);
		return 1;
	}

	const double Started = FPlatformTime::Seconds();
	FDuplicateCounts Duplicates;
	const TArray<FCorpusPackage> Packages = PlanCorpus(Lines, Seed, Duplicates);
	UE_LOG(LogUEShedCorpus, Display, TEXT("Planned %d lines in %d packages under %s."), Lines, Packages.Num(), *Root);

	UUserDefinedStruct* RowStruct = AuthorRowStruct(Root, Seed);
	if (!RowStruct)
	{
		UE_LOG(LogUEShedCorpus, Error, TEXT("Could not author %s."), *RowStructPath(Root));
		return 1;
	}

	for (int32 Index = 0; Index < Packages.Num(); ++Index)
	{
		const FCorpusPackage& Planned = Packages[Index];
		// Per-package GUID stream, independent of the plan and of authoring order.
		FRandomStream GuidRng(static_cast<int32>(GetTypeHash(Planned.PackageNamespace)));
		bool bSaved = false;
		if (Planned.Kind == KindStringTable) bSaved = AuthorStringTable(Planned, Root);
		else if (Planned.Kind == KindDataTable) bSaved = AuthorDataTable(Planned, Root, RowStruct);
		else if (Planned.Kind == KindBlueprint) bSaved = AuthorBlueprint(Planned, Root, GuidRng);
		else bSaved = AuthorWidget(Planned, Root, GuidRng);
		if (!bSaved)
		{
			UE_LOG(LogUEShedCorpus, Error, TEXT("Could not author %s."), *Planned.PackagePath(Root));
			return 1;
		}
		if ((Index + 1) % 50 == 0)
		{
			UE_LOG(LogUEShedCorpus, Display, TEXT("Saved %d of %d packages."), Index + 1, Packages.Num());
			CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS);
		}
	}

	const FString ManifestPath = Directory / ManifestName;
	if (!FFileHelper::SaveStringToFile(WriteManifest(Packages, Duplicates, Lines, Seed, Root), *ManifestPath,
		FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
	{
		UE_LOG(LogUEShedCorpus, Error, TEXT("Could not write %s."), *ManifestPath);
		return 1;
	}
	UE_LOG(LogUEShedCorpus, Display, TEXT("Wrote %d lines in %d packages in %.1f s. Manifest: %s"), Lines,
		Packages.Num(), FPlatformTime::Seconds() - Started, *ManifestPath);
	return 0;
}
