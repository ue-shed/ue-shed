# T04 — Version coverage
Question: Which requested observation/transaction APIs exist beyond the primary engines?
Why it matters for the sync layer: Separates plausible source compatibility from an actual supported-engine promise.
Method: `python research/sync-probe/version_coverage.py` reads exact declarations from registry/explicit engine manifest; output [CSV](evidence/T04-version-coverage.csv) includes every file and line. Registry paths for 5.5 and 5.6 were checked with Get-Item and rg --files; both directories absent. Probe: none.
Results:

| Hook | 4.27 | 5.3 | 5.5 | 5.6 | 5.7 | 5.8 |
| --- | --- | --- | --- | --- | --- | --- |
| OnObjectTransacted(UObject*, const FTransactionObjectEvent&) | Present | Present | UNVERIFIED | UNVERIFIED | Present | Present |
| OnObjectPropertyChanged(UObject*, FPropertyChangedEvent&) | Present | Present | UNVERIFIED | UNVERIFIED | Present | Present |
| OnObjectModified(UObject*) | Present | Present | UNVERIFIED | UNVERIFIED | Present | Present |
| FOnDataTableChanged() | Ordinary multicast | Ordinary multicast | UNVERIFIED | UNVERIFIED | Ordinary multicast | Thread-safe multicast |
| HandleDataTableChanged(FName = NAME_None) | Present | Present | UNVERIFIED | UNVERIFIED | Present | Present |
| FEditorUndoClient::PostUndo(bool) | Present | Present | UNVERIFIED | UNVERIFIED | Present | Present |
| FEditorUndoClient::PostRedo(bool) | Present | Present | UNVERIFIED | UNVERIFIED | Present | Present |
| PackageDirtyStateChanged(UPackage*) | Present | Present | UNVERIFIED | UNVERIFIED | Present | Present |
| PackageMarkedDirty(UPackage*, bool) | Present | Present | UNVERIFIED | UNVERIFIED | Present | Present |
| FScopedTransaction(context, title, primary, bool=true) | Present | Present; nodiscard annotation | UNVERIFIED | UNVERIFIED | Present; nodiscard | Present; nodiscard |

The 5.5/5.6 registry is stale: `D:\ue5\UE_5.5` and `D:\ue5\UE_5.6` do not exist, including Build.version. Not an absent-API result. Source survey does not compare every payload member or compile/run a cross-version plugin; there is no runtime compatibility claim for 4.27/5.3.

Evidence: [60-record signature CSV](evidence/T04-version-coverage.csv). Initial script failed FileNotFoundError at first 5.5 source; revised to record UNVERIFIED and continued. Primary differences corroborated by T03 complete-file comparisons.
Confidence: high for present declarations and unavailable paths; low for runtime compatibility beyond 5.7/5.8.
Surprises / risks found: Registry discovery must verify disk existence. DataTable TS delegate changes in 5.8; API presence alone cannot validate call coverage.
Open follow-ups: Install/configure actual 5.5/5.6 roots before source comparison; compile/run observer on any additional support candidates.
