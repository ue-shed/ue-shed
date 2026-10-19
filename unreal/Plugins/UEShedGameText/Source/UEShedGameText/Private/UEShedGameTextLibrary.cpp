#include "UEShedGameTextLibrary.h"

#include "UEShedGameTextEngine.h"

#include "UEShedGameTextActions.h"
#include "Dom/JsonObject.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Internationalization/StringTableRegistry.h"
#include "Internationalization/Text.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

void UUEShedGameTextLibrary::ApplyTextActions(const FString& RequestJson, FString& ResultJson)
{
	ResultJson = UEShedGameText::ApplyTextActions(RequestJson);
}

void UUEShedGameTextLibrary::VerifyStringTableRedirect(const FString& RequestJson, FString& ResultJson)
{
	TSharedPtr<FJsonObject> Request;
	FString RequestContract, Version, Table, OldKey, NewKey, ExpectedSource;
	bool bActivate = false;
	const bool bValid = FTCHARToUTF8(*RequestJson).Length() <= 1024 * 1024
		&& FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RequestJson), Request) && Request.IsValid()
		&& Request->TryGetStringField(TEXT("contract"), RequestContract) && RequestContract == TEXT("ue-shed-string-table-redirect")
		&& Request->TryGetStringField(TEXT("version"), Version) && Version == TEXT("1.0")
		&& Request->TryGetStringField(TEXT("tableId"), Table) && !Table.IsEmpty() && Table.Len() <= 4096
		&& Request->TryGetStringField(TEXT("oldKey"), OldKey) && !OldKey.IsEmpty() && OldKey.Len() <= 4096
		&& Request->TryGetStringField(TEXT("newKey"), NewKey) && !NewKey.IsEmpty() && NewKey.Len() <= 4096
		&& Request->TryGetStringField(TEXT("source"), ExpectedSource) && ExpectedSource.Len() <= 4096
		&& Request->TryGetBoolField(TEXT("activate"), bActivate);
	FString Status = bValid ? TEXT("inactive") : TEXT("invalid_request");
	FString Message = bValid ? TEXT("The exact redirect and destination source have not been verified.") : TEXT("Invalid String Table redirect request.");
	FName ActualTable(*Table);
	UEShedGameTextEngine::FTableKey ActualKey(OldKey);
	FString ActualSource;
	if (bValid)
	{
		// Loading a table is read-only. Verify its target before changing the live redirect map.
		if (!FStringTableRegistry::Get().FindStringTable(FName(Table))) LoadObject<UStringTable>(nullptr, *Table);
		const FStringTableConstPtr Target = FStringTableRegistry::Get().FindStringTable(FName(Table));
		FName DestinationTable(*Table); UEShedGameTextEngine::FTableKey DestinationKey(NewKey);
		FStringTableRedirects::RedirectTableIdAndKey(DestinationTable, DestinationKey);
		const bool bTarget = Target && Target->GetSourceString(UEShedGameTextEngine::FTableKey(NewKey), ActualSource) && ActualSource == ExpectedSource
			&& DestinationTable == FName(Table) && DestinationKey == UEShedGameTextEngine::FTableKey(NewKey);
		FStringTableRedirects::RedirectTableIdAndKey(ActualTable, ActualKey);
		const bool bConflict = ActualTable != FName(Table) || (ActualKey != UEShedGameTextEngine::FTableKey(OldKey) && ActualKey != UEShedGameTextEngine::FTableKey(NewKey));
		if (bActivate && bTarget && !bConflict)
		{
			FString ConfigFile;
			if (Request->TryGetStringField(TEXT("configFile"), ConfigFile))
			{
				const FString Root = FPaths::ConvertRelativePathToFull(FPaths::ProjectConfigDir());
				FString Filename = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir(), ConfigFile);
				FPaths::NormalizeFilename(Filename); FPaths::CollapseRelativeDirectories(Filename);
				if (FPaths::IsUnderDirectory(Filename, Root) && FPaths::GetExtension(Filename).Equals(TEXT("ini"), ESearchCase::IgnoreCase))
				{
					FConfigFile Persisted;
					Persisted.Combine(Filename);
					TArray<FString> Values;
					Persisted.GetArray(TEXT("Core.StringTable"), TEXT("StringTableRedirects"), Values);
					for (const FString& Value : Values)
					{
						FName ConfigTable; FString ConfigOld, ConfigNew;
						if (FParse::Value(*Value, TEXT("StringTable="), ConfigTable) && ConfigTable == FName(Table)
							&& FParse::Value(*Value, TEXT("OldKey="), ConfigOld) && ConfigOld == OldKey
							&& FParse::Value(*Value, TEXT("NewKey="), ConfigNew) && ConfigNew == NewKey)
						{
							UEShedGameTextEngine::AddRedirect(Value);
							FStringTableRedirects::InitStringTableRedirects();
							break;
						}
					}
				}
			}
		}
		ActualTable = FName(Table); ActualKey = UEShedGameTextEngine::FTableKey(OldKey);
		FStringTableRedirects::RedirectTableIdAndKey(ActualTable, ActualKey);
		if (bTarget && ActualTable == FName(Table) && ActualKey == UEShedGameTextEngine::FTableKey(NewKey))
		{
			const FText DynamicReference = FText::FromStringTable(FName(Table), OldKey, EStringTableLoadingPolicy::FindOrFullyLoad);
			FName ReferenceTable; FString ReferenceKey;
			if (FTextInspector::GetTableIdAndKey(DynamicReference, ReferenceTable, ReferenceKey)
				&& ReferenceTable == FName(Table) && ReferenceKey == NewKey)
			{
				Status = TEXT("active");
				Message = TEXT("A fresh runtime reference using the old key resolves to the exact reviewed destination source.");
			}
		}
	}
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("contract"), TEXT("ue-shed-string-table-redirect"));
	Result->SetStringField(TEXT("version"), TEXT("1.0"));
	Result->SetStringField(TEXT("status"), Status); Result->SetStringField(TEXT("tableId"), ActualTable.ToString());
	Result->SetStringField(TEXT("key"), UEShedGameTextEngine::KeyString(ActualKey)); Result->SetStringField(TEXT("source"), ActualSource);
	Result->SetStringField(TEXT("message"), Message);
	FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&ResultJson));
}
