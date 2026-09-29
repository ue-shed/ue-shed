#pragma once
#include "CoreMinimal.h"
class UUEShedNativeCoverageAsset;
class FJsonObject;
void FillPropertyBagFixture(UUEShedNativeCoverageAsset* Asset, UObject* Reference);
TSharedRef<FJsonObject> PropertyBagFixtureEvidence(const UUEShedNativeCoverageAsset* Asset);
