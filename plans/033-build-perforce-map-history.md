# Plan 033: Build the Perforce-backed Map History vertical

> **Executor instructions**: Follow this plan in order. Prove the source-control and saved-world
> reconstruction semantics before building presentation. Keep the first implementation explicitly
> Perforce-backed; do not introduce a speculative source-neutral revision provider or a generic
> `@ue-shed/perforce` package. Keep `p4client-ts` confined to `@ue-shed/map-history`, preserve
> Perforce provenance, and report unsupported or unclassified saved changes instead of presenting an
> exact-looking but incomplete history.
>
> **Drift check (run first)**:
> `git status --short -- package.json pnpm-lock.yaml packages/protocol packages/unreal-assets packages/map-history apps/cli apps/workbench extensions/content-observatory docs plans fixtures`
> and
> `git diff --stat 4cf4267 -- package.json pnpm-lock.yaml packages/protocol packages/unreal-assets packages/map-history apps/cli apps/workbench extensions/content-observatory docs plans fixtures`.
> Then inspect the installed `p4client-ts` API and the current `SavedWorld` contract. If
> `listDepotFilesAtChange`, `materializeDepotFiles`, submitted-changelist filtering, or exact
> revision metadata differ materially from `p4client-ts@0.7.1`, reconcile this plan before editing.

## Status

- **State**: IN PROGRESS
- **Priority**: P2
- **Effort**: XL
- **Risk**: HIGH — an incorrect path scope, baseline, deletion fold, actor-identity match, or
  partial-coverage interpretation could attribute changes to the wrong changelist or silently omit
  authored world changes.
- **Depends on**: `p4client-ts@0.7.1` historical depot materialization and the current
  `unreal-saved-world` v1.1 projection
- **Category**: product vertical
- **Planned at**: commit `4cf4267`, 2026-07-28

## Implementation checkpoint

- Steps 1–3 are complete: the product contract, private package, schema-owned output, Perforce
  adapter, actor continuity/diff, and unclassified evidence are in place.
- Step 4 is proven through the deterministic acquisition layer: verified local-to-depot scope,
  companion package mapping, bounded submitted-change selection, exact baseline inventory,
  incremental add/edit/delete fold, temporary-tree cleanup, aggregate materialization bounds,
  timeout cleanup, and World Partition conversion refusal all have focused tests.
- The headless portion of Step 6 is also in place ahead of real conformance: `MapHistory`, live/test
  layers, `readPerforceMapHistory`, encoded CLI output, bounded CLI defaults/overrides, and the
  partial-or-unclassified exit status are implemented. Real-Perforce CLI journey coverage remains
  gated on Step 5.
- The portable half of Step 5 is complete: `fixtures/perforce-map-history` carries generic,
  Unreal-generated conventional and World Partition histories. The conventional map proves a
  map-file actor move; World Partition covers incremental move, label, add, delete, and
  two-package unclassified bundles. Rust conformance tests reconstruct every revision into an
  owned temporary project tree and read the resulting saved world without Unreal or Perforce.
- The portable UI portion of Step 7 is complete: `@ue-shed/extension-content-observatory` provides
  the Workbench **World Log** route with a validated browser client, bounded query controls,
  progress polling, scoped cancellation, chronological changelist/actor evidence, package evidence,
  and explicit unclassified warnings. The Workbench main process owns the Map History fiber; opening
  Workbench or the route does not issue a Perforce command. Real-Perforce UI E2E remains gated on
  Step 5.
- Real-Perforce conformance remains deferred. The ordinary test/check lane is still entirely
  independent of Perforce binaries, network access, credentials, and a studio depot. The next work
  is the disposable, generic local-server harness described in Step 5—not a contributor's project
  or shared service.

## Why this matters

UE Shed can already read the actors saved in a conventional level or World Partition external-actor
tree. Perforce can now provide a bounded inventory at a submitted changelist and materialize exact
binary revisions without syncing the user's workspace. The missing product is the composition:
select one map and a time range, reconstruct the authored world at the relevant changelists, and
explain its actor changes with the Perforce evidence that carried them.

Users should not need to understand external-actor hashing, manually browse every actor package,
download binary revisions, or compare parser JSON. The supported headless question is:

```text
What saved actor changes happened to this map during this bounded Perforce range,
who submitted them, and how complete is our explanation?
```

This is the first narrow Content Observatory history slice. It is not the entire project
cartography, growth, dependency-history, or Janitor vision.

## Product boundary

### UE Shed owns in this plan

- One optional `@ue-shed/map-history` package containing the complete Perforce-first workflow.
- Map and World Partition external-actor scope discovery.
- Relevant submitted-changelist discovery and one baseline before the requested range.
- An isolated temporary historical project tree, incremental revision application, and cleanup.
- Saved-world parsing through the existing `AssetReader` boundary.
- Actor continuity and pure semantic diffing across adjacent saved snapshots.
- Perforce-aware, schema-owned history output with changelist, author, description, time, depot
  revisions, coverage, and diagnostics.
- Explicit unclassified package-change evidence when Perforce changed saved bytes but the supported
  actor projection cannot explain a semantic difference.
- Bounded progress, cancellation, telemetry, CLI access, and a focused local Workbench history view.

### Consumers still own

- Project, workspace, branch, map, and time-range selection.
- Perforce credentials and server access.
- Studio-specific ownership, taxonomy, milestone, approval, retention, and notification policy.
- Interpretation of private actor classes or custom native serialization not covered by the generic
  saved-world projection.
- Central databases, scheduled indexing, web portals, permissions, and organization-wide reporting.

### Explicitly deferred

- A source-neutral `WorldRevisionSource` abstraction.
- A generic `@ue-shed/perforce` package.
- Git, Plastic, archive, or arbitrary snapshot producers.
- History of referenced Blueprints, meshes, materials, textures, or transitive dependencies.
- Claiming every byte change has a decoded actor-property explanation.
- Live editor state, PIE history, runtime movement, screenshots, Map Review capture history, and
  time-indexed Observatory state.
- Whole-project growth, dependency cartography, cleanup findings, or a generic Perforce browser.
- Persistent background indexing, scheduling, hosted storage, or multi-user collaboration.

## Architectural decisions

1. `@ue-shed/map-history` directly depends on `p4client-ts`. No unrelated package may acquire that
   dependency.
2. The package is initially private and optional in repository composition. Publication is a later
   release decision.
3. The public workflow is deliberately named `readPerforceMapHistory`; it does not pretend the
   implemented producer is generic.
4. Perforce acquisition, temporary snapshot maintenance, saved-world reading, and pure diffing are
   separate internal modules. `p4client-ts` values are translated at the acquisition boundary and
   do not become the map-history domain model.
5. `@ue-shed/unreal-assets` remains the authority for one saved-world snapshot. It does not learn
   about changelists, timelines, caches, or actor-change semantics.
6. `@ue-shed/map-history` owns cross-snapshot identity and semantic changes because those concepts
   do not exist in a single package read.
7. Perforce concepts remain first-class provenance. Do not flatten changelists into opaque generic
   revision strings.
8. The operation is read-only. It may use `p4 files`, `changes`, `describe`, `where`, and
   `print -o` through the library boundary, but never `sync`, checkout, submit, client mutation, or
   server mutation.
9. The first implementation folds one mutable working tree only inside an operation-owned temporary
   directory: materialize the baseline once, apply each relevant changelist's adds/edits/deletes in
   ascending order, and parse after each atomic changelist. Do not redownload a complete map for
   every changelist.
10. Every limit is explicit. A limit breach is a typed result or error, never silent truncation.

## Current state

- `p4client-ts@0.7.1` exposes bounded submitted-changelist listing,
  `describeChangelist`, `listDepotFilesAtChange`, and binary-safe
  `materializeDepotFiles`.
- `p4client-ts` materializes exact revisions beneath a caller-owned directory without updating
  workspace have-state.
- UE Shed does not currently depend on `p4client-ts`.
- `@ue-shed/unreal-assets.readSavedWorld` accepts a project root and map path, enumerates either the
  conventional `.umap` or matching local `__ExternalActors__` subtree, and returns saved-package
  authority.
- `SavedWorld` v1.1 exposes source kind, actor GUID when serialized, object/package path, class,
  label, position resolution, completeness, and diagnostics.
- The current projection does not expose arbitrary actor properties, component graphs, asset
  references, native tails, map settings, Data Layers, HLODs, or runtime-effective behavior.
- The Content Observatory document is product vision rather than a shipped contract.
- No generic Perforce history fixture or end-to-end map-history command exists in UE Shed.

## Target public model

Use Effect Schema as the authority and derive decoded types. Exact names may adjust to existing
package conventions, but the distinctions below must remain.

### Query

```ts
PerforceMapHistoryQuery = {
	projectRoot: ProjectRoot
	mapPath: ProjectRelativeMapPath
	range: {
		since: DateTimeUtc
		until: DateTimeUtc
	}
	limits: {
		maxChangelists: PositiveInt
		maxPackages: PositiveInt
		maxMaterializedFiles: PositiveInt
		maxConcurrency: PositiveInt
		maxDuration: Duration
	}
}
```

The service may derive Perforce settings from the normal environment and local configuration
supported by `p4client-ts`. If local-to-depot resolution is ambiguous, return a typed error carrying
the safe local target and recovery guidance. Never guess a depot root from a filesystem path.

### Perforce revision evidence

```ts
PerforceMapRevision = {
	change: PerforceChangeNumber
	user?: string
	description?: string
	submittedAt: DateTimeUtc
	files: ReadonlyArray<PerforcePackageRevision>
	snapshot: SavedWorldSnapshotEvidence
	changes: ReadonlyArray<MapChange>
	unclassifiedPackageChanges: ReadonlyArray<UnclassifiedPackageChange>
}
```

The history result includes the effective query, resolved map/depot scope, baseline status, ordered
revisions, aggregate coverage, and bounded diagnostics. A range with no matching changelists is a
successful empty history with its baseline/coverage stated.

### Actor continuity

Actor matching is evidence-based:

1. Prefer a nonzero saved `ActorGuid`.
2. Otherwise use exact saved package/object identity only while it remains unchanged.
3. Never use label alone as identity.
4. When continuity cannot be proven, emit removal plus addition rather than inventing a rename or
   move.

Every match records its identity basis so consumers can distinguish GUID-backed continuity from a
path fallback.

### Semantic change union

The first supported `MapChange` union contains:

- `actor_added`;
- `actor_removed`;
- `actor_moved`;
- `actor_label_changed`;
- `actor_class_changed`;
- `actor_package_changed` when GUID continuity proves the same actor;
- `actor_position_resolution_changed`; and
- `snapshot_coverage_changed`.

Events carry before/after evidence appropriate to the variant and the actor identity basis. Diffing
uses exact saved double values for the historical record; any later display tolerance is
presentation policy, not semantic equality.

If a relevant `.umap` or external actor package revision changed but none of the supported semantic
events explains it, retain an `UnclassifiedPackageChange` with depot path, before/after revision,
action, affected actor identity when safely attributable, and parser coverage. This is not an error
and must remain visible.

## Implementation sequence

### Step 1: Freeze the first Map History product contract

1. Add `docs/products/map-history.md` and link it from `docs/README.md`. Promote only the focused
   Perforce-backed saved-map history slice from the Content Observatory vision.
2. Define the product promise, direct-authored-state boundary, Perforce-first choice, consumer
   policy boundary, supported change vocabulary, partial-knowledge language, and first demo.
3. Record that `@ue-shed/map-history` is the only initial package that depends on `p4client-ts`;
   generalization is deferred until a second real producer earns it.
4. Specify the CLI and Workbench outcome without making either shell the domain authority.
5. Do not change `docs/ideas/content-observatory.md` into a status document. Link to the new product
   contract while retaining the wider vision.

**Verify**:
`pnpm format:check`
→ the new contract and plan remain formatted.

### Step 2: Establish the package and schema-owned domain

1. Add private `packages/map-history` with dependencies on `@ue-shed/unreal-assets`,
   `@ue-shed/observability`, Effect, and exact released `p4client-ts`.
2. Add schemas and brands for query/range/limits, Perforce changelist and depot revision evidence,
   actor identity basis, history lifecycle/progress, semantic changes, unclassified changes,
   coverage, diagnostics, and final history.
3. Define typed errors for invalid target/range, Perforce configuration/authentication/command,
   ambiguous depot mapping, bounded-history limit, materialization, temporary storage, saved-world
   decode, baseline unavailable, and cancellation/recovery.
4. Adapt the Promise-oriented `p4client-ts` client once behind an internal Effect service and test
   layer. Public operations remain Effect-native and expose map-history actions, not a raw P4
   client.
5. Add an architecture test proving no package other than `packages/map-history` names
   `p4client-ts` in its dependency closure or imports.

**Verify**:
`pnpm --filter @ue-shed/map-history typecheck`
→ the package typechecks and its public schemas round-trip representative encoded values.

### Step 3: Implement and prove pure actor-history semantics

1. Implement deterministic actor indexing and matching from `SavedWorld` snapshots using the
   identity precedence above.
2. Implement a pure adjacent-snapshot diff producing the supported `MapChange` union.
3. Canonicalize actor order before comparison; array enumeration order must not create history.
4. Preserve partial snapshots and position-resolution variants. Do not treat a partial read as an
   empty complete world.
5. Correlate changed Perforce packages with supported semantic events and retain unexplained
   revisions as `UnclassifiedPackageChange`.
6. Add property/pure tests for additions, removals, GUID continuity across package/path changes,
   fallback identity, ambiguous continuity, labels, classes, exact positions, every resolution
   state, ordering, duplicate GUID defects, partial coverage, and unexplained package revisions.

**Verify**:
`pnpm test -- packages/map-history/src/map-history-diff.test.ts`
→ all pure and property cases pass.

### Step 4: Prove Perforce scope, baseline, and incremental reconstruction

1. Resolve the selected local map to exactly one depot map path through verified Perforce mapping.
   Keep the mapping implementation inside the acquisition module. If `p4client-ts` lacks a typed
   mapping helper, use its validated low-level tagged command boundary locally and record the
   contained gap; do not leak raw output or guess.
2. Read the current saved map to determine whether a matching external-actor root exists, then
   resolve that root to its depot scope. Query the map plus that subtree. V1 reports historical
   conventional/World Partition conversion as unsupported unless the fixture proves the scope can
   be reconstructed safely across the conversion.
3. Page submitted changelists for only the resolved scope until the requested lower time bound or
   `maxChangelists` is reached. Deduplicate changelists touching both map and actor paths and order
   them ascending.
4. Resolve one baseline immediately before `since`. Inventory its exact map/external-actor files
   with `listDepotFilesAtChange`, refuse `hasMore`, and materialize them into an
   operation-owned temporary project tree.
5. For each relevant changelist, use its described in-scope files to apply adds/edits/deletes to the
   working tree, then invoke `readSavedWorld` once for the resulting atomic changelist state.
6. Validate every materialized path remains inside the owned tree. Deletes only remove the exact
   resolved in-scope file. Clean temporary state on success, typed failure, interruption, and
   cancellation.
7. Bound changelists, packages, materialized revisions, concurrency, duration, diagnostics, and
   retained snapshots. Expose progress for discovery, baseline, materialization, parsing, diffing,
   and completion.
8. Add Effect tests with real temporary directories and a deterministic acquisition test layer for
   baseline creation, simultaneous file changes, add/edit/delete, empty range, pagination,
   truncation refusal, cancellation, cleanup, parser partial results, and failure after partial
   progress.

**Verify**:
`pnpm test -- packages/map-history/src`
→ pure, Effect, materialization-tree, cancellation, and cleanup tests pass.

### Step 5: Create a generic real-Perforce conformance fixture

Do not begin this step until the portable diff and reconstruction engine in Steps 3 and 4 is
proven. The ordinary `pnpm check` lane must remain independent of Perforce, network access, and
third-party credentials.

1. Add a source-control fixture separate from `fixtures/unreal-project`; the Unreal fixture itself
   remains the generator of valid package bytes and must stay usable without Perforce. Commit small
   Unreal-generated revision bundles and a scenario manifest, not a live server database.
2. Add an opt-in harness that provisions a disposable local server rather than relying on a hosted
   shared depot or a contributor's studio project:
    - prefer explicitly configured `p4` and `p4d` executables;
    - otherwise download one pinned platform build from Perforce's official distribution, verify a
      pinned SHA-256, and cache it outside the repository;
    - never commit or redistribute Perforce binaries;
    - create the server root, client workspace, tickets, configuration, logs, and depot beneath an
      owned temporary directory;
    - bind `p4d` to localhost on an available port, seed named changelists, run conformance, stop the
      process, and clean every owned path on success, failure, or cancellation; and
    - keep Docker optional rather than making it a contributor prerequisite.
3. Run the disposable-server lane through a focused command such as
   `pnpm test:perforce-map-history`. CI may run one pinned Linux conformance job, while portable
   package tests use the deterministic acquisition test layer and committed revision bundles.
4. Provide deterministic setup inputs/scripts for a small depot history containing:
    - a conventional map baseline and actor move;
    - a World Partition map with external actor add, move, label change, and delete;
    - two actor packages changed in one changelist;
    - one package revision whose current saved-world projection cannot classify;
    - a changelist outside the selected range; and
    - an unrelated map/subtree that must never enter the result.
5. Use real small Unreal-generated packages. Do not manufacture `.uasset` bytes in TypeScript.
6. The focused command may use an explicitly configured existing test server when requested, but
   its default conformance mode is disposable and local. Print `RUN`/`SKIP` with exact
   prerequisites, consistent with other environment-gated suites.
7. Prove the complete workflow attributes the expected semantic and unclassified changes to the
   correct changelists, preserves author/description/time, and leaves the workspace/have-state
   unchanged.

**Verify**:
the focused real-Perforce integration command documented by this step
→ provisions or targets the generic depot and passes without using a studio project.

**Completed (2026-07-29)**:

- `pnpm test:perforce-map-history` provisions a localhost-only `p4d` fixture, including isolated
  client, ticket, trust, config, log, depot, and workspace paths beneath one owned temporary root.
- Its default path downloads Perforce `r26.1` `p4`/`p4d` binaries from the official distribution,
  checks pinned SHA-256 values, and reuses an outside-repository cache. Supplying both explicit
  binary paths remains available for controlled CI or contributor environments; PATH is never a
  fallback.
- The fixture bootstraps its disposable 2026.1 secure-by-default server with a generated credential
  in its isolated ticket store, then restores the relevant secure settings before seeding.
- The harness seeds both real Unreal package histories, an unrelated map, and one later
  out-of-range change. It proves conventional and World Partition reconstruction, changelist
  metadata, semantic and unclassified attribution, scope exclusion, and unchanged have-state.
- Ordinary `pnpm test` reports this lane as `SKIP` with its focused command; ordinary `pnpm check`
  remains free of Perforce binaries, network access, and credentials.

### Step 6: Expose the complete headless workflow and CLI

1. Add a `MapHistory` Effect service and live/test layers. Its primary operation is
   `readPerforceMapHistory(query)`.
2. Instrument scope discovery, changelist paging, inventory, materialization bytes/files,
   saved-world parsing, actor counts, classified/unclassified changes, coverage, cleanup, and total
   duration with bounded telemetry dimensions.
3. Add a CLI command such as:

    ```text
    ue-shed map history <project-root> <map-path> --since <duration-or-ISO> [--until <ISO>]
    ```

    Resolve final spelling through existing CLI conventions. Provide validated JSON output plus a
    concise human summary. Do not require Workbench configuration.

4. Return distinct exit behavior for complete success, successful partial/unclassified history,
   invalid input, unavailable Perforce, resource limit, and failed reconstruction.
5. Add CLI parser tests and an end-to-end child-process journey using the real-Perforce gate when
   configured.

**Verify**:
`pnpm test -- apps/cli/src packages/map-history/src`
→ command parsing, JSON schema, exits, progress, and service behavior pass.

### Step 7: Add the focused Content Observatory history view

1. Add `extensions/content-observatory` as a maintained SolidJS/StyleX presentation package for this
   first slice. Do not build Overview, Growth, dependency graphs, or Janitor.
2. Define a narrow browser-safe client contract for map selection, bounded history query, progress,
   cancellation, and result retrieval. Renderer code receives no filesystem, subprocess, or P4
   authority.
3. Compose `MapHistory` once in Workbench main only when the route is used. Opening Workbench must
   not contact Perforce or start analysis.
4. Add validated IPC/preload adapters with scoped cancellation and no private domain logic.
5. Present a map-scoped chronological changelist timeline with author/description/time, actor change
   summaries, filters by change kind, actor detail, package evidence, completeness, and
   unclassified-change warnings.
6. Keep the visualization evidence-first. Do not create a spectacular all-project graph or imply an
   unclassified package is unchanged.
7. Cover empty, loading, cancelling, complete, partial, limit, authentication, mapping, and parser
   failure states. The same query and output must remain fully usable through the library and CLI.

**Verify**:
`pnpm test:components`
→ the focused Content Observatory components pass interaction and accessibility tests.

### Step 8: Close the portable and real-system gates

1. Update package/extension READMEs, `docs/vision-and-architecture.md`, showcase documentation, and
   health/doctor output to match the implemented optional Perforce boundary.
2. Document supported actor changes, identity precedence, unclassified evidence, limits, required
   P4 settings, temporary storage, cancellation, and the absence of workspace mutation.
3. Add architecture and license checks proving `p4client-ts` remains confined to the optional
   package and is not added to the parser, protocol, host, or unrelated domains.
4. Run the complete portable gates, CLI E2E, Workbench E2E, and configured real-Perforce
   conformance. No Unreal editor is required unless parser projection work was added.

**Verify**:

```powershell
pnpm check
pnpm test:e2e:cli
pnpm test:e2e:workbench
git diff --check
git status --short
```

→ all commands exit 0; the real-Perforce lane is reported explicitly; status contains only
in-scope files.

## Test plan

- **Schema**: query/range/limits, brands, provenance, actor identity basis, changes, partial
  coverage, unclassified revisions, old/future-incompatible values.
- **Pure**: stable actor matching, GUID/path precedence, duplicate/ambiguous identities, unordered
  input, exact transforms, resolution changes, package correlation, coverage folds.
- **Effect**: configuration, mapping, pagination, baseline, bounded concurrency, timeout,
  cancellation, temporary resource cleanup, typed library-error translation, progress, telemetry.
- **Filesystem integration**: baseline tree, exact revisions, add/edit/delete, containment,
  simultaneous changelist application, parser invocation, cleanup after every exit.
- **Real Perforce**: path scoping, state-at-changelist inventory, exact binary materialization,
  changelist metadata, unrelated-path exclusion, no sync/have-state mutation.
- **Parser conformance**: conventional and World Partition saved-world snapshots from real
  Unreal-generated packages, partial package evidence, stable actor GUID and double positions.
- **CLI**: explicit target/range, JSON output, human summary, partial exit behavior, cancellation,
  missing P4, bounds, child-process cleanup.
- **Component/IPC**: demand-driven start, progress, cancel/unsubscribe, timeline ordering, filters,
  actor/package evidence, partial/unclassified warnings, accessibility, no renderer authority.
- **Product**: one bounded map/time-range journey from CLI and Workbench against the same generic
  Perforce fixture.

## Done criteria

- [ ] `@ue-shed/map-history` is the only package that depends on or imports `p4client-ts`.
- [ ] The package exposes one complete Effect-native `readPerforceMapHistory` workflow.
- [ ] A conventional map and World Partition map both reconstruct from an exact baseline and
      ascending in-range changelists.
- [ ] Only the selected map and matching external-actor scope influence the history.
- [ ] Baseline materialization happens once; subsequent changelists apply only changed files.
- [ ] Actor continuity uses GUID first, exact path fallback second, and never label identity.
- [ ] Added, removed, moved, label, class, package, position-resolution, and coverage changes are
      schema-owned and tested.
- [ ] Changed saved packages not explained by the supported projection remain visible as
      unclassified evidence.
- [ ] Complete, partial, empty, unavailable, cancelled, and resource-limited outcomes are distinct.
- [ ] Temporary files are scoped and removed on success, failure, interruption, and cancellation.
- [ ] The operation never syncs or changes Perforce workspace/server state.
- [ ] The library and CLI provide the complete workflow without Workbench.
- [ ] Workbench uses the same public service through a validated browser-safe client.
- [ ] Portable tests and the configured real-Perforce fixture prove the semantics at their truthful
      layers.
- [ ] `pnpm check`, CLI E2E, Workbench E2E, `git diff --check`, and the configured Perforce lane
      pass.

## STOP conditions

Stop and report rather than weakening the contract if:

- `p4client-ts` cannot return a complete bounded state-at-changelist inventory or binary-safe exact
  revisions without workspace mutation.
- Local project/map paths cannot be resolved to one unambiguous depot scope without guessing.
- The matching external-actor depot scope cannot be derived and proven against a real World
  Partition fixture.
- Relevant changelists cannot be enumerated without scanning an unbounded depot or silently
  truncating history.
- A baseline immediately before the requested range cannot be represented honestly.
- Applying described add/edit/delete actions does not reproduce Perforce's state at a changelist.
- The saved-world reader requires files outside the selected map/external-actor package set for the
  claimed actor evidence.
- Actor continuity would require label heuristics or project-specific identity conventions.
- The parser reports actor evidence that disagrees with Unreal on the generic fixture.
- A package revision would disappear from the timeline merely because the current projection cannot
  classify it.
- Cleanup would require deleting outside an operation-owned, resolved temporary directory.
- Supporting the first slice requires adding `p4client-ts` to a core/parser/protocol package or
  introducing a source-neutral abstraction without a second producer.
- A verification command fails twice after a reasonable scoped correction.

## Maintenance notes

- Perforce is a deliberate first producer, not a universal history vocabulary.
- Keep acquisition internals narrow so a future extraction is possible, but do not publish a
  replacement seam before another producer exists.
- `UnclassifiedPackageChange` is durable evidence of a coverage boundary, not backlog noise to hide.
- Parser codec expansion must be driven by representative Unreal fixtures and a named product
  question. Do not copy every generic property into map-history merely to increase event counts.
- A changed referenced asset is not a direct map edit. Add dependency-impact history later with
  explicit traversal roots, reference coverage, and separate language.
- Historical snapshots are saved disk authority. Never merge them with live Observatory state or
  Map Review capture history without explicit provenance and comparison semantics.
- If recurring queries later justify a persistent revision/package cache, add a bounded,
  content-addressed repository with invalidation and health; do not turn the tracer bullet's
  temporary tree into an undocumented global cache.
