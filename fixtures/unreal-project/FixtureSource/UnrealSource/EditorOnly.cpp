// Gather-only. A region is editor-only only when an enclosing #if is exactly WITH_EDITOR or
// WITH_EDITORONLY_DATA (also as defined(...)). Unreal evaluates nothing: compound and negated
// conditions gather as runtime text. LOC_DEFINE_REGION excludes its region from every macro.

#define LOCTEXT_NAMESPACE "UnrealSource.EditorOnly"

FText Runtime()
{
	return LOCTEXT("Runtime", "Runtime text");
}

#if WITH_EDITOR
FText EditorText()
{
	return LOCTEXT("Editor", "Editor-only text");
}
#endif

#if WITH_EDITORONLY_DATA
FText EditorData()
{
	return LOCTEXT("EditorData", "Editor-only data text");
}
#endif

#if defined(WITH_EDITOR)
FText EditorDefined()
{
	return LOCTEXT("EditorDefined", "Editor-only through defined()");
}
#endif

#if WITH_EDITOR && UE_BUILD_DEBUG
FText Compound()
{
	return LOCTEXT("Compound", "A compound condition gathers as runtime text");
}
#endif

#if !WITH_EDITOR
FText Negated()
{
	return LOCTEXT("Negated", "A negated condition gathers as runtime text");
}
#endif

#if 0
FText Disabled()
{
	return LOCTEXT("Disabled", "Even #if 0 gathers");
}
#endif

#define LOC_DEFINE_REGION
FText Excluded()
{
	return LOCTEXT("Excluded", "Inside LOC_DEFINE_REGION, never gathered");
}
#undef LOC_DEFINE_REGION

#undef LOCTEXT_NAMESPACE
