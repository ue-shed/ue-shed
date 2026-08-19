#include "UEShedNiagaraPreviewCommandlet.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "NiagaraBakerOutputTexture2D.h"
#include "NiagaraBakerSettings.h"
#include "NiagaraScript.h"
#include "NiagaraSystem.h"
#include "NiagaraSystemImpl.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UEShedNiagaraCapture.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(UEShedNiagaraPreviewCommandlet)

DEFINE_LOG_CATEGORY_STATIC(LogUEShedNiagaraPreview, Log, All);

namespace UEShedNiagaraPreviewCommandletPrivate
{
constexpr int32 MaximumDimension = 4096;
constexpr int32 MaximumFrames = 512;
constexpr int64 MaximumTotalPixels = 268435456;
constexpr float MaximumStartSeconds = 3600.0f;
constexpr float MaximumDurationSeconds = 600.0f;
constexpr int32 MaximumSimulationFramesPerSecond = 480;
constexpr int32 ExitInvalidRequest = 10;
constexpr int32 ExitRenderingUnavailable = 20;
constexpr int32 ExitSystemUnavailable = 21;
constexpr int32 ExitBakerCameraMissing = 22;
constexpr int32 ExitCompilationFailed = 23;
constexpr int32 ExitCaptureFailed = 24;

bool IsLowerHex(TCHAR Character)
{
	return (Character >= TEXT('0') && Character <= TEXT('9'))
		|| (Character >= TEXT('a') && Character <= TEXT('f'));
}

bool IsRunId(const FString& Value)
{
	if (Value.Len() != 36 || Value[8] != TEXT('-') || Value[13] != TEXT('-')
		|| Value[18] != TEXT('-') || Value[23] != TEXT('-') || Value[14] != TEXT('4')
		|| !FString(TEXT("89ab")).Contains(FString::Chr(Value[19])))
	{
		return false;
	}
	for (int32 Index = 0; Index < Value.Len(); ++Index)
	{
		if (Index == 8 || Index == 13 || Index == 18 || Index == 23)
		{
			continue;
		}
		if (!IsLowerHex(Value[Index]))
		{
			return false;
		}
	}
	return true;
}

bool HasCompilationErrors(const UNiagaraSystem& System)
{
	bool bHasCompilationErrors = false;
	System.ForEachScript(
		[&bHasCompilationErrors](UNiagaraScript* Script)
		{
			bHasCompilationErrors |= Script
				&& Script->GetLastCompileStatus() == ENiagaraScriptCompileStatus::NCS_Error;
		});
	return bHasCompilationErrors;
}

bool ReadIntegerOverride(
	const TSharedPtr<FJsonObject>& Settings,
	const TCHAR* Field,
	int32& Value,
	FString& OutError)
{
	double Number = 0.0;
	if (!Settings->TryGetNumberField(Field, Number))
	{
		return true;
	}
	if (!FMath::IsFinite(Number) || Number != FMath::RoundToDouble(Number)
		|| Number < static_cast<double>(MIN_int32) || Number > static_cast<double>(MAX_int32))
	{
		OutError = FString::Printf(TEXT("Setting %s must be an integer."), Field);
		return false;
	}
	Value = static_cast<int32>(Number);
	return true;
}

bool ReadFloatOverride(
	const TSharedPtr<FJsonObject>& Settings,
	const TCHAR* Field,
	float& Value,
	FString& OutError)
{
	double Number = 0.0;
	if (!Settings->TryGetNumberField(Field, Number))
	{
		return true;
	}
	if (!FMath::IsFinite(Number) || Number < -static_cast<double>(MAX_flt)
		|| Number > static_cast<double>(MAX_flt))
	{
		OutError = FString::Printf(TEXT("Setting %s must be a finite number."), Field);
		return false;
	}
	Value = static_cast<float>(Number);
	return true;
}

void ApplySavedBakerDefaults(
	const UNiagaraBakerSettings& Settings,
	FUEShedNiagaraPreviewOptions& Options)
{
	Options.StartSeconds = Settings.StartSeconds;
	Options.DurationSeconds = Settings.DurationSeconds;
	Options.SimulationFramesPerSecond = Settings.FramesPerSecond;
	Options.FrameCount = Settings.FramesPerDimension.X * Settings.FramesPerDimension.Y;

	for (UNiagaraBakerOutput* Output : Settings.Outputs)
	{
		if (const UNiagaraBakerOutputTexture2D* TextureOutput =
				Cast<UNiagaraBakerOutputTexture2D>(Output))
		{
			Options.Width = TextureOutput->FrameSize.X;
			Options.Height = TextureOutput->FrameSize.Y;
			break;
		}
	}
}

bool ApplyRequestSettings(
	const TSharedPtr<FJsonObject>& Settings,
	FUEShedNiagaraPreviewOptions& Options,
	FString& OutError)
{
	if (!ReadIntegerOverride(Settings, TEXT("width"), Options.Width, OutError)
		|| !ReadIntegerOverride(Settings, TEXT("height"), Options.Height, OutError)
		|| !ReadIntegerOverride(Settings, TEXT("frameCount"), Options.FrameCount, OutError)
		|| !ReadIntegerOverride(
			Settings,
			TEXT("simulationFramesPerSecond"),
			Options.SimulationFramesPerSecond,
			OutError)
		|| !ReadFloatOverride(Settings, TEXT("startSeconds"), Options.StartSeconds, OutError)
		|| !ReadFloatOverride(
			Settings, TEXT("durationSeconds"), Options.DurationSeconds, OutError))
	{
		return false;
	}

	FString CaptureMode;
	if (Settings->TryGetStringField(TEXT("captureMode"), CaptureMode))
	{
		if (CaptureMode == TEXT("component_only"))
		{
			Options.bRenderComponentOnly = true;
		}
		else if (CaptureMode == TEXT("full_scene"))
		{
			Options.bRenderComponentOnly = false;
		}
		else
		{
			OutError = TEXT("captureMode must be component_only or full_scene.");
			return false;
		}
	}

	if (Options.Width < 1 || Options.Width > MaximumDimension || Options.Height < 1
		|| Options.Height > MaximumDimension)
	{
		OutError = FString::Printf(
			TEXT("Width and height must each be between 1 and %d."), MaximumDimension);
		return false;
	}
	if (Options.FrameCount < 1 || Options.FrameCount > MaximumFrames)
	{
		OutError =
			FString::Printf(TEXT("Frame count must be between 1 and %d."), MaximumFrames);
		return false;
	}
	const int64 TotalPixels = static_cast<int64>(Options.Width)
		* static_cast<int64>(Options.Height) * static_cast<int64>(Options.FrameCount);
	if (TotalPixels > MaximumTotalPixels)
	{
		OutError = FString::Printf(
			TEXT("The preview exceeds the v1 budget of %lld total pixels."),
			MaximumTotalPixels);
		return false;
	}
	if (Options.StartSeconds < 0.0f || Options.StartSeconds > MaximumStartSeconds)
	{
		OutError = TEXT("Start time must be between 0 and 3600 seconds.");
		return false;
	}
	if (Options.DurationSeconds < 0.001f
		|| Options.DurationSeconds > MaximumDurationSeconds)
	{
		OutError = TEXT("Duration must be between 0.001 and 600 seconds.");
		return false;
	}
	if (Options.SimulationFramesPerSecond < 1
		|| Options.SimulationFramesPerSecond > MaximumSimulationFramesPerSecond)
	{
		OutError = TEXT("Simulation rate must be between 1 and 480 frames per second.");
		return false;
	}
	return true;
}

bool ReadRequest(
	const FString& RequestPath,
	FUEShedNiagaraPreviewOptions& Options,
	FString& OutError)
{
	FString RequestText;
	if (!FFileHelper::LoadFileToString(RequestText, *RequestPath))
	{
		OutError = FString::Printf(TEXT("Could not read request '%s'."), *RequestPath);
		return false;
	}
	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		OutError = TEXT("The request is not a JSON object.");
		return false;
	}

	const TSharedPtr<FJsonObject>* Contract = nullptr;
	const TSharedPtr<FJsonObject>* Version = nullptr;
	FString ContractName;
	double Major = 0.0;
	double Minor = 0.0;
	if (!Root->TryGetObjectField(TEXT("contract"), Contract) || !Contract || !Contract->IsValid()
		|| !(*Contract)->TryGetStringField(TEXT("name"), ContractName)
		|| ContractName != TEXT("ue-shed-niagara-preview-request")
		|| !(*Contract)->TryGetObjectField(TEXT("version"), Version) || !Version
		|| !Version->IsValid() || !(*Version)->TryGetNumberField(TEXT("major"), Major)
		|| !(*Version)->TryGetNumberField(TEXT("minor"), Minor) || Major != 1.0 || Minor != 0.0)
	{
		OutError = TEXT("The request contract must be ue-shed-niagara-preview-request 1.0.");
		return false;
	}

	if (!Root->TryGetStringField(TEXT("runId"), Options.RunId) || !IsRunId(Options.RunId))
	{
		OutError = TEXT("The request runId must be a lowercase UUID v4.");
		return false;
	}
	if (!Root->TryGetStringField(TEXT("systemObjectPath"), Options.SystemObjectPath)
		|| !FPackageName::IsValidObjectPath(Options.SystemObjectPath)
		|| Options.SystemObjectPath.Len() > 1024)
	{
		OutError = TEXT("The request systemObjectPath must identify one mounted Unreal object.");
		return false;
	}
	const TSharedPtr<FJsonObject>* Settings = nullptr;
	if (!Root->TryGetObjectField(TEXT("settings"), Settings) || !Settings
		|| !Settings->IsValid())
	{
		OutError = TEXT("The request settings must be a JSON object.");
		return false;
	}
	Options.RequestedSettings = *Settings;
	return true;
}
}

UUEShedNiagaraPreviewCommandlet::UUEShedNiagaraPreviewCommandlet()
{
	IsClient = true;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
	ShowErrorCount = true;
}

int32 UUEShedNiagaraPreviewCommandlet::Main(const FString& Params)
{
	using namespace UEShedNiagaraPreviewCommandletPrivate;

	if (!IsAllowCommandletRendering())
	{
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("-AllowCommandletRendering is required."));
		return ExitRenderingUnavailable;
	}

	FString RequestArgument;
	if (!FParse::Value(*Params, TEXT("Request="), RequestArgument)
		|| RequestArgument.IsEmpty())
	{
		UE_LOG(
			LogUEShedNiagaraPreview,
			Error,
			TEXT("Usage: -run=UEShedNiagaraPreview -Request=<json> -AllowCommandletRendering"));
		return ExitInvalidRequest;
	}
	const FString RequestPath = FPaths::ConvertRelativePathToFull(RequestArgument);
	FUEShedNiagaraPreviewOptions Options;
	FString Error;
	if (!ReadRequest(RequestPath, Options, Error))
	{
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Invalid request: %s"), *Error);
		return ExitInvalidRequest;
	}

	UNiagaraSystem* System = LoadObject<UNiagaraSystem>(nullptr, *Options.SystemObjectPath);
	if (!System)
	{
		UE_LOG(
			LogUEShedNiagaraPreview,
			Error,
			TEXT("Failed to load Niagara System '%s'."),
			*Options.SystemObjectPath);
		return ExitSystemUnavailable;
	}
	UNiagaraBakerSettings* BakerSettings = System->GetBakerSettings();
	if (!BakerSettings || BakerSettings->CameraSettings.IsEmpty())
	{
		UE_LOG(
			LogUEShedNiagaraPreview,
			Error,
			TEXT("Niagara System '%s' has no valid saved Baker camera."),
			*Options.SystemObjectPath);
		return ExitBakerCameraMissing;
	}
	System->WaitForCompilationComplete(true, false);
	if (HasCompilationErrors(*System))
	{
		UE_LOG(
			LogUEShedNiagaraPreview,
			Error,
			TEXT("Niagara System '%s' failed to compile into a runnable state."),
			*Options.SystemObjectPath);
		return ExitCompilationFailed;
	}
	ApplySavedBakerDefaults(*BakerSettings, Options);
	if (!ApplyRequestSettings(Options.RequestedSettings, Options, Error))
	{
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Invalid settings: %s"), *Error);
		return ExitInvalidRequest;
	}

	Options.OutputDirectory = FPaths::Combine(
		FPaths::ProjectSavedDir(),
		TEXT("UEShed"),
		TEXT("NiagaraPreviewStaging"),
		Options.RunId);
	FPaths::NormalizeDirectoryName(Options.OutputDirectory);
	if (IFileManager::Get().DirectoryExists(*Options.OutputDirectory))
	{
		UE_LOG(
			LogUEShedNiagaraPreview,
			Error,
			TEXT("Run staging already exists: %s"),
			*Options.OutputDirectory);
		return ExitCaptureFailed;
	}
	const FString FramesDirectory = FPaths::Combine(Options.OutputDirectory, TEXT("frames"));
	if (!IFileManager::Get().MakeDirectory(*FramesDirectory, true))
	{
		UE_LOG(
			LogUEShedNiagaraPreview,
			Error,
			TEXT("Failed to create contained staging: %s"),
			*FramesDirectory);
		return ExitCaptureFailed;
	}

	UE_LOG(
		LogUEShedNiagaraPreview,
		Display,
		TEXT("Capturing %s: %dx%d, %d frames, %.3f seconds, simulation %d FPS"),
		*System->GetPathName(),
		Options.Width,
		Options.Height,
		Options.FrameCount,
		Options.DurationSeconds,
		Options.SimulationFramesPerSecond);

	FUEShedNiagaraCapture Capture;
	if (!Capture.Initialize(System, Options, Error))
	{
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Initialization failed: %s"), *Error);
		return ExitCaptureFailed;
	}

	const float FrameIntervalSeconds =
		Options.DurationSeconds / static_cast<float>(Options.FrameCount);
	TArray<FUEShedNiagaraPreviewFrame> Frames;
	Frames.Reserve(Options.FrameCount);
	for (int32 FrameIndex = 0; FrameIndex < Options.FrameCount; ++FrameIndex)
	{
		const float AbsoluteTime = Options.StartSeconds + FrameIndex * FrameIntervalSeconds;
		FUEShedNiagaraPreviewFrame Frame;
		Frame.RelativePath = FString::Printf(TEXT("frames/frame_%04d.png"), FrameIndex);
		const FString FramePath = FPaths::Combine(Options.OutputDirectory, Frame.RelativePath);
		if (!Capture.CaptureFrame(FrameIndex, AbsoluteTime, FramePath, Frame, Error))
		{
			UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Capture failed: %s"), *Error);
			return ExitCaptureFailed;
		}
		Frames.Add(MoveTemp(Frame));
	}

	Capture.FlushPendingWork();
	const FString ReceiptPath =
		FPaths::Combine(Options.OutputDirectory, TEXT("producer-receipt.json"));
	if (!Capture.WriteProducerReceipt(ReceiptPath, Frames, Error))
	{
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Receipt failed: %s"), *Error);
		return ExitCaptureFailed;
	}

	UE_LOG(
		LogUEShedNiagaraPreview,
		Display,
		TEXT("Niagara preview staged for run %s"),
		*Options.RunId);
	return 0;
}
