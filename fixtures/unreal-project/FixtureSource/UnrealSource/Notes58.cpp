// Gather-only, UE 5.8. Developer notes travel with the entry; UE 5.7 and 4.27 have no such
// macros, so their gathers find nothing in this file.

#define LOCTEXT_NAMESPACE "UnrealSource.Notes"

void Notes()
{
	NOTELOCTEXT("Anchor", "Drop anchor", "Shown when the ship stops");
	NSNOTELOCTEXT("UnrealSource.NotesExplicit", "Sail", "Raise the sails", "A command, not a noun");
	LOCTABLE_NEW("UnrealSource.Logbook", "UnrealSource.LogbookTable");
	LOCTABLE_SETNOTESTRING("UnrealSource.Logbook", "Entry", "A new logbook entry", "Title of the logbook page");
}

UE_DECLARE_ERROR(UNREALSOURCE_API, UnrealSourceErrors, 1, HarborFull, "The harbor is full");

#undef LOCTEXT_NAMESPACE
