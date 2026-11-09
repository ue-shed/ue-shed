#include "UEShedGameTextCommandlet.h"

#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "UEShedGameTextActions.h"
#include "UEShedGameTextResultFile.h"
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
		FString Error;
		if (UEShedGameText::PublishFileAtomically(ManifestFile, Manifest, Error)) return 0;
		UE_LOG(LogTemp, Error, TEXT("UEShedGameText could not publish the manifest: %s."), *Error);
		return 2;
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
	// A reader sees no result or a complete one, never partial JSON.
	FString Error;
	if (!UEShedGameText::PublishFileAtomically(ResultFile, ResultJson, Error))
	{
		UE_LOG(LogTemp, Error, TEXT("UEShedGameText could not publish the result: %s."), *Error);
		return 2;
	}
	return UEShedGameText::IsOkResult(ResultJson) ? 0 : 1;
}
