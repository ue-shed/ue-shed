#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Map capture 1.3 `capture.render.timing`. Unset fields keep each backend's default. */
struct FUEShedMapTileTiming
{
	TOptional<int32> FrameTimeoutMs;
	TOptional<int32> SettleFrames;
	TOptional<int32> OverviewFrames;
	TOptional<int32> ScreenshotWarmupFrames;
};

/** Reads `render.timing`. Returns false for unknown fields or values outside the contract. */
inline bool UEShedReadMapTileTiming(const TSharedPtr<FJsonObject>& Object, FUEShedMapTileTiming& Out)
{
	if (!Object)
		return false;
	struct FField
	{
		const TCHAR* Name;
		int32 Minimum;
		int32 Maximum;
		TOptional<int32>* Target;
	};
	const FField Fields[] = {
		{TEXT("frameTimeoutMs"), 1000, 900000, &Out.FrameTimeoutMs},
		{TEXT("settleFrames"), 1, 4096, &Out.SettleFrames},
		{TEXT("overviewFrames"), 1, 4096, &Out.OverviewFrames},
		{TEXT("screenshotWarmupFrames"), 1, 256, &Out.ScreenshotWarmupFrames},
	};
	int32 Known = 0;
	for (const FField& Field : Fields)
	{
		if (!Object->HasField(Field.Name))
			continue;
		++Known;
		double Value = 0;
		if (!Object->TryGetNumberField(Field.Name, Value) || Value != FMath::FloorToDouble(Value) ||
			Value < Field.Minimum || Value > Field.Maximum)
			return false;
		*Field.Target = static_cast<int32>(Value);
	}
	return Known == Object->Values.Num();
}

/** Applies timing to a camera render session request built for a map tile or level render. */
inline void UEShedApplyMapTileTiming(const FUEShedMapTileTiming& Timing, const TSharedPtr<FJsonObject>& SessionRequest,
									 int32 DefaultSettleFrames)
{
	const auto Policy = SessionRequest->GetObjectField(TEXT("policy"));
	const auto Settling = Policy->GetObjectField(TEXT("settling"));
	Settling->SetNumberField(TEXT("minimumFrames"), Timing.SettleFrames.Get(DefaultSettleFrames));
	if (Timing.FrameTimeoutMs.IsSet())
		Settling->SetNumberField(TEXT("timeoutMs"), Timing.FrameTimeoutMs.GetValue());
	const auto Renderer = Policy->GetObjectField(TEXT("renderer"));
	if (Timing.ScreenshotWarmupFrames.IsSet() &&
		Renderer->GetStringField(TEXT("kind")) == TEXT("editor_viewport"))
		Renderer->SetNumberField(TEXT("screenshotWarmupFrames"), Timing.ScreenshotWarmupFrames.GetValue());
}
