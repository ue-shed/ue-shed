#include "UEShedAuthoringLibrary.h"

#include "Components/ActorComponent.h"
#include "Containers/StringConv.h"
#include "Dom/JsonObject.h"
#include "Engine/DataTable.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "UObject/StructOnScope.h"
#endif

namespace
{
constexpr int32 MaxRequestCharacters = 16384;
constexpr int32 MaxPathCharacters = 2048;
constexpr int32 MaxPropertyDepth = 64;
constexpr int32 MaxPropertyVisits = 1000000;
constexpr int32 MaxResultPathCharacters = 4 * 1024 * 1024;

TSharedRef<FJsonObject> ActorReferencesContract()
{
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("unreal-authoring-actor-references"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}

bool IsActorReferencesContract(const TSharedPtr<FJsonObject>& Request)
{
	const TSharedPtr<FJsonObject>* Contract;
	const TSharedPtr<FJsonObject>* Version;
	FString Name;
	double Major, Minor;
	return Request->TryGetObjectField(TEXT("contract"), Contract)
		&& (*Contract)->TryGetStringField(TEXT("name"), Name)
		&& Name == TEXT("unreal-authoring-actor-references")
		&& (*Contract)->TryGetObjectField(TEXT("version"), Version)
		&& (*Version)->TryGetNumberField(TEXT("major"), Major) && Major == 1
		&& (*Version)->TryGetNumberField(TEXT("minor"), Minor) && Minor == 0;
}

bool ReadBoundedString(const TSharedPtr<FJsonObject>& Request, const TCHAR* Name,
	FString& Value, int32 Maximum)
{
	FString Parsed;
	if (!Request->TryGetStringField(Name, Parsed) || Parsed.IsEmpty() || Parsed.Len() > Maximum
		|| Parsed.Contains(TEXT("\n")) || Parsed.Contains(TEXT("\r"))) return false;
	for (const TCHAR Character : Parsed)
	{
		if (Character < 32) return false;
	}
	Value = MoveTemp(Parsed);
	return true;
}

bool ReadLimit(const TSharedPtr<FJsonObject>& Request, const TCHAR* Name,
	int32& Value, int32 Maximum)
{
	double Parsed;
	if (!Request->TryGetNumberField(Name, Parsed) || !FMath::IsFinite(Parsed)
		|| Parsed < 1 || Parsed > Maximum || FMath::FloorToDouble(Parsed) != Parsed) return false;
	Value = static_cast<int32>(Parsed);
	return true;
}

struct FRowReferenceScan
{
	const UDataTable* Table;
	FName RowName;
	int32 Visits = 0;
	bool bComplete = true;

	bool ScanStruct(const UStruct* Struct, const void* Container, int32 Depth)
	{
		for (TFieldIterator<FProperty> It(Struct); It; ++It)
		{
			for (int32 Index = 0; Index < It->ArrayDim; ++Index)
			{
				if (ScanValue(*It, It->ContainerPtrToValuePtr<void>(Container, Index), Depth))
					return true;
				if (Visits >= MaxPropertyVisits) return false;
			}
		}
		return false;
	}

	bool ScanValue(const FProperty* Property, const void* Value, int32 Depth)
	{
		if (Visits >= MaxPropertyVisits)
		{
			bComplete = false;
			return false;
		}
		++Visits;
		if (Visits >= MaxPropertyVisits) bComplete = false;
		if (Depth > MaxPropertyDepth)
		{
			bComplete = false;
			return false;
		}
		if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
		{
			if (Struct->Struct == FDataTableRowHandle::StaticStruct())
			{
				const FDataTableRowHandle& Handle = *static_cast<const FDataTableRowHandle*>(Value);
				return Handle.DataTable == Table && Handle.RowName == RowName;
			}
			return ScanStruct(Struct->Struct, Value, Depth + 1);
		}
		if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
		{
			FScriptArrayHelper Helper(Array, Value);
			for (int32 Index = 0; Index < Helper.Num(); ++Index)
			{
				if (ScanValue(Array->Inner, Helper.GetRawPtr(Index), Depth + 1)) return true;
				if (Visits >= MaxPropertyVisits) break;
			}
		}
		else if (const FSetProperty* Set = CastField<FSetProperty>(Property))
		{
			const FScriptSetHelper Helper(Set, Value);
			for (int32 Index = 0; Index < Helper.GetMaxIndex(); ++Index)
			{
				if (Helper.IsValidIndex(Index)
					&& ScanValue(Set->ElementProp, Helper.GetElementPtr(Index), Depth + 1)) return true;
				if (!Helper.IsValidIndex(Index)) ++Visits;
				if (Visits >= MaxPropertyVisits) break;
			}
		}
		else if (const FMapProperty* Map = CastField<FMapProperty>(Property))
		{
			FScriptMapHelper Helper(Map, Value);
			for (int32 Index = 0; Index < Helper.GetMaxIndex(); ++Index)
			{
				if (Helper.IsValidIndex(Index)
					&& (ScanValue(Map->KeyProp, Helper.GetKeyPtr(Index), Depth + 1)
						|| ScanValue(Map->ValueProp, Helper.GetValuePtr(Index), Depth + 1))) return true;
				if (!Helper.IsValidIndex(Index)) ++Visits;
				if (Visits >= MaxPropertyVisits) break;
			}
		}
		// Reaching the exact visit budget is conservatively partial, even if a
		// containing loop has no remaining properties.
		if (Visits >= MaxPropertyVisits) bComplete = false;
		return false;
	}
};
}

void UUEShedAuthoringLibrary::FindActorsReferencingRow(
	const FString& RequestJson, FString& ResultJson)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("contract"), ActorReferencesContract());
	FString WorldPath, TablePath, RowName;
	TArray<TSharedPtr<FJsonValue>> Paths, Errors;
	int32 Scanned = 0;
	bool bComplete = false;
	bool bRejected = true;
	auto Reject = [&](const TCHAR* Code, const TCHAR* Message)
	{
		const TSharedRef<FJsonObject> Error = MakeShared<FJsonObject>();
		Error->SetStringField(TEXT("code"), Code);
		Error->SetStringField(TEXT("message"), Message);
		Errors.Add(MakeShared<FJsonValueObject>(Error));
	};
	TSharedPtr<FJsonObject> Request;
	int32 MaxActors = 0, MaxResults = 0;
	if (RequestJson.Len() > MaxRequestCharacters
		|| FTCHARToUTF8(*RequestJson, RequestJson.Len()).Length() > MaxRequestCharacters
		|| !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RequestJson), Request)
		|| !Request.IsValid())
	{
		Reject(TEXT("invalid_request"), TEXT("Request must be a bounded JSON object."));
	}
	else if (!IsActorReferencesContract(Request)
		|| !ReadBoundedString(Request, TEXT("worldObjectPath"), WorldPath, MaxPathCharacters)
		|| !ReadBoundedString(Request, TEXT("tableObjectPath"), TablePath, MaxPathCharacters)
		|| !ReadBoundedString(Request, TEXT("rowName"), RowName, NAME_SIZE - 1)
		|| !WorldPath.StartsWith(TEXT("/")) || !TablePath.StartsWith(TEXT("/"))
		|| !ReadLimit(Request, TEXT("maxActors"), MaxActors, 100000)
		|| !ReadLimit(Request, TEXT("maxResults"), MaxResults, 10000))
	{
		Reject(TEXT("invalid_request"), TEXT("Contract, explicit target, or scan limits are invalid."));
	}
	else if (!IsInGameThread())
	{
		Reject(TEXT("wrong_thread"), TEXT("Actor reference scans require the game thread."));
	}
	else
	{
		UWorld* World = FindObject<UWorld>(nullptr, *WorldPath);
		UDataTable* Table = FindObject<UDataTable>(nullptr, *TablePath);
		if (!IsValid(World) || World->bIsTearingDown
			|| (World->WorldType != EWorldType::Editor && World->WorldType != EWorldType::PIE))
		{
			Reject(TEXT("world_unavailable"), TEXT("Target must be an already-loaded editor or PIE world."));
		}
		else if (!IsValid(Table) || !Table->GetRowStruct())
		{
			Reject(TEXT("table_unavailable"), TEXT("Target DataTable must already be loaded."));
		}
		else if (!Table->GetRowMap().Contains(FName(*RowName)))
		{
			Reject(TEXT("row_unavailable"), TEXT("Target row does not exist in the selected table."));
		}
		else
		{
			bRejected = false;
			FRowReferenceScan Scan { Table, FName(*RowName) };
			int32 PathCharacters = 0;
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				if (Scanned >= MaxActors || Paths.Num() >= MaxResults
					|| Scan.Visits >= MaxPropertyVisits)
				{
					Scan.bComplete = false;
					break;
				}
				AActor* Actor = *It;
				if (!IsValid(Actor) || Actor->GetWorld() != World) continue;
				++Scanned;
				bool bFound = Scan.ScanStruct(Actor->GetClass(), Actor, 0);
				if (!bFound)
				{
					for (const UActorComponent* Component : Actor->GetComponents())
					{
						if (IsValid(Component) && Scan.ScanStruct(Component->GetClass(), Component, 0))
						{
							bFound = true;
							break;
						}
						if (Scan.Visits >= MaxPropertyVisits) break;
					}
				}
				if (bFound)
				{
					const FString Path = Actor->GetPathName();
					if (PathCharacters + Path.Len() > MaxResultPathCharacters)
					{
						Scan.bComplete = false;
						break;
					}
					PathCharacters += Path.Len();
					Paths.Add(MakeShared<FJsonValueString>(Path));
				}
			}
			bComplete = Scan.bComplete;
			if (!bComplete) Reject(TEXT("scan_limit"), TEXT("Scan bounds reached; results are partial."));
		}
	}
	Result->SetStringField(TEXT("status"), bRejected ? TEXT("rejected") : TEXT("ok"));
	Result->SetStringField(TEXT("worldObjectPath"), WorldPath);
	Result->SetStringField(TEXT("tableObjectPath"), TablePath);
	Result->SetStringField(TEXT("rowName"), RowName);
	Result->SetArrayField(TEXT("actorObjectPaths"), Paths);
	Result->SetNumberField(TEXT("scannedActorCount"), Scanned);
	Result->SetBoolField(TEXT("isComplete"), bComplete);
	Result->SetArrayField(TEXT("errors"), Errors);
	ResultJson.Reset();
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&ResultJson);
	FJsonSerializer::Serialize(Result, Writer);
}

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUEShedAuthoringActorReferencesDepthTest,
	"UEShed.Authoring.ActorReferenceDepth",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEShedAuthoringActorReferencesDepthTest::RunTest(const FString& Parameters)
{
	UScriptStruct* Root = FDataTableRowHandle::StaticStruct();
	for (int32 Index = 0; Index < MaxPropertyDepth + 2; ++Index)
	{
		UScriptStruct* Parent = NewObject<UScriptStruct>(GetTransientPackage());
		FStructProperty* Nested = new FStructProperty(Parent, TEXT("Nested"), RF_NoFlags);
		Nested->Struct = Root;
		Parent->AddCppProperty(Nested);
		Parent->Bind();
		Parent->StaticLink(true);
		Root = Parent;
	}
	const FStructOnScope Value(Root);
	FRowReferenceScan Scan { nullptr, NAME_None };
	TestFalse(TEXT("References beyond the recursion bound are not reported"),
		Scan.ScanStruct(Root, Value.GetStructMemory(), 0));
	TestFalse(TEXT("Depth exhaustion never claims a complete scan"), Scan.bComplete);
	return true;
}
#endif
