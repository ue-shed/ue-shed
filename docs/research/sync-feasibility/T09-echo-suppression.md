# T09 â€” Echo suppression

Question: Can current Apply events be distinguished from other edits and from undo/redo?

Why it matters for the sync layer: Optimistic confirmations must correlate precisely without suppressing later editor undo.

Method: Analyze T08 Apply/Undo/Redo marked windows on 5.7 then 5.8; exact event IDs/title/context extracted to evidence/T09-provenance.json. Read product UEShedAuthoringLibrary.cpp:1759 and transaction context/ID APIs in T03. No product instrumentation added.

Results:

| Engine | Apply provenance                                                                                      | Undo/Redo                                                           |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 5.7    | Five object events share one transaction and operation ID; title Apply authoring draft; context empty | Same transaction ID, new distinct operation IDs, eventType UndoRedo |
| 5.8    | Same behavior with different GUIDs                                                                    | Same stable-entry/new-operation behavior                            |

Current public events contain **no UE Shed request operationId**. Title is descriptive, not unique provenance. An unrelated script can choose the same title; therefore reliable current suppression is **UNVERIFIED**. Probe-created transactions demonstrate a nonempty context UEShedSyncProbe at finalization. Its undo/redo retention is source-supported by T03 but was not exercised in this matrix. This supports a future tagged-context + engine transaction/request map or a scoped authority-side Apply flag, but the flag/mapping was not implemented or tested. Five-table Apply generated exactly five finalized object notifications; coalescing by engine operation ID works in these samples. PostTransactionFinalized carries a zero operation ID and empty title; use TransactionFinalized / UndoRedoFinalized and capture context before cleanup. Never suppress every future event carrying a previously-seen transaction ID: that loses undo/redo.

Later T12 supplement: a custom-context transaction **does retain UEShedSyncProbe through Undo and Redo on both engines**, with stable transaction ID and new operation IDs. [Exact tagged-context events](evidence/T09-tagged-context-supplement.json) replace the earlier source-only uncertainty about context retention. This tests the probe's own tagged property edit, not request-ID correlation for the current untagged product Apply. The current product attribution limitation remains.

Evidence: [Extracted provenance](evidence/T09-provenance.json); [Tagged-context supplement](evidence/T09-tagged-context-supplement.json); [T08](T08-observation-matrix.md), [T12](T12-concurrent-editing.md); raw matrix-events.jsonl and T08-rpc.jsonl per engine.

Confidence: high for GUID/context/title observations; low for collision-safe request correlation, not implemented.

Surprises / risks found: No source request ID in hook payload; title matching insufficient. Stored context can be overwritten by PostTransactionFinalized cleanup. Confirmations and undo use different operation IDs.

Open follow-ups: Authority-side scoped provenance and explicit request-to-engine-operation correlation; test title collision and reentrant edits.
