#include "UEShedAuthoringLibrary.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Tests/UEShedAuthoringTestTypes.h"
#include "Containers/StringConv.h"
#include "Dom/JsonObject.h"
#include "Engine/World.h"
#include "Kismet2/StructureEditorUtils.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UserDefinedStructure/UserDefinedStructEditorData.h"
#include "UObject/Package.h"
#include "UObject/StructOnScope.h"

namespace
{
TSharedPtr<FJsonObject> ReadObject(const FString& Json)
{
	TSharedPtr<FJsonObject> Object;
	FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Object);
	return Object;
}

FString WriteObject(const TSharedRef<FJsonObject>& Object)
{
	FString Json;
	FJsonSerializer::Serialize(Object, TJsonWriterFactory<>::Create(&Json));
	return Json;
}

TSharedPtr<FJsonObject> Snapshot(UDataTable* Table)
{
	FString Json;
	UUEShedAuthoringLibrary::GetTableSnapshot(Table->GetPathName(), Json);
	return ReadObject(Json);
}

TSharedPtr<FJsonObject> SchemaField(const TSharedPtr<FJsonObject>& Object, const FString& Name)
{
	for (const TSharedPtr<FJsonValue>& Value : Object->GetObjectField(TEXT("table"))
		->GetObjectField(TEXT("schema"))->GetArrayField(TEXT("fields")))
	{
		const TSharedPtr<FJsonObject> Field = Value->AsObject();
		if (Field->GetStringField(TEXT("name")) == Name) return Field;
	}
	return nullptr;
}

TSharedRef<FJsonObject> ReferenceRequest(UWorld* World, UDataTable* Table)
{
	const TSharedRef<FJsonObject> Request = MakeShared<FJsonObject>();
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("unreal-authoring-actor-references"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	Request->SetObjectField(TEXT("contract"), Contract);
	Request->SetStringField(TEXT("worldObjectPath"), World->GetPathName());
	Request->SetStringField(TEXT("tableObjectPath"), Table->GetPathName());
	Request->SetStringField(TEXT("rowName"), TEXT("Target"));
	Request->SetNumberField(TEXT("maxActors"), 1000);
	Request->SetNumberField(TEXT("maxResults"), 1000);
	return Request;
}

TSharedPtr<FJsonObject> Scan(const TSharedRef<FJsonObject>& Request)
{
	FString Json;
	UUEShedAuthoringLibrary::FindActorsReferencingRow(WriteObject(Request), Json);
	return ReadObject(Json);
}

TSet<FString> ResultPaths(const TSharedPtr<FJsonObject>& Result)
{
	TSet<FString> Paths;
	for (const TSharedPtr<FJsonValue>& Value : Result->GetArrayField(TEXT("actorObjectPaths")))
		Paths.Add(Value->AsString());
	return Paths;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedAuthoringDefaultsTest,
	"UEShed.Authoring.Defaults",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedAuthoringDefaultsTest::RunTest(const FString& Parameters)
{
	UDataTable* Table = NewObject<UDataTable>(GetTransientPackage());
	Table->RowStruct = FUEShedAuthoringTestRow::StaticStruct();
	FUEShedAuthoringTestRow Existing;
	Existing.Count = 999;
	Existing.Label = TEXT("existing-row");
	Table->AddRow(TEXT("Existing"), Existing);
	const bool bDirtyBefore = Table->GetOutermost()->IsDirty();
	const TSharedPtr<FJsonObject> Result = Snapshot(Table);
	if (!TestTrue(TEXT("Snapshot is JSON"), Result.IsValid())) return false;
	const TSharedPtr<FJsonObject> Count = SchemaField(Result, TEXT("Count"));
	const TSharedPtr<FJsonObject> Label = SchemaField(Result, TEXT("Label"));
	const TSharedPtr<FJsonObject> Nested = SchemaField(Result, TEXT("Nested"));
	const TSharedPtr<FJsonObject> Numbers = SchemaField(Result, TEXT("Numbers"));
	const TSharedPtr<FJsonObject> StaticNumbers = SchemaField(Result, TEXT("StaticNumbers"));
	if (!TestTrue(TEXT("All reflected schema fields exist"), Count.IsValid() && Label.IsValid()
		&& Nested.IsValid() && Numbers.IsValid() && StaticNumbers.IsValid())) return false;
	TestEqual(TEXT("Native constructor default is known"),
		Count->GetObjectField(TEXT("defaultValue"))->GetStringField(TEXT("status")), FString(TEXT("known")));
	TestEqual(TEXT("Default is independent of existing rows"),
		Count->GetObjectField(TEXT("defaultValue"))->GetObjectField(TEXT("value"))
			->GetStringField(TEXT("value")), FString(TEXT("73")));
	TestEqual(TEXT("Native string default survives initialization"),
		Label->GetObjectField(TEXT("defaultValue"))->GetObjectField(TEXT("value"))
			->GetStringField(TEXT("value")), FString(TEXT("native-default")));
	TestEqual(TEXT("Nested struct default uses the typed codec"),
		Nested->GetObjectField(TEXT("defaultValue"))->GetObjectField(TEXT("value"))
			->GetStringField(TEXT("kind")), FString(TEXT("struct")));
	TestEqual(TEXT("Container defaults retain both elements"),
		Numbers->GetObjectField(TEXT("defaultValue"))->GetObjectField(TEXT("value"))
			->GetArrayField(TEXT("values")).Num(), 2);
	TestEqual(TEXT("Static arrays stay unknown until the value codec can represent them"),
		StaticNumbers->GetObjectField(TEXT("defaultValue"))->GetStringField(TEXT("status")),
		FString(TEXT("unknown")));
	const FUEShedAuthoringTestRow* Unchanged = Table->FindRow<FUEShedAuthoringTestRow>(
		TEXT("Existing"), TEXT("DefaultsTest"));
	TestEqual(TEXT("Reading defaults does not add rows"), Table->GetRowMap().Num(), 1);
	TestEqual(TEXT("Reading defaults does not change row values"), Unchanged->Count, 999);
	TestEqual(TEXT("Reading defaults does not dirty the package"),
		Table->GetOutermost()->IsDirty(), bDirtyBefore);

	UUserDefinedStruct* BlueprintStruct = FStructureEditorUtils::CreateUserDefinedStruct(
		GetTransientPackage(), MakeUniqueObjectName(GetTransientPackage(),
			UUserDefinedStruct::StaticClass()), RF_Transient);
	if (!TestNotNull(TEXT("Create real Blueprint struct"), BlueprintStruct)) return false;
	const FGuid Variable = FStructureEditorUtils::GetVarDesc(BlueprintStruct)[0].VarGuid;
	if (!TestTrue(TEXT("Author a Blueprint boolean default"),
		FStructureEditorUtils::ChangeVariableDefaultValue(BlueprintStruct, Variable, TEXT("True"))))
		return false;
	UDataTable* BlueprintTable = NewObject<UDataTable>(GetTransientPackage());
	BlueprintTable->RowStruct = BlueprintStruct;
	const bool bBlueprintDirtyBefore = BlueprintTable->GetOutermost()->IsDirty();
	const TSharedPtr<FJsonObject> BlueprintSnapshot = Snapshot(BlueprintTable);
	if (!TestTrue(TEXT("Blueprint snapshot is JSON"), BlueprintSnapshot.IsValid())) return false;
	const TSharedPtr<FJsonObject> BlueprintField = BlueprintSnapshot->GetObjectField(TEXT("table"))
		->GetObjectField(TEXT("schema"))->GetArrayField(TEXT("fields"))[0]->AsObject();
	TestEqual(TEXT("Blueprint authored default is known"),
		BlueprintField->GetObjectField(TEXT("defaultValue"))->GetStringField(TEXT("status")),
		FString(TEXT("known")));
	TestTrue(TEXT("Blueprint authored default is true, not zero initialized"),
		BlueprintField->GetObjectField(TEXT("defaultValue"))->GetObjectField(TEXT("value"))
			->GetBoolField(TEXT("value")));
	TestEqual(TEXT("Blueprint defaults do not create rows"), BlueprintTable->GetRowMap().Num(), 0);
	TestEqual(TEXT("Blueprint defaults do not dirty package"),
		BlueprintTable->GetOutermost()->IsDirty(), bBlueprintDirtyBefore);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedAuthoringActorReferencesTest,
	"UEShed.Authoring.ActorReferences",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedAuthoringActorReferencesTest::RunTest(const FString& Parameters)
{
	FString FixtureDirectory;
	if (FParse::Value(FCommandLine::Get(), TEXT("UEShedAuthoringContractFixtures="), FixtureDirectory))
	{
		FString RequestJson;
		if (!TestTrue(TEXT("Load shared actor-reference wire fixture"),
			FFileHelper::LoadFileToString(RequestJson, *FPaths::Combine(
				FixtureDirectory, TEXT("actor-references-request.json"))))) return false;
		FString ResultJson;
		UUEShedAuthoringLibrary::FindActorsReferencingRow(RequestJson, ResultJson);
		const TSharedPtr<FJsonObject> Result = ReadObject(ResultJson);
		if (!TestTrue(TEXT("Shared fixture returns JSON"), Result.IsValid())) return false;
		TestEqual(TEXT("Shared request passes validation and reaches world resolution"),
			Result->GetArrayField(TEXT("errors"))[0]->AsObject()->GetStringField(TEXT("code")),
			FString(TEXT("world_unavailable")));
	}
	const UWorld::InitializationValues Settings = UWorld::InitializationValues()
		.AllowAudioPlayback(false).CreatePhysicsScene(false).CreateNavigation(false)
		.CreateAISystem(false).CreateFXSystem(false).ShouldSimulatePhysics(false);
	UWorld* World = UWorld::CreateWorld(EWorldType::Editor, false,
		MakeUniqueObjectName(GetTransientPackage(), UWorld::StaticClass()),
		nullptr, true, ERHIFeatureLevel::Num, &Settings);
	if (!TestNotNull(TEXT("Create isolated editor world"), World)) return false;
	ON_SCOPE_EXIT { World->DestroyWorld(false); };
	UWorld* OtherWorld = UWorld::CreateWorld(EWorldType::Editor, false,
		MakeUniqueObjectName(GetTransientPackage(), UWorld::StaticClass()),
		nullptr, true, ERHIFeatureLevel::Num, &Settings);
	if (!TestNotNull(TEXT("Create separate world"), OtherWorld)) return false;
	ON_SCOPE_EXIT { OtherWorld->DestroyWorld(false); };
	UDataTable* Table = NewObject<UDataTable>(GetTransientPackage());
	Table->RowStruct = FUEShedAuthoringTestRow::StaticStruct();
	Table->AddRow(TEXT("Target"), FUEShedAuthoringTestRow());
	Table->AddRow(TEXT("Other"), FUEShedAuthoringTestRow());
	FDataTableRowHandle Handle;
	Handle.DataTable = Table;
	Handle.RowName = TEXT("Target");
	FUEShedAuthoringTestReference Reference;
	Reference.Handle = Handle;
	TSet<FString> Expected;
	auto Spawn = [&]()
	{
		AUEShedAuthoringTestActor* Actor = World->SpawnActor<AUEShedAuthoringTestActor>();
		if (Actor) Expected.Add(Actor->GetPathName());
		return Actor;
	};
	AUEShedAuthoringTestActor* Direct = Spawn();
	AUEShedAuthoringTestActor* Nested = Spawn();
	AUEShedAuthoringTestActor* Static = Spawn();
	AUEShedAuthoringTestActor* Array = Spawn();
	AUEShedAuthoringTestActor* Set = Spawn();
	AUEShedAuthoringTestActor* MapKey = Spawn();
	AUEShedAuthoringTestActor* MapValue = Spawn();
	AUEShedAuthoringTestActor* ComponentActor = Spawn();
	if (!TestTrue(TEXT("Spawn reference cases"), Direct && Nested && Static && Array
		&& Set && MapKey && MapValue && ComponentActor)) return false;
	Direct->Direct = Handle;
	Direct->Nested = Reference; // Duplicate matches still yield one actor.
	Nested->Nested = Reference;
	Static->StaticReferences[1] = Handle;
	Array->Array.Add(Reference);
	Set->Set.Add(Reference);
	MapKey->Map.Add(Reference, FUEShedAuthoringTestReference());
	MapValue->Map.Add(FUEShedAuthoringTestReference(), Reference);
	UUEShedAuthoringTestComponent* Component = NewObject<UUEShedAuthoringTestComponent>(ComponentActor);
	Component->Nested = Reference;
	ComponentActor->AddInstanceComponent(Component);
	AUEShedAuthoringTestActor* NonMatch = World->SpawnActor<AUEShedAuthoringTestActor>();
	AUEShedAuthoringTestActor* OtherActor = OtherWorld->SpawnActor<AUEShedAuthoringTestActor>();
	if (!TestTrue(TEXT("Spawn negative controls"), NonMatch && OtherActor)) return false;
	NonMatch->Direct = Handle;
	NonMatch->Direct.RowName = TEXT("Other");
	OtherActor->Direct = Handle;
	const TSharedRef<FJsonObject> Request = ReferenceRequest(World, Table);
	const bool bDirtyBefore = World->GetOutermost()->IsDirty();
	const TSharedPtr<FJsonObject> Complete = Scan(Request);
	if (!TestTrue(TEXT("Scan returns JSON"), Complete.IsValid())) return false;
	TestEqual(TEXT("Scan succeeds"), Complete->GetStringField(TEXT("status")), FString(TEXT("ok")));
	TestTrue(TEXT("Unbounded fixture scan is complete"), Complete->GetBoolField(TEXT("isComplete")));
	const TSet<FString> Found = ResultPaths(Complete);
	TestEqual(TEXT("All container and component cases match exactly once"), Found.Num(), Expected.Num());
	for (const FString& Path : Expected) TestTrue(*Path, Found.Contains(Path));
	TestFalse(TEXT("Other rows are excluded"), Found.Contains(NonMatch->GetPathName()));
	TestFalse(TEXT("Other loaded worlds are excluded"), Found.Contains(OtherActor->GetPathName()));
	TestEqual(TEXT("Scanning does not dirty the world"), World->GetOutermost()->IsDirty(), bDirtyBefore);
	OtherWorld->WorldType = EWorldType::PIE;
	const TSharedPtr<FJsonObject> PieScan = Scan(ReferenceRequest(OtherWorld, Table));
	TestTrue(TEXT("Explicit loaded PIE worlds are supported"), PieScan->GetBoolField(TEXT("isComplete")));
	TestTrue(TEXT("PIE world selection finds its actor"),
		ResultPaths(PieScan).Contains(OtherActor->GetPathName()));
	TestFalse(TEXT("PIE world selection excludes editor actors"),
		ResultPaths(PieScan).Contains(Direct->GetPathName()));
	OtherWorld->WorldType = EWorldType::Game;
	TestEqual(TEXT("Standalone game worlds are outside this editor capability"),
		Scan(ReferenceRequest(OtherWorld, Table))->GetStringField(TEXT("status")),
		FString(TEXT("rejected")));
	OtherWorld->WorldType = EWorldType::Editor;
	Request->SetNumberField(TEXT("maxActors"), 1);
	const TSharedPtr<FJsonObject> ActorBounded = Scan(Request);
	TestEqual(TEXT("Actor budget is enforced"), ActorBounded->GetIntegerField(TEXT("scannedActorCount")), 1);
	TestFalse(TEXT("Actor limit reports partial"), ActorBounded->GetBoolField(TEXT("isComplete")));
	Request->SetNumberField(TEXT("maxActors"), 1000);
	Request->SetNumberField(TEXT("maxResults"), 1);
	const TSharedPtr<FJsonObject> ResultBounded = Scan(Request);
	TestEqual(TEXT("Result budget is enforced"), ResultPaths(ResultBounded).Num(), 1);
	TestFalse(TEXT("Result limit reports partial"), ResultBounded->GetBoolField(TEXT("isComplete")));
	Request->SetNumberField(TEXT("maxResults"), 1000);
	NonMatch->Array.SetNum(350000);
	const TSharedPtr<FJsonObject> PropertyBounded = Scan(Request);
	TestFalse(TEXT("Large reflected containers obey the property budget"),
		PropertyBounded->GetBoolField(TEXT("isComplete")));
	TestEqual(TEXT("Property exhaustion reports a scan diagnostic"),
		PropertyBounded->GetArrayField(TEXT("errors"))[0]->AsObject()->GetStringField(TEXT("code")),
		FString(TEXT("scan_limit")));
	NonMatch->Array.Empty();
	Request->SetStringField(TEXT("rowName"), TEXT("Missing"));
	TestEqual(TEXT("Missing row is rejected"), Scan(Request)->GetStringField(TEXT("status")),
		FString(TEXT("rejected")));
	Request->SetStringField(TEXT("rowName"), TEXT("Target"));
	World->bIsTearingDown = true;
	TestEqual(TEXT("Stale world is rejected"), Scan(Request)->GetStringField(TEXT("status")),
		FString(TEXT("rejected")));
	World->bIsTearingDown = false;
	Request->SetStringField(TEXT("worldObjectPath"), TEXT("/Game/NotLoaded.NotLoaded"));
	TestEqual(TEXT("Unloaded world is rejected without loading"),
		Scan(Request)->GetStringField(TEXT("status")), FString(TEXT("rejected")));
	Request->SetStringField(TEXT("worldObjectPath"), World->GetPathName());
	Request->SetStringField(TEXT("tableObjectPath"), TEXT("/Game/NotLoaded.NotLoaded"));
	TestEqual(TEXT("Unloaded table is rejected without loading"),
		Scan(Request)->GetStringField(TEXT("status")), FString(TEXT("rejected")));
	Request->SetStringField(TEXT("tableObjectPath"), Table->GetPathName());
	Request->SetStringField(TEXT("rowName"), TEXT("Target\n"));
	TestEqual(TEXT("Control characters are rejected"), Scan(Request)->GetStringField(TEXT("status")),
		FString(TEXT("rejected")));
	Request->SetStringField(TEXT("rowName"), TEXT("Target"));
	Request->SetNumberField(TEXT("maxActors"), 1.5);
	TestEqual(TEXT("Fractional limits are rejected"), Scan(Request)->GetStringField(TEXT("status")),
		FString(TEXT("rejected")));
	Request->SetNumberField(TEXT("maxActors"), 1000);
	Request->SetStringField(TEXT("padding"), FString::ChrN(6000, static_cast<TCHAR>(0x4E2D)));
	const FString UnicodeRequest = WriteObject(Request);
	TestTrue(TEXT("Unicode byte-limit fixture fits the character limit"), UnicodeRequest.Len() < 16384);
	TestTrue(TEXT("Unicode byte-limit fixture exceeds the UTF-8 byte limit"),
		FTCHARToUTF8(*UnicodeRequest).Length() > 16384);
	const TSharedPtr<FJsonObject> UnicodeRejected = Scan(Request);
	TestEqual(TEXT("Oversized UTF-8 request is rejected"),
		UnicodeRejected->GetStringField(TEXT("status")), FString(TEXT("rejected")));
	TestEqual(TEXT("UTF-8 rejection reports invalid request"),
		UnicodeRejected->GetArrayField(TEXT("errors"))[0]->AsObject()->GetStringField(TEXT("code")),
		FString(TEXT("invalid_request")));
	for (const FString& Malformed : { TEXT("{"), TEXT("[]"), TEXT("null"), TEXT("{}"),
		TEXT("{\"contract\":null}"), TEXT("{\"contract\":{\"name\":42}}") })
	{
		FString Json;
		UUEShedAuthoringLibrary::FindActorsReferencingRow(Malformed, Json);
		const TSharedPtr<FJsonObject> Rejected = ReadObject(Json);
		if (!TestTrue(TEXT("Malformed requests return JSON"), Rejected.IsValid())) return false;
		TestEqual(TEXT("Malformed request is rejected safely"), Rejected->GetStringField(TEXT("status")),
			FString(TEXT("rejected")));
		TestFalse(TEXT("Rejected scans are never complete"), Rejected->GetBoolField(TEXT("isComplete")));
	}
	return true;
}

#endif
