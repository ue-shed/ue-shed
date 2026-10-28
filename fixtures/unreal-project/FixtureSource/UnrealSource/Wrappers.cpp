// Gather-only. HARBOR_LOCTEXT gathers on every engine, 4.27 included, only because its name ends
// in LOCTEXT. The UE_SHED_HARBOR_* calls need the 5.x prepass to find their wrappers in
// Source/UEShedFixture/Public/UEShedFixtureTextWrappers.h; UE_SHED_HARBOR_TEXT never gathers.

#define LOCTEXT_NAMESPACE "UnrealSource.Wrappers"
#define HARBOR_LOCTEXT(InKey, InText) LOCTEXT(InKey, InText)

FText Wrapped()
{
	return HARBOR_LOCTEXT("Wrapped", "Text through a wrapper macro");
}

#undef HARBOR_LOCTEXT
#undef LOCTEXT_NAMESPACE

#define LOCTEXT_NAMESPACE "UnrealSource.HeaderWrappers"

FText HeaderWrapped()
{
	return UE_SHED_HARBOR_TEXT("Moored", "A wrapper defined in a header");
}

UE_SHED_HARBOR_PARAM(Anchor, "Anchor weight")

void RegisterWrappedCommands()
{
	UE_SHED_HARBOR_COMMAND(RaiseSails, "Raise Sails", "Raises every sail");
}

#undef LOCTEXT_NAMESPACE
