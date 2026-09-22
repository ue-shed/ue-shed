#pragma once

#include "CoreMinimal.h"

#if WITH_DEV_AUTOMATION_TESTS
// Game-thread-only hooks for deterministic lifecycle automation; never exposed on the wire.
namespace UEShedWorldPreparationTest
{
extern TFunction<double()> Clock;
extern TFunction<void()> BeforeLoad;
} // namespace UEShedWorldPreparationTest
#endif
