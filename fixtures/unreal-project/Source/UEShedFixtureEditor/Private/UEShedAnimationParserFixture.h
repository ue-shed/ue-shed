#pragma once
#include "CoreMinimal.h"
class USkeleton;
class FJsonObject;
bool GenerateAnimationParserFixture(USkeleton* Skeleton);
TSharedPtr<FJsonObject> AnimationParserFixtureEvidence();
