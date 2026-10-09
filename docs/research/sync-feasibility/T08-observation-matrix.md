# T08 — Observation matrix

Question: Which real scripted editor actions broadcast the available hooks?

Why it matters for the sync layer: Reverse synchronization must observe every supported editing path and define blind spots.

Method: `python research/sync-probe/live.py 5.7 matrix`; close editor; launch 5.8; `python research/sync-probe/live.py 5.8 matrix`; `python research/sync-probe/analyze.py`. Mark delimiters isolate scenarios. C++ helpers in probe implement FDataTableEditorUtils row actions and PreEditChange/PostEditChangeProperty dataasset/actor equivalents. Interactive scenario emits three Interactive events and SnapshotTransactionBuffer, then ValueSet. It is a scripted equivalent, not an actual slider drag. RC writes wait 1.5s before next marker to capture delayed finalization. Five tables: Scalars, ScalarsOverride, Structs, RightReferences, Text. Counts include dependent CompositeDataTable events and auxiliary objects; they are not one notification per requested table. CSV retains exact event types/properties. Raw mutation success alone is not UI observation.

Results:

**UE 5.7: counts across all observed objects in each scenario window**

| Source                      | Modified | Property | Transacted | Table | Dirty transition | Marked dirty | PostUndo | PostRedo | Tx state | Thread | Property / transacted names                         |
| --------------------------- | -------- | -------- | ---------- | ----- | ---------------- | ------------ | -------- | -------- | -------- | ------ | --------------------------------------------------- |
| apply-one                   | 1        | 0        | 1          | 0     | 1                | 1            | 0        | 0        | 4        | game   | — / Enabled                                         |
| apply-five                  | 5        | 0        | 5          | 0     | 4                | 5            | 0        | 0        | 4        | game   | — / Description;DisplayName;Enabled;Label;Nested    |
| undo-five                   | 9        | 9        | 5          | 18    | 4                | 0            | 1        | 0        | 2        | game   | None / Description;DisplayName;Enabled;Label;Nested |
| redo-five                   | 9        | 9        | 5          | 18    | 4                | 0            | 0        | 1        | 2        | game   | None / Description;DisplayName;Enabled;Label;Nested |
| dataasset-property          | 1        | 1        | 1          | 0     | 1                | 2            | 0        | 0        | 4        | game   | Value / Value                                       |
| actor-property              | 1        | 1        | 1          | 0     | 1                | 2            | 0        | 0        | 4        | game   | Value / Value                                       |
| rc-WRITE_ACCESS             | 2        | 1        | 0          | 0     | 0                | 2            | 0        | 0        | 0        | game   | Value / —                                           |
| rc-WRITE_TRANSACTION_ACCESS | 2        | 1        | 1          | 0     | 0                | 2            | 0        | 0        | 4        | game   | Value / Value                                       |
| cell                        | 1        | 0        | 1          | 3     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled                                   |
| row-add                     | 1        | 0        | 1          | 6     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled;Key;Notes;Ratio                   |
| row-rename                  | 1        | 0        | 1          | 3     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled;Key;Notes;Ratio                   |
| row-reorder                 | 1        | 0        | 1          | 3     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled;Key;Notes;Ratio                   |
| row-remove                  | 1        | 0        | 1          | 3     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled;Key;Notes;Ratio                   |
| cancel                      | 1        | 0        | 0          | 3     | 0                | 1            | 0        | 0        | 2        | game   | — / —                                               |
| raw-cell                    | 0        | 0        | 0          | 0     | 0                | 0            | 0        | 0        | 0        | —      | — / —                                               |
| interactive                 | 1        | 4        | 4          | 0     | 0                | 2            | 0        | 0        | 4        | game   | Value / Value                                       |
| save                        | 0        | 0        | 0          | 0     | 1                | 0            | 0        | 0        | 0        | game   | — / —                                               |
| reload                      | 3        | 4        | 0          | 1     | 0                | 0            | 0        | 0        | 0        | game   | None / —                                            |
| counts                      | 0        | 0        | 0          | 0     | 0                | 0            | 0        | 0        | 0        | —      | — / —                                               |

**UE 5.8: counts across all observed objects in each scenario window**

| Source                      | Modified | Property | Transacted | Table | Dirty transition | Marked dirty | PostUndo | PostRedo | Tx state | Thread | Property / transacted names                         |
| --------------------------- | -------- | -------- | ---------- | ----- | ---------------- | ------------ | -------- | -------- | -------- | ------ | --------------------------------------------------- |
| apply-one                   | 1        | 0        | 1          | 0     | 1                | 1            | 0        | 0        | 4        | game   | — / Enabled                                         |
| apply-five                  | 5        | 0        | 5          | 0     | 4                | 5            | 0        | 0        | 4        | game   | — / Description;DisplayName;Enabled;Label;Nested    |
| undo-five                   | 9        | 9        | 5          | 18    | 4                | 0            | 1        | 0        | 2        | game   | None / Description;DisplayName;Enabled;Label;Nested |
| redo-five                   | 9        | 9        | 5          | 18    | 4                | 0            | 0        | 1        | 2        | game   | None / Description;DisplayName;Enabled;Label;Nested |
| dataasset-property          | 1        | 1        | 1          | 0     | 1                | 2            | 0        | 0        | 4        | game   | Value / Value                                       |
| actor-property              | 1        | 1        | 1          | 0     | 1                | 2            | 0        | 0        | 4        | game   | Value / Value                                       |
| rc-WRITE_ACCESS             | 2        | 1        | 0          | 0     | 0                | 2            | 0        | 0        | 0        | game   | Value / —                                           |
| rc-WRITE_TRANSACTION_ACCESS | 2        | 1        | 1          | 0     | 0                | 2            | 0        | 0        | 4        | game   | Value / Value                                       |
| cell                        | 1        | 0        | 1          | 3     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled                                   |
| row-add                     | 1        | 0        | 1          | 6     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled;Key;Notes;Ratio                   |
| row-rename                  | 1        | 0        | 1          | 3     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled;Key;Notes;Ratio                   |
| row-reorder                 | 1        | 0        | 1          | 3     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled;Key;Notes;Ratio                   |
| row-remove                  | 1        | 0        | 1          | 3     | 0                | 1            | 0        | 0        | 4        | game   | — / Count;Enabled;Key;Notes;Ratio                   |
| cancel                      | 1        | 0        | 0          | 3     | 0                | 1            | 0        | 0        | 2        | game   | — / —                                               |
| raw-cell                    | 0        | 0        | 0          | 0     | 0                | 0            | 0        | 0        | 0        | —      | — / —                                               |
| interactive                 | 1        | 4        | 4          | 0     | 0                | 2            | 0        | 0        | 4        | game   | Value / Value                                       |
| save                        | 0        | 0        | 0          | 0     | 1                | 0            | 0        | 0        | 0        | game   | — / —                                               |
| reload                      | 3        | 4        | 0          | 1     | 0                | 0            | 0        | 0        | 0        | game   | None / —                                            |
| counts                      | 0        | 0        | 0          | 0     | 0                | 0            | 0        | 0        | 0        | —      | — / —                                               |

All recorded hooks in both runs were on the game thread. Event type integers: UndoRedo=0, Finalized=1, Snapshot=2. Property Changed `None` means the event carried no property. A raw pointer cell mutation fired zero requested hooks. Apply itself fired transaction notifications but **zero per-table change delegates and zero property-change events**. Save only produced a dirty transition among these hooks. Cancel generated TransactionStarted/Canceled and table events, but no finalized transaction; it leaves mutated bytes (confirmed separately in T10). Reload has no transaction and the old per-table subscription does not transfer to the replacement object.

Native row serialization produced property names in transaction events despite RowMap not being a UPROPERTY: one Count cell scenario named **Count and Enabled**, add/remove/reorder named all scalar fields, and Label-only edit also named Nested. These names are coarse and can include untouched fields; no row name or old/new field value appeared. Source-only assumptions that native rows necessarily give an empty property list are contradicted by these logs. Diffing remains necessary to identify exact cells.

**NEEDS HUMAN:** real DataTable editor cell controls, modal dialogs, PIE interactions, genuine mouse slider pacing and a dirty-package reload/revert. Reproduce with Mark, perform the UI operation, then inspect the same JSONL. Scripted reload here followed Save, so it reloads a clean package, not an unsaved revert.

Later T12 supplement successfully exercises **scripted dirty revert** on both engines, restores the original fingerprint and clears dirty. The earlier clean-reload-only limitation above describes this matrix run; genuine UI clicks remain untested. T12 also adds FText/String Table observation and tagged-context undo/redo evidence. [Supplement](T12-concurrent-editing.md).

Evidence: [5.7 CSV](evidence/T08-5.7-matrix.csv), [5.8 CSV](evidence/T08-5.8-matrix.csv), [5.7 sample](evidence/T08-5.7-sample.jsonl), [5.8 sample](evidence/T08-5.8-sample.jsonl). Raw `out/sync-research/{5.7,5.8}/matrix-events.jsonl`, `matrix-summary.json`, `T08-rpc.jsonl`.

Confidence: high for exact scripted runs on both engines; low for real UI/modal/PIE equivalence, explicitly untested.

Surprises / risks found: Apply has no table delegate signal; transaction field lists are broader than true cells. Delegate multiplicity includes dependent tables. Pointer writes evade the whole observer. Saved only the disposable DT_Scalars.uasset copies; tracked content untouched.

Open follow-ups: Test actual widgets and reload/revert of unsaved content; add package reload lifecycle observation/resubscription; coalesce finalized/undo notifications once per operation.
