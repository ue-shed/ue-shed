// Gather-only. How Unreal's line scanner reads comments, strings and preprocessor blocks.
// Its token counters never restart a partial match, so LLOCTEXT( is not read as LOCTEXT(.

#define LOCTEXT_NAMESPACE "UnrealSource.Lexing"

void Lexing()
{
	/* A block comment
	LOCTEXT("InSpanningComment", "inside a block comment over lines") */
	LOCTEXT("AfterComment", "After a block comment over lines");
	const TCHAR* Continued = TEXT("a string continued \
LOCTEXT(\"InContinuedString\", \"inside a continued string\")");
	LOCTEXT("AfterContinued", "After a continued string");
	const TCHAR* RawLines = TEXT(R"json(
LOCTEXT("InRawLines", "inside a raw string over lines")
)json");
	LOCTEXT("AfterRaw", "After a raw string over lines");
	const TCHAR QuoteChar = '"'; LOCTEXT("AfterQuoteChar", "After a quote character");
	const TCHAR* Backslash = TEXT("\\"); LOCTEXT("AfterBackslash", "After an escaped backslash");
	LLOCTEXT("Doubled", "A doubled first letter");
	LOCTEXT("Continued", "First half " \
		"second half");
	LOCTEXT("TwoOnALine", "First on the line"); LOCTEXT("SecondOnALine", "Second on the line");
}

#if WITH_EDITOR
FText EditorBranch() { return LOCTEXT("EditorBranch", "Editor-only, before #else"); }
#else
FText ElseBranch() { return LOCTEXT("ElseBranch", "After #else, runtime text"); }
#endif

#if SOME_FLAG
FText FlagBranch() { return LOCTEXT("FlagBranch", "Runtime text under another flag"); }
#elif WITH_EDITORONLY_DATA
FText ElifBranch() { return LOCTEXT("ElifBranch", "Editor-only through #elif"); }
#endif

#ifdef WITH_EDITOR
FText IfdefBranch() { return LOCTEXT("IfdefBranch", "Editor-only through #ifdef"); }
#endif

#undef LOCTEXT_NAMESPACE
