// Gather-only, UE 5.x. A #define whose body holds a loc macro becomes a descriptor of its own
// (the nested-macro prepass), so text written through a studio wrapper gathers. UE 4.27 has no
// prepass: there, wrapped text is invisible to Unreal too.

#define LOCTEXT_NAMESPACE "UnrealSource.Wrappers"
#define HARBOR_LOCTEXT(InKey, InText) LOCTEXT(InKey, InText)

FText Wrapped()
{
	return HARBOR_LOCTEXT("Wrapped", "Text through a wrapper macro");
}

#undef HARBOR_LOCTEXT
#undef LOCTEXT_NAMESPACE
