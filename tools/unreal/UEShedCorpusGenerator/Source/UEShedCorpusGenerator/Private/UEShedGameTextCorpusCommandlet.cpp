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
#include "Serialization/JsonSerializer.h"
#include "Dom/JsonObject.h"
#include "Internationalization/TextLocalizationResource.h"
#include "Internationalization/StringTableRegistry.h"
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

// TypeScript owns the complete semantic plan. This commandlet only authors UE5 assets and
// resources through Unreal APIs. Its GUID stream is serialization bookkeeping, never case selection.
namespace
{
const TCHAR* ManifestName = TEXT("UEShedGameTextCorpus.json");
const TCHAR* RowStructFolder = TEXT("Structs");
const TCHAR* RowStructName = TEXT("S_CorpusTextRow");
const TCHAR* DataTableColumns[] = { TEXT("DisplayName") };
const TCHAR* KindStringTable = TEXT("stringTable");
const TCHAR* KindDataTable = TEXT("dataTable");
const TCHAR* KindBlueprint = TEXT("blueprint");
const TCHAR* KindWidget = TEXT("widgetBlueprint");
const TCHAR* TextBlueprintVariable = TEXT("blueprintVariable");
const TCHAR* TextBlueprintPin = TEXT("blueprintPin");
const FName BeginPlayName(TEXT("ReceiveBeginPlay"));
const FName PrintTextName(TEXT("PrintText"));
const FName TextToUpperName(TEXT("TextToUpper"));

struct FCorpusText
{
    FString Kind, Field, Namespace, Key, Source, Notes, Mode, Table, TableKey, CompiledSource, PreviousSource;
};
struct FCorpusPackage
{
    FString Kind, Folder, Name, PackageNamespace, TableNamespace;
    FGuid PersistentGuid;
    TArray<FCorpusText> Texts;
    FString PackagePath(const FString& Root) const { return Root / Folder / Name; }
};
FGuid NextGuid(FRandomStream& Rng)
{
    const uint32 A = Rng.GetUnsignedInt();
    const uint32 B = Rng.GetUnsignedInt();
    const uint32 C = Rng.GetUnsignedInt();
    const uint32 D = Rng.GetUnsignedInt();
    return FGuid(A, B, C, D);
}
FText MakeText(const FCorpusText& Text)
{
    if (Text.Mode == TEXT("invariant")) return FText::AsCultureInvariant(Text.Source);
    if (Text.Mode == TEXT("reference"))
        return FText::FromStringTable(FName(*Text.Table), Text.TableKey, EStringTableLoadingPolicy::FindOrLoad);
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
	const FString Path = Planned.PackagePath(Root);
	UPackage* Package = FPackageName::DoesPackageExist(Path) ? LoadPackage(nullptr, *Path, LOAD_None) : CreatePackage(*Path);
	if (!Package) return nullptr;
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
		for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
		{
			Node->VariableGuid = NextGuid(Rng);
			Node->CategoryName = FText::GetEmpty();
		}
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
			for (UEdGraphPin* Pin : Node->Pins)
			{
				Pin->PinId = NextGuid(Rng);
				Pin->PinFriendlyName = FText::GetEmpty();
			}
		}
	}
}

bool AuthorStringTable(const FCorpusPackage& Planned, const FString& Root)
{
	UPackage* Package = CreateCorpusPackage(Planned, Root);
	if (!Package) return false;
	UStringTable* Asset = FindObject<UStringTable>(Package, *Planned.Name);
	if (!Asset) Asset = NewObject<UStringTable>(Package, *Planned.Name, RF_Public | RF_Standalone | RF_Transactional);
	FAssetRegistryModule::AssetCreated(Asset);
	FStringTableRef Table = Asset->GetMutableStringTable();
	Table->ClearSourceStrings();
	Table->ClearMetaData();
	Table->SetNamespace(Planned.TableNamespace);
	for (const FCorpusText& Text : Planned.Texts)
	{
#if UE_VERSION_OLDER_THAN(5, 8, 0)
		if (!Text.PreviousSource.IsEmpty()) Table->SetSourceString(FTextKey(Text.Key), Text.PreviousSource);
		Table->SetSourceString(FTextKey(Text.Key), Text.Source);
#else
		if (!Text.PreviousSource.IsEmpty()) Table->SetSourceString(FTextKey(Text.Key), Text.PreviousSource, FString());
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
	if (!Package) return false;
	UDataTable* Asset = FindObject<UDataTable>(Package, *Planned.Name);
	if (!Asset) Asset = NewObject<UDataTable>(Package, *Planned.Name, RF_Public | RF_Standalone | RF_Transactional);
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
		if (Text.Kind != TextBlueprintVariable || Text.Mode == TEXT("scaffold")) continue;
		if (!FBlueprintEditorUtils::AddMemberVariable(Blueprint, FName(*Owner(Text)), TextType)) return false;
	}
	for (FBPVariableDescription& Variable : Blueprint->NewVariables)
	{
		Variable.VarGuid = NextGuid(GuidRng);
		Variable.Category = FText::GetEmpty();
	}

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
		FCorpusText Initial = Text;
		if (!Text.CompiledSource.IsEmpty()) Initial.Source = Text.CompiledSource;
		Pin->DefaultTextValue = MakeText(Initial);
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
		if (Text.Kind != TextBlueprintVariable || Text.Mode == TEXT("scaffold")) continue;
		FTextProperty* Property = CastField<FTextProperty>(Blueprint->GeneratedClass->FindPropertyByName(FName(*Owner(Text))));
		if (!Property) return false;
		*Property->ContainerPtrToValuePtr<FText>(Defaults) = MakeText(Text);
	}
	FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	FKismetEditorUtilities::CompileBlueprint(Blueprint);
	for (const FCorpusText& Text : Planned.Texts)
	{
		if (Text.Kind != TextBlueprintPin || Text.CompiledSource.IsEmpty()) continue;
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (Node->GetName() != Owner(Text)) continue;
			UEdGraphPin* Pin = Node->FindPin(TEXT("InText"));
			if (!Pin) return false;
			Pin->DefaultTextValue = MakeText(Text);
		}
	}
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


bool SavePlannedFiles(const TSharedPtr<FJsonObject>& Localization, const FString& Target, bool bReplaceOwned)
{
    const FString Project = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    const TSharedPtr<FJsonObject> Files = Localization->GetObjectField(TEXT("files"));
    for (const auto& File : Files->Values)
    {
#if UE_VERSION_OLDER_THAN(5, 8, 0)
        const FString RelativePath = File.Key;
#else
        const FString RelativePath(File.Key.ToView());
#endif
        const FString Path = Project / RelativePath;
        if (RelativePath.Contains(TEXT("..")) || FPaths::IsRelative(RelativePath) == false ||
            !(RelativePath.StartsWith(TEXT("Content/Localization/") + Target + TEXT("/")) ||
              RelativePath == TEXT("Config/Localization/") + Target + TEXT("_Gather.ini"))) return false;
        if (!bReplaceOwned && IFileManager::Get().FileExists(*Path)) return false;
        IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
        if (!FFileHelper::SaveStringToFile(File.Value->AsString(), *Path,
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return false;
    }
    const FString Folder = Project / Localization->GetStringField(TEXT("folder"));
    FTextLocalizationMetaDataResource Meta;
    Meta.NativeCulture = TEXT("en");
    Meta.NativeLocRes = TEXT("en/") + Target + TEXT(".locres");
    for (const auto& Value : Localization->GetArrayField(TEXT("resources")))
    {
        const auto ResourcePlan = Value->AsObject();
        const FString Culture = ResourcePlan->GetStringField(TEXT("culture"));
        FTextLocalizationResource Resource;
        for (const auto& EntryValue : ResourcePlan->GetArrayField(TEXT("entries")))
        {
            const auto Entry = EntryValue->AsObject();
            Resource.AddEntry(FTextKey(Entry->GetStringField(TEXT("namespace"))),
                FTextKey(Entry->GetStringField(TEXT("key"))), Entry->GetStringField(TEXT("source")),
                Entry->GetStringField(TEXT("translation")), 0);
        }
        const FString ResourcePath = Folder / Culture / (Target + TEXT(".locres"));
        if (!Resource.SaveToFile(ResourcePath)) return false;
        // Verify serialization using Unreal's reader; these facts are not exposed by today's index.
        FTextLocalizationResource ReadBack;
        if (!ReadBack.LoadFromFile(ResourcePath, 0) || ReadBack.Entries.Num() != Resource.Entries.Num()) return false;
        for (const auto& Entry : Resource.Entries)
        {
            const auto* Saved = ReadBack.Entries.Find(Entry.Key);
            if (!Saved || Saved->SourceStringHash != Entry.Value.SourceStringHash ||
                *Saved->LocalizedString != *Entry.Value.LocalizedString) return false;
        }
        Meta.CompiledCultures.Add(Culture);
    }
    return Meta.SaveToFile(Folder / (Target + TEXT(".locmeta")));
}
}

UUEShedGameTextCorpusCommandlet::UUEShedGameTextCorpusCommandlet()
{
    IsClient = false;
    IsEditor = true;
    IsServer = false;
    LogToConsole = true;
    ShowErrorCount = true;
    UseCommandletResultAsExitCode = true;
}

int32 UUEShedGameTextCorpusCommandlet::Main(const FString& Params)
{
    // Defense in depth: even direct commandlet invocations require the generator-owned scratch.
    FString MarkerJson, Descriptor;
    TSharedPtr<FJsonObject> Marker;
    if (!FFileHelper::LoadFileToString(MarkerJson, *(FPaths::ProjectDir() / TEXT(".ue-shed-corpus-scratch.json"))) ||
        !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(MarkerJson), Marker) || !Marker ||
        Marker->GetStringField(TEXT("format")) != TEXT("ue-shed-corpus-scratch") ||
        Marker->GetStringField(TEXT("project")) != FPaths::GetCleanFilename(FPaths::GetProjectFilePath()) ||
        !FFileHelper::LoadFileToString(Descriptor, *FPaths::GetProjectFilePath()) ||
        Descriptor != Marker->GetStringField(TEXT("descriptor"))) return 1;
    FString PlanPath, Json;
    TSharedPtr<FJsonObject> Plan;
    if (!FParse::Value(*Params, TEXT("Plan="), PlanPath) ||
        !FFileHelper::LoadFileToString(Json, *PlanPath) ||
        !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Plan) || !Plan ||
        Plan->GetStringField(TEXT("format")) != TEXT("ue-shed-game-text-corpus-plan") ||
        Plan->GetIntegerField(TEXT("version")) != 1) return 1;
    const FString Root = Plan->GetStringField(TEXT("root"));
    const bool bPatch = FParse::Param(*Params, TEXT("Patch"));
    const FString Target = Plan->GetStringField(TEXT("target"));
    const int32 Seed = Plan->GetIntegerField(TEXT("seed"));
    if (!Root.StartsWith(TEXT("/Game/")) || Root.Contains(TEXT("..")) ||
        !FPackageName::IsValidLongPackageName(Root) || Target != TEXT("UEShedCorpus")) return 1;
    FString Directory;
    if (!FPackageName::TryConvertLongPackageNameToFilename(Root + TEXT("/"), Directory)) return 1;
    if (IFileManager::Get().DirectoryExists(*Directory) && !bPatch) return 1;
    TArray<FCorpusPackage> Packages;
    for (const auto& Value : Plan->GetArrayField(TEXT("packages")))
    {
        const auto Object = Value->AsObject();
        FCorpusPackage Package;
        Package.Kind = Object->GetStringField(TEXT("kind"));
        Package.Folder = Object->GetStringField(TEXT("folder"));
        Package.Name = Object->GetStringField(TEXT("name"));
        Package.PackageNamespace = Object->GetStringField(TEXT("packageNamespace"));
        Package.TableNamespace = Object->GetStringField(TEXT("tableNamespace"));
        if (!FGuid::ParseExact(Object->GetStringField(TEXT("persistentGuid")), EGuidFormats::Digits, Package.PersistentGuid) ||
            Object->GetStringField(TEXT("path")) != Package.PackagePath(Root) ||
            Package.Folder.Contains(TEXT("..")) || Package.Name.Contains(TEXT("/"))) return 1;
        for (const auto& TextValue : Object->GetArrayField(TEXT("texts")))
        {
            const auto Item = TextValue->AsObject();
            if (!Item->GetBoolField(TEXT("exists"))) continue;
            FCorpusText Text;
            Text.Kind = Item->GetStringField(TEXT("kind"));
            Text.Field = Item->GetStringField(TEXT("field"));
            if (Text.Kind == TEXT("dataTableCell") && !Text.Field.EndsWith(TEXT(".DisplayName"))) return 1;
            Text.Namespace = Item->GetStringField(TEXT("namespace"));
            Text.Key = Item->GetStringField(TEXT("key"));
            Text.Source = Item->GetStringField(TEXT("source"));
            Text.Notes = Item->GetStringField(TEXT("notes"));
            Text.Mode = Item->GetStringField(TEXT("mode"));
            Text.Table = Item->GetStringField(TEXT("table"));
            Text.TableKey = Item->GetStringField(TEXT("tableKey"));
            Text.CompiledSource = Item->GetStringField(TEXT("compiledSource"));
            Text.PreviousSource = Item->GetStringField(TEXT("previousSource"));
            if (Text.Mode != TEXT("text") && Text.Mode != TEXT("invariant") && Text.Mode != TEXT("reference") && Text.Mode != TEXT("scaffold")) return 1;
            Package.Texts.Add(Text);
        }
        if (Package.Kind != KindStringTable && Package.Kind != KindDataTable &&
            Package.Kind != KindBlueprint && Package.Kind != KindWidget) return 1;
        Packages.Add(Package);
    }
    UUserDefinedStruct* RowStruct = bPatch ? LoadObject<UUserDefinedStruct>(nullptr, *RowStructPath(Root)) : AuthorRowStruct(Root, Seed);
    if (!RowStruct) return 1;
    TSet<FString> Changed, Deleted;
    const auto Edits = Plan->GetObjectField(TEXT("edits"));
    for (const auto& Path : Edits->GetArrayField(TEXT("packages"))) Changed.Add(Path->AsString());
    for (const auto& Path : Edits->GetArrayField(TEXT("deletedPackages"))) Deleted.Add(Path->AsString());
    if (bPatch) for (const FString& Path : Deleted)
    {
        if (!Path.StartsWith(Root + TEXT("/")) || !FPackageName::IsValidLongPackageName(Path)) return 1;
        const FString Filename = FPackageName::LongPackageNameToFilename(Path, FPackageName::GetAssetPackageExtension());
        if (IFileManager::Get().FileExists(*Filename) && !IFileManager::Get().Delete(*Filename)) return 1;
    }
    // Tables must exist before any planned String Table reference is created.
    for (const FCorpusPackage& Package : Packages)
        if (Package.Kind == KindStringTable && (!bPatch || (Changed.Contains(Package.PackagePath(Root)) && !Deleted.Contains(Package.PackagePath(Root)))) && !AuthorStringTable(Package, Root)) return 1;
    for (const FCorpusPackage& Package : Packages)
    {
        if (bPatch && (!Changed.Contains(Package.PackagePath(Root)) || Deleted.Contains(Package.PackagePath(Root)))) continue;
        FRandomStream GuidRng(static_cast<int32>(GetTypeHash(Package.PackageNamespace)));
        bool Saved = true;
        if (Package.Kind == KindDataTable) Saved = AuthorDataTable(Package, Root, RowStruct);
        else if (Package.Kind == KindBlueprint) Saved = AuthorBlueprint(Package, Root, GuidRng);
        else if (Package.Kind == KindWidget) Saved = AuthorWidget(Package, Root, GuidRng);
        if (!Saved) return 1;
    }
    if (!SavePlannedFiles(Plan->GetObjectField(TEXT("localization")), Target, bPatch)) return 1;
    auto Manifest = MakeShared<FJsonObject>();
    Manifest->SetStringField(TEXT("format"), TEXT("ue-shed-game-text-corpus"));
    Manifest->SetNumberField(TEXT("version"), 1);
    Manifest->SetNumberField(TEXT("seed"), Seed);
    Manifest->SetNumberField(TEXT("lines"), Plan->GetIntegerField(TEXT("lines")));
    Manifest->SetStringField(TEXT("root"), Root);
    Manifest->SetStringField(TEXT("rowStruct"), RowStructPath(Root));
    Manifest->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
    Manifest->SetArrayField(TEXT("packages"), Plan->GetArrayField(TEXT("packages")));
    auto Counts = MakeShared<FJsonObject>();
    Counts->SetNumberField(TEXT("total"), Plan->GetIntegerField(TEXT("lines")));
    for (const auto& Package : Packages) for (const auto& Text : Package.Texts)
    {
        double Previous = 0;
        Counts->TryGetNumberField(Text.Kind, Previous);
        Counts->SetNumberField(Text.Kind, Previous + 1);
    }
    Manifest->SetObjectField(TEXT("counts"), Counts);
    auto Duplicates = MakeShared<FJsonObject>();
    double Shared = 0, Conflicts = 0, Empty = 0, Whitespace = 0;
    for (const auto& Value : Plan->GetObjectField(TEXT("expectations"))->GetArrayField(TEXT("subjects")))
    {
        const auto Subject = Value->AsObject();
        if (Subject->GetStringField(TEXT("culture")) != TEXT("en")) continue;
        const FString Source = Subject->GetStringField(TEXT("source"));
        if (Source.IsEmpty()) ++Empty;
        else if (Source.TrimStartAndEnd().IsEmpty()) ++Whitespace;
        for (const auto& Signal : Subject->GetArrayField(TEXT("signals")))
        {
            if (Signal->AsString() == TEXT("duplicate_source")) ++Shared;
            if (Signal->AsString() == TEXT("conflicting")) ++Conflicts;
        }
    }
    Duplicates->SetNumberField(TEXT("sharedSource"), Shared);
    Duplicates->SetNumberField(TEXT("keyConflicts"), Conflicts);
    Duplicates->SetNumberField(TEXT("empty"), Empty);
    Duplicates->SetNumberField(TEXT("whitespace"), Whitespace);
    Manifest->SetObjectField(TEXT("duplicates"), Duplicates);
    for (const auto& Pair : TArray<TPair<FString, TSharedPtr<FJsonObject>>>{
        { ManifestName, Manifest },
        { TEXT("UEShedGameTextCorpus.expected.json"), Plan->GetObjectField(TEXT("expectations")) }
    })
    {
        FString Output;
        FJsonSerializer::Serialize(Pair.Value.ToSharedRef(), TJsonWriterFactory<>::Create(&Output));
        if (!FFileHelper::SaveStringToFile(Output, *(Directory / Pair.Key),
            FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return 1;
    }
    UE_LOG(LogUEShedCorpus, Display, TEXT("Authored plan: %s"), *PlanPath);
    return 0;
}
