#pragma once

#include "Commandlets/Commandlet.h"
#include "UEShedBuildFixtureCommandlet.generated.h"

UCLASS()
class UUEShedBuildFixtureCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UUEShedBuildFixtureCommandlet();

	virtual int32 Main(const FString& Params) override;
};
