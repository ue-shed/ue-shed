# Plan 037: Deepen the headless Project Index with a native Catalog

> **Executor instructions**: Preserve one project-wide `Content` enumeration, the public
> `AssetReader.scanProject` compatibility surface, and the separation established by ADR 0007.
> TypeScript owns cache-root configuration and user-facing refresh/rebuild policy. Rust owns the
> private Catalog file format and SQLite implementation. JavaScript must never issue SQL or depend
> on tables, migrations, journal files, or SQLite locking behavior. Do not store generic property
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

- **State**: IN PROGRESS — Step 5 complete
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
| Rust Catalog adapter            | SQLite schema, migrations, transactions, locking, integrity, quarantine           |
| Workbench                       | Project chooser, selected-project state, progress and failure presentation        |
| Domain modules                  | Text, texture, table, input, map, and authoring meaning                           |

TypeScript supplies a configurable cache root. Rust canonicalizes project identity, chooses and
manages the Catalog files beneath that root, and returns an opaque Catalog reference. The SQLite
schema is private implementation, not a second cross-language interface.

The production Catalog adapter uses SQLite. An in-memory adapter exercises the same Rust refresh
coordinator in tests. The two adapters make the storage seam real without requiring JavaScript to
link or query SQLite.

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

This ordering keeps the public interface independent from the storage implementation. The Project
Index becomes a deep module: its small lifecycle/query interface hides traversal, signature
comparison, header probes, Generations, transactions, migrations, locking, and recovery. The memory
and SQLite adapters make the Catalog seam real, while keeping storage-specific knowledge local to
the native adapter.

Do not introduce a sharded or per-module JSON cache as an intermediate architecture. It would retain
the shallow whole-index interface, duplicate invalidation and atomicity rules, and pay a second
migration cost without removing the unbounded protocol transfer. If SQLite fails a release gate,
keep the coordinator and memory adapter usable while reconsidering the production Catalog adapter.

The deletion test for this work is explicit: after consumer migration, deleting
`ProjectInventoryCacheLive`, `projectIndexCacheLocator`, Workbench manifest hashing/materialization,
and `WorkbenchProject.index(): SavedAssetScan` must not remove Project Index behavior. Deleting the
SQLite adapter alone must leave the coordinator and its in-memory adapter usable.

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
                 +---- SQLite adapter (production)
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
10. SQL, SQLite filenames, journal details, and migrations never cross the public TypeScript seam.
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

The SQLite implementation may persist only the evidence required to refresh and query the Project
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

The SQLite adapter owns transaction configuration, `user_version`/migration metadata, busy policy,
integrity checking, and any WAL/journal files. Evaluate the Rust SQLite dependency and features
against Windows packaging, binary size, license gates, and offline builds before accepting it.
Prefer a bundled SQLite only if it keeps released binaries deterministic and passes repository
license/release checks.

`rusqlite` with narrowly selected bundled SQLite features is the leading dependency probe, not an
accepted dependency. Pin an exact version only after proving compatibility with the repository's
Rust 1.85 floor. Do not enable broad convenience features or build-time binding generation without
measured need. The release probe must verify a locked offline build, a self-contained Windows
`uasset.exe` with no new runtime DLL requirement, the executable and npm-package size delta, and
Rust transitive-license evidence; the existing npm-focused license check is not sufficient alone.

WAL is also a measured adapter choice rather than a default architectural requirement. Start from
the required behavior—one writer refresh, bounded readers of the previous committed Generation, a
finite busy timeout, and atomic publication—then choose and document the journal mode that passes
concurrency, crash, packaging, and performance tests.

## Refresh and caching algorithm

The coordinator implementation must preserve this storage-neutral algorithm:

1. Canonicalize the project identity and open its disposable Catalog beneath the configured cache
   root. Windows path-case and alias behavior must be specified and fixture-tested before hashing a
   Catalog location.
2. Keep the current committed Generation queryable and create isolated staging state for the
   refresh. Do not mutate or delete committed rows in place while enumeration is incomplete.
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
   dependency only after Rust 1.85, license, locked-offline-build, release-size, self-contained EXE,
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

### Step 10 — Add headless CLI and adoption evidence

1. Add bounded Project Index status, refresh, maps, and candidate-query CLI commands.
2. Require explicit project selection and machine-readable typed output.
3. Use the same `@ue-shed/unreal-assets` Project Index module as Workbench.
4. Document cache-root configuration, disposable-data behavior, generation staleness, rebuild, and
   worker-version recovery.
5. Update `@ue-shed/unreal-assets`, `uasset-io`, protocol, benchmark, and showcase documentation.

**Gate**: a clean headless invocation refreshes and queries the fixture without Electron or
Workbench code.

### Step 11 — Prove the representative project and close

1. Run cold, warm, one-change, delete, cancellation, corruption, and query benchmarks against the
   representative large project.
2. Verify unchanged refresh reads zero package headers, rewrites zero package evidence rows, and
   emits only bounded lifecycle output after signature comparison.
3. Verify one changed package reads exactly one header, and verify changed/deleted counts and
   generation transitions against controlled fixture mutations.
4. Verify Workbench loads the representative project and presents useful failures.
5. Record database bytes, write amplification, transaction duration, query p95, protocol bytes, and
   peak RSS alongside wall time without project-specific names or paths.
6. Compare rollback-journal and WAL behavior if both remain viable after the adapter tests.
7. Run focused checks, full `pnpm check`, fix every failure, and run `pnpm check` again immediately
   before handoff.

**Gate**: no operation hits the cumulative output limit, no whole manifest crosses into TypeScript,
and all repository checks pass.

## Verification matrix

| Scope                | Required evidence                                                                   |
| -------------------- | ----------------------------------------------------------------------------------- |
| Rust coordinator     | add/change/delete/rename/sidecars, revalidation, one traversal, atomic Generations  |
| Catalog conformance  | memory/SQLite equivalence, no-op writes, migration, corruption, locking, pagination |
| Protocol             | schema fixtures, v1.0 compatibility, v1.1 ops, stale generation, bounded pages      |
| TypeScript module    | lifecycle, typed failures, cache-root policy, progress, pagination                  |
| Domain integration   | maps, tables, input, text, texture consume bounded candidates                       |
| CLI                  | explicit refresh/status/query/rebuild without Workbench                             |
| Workbench            | visible failure/retry, progress, ready project, no private JSON cache               |
| Large project        | cold/warm/change/delete, header/row writes, wire/DB bytes, RSS, query p95           |
| Architecture/release | Rust 1.85/offline build, EXE/package size, licenses, portable crates unchanged      |
| Repository           | `pnpm check` passes twice at handoff                                                |

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
- [x] TypeScript owns cache-root/policy and never reads or writes SQLite.
- [ ] Rust owns the private SQLite Catalog behind memory/SQLite adapters.
- [ ] Refresh performs one traversal and decodes headers only for changed/new packages.
- [ ] An exact warm no-op reads zero package headers and rewrites zero package evidence rows.
- [ ] A committed Generation is atomic and stale queries are explicit.
- [ ] Workbench and CLI use the same Project Index interface.
- [ ] No ordinary caller receives the complete project manifest.
- [ ] Old Workbench JSON caches are no longer written.
- [ ] Generic `scanProject` and v1.0 protocol behavior remain compatible.
- [ ] Plan 033 domain-persistence gates remain intact.
- [ ] Representative large-project evidence passes without private identifiers in records.
- [ ] `pnpm check` passes immediately before handoff.

## STOP conditions

- Plan 033 still ambiguously forbids this foundational Catalog after the ownership clarification.
- Canonical project identity or Windows path-case semantics cannot be specified and tested.
- JavaScript must issue SQL or understand SQLite schema/migration/journal details.
- The Catalog must live inside the Unreal project or source control.
- Refresh requires a second project-wide traversal.
- Empty candidates can fall back to scanning `Content`.
- Partial, failed, or cancelled refresh can advance Generation or delete unseen packages.
- Old worker/new TypeScript negotiation is ambiguous or silently mis-decoded.
- An existing v1.0 operation must change meaning; design `uasset-io` v2 instead.
- A query can return an unbounded manifest or generic property graph.
- Domain meaning moves into the Catalog or `uasset-io` coordinator.
- Workbench remains the only usable Project Index caller.
- SQLite cannot pass deterministic Windows packaging, offline build, license, or release gates.
- `pnpm check` fails.

## Out of scope

- Domain SQLite persistence for Game Text or Texture Audit before Plan 033 Step 8 evidence.
- A universal asset/property database or EAV schema.
- Filesystem watching, USN Journal, Perforce, or source-control-driven invalidation.
- Hosted, multi-user, or cross-machine Catalog sharing.
- Mutating Unreal assets or project files.
- A persistent multi-request `uasset` worker before measurements justify it.
- Removing generic `scanProject` or v1.0 protocol operations.
