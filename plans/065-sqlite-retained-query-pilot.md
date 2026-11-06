# 065 — Complete retained Game Text queries in Bun SQLite

Status: IN PROGRESS

Continue the bounded [spike](archive/064-sqlite-query-engine-spike.md) on
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
2. Full local `pnpm check` started with the installed Rust 1.98.1 toolchain.
3. Implement and verify the Bun retained-query store and conformance workload.
4. Measure in isolated fresh processes, document results, and commit.
