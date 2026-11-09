#include "UEShedGameTextResultFile.h"

#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
#include "Windows/WindowsHWrapper.h"
#include "Windows/HideWindowsPlatformTypes.h"
#endif

namespace
{
// Replaces To with From in one step: readers never observe To missing or partly written.
bool ReplaceFile(const FString& From, const FString& To)
{
#if PLATFORM_WINDOWS
	const FString Source = FPaths::ConvertRelativePathToFull(From).Replace(TEXT("/"), TEXT("\\"));
	const FString Target = FPaths::ConvertRelativePathToFull(To).Replace(TEXT("/"), TEXT("\\"));
	return ::MoveFileExW(*Source, *Target, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
	// POSIX rename(2) replaces an existing target atomically on the same file system.
	return FPlatformFileManager::Get().GetPlatformFile().MoveFile(*To, *From);
#endif
}
}

bool UEShedGameText::PublishFileAtomically(const FString& Path, const FString& Text, FString& OutError,
	TFunctionRef<bool(const FString& StagingPath, const FString& Text)> Write)
{
	const FString Target = FPaths::ConvertRelativePathToFull(Path);
	const FString Directory = FPaths::GetPath(Target);
	IFileManager& Files = IFileManager::Get();
	if (!Directory.IsEmpty() && !Files.DirectoryExists(*Directory) && !Files.MakeDirectory(*Directory, true))
	{
		OutError = FString::Printf(TEXT("could not create %s"), *Directory);
		return false;
	}
	// Same directory, so the rename never crosses file systems.
	const FString Staging = FPaths::Combine(Directory, FString::Printf(TEXT(".%s.%s.tmp"),
		*FPaths::GetCleanFilename(Target), *FGuid::NewGuid().ToString(EGuidFormats::Digits)));
	if (!Write(Staging, Text))
	{
		Files.Delete(*Staging, false, true, true);
		OutError = FString::Printf(TEXT("could not write %s"), *Staging);
		return false;
	}
	if (!ReplaceFile(Staging, Target))
	{
		Files.Delete(*Staging, false, true, true);
		OutError = FString::Printf(TEXT("could not replace %s"), *Target);
		return false;
	}
	return true;
}

bool UEShedGameText::PublishFileAtomically(const FString& Path, const FString& Text, FString& OutError)
{
	return PublishFileAtomically(Path, Text, OutError, [](const FString& StagingPath, const FString& Contents)
	{
		return FFileHelper::SaveStringToFile(Contents, *StagingPath,
			FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
	});
}
