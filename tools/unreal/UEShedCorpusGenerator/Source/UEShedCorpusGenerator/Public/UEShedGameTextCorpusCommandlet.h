#pragma once

#include "Commandlets/Commandlet.h"
#include "UEShedGameTextCorpusCommandlet.generated.h"

/**
 * Writes a deterministic Game Text test corpus: String Tables, DataTables, actor Blueprints and
 * Widget Blueprints under one new content folder, plus a manifest JSON beside them.
 *
 * -run=UEShedGameTextCorpus -Lines=10000 -Seed=1 -Root=/Game/Developers/<user>/GameTextCorpus
 */
UCLASS()
class UUEShedGameTextCorpusCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UUEShedGameTextCorpusCommandlet();
	virtual int32 Main(const FString& Params) override;
};
