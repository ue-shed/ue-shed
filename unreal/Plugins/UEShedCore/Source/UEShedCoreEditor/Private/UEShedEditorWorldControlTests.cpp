#if WITH_DEV_AUTOMATION_TESTS
#include "UEShedEditorWorldControlLibrary.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "HAL/FileManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Tests/AutomationEditorCommon.h"

namespace
{
FString Request(const TCHAR* Id, const FString& Map)
{
	return FString::Printf(TEXT("{\"contract\":{\"name\":\"unreal-editor-world-control\",\"version\":{\"major\":1,\"minor\":0}},\"operationId\":\"%s\",\"targetMapPath\":\"%s\"}"), Id, *Map);
}
TSharedPtr<FJsonObject> Decode(const FString& Json)
{
	TSharedPtr<FJsonObject> Value;
	FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Value);
	return Value;
}
FString ObjectPath(const FString& Map) { return Map + TEXT(".") + FPackageName::GetShortName(Map); }

class FCheckMapOpen : public IAutomationLatentCommand
{
	FAutomationTestBase* Test;
	FString Original, Target, Pending;
	bool bCheckingDirty = false;
	double Deadline = FPlatformTime::Seconds() + 60;
public:
	FCheckMapOpen(FAutomationTestBase* InTest, FString InOriginal, FString InTarget, FString InPending)
		: Test(InTest), Original(MoveTemp(InOriginal)), Target(MoveTemp(InTarget)), Pending(MoveTemp(InPending)) {}
	virtual bool Update() override
	{
		FString Json;
		UUEShedEditorWorldControlLibrary::GetOpenMapStatus(Pending, Json);
		auto State = Decode(Json);
		if (State.IsValid() && State->GetStringField(TEXT("status")) == TEXT("completed"))
		{
			auto Result = State->GetObjectField(TEXT("result"));
			if (!bCheckingDirty)
			{
				Test->TestEqual(TEXT("Async open completes"), Result->GetStringField(TEXT("outcome")), FString(TEXT("opened")));
				Test->TestEqual(TEXT("Target is current"), GEditor->GetEditorWorldContext().World()->GetOutermost()->GetName(), Target);
				UUEShedEditorWorldControlLibrary::BeginOpenMap(Pending, Json);
				Test->TestEqual(TEXT("Repeated identity returns retained completion"), Decode(Json)->GetStringField(TEXT("status")), FString(TEXT("completed")));
				UUEShedEditorWorldControlLibrary::GetWorldState(Json);
				Test->TestEqual(TEXT("Live state follows the new map"), Decode(Json)->GetObjectField(TEXT("snapshot"))->GetStringField(TEXT("mapPath")), Target);
				GEditor->GetEditorWorldContext().World()->GetOutermost()->SetDirtyFlag(true);
				Pending = Request(TEXT("dirty-refusal"), TEXT("/Game/Fixture/WorldControl/Missing"));
				UUEShedEditorWorldControlLibrary::BeginOpenMap(Pending, Json);
				bCheckingDirty = true;
				return false;
			}
			Test->TestEqual(TEXT("Dirty map refused"), Result->GetStringField(TEXT("code")), FString(TEXT("dirty_world")));
			Test->TestEqual(TEXT("Dirty state did not switch maps"), GEditor->GetEditorWorldContext().World()->GetOutermost()->GetName(), Target);
			GEditor->GetEditorWorldContext().World()->GetOutermost()->SetDirtyFlag(false);
			UEditorLoadingAndSavingUtils::LoadMap(ObjectPath(Original));
			UUEShedEditorWorldControlLibrary::ShutdownWorldControl();
			return true;
		}
		if (FPlatformTime::Seconds() < Deadline) return false;
		Test->AddError(TEXT("Asynchronous map-open fixture did not complete."));
		UUEShedEditorWorldControlLibrary::ShutdownWorldControl();
		GEditor->GetEditorWorldContext().World()->GetOutermost()->SetDirtyFlag(false);
		UEditorLoadingAndSavingUtils::LoadMap(ObjectPath(Original));
		return true;
	}
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedWorldAsyncTest, "UEShed.Core.EditorWorld.AsyncOpen",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedWorldAsyncTest::RunTest(const FString& Parameters)
{
	// Never generate/save maps in a user's editor; this test owns the isolated compatibility project.
	if (FPaths::GetBaseFilename(FPaths::GetProjectFilePath()) != TEXT("UEShedPluginCompatibility"))
	{
		AddError(TEXT("Run using test:unreal-plugins in its isolated compatibility project."));
		return false;
	}
	const FString Original = GEditor->GetEditorWorldContext().World()->GetOutermost()->GetName();
	const FString Target = TEXT("/Game/Fixture/WorldControl/AsyncTarget");
	IFileManager::Get().MakeDirectory(*(FPaths::ProjectContentDir() / TEXT("Fixture/WorldControl")), true);
	UWorld* World = FAutomationEditorCommonUtils::CreateNewMap();
	if (!TestTrue(TEXT("Save generated target fixture"), UEditorLoadingAndSavingUtils::SaveMap(World, Target))) return false;
	UEditorLoadingAndSavingUtils::LoadMap(ObjectPath(Original));
	const FString Pending = Request(TEXT("async-open"), Target);
	FString Json;
	UUEShedEditorWorldControlLibrary::BeginOpenMap(Pending, Json);
	TestEqual(TEXT("Acknowledges before loading"), Decode(Json)->GetStringField(TEXT("status")), FString(TEXT("pending")));
	TestEqual(TEXT("Does not synchronously change the world"), GEditor->GetEditorWorldContext().World()->GetOutermost()->GetName(), Original);
	UUEShedEditorWorldControlLibrary::BeginOpenMap(Pending, Json);
	TestEqual(TEXT("Duplicate begin is idempotent"), Decode(Json)->GetStringField(TEXT("status")), FString(TEXT("pending")));
	UUEShedEditorWorldControlLibrary::BeginOpenMap(Request(TEXT("other"), Target), Json);
	TestEqual(TEXT("Second operation refused while busy"), Decode(Json)->GetStringField(TEXT("code")), FString(TEXT("busy")));
	UUEShedEditorWorldControlLibrary::BeginOpenMap(Request(TEXT("async-open"), TEXT("/Game/Fixture/Other")), Json);
	TestEqual(TEXT("ID cannot be reused for another target"), Decode(Json)->GetStringField(TEXT("code")), FString(TEXT("conflict")));
	UUEShedEditorWorldControlLibrary::GetOpenMapStatus(Request(TEXT("unknown"), Target), Json);
	TestEqual(TEXT("Missing operation is not replayed"), Decode(Json)->GetStringField(TEXT("code")), FString(TEXT("unknown_operation")));
	UUEShedEditorWorldControlLibrary::BeginOpenMap(TEXT("{}"), Json);
	TestEqual(TEXT("Reject malformed request"), Decode(Json)->GetStringField(TEXT("code")), FString(TEXT("invalid_request")));
	FAutomationTestFramework::Get().EnqueueLatentCommand(MakeShared<FCheckMapOpen>(this, Original, Target, Pending));
	return true;
}
#endif
