#include "UEShedCameraLibrary.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Dom/JsonObject.h"
#include "Misc/AutomationTest.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedCameraFailureJsonTest, "UEShed.Cameras.FailureJson",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedCameraFailureJsonTest::RunTest(const FString& Parameters)
{
	// Quotes, backslashes and control characters used to end the string early or break the JSON.
	const FString Message = TEXT("Actor \"Door\\Left\" is\nnot loaded\t(see C:\\Maps)");
	const FString Json = UEShedCameraFailureJson(5, TEXT("invalid-visibility"), Message);
	TSharedPtr<FJsonObject> Root;
	if (!TestTrue(TEXT("Failure JSON parses"),
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Root) && Root.IsValid()))
	{
		return false;
	}
	TestEqual(TEXT("Version"), static_cast<int32>(Root->GetNumberField(TEXT("schemaVersion"))), 5);
	TestEqual(TEXT("Status"), Root->GetStringField(TEXT("status")), FString(TEXT("failed")));
	TestEqual(TEXT("The code field holds the code"), Root->GetStringField(TEXT("error")),
		FString(TEXT("invalid-visibility")));
	TestEqual(TEXT("The prose survives intact"), Root->GetStringField(TEXT("message")), Message);

	TSharedPtr<FJsonObject> Bare;
	TestTrue(TEXT("Code-only failure parses"), FJsonSerializer::Deserialize(
		TJsonReaderFactory<>::Create(UEShedCameraFailureJson(1, TEXT("no-renderable-world"), FString())), Bare)
		&& Bare.IsValid() && !Bare->HasField(TEXT("message")));

	// A malformed Configure request reports a code, now with a status, as valid JSON.
	FString Configured;
	UUEShedCameraLibrary::Configure(TEXT("{\"bad\""), Configured);
	TSharedPtr<FJsonObject> Failure;
	if (TestTrue(TEXT("Configure failure parses"),
		FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Configured), Failure) && Failure.IsValid()))
	{
		TestEqual(TEXT("Configure failure status"), Failure->GetStringField(TEXT("status")), FString(TEXT("failed")));
		TestFalse(TEXT("Configure failure has a code"), Failure->GetStringField(TEXT("error")).IsEmpty());
	}
	return true;
}

#endif
