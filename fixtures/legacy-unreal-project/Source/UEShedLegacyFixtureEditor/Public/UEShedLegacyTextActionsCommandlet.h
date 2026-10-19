#pragma once

#include "Commandlets/Commandlet.h"
#include "UEShedLegacyTextActionsCommandlet.generated.h"

/** Disposable baseline and fresh-process evidence for localization key repairs. */
UCLASS()
class UUEShedLegacyTextActionsCommandlet : public UCommandlet
{
	GENERATED_BODY()
public:
	UUEShedLegacyTextActionsCommandlet();
	virtual int32 Main(const FString& Params) override;
};
