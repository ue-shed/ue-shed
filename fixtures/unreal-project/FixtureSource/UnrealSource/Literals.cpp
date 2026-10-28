// Gather-only. How Unreal reads a macro's arguments: adjacent literals join, a call can span
// lines, escapes decode, raw strings and comments cannot close a call early, and only literal,
// non-empty arguments gather.

#define LOCTEXT_NAMESPACE "UnrealSource.Literals"

static const TCHAR* KeyConstant = TEXT("FromConstant");

void Literals()
{
	LOCTEXT("Joined", "Two literals " "become one");
	LOCTEXT(
		"Spanning",
		"A call over several lines"
	);
	LOCTEXT("Escapes", "Tab\there, quote \" and backslash \\ and newline\nend");
	LOCTEXT("Hex", "Snow \x2744 and été");
	LOCTEXT("WithText", TEXT("Inside TEXT()"));
	LOCTEXT /* a comment before the bracket */ ("Commented", "A comment between name and bracket");
	const TCHAR* Raw = TEXT(R"raw(LOCTEXT("InRaw", "inside a raw string") ) " )raw");
	// LOCTEXT("InLineComment", "inside a line comment")
	/* LOCTEXT("InBlockComment", "inside a block comment") */
	const TCHAR* Quoted = TEXT("LOCTEXT(\"InString\", \"inside a string\")");
	MYLOCTEXT("Prefixed", "a longer name is not LOCTEXT");
	LOCTEXT2("Suffixed", "nor is a suffixed one");
	LOCTEXT("", "An empty key gathers nothing");
	LOCTEXT("EmptySource", "");
	LOCTEXT("Blank", "   ");
	LOCTEXT(KeyConstant, "A constant key gathers nothing");
	LOCTEXT("TooMany", "Three", "arguments");
}

#undef LOCTEXT_NAMESPACE
