// Gather-only, UE 5.x. Entries of a table this file never registers are dropped with a warning.
// UE 4.27's gather crashes on such a file (access violation), so its recipe excludes this one.

void RegisterElsewhere()
{
	LOCTABLE_SETSTRING("UnrealSource.Unregistered", "Lost", "An entry of a table never registered here");
}
