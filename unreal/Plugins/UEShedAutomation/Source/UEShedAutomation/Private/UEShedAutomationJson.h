#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace UEShedAutomation
{
inline TSharedRef<FJsonObject> Result(const TCHAR* Name)
{
	auto Value = MakeShared<FJsonObject>();
	auto Contract = MakeShared<FJsonObject>();
	auto Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetStringField(TEXT("name"), Name);
	Contract->SetObjectField(TEXT("version"), Version);
	Value->SetObjectField(TEXT("contract"), Contract);
	Value->SetStringField(TEXT("status"), TEXT("rejected"));
	Value->SetArrayField(TEXT("errors"), {});
	return Value;
}

inline void Error(const TSharedRef<FJsonObject>& Result, const TCHAR* Code, const TCHAR* Message)
{
	auto Value = MakeShared<FJsonObject>();
	Value->SetStringField(TEXT("code"), Code);
	Value->SetStringField(TEXT("message"), Message);
	Result->SetArrayField(TEXT("errors"), { MakeShared<FJsonValueObject>(Value) });
}

inline void Encode(const TSharedRef<FJsonObject>& Result, FString& Json)
{
	Json.Reset();
	FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Json));
}

inline bool Parse(const FString& Json, const TCHAR* Name,
	const TSharedRef<FJsonObject>& Result, TSharedPtr<FJsonObject>& Request)
{
	if (!IsInGameThread())
	{
		Error(Result, TEXT("game_thread_required"), TEXT("Call automation on the game thread."));
		return false;
	}
	if (Json.Len() > 16384 || FTCHARToUTF8(*Json).Length() > 16384)
	{
		Error(Result, TEXT("payload_too_large"), TEXT("Requests are limited to 16384 UTF-8 bytes."));
		return false;
	}
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Json), Request)
		|| !Request.IsValid())
	{
		Error(Result, TEXT("invalid_request"), TEXT("Expected a JSON object."));
		return false;
	}
	const TSharedPtr<FJsonObject>* Contract = nullptr;
	const TSharedPtr<FJsonObject>* Version = nullptr;
	FString ContractName;
	double Major = -1, Minor = -1;
	if (!Request->TryGetObjectField(TEXT("contract"), Contract)
		|| !(*Contract)->TryGetStringField(TEXT("name"), ContractName)
		|| !(*Contract)->TryGetObjectField(TEXT("version"), Version)
		|| !(*Version)->TryGetNumberField(TEXT("major"), Major)
		|| !(*Version)->TryGetNumberField(TEXT("minor"), Minor)
		|| ContractName != Name || Major != 1 || Minor != 0)
	{
		Error(Result, TEXT("unsupported_contract"), TEXT("Expected the named version 1.0 contract."));
		return false;
	}
	return true;
}

inline bool RequiredPath(const TSharedPtr<FJsonObject>& Request,
	const TSharedRef<FJsonObject>& Result, const TCHAR* Field, FString& Path)
{
	const bool bString = Request->TryGetStringField(Field, Path);
	if (bString) Result->SetStringField(Field, Path);
	bool bControlCharacter = false;
	for (const TCHAR Character : Path)
		if (Character < 0x20) bControlCharacter = true;
	if (!bString || !Path.StartsWith(TEXT("/")) || Path.Len() > 2048 || bControlCharacter)
	{
		Error(Result, TEXT("invalid_request"),
			TEXT("Supply absolute object paths up to 2048 characters with no control characters."));
		return false;
	}
	return true;
}
}
