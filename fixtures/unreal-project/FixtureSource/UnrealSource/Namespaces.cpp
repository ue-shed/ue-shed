// Gather-only C++ text for Plan 060's source scanner. Not compiled: Unreal's GatherTextFromSource
// reads it as text (UnrealSource.ini), and the manifests it writes are the scanner's oracle.
// Namespace scoping: a define holds until its #undef, a nested define is ignored (first wins), and
// text with no namespace in scope gathers under the empty namespace.

FText NoNamespaceYet()
{
	return LOCTEXT("NoNamespace", "Text before any namespace");
}

#define LOCTEXT_NAMESPACE "UnrealSource.Namespaces"

FText Docked()
{
	return LOCTEXT("Docked", "The ship is docked");
}

#define LOCTEXT_NAMESPACE "UnrealSource.Ignored"

FText StillFirst()
{
	return LOCTEXT("StillFirst", "The first namespace still holds");
}

FText Explicit()
{
	return NSLOCTEXT("UnrealSource.Explicit", "Explicit", "An explicit namespace wins");
}

#undef LOCTEXT_NAMESPACE

#define LOCTEXT_NAMESPACE TEXT("UnrealSource.Wrapped")

FText WrappedDefine()
{
	return LOCTEXT("WrappedDefine", "A namespace written with TEXT()");
}

#undef LOCTEXT_NAMESPACE
#undef LOCTEXT_NAMESPACE
