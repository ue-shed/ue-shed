#pragma once

#include "CoreMinimal.h"
#include "Engine/DataTable.h"
#include "UEShedCorpusTypes.generated.h"

/**
 * Row struct of the generated DataTables. It lives in this development plugin, so the generated
 * DataTables only open in the editor while the plugin is loaded (for example with -PLUGIN=).
 */
USTRUCT(BlueprintType)
struct FUEShedCorpusTextRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Corpus")
	FText DisplayName;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Corpus")
	FText Description;
};
