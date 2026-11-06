# 065 — Complete retained Game Text queries in Bun SQLite

Status: DONE — bounded retained-query pilot; no production backend migration.

Continue the bounded [spike](064-sqlite-query-engine-spike.md) on
`research/sqlite-query-engine`. Compare direct Bun SQLite with the shipping Rust reader only.

## Scope and acceptance

- Preserve complete corpus, occurrences, coverage, diagnostics, localization manifest/archive/PO
  evidence, review/key-change data, and query projections, including blank sources and UTF-16.
- SQLite owns selection, paging and aggregation. Do not filter a bulk export in JavaScript to
  simulate a SQLite query engine. Store fields relationally; no persisted JSON documents.
- Compare complete answers, including ordered payloads and continuation behavior. Include positive
  selective search, translation search, culture scopes, negative filters, same-place constraints,
  facets leaving out their own clauses, groups, full detail and explicit bulk reads.
- Exercise retained generation replacement, rollback, reader pinning and crash recovery. Report
  shared upstream extraction/join/rule preparation separately from SQLite ingestion; never call
  ingestion a replacement for that preparation.
- Run the full-size generated cohort and the full local repository gate. Keep raw evidence and
  command exit codes, disclose every failure/skip, and fix failures introduced by this branch.
- Inventory any public behavior the pilot does not implement. Full data retention does not prove
  a complete replacement of the product's preparation and rule execution system.
- Commit the initial spike and the reviewed follow-up on the isolated branch; no push requested.

## Execution

1. Initial spike committed as `b5c2f4af`.
2. Full-evidence implementation committed as `7c985ed8`; progress logging as `e09dd8ba`.
   The independent page-bound fix is `186627f1`.
3. All 583,798 units and 583,507 raw lines retained; complete record/view/preview parity and
   corpus fingerprint passed. Full-size 268 cases plus 798 small/before/after cases matched.
   Complete-generation commit, pinning, rollback and recovery with spilled WAL passed.
4. Six fresh timing processes completed: 486 timed answers and 162 warmups matched. Full local
   `pnpm check`, final precommit and prototype checks passed, with configured integration/native
   skips disclosed in the evidence. No fresh Unreal matrix or hosted CI run was claimed.
5. [Report and portable evidence](../../docs/research/sqlite-full-evidence-pilot-2026-11-06.md)
   record the results, reproducible commands, failures/restarts and unimplemented product APIs.
   Keep Rust in production while the SQL count model and missing capabilities are investigated.
