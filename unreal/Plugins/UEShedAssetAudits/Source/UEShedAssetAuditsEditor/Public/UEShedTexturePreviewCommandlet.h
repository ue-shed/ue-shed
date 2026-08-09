#pragma once

#include "Commandlets/Commandlet.h"
#include "UEShedTexturePreviewCommandlet.generated.h"

/** Generates up to 100 bounded saved-asset texture previews per headless editor launch. */
UCLASS()
class UUEShedTexturePreviewCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UUEShedTexturePreviewCommandlet();

	virtual int32 Main(const FString& Params) override;
};
