#include "UEShedNiagaraPreviewCommandlet.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "UObject/GarbageCollection.h"
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
FString SessionCancelPath;
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
	return (Character >= TEXT('0') && Character <= TEXT('9')) ||
		   (Character >= TEXT('a') && Character <= TEXT('f'));
}

bool IsRunId(const FString& Value)
{
	if (Value.Len() != 36 || Value[8] != TEXT('-') || Value[13] != TEXT('-') ||
		Value[18] != TEXT('-') || Value[23] != TEXT('-') || Value[14] != TEXT('4') ||
		!FString(TEXT("89ab")).Contains(FString::Chr(Value[19])))
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
			bHasCompilationErrors |=
				Script && Script->GetLastCompileStatus() == ENiagaraScriptCompileStatus::NCS_Error;
		});
	return bHasCompilationErrors;
}

bool ReadIntegerOverride(const TSharedPtr<FJsonObject>& Settings, const TCHAR* Field, int32& Value,
						 FString& OutError)
{
	double Number = 0.0;
	if (!Settings->TryGetNumberField(Field, Number))
	{
		if (!Settings->HasField(Field))
			return true;
		OutError = FString::Printf(TEXT("Setting %s must be numeric."), Field);
		return false;
	}
	if (!FMath::IsFinite(Number) || Number != FMath::RoundToDouble(Number) ||
		Number < static_cast<double>(MIN_int32) || Number > static_cast<double>(MAX_int32))
	{
		OutError = FString::Printf(TEXT("Setting %s must be an integer."), Field);
		return false;
	}
	Value = static_cast<int32>(Number);
	return true;
}

bool ReadFloatOverride(const TSharedPtr<FJsonObject>& Settings, const TCHAR* Field, float& Value,
					   FString& OutError)
{
	double Number = 0.0;
	if (!Settings->TryGetNumberField(Field, Number))
	{
		if (!Settings->HasField(Field))
			return true;
		OutError = FString::Printf(TEXT("Setting %s must be numeric."), Field);
		return false;
	}
	if (!FMath::IsFinite(Number) || Number < -static_cast<double>(MAX_flt) ||
		Number > static_cast<double>(MAX_flt))
	{
		OutError = FString::Printf(TEXT("Setting %s must be a finite number."), Field);
		return false;
	}
	Value = static_cast<float>(Number);
	return true;
}

void ApplySavedBakerDefaults(const UNiagaraBakerSettings& Settings,
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

bool ApplyRequestSettings(const TSharedPtr<FJsonObject>& Settings,
						  FUEShedNiagaraPreviewOptions& Options, FString& OutError)
{
	const TPair<const TCHAR*, FString*> EnumFields[] = {
		{TEXT("background"), &Options.Background},
		{TEXT("renderMode"), &Options.RenderMode},
		{TEXT("cameraMode"), &Options.CameraMode},
		{TEXT("sceneProfile"), &Options.SceneProfile}};
	for (const auto& Field : EnumFields)
	{
		if (Settings->HasField(Field.Key) && !Settings->TryGetStringField(Field.Key, *Field.Value))
		{
			OutError = TEXT("Preview mode settings must be strings.");
			return false;
		}
	}
	if ((Options.Background != TEXT("default") && Options.Background != TEXT("dark") &&
		 Options.Background != TEXT("light")) ||
		(Options.RenderMode != TEXT("transparent") && Options.RenderMode != TEXT("scene")) ||
		(Options.CameraMode != TEXT("saved") && Options.CameraMode != TEXT("auto_fit")) ||
		(Options.SceneProfile != TEXT("ground_impact") &&
		 Options.SceneProfile != TEXT("projectile") && Options.SceneProfile != TEXT("aura") &&
		 Options.SceneProfile != TEXT("environment")))
	{
		OutError = TEXT("Unknown background, renderMode, cameraMode, or sceneProfile.");
		return false;
	}
	if (Options.Background != TEXT("default") && Options.RenderMode != TEXT("scene"))
	{
		OutError = TEXT("Plain backgrounds require scene rendering.");
		return false;
	}
	if (Settings->HasField(TEXT("cameraOverride")))
	{
		const TSharedPtr<FJsonObject>* Camera = nullptr;
		double Fov = 0;
		if (!Settings->TryGetObjectField(TEXT("cameraOverride"), Camera) ||
			!(*Camera)->TryGetNumberField(TEXT("fieldOfViewDegrees"), Fov) ||
			!FMath::IsFinite(Fov) || Fov < 1 || Fov > 179)
		{
			OutError =
				TEXT("cameraOverride requires a perspective fieldOfViewDegrees between 1 and 179.");
			return false;
		}
		for (const TCHAR* Group : {TEXT("location"), TEXT("rotation")})
		{
			const TSharedPtr<FJsonObject>* Value = nullptr;
			if (!(*Camera)->TryGetObjectField(Group, Value))
			{
				OutError = TEXT("cameraOverride requires location and rotation.");
				return false;
			}
			const TArray<FString> Keys =
				FString(Group) == TEXT("location")
					? TArray<FString>{TEXT("x"), TEXT("y"), TEXT("z")}
					: TArray<FString>{TEXT("pitch"), TEXT("yaw"), TEXT("roll")};
			for (const FString& Key : Keys)
			{
				double Number = 0;
				if (!(*Value)->TryGetNumberField(Key, Number) || !FMath::IsFinite(Number) ||
					FMath::Abs(Number) > 1.e12)
				{
					OutError =
						TEXT("cameraOverride coordinates must be finite and within +/-1e12.");
					return false;
				}
			}
		}
		Options.CameraOverride = *Camera;
	}
	if (!ReadFloatOverride(Settings, TEXT("exposureCompensation"), Options.ExposureCompensation,
						   OutError) ||
		!ReadFloatOverride(Settings, TEXT("cameraPadding"), Options.CameraPadding, OutError) ||
		Options.ExposureCompensation < -8 || Options.ExposureCompensation > 8 ||
		Options.CameraPadding < 1.05f || Options.CameraPadding > 3.0f)
	{
		OutError =
			TEXT("Exposure must be between -8 and 8 stops; camera padding between 1.05 and 3.");
		return false;
	}
	if (!ReadIntegerOverride(Settings, TEXT("width"), Options.Width, OutError) ||
		!ReadIntegerOverride(Settings, TEXT("height"), Options.Height, OutError) ||
		!ReadIntegerOverride(Settings, TEXT("frameCount"), Options.FrameCount, OutError) ||
		!ReadIntegerOverride(Settings, TEXT("simulationFramesPerSecond"),
							 Options.SimulationFramesPerSecond, OutError) ||
		!ReadFloatOverride(Settings, TEXT("startSeconds"), Options.StartSeconds, OutError) ||
		!ReadFloatOverride(Settings, TEXT("durationSeconds"), Options.DurationSeconds, OutError))
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

	if (Options.RenderMode == TEXT("scene"))
	{
		if (CaptureMode == TEXT("component_only"))
		{
			OutError = TEXT("Scene previews require full_scene capture mode.");
			return false;
		}
		Options.bRenderComponentOnly = false;
	}
	if (Options.Width < 1 || Options.Width > MaximumDimension || Options.Height < 1 ||
		Options.Height > MaximumDimension)
	{
		OutError = FString::Printf(TEXT("Width and height must each be between 1 and %d."),
								   MaximumDimension);
		return false;
	}
	if (Options.FrameCount < 1 || Options.FrameCount > MaximumFrames)
	{
		OutError = FString::Printf(TEXT("Frame count must be between 1 and %d."), MaximumFrames);
		return false;
	}
	const int64 TotalPixels = static_cast<int64>(Options.Width) *
							  static_cast<int64>(Options.Height) *
							  static_cast<int64>(Options.FrameCount);
	if (TotalPixels > MaximumTotalPixels)
	{
		OutError = FString::Printf(TEXT("The preview exceeds the v1 budget of %lld total pixels."),
								   MaximumTotalPixels);
		return false;
	}
	if (Options.StartSeconds < 0.0f || Options.StartSeconds > MaximumStartSeconds)
	{
		OutError = TEXT("Start time must be between 0 and 3600 seconds.");
		return false;
	}
	if (Options.DurationSeconds < 0.001f || Options.DurationSeconds > MaximumDurationSeconds)
	{
		OutError = TEXT("Duration must be between 0.001 and 600 seconds.");
		return false;
	}
	if (Options.SimulationFramesPerSecond < 1 ||
		Options.SimulationFramesPerSecond > MaximumSimulationFramesPerSecond)
	{
		OutError = TEXT("Simulation rate must be between 1 and 480 frames per second.");
		return false;
	}
	return true;
}

bool ReadRequest(const FString& RequestPath, FUEShedNiagaraPreviewOptions& Options,
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
	if (!Root->TryGetObjectField(TEXT("contract"), Contract) || !Contract || !Contract->IsValid() ||
		!(*Contract)->TryGetStringField(TEXT("name"), ContractName) ||
		ContractName != TEXT("ue-shed-niagara-preview-request") ||
		!(*Contract)->TryGetObjectField(TEXT("version"), Version) || !Version ||
		!Version->IsValid() || !(*Version)->TryGetNumberField(TEXT("major"), Major) ||
		!(*Version)->TryGetNumberField(TEXT("minor"), Minor) || Major != 1.0 ||
		(Minor != 0.0 && Minor != 1.0 && Minor != 2.0))
	{
		OutError =
			TEXT("The request contract must be ue-shed-niagara-preview-request 1.0, 1.1, or 1.2.");
		return false;
	}

	if (!Root->TryGetStringField(TEXT("runId"), Options.RunId) || !IsRunId(Options.RunId))
	{
		OutError = TEXT("The request runId must be a lowercase UUID v4.");
		return false;
	}
	if (!Root->TryGetStringField(TEXT("systemObjectPath"), Options.SystemObjectPath) ||
		!FPackageName::IsValidObjectPath(Options.SystemObjectPath) ||
		Options.SystemObjectPath.Len() > 1024)
	{
		OutError = TEXT("The request systemObjectPath must identify one mounted Unreal object.");
		return false;
	}
	const TSharedPtr<FJsonObject>* Settings = nullptr;
	if (!Root->TryGetObjectField(TEXT("settings"), Settings) || !Settings || !Settings->IsValid())
	{
		OutError = TEXT("The request settings must be a JSON object.");
		return false;
	}
	Options.RequestedSettings = *Settings;
	return true;
}
} // namespace UEShedNiagaraPreviewCommandletPrivate

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

	FString SessionArgument;
	if (FParse::Value(*Params, TEXT("Session="), SessionArgument))
	{
		return RunSession(FPaths::ConvertRelativePathToFull(SessionArgument));
	}
	FString RequestArgument;
	if (!FParse::Value(*Params, TEXT("Request="), RequestArgument) || RequestArgument.IsEmpty())
	{
		UE_LOG(LogUEShedNiagaraPreview, Error,
			   TEXT("Usage: -run=UEShedNiagaraPreview -Request=<json> -AllowCommandletRendering"));
		return ExitInvalidRequest;
	}
	return CaptureRequest(FPaths::ConvertRelativePathToFull(RequestArgument));
}

int32 UUEShedNiagaraPreviewCommandlet::CaptureRequest(const FString& RequestPath)
{
	using namespace UEShedNiagaraPreviewCommandletPrivate;
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
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Failed to load Niagara System '%s'."),
			   *Options.SystemObjectPath);
		return ExitSystemUnavailable;
	}
	UNiagaraBakerSettings* BakerSettings = System->GetBakerSettings();
	if (!BakerSettings || BakerSettings->CameraSettings.IsEmpty())
	{
		UE_LOG(LogUEShedNiagaraPreview, Error,
			   TEXT("Niagara System '%s' has no valid saved Baker camera."),
			   *Options.SystemObjectPath);
		return ExitBakerCameraMissing;
	}
	System->WaitForCompilationComplete(true, false);
	if (HasCompilationErrors(*System))
	{
		UE_LOG(LogUEShedNiagaraPreview, Error,
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

	Options.OutputDirectory = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEShed"),
											  TEXT("NiagaraPreviewStaging"), Options.RunId);
	FPaths::NormalizeDirectoryName(Options.OutputDirectory);
	if (IFileManager::Get().DirectoryExists(*Options.OutputDirectory))
	{
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Run staging already exists: %s"),
			   *Options.OutputDirectory);
		return ExitCaptureFailed;
	}
	const FString FramesDirectory = FPaths::Combine(Options.OutputDirectory, TEXT("frames"));
	if (!IFileManager::Get().MakeDirectory(*FramesDirectory, true))
	{
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Failed to create contained staging: %s"),
			   *FramesDirectory);
		return ExitCaptureFailed;
	}

	UE_LOG(LogUEShedNiagaraPreview, Display,
		   TEXT("Capturing %s: %dx%d, %d frames, %.3f seconds, simulation %d FPS"),
		   *System->GetPathName(), Options.Width, Options.Height, Options.FrameCount,
		   Options.DurationSeconds, Options.SimulationFramesPerSecond);

	const double ProgressStarted = FPlatformTime::Seconds();
 Options.OnProgress = [&](const TCHAR* Phase, int32 Completed) {
  auto Progress = MakeShared<FJsonObject>();
  Progress->SetNumberField(TEXT("schemaVersion"), 1);
  Progress->SetStringField(TEXT("runId"), Options.RunId);
  Progress->SetStringField(TEXT("phase"), Phase);
  Progress->SetNumberField(TEXT("completedFrames"), Completed);
  Progress->SetNumberField(TEXT("totalFrames"), Options.FrameCount);
  Progress->SetNumberField(TEXT("elapsedMs"), (FPlatformTime::Seconds() - ProgressStarted) * 1000);
  FString Text; FJsonSerializer::Serialize(Progress, TJsonWriterFactory<>::Create(&Text));
  const FString Path = FPaths::Combine(Options.OutputDirectory, TEXT("progress.json"));
  if (FFileHelper::SaveStringToFile(Text, *(Path + TEXT(".tmp")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
   IFileManager::Get().Move(*Path, *(Path + TEXT(".tmp")), true, true);
 };
 Options.OnProgress(TEXT("initializing"), 0);
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
		if (!SessionCancelPath.IsEmpty() && IFileManager::Get().FileExists(*SessionCancelPath))
		{
			return ExitCaptureFailed;
		}
		Options.OnProgress(TEXT("capturing"), FrameIndex);
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

	Options.OnProgress(TEXT("writing_receipt"), Frames.Num());
	Capture.FlushPendingWork();
	const FString ReceiptPath =
		FPaths::Combine(Options.OutputDirectory, TEXT("producer-receipt.json"));
	if (!Capture.WriteProducerReceipt(ReceiptPath, Frames, Error))
	{
		UE_LOG(LogUEShedNiagaraPreview, Error, TEXT("Receipt failed: %s"), *Error);
		return ExitCaptureFailed;
	}

	Options.OnProgress(TEXT("completed"), Frames.Num());
	UE_LOG(LogUEShedNiagaraPreview, Display, TEXT("Niagara preview staged for run %s"),
		   *Options.RunId);
	return 0;
}

// One host-owned process, sequential requests, isolated capture scenes and bounded lifetime.
int32 UUEShedNiagaraPreviewCommandlet::RunSession(const FString& Directory)
{
    using namespace UEShedNiagaraPreviewCommandletPrivate;
    if (!IFileManager::Get().DirectoryExists(*Directory)) return ExitInvalidRequest;
    const FString ReadyPath = FPaths::Combine(Directory, TEXT("ready.json"));
    const FString ReadyTemporary = ReadyPath + TEXT(".tmp");
    if (!FFileHelper::SaveStringToFile(TEXT("{\"protocol\":\"ue-shed-niagara-session.v1\"}"), *ReadyTemporary) ||
        !IFileManager::Get().Move(*ReadyPath, *ReadyTemporary, false, true)) return ExitInvalidRequest;
    double LastWork = FPlatformTime::Seconds();
    int32 Completed = 0;
    while (!IsEngineExitRequested() && Completed < 300 && FPlatformTime::Seconds() - LastWork < 900.0)
    {
        if (IFileManager::Get().FileExists(*FPaths::Combine(Directory, TEXT("stop")))) break;
        TArray<FString> Requests;
        IFileManager::Get().FindFiles(Requests, *FPaths::Combine(Directory, TEXT("*.request.json")), true, false);
        Requests.Sort();
        for (const FString& Filename : Requests)
        {
            const FString Id = Filename.LeftChop(13);
            if (!IsRunId(Id)) continue;
            const FString ResultPath = FPaths::Combine(Directory, Id + TEXT(".result.json"));
            if (IFileManager::Get().FileExists(*ResultPath)) continue;
            const FString RequestPath = FPaths::Combine(Directory, Filename);
            FUEShedNiagaraPreviewOptions Parsed;
            FString Error;
            SessionCancelPath = FPaths::Combine(Directory, Id + TEXT(".cancel"));
            int32 Code = ExitInvalidRequest;
            if (ReadRequest(RequestPath, Parsed, Error) && Parsed.RunId == Id &&
                !IFileManager::Get().FileExists(*SessionCancelPath))
            {
                Code = CaptureRequest(RequestPath);
            }
            SessionCancelPath.Reset();
            CollectGarbage(RF_NoFlags);
            const FString Result = FString::Printf(TEXT("{\"protocol\":\"ue-shed-niagara-session.v1\",\"runId\":\"%s\",\"exitCode\":%d}"), *Id, Code);
            const FString Temporary = ResultPath + TEXT(".tmp");
            if (!FFileHelper::SaveStringToFile(Result, *Temporary) ||
                !IFileManager::Get().Move(*ResultPath, *Temporary, false, true)) return ExitCaptureFailed;
            ++Completed;
            LastWork = FPlatformTime::Seconds();
            if (Completed >= 300) break;
        }
        FPlatformProcess::Sleep(0.05f);
    }
    IFileManager::Get().Delete(*ReadyPath);
    return 0;
}
