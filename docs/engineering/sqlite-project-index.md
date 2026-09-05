# SQLite Project Index

This records the SQLite baseline, superseded later on 2026-09-05 by the
[binary Catalog](binary-project-index.md). SQLite remains an opt-in test oracle.

The baseline used `rusqlite` 0.37.0
and its bundled SQLite 3.50.2. `uasset-io` owns the
adapter; parsing and inspection remain database-free and WASM-compatible. The CLI, libraries,
and Workbench use the same storage-neutral coordinator and bounded query protocol.

## Storage and publication

- The cache is disposable derived evidence, under `catalogs-v3/<project-hash>`.
- A manifest atomically selects an immutable physical SQLite snapshot. The previous physical
  snapshot is retained; an already-open reader can finish its generation across publication.
- A warm no-op publishes generation metadata while reusing the physical snapshot with zero evidence
  writes. Writers are initialized only when evidence changes or deletions require a new snapshot.
- Fresh catalogs write directly into the final entry table. Changed refreshes copy the immutable
  snapshot and update only changed evidence and class postings. Removed paths delete their postings.
- Private writers use one transaction, rollback journaling, and `synchronous=FULL`. Publication
  follows database commit and connection close. Failed/discarded staging removes unpublished
  database files and journals.
- Relative paths define pagination order. Internal row IDs remain stable across updates but carry
  no ordering contract; middle insertions and unordered discovery must not skip query results.
- Class and reversed class-name postings support exact, prefix, and suffix queries. Serialized
  names remain JSONB arrays scanned on demand. Full name postings were rejected for fresh-scan cost.
- A covering signature index lets warm refreshes compare the compact inventory without reading
  serialized-name payloads.
- File size and timestamp signatures use fixed-width eight-byte blobs to preserve the entire Rust
  `u64` domain. SQL and serialization details remain private to the adapter.

The existing `catalogs-v2` DuckDB files are ignored. The first refresh builds a new SQLite catalog;
no private cache conversion or automatic deletion of old caches is attempted. Clearing a catalog
quarantines its directory. Invalid manifests and unreadable snapshots also trigger quarantine and
rebuild; unavailable filesystem operations remain errors.

## Performance and validation

The [second speed pass](../research/rust-core-speed-round2-2026-09-05.md) records the selection
experiment; the [canonical SQLite pass](../research/sqlite-canonical-2026-09-05.md) records the
production migration and subsequent optimization. Fresh catalogs, warm refreshes, bounded queries,
and input decode are separate timings. Memory and complete cache storage are secondary guardrails.

Use `pnpm benchmark:project-index` with explicit read-only project roots. Full ordered query parity
and cache-repair tools live under `tools/benchmarks`. Source project files must remain read-only;
mutation scenarios use explicitly marked disposable projects/caches.

`uasset:check:io` covers ownership boundaries, formatting, Clippy, native tests, process conformance,
and native/WASM parity. The root license gate checks the pinned bundled SQLite dependency. Local
runtime timings do not establish hosted CI build-time savings.
