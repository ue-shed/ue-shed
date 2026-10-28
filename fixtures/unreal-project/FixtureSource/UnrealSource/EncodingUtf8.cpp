// Gather-only. How Unreal reads a source file's encoding: UTF-8 without a byte order mark.

#define LOCTEXT_NAMESPACE "UnrealSource.Encoding"

FText Utf8()
{
	return LOCTEXT("Utf8", "Café ❄ 港");
}

#undef LOCTEXT_NAMESPACE
