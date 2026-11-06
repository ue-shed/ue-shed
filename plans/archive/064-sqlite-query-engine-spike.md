# SQLite query-engine spike

## Status

DONE on `research/sqlite-query-engine`, based on `3d7e0ba2` (0.25.0).
The owner authorized an isolated worktree and the experiment discussed in the thread. This is
research, not a decision to migrate either production index or change ADR 0012.

## Questions

1. How does the current Game Text query API compare with relational SQLite over the same facts?
2. How much does the production process/frame/batch boundary cost compared with direct Node and
   Bun bindings? Separate the engine, packing, transfer, and host materialization where measured.
3. What does SQLite cost to construct, reopen and edit? Which domain behavior still needs an adapter?
4. Can an independent Python consumer read the same data and add a report without a Rust operation?

## Experimental boundary

All implementation lives in `tools/benchmarks/sqlite-query`. The production reader, native join,
protocol, host APIs and Unreal parser are unchanged. The SQLite adapter reuses production frame,
batch and TypeScript session implementations, but its serial server does not implement production
concurrency or cancellation. Results cannot claim equivalent interactive behavior under load.

Use seed-57 generated retained evidence, initially at 0.001, 0.01 and 0.1 scale. The input preparation
uses existing test producers and the production native join, then exports a selected projection.
SQLite construction starts from that projection. Generation, native joining, conversion and SQL
construction are separate measurements; they are not an end-to-end competing build comparison.
The SQLite projection does not retain all provenance in the native store: storage bytes are not
equivalent full-index footprints. No studio project or authored Unreal asset is changed.

Four measured paths are the production Rust engine, SQLite over the production host framing and
column encoder, direct Node SQLite, and direct Bun SQLite. Capture exact SQLite versions and
compile options; this is not a pure runtime/bridge experiment with an identical SQLite binary.

For line exports, the selected fields and column batch encodings match. For pages, the native API
constructs richer previews before the harness selects the common fields. Page results measure the
actual API costs, not equal-width transport or pure database execution.

## Work and acceptance

- [x] Create the separate worktree; preserve the original checkout's uncommitted work.
- [x] Build the current production reader with an explicit installed Rust toolchain.
- [x] Add a relational dictionary, lines, cultures, marks and places, indexes, FTS candidates and views.
- [x] Add direct Node/Bun drivers and an isolated Rust SQLite process using production frames/batches.
- [x] Compare queries with an independent retained-fact oracle; plant nonempty Unicode controls.
- [x] Complete alternating independent-process measurements at all selected scales.
- [x] Record SQLite reopen/edit, rollback, old-reader and interrupted-transaction evidence.
- [x] Verify independent Python reads and a report without a new Rust operation.
- [x] Record exact source/binary hashes, raw samples, query plans, mismatches and limitations.
- [x] Run focused TypeScript, lint, formatting, Rust and correctness checks; review the diff.

## Outcome

The [report and retained evidence](../../docs/research/sqlite-query-engine-spike-2026-11-06.md)
cover 8,637 timed operations, all with matching result hashes/counts, plus structural lifecycle
checks and nine additional independent/native join/projection cases. A diagnostic Rust build
removed unrequested preview construction; grouping indexed IDs before labels separately improved
the SQL counts. Both controls materially changed the initial comparison.

Production source and the default baseline executable were restored after the diagnostic build.
The patch is retained with the experimental tools. Full provenance, source-to-store construction,
complete rule/evidence semantics, all facets and concurrent host responsiveness remain migration
questions, not unfinished acceptance for this bounded query spike.

Keep results by operation. Do not turn a point-query win into a claim about quality evaluation,
full scans, arbitrary policies, facets with filter omission, cancellation, or Project Index.
Representative SQL rules initially cover grouped duplicate sources and UTF-16 source length, with
an independent fact oracle. They do not replace the complete native rule compiler/evaluator.

Any answer mismatch fails the measured comparison. Performance runs are serial under the existing
shared heavy-job lease, use three independently opened processes per lane and repeated operations,
rotate lane/case order, and retain every sample. Hashes are computed outside operation timers.
Capture callback gaps including the unfinished synchronous gap, sampled process-tree RSS, source
and runtime provenance. Stop on resource limits; do not silently drop failed cases or resize inputs.

The final report must distinguish supported migration evidence from unresolved questions. A
follow-up migration decision needs equivalent full provenance, authored rule semantics, incremental
join/evaluation behavior, host packaging, reader lifecycle and relevant Unreal conformance.
