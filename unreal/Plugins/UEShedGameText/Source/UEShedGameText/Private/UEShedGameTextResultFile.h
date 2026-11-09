#pragma once

#include "CoreMinimal.h"
#include "Templates/Function.h"

namespace UEShedGameText
{
/**
 * Publishes Text at Path through a temporary file in the same directory and a rename over Path, so
 * a reader sees the previous complete file or the new one, never a partial file. Write stages the
 * temporary file; a failed or interrupted write leaves Path untouched and removes the staging file.
 */
bool PublishFileAtomically(const FString& Path, const FString& Text, FString& OutError,
	TFunctionRef<bool(const FString& StagingPath, const FString& Text)> Write);

/** Publishes UTF-8 text without a byte-order mark. */
bool PublishFileAtomically(const FString& Path, const FString& Text, FString& OutError);
}
