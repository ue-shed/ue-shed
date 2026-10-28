// Gather-only. How Unreal reads a source file's encoding: UTF-8 with a byte order mark.

#define LOCTEXT_NAMESPACE "UnrealSource.Encoding"

FText Utf8Bom()
{
	return LOCTEXT("Utf8Bom", "Café ❄ 港");
}

#undef LOCTEXT_NAMESPACE
