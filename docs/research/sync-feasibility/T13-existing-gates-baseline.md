# T13 — Existing gates baseline

Question: Do existing authoring and localization process gates pass, and what does import/compile cost?

Why it matters for the sync layer: Establish existing correctness and distinguish commandlet synchronization from per-edit live latency.

Method: Installed locked dependencies; selected the already-installed Node 26.9.0 runtime with `UE_SHED_RESEARCH_NODE_EXECUTABLE` (see README); `python research/sync-probe/gates.py prerequisites` executes `pnpm run build:typescript-packages`; `python research/sync-probe/gates.py authoring 5.7`, then `authoring 5.8`, execute exactly `pnpm test:unreal-authoring`; `python research/sync-probe/gates.py localization` executes `pnpm test:localization-processes`, with engine roots set from the manifest for 5.7, 5.8 and 4.27. TEMP/TMP/TMPDIR redirected inside this worktree. `python research/sync-probe/gates_report.py out/loc-processes-ce1947` extracts receipts and saves. Read `scripts/unreal-fixture.ts:33–65` (5.7 pin), `scripts/test-localization-processes.ts:38–53,290–338,343–390` (configured lanes, disposable projects, supported operations). No product source changes.

Results:

| Gate                   | 5.7                                                                                                 | 5.8                                                                    | Other / timing                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Authoring              | PASS: 1 file, 1 test; test 268.24 s, Vitest 268.82 s, entire command 273.08 s                       | UNAVAILABLE: script rejects engine root before tests, exit 1 in 0.54 s | First 5.7 attempt on Node 24 failed missing `@ue-shed/protocol` dist; package build prerequisite then Node 26 rerun passed |
| Localization processes | PASS: supported operations, audit, cancellation, review state, CLI PO apply/sync, key across gather | PASS: same cases                                                       | 4.27 PASS: supported operations, audit and cancellation; all three lanes together 468.29 s including project builds        |

| Engine | Import receipt                                                                     | Compile receipt      | Import + compile |
| ------ | ---------------------------------------------------------------------------------- | -------------------- | ---------------- |
| 5.7    | completed, 16,762 ms                                                               | completed, 16,354 ms | 33,116 ms        |
| 5.8    | completed, 12,943 ms                                                               | completed, 12,973 ms | 25,916 ms        |
| 4.27   | NOT RUN: disposable legacy target has no import operation in its available recipes | completed, 4,365 ms  | Not applicable   |

These are one retained receipt per operation on small localization fixtures, not quantiles or a pure localization computation benchmark. They include supervised commandlet launch/shutdown. Full CLI apply/sync cases execute additional operations; table timings refer only to the explicitly retained import/compile receipts. Receipt plans identify configs and log paths. A passing process gate proves file pipeline behavior, not live editor preview, undo or push observation.

Exact 5.8 failure: `Error: UE_SHED_UNREAL_ENGINE_ROOT must point to Unreal 5.7` at `scripts/unreal-fixture.ts:62`. Research 5.8 native live tests passed independently; the existing gate is still unavailable there. No full portable gate or engine parser matrix was requested/run for this research-only change.

Asset saves: existing authoring test regenerates tracked fixture packages in this worktree. [Asset inventory](evidence/asset-saves.csv) records 72 distinct paths using LogSavePackage lines, tracked byte differences and the two T10 disposable saves; 48 tracked files differed before restoration. All tracked fixture Content was restored with `git checkout -- fixtures/unreal-project/Content`; the subsequent diff was empty. Localization creates disposable copies under `out/loc-processes-ce1947`; their generated artifacts and receipts are ignored evidence, with no tracked asset changes from that lane. T10 disposable DT_Scalars copies were already restored from the original tracked bytes.

Evidence: [Baseline summaries and receipt timings](evidence/T13-baseline.json); [Asset inventory](evidence/asset-saves.csv); raw `out/sync-research/T13-{prerequisites,authoring-5.7,authoring-5.8,localization}.log` and result JSON; initial failure `T13-authoring-5.7-node24-initial.log`; receipts/logs in `out/loc-processes-ce1947/{5.7,5.8,4.27}`. [Journal](JOURNAL.md) records engine PIDs. PID-only process ancestry can misattribute reused PIDs; final independent Win32 process inventory found no Unreal/UE4Editor/ShaderCompile/Zen/crashpad processes. Numeric PID candidates alone are not grounds to terminate another process.

Confidence: high for exit status and retained receipt durations; medium for completeness of save inventory (only actual save logs/differences recorded), low for any extrapolation to live preview.

Surprises / risks found: Authoring gate requires built package exports and pins 5.7. Import + compile is tens of seconds, far beyond per-edit live latency. Fixture regeneration can save packages whose bytes do not change, so `git diff` alone undercounts saves.

Open follow-ups: Support a separately configured 5.8 authoring gate upstream; benchmark larger localization targets and in-editor resource refresh separately; use creation-time-aware process ownership when extending the throwaway harness.
