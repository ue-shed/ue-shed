#include "UEShedSavedReviewFixture.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraph.h"
#include "EdGraphNode_Comment.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "GameFramework/Actor.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "K2Node_IfThenElse.h"
#include "K2Node_Knot.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace
{
constexpr const TCHAR* PackageName = TEXT("/Game/Fixture/Blueprints/BP_ReviewFixture");
constexpr const TCHAR* ObjectPath = TEXT("/Game/Fixture/Blueprints/BP_ReviewFixture.BP_ReviewFixture");
FString Guid(const FGuid& Value)
{
	return FString::Printf(TEXT("%08x-%08x-%08x-%08x"), Value.A, Value.B, Value.C, Value.D);
}
template <typename T> T* Node(UEdGraph* Graph, int32 X, int32 Y)
{
	FGraphNodeCreator<T> Creator(*Graph);
	T* Result = Creator.CreateNode(false);
	Result->NodePosX = X; Result->NodePosY = Y;
	Creator.Finalize();
	return Result;
}
}

bool GenerateSavedReviewBlueprintFixture()
{
	UPackage* Package = CreatePackage(PackageName);
	if (FindObject<UBlueprint>(Package, TEXT("BP_ReviewFixture"))) return true;
	UBlueprint* Blueprint = FKismetEditorUtilities::CreateBlueprint(
		AActor::StaticClass(), Package, TEXT("BP_ReviewFixture"), BPTYPE_Normal);
	if (!Blueprint || Blueprint->UbergraphPages.IsEmpty()) return false;
	FAssetRegistryModule::AssetCreated(Blueprint);
	FEdGraphPinType BoolType;
	BoolType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
	if (!FBlueprintEditorUtils::AddMemberVariable(Blueprint, TEXT("ReviewEnabled"), BoolType, TEXT("true"))) return false;
	UEdGraph* Graph = Blueprint->UbergraphPages[0];
	int32 Y = 0;
	UK2Node_Event* Event = FKismetEditorUtilities::AddDefaultEventNode(
		Blueprint, Graph, TEXT("ReceiveBeginPlay"), AActor::StaticClass(), Y);
	UK2Node_IfThenElse* Branch = Node<UK2Node_IfThenElse>(Graph, 350, 0);
	UK2Node_Knot* Knot = Node<UK2Node_Knot>(Graph, 250, 180);
	FGraphNodeCreator<UK2Node_VariableGet> GetCreator(*Graph);
	UK2Node_VariableGet* Get = GetCreator.CreateNode(false);
	Get->VariableReference.SetSelfMember(TEXT("ReviewEnabled"));
	Get->NodePosX = 0; Get->NodePosY = 180;
	GetCreator.Finalize();
	FGraphNodeCreator<UK2Node_VariableSet> SetCreator(*Graph);
	UK2Node_VariableSet* Set = SetCreator.CreateNode(false);
	Set->VariableReference.SetSelfMember(TEXT("ReviewEnabled"));
	Set->NodePosX = 680; Set->NodePosY = 0;
	SetCreator.Finalize();
	UEdGraphPin* Value = Set->FindPin(TEXT("ReviewEnabled"), EGPD_Input);
	if (!Value) return false;
	Value->DefaultValue = TEXT("false");
	FGraphNodeCreator<UK2Node_CallFunction> CallCreator(*Graph);
	UK2Node_CallFunction* Call = CallCreator.CreateNode(false);
	Call->SetFromFunction(AActor::StaticClass()->FindFunctionByName(GET_FUNCTION_NAME_CHECKED(AActor, SetActorHiddenInGame)));
	Call->NodePosX = 1000; Call->NodePosY = 0;
	CallCreator.Finalize();
	const UEdGraphSchema_K2* Schema = GetDefault<UEdGraphSchema_K2>();
	if (!Event || !Schema->TryCreateConnection(Event->FindPin(UEdGraphSchema_K2::PN_Then), Branch->GetExecPin())
		|| !Schema->TryCreateConnection(Get->FindPin(TEXT("ReviewEnabled")), Knot->GetInputPin())
		|| !Schema->TryCreateConnection(Knot->GetOutputPin(), Branch->GetConditionPin())
		|| !Schema->TryCreateConnection(Branch->FindPin(UEdGraphSchema_K2::PN_Then), Set->GetExecPin())
		|| !Schema->TryCreateConnection(Set->FindPin(UEdGraphSchema_K2::PN_Then), Call->GetExecPin())) return false;
	Call->FindPin(TEXT("bNewHidden"))->DefaultValue = TEXT("true");
	UEdGraphNode_Comment* Comment = Node<UEdGraphNode_Comment>(Graph, -40, -80);
	Comment->NodeComment = TEXT("Saved review fixture: branch, variable and reroute");
	UEdGraph* Function = FBlueprintEditorUtils::CreateNewGraph(Blueprint, TEXT("ReviewFunction"), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
	FBlueprintEditorUtils::AddFunctionGraph<UClass>(Blueprint, Function, true, nullptr);
	FKismetEditorUtilities::CompileBlueprint(Blueprint);
	if (Blueprint->Status == BS_Error) return false;
	Package->MarkPackageDirty();
	const FString Filename = FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension());
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
	FSavePackageArgs Args; Args.TopLevelFlags = RF_Public | RF_Standalone; Args.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Blueprint, *Filename, Args);
}

bool WriteSavedReviewBlueprintEvidence(const FString& OutputDirectory)
{
	const UBlueprint* Blueprint = LoadObject<UBlueprint>(nullptr, ObjectPath);
	if (!Blueprint) return false;
	TArray<UEdGraph*> Graphs;
	Blueprint->GetAllGraphs(Graphs);
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("producer"), FString::Printf(TEXT("Unreal %s loaded graph APIs"), *FEngineVersion::Current().ToString()));
	Root->SetStringField(TEXT("objectPath"), Blueprint->GetPathName());
	TArray<TSharedPtr<FJsonValue>> GraphValues;
	for (const UEdGraph* Graph : Graphs)
	{
		const TSharedRef<FJsonObject> GraphValue = MakeShared<FJsonObject>();
		GraphValue->SetStringField(TEXT("path"), Graph->GetPathName());
		GraphValue->SetStringField(TEXT("name"), Graph->GetName());
		GraphValue->SetStringField(TEXT("guid"), Guid(Graph->GraphGuid));
		TArray<TSharedPtr<FJsonValue>> Nodes;
		for (const UEdGraphNode* Node : Graph->Nodes)
		{
			if (!Node) return false;
			const TSharedRef<FJsonObject> NodeValue = MakeShared<FJsonObject>();
			NodeValue->SetStringField(TEXT("path"), Node->GetPathName());
			NodeValue->SetStringField(TEXT("class"), Node->GetClass()->GetPathName());
			NodeValue->SetStringField(TEXT("guid"), Guid(Node->NodeGuid));
			NodeValue->SetNumberField(TEXT("x"), Node->NodePosX);
			NodeValue->SetNumberField(TEXT("y"), Node->NodePosY);
			TArray<TSharedPtr<FJsonValue>> Pins;
			for (const UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin) return false;
				const TSharedRef<FJsonObject> PinValue = MakeShared<FJsonObject>();
				PinValue->SetStringField(TEXT("id"), Guid(Pin->PinId));
				PinValue->SetStringField(TEXT("name"), Pin->PinName.ToString());
				PinValue->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Input ? TEXT("input") : TEXT("output"));
				PinValue->SetStringField(TEXT("category"), Pin->PinType.PinCategory.ToString());
				PinValue->SetStringField(TEXT("defaultValue"), Pin->DefaultValue);
				TArray<TSharedPtr<FJsonValue>> Links;
				for (const UEdGraphPin* Linked : Pin->LinkedTo)
				{
					const TSharedRef<FJsonObject> Link = MakeShared<FJsonObject>();
					Link->SetStringField(TEXT("node"), Linked->GetOwningNode()->GetPathName());
					Link->SetStringField(TEXT("pin"), Guid(Linked->PinId));
					Links.Add(MakeShared<FJsonValueObject>(Link));
				}
				PinValue->SetArrayField(TEXT("links"), Links);
				Pins.Add(MakeShared<FJsonValueObject>(PinValue));
			}
			NodeValue->SetArrayField(TEXT("pins"), Pins); Nodes.Add(MakeShared<FJsonValueObject>(NodeValue));
		}
		GraphValue->SetArrayField(TEXT("nodes"), Nodes); GraphValues.Add(MakeShared<FJsonValueObject>(GraphValue));
	}
	Root->SetArrayField(TEXT("graphs"), GraphValues);
	FString Json;
	FJsonSerializer::Serialize(Root, TJsonWriterFactory<>::Create(&Json));
	IFileManager::Get().MakeDirectory(*OutputDirectory, true);
	return FFileHelper::SaveStringToFile(Json, *FPaths::Combine(OutputDirectory, TEXT("blueprint-review.json")));
}
