// Gather-only. String Tables declared in code: the first definition of a table, entry or metadata
// key wins, and LOCTABLE_FROMFILE_GAME imports a CSV under Content/ as the table's entries.
// INVTEXT and FText::FromString are culture-invariant and never gathered.

void RegisterTables()
{
	LOCTABLE_NEW("UnrealSource.Harbor", "UnrealSource.HarborTable");
	LOCTABLE_SETSTRING("UnrealSource.Harbor", "Berth", "A berth is free");
	LOCTABLE_SETSTRING("UnrealSource.Harbor", "Berth", "A later duplicate is ignored");
	LOCTABLE_SETMETA("UnrealSource.Harbor", "Berth", "Comment", "Shown on the harbor board");

	LOCTABLE_FROMFILE_GAME("UnrealSource.Cargo", "UnrealSource.CargoTable", "Fixture/UnrealSource/Cargo.csv");
	LOCTABLE_FROMFILE_GAME("UnrealSource.Crew", "UnrealSource.CrewTable", "Fixture/UnrealSource/CrewUtf16.csv");

	const FText Invariant = INVTEXT("Culture-invariant, never gathered");
	const FText FromString = FText::FromString(TEXT("Not localizable, never gathered"));
}
