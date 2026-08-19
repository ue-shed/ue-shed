#pragma once

#include "Commandlets/Commandlet.h"
#include "UEShedNiagaraPreviewCommandlet.generated.h"

/** Captures one bounded Niagara Baker preview into contained Saved staging. */
UCLASS()
class UUEShedNiagaraPreviewCommandlet final : public UCommandlet
{
	GENERATED_BODY()

public:
	UUEShedNiagaraPreviewCommandlet();

	virtual int32 Main(const FString& Params) override;
};
