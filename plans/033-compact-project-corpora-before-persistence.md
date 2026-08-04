# Plan 033: Compact project corpora before persistence

> **Executor instructions**: Follow this plan in order. Preserve the one native project-header
> enumeration already being introduced in the current worktree. Do not add SQLite, IndexedDB, a
> generic property database, or a second `Content` traversal while executing Steps 1–7. Measure the
> compact domain results first, then make the persistence decision in Step 8. Run every verification
> gate before advancing. If a STOP condition occurs, stop and report it rather than restoring the
> generic full-inspection payload or weakening corpus coverage.
>
> **Drift check (run first)**:
> `git status --short -- crates/uasset-parser packages/unreal-assets packages/game-text packages/asset-audits apps/cli apps/workbench extensions/game-text extensions/asset-audits plans`
> and
> `git diff -- crates/uasset-parser/src/bin/uasset.rs packages/unreal-assets/src/index.ts packages/game-text/src/corpus.ts packages/asset-audits/src/texture.ts apps/workbench/src/main/services/project-workspace.ts apps/workbench/src/main/services/game-text.ts apps/workbench/src/main/services/asset-audits.ts`.
> The current worktree contains uncommitted project-index, schema-compatibility, and `--path-list`
> work. Re-read those files and reconcile this plan before editing; do not overwrite another agent's
> changes.

## Status

- **State**: IN PROGRESS — compact projections and paged Workbench queries are implemented;
  complete comparative evidence and the persistence decision remain
- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — this changes native reader contracts, saved-asset process transport, domain
  corpus construction, public headless interfaces, CLI behavior, Workbench IPC, and renderer data
  ownership.
- **Depends on**: ADR 0004 and the current project-index worktree
- **Category**: direction
- **Planned at**: current dirty worktree, 2026-07-30

## Plan 036 handoff

Recorded 2026-07-30:

- Plan 036 may relocate generic parser, inspection, filesystem, scheduling, and process-transport
  implementation while preserving this plan's compact extraction contracts.
- This plan retains ownership of text/texture meaning, identity and coverage accounting, compact
  benchmark acceptance, and the persistence decision.
- The shared invariants remain: one project-header enumeration, explicit candidate paths only,
  empty candidate paths mean zero work, compact evidence before TypeScript transport, and no generic
  full-inspection bulk route.
- Any change to those invariants, fixture meaning, benchmark budget, or persistence requires review
  under this plan.

## Plan 037 ownership clarification

Recorded 2026-08-04:

- Plan 037 owns the foundational saved-package Catalog: package/sidecar signatures, compact
  package-header evidence, atomic generations, and bounded candidate queries.
- Plan 033 retains the persistence decision for compact Game Text and Texture Audit query models.
- A Rust-managed SQLite Catalog under Plan 037 does not authorize a universal property database or
  domain corpus persistence here.
- The shared invariants remain one project-wide enumeration, compact evidence, explicit candidate
  paths, zero work for empty candidates, bounded IPC, and headless availability.

## Current local evidence (not a storage decision)

The opt-in `benchmark:compact-text` command records aggregate evidence under ignored
`test-results` only. A local large-project run on 2026-07-30 produced one shared header index of
182,626 inventory files/packages in 5,892 ms. The explicit-candidate text extraction then opened
7,057 packages in 8,228 ms, yielding 343,435 occurrences, 12,495 explicit coverage gaps, and no
failed packages. It did not perform a second `Content` enumeration.

This establishes the compact path is viable, but it is deliberately not yet the Step 8 storage
decision: the benchmark still needs generic-vs-compact output-byte and peak-RSS comparisons, plus
the texture equivalent and bounded IPC size evidence.

## Why this matters

The shared header index now answers which packages may contain DataTables, Enhanced Input assets,
String Tables, `FText`, and Texture2D exports in one native enumeration. Data Authoring and Input
Atlas can project useful results directly from that index.

Game Text and Texture Audit need property evidence that is not present in package headers, so they
must still open candidate packages. Their current implementation crosses the wrong seam:

1. the header index selects candidate package paths correctly;
2. the generic full scan decodes and serializes complete saved-asset inspections;
3. `@ue-shed/unreal-assets` retains every inspection in one `SavedAssetScan`;
4. the domain packages discard almost all of that data after extracting text or texture facts;
5. Workbench IPC returns the complete domain corpus to the renderer;
6. renderer filtering repeatedly walks the whole result.

Large-project evidence shows that generic inspection output can reach multiple gigabytes and take
tens of seconds even though the domain facts are narrow. That does not prove a searchable
whole-project corpus is impossible. It proves the saved-asset module is shallow for corpus queries:
callers must understand and pay for the parser's complete implementation to obtain a small result.

The required deepening is a compact corpus extraction module. Its interface is candidate packages
in, versioned domain facts and coverage out. Package parsing, recursive property traversal,
diagnostics, NDJSON framing, subprocess transport, cancellation, and temporary path-list cleanup
remain implementation details behind that interface.

## Product decisions fixed by this plan

- Full-project Game Text search remains a product requirement. Piece-by-piece package inspection is
  a drill-down path, not the primary discovery model.
- Texture Audit still presents the corpus before applying rules. It does not become a package picker
  or validator log.
- The global project header index remains the only project-wide enumeration in Workbench.
- Game Text and Texture Audit may open only the explicit candidate package paths projected by that
  index.
- Generic saved-asset inspection remains available for explicit package drill-down, but corpus
  routes must not use it as their bulk transport.
- Rust projection code belongs in the portable parser library. Native filesystem enumeration,
  concurrency, NDJSON transport, caching, and path-list files remain adapters around it, preserving
  ADR 0004 and WASM parity.
- Domain packages own normalized text and texture meaning. The Rust reader emits compact evidence;
  it does not become the authority for Workbench presentation, text grouping, audit rules, or
  renderer state.
- Workbench main retains the active compact query model. Renderer IPC is paged and validated; it
  never returns every text unit, occurrence, or texture record in one response.
- SQLite remains a possible later adapter. IndexedDB is not the authoritative corpus store because
  it is renderer/profile scoped and cannot naturally serve the CLI or public headless packages.
- Do not introduce a universal asset/property schema or EAV database. Text and texture evidence keep
  their specialist domain models.
- No source text, translation text, project paths, or asset identities enter ordinary telemetry or
  committed benchmark records.

## Target flow

```text
one project header index
        |
        +-- DataTables ----------> header projection
        +-- Input Atlas ---------> header projection
        +-- text candidates -----> portable text projection ----+
        +-- texture candidates --> portable texture projection -+--> compact query modules
                                                                  |
                                            CLI queries <---------+---------> paged Workbench IPC
```

The text and texture projections may initially reuse existing complete property decoding internally.
They must project before JSON serialization and before crossing into TypeScript. If measurement
shows decoding itself remains dominant, Step 7 narrows the parser implementation without changing
the projection interface.

## Required interfaces

Exact names may change to follow package conventions, but the responsibilities may not collapse.

### Saved-asset extraction interface

`@ue-shed/unreal-assets` exposes scoped, streaming operations for explicit candidate paths:

```ts
extractProjectText(options): Stream<TextExtractionEvent, AssetReaderError>
extractProjectTextures(options): Stream<TextureExtractionEvent, AssetReaderError>
```

The interface includes:

- project root and explicit candidate paths;
- concurrency and maximum-asset limits;
- versioned occurrence/record, coverage-gap, package-result, progress, and summary events;
- interruption-safe child-process and temporary-file cleanup;
- bounded per-line decoding with runtime schema validation;
- no filesystem discovery when candidate paths are supplied.

It does not expose Rust `DecodedAsset`, complete generic inspections, or a storage technology.

### Game Text query interface

`@ue-shed/game-text` owns a scoped query module built from the extraction stream:

```ts
refreshFromProjectIndex(index, options);
status();
search(query);
focus(textUnitId);
```

The query input owns normalized search text, capability filters, occurrence-kind filters, stable
ordering, cursor/page size, and an explicit maximum page size. Search returns a page plus corpus
coverage, not the complete `TextCorpus`. Focus returns one unit and its occurrences.

The first implementation is in memory. This is not a storage seam yet; add a persistence seam only
if Step 8 proves a second adapter is required.

The existing `TextCorpus` result may remain as a bounded CLI/export compatibility shape. The
Workbench must not request or retain that whole result during ordinary browsing and search.

### Texture Audit query interface

`@ue-shed/asset-audits` owns a scoped query module built from compact texture records:

```ts
refreshFromProjectIndex(index, options);
summary();
search(query);
record(textureObjectPath);
```

Summary returns coverage, distributions, findings, and bounded diagnostics. Search returns a stable
page of compact records/findings. Record returns one detailed item. Audit rules continue to execute
over the same compact facts; no separate validation scan is permitted.

The existing `TextureAuditReport` may remain as a bounded CLI/export compatibility shape. The
Workbench must use the paged query interface for its ordinary audit view.

## Native projection contracts

Add separate version-1 contracts for text and texture extraction. Do not silently reinterpret the
generic scan contract.

### Text extraction

Emit only:

- package file identity;
- object path and class path where applicable;
- location kind: String Table entry, DataTable row/property, or asset property;
- row, entry key, and property path required to explain the occurrence;
- source string plus Unreal namespace/key/history evidence;
- unsupported `TextProperty` coverage gaps;
- package decode diagnostics and summary counts.

The portable implementation traverses decoded arrays, sets, maps, and structs but does not render
non-text property values. Equal source strings with different identities remain distinct. Shared
namespace/key identities retain multiple occurrences.

Candidate packages that contain no decoded occurrence are valid zero-result packages, not failures.
Coverage distinguishes candidates, decoded packages, zero-result packages, partial packages,
failed packages, occurrences, resolved identities, unresolved identities, and unsupported text.

### Texture extraction

Decode only Texture2D exports from candidate packages and emit:

- package and object identity;
- package file size;
- source dimensions, source mip count, and source format evidence;
- compression, sRGB, texture group, and mip-generation evidence;
- explicit unavailable reasons for omitted or wrong-kind serialized values;
- package/export diagnostics and summary counts.

Do not decode or serialize unrelated exports in the same package. Missing default-valued properties
remain unavailable; the projection must not infer Unreal effective defaults.

### Process transport

- Retain `--path-list` or an equivalent bounded list transport for large candidate sets.
- Add an explicit projection selector or dedicated extraction commands with versioned help.
- Stream one bounded NDJSON event at a time.
- Keep progress on stderr and domain evidence on stdout.
- Treat exit code 6 as partial success with valid evidence.
- Reject unreadable, out-of-project, or malformed path lists before decoding.
- Never fall back from an empty path list to scanning `Content`.

## Execution plan

### Step 1 — Freeze semantic and performance evidence

1. Add fixture expectations for compact text occurrences, identity grouping, nested containers,
   unsupported text, texture facts, unavailable texture evidence, and partial package diagnostics.
2. Add an opt-in benchmark command accepting project and reader paths through explicit arguments or
   environment configuration.
3. Record only counts, durations, output bytes, peak RSS, and diagnostic codes under ignored
   `test-results`; never record project names, paths, object identities, or text.
4. Measure the existing generic path and the new projection path in the same invocation so ratios
   remain meaningful across machines.

**Gate**: the benchmark fails if the reader never starts, output validation fails, a second project
enumeration occurs, or temporary artifacts remain after completion/interruption.

### Step 2 — Implement portable Rust projections

1. Add pure text and texture projection functions to `crates/uasset-parser/src`, operating on parsed
   package evidence rather than filesystem paths.
2. Keep domain event serialization in the native CLI adapter.
3. Add Rust tests for nested property traversal, identity preservation, zero-result packages,
   Texture2D export selection, unavailable properties, and partial diagnostics.
4. Add native/WASM fixture parity for the compact projection results.
5. Keep the existing generic `inspect` and `scan` behavior compatible.

**Gate**: do not proceed if the projection exists only in `src/bin/uasset.rs`, if WASM cannot produce
equivalent package-level evidence, or if a projected event still contains a generic property graph.

### Step 3 — Add streaming TypeScript adapters

1. Extend `@ue-shed/unreal-assets` with Effect `Stream` extraction operations and runtime schemas.
2. Factor the child-process NDJSON implementation so progress, error classification, cancellation,
   output bounds, and cleanup have one place of locality.
3. Keep generic `scanProject` for callers that genuinely need complete inspection.
4. Prove interruption removes the temporary path-list directory and terminates the child.
5. Prove a candidate list larger than the Windows command-line limit reaches the reader.

**Gate**: no extraction operation may first collect a `SavedAssetScan`, complete stdout string, or
array of generic inspections.

### Step 4 — Deepen the domain query modules

1. Build Game Text units incrementally from compact events.
2. Index normalized searchable fields once during refresh; do not recompute corpus-wide filtering
   for every renderer keystroke.
3. Provide stable cursor pagination and bounded focus results.
4. Fold texture distributions, findings, and diagnostics while records arrive.
5. Retain texture records in stable object-path order and page them through the query interface.
6. Make refresh lifecycle explicit: idle, indexing with progress, ready, partial, failed, and
   cancelled.
7. Invalidate a query model when the selected project/index generation changes.

**Gate**: the public headless packages and CLI tests must exercise the same query interfaces used by
Workbench. Deleting `apps/workbench` must leave extraction, search, focus, audit summary, and record
inspection usable.

### Step 5 — Replace whole-result Workbench IPC

1. Replace scan IPC that returns `TextCorpusRunResult` or complete `TextureAuditRunResult` with
   validated refresh/status/search/focus interfaces.
2. Keep corpus ownership in Workbench main; the renderer receives summary and bounded pages only.
3. Enforce maximum page sizes at the IPC schema, regardless of renderer input.
4. Update preload and renderer clients without exposing filesystem, process, or cache authority.
5. Preserve explicit Rescan, cancellation, partial coverage, and recovery states.

**Gate**: serialized IPC responses remain bounded under the large-project benchmark, and no renderer
state contains the complete corpus.

### Step 6 — Update the maintained interfaces

1. Keep Game Text globally searchable. Use a query-backed, virtualized result list with stable
   selection and a focused occurrence inspector.
2. Preserve search and filters while opening one text unit.
3. Keep Texture Audit's distributions and rule findings, but fetch asset rows and details on demand.
4. Expose indexing progress and allow already-indexed results to remain inspectable during an
   explicit refresh where correctness permits.
5. Do not copy Data Authoring's piece-by-piece discovery model. Reuse only its progressive
   disclosure and bounded presentation lessons.

**Gate**: component tests cover empty, indexing, ready, partial, failed, cancelled, zero-result,
search-no-match, page transition, retained selection, and focused detail states.

### Step 7 — Measure and optimize decoding if required

Run fixture, CLI, Workbench, and opt-in large-project benchmarks before changing storage.

The first projection implementation passes when:

- it performs no project-wide enumeration after the shared header index;
- transport output grows with domain facts rather than the generic property graph;
- projected output is at least 20× smaller than the same-run generic output;
- peak main-process memory attributable to a corpus remains below 256 MiB;
- every renderer response remains below 1 MiB and the enforced page limit;
- ready-state in-memory search returns a page within 100 ms at p95 over the benchmark query set;
- no text identity, occurrence, texture evidence, or coverage diagnostic regresses on fixtures.

If wall time remains dominated by parsing after JSON volume is removed:

1. profile package read, package parse, export decode, projection, serialization, and TypeScript
   folding separately;
2. skip unrelated exports for texture extraction;
3. add a text-oriented tagged-property walker that skips non-text payloads by validated serialized
   spans where the format permits;
4. preserve the same projection interface and native/WASM fixture parity.

Do not use persistence to hide slow cold extraction. Persistence can improve unchanged reopen time;
it cannot make the first trustworthy index cheaper.

### Step 8 — Make the domain-corpus persistence decision

This step applies to the compact Game Text and Texture Audit query models. Foundational
saved-package Catalog persistence is owned by Plan 037.

Evaluate storage only after Step 7 produces compact measurements.

Keep the in-memory implementation when:

- retained corpus memory stays within the budget;
- search meets the latency budget;
- rebuild time is acceptable for the intended route lifecycle; and
- package-level incremental replacement is not required.

Consider a compact versioned snapshot before SQLite when the only problem is repeated unchanged
rebuild and the whole compact index remains cheap to load and validate.

Add a SQLite adapter only when evidence shows at least one of:

- compact corpus memory exceeds the budget;
- bounded queries cannot meet latency without a disk-backed index;
- package-level incremental replacement is required to avoid expensive full rebuilds;
- corpus size makes whole-snapshot validation or replacement materially expensive; or
- multiple headless invocations need a durable shared local index.

If SQLite is selected:

- place it in a configurable local application cache keyed by a hash of canonical project identity;
- keep it out of the Unreal project and source control;
- version extractor semantics and schema independently;
- update changed packages transactionally from path/size/mtime signatures;
- remove deleted-package facts;
- expose the same domain query interfaces through a second adapter;
- keep text contents out of telemetry and diagnostics;
- prove CLI and Workbench conformance against the same fixture.

Do not use IndexedDB as the authoritative adapter in this plan. A future browser-only host may add
an IndexedDB adapter at the existing domain seam if it has a real independent requirement.

## Verification matrix

| Scope               | Evidence                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| Rust unit           | text traversal, texture selection, diagnostics, resource limits         |
| Native/WASM parity  | compact fixture projections are semantically equal                      |
| Process integration | NDJSON schemas, partial exit, cancellation, path-list cleanup           |
| Domain unit         | grouping, search ordering, filters, pagination, distributions, findings |
| Domain integration  | compact reader events produce fixture corpus/report                     |
| CLI                 | scan/search/focus and audit summary/query use public domain interfaces  |
| Workbench main      | one project index, generation invalidation, bounded IPC                 |
| UI component        | lifecycle, paging, selection, focus, partial coverage                   |
| Large project       | timing, output bytes, peak RSS, bounded response sizes                  |
| Repository          | `pnpm check`                                                            |

Required focused commands must be added to the benchmark documentation. The final executor must run:

```powershell
cargo test -p uasset-parser --all-targets
pnpm exec vitest run packages/unreal-assets/src packages/game-text/src packages/asset-audits/src
pnpm exec vitest run apps/workbench/src/main extensions/game-text/src extensions/asset-audits/src
pnpm check
```

## STOP conditions

Stop and report if any of the following occurs:

- another project-wide filesystem enumeration is required after the shared header index;
- an empty candidate list falls back to `Content`;
- compact extraction loses namespace/key identity, occurrence location, unavailable texture
  evidence, or partial coverage;
- a domain route still requires generic `SavedAssetInspection` arrays;
- Workbench becomes the only owner of search or audit query behavior;
- projection logic cannot remain portable to the parser's WASM target;
- renderer IPC still transfers a complete corpus;
- implementation introduces project-specific names, paths, schemas, or assumptions;
- benchmark or ordinary telemetry records text or asset identities;
- SQLite or IndexedDB is introduced for a domain corpus before the Step 8 decision;
- `pnpm check` fails.

## Out of scope

- localization PO import/export, translation editing, or text mutation;
- automatic texture repair or inferred Unreal defaults;
- a universal asset property index;
- background filesystem watching before compact cold behavior is measured;
- source-control integration;
- cross-project or hosted search;
- persistence selected by preference rather than evidence.
