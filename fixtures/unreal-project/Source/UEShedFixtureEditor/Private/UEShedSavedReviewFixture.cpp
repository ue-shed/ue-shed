#include "UEShedSavedReviewFixture.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraph.h"
#include "EdGraphNode_Comment.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/SCS_Node.h"
#include "Components/SceneComponent.h"
#include "GameFramework/RotatingMovementComponent.h"
#include "UObject/UnrealType.h"
#include "GameFramework/Actor.h"
#include "GameFramework/Character.h"
#include "Components/CapsuleComponent.h"
#include "Engine/StaticMesh.h"
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
		ACharacter::StaticClass(), Package, TEXT("BP_ReviewFixture"), BPTYPE_Normal);
	if (!Blueprint || Blueprint->UbergraphPages.IsEmpty()) return false;
	FAssetRegistryModule::AssetCreated(Blueprint);
	FEdGraphPinType BoolType;
	BoolType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
	if (!FBlueprintEditorUtils::AddMemberVariable(Blueprint, TEXT("ReviewEnabled"), BoolType, TEXT("true"))) return false;

    FEdGraphPinType IntType; IntType.PinCategory = UEdGraphSchema_K2::PC_Int;
    FEdGraphPinType StringType; StringType.PinCategory = UEdGraphSchema_K2::PC_String;
    FEdGraphPinType ObjectType; ObjectType.PinCategory = UEdGraphSchema_K2::PC_Object; ObjectType.PinSubCategoryObject = UStaticMesh::StaticClass();
    FEdGraphPinType ArrayType = IntType; ArrayType.ContainerType = EPinContainerType::Array;
    FEdGraphPinType MapType; MapType.PinCategory = UEdGraphSchema_K2::PC_Name; MapType.ContainerType = EPinContainerType::Map;
    MapType.PinValueType.TerminalCategory = UEdGraphSchema_K2::PC_Object; MapType.PinValueType.TerminalSubCategoryObject = UObject::StaticClass();
    if (!FBlueprintEditorUtils::AddMemberVariable(Blueprint,TEXT("ReviewCount"),IntType,TEXT("17"))
        || !FBlueprintEditorUtils::AddMemberVariable(Blueprint,TEXT("ReviewLabel"),StringType,TEXT("Unicode 世界"))
        || !FBlueprintEditorUtils::AddMemberVariable(Blueprint,TEXT("ReviewNumbers"),ArrayType,TEXT("(1,-2,3)"))
        || !FBlueprintEditorUtils::AddMemberVariable(Blueprint,TEXT("ReviewAssets"),MapType)
        || !FBlueprintEditorUtils::AddMemberVariable(Blueprint,TEXT("ReviewObject"),ObjectType,TEXT("StaticMesh'/Engine/BasicShapes/Cube.Cube'"))) return false;
    FBlueprintEditorUtils::SetBlueprintVariableCategory(Blueprint,TEXT("ReviewCount"),nullptr,FText::FromString(TEXT("Review|Settings")),true);
    FBlueprintEditorUtils::SetBlueprintVariableMetaData(Blueprint,TEXT("ReviewCount"),nullptr,TEXT("ToolTip"),TEXT("Saved count metadata"));
    auto* SCS = Blueprint->SimpleConstructionScript.Get();
    auto* Root = SCS->CreateNode(USceneComponent::StaticClass(),TEXT("ReviewRoot"));
    auto* Child = SCS->CreateNode(USceneComponent::StaticClass(),TEXT("ReviewChild"));
    auto* Movement = SCS->CreateNode(URotatingMovementComponent::StaticClass(),TEXT("ReviewMovement"));
    SCS->AddNode(Root); Root->AddChildNode(Child); SCS->AddNode(Movement);
    Root->SetParent(GetDefault<ACharacter>()->GetCapsuleComponent());
    CastChecked<USceneComponent>(Child->ComponentTemplate)->SetRelativeLocation(FVector(11,22,33));
    Child->AttachToName=TEXT("SavedSocket");
    CastChecked<URotatingMovementComponent>(Movement->ComponentTemplate)->RotationRate=FRotator(1,2,3);
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
    FindFProperty<FIntProperty>(Blueprint->GeneratedClass,TEXT("ReviewCount"))->SetPropertyValue_InContainer(Blueprint->GeneratedClass->GetDefaultObject(),23);
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
    TArray<TSharedPtr<FJsonValue>> Variables;
    const UObject* Defaults=Blueprint->GeneratedClass->GetDefaultObject();
    for (const auto& Variable : Blueprint->NewVariables) {
        auto V=MakeShared<FJsonObject>(); V->SetStringField(TEXT("name"),Variable.VarName.ToString()); V->SetStringField(TEXT("guid"),Guid(Variable.VarGuid));
        V->SetStringField(TEXT("category"),Variable.Category.ToString()); V->SetStringField(TEXT("type_category"),Variable.VarType.PinCategory.ToString());
        V->SetNumberField(TEXT("container"),int32(Variable.VarType.ContainerType)); V->SetStringField(TEXT("declaration_default"),Variable.DefaultValue);
        if (const FProperty* P=FindFProperty<FProperty>(Blueprint->GeneratedClass,Variable.VarName)) {
            FString Default; P->ExportText_InContainer(0,Default,Defaults,Defaults,const_cast<UObject*>(Defaults),PPF_None);
            V->SetStringField(TEXT("loaded_default"),Default);
        }
        Variables.Add(MakeShared<FJsonValueObject>(V));
    }
    Root->SetArrayField(TEXT("variables"),Variables);
    TArray<TSharedPtr<FJsonValue>> Components;
    for (const auto* N : Blueprint->SimpleConstructionScript->GetAllNodes()) {
        auto V=MakeShared<FJsonObject>(); V->SetStringField(TEXT("path"),N->GetPathName()); V->SetStringField(TEXT("name"),N->GetVariableName().ToString());
        V->SetStringField(TEXT("class"),N->ComponentClass->GetPathName()); V->SetStringField(TEXT("guid"),Guid(N->VariableGuid));
        V->SetStringField(TEXT("parent"),N->ParentComponentOrVariableName.ToString());
        V->SetStringField(TEXT("parent_owner"),N->ParentComponentOwnerClassName.ToString()); V->SetBoolField(TEXT("parent_native"),N->bIsParentComponentNative);
        V->SetStringField(TEXT("template"),N->ComponentTemplate->GetPathName()); V->SetStringField(TEXT("socket"),N->AttachToName.ToString());
        TArray<TSharedPtr<FJsonValue>> Children; for (const auto* C : N->GetChildNodes()) Children.Add(MakeShared<FJsonValueString>(C->GetPathName()));
        V->SetArrayField(TEXT("children"),Children);
        if (const auto* C=Cast<USceneComponent>(N->ComponentTemplate)) { auto L=C->GetRelativeLocation(); V->SetNumberField(TEXT("x"),L.X); V->SetNumberField(TEXT("y"),L.Y); V->SetNumberField(TEXT("z"),L.Z); }
        Components.Add(MakeShared<FJsonValueObject>(V));
    }
    Root->SetArrayField(TEXT("components"),Components);

	FString Json;
	FJsonSerializer::Serialize(Root, TJsonWriterFactory<>::Create(&Json));
	IFileManager::Get().MakeDirectory(*OutputDirectory, true);
	return FFileHelper::SaveStringToFile(Json, *FPaths::Combine(OutputDirectory, TEXT("blueprint-review.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
}
