# T11 — Latency and throughput

Question: Are per-edit RC Apply and reverse observation fast enough, including large tables and background operation?

Why it matters for the sync layer: One-cell target is ≤100 ms p95; background and whole-table cost can determine feasibility.

Method: `python research/sync-probe/windows.py VERSION focus`; `python research/sync-probe/live.py VERSION perf focused`; minimize and run `perf minimized-throttle-off`; `rc.Client.scenario('throttle', value=True)` and run `perf minimized-throttle-on`. 5.7 first, then 5.8; one editor per engine retained between modes. windows.py records Win32 foreground PID and IsIconic. Ten no-op warmups, then 40 interleaved rounds per mode, each with no-op, one-cell small-table Apply, five small-table Apply, large snapshot and one-cell large Apply, followed by 200 sequential one-cell small-table Applies. Mutation IDs unique, fresh fingerprints/returned confirmations used. Nearest-rank p50/p95/max. Timer covers urllib HTTP request/response body read; excludes response JSON decoding and raw-client logging after read, includes request encoding; game-thread synchronous probe JSONL writing remains enabled. No concurrent builds/gates during measurements. Record engine setting from GetCounts, not requested label alone. Background source EditorEngine.cpp 5.7:5025–5068 / 5.8:5316–5359 includes foreground/focus checks, disable-throttling delegates and loading/shader exemptions; UI RC warning in SRemoteControlPanel.cpp:666–689 both versions.

Results:

All numbers in ms. The full 40-round/200-sequential datasets below launch with **-unattended**, which bypasses CPU throttling at `EditorEngine.cpp 5.7:5014–5023 / 5.8:5305–5314`. 5.8 has one full visible/unfocused dataset; redundant unattended minimized large-table runs were skipped after this source finding. Normal-editor background effects were instead tested directly below. **The requested focused mode failed foreground activation on both engines where native evidence says unfocused. Those rows are visible/unfocused measurements; actual focused performance remains UNVERIFIED.**

| Engine | Requested mode (actual state)                 | Throttle setting | Operation      | n   | p50    | p95    | max    |
| ------ | --------------------------------------------- | ---------------- | -------------- | --- | ------ | ------ | ------ |
| 5.7    | focused (unfocused, visible)                  | False            | noop           | 40  | 7.6    | 30.6   | 37.2   |
| 5.7    | focused (unfocused, visible)                  | False            | one            | 40  | 18.6   | 33.4   | 37.0   |
| 5.7    | focused (unfocused, visible)                  | False            | five           | 40  | 29.8   | 36.0   | 38.6   |
| 5.7    | focused (unfocused, visible)                  | False            | large-snapshot | 40  | 891.5  | 928.1  | 979.2  |
| 5.7    | focused (unfocused, visible)                  | False            | large-apply    | 40  | 2000.6 | 2049.1 | 2224.6 |
| 5.7    | minimized-throttle-off (unfocused, minimized) | False            | noop           | 40  | 5.6    | 19.5   | 31.1   |
| 5.7    | minimized-throttle-off (unfocused, minimized) | False            | one            | 40  | 11.9   | 34.7   | 37.0   |
| 5.7    | minimized-throttle-off (unfocused, minimized) | False            | five           | 40  | 12.0   | 37.8   | 38.2   |
| 5.7    | minimized-throttle-off (unfocused, minimized) | False            | large-snapshot | 40  | 887.5  | 934.2  | 955.7  |
| 5.7    | minimized-throttle-off (unfocused, minimized) | False            | large-apply    | 40  | 2012.1 | 2108.9 | 2149.7 |
| 5.7    | minimized-throttle-on (unfocused, minimized)  | True             | noop           | 40  | 7.0    | 27.1   | 34.5   |
| 5.7    | minimized-throttle-on (unfocused, minimized)  | True             | one            | 40  | 18.4   | 27.1   | 27.5   |
| 5.7    | minimized-throttle-on (unfocused, minimized)  | True             | five           | 40  | 19.6   | 36.8   | 37.7   |
| 5.7    | minimized-throttle-on (unfocused, minimized)  | True             | large-snapshot | 40  | 890.2  | 969.2  | 997.0  |
| 5.7    | minimized-throttle-on (unfocused, minimized)  | True             | large-apply    | 40  | 2018.2 | 2111.0 | 2341.6 |
| 5.8    | focused (unfocused, visible)                  | False            | noop           | 40  | 9.0    | 31.2   | 39.4   |
| 5.8    | focused (unfocused, visible)                  | False            | one            | 40  | 17.2   | 33.8   | 37.0   |
| 5.8    | focused (unfocused, visible)                  | False            | five           | 40  | 21.1   | 38.8   | 43.8   |
| 5.8    | focused (unfocused, visible)                  | False            | large-snapshot | 40  | 856.6  | 905.9  | 933.9  |
| 5.8    | focused (unfocused, visible)                  | False            | large-apply    | 40  | 2020.6 | 2101.8 | 2164.2 |

DT_LargeScalars contains 10,000 rows. Five-table batch uses Scalars, ScalarsOverride, Structs, RightReferences and Text (small tables); large Apply is measured separately. These are loopback RC timings on this machine, not full client UI latency, WAN measurements or guarantees. First visible/unfocused 5.7 mode retained full large responses in raw log; later modes retain byte-size/SHA256 summaries to avoid repeated huge payloads. Client logging lies outside timer but changes pacing.

**200 sequential small-table edits per mode** (p50/p95/max in ms; RSS in MiB):

| Engine | Mode                   | Apply times        | Queue entries | Undo bytes            | Process physical MiB |
| ------ | ---------------------- | ------------------ | ------------- | --------------------- | -------------------- |
| 5.7    | focused                | 20.5 / 35.7 / 38.2 | 121 → 321     | 58949573 → 59072173   | 6445.9 → 5651.8      |
| 5.7    | minimized-throttle-off | 10.8 / 33.5 / 37.8 | 441 → 641     | 118020853 → 118143453 | 8170.6 → 7378.0      |
| 5.7    | minimized-throttle-on  | 23.7 / 33.3 / 34.0 | 761 → 961     | 177092133 → 177214733 | 9915.0 → 9122.3      |
| 5.8    | focused                | 25.3 / 34.9 / 36.2 | 120 → 320     | 58949124 → 59071724   | 6672.1 → 5879.4      |

Memory is process-level, not a precise allocation measurement of backups. Apply cache is bounded to 128 operation results (`UEShedAuthoringLibrary.cpp:1346–1358`), so the 200 small edits evict earlier large cached results; GC and retained transactions also affect RSS. Undo queue/bytes isolate history growth better than RSS. No claim about peak duplicate-table allocation or time isolated to fingerprinting can be made from these numbers. Large Apply aggregates backups, fingerprinting, mutation, engine serialization and HTTP response transfer.

**Editor-side hook latency:** one sample per scripted case, from immediately-before-value-write MutationStart timestamp to first same-object hook; includes writing the marker and is not network push latency.

| Engine | Source → hook                        | ms    |
| ------ | ------------------------------------ | ----- |
| 5.7    | cell → DataTableChanged              | 0.396 |
| 5.7    | dataasset-property → PropertyChanged | 0.239 |
| 5.7    | actor-property → PropertyChanged     | 0.154 |
| 5.7    | interactive → PropertyChanged        | 0.112 |
| 5.8    | cell → DataTableChanged              | 0.126 |
| 5.8    | dataasset-property → PropertyChanged | 0.107 |
| 5.8    | actor-property → PropertyChanged     | 0.142 |
| 5.8    | interactive → PropertyChanged        | 0.113 |

**Normal editors without -unattended:** Set PowerShell env UE_SHED_RESEARCH_EDITOR_UNATTENDED to 0, then `python research/sync-probe/fixture.py launch VERSION`; `python research/sync-probe/policy.py VERSION visible-off`, then visible-on; minimize and run minimized-off/on. Each has 40 no-op and 40 one-cell trials. Captures effective ShouldThrottleCPUUsage, FApp focus, native foreground, setting and unattended flag before/after. No large-table or five-table normal-policy trials in these short runs.

| Engine | Mode/setting  | Effective throttle | App focus | Operation | p50   | p95   | max   |
| ------ | ------------- | ------------------ | --------- | --------- | ----- | ----- | ----- |
| 5.7    | visible-off   | False              | False     | noop      | 15.9  | 26.5  | 33.5  |
| 5.7    | visible-off   | False              | False     | one       | 11.6  | 34.4  | 36.5  |
| 5.7    | visible-on    | True               | False     | noop      | 330.7 | 331.4 | 332.7 |
| 5.7    | visible-on    | True               | False     | one       | 335.2 | 336.2 | 336.4 |
| 5.7    | minimized-off | True               | False     | noop      | 330.6 | 331.5 | 332.2 |
| 5.7    | minimized-off | True               | False     | one       | 335.3 | 335.7 | 337.4 |
| 5.7    | minimized-on  | True               | False     | noop      | 330.7 | 331.1 | 332.5 |
| 5.7    | minimized-on  | True               | False     | one       | 335.3 | 335.8 | 338.8 |
| 5.8    | visible-off   | False              | False     | noop      | 8.4   | 32.2  | 34.7  |
| 5.8    | visible-off   | False              | False     | one       | 10.9  | 28.6  | 30.6  |
| 5.8    | visible-on    | True               | False     | noop      | 330.5 | 331.7 | 335.4 |
| 5.8    | visible-on    | True               | False     | one       | 335.5 | 340.5 | 344.0 |
| 5.8    | minimized-off | True               | False     | noop      | 330.7 | 331.3 | 332.0 |
| 5.8    | minimized-off | True               | False     | one       | 335.3 | 336.4 | 337.4 |
| 5.8    | minimized-on  | True               | False     | noop      | 330.4 | 331.0 | 332.7 |
| 5.8    | minimized-on  | True               | False     | one       | 335.4 | 335.9 | 336.9 |

Visible/unfocused with the setting disabled passes the target. Enabled setting and all-windows-minimized cases miss it. A minimized editor throttles even when the checkbox is false. Source offers disable-throttling delegates before the focus/minimized checks (`EditorEngine.cpp:5025–5032 / 5316–5323`); using a scoped delegate during a sync lease is a **proposed workaround, not tested**. Do not infer normal-editor latency from unattended runs.

Evidence: [Compact timings/state/memory](evidence/T11-performance.json); raw `out/sync-research/{5.7,5.8}/perf-*-summary.json`, `T11-rpc.jsonl`, `policy-*.json`, `T11-policy-rpc.jsonl`, `window-state.jsonl`, matrix-events.jsonl. Each mode has explicit before/after native window state and engine throttle setting.

Confidence: high for measured loopback modes and sample quantiles; low for actual focused performance and isolated allocation causality.

Machine context is recorded in [environment.json](evidence/environment.json). No-op means the probe's `Scenario({action:"noop"})` early return, not a zero-change Apply or GetCounts. Cached/idempotent/no-change Apply observation was not benchmarked as an edit source.

Surprises / risks found: Large-table whole snapshots/Apply may miss the live target badly even when small edits pass. Enabling background throttle can dominate HTTP timing; minimized windows can also trigger source throttling independently of setting. Focus activation failed in the unattended desktop. RSS decreases do not prove edits are cheap.

Open follow-ups: Profile large Apply CPU/allocation stages; test delta confirmations/observations as a separate spike; repeat focused after a human unlocks/activates the desktop; verify steady-state long-session history and more table shapes. Effective background policy should be instrumented directly, not inferred solely from the setting.
