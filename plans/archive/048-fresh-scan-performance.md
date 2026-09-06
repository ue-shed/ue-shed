# Fresh Catalog scan performance

Status: DONE — implemented and validated

Baseline: `1756fcb269f0f6cc8ba2cd9514938c77f5f46a81`. Optimize actual fresh project scans,
separately from queries, incremental refresh, and Workbench presentation. Preserve unrelated icon
edits and keep private projects read-only. Speed is primary; memory/storage are guardrails.

1. Freeze the current executable and three-cohort baseline. Profile the current 16-worker pipeline
   in an isolated build, including discovery, parsing, and initial Catalog construction.
2. Investigate duplicate summary parsing, file reading/scheduling, parser allocations, and initial
   records/postings construction according to measured cost. Keep rejected experiment evidence.
3. Measure retained changes without instrumentation, serially across fixture/medium/large cohorts.
4. Prove parser behavior, ordered-query and count parity, snapshot equality where applicable,
   malformed-input protection, and relevant native/WASM/platform gates.
5. Publish separate before/after numbers and limitations. Stop when remaining candidates lack a
   measurable benefit or need a materially broader contract. Do not commit or push until requested.

Scratch evidence: `test-results/fresh-scan-2026-09-06/`. Fresh means an empty Catalog, with the OS
filesystem cache left intact. Instrumented worker elapsed totals overlap and are not wall time.

## Outcome

- Refreshed the 16-worker profile and added coordinator/initial-Catalog stages. The principal
  retained gains are in accepting records and constructing postings, not file writing or checksums.
- Retained eight-result channel batches, append/stable-sort/merge staging, and dense posting-ID
  indexing. Last-write-wins staging, output order, checksums, and publication behavior are preserved.
- Hash-based staging was an intermediate experiment. A safe parser checkpoint passed its tests,
  but removing it improved the measured workload; no parser changes remain. Name-list caching
  lacked a compelling bounded hit rate and was not implemented.
- Final fresh medians: fixture 37.30 → 38.74 ms (no meaningful change), medium 218.51 → 200.94 ms,
  large 2,784.85 → 2,630.68 ms. Large has six timed samples per variant with baseline confirmation.
  Warm refresh is unchanged. Query/input timings remain separately recorded without attributing
  their changes to unchanged implementations.
- Native peak working set fell; storage and physical snapshot bytes remain unchanged. Complete
  ordered-query/count parity passes on all cohorts. Windows/Linux oracle/process tests, IO gate,
  packed native artifact, MSRV check, and formatting pass.
- The profiling helper now excludes untracked Unreal-generated build outputs. Its first failed
  copy is excluded from timing evidence. Private projects and unrelated icon changes are untouched.
- [Final report and raw evidence](../../docs/research/fresh-scan-2026-09-06.md). Further work needs
  focused allocation/interning or file-loading evidence.
