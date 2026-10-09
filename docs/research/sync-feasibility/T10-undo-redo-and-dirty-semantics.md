# T10 — Undo/redo and dirty semantics
Question: Does one five-table transaction restore content, dirty flags and history across Save?
Why it matters for the sync layer: Local optimistic undo must not compete with Unreal's authoritative transaction buffer.
Method: Fresh editor per engine; `python research/sync-probe/live.py 5.7 undo` then 5.8. Snapshots before Apply, after Undo, Redo, Save+Undo compared exactly by engine fingerprints. GetCounts records queueLength, undoCount (number currently undone, **not total undo entries**) and buffer bytes. Each event records current package dirty. Save uses UPackage::SavePackage on the disposable DT_Scalars copy only. Minimize via windows.py and perform fresh Apply/Undo/Redo through RC. Undo buffer source: EditorServer.cpp 5.7:1244–1254 / 5.8:1255–1265; TransBuffer.h:69–116 eviction; EditorTransaction.cpp:25–51,832–842 dirty save fence.
Results:

| Engine | Queue before → after Apply | Undo matches baseline | Redo matches edited state | Save+Undo matches baseline | Dirty after Save+Undo |
| --- | --- | --- | --- | --- | --- |
| 5.7 | 0 → 1 | True (5/5) | True (5/5) | True (5/5) | scalar dirty=true; others false |
| 5.8 | 0 → 1 | True (5/5) | True (5/5) | True (5/5) | scalar dirty=true; others false |

Before Save, all five packages became clean on Undo and dirty on Redo. Save did not clear history: queueLength stayed 1 and buffer bytes stayed 3042 on both engines; Undo remained available. Initial undoBytes=0, after Apply=3042, after Undo=2954; bytes differ with captured state. Runtime logs report **256 MB** undo buffer on each engine. Source uses configurable `[Undo] UndoBufferSize` with 256 MB fallback and memory eviction; saturation/old-entry eviction not forced here.

Canceled transaction left Scalar_Alpha.Count=55 and changed fingerprint, with no new queue entry. Cancel is not rollback. Minimized 5.8 Undo/Redo succeeded. 5.7 minimized follow-up details retained in T10-unfocused-rpc.jsonl and native window evidence; initial attempt had no remaining undoable entry (false Undo, true Redo), then a fresh entry was used.

Only disposable scalar copies were saved/restored. No tracked fixture asset was saved in these live tasks.

Evidence: [Compact fingerprint/dirty/buffer proof](evidence/T10-proof.json); per engine raw `undo-summary.json`, `undo-events.jsonl`, `T10-rpc.jsonl`, `T10-unfocused-rpc.jsonl`, `window-state.jsonl`, editor.log (Undo buffer set to 256 MB).
Confidence: high for five-table restoration and Save/dirty semantics; buffer eviction behavior source-only.
Surprises / risks found: Package dirty is not equivalent to current content equals an arbitrary earlier baseline after Save. Canceled changes remain observable through table delegate but lack finalized transaction events. A package saved during a multi-table edit has a different dirty fence from the other packages.
Open follow-ups: Exercise saturated history and interactive transaction cancellation; test Undo in modal/PIE states; scope read-only/leased UI reconciliation to engine history.
