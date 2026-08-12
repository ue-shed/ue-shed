#include "UEShedCameraReviewLibrary.h"
#include "UEShedTransientCapture.h"

#include "Components/SceneCaptureComponent2D.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "WorldPartition/WorldPartition.h"

namespace
{
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
	FString DataLayerMode;
	FString LodPolicy;
	FString RenderProfile;
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
		|| !(*Render)->TryGetStringField(TEXT("lodPolicy"), LodPolicy)
		|| !(*Render)->TryGetStringField(TEXT("profile"), RenderProfile)
		|| !(*CapturePolicy)->TryGetNumberField(TEXT("z"), CaptureZ)
		|| !FMath::IsFinite(CaptureZ)
		|| Pitch != -90.0
		|| Yaw != 0.0
		|| Roll != 0.0
		|| (RenderProfile != TEXT("full_fidelity")
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
	if (LodPolicy != TEXT("natural"))
	{
		Fail(
			TEXT("invalid_request"),
			TEXT("Explicit LOD intervention is not supported by map tile capture v1."),
			TEXT("Use natural LOD selection or install a project render-policy adapter."),
			false);
		return;
	}

	const TArray<TSharedPtr<FJsonValue>>* Tiles;
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
		if (!bValid)
		{
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

		const int32 RenderSize = TilePixelSize + GutterPixels * 2;
		const double OrthoWidth = RenderSize * UnitsPerPixel;
		const FVector Location((MinX + MaxX) * 0.5, (MinY + MaxY) * 0.5, CaptureZ);
		TUniquePtr<FUEShedTransientCapture> Capture = FUEShedTransientCapture::Create(
			World,
			Location,
			FRotator(-90.0, 0.0, 0.0),
			RenderSize,
			RenderSize,
			TEXT("UEShedMapTileCapture"));
		const TSharedRef<FJsonObject> TileResult = MakeShared<FJsonObject>();
		TileResult->SetObjectField(TEXT("key"), MapTileKeyJson(Zoom, Row, Column));
		if (!Capture.IsValid())
		{
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
		Capture->ConfigureOrthographic(static_cast<float>(OrthoWidth));
		if (RenderProfile == TEXT("observation"))
		{
			USceneCaptureComponent2D* Component = Capture->Component();
			Component->ShowFlags.DisableAdvancedFeatures();
			Component->ShowFlags.SetPostProcessing(false);
			Component->ShowFlags.SetMotionBlur(false);
			Component->ShowFlags.SetBloom(false);
			Component->ShowFlags.SetAntiAliasing(false);
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
			GutterPixels,
			GutterPixels,
			GutterPixels + TilePixelSize,
			GutterPixels + TilePixelSize);
		const bool bWritten = Capture->ExportPng(CapturePath, &Crop);
		Capture.Reset();
		if (!bWritten)
		{
			TileResult->SetStringField(TEXT("status"), TEXT("failed"));
			TileResult->SetObjectField(
				TEXT("failure"),
				MapTileFailure(
					TEXT("encoding_failed"),
					TEXT("Unreal could not crop, encode, or stage the tile PNG."),
					TEXT("Check the project Saved directory and retry this tile."),
					true));
			Failed += 1;
		}
		else
		{
			TileResult->SetStringField(TEXT("status"), TEXT("captured"));
			TileResult->SetStringField(
				TEXT("stagedPath"), FPaths::ConvertRelativePathToFull(CapturePath));
			TileResult->SetNumberField(TEXT("width"), TilePixelSize);
			TileResult->SetNumberField(TEXT("height"), TilePixelSize);
			TileResult->SetNumberField(
				TEXT("bytes"), IFileManager::Get().FileSize(*CapturePath));
			TileResult->SetNumberField(
				TEXT("captureDurationMs"),
				(FPlatformTime::Seconds() - TileStartedSeconds) * 1000.0);
			Succeeded += 1;
		}
		TileResults.Add(MakeShared<FJsonValueObject>(TileResult));
	}

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
