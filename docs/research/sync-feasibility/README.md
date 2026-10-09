# Live editor synchronization feasibility

Research only. No product implementation is authorized. Source findings and live observations are distinguished throughout.

Base: `origin/main` at `3d027eb8` (full hash in evidence/context.txt). Design: `origin/docs/standalone-sync-design`, direction revision 2026-10-09; older sections are historical.

## Engine installations used

| Engine | Root | Discovery |
| --- | --- | --- |
| 4.27 | `D:\ue5\UE_4.27` | HKLM EpicGames registry |
| 5.3 | `D:\ue5\UE_5.3` | HKLM EpicGames registry |
| 5.5 | `D:\ue5\UE_5.5` | HKLM EpicGames registry |
| 5.6 | `D:\ue5\UE_5.6` | HKLM EpicGames registry |
| 5.7 | `D:\ue5\UE_5.7` | HKLM EpicGames registry |
| 5.8 | `D:\ue5\UE_5.8` | Explicit user configuration; not registered |

Paths are evidence of this machine, never runtime defaults. Probe/scripts take engine configuration from environment or the generated uncommitted `out/sync-research/engines.json` manifest.

## Reproduction and evidence

Worktree: `D:\git\ue-shed-sync-research`, branch `research/sync-feasibility`. Run commands from this worktree. Source references are relative to the engine root and include 1-based line numbers. Repository references are relative to the worktree. Raw logs under `out/sync-research/` are intentionally uncommitted; small samples and summaries are in [evidence](evidence/).

Source utility: `python research/sync-probe/evidence.py query T01 5.7 Engine/Plugins/Developer/Concert REGEX`; `read VERSION RELATIVE_PATH START END`. Set `UE_SHED_RESEARCH_ENGINES` to a JSON version-to-root manifest when reproducing elsewhere. See each task for exact probes and checks.

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
