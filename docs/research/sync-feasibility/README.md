# Live editor synchronization feasibility

Research only. No product implementation was changed. Start with [FINDINGS.md](FINDINGS.md), then follow task/evidence links. Both primary engines were compiled and live-tested. Source findings, runtime observations and untested proposals are distinguished throughout.

Base: `origin/main` at `3d027eb8` (full hash in evidence/context.txt). Design: `origin/docs/standalone-sync-design`, direction revision 2026-10-09; older sections are historical.

## Engine installations used

| Engine | Root             | Discovery                                                                        |
| ------ | ---------------- | -------------------------------------------------------------------------------- |
| 4.27   | `D:\ue5\UE_4.27` | HKLM EpicGames registry                                                          |
| 5.3    | `D:\ue5\UE_5.3`  | HKLM EpicGames registry                                                          |
| 5.5    | `D:\ue5\UE_5.5`  | Stale registry entry; directory absent, UNVERIFIED                               |
| 5.6    | `D:\ue5\UE_5.6`  | Stale registry entry; directory absent, UNVERIFIED                               |
| 5.7.4  | `D:\ue5\UE_5.7`  | HKLM EpicGames registry; CL 51494982, compatible CL 47537391                     |
| 5.8.3  | `D:\ue5\UE_5.8`  | Explicit user configuration; not registered; CL 58210709, compatible CL 55116800 |

Paths are evidence of this machine, never runtime defaults. Probe/scripts take engine configuration from environment or the generated uncommitted `out/sync-research/engines.json` manifest.

[Machine context](evidence/environment.json): Ryzen 9 5950X, 32 logical processors, approximately 64 GiB physical RAM, RTX 3060 Ti plus virtual display, High performance power scheme. Recorded after benchmarks; it is context, not proof of unchanged scheduling conditions throughout them.

## Reproduction and evidence

Worktree: `D:\git\ue-shed-sync-research`, branch `research/sync-feasibility`. Run commands from this worktree. Source references are relative to the engine root and include 1-based line numbers. Repository references are relative to the worktree. Raw logs under `out/sync-research/`, generated fixture Saved logs, and the existing localization lane's `out/loc-processes-ce1947/` are intentionally uncommitted; small samples and summaries are in [evidence](evidence/). The committed branch does not carry raw logs or binaries. They remain on this machine for review. Engine implementation was read, not copied into the probe.

Source utility: `python research/sync-probe/evidence.py query T01 5.7 Engine/Plugins/Developer/Concert REGEX`; `read VERSION RELATIVE_PATH START END`. Set `UE_SHED_RESEARCH_ENGINES` to a JSON version-to-root manifest when reproducing elsewhere. See each task for exact probes and checks.

Reproduce runtime tests in a fresh isolated checkout/worktree (prepare deliberately refuses to overwrite an existing evidence fixture). Requires Windows, Python 3.12, Node 26, pnpm and an Unreal-supported MSVC/SDK. Locked dependency installation and package-export build are prerequisites. This machine selected existing Node 26.9.0 at `C:\Users\denny\AppData\Local\vite-plus\data\js_runtime\node\26.9.0\node.exe`, rather than the shell's Node 24.21. Set `UE_SHED_RESEARCH_NODE_EXECUTABLE` to the Node executable you select; `gates.py` prepends its directory for child commands.

1. Supply a JSON manifest mapping version strings `"5.7"`, `"5.8"` and optional older versions to discovered/configured engine roots; set `UE_SHED_RESEARCH_ENGINES` to its filename. Discovery used `Get-ItemProperty 'HKLM:\SOFTWARE\EpicGames\Unreal Engine\*'`, verifying directories exist; 5.8 was supplied separately. The local manifest is `out/sync-research/engines.json`.
2. `pnpm install --frozen-lockfile`; `python research/sync-probe/gates.py prerequisites`. `python research/sync-probe/fixture.py prepare 5.7`, then `build 5.7`; repeat for 5.8. Product scripts/plugins remain unchanged; the fixture and probe plugins are copied into `out/sync-research/VERSION/fixture` with the appropriate EngineAssociation.
3. Test one engine at a time, because both use HTTP 30001 / WS 30002. `python research/sync-probe/fixture.py launch VERSION`; `python research/sync-probe/rc.py VERSION` verifies readiness. Probe function calls use `/Script/UEShedSyncProbe.Default__UEShedSyncProbeLibrary`, product calls use the existing Authoring library. Every scenario is marked in the event log.
4. Run `python research/sync-probe/live.py VERSION matrix`; stop editor; restore disposable saved scalar with `fixture.py restore-assets VERSION`. Launch fresh for `live.py VERSION undo`. Follow T11 commands for full benchmark, including windows.py state capture. Launch fresh for concurrent tests and each scenario set that follows package reload, since subscriptions are not reattached automatically.
5. **Normal editor policy matters:** in PowerShell set `$env:UE_SHED_RESEARCH_EDITOR_UNATTENDED = "0"` before launch. Run `python research/sync-probe/policy.py VERSION visible-off`, `visible-on`, minimize with windows.py, then `minimized-off` / `minimized-on`. Unattended editors bypass CPU throttling and cannot establish normal background behavior. Attempted foreground activation failed here; actual focused latency is UNVERIFIED.

   Follow-up [T15](T15-focus-conditional-throttling.md): launch a fresh normal editor after rebuilding the updated probe and run `python research/sync-probe/focus_policy.py VERSION`, then stop it. This tests a conditional native foreground-process/expiring-lease override while leaving the checkbox true. The existing foreground process is explicitly a stand-in, not actual Workbench integration.

6. `python research/sync-probe/live.py VERSION concurrent` exercises open table bindings, notification refresh, stale fingerprint, dirty revert and String Table/FText/context supplements. `python research/sync-probe/fixture.py stop VERSION` closes the exact recorded editor tree. Use fresh launches and unique log names; preserve launch metadata/PIDs.
7. Existing gates: `python research/sync-probe/gates.py authoring 5.7` / `authoring 5.8`, then `localization` (requires manifest 5.7/5.8/4.27). The exact authoring gate is pinned to 5.7 and rejects 5.8; do not change its product contract to obtain a misleading pass. Run localization with explicit roots as shown in T13 if not supplying 4.27.
8. Report generators are `analyze.py`, `report.py`, `undo_report.py`, `perf_report.py`, `concurrent_report.py`, `gates_report.py`. Human-added supplemental notes in task files must be retained when regenerating. `python research/sync-probe/audit.py` validates task fields, JSON/JSONL, sample limits, local links, Python syntax and Win32 creation-time inspection. `pnpm exec oxfmt --check docs/research/sync-feasibility research/sync-probe` checks supported research files; scoped config excludes the append-only journal.

Cleanup/evidence: [asset-saves.csv](evidence/asset-saves.csv) records observed saves and restoration. Tracked fixture Content was restored with `git checkout -- fixtures/unreal-project/Content`; `python research/sync-probe/restore.py` also restores saved disposable package copies from those git-restored bytes. Ignored copies under out have no git history, so checkout operates on their original tracked counterparts. Localization receipts, PO/archive/resource artifacts and raw logs remain ignored evidence. Final process inventory and git cleanliness are journaled. No full portable/product/parser gate was run for this research-only change; authoring/localization baseline results and unavailable checks are reported in T13. Actual widget clicks, modal/PIE behavior, a live network push subscription and translation preview remain explicitly untested.

- [Journal](JOURNAL.md)
- [Findings](FINDINGS.md)
- [T01 — Concert prior art](T01-concert-prior-art.md)
- [T02 — Remote Control push and transactions](T02-remote-control-push-and-transactions.md)
- [T03 — Hook semantics](T03-hook-semantics.md)
- [T04 — Version coverage](T04-version-coverage.md)
- [T05 — Localization live-write APIs](T05-localization-live-write-apis.md)
- [T06 — UE Shed internals map](T06-ue-shed-internals-map.md)
- [T07 — Observation probe plugin](T07-observation-probe-plugin.md)
- [T08 — Observation matrix](T08-observation-matrix.md)
- [T09 — Echo suppression](T09-echo-suppression.md)
- [T10 — Undo redo and dirty semantics](T10-undo-redo-and-dirty-semantics.md)
- [T11 — Latency and throughput](T11-latency-and-throughput.md)
- [T12 — Concurrent editing](T12-concurrent-editing.md)
- [T13 — Existing gates baseline](T13-existing-gates-baseline.md)
- [T14 — Prior art web scan](T14-prior-art-web-scan.md)
- [T15 — Focus-conditional background throttling](T15-focus-conditional-throttling.md)
