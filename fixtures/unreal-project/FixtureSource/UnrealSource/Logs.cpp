// Gather-only, UE 5.x. Localized structured logs gather key and format; the NSLOC forms take an
// explicit namespace after the verbosity, and the CLOG forms add a condition first.

#define LOCTEXT_NAMESPACE "UnrealSource.Logs"

void Logs(bool bFailed)
{
	UE_LOGFMT_LOC(LogTemp, Warning, "TideLate", "The tide is late by {Minutes} minutes", Minutes);
	UE_LOGFMT_NSLOC(LogTemp, Warning, "UnrealSource.LogsExplicit", "TideEarly", "The tide is early");
	UE_CLOGFMT_LOC(bFailed, LogTemp, Error, "TideFailed", "The tide table failed to load");
}

#undef LOCTEXT_NAMESPACE
