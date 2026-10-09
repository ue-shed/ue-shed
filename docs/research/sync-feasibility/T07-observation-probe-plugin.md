# T07 — Observation probe plugin
Question: Can an isolated observer compile and run on both primary engines?
Why it matters for the sync layer: Runtime evidence must distinguish actual hook broadcasts from declarations and assumptions.
Method: Throwaway plugin at `research/sync-probe/UEShedSyncProbe`; preparation/build/launch at `research/sync-probe/fixture.py`; HTTP client at `research/sync-probe/rc.py`. Read existing plugin descriptors/Build.cs, `scripts/unreal-fixture.ts:123–133,205–235`, `scripts/unreal-plugin-host.ts`, `scripts/test-uasset-engine-matrix.ts:198–227`, and `packages/engine/src/remote-control-permissions.ts:24–40`. Commands: `python research/sync-probe/fixture.py prepare 5.7`, repeat 5.8; `build 5.7`, then `build 5.8`; `launch 5.7`; `python research/sync-probe/rc.py 5.7`. Copies fixture excluding build/cache directories, sets copied EngineAssociation, stages Core/Authoring/probe into copied Plugins. Uses repository Build.bat target/arguments and RC ports, but bypasses the main script's 5.7 contract check for a disposable 5.8 copy. No product sources edited.
Results:

| Engine | Build | Runtime smoke |
| --- | --- | --- |
| 5.7.4 | Final build succeeded, 6.42 s after source correction | 12 tables watched; RC counts/snapshot succeed; gameThread=true; undo queue initially empty |
| 5.8.3 | First build succeeded, 64.78 s; instrumentation rebuild 14.38 s | Scheduled in T08; build alone is not runtime evidence |

Probe logs every requested global hook, transaction state, registered undo callbacks and per-table delegates to copied project's `Saved/SyncProbe/events.jsonl`. Fields include high-resolution monotonic time, UTC, thread, object/class/package, dirty, property/change type, transaction event/type IDs and captured title/context. Synchronous JSONL writes add measurement overhead. Mark enables observation; Clear stops it. Scenarios use editor C++ APIs, not simulated mouse input. Reload does not subscribe anew to replacement tables; put reload last and restart for later tasks. State maps/lifetimes are sufficient for these game-thread scenarios, not a production observer.
Evidence: `out/sync-research/5.7/build-1791513806.log` (first failure), `build-1791513875.log`, `build-1791513964.log`; 5.8 exact log filenames in [JOURNAL](JOURNAL.md); `out/sync-research/5.7/T07-smoke-rpc.jsonl`; [API comparison](evidence/T07-source-comparison.txt). All launch PIDs and termination results are journaled.
Confidence: high for both builds and 5.7 smoke; 5.8 runtime unverified until T08.
Surprises / risks found: First 5.7 compile failed C1083 for guessed `Settings/EditorPerformanceSettings.h`; located actual `Editor/EditorPerformanceSettings.h` and corrected probe. UE 5.8 RC needs an allowlist; launch supplies exact Authoring/probe API classes. Initial background throttle explicitly disabled.
Open follow-ups: Both runtime matrices; replacement-object resubscription; unusual off-thread events.
