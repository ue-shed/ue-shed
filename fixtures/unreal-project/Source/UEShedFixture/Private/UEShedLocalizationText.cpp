#include "Internationalization/Text.h"

#define LOCTEXT_NAMESPACE "Fixture.Localization.Source"

// Source-only occurrences deliberately exercise the gathered-only state.
TArray<FText> UEShedLocalizationSourceText()
{
	return {
		LOCTEXT("RuntimeReady", "Ready to begin"),
		NSLOCTEXT("Fixture.Localization.Source", "RuntimeOrdered", "Stage {0} of {1}")
	};
}

#undef LOCTEXT_NAMESPACE
