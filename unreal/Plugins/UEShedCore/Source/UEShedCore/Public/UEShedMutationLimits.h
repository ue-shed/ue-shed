#pragma once

#include "CoreMinimal.h"

/**
 * Limits on one authoring Apply, advertised in the capability manifest as `authoringLimits` and
 * enforced by the authoring plugin. A project raises them in its editor config:
 *
 *   [UEShed.Authoring]
 *   MaxCommands=1024        ; 1 to 1000000
 *   MaxPayloadBytes=1048576 ; 1 to 268435456 (256 MiB), request characters
 *   MaxTables=16            ; 1 to 10000
 *
 * Missing or out-of-range values keep the default.
 */
struct FUEShedAuthoringLimits
{
	int32 MaxCommands = 1024;
	int32 MaxPayloadBytes = 1024 * 1024;
	int32 MaxTables = 16;
};

/** The section of the editor config the limits are read from. */
constexpr const TCHAR* UEShedAuthoringLimitsSection = TEXT("UEShed.Authoring");

/** Reads the limits from the editor config each call, so a config change applies at once. */
UESHEDCORE_API FUEShedAuthoringLimits UEShedReadAuthoringLimits();
