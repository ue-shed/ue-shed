#include "UEShedTexturePreviewCommandlet.h"

#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedAssetAuditsLibrary.h"

namespace
{
constexpr int32 MaxBatchSize = 100;

bool GeneratePreview(
	const FString& ObjectPath, const FString& OutputPath, int32 MaxDimension)
{
	const FString ResultJson = UUEShedAssetAuditsLibrary::BuildTexturePreviewJson(
		ObjectPath, MaxDimension, TEXT("saved_asset"));
	const FString AbsoluteOutput = FPaths::ConvertRelativePathToFull(OutputPath);
	return FFileHelper::SaveStringToFile(ResultJson, *AbsoluteOutput);
}

int32 GenerateBatch(const FString& RequestPath)
{
	FString RequestJson;
	const FString AbsoluteRequest = FPaths::ConvertRelativePathToFull(RequestPath);
	if (!FFileHelper::LoadFileToString(RequestJson, *AbsoluteRequest))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not read texture preview batch %s"), *AbsoluteRequest);
		return 1;
	}
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		UE_LOG(LogTemp, Error, TEXT("Texture preview batch is not valid JSON"));
		return 1;
	}
	const TArray<TSharedPtr<FJsonValue>>* Requests = nullptr;
	if (!Root->TryGetArrayField(TEXT("requests"), Requests) || !Requests || Requests->IsEmpty()
		|| Requests->Num() > MaxBatchSize)
	{
		UE_LOG(LogTemp, Error, TEXT("Texture preview batch must contain 1-%d requests"), MaxBatchSize);
		return 1;
	}
	for (int32 Index = 0; Index < Requests->Num(); ++Index)
	{
		const TSharedPtr<FJsonObject> Request = (*Requests)[Index]->AsObject();
		FString ObjectPath;
		FString OutputPath;
		int32 MaxDimension = 384;
		if (!Request.IsValid() || !Request->TryGetStringField(TEXT("objectPath"), ObjectPath)
			|| !Request->TryGetStringField(TEXT("outputPath"), OutputPath)
			|| !Request->TryGetNumberField(TEXT("maxDimension"), MaxDimension))
		{
			UE_LOG(LogTemp, Error, TEXT("Texture preview batch request %d is invalid"), Index);
			return 1;
		}
		if (!GeneratePreview(ObjectPath, OutputPath, MaxDimension))
		{
			UE_LOG(LogTemp, Error, TEXT("Could not write texture preview %d to %s"), Index,
				*FPaths::ConvertRelativePathToFull(OutputPath));
			return 1;
		}
	}
	return 0;
}
}

UUEShedTexturePreviewCommandlet::UUEShedTexturePreviewCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UUEShedTexturePreviewCommandlet::Main(const FString& Params)
{
	FString RequestPath;
	if (FParse::Value(*Params, TEXT("Request="), RequestPath))
	{
		return GenerateBatch(RequestPath);
	}

	FString ObjectPath;
	FString OutputPath;
	int32 MaxDimension = 384;
	if (!FParse::Value(*Params, TEXT("ObjectPath="), ObjectPath)
		|| !FParse::Value(*Params, TEXT("Output="), OutputPath))
	{
		UE_LOG(LogTemp, Error,
			TEXT("Usage: -run=UEShedTexturePreview -ObjectPath=/Game/... -Output=<json> "
				 "[-MaxDimension=384]"));
		return 1;
	}
	FParse::Value(*Params, TEXT("MaxDimension="), MaxDimension);

	if (!GeneratePreview(ObjectPath, OutputPath, MaxDimension))
	{
		UE_LOG(LogTemp, Error, TEXT("Could not write texture preview result to %s"),
			*FPaths::ConvertRelativePathToFull(OutputPath));
		return 1;
	}
	return 0;
}
