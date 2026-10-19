#include "UEShedGameTextCommandlet.h"

#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "UEShedGameTextActions.h"
#include "UEShedCoreLibrary.h"

UUEShedGameTextCommandlet::UUEShedGameTextCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UUEShedGameTextCommandlet::Main(const FString& Params)
{
	FString ManifestFile;
	if (FParse::Value(*Params, TEXT("Manifest="), ManifestFile))
	{
		FString Manifest;
		UUEShedCoreLibrary::GetCapabilityManifest(Manifest);
		return FFileHelper::SaveStringToFile(Manifest, *ManifestFile,
			FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) ? 0 : 2;
	}
	FString RequestFile;
	FString ResultFile;
	if (!FParse::Value(*Params, TEXT("Request="), RequestFile) || !FParse::Value(*Params, TEXT("Result="), ResultFile))
	{
		UE_LOG(LogTemp, Error, TEXT("UEShedGameText requires -Request=<request.json> -Result=<result.json>."));
		return 2;
	}
	FString RequestJson;
	if (!FFileHelper::LoadFileToString(RequestJson, *RequestFile))
	{
		UE_LOG(LogTemp, Error, TEXT("UEShedGameText could not read %s."), *RequestFile);
		return 2;
	}
	const FString ResultJson = UEShedGameText::ApplyTextActions(RequestJson);
	if (!FFileHelper::SaveStringToFile(ResultJson, *ResultFile, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
	{
		UE_LOG(LogTemp, Error, TEXT("UEShedGameText could not write %s."), *ResultFile);
		return 2;
	}
	return UEShedGameText::IsOkResult(ResultJson) ? 0 : 1;
}
