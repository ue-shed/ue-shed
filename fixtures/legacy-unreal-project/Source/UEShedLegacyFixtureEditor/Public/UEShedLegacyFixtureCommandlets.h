#pragma once

#include "Commandlets/Commandlet.h"
#include "UEShedLegacyFixtureCommandlets.generated.h"

UCLASS()
class UUEShedLegacyFixtureBuildCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UUEShedLegacyFixtureBuildCommandlet();
	virtual int32 Main(const FString& Params) override;
};

UCLASS()
class UUEShedLegacyFixtureEvidenceCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UUEShedLegacyFixtureEvidenceCommandlet();
	virtual int32 Main(const FString& Params) override;
};
