# Plan 037: Deepen the headless Project Index with a native Catalog

> **Executor instructions**: Preserve one project-wide `Content` enumeration, the public
> `AssetReader.scanProject` compatibility surface, and the separation established by ADR 0007.
> TypeScript owns cache-root configuration and user-facing refresh/rebuild policy. Rust owns the
> private Catalog file format and DuckDB implementation. JavaScript must never issue SQL or depend
> on tables, snapshot files, manifests, checkpoints, or DuckDB locking behavior. Do not store generic property
> graphs, source text, translation text, or product-specific reports in the Catalog.
>
> **Drift check (run first)**:
>
> ```powershell
> git status --short -- CONTEXT.md docs/decisions plans crates/uasset-io packages/protocol packages/unreal-assets packages/host apps/cli apps/workbench packages/game-text packages/asset-audits packages/enhanced-input
> git diff -- crates/uasset-io/src/direct_executor/project_io.rs crates/uasset-io/src/protocol.rs crates/uasset-io/src/protocol_adapter.rs packages/protocol/src/uasset-io.ts packages/unreal-assets/src/index.ts apps/workbench/src/main/services/project-workspace.ts apps/workbench/src/renderer/app-shell.tsx plans/033-compact-project-corpora-before-persistence.md
> ```
>
> Reconcile new project-index, protocol, cache, or Plan 033 work before editing. Do not overwrite
> another agent's changes or treat Workbench behavior as the headless contract.

## Status

- **State**: IN PROGRESS — DuckDB is selected and the natural immutable Adapter passes the shared
  Catalog conformance suite; ordinary-startup lifecycle, persistent query sessions, release and
  benchmark gates, production cutover, SQLite retirement, and an explicit Workbench rebuild control
  remain
- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — changes native persistence, the language-neutral process seam, project refresh
  semantics, public TypeScript ownership, Workbench composition, and large-project caching
- **Depends on**: ADR 0007 and Plan 033 compact-extraction invariants
- **Category**: foundation
- **Planned at**: current worktree, 2026-08-04

## Decision

Deepen `@ue-shed/unreal-assets` with a headless Project Index module. Do not create a new npm package
or Rust crate in this plan: `@ue-shed/unreal-assets` already owns the public saved-package reader and
process adapter, while `uasset-io` already owns native project discovery and cache participation.
Extract a package or crate only after a second independent consumer makes that seam real.

Ownership is split by policy and mechanism:

| Owner                           | Responsibility                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------- |
| TypeScript Project Index module | Public Effect interface, cache-root configuration, refresh/rebuild policy, errors |
| `uasset-io` Project Index       | Refresh coordination, signatures, changed/deleted detection, generations          |
| Rust Catalog adapter            | DuckDB snapshots, manifest publication, locking, integrity, quarantine            |
| Workbench                       | Project chooser, selected-project state, progress and failure presentation        |
| Domain modules                  | Text, texture, table, input, map, and authoring meaning                           |

TypeScript supplies a configurable cache root. Rust canonicalizes project identity, chooses and
manages the Catalog files beneath that root, and returns an opaque Catalog reference. The DuckDB
schema and snapshot manifest are private Implementation, not a second cross-language Interface.

DuckDB 1.5.5 is selected as the target canonical production Catalog. SQLite remains the measured interim
Adapter until the natural DuckDB Adapter passes conformance, recovery, release, and equal-workload
regression gates; it is not a second runtime cache or a permanent user-selectable backend. The
in-memory Adapter continues to exercise the same Rust refresh coordinator in tests. During the
cutover, three Adapters make the Catalog Seam real; after cutover, delete the SQLite Adapter unless
a separately recorded release rollback requirement justifies retaining it.

The selection is based on the completed equal-workload comparison, not the engine category alone.
The natural columnar DuckDB probe improved representative cold mean from SQLite's 25.72 seconds to
21.63 seconds, reduced active Catalog storage from 647.3 MB to approximately 182.8 MB, and reduced
cold Rust peak RSS. Follow-up model research found further Leverage in nested evidence, immutable
snapshot files, path ordering, Arrow batch ingestion, and connection reuse. The stable Catalog
Interface and all Project Index invariants remain fixed while the private Implementation changes.

This selection supersedes the storage-specific SQLite sentence in ADR 0007's Project Index
amendment, but not that ADR's ownership split or process Seam. Step 13 must record the scoped ADR
change before the production factory switches; the plan does not silently rewrite accepted history.

## Relationship to Plan 033

Plan 033 retains the persistence decision for compact Game Text and Texture Audit query models.
This plan resolves a different issue: the foundational package-signature and compact-header Catalog
currently represented by Rust and Workbench whole-file JSON caches.

The 184,559-package failure is evidence that the current Project Index interface is unbounded, not
permission to place every domain corpus in SQLite. Domain-specific SQLite adapters remain gated by
Plan 033 Step 8 measurements.

## Evidence

The representative local project supplied the missing large-project evidence:

- `Content` contains 184,559 packages/sidecars relevant to inventory and roughly 92 GiB of files.
- The native header scan completes successfully with zero asset failures.
- Human scan output is approximately 56.5 MiB and the native JSON header cache approximately
  66.6 MiB.
- The protocol reaches its fixed cumulative 64 MiB output budget at inventory frame 178,986 and
  returns `output_limit` before the summary.
- All 165 Enhanced Input candidates decode successfully, so package readability is not the cause.
- Workbench receives a typed failed project state but renders every non-ready state as
  `CHOOSE PROJECT...`, hiding the failure.

Existing representative evidence in `docs/engineering/uasset-benchmarks.md` records 182,626
packages, a 5.77-second cold rebuild, and a 2.88-second warm revalidation. Warm revalidation still
enumerates and stats the whole project.

The current implementation duplicates and leaks index state:

1. Rust loads and rewrites one filter-specific `ScanHeaderCache` JSON vector.
2. `scan --inventory` emits one verbose protocol result for every package and sidecar.
3. TypeScript collects every inventory entry and matching header into `SavedAssetScan` arrays.
4. Workbench sorts and hashes the complete manifest.
5. Workbench persists a second JSON document containing that manifest and derived projections.
6. Workbench-only consumers receive the complete `SavedAssetScan` to ask narrow candidate questions.

SQLite alone does not repair this design. The Project Index interface must stop transmitting the
complete manifest during ordinary project opening.

### Architecture review outcome (2026-08-04)

The selected deepening sequence is:

1. Deepen the public TypeScript Project Index module and freeze the schema-first v1.1 interface.
2. Extract the native refresh coordinator and prove it against an in-memory Catalog adapter.
3. Add SQLite as a private Catalog adapter only after dependency and release probes pass.
4. Connect bounded summaries and query pages; never carry the complete manifest over the wire.
5. Migrate consumers one at a time, then delete both old JSON cache implementations.
6. Benchmark the completed SQLite path, attribute bottlenecks, and conditionally compare DuckDB only
   when SQLite-specific evidence warrants it.

This ordering keeps the public interface independent from the storage implementation. The Project
Index becomes a deep module: its small lifecycle/query interface hides traversal, signature
comparison, header probes, Generations, transactions, migrations, locking, and recovery. The memory
and SQLite adapters make the Catalog seam real, while keeping storage-specific knowledge local to
the native adapter.

This sequence is historical and completed through the SQLite baseline. The equal-workload evidence
later in this plan selects DuckDB as the canonical Adapter without changing the Catalog Interface.

Do not introduce a sharded or per-module JSON cache as an intermediate architecture. It would retain
the shallow whole-index interface, duplicate invalidation and atomicity rules, and pay a second
migration cost without removing the unbounded protocol transfer. If SQLite fails a release gate,
keep the coordinator and memory adapter usable while reconsidering the production Catalog adapter.
Do not pause Steps 8–10 for a speculative DuckDB rewrite. The current SQLite implementation is the
baseline that makes a later comparison meaningful.

The deletion test for this work is explicit: after consumer migration, deleting
`ProjectInventoryCacheLive`, `projectIndexCacheLocator`, Workbench manifest hashing/materialization,
and `WorkbenchProject.index(): SavedAssetScan` must not remove Project Index behavior. Deleting any
storage Adapter alone must leave the coordinator and its in-memory Adapter usable.

## Target flow

```text
Workbench / CLI / another host
        |
        | public Effect operations
        v
@ue-shed/unreal-assets Project Index
        |
        | typed uasset-io v1.1 operations
        v
uasset-io refresh coordinator
        |
        +---- project scanner --------> filesystem + package headers
        |
        +---- Catalog seam
                 |
                 +---- DuckDB adapter (canonical production)
                 +---- SQLite adapter (interim baseline; delete after cutover)
                 +---- in-memory adapter (coordinator tests)

Callers receive: lifecycle, generation, counts, diagnostics, bounded pages
Callers do not receive: complete signatures, SQL schema, entire manifest
```

## Required invariants

1. One refresh performs exactly one project-wide enumeration.
2. An explicit empty candidate set means zero package work and never falls back to `Content`.
3. Package and sidecar signatures are compared before header decoding.
4. Only changed or new packages have their header evidence rebuilt.
5. Deleted packages disappear only after a complete enumeration commits.
6. Queries observe the previous committed Generation while a refresh is in progress.
7. Cancellation, crash, timeout, or partial enumeration cannot advance Generation.
8. Every query is bounded, stably ordered, and may reject a stale expected Generation.
9. The Catalog is disposable derived data outside the Unreal project and source control.
10. SQL, database filenames, snapshot manifests, checkpoints, and migrations never cross the public
    TypeScript seam.
11. `scanProject` remains available for generic explicit scans and compatibility.
12. Deleting `apps/workbench` leaves refresh, status, query, rebuild, and CLI use intact.
13. An exact warm no-op rewrites no package evidence and reads zero package headers.
14. A changed or new package is signature-checked again after its header read, before its evidence
    can be staged, so concurrent writes cannot pair new evidence with an old signature.
15. Package and sidecar signatures remain distinct. A sidecar-only change updates inventory evidence
    without pretending the package header changed.

## Interface constraints

Design the exact schemas before implementation, using the following shape as a constraint rather
than frozen code:

```ts
interface ProjectIndex {
	readonly refresh: (
		target: ProjectIndexTarget
	) => Stream<ProjectIndexRefreshEvent, ProjectIndexError>;
	readonly query: (request: ProjectIndexQuery) => Effect<ProjectIndexPage, ProjectIndexError>;
	readonly rebuild: (
		target: ProjectIndexTarget
	) => Stream<ProjectIndexRefreshEvent, ProjectIndexError>;
}
```

- `ProjectIndexTarget` contains an explicit project root; configured adapters supply the cache root.
- A successful refresh terminal event returns a branded project identity, branded Generation,
  package/map counts, changed/removed counts, completeness, and bounded diagnostics.
- `ProjectIndexQuery` carries the project identity, expected Generation, stable cursor, and page
  limit enforced below the caller.
- Query variants cover maps and domain-neutral header probes: exact classes, class prefixes,
  class-name suffixes, and serialized names.
- Convenience functions may expose saved-table, input, text, and texture candidate streams, but
  they compile down to the generic bounded query and remain owned by their domain modules.
- SQL expressions, table names, database paths, and arbitrary property queries are forbidden.
- Refresh and rebuild are explicit; ordinary queries never silently rescan a project.

Before freezing the interface, write at least two usage tests: one CLI refresh/query journey and one
Workbench selection/progress/retry journey. The interface is accepted only when both use the same
module without Workbench-specific arguments.

## Protocol compatibility

Add Project Index operations to `uasset-io` contract v1.1 while preserving v1.0 operations and
semantics:

- `project_index_status` returns absence or one small committed-generation summary;
- `project_index_refresh` streams progress and ends with one small refresh summary;
- `project_index_query` returns one bounded page for an expected Generation;
- `project_index_rebuild` discards/quarantines the exact private Catalog and performs a fresh build.

Names may be sharpened during schema design, but responsibilities may not collapse into raw SQL or
an unbounded generic query. Additive operations are safe only for paired TypeScript/native releases:
old workers reject unknown operations before `accepted`. Detect and report an incompatible worker
with explicit recovery guidance.

Do not reinterpret v1.0 `maximumOutputBytes`. Both Rust and TypeScript tests establish it as a
cumulative budget; changing its meaning requires `uasset-io` v2. Paired releases use a finite 1 GiB
legacy compatibility ceiling while new Project Index operations avoid the cliff through small
summaries and bounded pages. Keep a per-frame decoder bound independently.

Change the authoritative JSON Schema and fixtures first, then Effect schemas, Rust protocol types,
Rust adapters, and TypeScript process adapters. Every operation/result variant needs a shared valid
fixture and every new rule needs an invalid fixture.

## Catalog constraints

The DuckDB Implementation may persist only the evidence required to refresh and query the Project
Index:

- canonical project identity and Catalog schema/profile versions;
- committed and staging Generation metadata;
- project-relative package and sidecar paths;
- package kind, size, and modification timestamp/signature;
- compact package name, matching exports/classes, and matching serialized names;
- bounded per-package failures required to explain incomplete evidence.

Do not persist complete saved-asset inspections, generic properties, text corpora, texture reports,
audit findings, authoring sessions, source-control state, or presentation state.

Use a versioned Index Profile for the probes shared by current consumers. A profile change may
invalidate and rebuild compact header evidence while retaining safe package signature knowledge.
Do not silently answer a wider query from evidence captured for a narrower profile.

The DuckDB Adapter owns its nested schema, physical snapshot identity, logical-Generation manifest,
checkpoint policy, read-only connection policy, corruption detection, quarantine, and retired-file
cleanup. DuckDB files are generation-specific and immutable after publication. A refresh writes a
new unpublished file while readers continue using the prior file, then atomically replaces the
small manifest only after the new file is closed and durable.

The exact DuckDB Rust dependency and narrowly required features must pass the repository's Rust 1.88,
locked-offline-build, complete transitive-license, self-contained executable, Windows packaging,
executable-size, and npm-package-size gates. Disable extension autoload and installation; the
Catalog must not require network access or dynamically acquired code. Do not enable broad convenience
features or a newer storage version without measured need.

The physical package table is path-ordered and stores one row per package with nested class,
class-name, and serialized-name lists. Cold ingestion appends bounded Arrow `RecordBatch` values
directly into the unpublished snapshot. It must not explode evidence into normalized child tables,
build SQLite-style ART indexes, or perform N+1 hydration. Start the adoption experiment with the
measured 1,024-package batch bound, four DuckDB threads, and 16,384- versus 32,768-row-group trials;
select the final settings from equal-workload evidence.

## Startup and publication lifecycle

Ordinary Workbench startup must not wait for a project-wide refresh:

1. Read Catalog status and open the last committed immutable snapshot read-only.
2. Serve only the routes the active workflow requests, using the committed Generation immediately.
3. Start signature revalidation in the background and keep the prior Generation queryable for the
   complete refresh.
4. If nothing changed, atomically advance the logical Generation while reusing the same physical
   snapshot; do not copy or rewrite package evidence.
5. If packages changed, build the replacement physical snapshot off to the side, close and
   checkpoint it, atomically publish the manifest, then notify callers that a fresher Generation is
   available.

The user should pay a true cold build only when no compatible committed snapshot exists: first use
for that project and cache root, explicit rebuild, manual cache deletion, quarantine after detected
corruption, or an incompatible Catalog/Index Profile change. A running refresh is not a cold-start
condition; it is background revalidation of an already usable Generation.

Do not create a second non-DuckDB index and then build DuckDB afterward. If the measured first-ever
experience remains unacceptable after natural DuckDB improvements, one scanner pass may tee each
deterministically ordered batch to both the unpublished DuckDB snapshot and bounded provisional
matches for explicitly requested routes. Those events must carry a refresh-attempt identity and
partial/provisional state, must never masquerade as a committed Generation, and must disappear on
failure or cancellation. Implement this only after measuring time to first useful route with direct
nested Arrow ingestion and persistent query sessions.

Read-only workflows may display the prior Generation while background refresh runs. Any future
operation that requires fresh evidence must state that requirement in its own Interface rather than
silently forcing every Project Index query to block on refresh.

## Refresh and caching algorithm

The coordinator implementation must preserve this storage-neutral algorithm:

1. Canonicalize the project identity and open its disposable Catalog beneath the configured cache
   root. Windows path-case and alias behavior must be specified and fixture-tested before hashing a
   Catalog location.
2. Keep the current committed Generation queryable and create an unpublished physical snapshot for
   the refresh. Do not mutate or delete the published snapshot while enumeration is incomplete.
3. Enumerate the configured project roots once. For each package and sidecar, read one signature
   containing its canonical project-relative path, kind, size, and high-resolution modification
   timestamp.
4. Compare that signature with the Catalog before any header IO. If the signature and Index Profile
   evidence version match, mark the row observed and reuse its evidence without reading the package
   header or rewriting the evidence row.
5. If the signature matches but the Index Profile evidence is stale, retain the signature and
   rebuild only the compact header evidence. A wider profile must never reuse narrower evidence.
6. For a new or signature-changed package, read only the compact header probe, then re-read its
   signature before staging. A concurrent change retries within a bounded policy or produces a
   diagnostic that prevents publication of an incorrectly paired signature/evidence row.
7. Treat sidecars as separate signature rows. Sidecar changes participate in inventory state and
   deletion detection but do not force a package-header read unless a future versioned profile
   explicitly requires sidecar-derived evidence.
8. Mark missing prior rows as deletions only after the one enumeration completes. Publish staged
   evidence, deletions, summary metadata, and the next immutable Generation in one successful
   transaction.
9. On cancellation, timeout, process failure, partial enumeration, failed signature revalidation,
   or transaction failure, discard staging and leave the prior committed Generation intact.
10. Serve only stable, bounded, Generation-checked pages from committed state. Ordinary queries
    never refresh, enumerate, or fall back to scanning `Content`.

The coordinator interface is the test surface. Its conformance suite must run unchanged against the
in-memory and SQLite adapters; coordinator tests must never name SQL tables, pragmas, journal files,
or migrations.

## Execution plan

### Step 1 — Make current failures visible

1. Render `WorkbenchProjectState.status === "failed"` message and recovery beside the chooser.
2. Preserve the failed state after the indexing modal closes.
3. Add retry behavior that clears the prior error only when a new selection starts or succeeds.
4. Cover failed, retrying, cancelled, and ready states in component tests.

**Gate**: selecting the representative project shows `output_limit` and recovery instead of silently
returning to `CHOOSE PROJECT...`.

### Step 2 — Freeze baseline and interface evidence

1. Extend the project-index benchmark to record cold build, warm no-op, one changed package, one
   deletion, total protocol bytes, largest frame, peak TypeScript/Rust RSS, and cache bytes.
2. Record aggregate evidence only; never record supplied project paths or asset identities.
3. Add CLI and Workbench usage tests for the proposed public interface.
4. Record the v1.1 compatibility rule and private Catalog ownership in a new decision record or an
   explicit amendment to ADR 0007.

**Gate**: the benchmark records the historical 64 MiB failure, completes the representative scan
under the 1 GiB legacy compatibility ceiling, and usage tests settle the public interface before
SQLite code lands.

**Implementation evidence (2026-08-04)**: the v2 harness now emits all four scenarios and records
aggregate protocol/frame/cache/RSS evidence without paths or asset identities. A guarded mutation
run on the 52-package fixture observed 52 cold/warm packages, 51 cache hits after one timestamp
change, and 51 remaining packages after one temporary deletion; restoration tests cover package
sidecars and failure paths. CLI and Workbench usage tests exercise the same public Effect module,
and ADR 0007 records paired v1.1 compatibility plus private Catalog ownership. The representative
184,559-package rerun reproduced the former 64 MiB cumulative failure, then completed every sample
under the paired 1 GiB compatibility ceiling: 11.695-second cold p50 and 7.111-second warm p50,
with 69.166 MiB and 67.989 MiB of protocol output respectively. Reusing the inventory signature for
cache comparison and skipping the exact no-op JSON rewrite reduced warm p50 to 6.592 seconds while
leaving the full inventory transfer visible for the Catalog work to remove.

### Step 3 — Deepen `@ue-shed/unreal-assets`

1. Split process transport, ordinary saved-asset operations, and Project Index code out of the
   current large `src/index.ts` implementation without changing public behavior.
2. Add Project Index schemas, branded identity/Generation, lifecycle, typed failures, query cursors,
   and enforced maximum page size.
3. Provide the public Effect module with an in-memory test adapter.
4. Concentrate lifecycle folding, Generation/page validation, typed recovery, and cache-root policy
   in the Project Index implementation rather than duplicating them in CLI or Workbench callers.
5. Keep the child-process transport as an internal adapter and cache-root selection configurable and
   free of Electron imports.
6. Add an architecture check preventing Workbench dependencies and SQLite-specific types.

**Gate**: public interface tests pass with the in-memory adapter and deleting Workbench imports does
not remove any Project Index behavior.

**Implementation evidence (2026-08-04)**: `@ue-shed/unreal-assets` now splits process transport
(`protocol-transport.ts`), ordinary AssetReader operations (`asset-reader.ts` + `scan-target.ts`),
and the Project Index module (`project-index.ts` + `project-index-memory.ts`) behind a thin public
barrel. The Project Index surface owns branded identity/Generation, bounded query schemas, typed
failures, refresh folding, page validation, and cache-root configuration via
`UE_SHED_PROJECT_INDEX_CACHE_ROOT` with no Electron imports. An in-memory adapter exercises refresh,
stale-generation rejection, and enforced page limits. `pnpm run uasset:architecture` forbids
Workbench and SQLite leakage from the package TypeScript seam.

### Step 4 — Add the schema-first v1.1 protocol

1. Extend request/event JSON Schemas and fixtures with bounded Project Index operations/results.
2. Update Effect schemas and contract generation checks.
3. Update Rust request/result models and conformance tests.
4. Extend the shared process adapter with progress, cancellation, stale-generation, worker-version,
   and corruption failure mappings.
5. Retain every v1.0 fixture and generic `scan` behavior unchanged.

**Gate**: TypeScript and Rust accept the same fixtures, old operations are unchanged, every query
page is bounded, and an old worker produces a typed incompatible-worker result.

**Implementation evidence (2026-08-04)**: `uasset-io` v1.1 fixtures cover Project Index status,
refresh, rebuild, and query requests plus status/summary/page results, progress, and stale-generation
failures. Invalid fixtures reject oversize page limits and unbounded result pages. Effect schemas,
generated JSON Schemas, and Rust request/result models decode the same fixtures; v1.0 fixtures remain
green. The TypeScript process adapter maps pre-`accepted` worker exits to
`ProjectIndexIncompatibleWorker`, and maps stale-generation, corrupt-catalog, cancelled, and
unavailable failed frames onto the public Project Index error surface. Native execution of the new
operations remains intentionally unavailable until the Catalog coordinator lands.

### Step 5 — Extract the Rust refresh coordinator

1. Split `project_io.rs` into internal scanner, Project Index coordinator, and existing scan
   compatibility adapter modules.
2. Define the Catalog seam over storage-neutral package signatures, compact header evidence,
   refresh transactions, Generations, and bounded queries.
3. Implement the in-memory Catalog adapter first.
4. Prove add/change/delete/rename/sidecar behavior and stable ordering through the coordinator
   interface.
5. Separate reusable signature evidence from versioned Index Profile header evidence.
6. Revalidate changed/new package signatures after header reads and prove bounded concurrent-write
   handling.
7. Preserve cancellation checkpoints, previous-Generation queries, and one traversal.

**Gate**: coordinator tests never mention SQLite, and legacy scan conformance remains green.

**Implementation evidence (2026-08-04)**: `direct_executor` now splits Catalog seam
(`catalog.rs`), in-memory adapter (`catalog_memory.rs`), refresh coordinator
(`project_index.rs`), filesystem scanner helpers (`scanner.rs`), and legacy scan compatibility
(`project_io.rs`). The coordinator proves cold/warm no-op header reuse, add/change/delete/rename
plus sidecar updates, bounded signature revalidation, cancellation that discards staging while
preserving the prior Generation, stale-generation query rejection with stable path ordering, and
rebuild clearing committed state before generation `1`. Coordinator and scanner tests never mention
SQLite. `FilesystemProjectScanner` walks `Content` and probes Index Profile evidence; protocol
wiring remains deferred to Step 7. `cargo test -p uasset-io --lib` is green (25 tests).

### Step 6 — Implement the SQLite Catalog adapter

1. Probe a narrowly featured bundled `rusqlite` build, but add the selected exact Rust SQLite
   dependency only after Rust 1.88, license, locked-offline-build, release-size, self-contained EXE,
   and Windows packaging checks pass.
2. Implement schema creation, migrations, transactional staging, atomic Generation publication,
   indexed evidence queries, and stable pagination.
3. Inspect headers only for new or signature-changed packages.
4. Mark observed rows during enumeration and delete unseen rows only at successful commit.
5. Preserve the last committed Generation during concurrent refresh and after interruption.
6. Quarantine the exact corrupt/incompatible Catalog and rebuild; never touch project content.
7. Select rollback journal or WAL from measured concurrent-read, crash, and warm-refresh evidence;
   enforce a finite busy timeout either way.
8. Add Rust transitive-license evidence and record native executable/npm-package size deltas.
9. Run one conformance suite against both memory and SQLite adapters.

**Gate**: SQLite and memory adapters produce equal fixture results; cancellation and injected failure
leave the prior Generation queryable and delete nothing.

**Implementation evidence (2026-08-05)**:

_Dependency probe._ `rusqlite 0.40.1` was rejected: its `libsqlite3-sys 0.38.1` build script uses the
unstable `cfg_select!` macro and fails to compile even on the local `rustc 1.94.0`, let alone the
1.85 floor. The accepted dependency is `rusqlite = { version = "=0.37.0", default-features = false,
features = ["bundled"] }`, which resolves `libsqlite3-sys 0.35.0` and enables only `bundled` plus
`modern_sqlite` (46 features stay off; no `buildtime_bindgen`). Eleven new crates enter the graph
(`bitflags`, `cc`, `fallible-iterator`, `fallible-streaming-iterator`, `find-msvc-tools`, `foldhash`,
`hashbrown`, `hashlink`, `libsqlite3-sys`, `pkg-config`, `rusqlite`, `shlex`, `smallvec`, `vcpkg`).

_Gates._ Rust 1.85: `cargo +1.85.0 build --locked -p rusqlite -p libsqlite3-sys` succeeds, and
resolver 3 locked the graph to "latest Rust 1.85 compatible versions". Offline build:
`cargo build --locked --offline -p uasset-io` succeeds because the SQLite amalgamation ships inside
the crate (`sqlite3/sqlite3.c`), so no build-time download occurs. Licenses: every new crate is MIT
or MIT/Apache-2.0 except `foldhash` (Zlib); the vendored SQLite amalgamation is public domain.
Self-contained EXE: the released `uasset.exe` gains no third-party runtime DLL — only additional
Windows Universal CRT API sets (`api-ms-win-crt-string/-utility/-time`) beside the
`VCRUNTIME140.dll` the baseline already required. Release size, measured with a temporary
reachability patch so the linker retains the adapter: `uasset.exe` 3,649,536 → 5,345,792 bytes
(+1,696,256, +46.5%) and the `@ue-shed/uasset-win32-x64` tarball 1,292,370 → 2,241,201 bytes
(+948,831, +73.4%). The committed tree ships 3,650,560 bytes (+1,024) because the adapter is not yet
reachable and the linker drops it; Step 7 realizes the measured delta.

_MSRV resolution (2026-08-06)._ `cargo +1.85.1 check --locked --workspace` proved the old declared
floor was stale independently of DuckDB: existing Edition 2024 let-chains require Rust 1.88. All
four workspace crates, the root README, showcase guide, and native-tool recovery text now declare
Rust 1.88. `cargo +1.88.0 check --locked --workspace` succeeds, so the published floor matches the
code and also clears DuckDB 1.5.5's Rust 1.85.1 client requirement.

_Adapter._ `direct_executor/catalog_sqlite.rs` is the only file in the repository that knows the
Catalog is SQLite. It owns schema version 3 in `user_version`, an explicit `migrate` step, a finite
5-second busy timeout, `quick_check` integrity verification, quarantine, and a project-identity
guard. Evidence is normalized into `entry`, `entry_class`, and `entry_name` with `ordinal` columns so
committed rows round-trip byte-identically to the in-memory adapter. Schema v3 gives each entry a
compact integer identity; child evidence and its secondary indexes no longer repeat a project-relative
path for every class and serialized name. Queries are indexed rather than
scanned: maps use a partial `entry(relative_path) WHERE is_map = 1` index, exact classes and
serialized names use equality indexes, and class prefixes and class-name suffixes become half-open
range scans over `class_path`
and a stored `class_name_reversed` column. Pagination is keyset, ordered by project-relative path,
and both adapters now share one cursor and page-limit rule in `catalog.rs`. Catalog files live in a
versioned `catalogs-v1` cache subdirectory under a `project-<fnv1a64>.catalog` name that carries no
project path; Windows separator, trailing-separator, and case aliases hash to one Catalog and are
fixture-tested.
The v1/v2 migration rebuilds the disposable Catalog into schema v3 and runs a one-time `VACUUM`.
Rebuilding derived evidence is cheaper and safer than a multi-gigabyte row-by-row key migration.

_Bounded writes._ Refresh reads one compact ordered signature/profile snapshot and never hydrates
class or serialized-name evidence merely to compare signatures or detect deletion. Unchanged entries
cost no SQL lookup and no write. Later generations write only changed evidence into a connection-local
temporary `staged_entry` table inside one staging transaction. Generation one has no prior readers or
evidence to preserve, so it writes directly into an unpublished transaction and builds secondary
indexes only before atomic commit, avoiding the former in-memory staging copy and second full write.
Observed paths are tracked in memory, deletions
are computed only after enumeration completes, and one `BEGIN IMMEDIATE` transaction publishes
deletions, staged evidence, the summary, and the next Generation together. Commit streams staged
rows in 1,024-row batches so publication never materializes a whole project. Refreshes with at
least 4,096 changed or removed packages drop and rebuild secondary evidence indexes inside that
transaction, avoiding row-by-row index maintenance on large cold rebuilds while retaining indexes
for small changes.

_Journal mode._ WAL is the measured default. After the compact snapshot/schema/direct-publication
changes, `journal_mode_refresh_measurement` (an `--ignored` timing test in the adapter) over 20,000
packages records WAL cold 2.37 s / warm 0.085 s against rollback-journal cold 2.34 s / warm 0.086 s.
A truncating `wal_checkpoint` after each successful commit keeps sidecar cost bounded: the current
test Catalogs are 6,230,016 bytes (WAL) and 6,197,248 bytes (rollback). Both modes pass the whole
conformance suite, both keep a second
reader on the previous committed Generation while a refresh stages, and rollback stays selectable.

_Conformance._ `catalog_conformance.rs` holds one adapter-neutral suite of eleven scenarios invoked
through `catalog_conformance_tests!` against the in-memory adapter, SQLite in WAL mode, and SQLite in
rollback mode — 33 shared tests plus 11 SQLite-specific ones and 1 ignored measurement. The suite
covers cold/warm no-op header
reuse, rebuild, add/change/delete/rename/sidecar, cancellation, injected failure, stale generations
and stable ordering, signature revalidation, all five query kinds, bounded keyset pagination with
rejected limits and cursors, absent/foreign project identity, and stale-Index-Profile evidence
rebuild that retains the signature. `memory_and_sqlite_adapters_answer_fixtures_identically` compares
summaries, status, committed paths, per-path round-trips, and every query kind at three page sizes.
SQLite-specific tests prove a warm no-op writes zero evidence rows, an injected commit failure rolls
back and deletes nothing while leaving the Catalog usable, reopening serves the committed Generation,
a non-database file / newer schema version / foreign project identity is quarantined and kept for
inspection, and rebuild discards the exact Catalog files. The suite never names SQL, pragmas, journal
files, or migrations.

_Gates added._ `pnpm run uasset:architecture` now fails if any `crates/uasset-io/src` file other than
`catalog_sqlite.rs` mentions a SQLite crate, SQLite vocabulary, a pragma, SQL DDL/DML, or a
journal/migration detail; if the portable crates gain a SQLite dependency; or if `uasset-io` stops
pinning an exact rusqlite version with default features off. `pnpm run license:check` now validates
the whole `Cargo.lock` graph against a recorded permissive-license set, failing on an unrecorded
crate, a non-permissive license, or a stale record, with three new unit tests.

_Not yet wired._ Protocol and TypeScript adapters remain untouched, so no product path reaches the
SQLite Catalog until Step 7. `cargo test -p uasset-io --all-targets` is green (63 library tests plus
13 protocol-process tests, 1 ignored measurement).

### Step 7 — Connect protocol and TypeScript adapters

1. Route v1.1 operations through the Rust coordinator and SQLite adapter.
2. Have TypeScript supply only the cache root and policy; consume the opaque Catalog reference.
3. Stream refresh progress without inventory rows.
4. Reject stale cursors/Generations and oversized page requests with typed recovery.
5. Instrument refresh, changed/header-read counts, transaction duration, query latency, cache bytes,
   evidence-row writes, generation transitions, and rebuild/quarantine events without recording
   paths or asset identities.

**Gate**: a representative refresh emits no `scan_inventory` frames and every response remains
bounded regardless of total project size.

**Implementation evidence (2026-08-05)**:

_Native protocol wiring._ `direct_executor/project_index_io.rs` opens the production Catalog under
the caller-supplied cache root, drives the storage-neutral coordinator with
`FilesystemProjectScanner`, and converts Catalog values into protocol result frames. `protocol_adapter`
routes `project_index_status` / `refresh` / `rebuild` / `query` through that path; refresh runs on a
worker thread and streams `enumerating` / `comparing` / `reading_headers` / `committing` progress
without any `scan_inventory` frames. Failed frames carry optional `expectedGeneration` /
`actualGeneration` for `stale_generation`. A corrupt Catalog still quarantines before refresh and
emits a path-free `catalog_quarantined` diagnostic. After each successful refresh the worker emits a
`project_index_metrics` diagnostic with generation, package/changed/removed counts, evidence-row
writes, storage bytes, and duration only.

_TypeScript process adapter._ `project-index-process.ts` is the production Project Index layer:
TypeScript supplies cache root + worker executable/timeout, builds v1.1 protocol requests, maps
progress/summary/page/failure frames onto the public Effect surface, and never names SQL or Catalog
files. `ProjectIdentity` now accepts a full project-root path length so wire summaries decode.
Optional `nextCursor` serializes only when present so pages stay schema-valid. Effect metrics cover
refresh/query duration, changed/removed packages, generation, cache bytes, evidence writes,
quarantines, and terminal state.

_Proof._ `protocol_process::project_index_refresh_emits_bounded_summary_without_inventory` refreshes
the shared fixture Catalog, asserts zero `scan_inventory` frames, warm `changedPackages == 0`, a
bounded maps page, and a typed stale-generation failure with generation fields. The TypeScript
process integration test (gated on `UE_SHED_UASSET_EXECUTABLE`) exercises the same journey through
`projectIndexProcessLayerWithConfig`. `cargo test -p uasset-io --all-targets`,
`pnpm run uasset:architecture`, and `pnpm exec vitest run packages/protocol/src packages/unreal-assets/src`
are green.

_Not yet migrated._ Workbench and domain consumers still use the legacy `scanProject` inventory path
until Step 8. CLI Project Index commands land in Step 10.

### Step 8 — Migrate consumers incrementally

Migrate one consumer at a time, retaining old behavior until its focused tests pass:

1. Project summary and maps.
2. Saved DataTable candidates/catalog.
3. Enhanced Input candidates.
4. Game Text candidates.
5. Texture Audit candidates.
6. Map Review saved-project access.

Replace `WorkbenchProject.index(): SavedAssetScan` with the public Project Index reference/query
interface. Candidate pages may be folded internally for existing explicit-path extractors, but no
caller receives the whole project inventory. Domain modules retain all interpretation and result
schemas.

**Gate**: each migrated domain uses the same headless interface in package/CLI tests before its
Workbench adapter switches.

**Implementation evidence (2026-08-05)**: Workbench project summary and saved-map access use the
headless Project Index process adapter. `WorkbenchProject.index(): SavedAssetScan` has been removed.
Its replacement accepts a domain candidate kind and folds only that domain's bounded pages. Texture
Audit, Game Text, Input Atlas, and saved DataTables request distinct filters, and existing domain
extractors receive only explicit candidate paths. Saved DataTables perform one explicit-path header
batch over indexed candidates to recover authoritative export object paths rather than manufacturing
them or widening the Catalog contract. Focused Workbench and domain tests prove filter isolation and
that the legacy inventory path is never invoked.

### Step 9 — Retire Workbench-owned caches

1. Introduce the new Catalog cache-root version without importing either old JSON schema.
2. Keep `project-indexes-v1` and `project-inventories-v1` untouched until the first SQLite refresh
   commits successfully.
3. Remove `ProjectInventoryCacheLive`, `projectIndexCacheLocator`, manifest hashing/materialization,
   and their tests only after every consumer has migrated.
4. Retire exact obsolete per-project files through versioned cleanup or leave them for documented
   cache cleanup; never broadly delete user-data directories.
5. Keep rebuild available through CLI and Workbench with typed progress and recovery.

**Gate**: Workbench opening writes no JSON inventory/header cache and a missing/corrupt Catalog
rebuilds without losing project selection or hiding the error.

**Implementation evidence (2026-08-05)**: `ProjectInventoryCacheLive`, its adapter file,
`projectIndexCacheLocator`, Workbench manifest hashing/materialization, and the old inventory-cache
tests are deleted. Workbench composition requires Project Index and names only the versioned
`project-catalogs-v1` root. Old JSON files are left untouched as disposable legacy data; no runtime
code reads or writes them. SQLite corruption/quarantine, first-generation rollback,
later-generation rollback, concurrent-reader, and rebuild tests remain green.

### Step 10 — Add headless CLI and adoption evidence

1. Add bounded Project Index status, refresh, maps, and candidate-query CLI commands.
2. Require explicit project selection and machine-readable typed output.
3. Use the same `@ue-shed/unreal-assets` Project Index module as Workbench.
4. Document cache-root configuration, disposable-data behavior, generation staleness, rebuild, and
   worker-version recovery.
5. Update `@ue-shed/unreal-assets`, `uasset-io`, protocol, benchmark, and showcase documentation.

**Gate**: a clean headless invocation refreshes and queries the fixture without Electron or
Workbench code.

**Implementation evidence (2026-08-05)**: the Effect CLI exposes `project-index status`, `refresh`,
`rebuild`, `maps`, and domain-neutral `query` subcommands. Each requires an explicit project and
disposable cache root, optionally accepts a compatible reader, uses the same public process layer as
Workbench, and emits machine-readable JSON. Page commands bind the committed Generation returned by
status, enforce the 1,024-item cap, and never refresh implicitly. CLI help/parser and headless
refresh/query usage tests are green; root and package documentation cover cache ownership, explicit
refresh, stale paging, and rebuild recovery.

### Step 11 — Prove the representative project and attribute bottlenecks

1. Run cold, warm, one-change, delete, cancellation, corruption, and query benchmarks against the
   representative large project.
2. Verify unchanged refresh reads zero package headers, rewrites zero package evidence rows, and
   emits only bounded lifecycle output after signature comparison.
3. Verify one changed package reads exactly one header, and verify changed/deleted counts and
   generation transitions against controlled fixture mutations.
4. Verify Workbench loads the representative project and presents useful failures.
5. Record repeated-sample p50/p95 duration and peak RSS for process startup and Catalog open,
   filesystem enumeration/stat, signature lookup/comparison, header reads, staged evidence writes,
   commit/checkpoint, query execution, protocol transport, and TypeScript folding. Do not report only
   the end-to-end wall time or infer a storage bottleneck from it.
6. Record database bytes, write amplification, protocol bytes, and cache behavior without
   project-specific names or paths. Compare rollback-journal and WAL behavior if both remain viable.
7. Add adapter-internal, bounded analytical probes over evidence the Catalog already owns: total
   entry/package/sidecar count and bytes, grouping by kind and coarse project-relative path bucket,
   class counts, and top-N package sizes. These probes establish storage capability and latency; they
   do not add raw SQL, generic querying, or an analytics promise to the public interface.
8. State the acceptance budgets before interpreting results. Identify whether SQLite is a material
   contributor after unavoidable filesystem and header work is separated, and record one of:
   `sqlite_accepted`, `duckdb_probe_warranted`, or `inconclusive` with the supporting measurements.

**Benchmark harness readiness evidence (2026-08-05)**: `apps/workbench/scripts/benchmark-project-index.ts`
now exercises the production SQLite-backed Project Index instead of the legacy JSON inventory cache.
Each sample refreshes the configured Catalog, pages Maps plus the class/prefix/suffix/serialized-name
queries, folds bounded headers in TypeScript, and optionally decodes explicit Enhanced Input
candidates. Evidence schema version 3 records only aggregate counts, Generation transitions, cache
bytes, protocol bytes/frames, RSS, and p50/p95 wall-time distributions; supplied project paths and
asset identities remain rejected.

The native refresh diagnostic now carries path-free enumeration, signature-comparison,
header-reading, and commit timings. The benchmark records those timings alongside refresh wall time,
bounded query time, TypeScript folding, and targeted decode time. Project Index protocol workers now
finalize the shared protocol telemetry boundary, so worker output bytes, largest frames, and RSS are
included for refresh and query operations as well as AssetReader follow-ups. A fixture smoke run
completes cold and warm samples without an inventory frame or an unbounded response. Representative
project runs and controlled mutation/cancellation/corruption measurements remain pending; no
SQLite/DuckDB decision is inferred from the fixture smoke run.

**Initial representative refresh probe (2026-08-05, before staging/index optimization)**: the corrected local corpus contains 185,690 packages,
228 maps, and 99,735,757,773 Content bytes. A production-worker refresh-only probe completed with
the SQLite Catalog and recorded 104.24 seconds cold and 16.03 seconds warm (one warmup and one
timed warm sample). Cold native timing was 4.11 seconds enumerating, 5.17 seconds reading headers,
and 63.66 seconds committing, with 185,690 staged and committed evidence rows and a
3,022,163,968-byte Catalog. Warm native timing was 8.41 seconds enumerating, zero header reads,
and 0.13 seconds committing; the Catalog remained 3,017,379,840 bytes. Refresh protocol output was
75,801,145 bytes cold and 37,288,705 bytes warm, with one worker per refresh.

This is materially above the pre-migration comparison supplied for this corpus (approximately
11 seconds cold and 6 seconds warm). It flags the SQLite commit phase as a serious cold-path probe
candidate, while warm cost is dominated by whole-project signature enumeration and process/output
overhead. It does not yet justify switching storage: the full candidate workload did not complete
because the original 256-item page cap expanded the representative filters to roughly 53 or more sequential
worker queries (including 10,786 Texture2D, 554 DataTable, and 1,060 `Text`-name candidates).
The next benchmark iteration must separate query-worker orchestration from storage and run the same
workload against a time-boxed DuckDB probe only after those controls are in place.

**Pre-SQLite baseline (2026-08-05)**: the same project was measured from an isolated clean worktree
at commit `068343e5c782fa2b54b3e1e97d6b259745d9cafb` (`feat(uasset): deepen headless project index
refresh coordinator`), before the SQLite Catalog adapter. The legacy JSON/header-cache benchmark
completed three cold and three warm samples. Cold was 10.634 seconds mean, 10.534 seconds p50,
and 10.873 seconds p95. Warm was 5.967 seconds mean, 5.989 seconds p50, and 5.998 seconds p95.
The legacy cache was 57,888,840 bytes; cold samples emitted 734 headers and decoded 165 Enhanced
Input candidates, while warm samples reported 185,690 cache hits. The legacy protocol emitted
72,984,414 bytes cold and 71,751,405 bytes warm. Complete machine-readable evidence is retained at
`test-results/project-index-arif-mbresearch-pre-sqlite.json`.

This is not a claim of identical end-to-end work: the legacy scenario transmits the complete
inventory and performs the targeted Input decode, while the current representative measurement is
refresh-only because its bounded candidate workload expands to dozens of worker queries. That makes
the regression more concerning, not less: current SQLite refresh alone is 104.24 seconds cold and
16.03 seconds warm, versus 10.634 and 5.967 seconds for the pre-SQLite path. The comparison now
establishes a clean baseline for attributing the excess to Catalog commit work, signature
enumeration, and query-worker orchestration before selecting a storage replacement.

**SQLite staging/index probe (2026-08-05)**: the adapter was then changed to schema version 2:
staged evidence is connection-local temporary state committed once before publication, the map
index is partial, and large refreshes rebuild secondary evidence indexes once instead of maintaining
them for every row. On the same corpus, one cold and one warm sample (after one warmup) recorded
58.26 seconds cold and 15.93 seconds warm. Cold native timing was 4.10 seconds enumerating, 2.97
seconds reading headers, and 28.45 seconds committing; warm native timing was 8.44 seconds
enumerating, zero header reads, and 0.12 seconds committing. The cold Catalog was 2,334,810,112
bytes and the warm Catalog was 2,330,288,128 bytes; protocol output remained 75,801,144 bytes
cold and 37,288,705 bytes warm, with one worker per refresh. The staging-only pass had been 82.66
seconds cold with a 50.32-second commit and a 2,437,369,856-byte Catalog, so the index rebuild
alone removed roughly 22 seconds from the cold path. This is a meaningful improvement, but it is
still 5.5× the pre-SQLite cold baseline and 2.7× the warm baseline; the evidence does not yet
justify DuckDB because whole-project signature enumeration and per-page process orchestration
remain separate costs.

**SQLite publication/query probe (2026-08-05)**: publication now reuses one prepared statement set
per batch and skips evidence deletes on generation 1. The refresh-only result moved to 56.81 seconds
cold / 15.67 seconds warm, with native commit at 26.59 seconds cold / 0.12 seconds warm. The wire
page bound was raised from 256 to 1,024 while remaining bounded; the invalid contract fixtures now
reject 1,025. Query workers skip the full Catalog `quick_check` on read-only opens; refresh, rebuild,
and status retain integrity verification, and a damaged query page remains a typed failure whose
next refresh quarantines the Catalog.

The complete representative workload now finishes. One cold and one timed warm sample (after one
warmup) recorded 60.24 seconds cold and 17.75 seconds warm, with 17 query pages rather than 56.
Refresh accounted for 58.10 / 15.90 seconds, bounded query execution for 1.82 / 1.75 seconds,
and TypeScript folding plus targeted Input decode for 0.22 / 0.07 seconds. Cold native timing was
4.28 seconds enumerating, 3.02 seconds reading headers, and 27.82 seconds committing; warm timing
was 8.52 seconds enumerating, zero header reads, and 0.13 seconds committing. Aggregate cold/warm
protocol output was 98,003,690 / 58,258,962 bytes, largest frame 2,136,187 bytes, Catalog bytes
2,330,255,360, and peak Rust RSS 1,941,671,936 / 173,350,912 bytes. The query workers are no
longer the dominant cost; SQLite publication and the unavoidable whole-project signature pass are.
This evidence initially supported a time-boxed `duckdb_probe_warranted` comparison, but the next
probe showed that much of the apparent storage-engine cost was avoidable row-oriented coordinator,
schema, progress, and timing behavior rather than SQLite itself.

**Corrected SQLite usage probe (2026-08-05)**: refresh now compares a single compact metadata
snapshot, never loads multivalued evidence on a warm comparison, reads changed headers with four
bounded workers, and emits progress only at phase boundaries and 1,024-package intervals. Timing
accumulates `Duration` values before converting to milliseconds; the former implementation rounded
hundreds of thousands of sub-millisecond intervals down individually, leaving 22.87 seconds cold and
4.94 seconds warm unattributed. Schema v3 uses integer entry identities for child evidence, inserts
bounded arrays set-wise, and publishes generation one directly inside its still-invisible transaction.
Cancellation or injected failure rolls that transaction back to an absent Catalog; later-generation
readers continue to observe the previous commit.

The clean one-run confirmation on the same representative project (now 185,676 packages) recorded
31.43 seconds cold and 7.73 seconds warm. Refresh accounted for 29.46 / 5.96 seconds and the same 17
bounded query pages for 1.74 / 1.66 seconds. Correct native phase timing was 4.55 seconds enumeration,
0.02 comparison, 14.52 parallel header processing plus direct evidence insertion, and 10.33 commit/
index publication cold; warm was 4.63 enumeration, 0.11 comparison, zero header work, and 0.10 commit.
The Catalog is 647,307,264 bytes, peak Rust RSS is 598,196,224 / 149,839,872 bytes, and aggregate
protocol output is 22,263,760 / 20,808,735 bytes. Cold publication stages zero duplicate evidence
rows and commits 185,676; warm stages and commits zero.

Relative to the preceding full SQLite run, wall time falls 47.8% cold and 56.5% warm, Catalog bytes
fall 72.2%, cold Rust RSS falls 69.2%, and protocol traffic falls 77.3% cold / 64.3% warm while query
latency remains approximately 1.7 seconds. The 5.96-second warm refresh now matches the complete
5.97-second pre-SQLite warm baseline before bounded queries are added. Cold remains roughly 3x the
legacy filter-specific workload because the foundational index materializes query-neutral evidence
for every package; its 10.33-second index publication is still a storage candidate, but no longer an
engine-level catastrophe. Record the storage decision as `inconclusive`: isolate direct evidence
insertion from header parsing and finish mutation/recovery scenarios before deciding whether the
remaining cold-only opportunity warrants DuckDB.

**Completed consumer-migration and attribution benchmark (2026-08-05)**: after deleting both
Workbench JSON-cache paths and migrating every Workbench domain to bounded candidates, three cold
and three timed warm samples completed against the same 185,676-package corpus. Cold wall time was
34.19–37.12 seconds (34.86 p50, 37.12 p95, 35.39 mean); warm was 7.81–7.95 seconds (7.84 p50,
7.95 p95, 7.87 mean). Every sample completed 17 bounded pages and returned 13,403 unique candidate
headers. Cold samples decoded 165 Enhanced Input packages. The Catalog remained 647,307,264 bytes;
cold Rust peak RSS was 593.9–597.4 MiB and warm peak RSS was 149.9–150.7 MiB.

The new storage split attributes 6.01–6.17 seconds of each cold run directly to SQLite evidence
writes. Commit, secondary-index publication, and transaction completion cost another 10.27–10.76
seconds. Header processing outside those writes cost 11.26–12.83 seconds, filesystem enumeration
4.59–5.43 seconds, all bounded queries 1.67–1.81 seconds, TypeScript folding 0.08–0.09 seconds, and
targeted Input decode 0.15–0.16 seconds. Warm evidence writes are zero, commit is 0.10–0.11 seconds,
enumeration is 4.73–4.81 seconds, and the same queries cost 1.67–1.74 seconds. SQLite cannot
materially repair warm startup, but its cold write and publication work is approximately 16.6
seconds mean and is a material contributor independent of header parsing.

A separately marked disposable fixture passed controlled mutation probes: one timestamp change
read and committed exactly one package header with a 19.3 ms refresh, while one temporary package
deletion read zero headers, removed exactly one evidence row, and refreshed in 18.7 ms. Existing
cancellation, concurrent-reader, rollback, corruption, quarantine, and rebuild tests complete the
recovery evidence. Aggregate schema-v4 evidence is retained in ignored `test-results` JSON without
project paths or asset identities.

The pre-batching Step 11 decision was `duckdb_probe_warranted`. This was not a production-engine
decision: SQLite already met warm no-op, bounded-query, mutation, and recovery invariants. Before a
DuckDB probe, the remaining SQLite opportunity still had to be measured after bounded ingestion and
overlap rather than treating the earlier additive ~16.6-second storage attribution as immutable.

**Bounded SQLite ingest implementation (2026-08-05)**: before starting the DuckDB probe, the
filesystem scanner now streams deterministically ordered results from four header workers through a
bounded 1,024-result read-ahead window while the SQLite adapter flushes evidence in bounded
1,024-entry batches. This replaces the cold path's one-entry `write_committed_batch` calls, keeps
readers active during a Catalog flush, and preserves cancellation, rollback, and atomic Generation
publication. Focused tests prove ordered delivery and that SQLite does not flush before the batch
bound. The 52-package fixture completed cold and warm end to end; a 20,000-package synthetic Catalog
probe completed cold in 2.02–2.05 seconds with 271–281 ms attributed to evidence writes. These are
mechanical/conformance checks, not representative performance evidence. Temporarily return the
storage decision to `inconclusive` until the same 185,676-package workload is rerun against this
implementation; do not begin the DuckDB probe from the pre-batching measurements.

**Representative bounded-ingest measurement (2026-08-05)**: three cold and three timed warm samples
completed against the same 185,676-package workload. Cold wall time is 25.62–25.86 seconds (25.67
p50, 25.86 p95, 25.72 mean), down 27.3% from the prior 35.39-second mean. The pipelined header/write
phase is 8.93–9.21 seconds; evidence-write work inside that phase is 4.69–4.80 seconds, while time on
the consuming thread outside SQLite writes is 4.23–4.41 seconds. The former additive
17.28–19.00-second phase therefore falls by roughly half because header workers remain active during
bounded Catalog flushes. Cold commit and secondary-index publication remains 10.14–10.33 seconds,
essentially unchanged. All 17 bounded query pages remain 1.66–1.74 seconds. Warm wall time is
7.54–7.61 seconds (7.55 p50, 7.61 p95, 7.57 mean), with zero header reads/evidence writes and a
99–100 ms commit. Catalog bytes remain 647,307,264; cold Rust peak RSS is 578.7–579.6 MB.

Restore the Step 11 decision to `duckdb_probe_warranted`, now against the post-batching baseline.
The time-boxed comparison must target the remaining ~10.2-second cold index/publication phase; it
must not claim the already-overlapped evidence-write duration as another additive saving. Retain
SQLite unless an equal-workload adapter improves end-to-end cold latency enough to justify its
packaging, dependency, memory, and conformance cost.

**DuckDB probe result (2026-08-05)**: DuckDB 1.5.5 was exercised behind the existing Catalog seam,
using the same coordinator, 185,676-package workload, 17 bounded query pages, and shared adapter
conformance suite. An initial adapter that copied SQLite's indexed destination strategy was an
invalid OLAP comparison: it completed cold in 68.21–68.89 seconds, spent 26.71–27.07 seconds
publishing into indexed tables, and spent 22.51–22.98 seconds in N+1-style query hydration. A
follow-up isolated probe established the natural DuckDB shape: bulk `CREATE TABLE AS SELECT`
publication without indexes took 0.79 seconds, and all 17 route-equivalent pages using set-oriented
hydration over the unindexed columnar snapshot took 0.85 seconds. Building five route indexes after
the bulk load instead took another 12.67 seconds and produced no benefit commensurate with that
cold cost.

The corrected adapter therefore streamed changed evidence into unindexed staging tables, atomically
replaced the changed immutable snapshot with set-oriented table operations, skipped snapshot
replacement for a warm no-op, and answered each typed route with one bounded vectorized query. All
11 shared conformance scenarios passed. Three representative cold samples completed in 21.57–21.70
seconds (21.62 p50, 21.70 p95, 21.63 mean), 15.9% faster than SQLite's 25.72-second mean. Native
refresh fell to 18.42–18.52 seconds, with 3.61–3.70 seconds in publication versus SQLite's
10.14–10.33 seconds. DuckDB query pages cost 2.77–2.81 seconds versus SQLite's 1.66–1.74 seconds,
so route scans return about 1.1 seconds of the publication gain. Warm no-op mean was 7.75 seconds
versus SQLite's 7.57 seconds. Cold Rust peak RSS was 514–523 MB versus SQLite's 579 MB, and active
Catalog bytes were 181.7–184.0 MB versus SQLite's 647.3 MB. The release executable was 31,511,040
bytes versus SQLite's 5,639,168 bytes.

At the conclusion of the initial runtime probe, record `duckdb_adoption_warranted`; the follow-up
research and explicit Step 12 decision below later advance this to `duckdb_selected`. The repository
now truthfully requires Rust 1.88, resolving the client's Rust 1.85.1 requirement. DuckDB still
expands the locked graph by roughly 140 packages that require explicit license review, makes clean
bundled native builds materially slower, and grows the executable by about 25.9 MB. The time-boxed
dependency and adapter must remain out of the production graph until an adoption change records the
complete permissive-license graph, updates the storage-adapter architecture gate and ADR 0007,
proves locked offline/package builds, and repeats the full repository checks. Aggregate probe
evidence is retained in ignored
`test-results/project-index-arif-mbresearch-duckdb-columnar.json`; it contains no project path or
asset identity.

**DuckDB design research (2026-08-06)**: primary-source research and additional model experiments
show that the next Adapter should deepen further rather than preserve a mutable normalized file.
DuckDB permits cross-process readers only when the database is read-only, so publication should use
generation-specific immutable files plus an atomically replaced logical-Generation manifest. The
scanner should append one path-ordered package row with nested class/name `LIST` columns directly in
Arrow record batches. This removes the 631,258-row class relation and 7,724,306-row serialized-name
relation from both ingestion and hydration.

On the same 185,676-package evidence, the nested snapshot occupied 38.0–41.2 MB versus 59.0 MB for
unindexed normalized DuckDB and 647.3 MB for SQLite. The 17-page in-process query workload measured
0.54–0.82 seconds with a reused connection; a path-unordered copy cost 1.05 seconds and 55.8 MB.
Four threads matched or beat 8/16/32, a 32,768-row group was the best measured size/query compromise,
and a complete immutable generation copy took 622 ms. Explicit checkpoint work on bulk copies was
2–8 ms. These are exploratory model results, not yet an equal end-to-end Rust Adapter result.

The complete rationale, rejected alternatives, reproducible driver, and next bounded experiment are
recorded in `docs/engineering/duckdb-project-index-research.md`. Those results and the accepted
binary/dependency tradeoff support the Step 12 canonical selection. Step 13 must now test direct
Rust Arrow/List ingestion, immutable publication, persistent bounded query sessions,
one-change/delete behavior, previous-Generation readers, recovery, size, memory, licenses, and
offline builds before the production factory switches.

**Gate**: no operation hits the cumulative output limit, no whole manifest crosses into TypeScript,
the benchmark attributes rather than guesses at the dominant cost, and a storage decision is
recorded without private identifiers.

### Step 12 — Compare DuckDB and select the canonical Catalog

1. [x] Attribute the optimized SQLite baseline before comparing another engine.
2. [x] Exercise DuckDB behind the storage-neutral Catalog Seam with the same coordinator,
       conformance scenarios, representative project, and bounded query workload.
3. [x] Reject the SQLite-shaped indexed/N+1 DuckDB Implementation as an invalid OLAP design.
4. [x] Measure the natural bulk, unindexed, set-oriented DuckDB Implementation end to end.
5. [x] Record binary, dependency, memory, Catalog-size, cold, warm, publication, and query costs.
6. [x] Research nested evidence, row groups, ordering, thread count, checkpointing, immutable files,
       Arrow ingestion, connection reuse, and cross-process concurrency from primary sources and model
       experiments.
7. [x] Select DuckDB as the canonical Catalog from the complete evidence and retain SQLite only as
       the interim baseline until Step 13 cutover gates pass.

**Decision (2026-08-06): `duckdb_selected`.** The approximately 25.9 MB executable increase and
larger dependency graph are accepted for this foundational cache because the natural DuckDB
Implementation improved cold latency, storage, and memory while preserving the small Catalog
Interface. This is not permission to use DuckDB for unrelated domain persistence; Plan 033 retains
those decisions.

### Step 13 — Implement and cut over the canonical DuckDB Adapter

**Implementation progress (2026-08-06):** the pinned `duckdb` 1.10505.0 client (DuckDB 1.5.5) is
now compiled into `uasset-io` with only `bundled` and `appender-arrow`, with runtime extension
autoload/installation and external access disabled on every Adapter connection. The private
`catalogs-v2` layout publishes an atomically replaced JSON manifest over generation-specific
immutable snapshots, retains the current and previous physical files, and performs bounded
best-effort cleanup of older files.

The Adapter stores one path-ordered scalar row with nested class, class-name, and serialized-name
lists. Changed evidence and observed paths enter unpublished files as at-most-1,024-row Arrow
batches. Changed generations copy the prior immutable snapshot in bounded Arrow batches and
set-build the replacement from observed prior rows plus staged replacements; warm no-ops publish a
new logical Generation over the same physical snapshot. Read connections are read-only, capped at
four threads, and answer each route with one set-oriented bounded query.

The unchanged shared Catalog conformance suite passes against memory, SQLite, and DuckDB. Additional
DuckDB tests prove empty first publication, reopen, warm physical-snapshot reuse, corrupt-manifest
quarantine, and a reader retaining the previous snapshot while the next Generation publishes. The
complete locked Rust license graph is recorded, a locked offline native build passes, and two full
repository checks pass with isolated release/adoption builds taking approximately 2 minutes 20
seconds to relink the bundled engine.

The production factory now opens only DuckDB. Writable snapshots use the measured 32,768-row-group
layout through a private attach bootstrap, while every committed query connection remains read-only
with external access and extension autoload disabled. A storage-boundary check proves the former
SQLite module is compiled only for tests and `rusqlite` is only a development dependency, making its
eventual retirement a mechanical deletion. Workbench now renders a ready committed Generation and
its maps before starting a scoped background refresh; a genuinely absent Catalog still refreshes
synchronously. Persistent native query sessions, cold-ingestion memory follow-up, and the last
release/package evidence remain open before the retirement commit.

**Representative cutover rerun (2026-08-06):** the first three-sample production run exposed an
invalid query regression rather than a storage-engine regression. The Adapter used correlated
`UNNEST` predicates instead of the list-native predicates from the accepted model. Cold p50 was
36.77 seconds and warm p50 was 20.56 seconds; the same 17 pages consumed 15.80 / 15.64 seconds and
peak Rust RSS reached 1.46 / 1.40 GB. This result is retained as negative evidence at
`test-results/project-index-arif-mbresearch-duckdb-cutover.json`.

Replacing those predicates with `list_has_any`, `list_transform`, and `list_bool_or` restored the
natural nested model. Three corrected cold samples measured 22.93–23.33 seconds (23.20 p50, 23.33
p95), with 20.28 seconds refresh and 2.63 seconds across 17 bounded query pages at the median. Three
warm samples measured 7.37–7.39 seconds (7.37 p50, 7.39 p95), with 4.77 seconds refresh, zero header
or evidence writes, and 2.52 seconds of queries. The active Catalog is approximately 124 MB and warm
peak Rust RSS is 158–163 MB. Aggregate corrected evidence is retained at
`test-results/project-index-arif-mbresearch-duckdb-cutover-list-native.json`.

Against the bounded-ingest SQLite baseline, corrected production DuckDB is about 9.6% faster cold,
2.4% faster warm, and roughly 80.8% smaller on disk. Cold peak Rust RSS remains 894–899 MB versus
SQLite's roughly 579 MB and the earlier columnar probe's 514–523 MB, so cold ingestion memory remains
an explicit follow-up rather than being hidden by the wall-time win. Persistent query sessions also
remain justified: the list-native correction removes pathological SQL work, while the existing 17
process/connection launches still account for most of the remaining 2.5–2.8-second query phase.

1. Add the exact DuckDB 1.5.5 Rust client with only bundled and Arrow-Appender capabilities required
   by the Catalog. Disable runtime extension autoload/installation and record the complete locked
   dependency and license graph.
2. Create a new versioned cache layout using generation-specific immutable DuckDB files and one
   atomically replaced manifest. Do not migrate SQLite rows: both stores are disposable derived
   data, so the first DuckDB refresh rebuilds from the project and leaves the SQLite cache available
   only until successful publication.
3. Store one path-ordered row per package with scalar signature/header fields and nested `VARCHAR[]`
   class, class-name, and serialized-name evidence. Do not create ART indexes or normalized evidence
   child tables.
4. Convert each existing bounded 1,024-package scanner batch directly into an Arrow `RecordBatch`
   and append it to the unpublished snapshot while header workers continue. Preserve one traversal,
   deterministic result order, cancellation checkpoints, signature recheck after header read, and
   changed-only header decoding.
5. For a changed refresh, bulk-create the next path-ordered snapshot from unchanged rows in the
   prior read-only snapshot plus staged replacements and removals. Begin with the measured complete
   immutable-copy strategy; add a delta threshold only after end-to-end evidence proves additional
   Leverage without weakening publication semantics.
6. Close and checkpoint the new file before publishing its manifest. Retain the current and previous
   physical snapshots, clean older files with a bounded best-effort policy, and retry Windows files
   still held by readers rather than blocking publication.
7. Open query snapshots read-only and answer each bounded route with one set-oriented query. Add a
   persistent bounded query session so a workflow requiring several pages or predicates reuses one
   native process and connection. Pages remain individually bounded and no complete manifest enters
   TypeScript.
8. Change Workbench startup order: query the last committed Generation for the active route first,
   render it immediately, and perform refresh in the background. Surface refreshing/freshness state
   without replacing usable content with a loading-only state.
9. Keep route loading lazy. Workbench requests maps, text, texture, table, or input candidates only
   when the active workflow needs them; publication never means eagerly pulling every route into the
   Workbench.
10. Measure first-ever time to first useful route after direct Arrow/List ingestion and persistent
    queries. Add provisional cold-build route streaming only if that measurement remains outside the
    agreed UX budget, and tee it from the same scanner batches rather than creating or sequencing a
    second cache.
11. Run the shared Catalog conformance suite against memory, SQLite, and DuckDB during cutover.
    Explicitly prove warm no-op, one change, one deletion, cancellation, failed publication,
    corruption/quarantine, rebuild, stale Generation, and a separate process reading the previous
    snapshot while the next snapshot is written and published.
12. Benchmark 16,384 and 32,768 row groups and start query execution at four threads. Record cold and
    warm p50/p95, time to first committed route, time to fresh Generation, phase attribution, query
    pages, peak RSS, Catalog/WAL bytes, write amplification, executable/package size, and clean build
    time on the same representative workload.
13. Add a storage-decision ADR (or amend ADR 0007 with a clearly scoped Catalog amendment), update
    architecture/license/release checks, prove locked offline and packaged Windows builds, and run
    `pnpm check` twice.
14. Switch the production factory to DuckDB only after every gate above passes. Then remove the
    SQLite production dependency, Adapter, migrations, journal-specific tests, and obsolete cache
    layout references; retain storage-neutral coordinator and conformance coverage.

**Gate**: DuckDB is the selected canonical Catalog, but it is not the production factory until the
natural Adapter passes Interface conformance, immutable cross-process publication, recovery,
release, and equal-workload regression gates. The common warm launch serves the last committed
Generation before background refresh, and the true cold path is limited to absence, explicit
rebuild, deletion, quarantine, or incompatible schema/profile change.

## Verification matrix

| Scope                | Required evidence                                                                  |
| -------------------- | ---------------------------------------------------------------------------------- |
| Rust coordinator     | add/change/delete/rename/sidecars, revalidation, one traversal, atomic Generations |
| Catalog conformance  | memory/SQLite/DuckDB equivalence, immutable publication, recovery, pagination      |
| Protocol             | schema fixtures, v1.0 compatibility, v1.1 ops, stale generation, bounded pages     |
| TypeScript module    | lifecycle, typed failures, cache-root policy, progress, pagination                 |
| Domain integration   | maps, tables, input, text, texture consume bounded candidates                      |
| CLI                  | explicit refresh/status/query/rebuild without Workbench                            |
| Workbench            | committed route before refresh, freshness/progress, failure/retry, no private JSON |
| Large project        | cold/warm/change/delete, attributed p50/p95, header/row writes, wire/DB bytes, RSS |
| Storage decision     | selected DuckDB; nested/immutable regression evidence; SQLite retirement           |
| Architecture/release | Rust 1.88/offline build, EXE/package size, licenses, portable crates unchanged     |
| Repository           | `pnpm check` passes twice at handoff                                               |

Focused commands must include:

```powershell
pnpm run uasset:architecture
cargo fmt --all -- --check
cargo clippy -p uasset-io --all-targets -- -D warnings
cargo test -p uasset-io --all-targets
pnpm --filter @ue-shed/protocol contract:check
pnpm exec vitest run packages/protocol/src packages/unreal-assets/src
pnpm exec vitest run packages/game-text/src packages/asset-audits/src packages/enhanced-input/src
pnpm exec vitest run apps/workbench/src/main apps/workbench/src/renderer apps/cli/src
pnpm benchmark:project-index -- --project <representative-project-root> --output test-results/project-index.json
pnpm check
```

## Done criteria

- [x] Failed project selection remains visible with message, recovery, and retry.
- [x] Project Index is a headless public module in `@ue-shed/unreal-assets`.
- [x] TypeScript owns cache-root/policy and never reads or writes a database directly.
- [x] Rust owns the private Catalog behind storage-neutral memory/SQLite adapters.
- [x] Refresh performs one traversal and decodes headers only for changed/new packages.
- [x] An exact warm no-op reads zero package headers and rewrites zero package evidence rows.
- [x] A committed Generation is atomic and stale queries are explicit.
- [x] Workbench project summary/maps use refresh progress and bounded Project Index map pages.
- [ ] Workbench and CLI use the same Project Index interface.
- [ ] No ordinary caller receives the complete project manifest.
- [ ] Old Workbench JSON caches are no longer written.
- [x] Generic `scanProject` and v1.0 protocol behavior remain compatible.
- [ ] Plan 033 domain-persistence gates remain intact.
- [ ] Representative large-project evidence passes without private identifiers in records.
- [x] Storage costs are attributed and DuckDB is selected from equal-workload measured evidence.
- [x] The natural DuckDB Adapter uses nested Arrow batches and immutable snapshot publication.
- [ ] Ordinary startup serves the last committed Generation before background refresh.
- [ ] Bounded query sessions reuse one native process/connection while route loading remains lazy.
- [ ] DuckDB passes dependency, license, offline, Windows package, size, recovery, and conformance gates.
- [ ] The production factory uses DuckDB and the interim SQLite Adapter/dependency are removed.
- [x] `pnpm check` passes immediately before handoff.

## STOP conditions

- Plan 033 still ambiguously forbids this foundational Catalog after the ownership clarification.
- Canonical project identity or Windows path-case semantics cannot be specified and tested.
- JavaScript must issue SQL or understand DuckDB schema/snapshot/manifest details.
- The Catalog must live inside the Unreal project or source control.
- Refresh requires a second project-wide traversal.
- Empty candidates can fall back to scanning `Content`.
- Partial, failed, or cancelled refresh can advance Generation or delete unseen packages.
- Old worker/new TypeScript negotiation is ambiguous or silently mis-decoded.
- An existing v1.0 operation must change meaning; design `uasset-io` v2 instead.
- A query can return an unbounded manifest or generic property graph.
- Domain meaning moves into the Catalog or `uasset-io` coordinator.
- Workbench remains the only usable Project Index caller.
- DuckDB cannot pass deterministic Windows packaging, offline build, license, or release gates.
- Immutable DuckDB publication requires weakening Catalog semantics or exposing storage details to callers.
- `pnpm check` fails.

## Out of scope

- Domain SQLite or DuckDB persistence for Game Text or Texture Audit before Plan 033 Step 8 evidence.
- A universal asset/property database or EAV schema.
- Filesystem watching, USN Journal, Perforce, or source-control-driven invalidation.
- Hosted, multi-user, or cross-machine Catalog sharing.
- A permanent runtime choice between SQLite and DuckDB after canonical cutover.
- Mutating Unreal assets or project files.
- A persistent multi-request `uasset` worker before measurements justify it.
- Removing generic `scanProject` or v1.0 protocol operations.
