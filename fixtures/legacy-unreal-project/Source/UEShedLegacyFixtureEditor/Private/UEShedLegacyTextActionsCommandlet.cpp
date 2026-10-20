#include "UEShedLegacyTextActionsCommandlet.h"

#include "UEShedLegacyFixtureTypes.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "GameFramework/Actor.h"
#include "HAL/FileManager.h"
#include "Internationalization/TextPackageNamespaceUtil.h"
#include "K2Node_CallFunction.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace
{
const TCHAR* Root = TEXT("/Game/KeyRepairs/");
const TCHAR* Operations[] = { TEXT("split"), TEXT("regenerate"), TEXT("adopt") };

FText BaselineText(const TCHAR* Operation)
{
	return FText::ChangeKey(TEXT("KeyRepairs"), FString(Operation) + TEXT("Before"),
		FText::FromString(FString(Operation) + TEXT(" source")));
}

FText AuthoredText(UObject* Owner, const FText& Text)
{
	return FText::ChangeKey(TextNamespaceUtil::BuildFullNamespace(TEXT("KeyRepairs"),
		TextNamespaceUtil::GetPackageNamespace(Owner->GetOutermost()), true),
		FTextInspector::GetKey(Text).Get(FString()), Text);
}

UPackage* NewPackage(const TCHAR* Name)
{
	UPackage* Package = CreatePackage(*(FString(Root) + Name));
	TextNamespaceUtil::ForcePackageNamespace(Package, FString(TEXT("KeyRepairs_")) + Name);
	return Package;
}

bool Save(UObject* Asset)
{
	UPackage* Package = Asset->GetOutermost();
	const FString File = FPackageName::LongPackageNameToFilename(Package->GetName(), TEXT(".uasset"));
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(File), true);
#if ENGINE_MAJOR_VERSION >= 5
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	Args.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Asset, *File, Args);
#else
	return UPackage::SavePackage(Package, Asset, RF_Public | RF_Standalone, *File,
		GError, nullptr, false, true, SAVE_NoError);
#endif
}

bool CreateBaseline()
{
	UUEShedLegacyFixtureTextAsset* Asset = NewObject<UUEShedLegacyFixtureTextAsset>(
		NewPackage(TEXT("DA_Keys")), TEXT("DA_Keys"), RF_Public | RF_Standalone);
	Asset->Text = BaselineText(Operations[0]);
	Asset->Nested.Text = BaselineText(Operations[1]);
	Asset->Texts.Add(BaselineText(Operations[2]));
	// Survivors make split and adopt actual shared-identity operations within a package.
	Asset->Texts.Add(FText::ChangeKey(TEXT("KeyRepairs"), TEXT("splitBefore"), FText::FromString(TEXT("split survivor source"))));
	Asset->Texts.Add(FText::ChangeKey(TEXT("KeyRepairs"), TEXT("Survivor"), FText::FromString(TEXT("adopt source"))));
	Asset->Text = AuthoredText(Asset, Asset->Text);
	Asset->Nested.Text = AuthoredText(Asset, Asset->Nested.Text);
	for (FText& Text : Asset->Texts) Text = AuthoredText(Asset, Text);
	UDataTable* Table = NewObject<UDataTable>(NewPackage(TEXT("DT_Keys")), TEXT("DT_Keys"), RF_Public | RF_Standalone);
	Table->RowStruct = FUEShedLegacyFixtureRow::StaticStruct();
	for (const TCHAR* Operation : Operations)
	{
		FUEShedLegacyFixtureRow Row;
		Row.BaseText = AuthoredText(Table, BaselineText(Operation));
		Table->AddRow(FName(Operation), Row);
	}
	FUEShedLegacyFixtureRow Survivor;
	Survivor.BaseText = AuthoredText(Table, Asset->Texts[1]);
	Table->AddRow(TEXT("SplitSurvivor"), Survivor);
	Survivor.BaseText = AuthoredText(Table, Asset->Texts[2]);
	Table->AddRow(TEXT("AdoptSurvivor"), Survivor);
	UBlueprint* Blueprint = FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), NewPackage(TEXT("BP_Keys")),
		TEXT("BP_Keys"), BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass());
	UEdGraph* Graph = Blueprint->UbergraphPages.Num() ? Blueprint->UbergraphPages[0] : nullptr;
	if (!Graph)
	{
		Graph = FBlueprintEditorUtils::CreateNewGraph(Blueprint, TEXT("EventGraph"), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
		FBlueprintEditorUtils::AddUbergraphPage(Blueprint, Graph);
	}
	for (const TCHAR* Operation : Operations)
	{
		UK2Node_CallFunction* Node = NewObject<UK2Node_CallFunction>(Graph, FName(Operation));
		Node->CreateNewGuid();
		Node->SetFromFunction(UKismetSystemLibrary::StaticClass()->FindFunctionByName(TEXT("PrintText")));
		Graph->AddNode(Node, false, false);
		Node->AllocateDefaultPins();
		Node->FindPin(TEXT("InText"))->DefaultTextValue = AuthoredText(Blueprint, BaselineText(Operation));
	}
	for (int32 Index = 0; Index < 2; ++Index)
	{
		UK2Node_CallFunction* Node = NewObject<UK2Node_CallFunction>(Graph,
			Index == 0 ? TEXT("SplitSurvivor") : TEXT("AdoptSurvivor"));
		Node->CreateNewGuid();
		Node->SetFromFunction(UKismetSystemLibrary::StaticClass()->FindFunctionByName(TEXT("PrintText")));
		Graph->AddNode(Node, false, false); Node->AllocateDefaultPins();
		Node->FindPin(TEXT("InText"))->DefaultTextValue = AuthoredText(Blueprint, Asset->Texts[Index + 1]);
	}
	FKismetEditorUtilities::CompileBlueprint(Blueprint);
	return Save(Asset) && Save(Table) && Save(Blueprint);
}

TSharedRef<FJsonObject> Place(UObject* Object, const FString& Property, const FText& Text,
	const TCHAR* Kind, const TCHAR* Operation)
{
	auto Item = MakeShared<FJsonObject>();
	Item->SetStringField(TEXT("kind"), Kind);
	Item->SetStringField(TEXT("operation"), Operation);
	Item->SetStringField(TEXT("objectPath"), Object->GetPathName());
	Item->SetStringField(TEXT("packageFile"), FPaths::ConvertRelativePathToFull(
		FPackageName::LongPackageNameToFilename(Object->GetOutermost()->GetName(), TEXT(".uasset"))));
	Item->SetStringField(TEXT("propertyPath"), Property);
	Item->SetStringField(TEXT("namespace"), TextNamespaceUtil::StripPackageNamespace(FTextInspector::GetNamespace(Text).Get(FString())));
	Item->SetStringField(TEXT("key"), FTextInspector::GetKey(Text).Get(FString()));
	const FString* Source = FTextInspector::GetSourceString(Text);
	Item->SetStringField(TEXT("source"), Source ? *Source : FString());
	return Item;
}
}

UUEShedLegacyTextActionsCommandlet::UUEShedLegacyTextActionsCommandlet()
{
	IsClient = false; IsServer = false; IsEditor = true; LogToConsole = true;
}

int32 UUEShedLegacyTextActionsCommandlet::Main(const FString& Params)
{
	FString Evidence;
	if (!FParse::Value(*Params, TEXT("Evidence="), Evidence)) return 2;
	if (FParse::Param(*Params, TEXT("Create")) && !CreateBaseline()) return 1;
	auto* Asset = LoadObject<UUEShedLegacyFixtureTextAsset>(nullptr, TEXT("/Game/KeyRepairs/DA_Keys.DA_Keys"));
	auto* Table = LoadObject<UDataTable>(nullptr, TEXT("/Game/KeyRepairs/DT_Keys.DT_Keys"));
	auto* Blueprint = LoadObject<UBlueprint>(nullptr, TEXT("/Game/KeyRepairs/BP_Keys.BP_Keys"));
	if (!Asset || !Table || !Blueprint) return 1;
	TArray<TSharedPtr<FJsonValue>> Places;
	Places.Add(MakeShared<FJsonValueObject>(Place(Asset, TEXT("Text"), Asset->Text, TEXT("object"), Operations[0])));
	Places.Add(MakeShared<FJsonValueObject>(Place(Asset, TEXT("Nested.Text"), Asset->Nested.Text, TEXT("object"), Operations[1])));
	Places.Add(MakeShared<FJsonValueObject>(Place(Asset, TEXT("Texts[0]"), Asset->Texts[0], TEXT("object"), Operations[2])));
	for (const TCHAR* Operation : Operations)
	{
		const auto* Row = Table->FindRow<FUEShedLegacyFixtureRow>(FName(Operation), TEXT("KeyRepairs"));
		if (!Row) return 1;
		auto Item = Place(Table, TEXT("BaseText"), Row->BaseText, TEXT("data_table_cell"), Operation);
		Item->SetStringField(TEXT("row"), Operation);
		Places.Add(MakeShared<FJsonValueObject>(Item));
	}
	for (UEdGraph* Graph : Blueprint->UbergraphPages)
		for (UEdGraphNode* Node : Graph->Nodes)
			if (auto* Call = Cast<UK2Node_CallFunction>(Node))
				if (Call->GetName() == TEXT("split") || Call->GetName() == TEXT("regenerate") || Call->GetName() == TEXT("adopt"))
				if (UEdGraphPin* Pin = Call->FindPin(TEXT("InText")))
				{
					auto Item = Place(Node, TEXT("DefaultTextValue"), Pin->DefaultTextValue, TEXT("graph_pin"), *Node->GetName());
					Item->SetStringField(TEXT("pinId"), Pin->PinId.ToString());
					Item->SetNumberField(TEXT("pinIndex"), Node->Pins.IndexOfByKey(Pin));
					Places.Add(MakeShared<FJsonValueObject>(Item));
				}
	auto Result = MakeShared<FJsonObject>();
	Result->SetArrayField(TEXT("places"), Places);
	FString Json;
	FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Json));
	return Places.Num() == 9 && FFileHelper::SaveStringToFile(Json, *Evidence,
		FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) ? 0 : 1;
}
