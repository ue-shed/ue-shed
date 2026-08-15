#include "UEShedCameraReviewLibrary.h"
#include "UEShedTransientCapture.h"

#include "Async/Async.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "EditorViewportClient.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "HighResScreenshot.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UnrealClient.h"
#include "WorldPartition/WorldPartition.h"

namespace
{
constexpr int32 MaximumPendingTileEncodes = 4;
constexpr int32 MaximumPendingTileReadbacks = 1;
constexpr int32 FullFidelityWarmupCaptures = 2;
constexpr int32 SeamStableRenderScale = 2;

struct FPendingMapTileEncode
{
	FPendingMapTileEncode(
		const TSharedRef<FJsonObject>& InResult,
		FString InPath,
		double InStartedSeconds,
		TFuture<bool>&& InWritten)
		: Result(InResult)
		, Path(MoveTemp(InPath))
		, StartedSeconds(InStartedSeconds)
		, Written(MoveTemp(InWritten))
	{
	}

	TSharedRef<FJsonObject> Result;
	FString Path;
	double StartedSeconds;
	TFuture<bool> Written;
};

struct FPendingMapTileReadback
{
	FPendingMapTileReadback(
		FUEShedTransientCapture* InCapture,
		const TSharedRef<FJsonObject>& InResult,
		FString InPath,
		double InStartedSeconds,
		const FIntRect& InCrop,
		int32 InOutputSize)
		: Capture(InCapture)
		, Result(InResult)
		, Path(MoveTemp(InPath))
		, StartedSeconds(InStartedSeconds)
		, Crop(InCrop)
		, OutputSize(InOutputSize)
	{
	}

	FUEShedTransientCapture* Capture;
	TSharedRef<FJsonObject> Result;
	FString Path;
	double StartedSeconds;
	FIntRect Crop;
	int32 OutputSize;
};

FString MapTileJsonString(const TSharedRef<FJsonObject>& Object)
{
	FString Result;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Result);
	FJsonSerializer::Serialize(Object, Writer);
	return Result;
}

TSharedRef<FJsonObject> MapTileContract()
{
	const TSharedRef<FJsonObject> Contract = MakeShared<FJsonObject>();
	Contract->SetStringField(TEXT("name"), TEXT("ue-shed-map-tile-capture"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Contract->SetObjectField(TEXT("version"), Version);
	return Contract;
}

TSharedRef<FJsonObject> MapTileFailure(
	const TCHAR* Code,
	const TCHAR* Message,
	const TCHAR* Recovery,
	bool bRetrySafe)
{
	const TSharedRef<FJsonObject> Failure = MakeShared<FJsonObject>();
	Failure->SetStringField(TEXT("code"), Code);
	Failure->SetStringField(TEXT("message"), Message);
	Failure->SetStringField(TEXT("recovery"), Recovery);
	Failure->SetBoolField(TEXT("retrySafe"), bRetrySafe);
	return Failure;
}

bool IsMapTileSafeIdentifier(const FString& Value)
{
	if (Value.IsEmpty() || Value.Len() > 128 || !FChar::IsAlnum(Value[0])) return false;
	for (const TCHAR Character : Value)
	{
		if (!FChar::IsAlnum(Character)
			&& Character != TEXT('-')
			&& Character != TEXT('_')
			&& Character != TEXT('.'))
		{
			return false;
		}
	}
	return true;
}

TSharedRef<FJsonObject> MapTileKeyJson(int32 Zoom, int32 Row, int32 Column)
{
	const TSharedRef<FJsonObject> Key = MakeShared<FJsonObject>();
	Key->SetNumberField(TEXT("zoom"), Zoom);
	Key->SetNumberField(TEXT("row"), Row);
	Key->SetNumberField(TEXT("column"), Column);
	return Key;
}

void SetMapTileCounts(
	const TSharedRef<FJsonObject>& Result,
	int32 Requested,
	int32 Succeeded,
	int32 Failed)
{
	const TSharedRef<FJsonObject> Counts = MakeShared<FJsonObject>();
	Counts->SetNumberField(TEXT("requested"), Requested);
	Counts->SetNumberField(TEXT("succeeded"), Succeeded);
	Counts->SetNumberField(TEXT("failed"), Failed);
	Result->SetObjectField(TEXT("tileCounts"), Counts);
}

TSharedRef<FJsonObject> MapTileResponseBase(
	const FString& OperationId,
	const FString& CorrelationId,
	bool bDirtyBefore,
	bool bDirtyAfter,
	double DurationMs)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("contract"), MapTileContract());
	Result->SetStringField(TEXT("operationId"), OperationId);
	Result->SetStringField(TEXT("correlationId"), CorrelationId);
	const TSharedRef<FJsonObject> DirtyState = MakeShared<FJsonObject>();
	DirtyState->SetBoolField(TEXT("before"), bDirtyBefore);
	DirtyState->SetBoolField(TEXT("after"), bDirtyAfter);
	Result->SetObjectField(TEXT("dirtyState"), DirtyState);
	Result->SetNumberField(TEXT("durationMs"), DurationMs);
	return Result;
}

void MapTileTopFailure(
	FString& ResultJson,
	const FString& OperationId,
	const FString& CorrelationId,
	const TCHAR* Code,
	const TCHAR* Message,
	const TCHAR* Recovery,
	bool bRetrySafe,
	bool bDirtyBefore = false,
	bool bDirtyAfter = false)
{
	const TSharedRef<FJsonObject> Result = MapTileResponseBase(
		OperationId, CorrelationId, bDirtyBefore, bDirtyAfter, 0.0);
	Result->SetStringField(TEXT("status"), TEXT("failed"));
	Result->SetObjectField(
		TEXT("failure"), MapTileFailure(Code, Message, Recovery, bRetrySafe));
	Result->SetArrayField(TEXT("results"), {});
	SetMapTileCounts(Result, 0, 0, 0);
	ResultJson = MapTileJsonString(Result);
}

bool ReadInteger(
	const TSharedPtr<FJsonObject>& Object,
	const TCHAR* Field,
	int32& OutValue)
{
	double Value;
	if (!Object->TryGetNumberField(Field, Value)
		|| Value != FMath::FloorToDouble(Value)
		|| Value < MIN_int32
		|| Value > MAX_int32)
	{
		return false;
	}
	OutValue = static_cast<int32>(Value);
	return true;
}

struct FViewportHighResolutionTile
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	int32 Zoom = 0;
	int32 Row = 0;
	int32 Column = 0;
	double MinX = 0.0;
	double MinY = 0.0;
	double MaxX = 0.0;
	double MaxY = 0.0;
};

struct FScopedViewportHighResolutionState
{
	explicit FScopedViewportHighResolutionState(FLevelEditorViewportClient& InClient)
		: Client(InClient)
		, ViewportType(InClient.GetViewportType())
		, ViewLocation(InClient.GetViewLocation())
		, ViewRotation(InClient.GetViewRotation())
		, ScreenshotConfig(GetHighResScreenshotConfig())
		, ScreenshotResolutionX(GScreenshotResolutionX)
		, ScreenshotResolutionY(GScreenshotResolutionY)
		, bWasHighResolutionScreenshot(GIsHighResScreenshot)
	{
		AlignedOrthoZoom = IConsoleManager::Get().FindConsoleVariable(
			TEXT("r.Editor.AlignedOrthoZoom"));
		DisableFogInOrtho = IConsoleManager::Get().FindConsoleVariable(
			TEXT("r.Editor.DisableFogInOrthoDebugViews"));
		AlignedOrthoZoomValue = AlignedOrthoZoom == nullptr ? 1 : AlignedOrthoZoom->GetInt();
		DisableFogInOrthoValue = DisableFogInOrtho == nullptr ? 1 : DisableFogInOrtho->GetInt();
		if (ViewportType == LVT_Perspective)
		{
			Client.SetViewportType(LVT_OrthoTop);
			OrthographicViewLocation = Client.GetViewLocation();
			OrthographicViewRotation = Client.GetViewRotation();
			OrthographicZoom = Client.GetOrthoZoom();
			Client.SetViewportType(ViewportType);
		}
		else
		{
			OrthographicViewLocation = ViewLocation;
			OrthographicViewRotation = ViewRotation;
			OrthographicZoom = Client.GetOrthoZoom();
		}
	}

	~FScopedViewportHighResolutionState()
	{
		Client.SetViewportType(LVT_OrthoTop);
		Client.SetViewLocation(OrthographicViewLocation);
		Client.SetViewRotation(OrthographicViewRotation);
		Client.SetOrthoZoom(OrthographicZoom);
		Client.SetViewportType(ViewportType);
		Client.SetViewLocation(ViewLocation);
		Client.SetViewRotation(ViewRotation);
		if (bInstalledShowFlagsOverride) Client.DisableOverrideEngineShowFlags();
		GetHighResScreenshotConfig() = ScreenshotConfig;
		GScreenshotResolutionX = ScreenshotResolutionX;
		GScreenshotResolutionY = ScreenshotResolutionY;
		GIsHighResScreenshot = bWasHighResolutionScreenshot;
		if (AlignedOrthoZoom != nullptr)
			AlignedOrthoZoom->Set(AlignedOrthoZoomValue, ECVF_SetByCode);
		if (DisableFogInOrtho != nullptr)
			DisableFogInOrtho->Set(DisableFogInOrthoValue, ECVF_SetByCode);
	}

	FLevelEditorViewportClient& Client;
	ELevelViewportType ViewportType;
	FVector ViewLocation;
	FRotator ViewRotation;
	FVector OrthographicViewLocation;
	FRotator OrthographicViewRotation;
	float OrthographicZoom = 1.0f;
	FHighResScreenshotConfig ScreenshotConfig;
	uint32 ScreenshotResolutionX;
	uint32 ScreenshotResolutionY;
	bool bWasHighResolutionScreenshot;
	IConsoleVariable* AlignedOrthoZoom = nullptr;
	IConsoleVariable* DisableFogInOrtho = nullptr;
	int32 AlignedOrthoZoomValue = 1;
	int32 DisableFogInOrthoValue = 1;
	bool bInstalledShowFlagsOverride = false;
};

bool CaptureViewportHighResolutionLevel(
	const TArray<TSharedPtr<FJsonValue>>& TileValues,
	int32 TilePixelSize,
	int32 GutterPixels,
	double CaptureZ,
	bool bFog,
	bool bVolumetricFog,
	const FString& RenderProfile,
	const FString& RunId,
	TArray<TSharedPtr<FJsonValue>>& OutTileResults,
	int32& OutSucceeded,
	int32& OutFailed,
	FString& OutFailureCode,
	FString& OutFailureMessage,
	FString& OutFailureRecovery)
{
	auto Fail = [&](const TCHAR* Code, const TCHAR* Message, const TCHAR* Recovery)
	{
		OutFailureCode = Code;
		OutFailureMessage = Message;
		OutFailureRecovery = Recovery;
		return false;
	};
	if (GCurrentLevelEditingViewportClient == nullptr
		|| GCurrentLevelEditingViewportClient->Viewport == nullptr)
	{
		return Fail(
			TEXT("capture_failed"),
			TEXT("No active Level Editor viewport is available for High Resolution Screenshot."),
			TEXT("Open a Level Editor viewport for the target map and retry."));
	}
	FLevelEditorViewportClient& Client = *GCurrentLevelEditingViewportClient;
	FViewport* Viewport = Client.Viewport;
	FScopedViewportHighResolutionState SavedState(Client);

	TArray<FViewportHighResolutionTile> Tiles;
	Tiles.Reserve(TileValues.Num());
	int32 Zoom = INDEX_NONE;
	int32 MaximumRow = INDEX_NONE;
	int32 MaximumColumn = INDEX_NONE;
	double UnitsPerPixel = 0.0;
	double FullMinX = TNumericLimits<double>::Max();
	double FullMinY = TNumericLimits<double>::Max();
	double FullMaxX = TNumericLimits<double>::Lowest();
	double FullMaxY = TNumericLimits<double>::Lowest();
	TSet<FString> UniqueKeys;
	for (const TSharedPtr<FJsonValue>& TileValue : TileValues)
	{
		const TSharedPtr<FJsonObject>* TileObject;
		const TSharedPtr<FJsonObject>* Key;
		const TSharedPtr<FJsonObject>* Bounds;
		FViewportHighResolutionTile Tile;
		double TileUnitsPerPixel = 0.0;
		const bool bValid = TileValue.IsValid()
			&& TileValue->TryGetObject(TileObject)
			&& (*TileObject)->TryGetObjectField(TEXT("key"), Key)
			&& ReadInteger(*Key, TEXT("zoom"), Tile.Zoom)
			&& ReadInteger(*Key, TEXT("row"), Tile.Row)
			&& ReadInteger(*Key, TEXT("column"), Tile.Column)
			&& Tile.Zoom >= 0
			&& Tile.Row >= 0
			&& Tile.Column >= 0
			&& (*TileObject)->TryGetNumberField(TEXT("unitsPerPixel"), TileUnitsPerPixel)
			&& FMath::IsFinite(TileUnitsPerPixel)
			&& TileUnitsPerPixel > 0.0
			&& (*TileObject)->TryGetObjectField(TEXT("worldBounds"), Bounds)
			&& (*Bounds)->TryGetNumberField(TEXT("minX"), Tile.MinX)
			&& (*Bounds)->TryGetNumberField(TEXT("minY"), Tile.MinY)
			&& (*Bounds)->TryGetNumberField(TEXT("maxX"), Tile.MaxX)
			&& (*Bounds)->TryGetNumberField(TEXT("maxY"), Tile.MaxY);
		const double ExpectedWorldSize = TilePixelSize * TileUnitsPerPixel;
		const double Tolerance = FMath::Max(0.001, ExpectedWorldSize * UE_DOUBLE_SMALL_NUMBER);
		const FString KeyIdentity = FString::Printf(
			TEXT("%d/%d/%d"), Tile.Zoom, Tile.Row, Tile.Column);
		if (!bValid
			|| (Zoom != INDEX_NONE && Tile.Zoom != Zoom)
			|| (UnitsPerPixel > 0.0
				&& !FMath::IsNearlyEqual(TileUnitsPerPixel, UnitsPerPixel, UE_DOUBLE_SMALL_NUMBER))
			|| UniqueKeys.Contains(KeyIdentity)
			|| !FMath::IsNearlyEqual(Tile.MaxX - Tile.MinX, ExpectedWorldSize, Tolerance)
			|| !FMath::IsNearlyEqual(Tile.MaxY - Tile.MinY, ExpectedWorldSize, Tolerance))
		{
			return Fail(
				TEXT("invalid_request"),
				TEXT("Viewport High Resolution capture requires one valid, uniform zoom level."),
				TEXT("Send every tile from exactly one complete zoom level."));
		}
		Zoom = Tile.Zoom;
		UnitsPerPixel = TileUnitsPerPixel;
		MaximumRow = FMath::Max(MaximumRow, Tile.Row);
		MaximumColumn = FMath::Max(MaximumColumn, Tile.Column);
		FullMinX = FMath::Min(FullMinX, Tile.MinX);
		FullMinY = FMath::Min(FullMinY, Tile.MinY);
		FullMaxX = FMath::Max(FullMaxX, Tile.MaxX);
		FullMaxY = FMath::Max(FullMaxY, Tile.MaxY);
		UniqueKeys.Add(KeyIdentity);
		Tile.Result->SetObjectField(
			TEXT("key"), MapTileKeyJson(Tile.Zoom, Tile.Row, Tile.Column));
		Tiles.Add(MoveTemp(Tile));
	}

	const int32 Rows = MaximumRow + 1;
	const int32 Columns = MaximumColumn + 1;
	if (Rows <= 0 || Columns <= 0 || Rows * Columns != Tiles.Num())
	{
		return Fail(
			TEXT("invalid_request"),
			TEXT("Viewport High Resolution capture requires a complete rectangular zoom level."),
			TEXT("Capture the full zoom, or use the tiled Scene Capture backend for subsets."));
	}
	const double TileWorldSize = TilePixelSize * UnitsPerPixel;
	const double Tolerance = FMath::Max(0.001, TileWorldSize * UE_DOUBLE_SMALL_NUMBER);
	for (const FViewportHighResolutionTile& Tile : Tiles)
	{
		const double ExpectedMinX = FullMaxX - (Tile.Row + 1) * TileWorldSize;
		const double ExpectedMinY = FullMinY + Tile.Column * TileWorldSize;
		if (!FMath::IsNearlyEqual(Tile.MinX, ExpectedMinX, Tolerance)
			|| !FMath::IsNearlyEqual(Tile.MinY, ExpectedMinY, Tolerance))
		{
			return Fail(
				TEXT("invalid_request"),
				TEXT("Viewport High Resolution tile bounds do not form the declared row and column grid."),
				TEXT("Regenerate the request from the deterministic Map Capture grid."));
		}
	}

	const int32 RenderWidth = Columns * TilePixelSize + GutterPixels * 2;
	const int32 RenderHeight = Rows * TilePixelSize + GutterPixels * 2;
	FHighResScreenshotConfig& Config = GetHighResScreenshotConfig();
	if (!Config.SetResolution(RenderWidth, RenderHeight))
	{
		return Fail(
			TEXT("capture_failed"),
			TEXT("The complete zoom exceeds Unreal's maximum High Resolution Screenshot size."),
			TEXT("Reduce tile size or zoom dimensions, or use the tiled Scene Capture backend."));
	}

	if (SavedState.AlignedOrthoZoom != nullptr)
		SavedState.AlignedOrthoZoom->Set(0, ECVF_SetByCode);
	if (SavedState.DisableFogInOrtho != nullptr)
		SavedState.DisableFogInOrtho->Set(0, ECVF_SetByCode);
	Client.SetViewportType(LVT_OrthoTop);
	Client.SetViewLocation(FVector(
		(FullMinX + FullMaxX) * 0.5,
		(FullMinY + FullMaxY) * 0.5,
		CaptureZ));
	Client.SetOrthoZoom(static_cast<float>(
		(FullMaxY - FullMinY + GutterPixels * 2.0 * UnitsPerPixel) * 15.0));
	if (Client.IsEngineShowFlagsOverrideEnabled())
	{
		return Fail(
			TEXT("capture_failed"),
			TEXT("The active Level Editor viewport already owns a temporary show-flag override."),
			TEXT("Finish the current viewport operation and retry the experimental capture."));
	}
	Client.EnableOverrideEngineShowFlags(
		[bFog, bVolumetricFog, RenderProfile](FEngineShowFlags& ShowFlags)
		{
			ShowFlags.SetGrid(false);
			ShowFlags.SetFog(bFog);
			ShowFlags.SetVolumetricFog(bVolumetricFog);
			if (RenderProfile == TEXT("observation"))
			{
				ShowFlags.DisableAdvancedFeatures();
				ShowFlags.SetPostProcessing(false);
				ShowFlags.SetMotionBlur(false);
				ShowFlags.SetBloom(false);
				ShowFlags.SetAntiAliasing(false);
			}
		});
	SavedState.bInstalledShowFlagsOverride = true;

	const FString ScreenshotPath = FPaths::Combine(
		FPaths::ProjectSavedDir(),
		TEXT("UEShed"),
		TEXT("MapTileStaging"),
		RunId,
		FString::Printf(TEXT("_viewport_Z%02d.png"), Zoom));
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(ScreenshotPath), true);
	IFileManager::Get().Delete(*ScreenshotPath, false, true);
	Config.SetFilename(ScreenshotPath);
	Config.SetMaskEnabled(false);
	Config.SetHDRCapture(false);
	const double CaptureStartedSeconds = FPlatformTime::Seconds();
	if (!Viewport->TakeHighResScreenShot())
	{
		return Fail(
			TEXT("capture_failed"),
			TEXT("Unreal rejected the High Resolution Screenshot request."),
			TEXT("Reduce the complete zoom dimensions and retry."));
	}
	Viewport->Draw(false);

	FImage FullImage;
	const bool bLoadedScreenshot = FImageUtils::LoadImage(*ScreenshotPath, FullImage);
	if (!bLoadedScreenshot
		|| FullImage.SizeX != RenderWidth
		|| FullImage.SizeY != RenderHeight)
	{
		IFileManager::Get().Delete(*ScreenshotPath, false, true);
		return Fail(
			TEXT("capture_failed"),
			TEXT("Unreal did not produce the expected viewport High Resolution Screenshot."),
			TEXT("Keep the Level Editor viewport visible, reduce the zoom dimensions, and retry."));
	}
	IFileManager::Get().Delete(*ScreenshotPath, false, true);
	FullImage.ChangeFormat(ERawImageFormat::BGRA8, EGammaSpace::sRGB);
	const int64 BytesPerPixel = FullImage.GetBytesPerPixel();
	const int64 SourceStride = FullImage.GetStrideBytes();
	const double CaptureDurationMs =
		(FPlatformTime::Seconds() - CaptureStartedSeconds) * 1000.0;
	for (FViewportHighResolutionTile& Tile : Tiles)
	{
		FImage TileImage(
			TilePixelSize,
			TilePixelSize,
			ERawImageFormat::BGRA8,
			EGammaSpace::sRGB);
		const int32 SourceX = GutterPixels + Tile.Column * TilePixelSize;
		const int32 SourceY = GutterPixels + Tile.Row * TilePixelSize;
		for (int32 PixelRow = 0; PixelRow < TilePixelSize; ++PixelRow)
		{
			const uint8* Source = FullImage.RawData.GetData()
				+ (SourceY + PixelRow) * SourceStride
				+ SourceX * BytesPerPixel;
			uint8* Destination = TileImage.RawData.GetData()
				+ PixelRow * TileImage.GetStrideBytes();
			FMemory::Memcpy(Destination, Source, TilePixelSize * BytesPerPixel);
		}
		const FString CapturePath = FPaths::Combine(
			FPaths::ProjectSavedDir(),
			TEXT("UEShed"),
			TEXT("MapTileStaging"),
			RunId,
			FString::Printf(TEXT("Z%02d"), Tile.Zoom),
			FString::Printf(TEXT("R%03d_C%03d.png"), Tile.Row, Tile.Column));
		if (!FUEShedTransientCapture::WritePng(CapturePath, TileImage))
		{
			Tile.Result->SetStringField(TEXT("status"), TEXT("failed"));
			Tile.Result->SetObjectField(
				TEXT("failure"),
				MapTileFailure(
					TEXT("encoding_failed"),
					TEXT("Unreal could not encode a tile cut from the viewport screenshot."),
					TEXT("Check the project Saved directory and retry this zoom."),
					true));
			OutFailed += 1;
		}
		else
		{
			Tile.Result->SetStringField(TEXT("status"), TEXT("captured"));
			Tile.Result->SetStringField(
				TEXT("stagedPath"), FPaths::ConvertRelativePathToFull(CapturePath));
			Tile.Result->SetNumberField(TEXT("width"), TilePixelSize);
			Tile.Result->SetNumberField(TEXT("height"), TilePixelSize);
			Tile.Result->SetNumberField(
				TEXT("bytes"), IFileManager::Get().FileSize(*CapturePath));
			Tile.Result->SetNumberField(TEXT("captureDurationMs"), CaptureDurationMs);
			OutSucceeded += 1;
		}
		OutTileResults.Add(MakeShared<FJsonValueObject>(Tile.Result));
	}
	return true;
}
}

void UUEShedCameraReviewLibrary::CaptureMapTiles(
	const FString& RequestJson,
	FString& ResultJson)
{
	const double StartedSeconds = FPlatformTime::Seconds();
	FString OperationId(TEXT("unknown"));
	FString CorrelationId(TEXT("unknown"));
	auto Fail = [&](const TCHAR* Code, const TCHAR* Message, const TCHAR* Recovery, bool bRetrySafe)
	{
		MapTileTopFailure(
			ResultJson,
			OperationId,
			CorrelationId,
			Code,
			Message,
			Recovery,
			bRetrySafe);
	};

	if (RequestJson.Len() > 256 * 1024)
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("Map tile capture request exceeds 256 KiB."),
			TEXT("Send a bounded batch of at most 64 tiles."),
			false);
		return;
	}
	TSharedPtr<FJsonObject> Request;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RequestJson);
	if (!FJsonSerializer::Deserialize(Reader, Request) || !Request.IsValid())
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("Map tile capture request is not valid JSON."),
			TEXT("Validate the request against ue-shed-map-tile-capture 1.0."),
			false);
		return;
	}
	FString RequestedOperationId;
	FString RequestedCorrelationId;
	Request->TryGetStringField(TEXT("operationId"), RequestedOperationId);
	Request->TryGetStringField(TEXT("correlationId"), RequestedCorrelationId);
	FString PlanId;
	FString RunId;
	Request->TryGetStringField(TEXT("planId"), PlanId);
	Request->TryGetStringField(TEXT("runId"), RunId);
	if (!IsMapTileSafeIdentifier(RequestedOperationId)
		|| !IsMapTileSafeIdentifier(RequestedCorrelationId)
		|| !IsMapTileSafeIdentifier(PlanId)
		|| !IsMapTileSafeIdentifier(RunId))
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("Map capture identities are invalid."),
			TEXT("Use safe identifiers no longer than 128 characters."),
			false);
		return;
	}
	OperationId = RequestedOperationId;
	CorrelationId = RequestedCorrelationId;

	const TSharedPtr<FJsonObject>* Contract;
	const TSharedPtr<FJsonObject>* Version;
	FString ContractName;
	double ContractMajor;
	double ContractMinor;
	if (!Request->TryGetObjectField(TEXT("contract"), Contract)
		|| !(*Contract)->TryGetStringField(TEXT("name"), ContractName)
		|| ContractName != TEXT("ue-shed-map-tile-capture")
		|| !(*Contract)->TryGetObjectField(TEXT("version"), Version)
		|| !(*Version)->TryGetNumberField(TEXT("major"), ContractMajor)
		|| !(*Version)->TryGetNumberField(TEXT("minor"), ContractMinor)
		|| ContractMajor != 1
		|| ContractMinor != 0)
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("Map tile capture contract 1.0 is required."),
			TEXT("Negotiate a supported UEShedCamerasEditor capability."),
			false);
		return;
	}

	if (GEditor == nullptr)
	{
		Fail(
			TEXT("capture_failed"),
			TEXT("The Unreal editor is unavailable."),
			TEXT("Run map capture in an editor process."),
			true);
		return;
	}
	UWorld* World = GEditor->GetEditorWorldContext().World();
	if (World == nullptr)
	{
		Fail(
			TEXT("capture_failed"),
			TEXT("No editor world is open."),
			TEXT("Open the Map Capture Plan's expected map and retry."),
			true);
		return;
	}
	FString ExpectedMapPath;
	if (!Request->TryGetStringField(TEXT("expectedMapPath"), ExpectedMapPath)
		|| World->GetOutermost()->GetName() != ExpectedMapPath)
	{
		Fail(
			TEXT("map_mismatch"),
			TEXT("The open editor map does not match the Map Capture Plan."),
			TEXT("Open the expected map without discarding unsaved work, then retry."),
			true);
		return;
	}

	int32 TilePixelSize;
	int32 GutterPixels;
	if (!ReadInteger(Request, TEXT("tilePixelSize"), TilePixelSize)
		|| TilePixelSize < 64
		|| TilePixelSize > 4096
		|| !ReadInteger(Request, TEXT("gutterPixels"), GutterPixels)
		|| GutterPixels < 0
		|| GutterPixels > 32)
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("Tile or gutter pixel size is outside v1 limits."),
			TEXT("Use tile pixels 64-4096 and gutter pixels 0-32."),
			false);
		return;
	}

	const TSharedPtr<FJsonObject>* CapturePolicy;
	const TSharedPtr<FJsonObject>* DataLayers;
	const TSharedPtr<FJsonObject>* Orientation;
	const TSharedPtr<FJsonObject>* Render;
	const TSharedPtr<FJsonObject>* Effects;
	FString DataLayerMode;
	FString LodPolicy;
	FString RenderProfile;
	bool bFog = true;
	bool bVolumetricFog = true;
	double CaptureZ;
	double Pitch;
	double Yaw;
	double Roll;
	if (!Request->TryGetObjectField(TEXT("capture"), CapturePolicy)
		|| !(*CapturePolicy)->TryGetObjectField(TEXT("dataLayers"), DataLayers)
		|| !(*DataLayers)->TryGetStringField(TEXT("mode"), DataLayerMode)
		|| !(*CapturePolicy)->TryGetObjectField(TEXT("orientation"), Orientation)
		|| !(*Orientation)->TryGetNumberField(TEXT("pitch"), Pitch)
		|| !(*Orientation)->TryGetNumberField(TEXT("yaw"), Yaw)
		|| !(*Orientation)->TryGetNumberField(TEXT("roll"), Roll)
		|| !(*CapturePolicy)->TryGetObjectField(TEXT("render"), Render)
		|| !(*Render)->TryGetObjectField(TEXT("effects"), Effects)
		|| !(*Effects)->TryGetBoolField(TEXT("fog"), bFog)
		|| !(*Effects)->TryGetBoolField(TEXT("volumetricFog"), bVolumetricFog)
		|| !(*Render)->TryGetStringField(TEXT("lodPolicy"), LodPolicy)
		|| !(*Render)->TryGetStringField(TEXT("profile"), RenderProfile)
		|| !(*CapturePolicy)->TryGetNumberField(TEXT("z"), CaptureZ)
		|| !FMath::IsFinite(CaptureZ)
		|| Pitch != -90.0
		|| Yaw != 0.0
		|| Roll != 0.0
		|| (RenderProfile != TEXT("full_fidelity")
			&& RenderProfile != TEXT("seam_stable")
			&& RenderProfile != TEXT("scene_capture_defaults")
			&& RenderProfile != TEXT("observation")))
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("The top-down capture policy is invalid."),
			TEXT("Use finite capture Z, orientation (-90,0,0), and a supported render profile."),
			false);
		return;
	}
	if (DataLayerMode != TEXT("unchanged"))
	{
		Fail(
			TEXT("data_layer_policy_unsupported"),
			TEXT("Explicit Data Layer state is not supported by map tile capture v1."),
			TEXT("Use unchanged Data Layers or install a project adapter with scoped restoration."),
			false);
		return;
	}
	const TArray<TSharedPtr<FJsonValue>>* LodDistanceScales = nullptr;
	if (LodPolicy == TEXT("per_level_distance_scale"))
	{
		if (!(*Render)->TryGetArrayField(TEXT("lodDistanceScaleByZoom"), LodDistanceScales)
			|| LodDistanceScales->IsEmpty()
			|| LodDistanceScales->Num() > 24)
		{
			Fail(
				TEXT("invalid_request"),
				TEXT("Per-level LOD policy requires one to 24 distance scales."),
				TEXT("Provide one finite 0.1-100 scale for every captured pyramid zoom."),
				false);
			return;
		}
	}
	else if (LodPolicy != TEXT("natural"))
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("Explicit LOD intervention is not supported by map tile capture v1."),
			TEXT("Use natural or per-level distance-scale LOD selection."),
			false);
		return;
	}

	const TArray<TSharedPtr<FJsonValue>>* Tiles;
	FString CaptureBackend(TEXT("scene_capture_tiles"));
	Request->TryGetStringField(TEXT("captureBackend"), CaptureBackend);
	if (CaptureBackend != TEXT("scene_capture_tiles")
		&& CaptureBackend != TEXT("viewport_high_resolution"))
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("The requested Map Capture backend is unsupported."),
			TEXT("Use scene_capture_tiles or viewport_high_resolution."),
			false);
		return;
	}
	if (!Request->TryGetArrayField(TEXT("tiles"), Tiles)
		|| Tiles->IsEmpty()
		|| Tiles->Num() > 64)
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("Map tile capture requires one to 64 tiles."),
			TEXT("Split the plan into bounded tile batches."),
			false);
		return;
	}

	UPackage* MapPackage = World->GetOutermost();
	const bool bDirtyBefore = MapPackage->IsDirty();
	World->FlushLevelStreaming(EFlushLevelStreamingType::Full);
	World->BlockTillLevelStreamingCompleted();
	if (const UWorldPartition* WorldPartition = World->GetWorldPartition();
		WorldPartition != nullptr && !WorldPartition->IsStreamingCompleted(nullptr))
	{
		MapTileTopFailure(
			ResultJson,
			OperationId,
			CorrelationId,
			TEXT("streaming_not_ready"),
			TEXT("World Partition streaming is not ready for deterministic capture."),
			TEXT("Wait for streaming completion or launch a headless session with the required region loaded."),
			true,
			bDirtyBefore,
			MapPackage->IsDirty());
		return;
	}
	TArray<TSharedPtr<FJsonValue>> TileResults;
	int32 Succeeded = 0;
	int32 Failed = 0;
	bool bCancelled = false;
	TSet<FString> UniqueKeys;
	if (CaptureBackend == TEXT("viewport_high_resolution"))
	{
		FString FailureCode;
		FString FailureMessage;
		FString FailureRecovery;
		if (!CaptureViewportHighResolutionLevel(
				*Tiles,
				TilePixelSize,
				GutterPixels,
				CaptureZ,
				bFog,
				bVolumetricFog,
				RenderProfile,
				RunId,
				TileResults,
				Succeeded,
				Failed,
				FailureCode,
				FailureMessage,
				FailureRecovery))
		{
			MapTileTopFailure(
				ResultJson,
				OperationId,
				CorrelationId,
				*FailureCode,
				*FailureMessage,
				*FailureRecovery,
				FailureCode != TEXT("invalid_request"),
				bDirtyBefore,
				MapPackage->IsDirty());
			return;
		}
	}
	else
	{
	TArray<TUniquePtr<FUEShedTransientCapture>> CapturePool;
	TArray<FPendingMapTileEncode> PendingEncodes;
	TArray<FPendingMapTileReadback> PendingReadbacks;
	auto FinalizeOldestEncode = [&]()
	{
		FPendingMapTileEncode Pending = MoveTemp(PendingEncodes[0]);
		PendingEncodes.RemoveAt(0, EAllowShrinking::No);
		const bool bWritten = Pending.Written.Get();
		if (!bWritten)
		{
			Pending.Result->SetStringField(TEXT("status"), TEXT("failed"));
			Pending.Result->SetObjectField(
				TEXT("failure"),
				MapTileFailure(
					TEXT("encoding_failed"),
					TEXT("Unreal could not encode or stage the tile PNG."),
					TEXT("Check the project Saved directory and retry this tile."),
					true));
			Failed += 1;
		}
		else
		{
			Pending.Result->SetStringField(TEXT("status"), TEXT("captured"));
			Pending.Result->SetStringField(
				TEXT("stagedPath"), FPaths::ConvertRelativePathToFull(Pending.Path));
			Pending.Result->SetNumberField(TEXT("width"), TilePixelSize);
			Pending.Result->SetNumberField(TEXT("height"), TilePixelSize);
			Pending.Result->SetNumberField(
				TEXT("bytes"), IFileManager::Get().FileSize(*Pending.Path));
			Pending.Result->SetNumberField(
				TEXT("captureDurationMs"),
				(FPlatformTime::Seconds() - Pending.StartedSeconds) * 1000.0);
			Succeeded += 1;
		}
		TileResults.Add(MakeShared<FJsonValueObject>(Pending.Result));
	};
	auto FinalizeAllEncodes = [&]()
	{
		while (!PendingEncodes.IsEmpty()) FinalizeOldestEncode();
	};
	auto FinalizeAllReadbacks = [&]()
	{
		for (FPendingMapTileReadback& Pending : PendingReadbacks)
		{
			FImage Image;
			if (!Pending.Capture->ReadImage(Image, &Pending.Crop))
			{
				FinalizeAllEncodes();
				Pending.Result->SetStringField(TEXT("status"), TEXT("failed"));
				Pending.Result->SetObjectField(
					TEXT("failure"),
					MapTileFailure(
						TEXT("encoding_failed"),
						TEXT("Unreal could not crop or read the tile render target."),
						TEXT("Check the project Saved directory and retry this tile."),
						true));
				Failed += 1;
				TileResults.Add(MakeShared<FJsonValueObject>(Pending.Result));
				continue;
			}
			if (Image.SizeX != Pending.OutputSize || Image.SizeY != Pending.OutputSize)
			{
				FImageCore::ResizeImageInPlace(
					Image,
					Pending.OutputSize,
					Pending.OutputSize,
					FImageCore::EResizeImageFilter::Box);
			}
			TFuture<bool> Written = Async(
				EAsyncExecution::ThreadPool,
				[CapturePath = Pending.Path, Image = MoveTemp(Image)]() mutable
				{
					return FUEShedTransientCapture::WritePng(CapturePath, Image);
				});
			PendingEncodes.Emplace(
				Pending.Result, Pending.Path, Pending.StartedSeconds, MoveTemp(Written));
			if (PendingEncodes.Num() >= MaximumPendingTileEncodes) FinalizeOldestEncode();
		}
		PendingReadbacks.Reset();
	};
	for (const TSharedPtr<FJsonValue>& TileValue : *Tiles)
	{
		if (IsEngineExitRequested())
		{
			bCancelled = true;
			break;
		}
		const double TileStartedSeconds = FPlatformTime::Seconds();
		const TSharedPtr<FJsonObject>* Tile;
		const TSharedPtr<FJsonObject>* Key;
		const TSharedPtr<FJsonObject>* Bounds;
		int32 Zoom = 0;
		int32 Row = 0;
		int32 Column = 0;
		double UnitsPerPixel = 0.0;
		double MinX = 0.0;
		double MinY = 0.0;
		double MaxX = 0.0;
		double MaxY = 0.0;
		double LodDistanceScale = 1.0;
		bool bValid = TileValue.IsValid()
			&& TileValue->TryGetObject(Tile)
			&& (*Tile)->TryGetObjectField(TEXT("key"), Key)
			&& ReadInteger(*Key, TEXT("zoom"), Zoom)
			&& ReadInteger(*Key, TEXT("row"), Row)
			&& ReadInteger(*Key, TEXT("column"), Column)
			&& Zoom >= 0
			&& Row >= 0
			&& Column >= 0
			&& (*Tile)->TryGetNumberField(TEXT("unitsPerPixel"), UnitsPerPixel)
			&& FMath::IsFinite(UnitsPerPixel)
			&& UnitsPerPixel > 0.0
			&& (*Tile)->TryGetObjectField(TEXT("worldBounds"), Bounds)
			&& (*Bounds)->TryGetNumberField(TEXT("minX"), MinX)
			&& (*Bounds)->TryGetNumberField(TEXT("minY"), MinY)
			&& (*Bounds)->TryGetNumberField(TEXT("maxX"), MaxX)
			&& (*Bounds)->TryGetNumberField(TEXT("maxY"), MaxY);
		if (bValid && LodPolicy == TEXT("per_level_distance_scale"))
		{
			bValid = LodDistanceScales != nullptr
				&& LodDistanceScales->IsValidIndex(Zoom)
				&& (*LodDistanceScales)[Zoom]->TryGetNumber(LodDistanceScale)
				&& FMath::IsFinite(LodDistanceScale)
				&& LodDistanceScale >= 0.1
				&& LodDistanceScale <= 100.0;
		}
		if (!bValid)
		{
			FinalizeAllReadbacks();
			FinalizeAllEncodes();
			MapTileTopFailure(
				ResultJson,
				OperationId,
				CorrelationId,
				TEXT("invalid_request"),
				TEXT("A tile entry is invalid."),
				TEXT("Validate every key, bounds rectangle, and world-units-per-pixel value."),
				false,
				bDirtyBefore,
				MapPackage->IsDirty());
			return;
		}

		const FString KeyIdentity = FString::Printf(TEXT("%d/%d/%d"), Zoom, Row, Column);
		const double ExpectedWorldSize = TilePixelSize * UnitsPerPixel;
		const double Tolerance = FMath::Max(0.001, ExpectedWorldSize * UE_DOUBLE_SMALL_NUMBER);
		if (UniqueKeys.Contains(KeyIdentity)
			|| MaxX <= MinX
			|| MaxY <= MinY
			|| !FMath::IsNearlyEqual(MaxX - MinX, ExpectedWorldSize, Tolerance)
			|| !FMath::IsNearlyEqual(MaxY - MinY, ExpectedWorldSize, Tolerance))
		{
			FinalizeAllReadbacks();
			FinalizeAllEncodes();
			MapTileTopFailure(
				ResultJson,
				OperationId,
				CorrelationId,
				TEXT("invalid_request"),
				TEXT("Tile keys must be unique and bounds must match tile pixels times units-per-pixel."),
				TEXT("Regenerate the bounded request from the validated Map Capture Plan grid."),
				false,
				bDirtyBefore,
				MapPackage->IsDirty());
			return;
		}
		UniqueKeys.Add(KeyIdentity);

		const int32 RenderScale = RenderProfile == TEXT("seam_stable")
			? SeamStableRenderScale
			: 1;
		const int32 RenderSize = (TilePixelSize + GutterPixels * 2) * RenderScale;
		const double OrthoWidth = (TilePixelSize + GutterPixels * 2) * UnitsPerPixel;
		const FVector Location((MinX + MaxX) * 0.5, (MinY + MaxY) * 0.5, CaptureZ);
		const int32 CaptureSlot = PendingReadbacks.Num();
		if (!CapturePool.IsValidIndex(CaptureSlot))
		{
			TUniquePtr<FUEShedTransientCapture> NewCapture = FUEShedTransientCapture::Create(
				World,
				Location,
				FRotator(-90.0, 0.0, 0.0),
				RenderSize,
				RenderSize,
				TEXT("UEShedMapTileCapture"));
			if (NewCapture.IsValid()) CapturePool.Add(MoveTemp(NewCapture));
		}
		FUEShedTransientCapture* Capture = CapturePool.IsValidIndex(CaptureSlot)
			? CapturePool[CaptureSlot].Get()
			: nullptr;
		const TSharedRef<FJsonObject> TileResult = MakeShared<FJsonObject>();
		TileResult->SetObjectField(TEXT("key"), MapTileKeyJson(Zoom, Row, Column));
		if (Capture == nullptr)
		{
			FinalizeAllReadbacks();
			FinalizeAllEncodes();
			TileResult->SetStringField(TEXT("status"), TEXT("failed"));
			TileResult->SetObjectField(
				TEXT("failure"),
				MapTileFailure(
					TEXT("capture_failed"),
					TEXT("Unreal could not create a transient orthographic capture source."),
					TEXT("Check the editor world and retry this tile."),
					true));
			Failed += 1;
			TileResults.Add(MakeShared<FJsonValueObject>(TileResult));
			continue;
		}
		Capture->SetLocation(Location);
		Capture->ConfigureOrthographic(static_cast<float>(OrthoWidth));
		Capture->ConfigureRenderPolicy(
			bFog,
			bVolumetricFog,
			static_cast<float>(LodDistanceScale));
		if (RenderProfile == TEXT("observation"))
		{
			USceneCaptureComponent2D* Component = Capture->Component();
			Component->ShowFlags.DisableAdvancedFeatures();
			Component->ShowFlags.SetPostProcessing(false);
			Component->ShowFlags.SetMotionBlur(false);
			Component->ShowFlags.SetBloom(false);
			Component->ShowFlags.SetAntiAliasing(false);
		}
		else
		{
			if (RenderProfile == TEXT("full_fidelity"))
			{
				Capture->ConfigureFullFidelityRenderer();
			}
			else if (RenderProfile == TEXT("seam_stable"))
			{
				Capture->ConfigureSeamStableRenderer();
			}
			// A camera cut prevents the reused capture context from carrying temporal state from a
			// spatially unrelated tile. The discarded synchronous renders prime render resources, but
			// do not advance shared exposure or cross-frame temporal history.
			Capture->BeginPersistentCameraCut();
			for (int32 Warmup = 0; Warmup < FullFidelityWarmupCaptures; ++Warmup)
			{
				Capture->Capture();
			}
		}
		Capture->Capture();
		const FString CapturePath = FPaths::Combine(
			FPaths::ProjectSavedDir(),
			TEXT("UEShed"),
			TEXT("MapTileStaging"),
			RunId,
			FString::Printf(TEXT("Z%02d"), Zoom),
			FString::Printf(TEXT("R%03d_C%03d.png"), Row, Column));
		const FIntRect Crop(
			GutterPixels * RenderScale,
			GutterPixels * RenderScale,
			(GutterPixels + TilePixelSize) * RenderScale,
			(GutterPixels + TilePixelSize) * RenderScale);
		PendingReadbacks.Emplace(
			Capture, TileResult, CapturePath, TileStartedSeconds, Crop, TilePixelSize);
		if (PendingReadbacks.Num() >= MaximumPendingTileReadbacks) FinalizeAllReadbacks();
	}
	FinalizeAllReadbacks();
	FinalizeAllEncodes();

	if (bCancelled)
	{
		for (int32 Index = TileResults.Num(); Index < Tiles->Num(); ++Index)
		{
			const TSharedPtr<FJsonObject>* Tile;
			const TSharedPtr<FJsonObject>* Key;
			int32 Zoom = 0;
			int32 Row = 0;
			int32 Column = 0;
			(*Tiles)[Index]->TryGetObject(Tile);
			(*Tile)->TryGetObjectField(TEXT("key"), Key);
			ReadInteger(*Key, TEXT("zoom"), Zoom);
			ReadInteger(*Key, TEXT("row"), Row);
			ReadInteger(*Key, TEXT("column"), Column);
			const TSharedRef<FJsonObject> TileResult = MakeShared<FJsonObject>();
			TileResult->SetObjectField(TEXT("key"), MapTileKeyJson(Zoom, Row, Column));
			TileResult->SetStringField(TEXT("status"), TEXT("failed"));
			TileResult->SetObjectField(
				TEXT("failure"),
				MapTileFailure(
					TEXT("cancelled"),
					TEXT("Editor shutdown cancelled map tile capture."),
					TEXT("Restart the editor and retry the missing tile subset."),
					true));
			TileResults.Add(MakeShared<FJsonValueObject>(TileResult));
			Failed += 1;
		}
	}
	}

	const bool bDirtyAfter = MapPackage->IsDirty();
	const TSharedRef<FJsonObject> Result = MapTileResponseBase(
		OperationId,
		CorrelationId,
		bDirtyBefore,
		bDirtyAfter,
		(FPlatformTime::Seconds() - StartedSeconds) * 1000.0);
	Result->SetStringField(TEXT("actualMapPath"), World->GetOutermost()->GetName());
	Result->SetArrayField(TEXT("results"), TileResults);
	SetMapTileCounts(Result, Tiles->Num(), Succeeded, Failed);
	if (bCancelled)
	{
		Result->SetStringField(TEXT("status"), TEXT("cancelled"));
		Result->SetObjectField(
			TEXT("failure"),
			MapTileFailure(
				TEXT("cancelled"),
				TEXT("Map tile capture was cancelled during editor shutdown."),
				TEXT("Retry only the missing or failed tiles."),
				true));
	}
	else if (bDirtyBefore != bDirtyAfter)
	{
		Result->SetStringField(TEXT("status"), TEXT("failed"));
		Result->SetObjectField(
			TEXT("failure"),
			MapTileFailure(
				TEXT("dirty_state_changed"),
				TEXT("The target map package dirty state changed during capture."),
				TEXT("Inspect editor state; do not publish this attempt."),
				false));
	}
	else if (Failed == 0)
	{
		Result->SetStringField(TEXT("status"), TEXT("completed"));
	}
	else if (Succeeded > 0)
	{
		Result->SetStringField(TEXT("status"), TEXT("partial"));
	}
	else
	{
		Result->SetStringField(TEXT("status"), TEXT("failed"));
	}
	ResultJson = MapTileJsonString(Result);
}
