#pragma once

#include "CoreMinimal.h"

class UUEShedCoverageBatchAsset;
class FJsonObject;
void FillCoverageBatchFixture(UUEShedCoverageBatchAsset* Asset, UObject* Reference);
TSharedRef<FJsonObject> CoverageBatchFixtureEvidence(const UUEShedCoverageBatchAsset* Asset);
TSharedRef<FJsonObject> LandscapeConstraintFixtureEvidence(const UUEShedCoverageBatchAsset* Asset);
