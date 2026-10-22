# Plan 058: Game Text ID actions, studio-owned rules, performance and a codebase audit

> **Executor instructions**: This plan is written to be executed autonomously over about a week by
> one coordinating agent that runs up to four lanes in parallel. Read it fully first. Before editing,
> read `AGENTS.md`, `docs/README.md`, `docs/vision-and-architecture.md#base-not-constraints`,
> `docs/products/game-text.md`, `docs/engineering/effect.md`, `docs/engineering/functional-design.md`,
> `docs/engineering/types-and-errors.md`, `docs/engineering/testing.md`,
> `docs/engineering/releases.md`, ADRs 0009 and 0010, and Plans 052 and 057. Verify every Unreal fact
> against each engine's `Engine/Source` before relying on it. Honour the STOP conditions. Update the
> status table in the same PR that changes an item's state.
>
> **Drift check (run before starting each item)**: `git fetch` and
> `git diff dc654ce4...origin/main --stat -- packages crates apps unreal fixtures scripts`. Every
> file:line reference below was taken at `dc654ce4` (0.16.2). Re-locate anything that moved before
> editing; do not trust stale line numbers.

## Status

- **State**: IN PROGRESS
- **Priority**: P1
- **Effort**: XL (four lanes, about a week; unfinished items are acceptable)
- **Risk**: MEDIUM. Lane A adds the first asset writes for text outside DataTables, and A2 and lane D
  contain breaking API changes. All of it ships together as 0.17.0 with migration notes.
- **Depends on**: PR #99 (Game Text identity fixture and Blueprint bytecode text) and PR #98
  (external actor text headers) merged. Lane A cannot start without #99.
- **Engines**: parser, fixture and Unreal integration changes require verification on UE 5.7 and
  UE 5.8 (decision 11). Missing engine evidence keeps an item incomplete. A5 separately needs UE 4.27.
- **PR #101** (opt-in native index builder) merges before the items that change behaviour
  it duplicates (decision 12): A1, A2, B5, B7, B8 and C5.
- **Category**: direction
- **Planned at**: `docs/plan-058-ue-shed-week`, 2026-10-17

| Item | Title                                          | Lane | State                                      |
| ---- | ---------------------------------------------- | ---- | ------------------------------------------ |
| A1   | Name packages by file location                 | A    | TODO                                       |
| A2   | Graph pin text as Game Text places             | A    | TODO                                       |
| A3   | Game Text actions: editor plugin and API       | A    | IN PROGRESS — #112; graph pins await A2    |
| A4   | Identity fixture, slice 2                      | A    | DONE — #120; UE 5.7 and UE 5.8             |
| A5   | UE 4.27 identity slice                         | A    | TODO                                       |
| A6   | Stretch: text diff of two package versions     | A    | DONE — #104                                |
| B1   | Check catalogue                                | B    | DONE — #106                                |
| B2   | Rules file v3                                  | B    | DONE — #109                                |
| B3   | Parameterised, scoped checks                   | B    | DONE — #111                                |
| B4   | Severity stored per finding                    | B    | DONE — #113                                |
| B5   | Host-supplied policies                         | B    | TODO                                       |
| B6   | Studio-defined checks                          | B    | DONE — #117                                |
| B7   | Intended marks                                 | B    | TODO                                       |
| B8   | Scans keyed on the resolved rules              | B    | TODO                                       |
| C1   | Stage breakdown on real projects               | C    | IN PROGRESS — #114                         |
| C2   | Prepare the query once, off the main thread    | C    | IN PROGRESS — #110                         |
| C3   | Quality scan in a worker                       | C    | IN PROGRESS — #119                         |
| C4   | Column cache per reader                        | C    | DONE — #116                                |
| C5   | Spike: binary package-text output              | C    | DONE — reader-staged lines, uasset-io 1.19 |
| C6   | Electron vs Node build time                    | C    | TODO                                       |
| C7   | Bytecode reader cost                           | C    | TODO                                       |
| D1   | `game-text` entry points                       | D    | DONE — #115                                |
| D2   | Reader batching inside the index source        | D    | DONE — #108                                |
| D3   | Unreal path module                             | D    | TODO                                       |
| D4   | One error shape                                | D    | DONE — #118, #122, #129                    |
| D5   | Classified causes instead of prose             | D    | DONE — #122, #129                          |
| D6   | Deliberate error translation                   | D    | DONE — #122, #129                          |
| D7   | Domain parsers instead of raw decoders         | D    | DONE — #127, #129                          |
| D8   | Layers and test layers                         | D    | DONE — #125, #129                          |
| D9   | One progress mechanism, one completeness shape | D    | IN PROGRESS — #125                         |
| D10  | Workspace orchestration as a package           | D    | DONE — #124                                |
| D11  | JSDoc on public exports                        | D    | DONE — #123, #129; all eight SDKs          |
| D12  | Small cleanups                                 | D    | DONE — #107, #129                          |
| D13  | API surface of the other host-facing packages  | D    | DONE — #123, #129; named/public docs       |
| D14  | Native error audit                             | D    | DONE — #123, #126, #129                    |
| R    | 0.17.0 release preparation                     | —    | TODO                                       |

## Context

Six read-only surveys of `dc654ce4` produced this plan: Game Text identity and actions, Quality
rules, performance, the localization team's other building blocks, an API review against the main
downstream host, and an audit against an external Effect coding standard and error-design guide
(its HTTP, OpenAPI, Durable Object and Cloudflare sections excluded). The key findings:

- **Actions.** Plan 052 rules out editing keys inside assets (`plans/052-text-identity-and-scope-tools.md:50-55`).
  The only shipped text writes are DataTable cells through `UEShedAuthoring`
  (`unreal/Plugins/UEShedAuthoring/.../UEShedAuthoringLibrary.cpp:752-830`). Nothing shipped
  compiles Blueprints or edits pins, widgets, DataAssets or Blueprint defaults; the Game Text
  identity fixture (`UEShedGameTextActionsFixture.cpp`, PR #99) already uses the needed engine APIs.
- **Package naming.** The reader names every object from the saved `Summary.PackageName`
  (`crates/uasset-parser/src/package.rs:644`, `:359`, `:1645`). A file-level copy (a branch) keeps
  the original's saved name, so it is reported under the original path, while Unreal uses the file
  location. UE 4.27 saves `None`, which `packages/game-text/src/package-object-path.ts:14-30`
  patches for package-relative paths only.
- **Graph pins.** Pin `DefaultTextValue` is decoded (`crates/uasset-parser/src/asset.rs:172`,
  `:1981`) but only reaches the graph viewer; it is not a Game Text place. Graph decoding accepts
  UE5 package versions up to 1018 (`asset.rs:47`), which covers UE 5.8.2; UE 4.27 is rejected.
- **Rules.** 25 built-in checks with fixed severities (`localization-check-ids.ts:60-94`) and
  hardcoded thresholds and word lists (`localization-text-shape.ts:229-309`,
  `localization-checks.ts:238-303`, `:611-619`). No custom checks; the finding and filter unions are
  closed. Severity is not stored per finding; it is re-derived from the filter at query time.
  Hosts hand-write check descriptions that drift from the code.
- **Performance.** On the large shipped UE 4.27 project: Workbench cold scan 348 s, Quality scan
  319–339 s on the host's main thread, unchanged rescan 32 s (2.5 s on the generated equivalent).
  No stage breakdown exists for it, and no UE5 project has any performance numbers. `openTarget`
  blocks about 1.15 s and the search worker repeats the same preparation
  (`packages/game-text/src/index-steps.ts:619-627`, `search-worker.ts:34`).
- **API.** `game-text` exports 767 names from `export *` over about 50 modules; the main host uses
  199 and 403 are used only inside the package. The host copies about 2,900 lines of Workbench
  Game Text orchestration and re-implements check descriptions, reader batching, object-path
  parsing and ID findings.
- **Audit.** Type safety is already enforced (0 `as unknown as`, 0 `any`, 0 `Record<string, unknown>`).
  The gaps are errors, layers and docs: 56 of 141 error types have no `recovery`, 104 have no retry
  flag, 126 keep no `cause`; messages are built from `String(cause)` (72) and `Cause.pretty` (47);
  134 `instanceof` checks on tagged errors; 13 catch-alls in `packages/host/src/authoring.ts`; 83%
  of exports have no JSDoc.
- **Native index builder (PR #101).** Adds an opt-in Rust `GameTextIndexBuilder`
  (`nativeIndexBuilderLayer`, new crate `crates/game-text-index`, uasset-io protocol 1.13
  `game_text_index` operations). TypeScript stays the default and queries stay in JavaScript. The
  crate re-implements part of the TypeScript policy in Rust (`join_policy.rs`: "mirrored from
  localization.ts, text-origin.ts and review-file.ts"): gather rules, text origin, `/Game/` ↔
  `Content/` package mapping, place keys and review marks. The Quality checks are not ported. Any
  item that changes one of those behaviours has to change both builders while #101 exists.

## Decisions (owner, 2026-10-17)

1. #98 and #99 merge before this plan starts.
2. **Naming packages by file location is accepted** (A1), including the breaking change for
   catalog and map keys of copied files and UE 4.27 packages.
3. **Breaking API changes are allowed** and ship together as 0.17.0, each with a migration note in
   its changeset.
4. **Keep optional fields**, not `Option`, for optional values (UE Shed's `exactOptionalPropertyTypes`
   style, about 866 uses). Write this down in `docs/engineering/types-and-errors.md` as a deliberate
   difference from the external standard.
5. **Non-null `!`**: a documented exemption for the game-text columnar hot-path files (about 2,064
   uses on typed-array indexing), justified with a benchmark per `effect.md`; enable
   `typescript/no-non-null-assertion` everywhere else.
6. **Every `// SAFETY:` assertion also gets a `// Verified by:` line** naming the tests that fail if
   the invariant breaks. Extend the existing lint rule. About 28 sites.
7. **Errors get a typed `nextStep`** (`fix_input`, `retry`, `reconcile`, `escalate`) next to the
   prose `recovery`. `retrySafe` and `nextStep: "retry"` must match the operation's real idempotency.
8. **Test layers are complete, behaviourally honest fakes**, not `Partial` mocks or "not stubbed"
   dies.
9. **Keep packages with a single consumer** (host, plugin-distribution), and treat each public
   library entry point as a boundary that may decode its input. Write this down in
   `docs/engineering/functional-design.md`.
10. **ID actions run through an editor plugin over Remote Control**, like authoring, with a
    commandlet entry for headless batches.
11. **Verify lane A on both UE 5.7 and UE 5.8 before merge**, as required by `AGENTS.md` and
    `testing.md`. The original executor had only 5.7; that machine limit is not a verification
    exemption. Discover installed engines or use explicit configuration rather than assuming a
    version is absent. Report unavailable checks explicitly and keep the affected item incomplete.
    A5 additionally requires UE 4.27. Do not install engines as part of this plan.
12. **PR #101 merges first.** Items that change behaviour the native builder duplicates (A1, A2,
    B5, B7, B8, C5; see "Two index builders") wait for #101 to merge and then change both builders.
    Other items do not wait.

## Machine prerequisites

- Windows, Node 26+, pnpm 11, Rust (CI pins 1.98.1 with rustfmt and clippy), wasm-pack 0.14,
  git and an authenticated `gh`.
- **Lane A** additionally needs UE 5.7 and UE 5.8 with engine source, plus Visual Studio 2022
  with the Unreal C++ workload. Discover engines from the registry or explicit configuration;
  registry entries can outlive an uninstalled engine, so confirm each folder exists. A5 separately
  needs UE 4.27. Never commit a machine path.
- **Lane C's real-project measurements** need read-only local copies of a large UE 4.27 project
  with a localization target and a large UE 5 World Partition project, provided by the owner. If
  they are absent, use the generated scale harness (`scripts/game-text-scale.md`) and record that
  real-project numbers are still missing. Never name those projects in the repository.
- If a prerequisite is missing, mark the affected items `BLOCKED` with a one-line reason and continue
  with the other lanes.

## Working method

- **One lane per worktree and branch** (`feat/058-a-game-text-actions`, …). Keep PRs few: a lane
  adds its items as commits to its open PR, one commit and one changeset per item. Open a separate
  PR only when an item needs its own review (a breaking API change, an ADR) or the lane PR has
  grown too large to review. Never stack across lanes.
- **Only lane A runs Unreal, and only one engine process at a time.** Before any engine task, check
  both editor process families, `tasklist /FI "IMAGENAME eq UnrealEditor*"` and
  `tasklist /FI "IMAGENAME eq UE4Editor*"` (the names `scripts/unreal-plugin-host.ts` selects);
  if an editor the plan did not start is open, STOP and ask the owner.
- Measurements run alone, never while a build, an engine task or another lane's tests run.
- Run targeted checks while iterating, `pnpm run check:precommit` before each push, and `pnpm check`
  before asking for review. Run relevant `fixture:*` commands, `test:uasset-conformance`,
  `check:unreal`, and `test:unreal-plugins` / `test:unreal-authoring` on both UE 5.7 and UE 5.8,
  selecting each engine explicitly. Parser and codegen changes also run
  `pnpm test:uasset-engine-matrix`. Report each version's result and unavailable checks in the PR
  body; an unavailable relevant version prevents complete verification. CI must be green.
- PR bodies say what changed, why, how it was verified (per engine where relevant), what is
  breaking, and the migration note. Link the item ID.
- **Merging is the owner's**, unless the owner has explicitly authorised merging in the running
  session; then merge each green PR in lane order.
- **Two index builders** (decision 12). An item that changes package naming, place kinds or keys,
  gather or origin rules, review marks or the joined layout starts only after PR #101 has merged.
  It changes `crates/game-text-index` in the same PR and extends #101's differential tests
  (`native-index-builder.integration.test.ts`, `scripts/native-game-text-join.test.ts`) so both
  builders agree. While #101 is open, mark those items `BLOCKED — waits for #101` and work on the
  others. Bump the `joined-native-v1:` key namespace whenever the native joined layout changes.
- Do not add hardcoded studio policy. UE Shed ships Unreal's facts, engines and extension points;
  any preset is optional and host-replaceable.
- The audit counts below are a baseline, not a target to game. Re-measure with a TypeScript AST scan
  of `{packages,apps,extensions}/*/src` excluding tests, test-support, dist and e2e.

## STOP conditions

Stop and ask the owner when:

- a step needs a credential, token or sign-in (Perforce, npm, Cloudflare, GitHub beyond `gh`);
- publishing anything (npm staging or release) is next; R ends at a release-preparation PR;
- an Unreal editor is already open, or a second engine task would be needed concurrently;
- committed Unreal evidence (fixture `evidence*.json`, `expected-cases.json`, gather output) would
  have to change in a way the engine run does not explain;
- a change would need a studio-project name, path, asset or schema;
- a breaking change is needed that this plan does not list;
- a real-project measurement shows a regression larger than 10% that the item cannot explain;
- a decision above turns out to be wrong in practice.

## Lane A: Game Text ID actions (needs Unreal)

Goal: a host can regenerate a text's key, adopt another id's key (merge), change its source,
recompile the owning Blueprint and confirm the new ids by re-reading, for every place the identity
fixture covers, on both UE 5.7 and UE 5.8 (decision 11).

First PR of the lane: add a short "Asset key fixes" note to Plan 052's out-of-scope section pointing
to this plan.

### A1. Name packages by file location

- The parser takes the mounted package name from its caller (derived from the file's location under
  a mount root: `Content/` → `/Game/`, plugin content → `/<Plugin>/`) and keeps the saved name
  beside it as evidence. Object, import and export paths use the mounted name.
- Remove the guessing in `packages/game-text/src/package-object-path.ts` once the reader is right.
- Follow through catalog and project index (`crates/uasset-io/.../scanner.rs:90`, `catalog.rs:70`,
  `catalog_sqlite.rs:637`, `project_io.rs:1297`, `packages/unreal-assets/src/project-index.ts:127,135`,
  `asset-reader.ts:369,441`), maps (`saved_world.rs:282`, `project_io.rs:2180-2196`,
  `level_sequence.rs:547`), inspection (`generic.rs`, `generic/json.rs`, `saved_inspection.rs`) and
  Game Text (`corpus.ts:186-215`, `representation-copies.ts:82-120`).
- With PR #101: `join_policy.rs` `manifest_package`, `file_label` and `relative_package` know only
  `/Game/` ↔ `Content/`; they need the same mount-root mapping (plugin content included).
- Bump any persisted index or snapshot format that stores object paths so old caches rebuild.
- **Accept when** the identity fixture's `Branched/` packages report `Branched/` object paths, the
  committed 4.27 legacy fixture reports full paths (saved bytes; no engine run needed), PR #99's
  reader test no longer derives the package from `packageFile`, and both engine versions pass.

### A2. Graph pin text as Game Text places

- Project pin `DefaultTextValue` as an authoring place (location kind for a graph pin with
  Blueprint, graph, node GUID and pin name), editable through the A3 API.
- Fold the compiled bytecode literal (`ScriptBytecode` place from PR #99) under the pin it came
  from only when that is provable. PR #99 deduplicates `(identity, source)` per function and
  reports one `ScriptBytecode` path with no node or pin provenance
  (`crates/uasset-inspection/src/projection.rs`, `DecodedAsset::Function`). Matching identity or
  source, even with exactly one current pin in the function, does not prove origin: a pin may
  have been removed or re-keyed since compilation, or a macro may contribute the literal.
  Require explicit reader evidence linking the compiled site to that pin before folding or
  assigning a per-pin stale-compile state. Without that evidence, keep the compiled literal as
  a separate place with unproven attribution; use ambiguous attribution when multiple origins
  remain possible. Do not assign any pin a stale state from unproven or ambiguous evidence.
  Adding per-pin bytecode provenance is out of scope, so PR #99's deduplicated output keeps this
  conservative fallback.
- Replace "UE 5.7" wording in graph comments and errors with the real version range.
- With PR #101: the native place keys (`package_evidence.rs` `places`, keyed on location codes
  0–2) and `join_places.rs` need the new pin location kind.
- **Accept when**, on both engine versions, the fixture's Print Text pins appear as pin places
  with the same key and source Unreal gathers. Compiled copies fold, and an uncompiled edit
  produces a stale state, only with explicit pin provenance; otherwise they remain separate.
  Cover two pins sharing an identity/source, an uncompiled edit to one of them, a removed pin,
  a re-keyed pin, a macro literal, and a single matching current pin without provenance. In each
  unproven or ambiguous case the compiled place remains separate and no pin is marked stale.

### A3. Game Text actions: editor plugin and API

- New plan section or ADR first (S): the operation set, places, verification and failure model.
- `UEShedGameText` editor plugin, capability-advertised and allow-listed like `UEShedAuthoring`
  (`packages/engine/src/remote-control-permissions.ts:18`), plus a commandlet entry for headless
  batches. Operations: change key, regenerate key, adopt key, change source, compile Blueprint,
  save, re-read. Places: DataAsset properties, Blueprint CDO variables, SCS components, widget tree,
  graph pins; DataTables keep using `UEShedAuthoring`.
- Use `TextNamespaceUtil::GetTextIdForEdit` and `FText::ChangeKey` as the fixture does; verify each
  API in both UE 5.7 and UE 5.8 source.
- `@ue-shed/game-text` actions API: typed requests, dry run, apply, re-read and compare against the
  expected result. Errors follow lane D's shape.
- **Accept when** tests drive every applicable case in
  `fixtures/unreal-project/FixtureSource/GameTextActions/expected-cases.json` through the API on
  both engine versions and the re-read ids match Unreal's gather.

### A4. Identity fixture, slice 2

Add cases checked against Unreal's gather on both UE 5.7 and UE 5.8: compiled text literals of
every saved type, including culture-invariant text, String Table references, UE 5.8's renumbered
literal types and text with translator notes; a child Blueprint that inherits a parent's text and
one that overrides it; level actor text; World Partition external actor text; and C++ `LOCTEXT`
(gather-only, documented as such). Extend `expected-cases.json` and the integration test. Synthetic
byte cases supplement, rather than replace, saved-asset evidence from each engine version.

### A5. UE 4.27 identity slice

Requires an installed UE 4.27 engine with source (decision 11). Discover it or configure it
explicitly; if unavailable, mark this item `BLOCKED` and report the missing prerequisite.

A 4.27 identity fixture; bytecode literals checked against 4.27 evidence (4.27 support so far comes
only from reading engine source); pins on 4.27 (version gate and pin-type custom-version minimums
in `codec/native_values/pin_type.rs:8-20`).

### A6. Stretch: text diff of two package versions

A function comparing the text records of two copies of one package (for example depot head and
local) and reporting added, removed, re-keyed and edited text. The changelist scanner building
block; Perforce stays in the host or a later `@ue-shed/perforce` (Plan 052 Phase 3).

## Lane B: studio-owned rules engine

Goal: every check is visible, configurable and replaceable from the rules file or the host. Checks
that model Unreal's behaviour keep fixed logic but studio-controlled severity, on/off and scope;
heuristics are fully the studio's; studios can add checks and mark single lines as intended.

### B1. Check catalogue

One descriptor per check: id, `unreal` or `heuristic`, default severity, parameter schema with
defaults, and a condition text generated next to the thresholds it describes. Replaces
`checkSeverity`, `workspaceQualityLabels` and the private text-shape constants. Export
`localizationRuleId` and `parseLocalizationRuleId`. Generate the README check table from it.

### B2. Rules file v3

Per check: `enabled`, `severity`, `scope` (roles, cultures, path prefixes) and `params`, plus an
optional preset reference. Migrate `disabledLocalizationChecks`, `segmentSeparator`,
`optionalTags` and `optionalArguments`; v1 and v2 files keep loading. Rename `quality-rules-v2.ts`.

### B3. Parameterised, scoped checks

Text-shape helpers become functions of parameters. Apply scope after a finding is produced so units
stay lazy, except for suppression: "one check switches another off"
(`localization-checks.ts:1121-1140`, `:1163-1231`, `:1283-1292`) must ask whether the suppressing
check is enabled **and in scope** for the unit, so an out-of-scope check never hides an in-scope
one. Regression case: a long source with translation `skip`, `placeholder_translation` scoped to
another culture and `length_outlier` scoped to this one; the length finding survives (extend
`localization-checks-shape.test.ts:384-400`).

### B4. Severity stored per finding

A severity column beside the full 32-bit facts word (`localization-quality-index.ts:766-781`);
`severityAt` and `severityCounts` read it; policy findings get severity. Coordinate with C3, which
touches the same scan.

### B5. Host-supplied policies

`AudiencePolicy` with today's `TEXT_AUDIENCE_POLICY` (`text-audience.ts:80-95`) as the exported
default preset; the `/debug/i` exclusion and placeholder word list move into the preset; gate
default failures become opt-in (`localization-gate.ts:42,101`); no implicit `segment_separator`
disable (`localization-checks.ts:425`). Policy is hashed into cache keys. With PR #101, policy
that the native join uses (gather rules, origin) is passed in the join input, not re-hardcoded in
Rust, and the policy hash is part of the native joined key.

### B6. Studio-defined checks

Open the closed unions with a generic custom finding and a dynamic filter list; lift the
8,192-rule packing limit. First custom kinds: pattern, length and forbidden term, each scoped by
role, culture and path.

### B7. Intended marks

Fix: an acceptance saved with `culture: null` is looked up as `""` and never matches
(`localization-review.ts:134`). PR #101's `join_marks.rs` requires a string culture
(`ok_or("review culture")`), so a `null` culture fails the native build; fix both. Allow keyless
findings such as `culture_invariant_text` (`:139`).
Decide and document whether a parameter change voids a mark.

### B8. Scans keyed on the resolved rules

Key cached scans on a content hash of the resolved rules and policies instead of object identity
(Workbench `game-text-localization.ts:419-455`), so unchanged rules never rescan.

## Lane C: performance

Measure first; choose C3–C5 from the C1 data. Follow ADR 0010's measurement rules: alternating fresh
processes, verified result hashes, never summed worker time as wall time.

- **C1. Stage breakdown on real projects.** Instrument the build and Quality scan by stage on the
  large UE 4.27 project and the large UE 5 project; record results in
  `docs/engineering/game-text-shared-index-measurements.md` without naming the projects. If PR
  #101 is available, measure both builders and say which one each number is for; #101's own
  numbers are prototype figures that exclude discovery, extraction and UI work.
- **C2. Prepare the query once, off the main thread.** Build the query model in the search worker
  and give the main thread a proxy, removing the ~1.15 s block in `openTarget` and the duplicate
  build. Port the responsiveness test from the `perf/game-text-event-loop-probe` branch on origin
  (`packages/game-text/src/host-responsiveness.test.ts`, its `.test-support.ts` and
  `scripts/test-game-text-responsiveness.ts`; the branch predates PR #96 and is reference only, not
  for merging) and cover the whole build-and-open path. Add a test that cancels a
  scan at one of PR #96's yield points with an old reader pinned and a second writer queued.
- **C3. Quality scan in a worker.** It runs on the host's main thread (longest stall ~0.94 s on the
  large project).
- **C4. Column cache per reader** and the per-id segment rebuild in `bytesSync`; profiles attribute
  37% of the Quality scan to string lookups.
- **C5. Spike: binary package-text output.** The reader's ~3 GB of JSON on the large project is
  decoded in Node, re-written as NDJSON and decoded again in workers
  (`package-text-layer.ts:303-312`, `package-text-worker.ts:17`). Measure a binary or native-written
  layer before adopting it. PR #101 already has the reader process write the shared index, but
  still receives the TypeScript producers' layers as staged JSON; build the spike on its protocol
  and writer lease rather than a second native path.
- **C6. Electron vs Node.** One control run took 122.6 s in Electron and 70.5 s in Node on the same
  input. Find the cause or record why it couldn't be found.
- **C7. Bytecode reader cost.** Text extraction on the large UE 4.27 project got 9% slower with PR
  #99; profile it once C1 exists.

## Lane D: API surface and the Effect and errors audit

**Scope.** The Effect and errors audit (D4–D8, D11, D12) covered all TypeScript in
`packages/*/src`, `apps/*/src` and `extensions/*/src` (667 files, about 192k lines, tests excluded),
and its fixes apply to every package; package names below set the order, not the scope. The API
review behind D1, D2, D9 and D10 looked only at `game-text` and its neighbours; D13 repeats it for the
other host-facing packages. The audit did not cover Rust or the C++ editor plugins; D14 does.

Order matters: shrink the public surface (D1, D13) before documenting it (D11) or wrapping its
decoders (D7). Every fix lands with a lint or `check-effect-architecture` rule so it cannot regress.

- **D1. `game-text` entry points** (breaking imports). Subpaths `./schema` (browser-safe wire types
  and ids), `./rules`, `./checks`, `./index` (Node: steps, layers, retained model, errors,
  progress), `./corpus`, `./labels`; named exports only. Snapshot, shared-index, joined,
  package-text, cold-pool and worker modules become private. Stop re-exporting other packages'
  types (`investigation.ts:275`, `localization-review.ts:12`). With PR #101,
  `nativeIndexBuilderLayer` goes in `./index`, and its newly exported `SharedIndexManifestSchema`
  becomes private again.
- **D2. Reader batching inside `gameTextIndexSourceNodeLayer`**, and export the request limit from
  `unreal-assets` (`protocol-transport.ts:58`), so hosts stop batching themselves.
- **D3. Unreal path module** (breaking brands), paired with A1: branded `PackageName`, `ObjectPath`,
  `TopLevelAssetPath`, `ProjectRelativeFile`; public `owningAssetPath` and `packageFileKey`; locate
  requests take `TopLevelAssetPath`. Game Text namespace and key use localization's brands.
- **D4. One error shape** (breaking): `{ code, message, recovery, retrySafe, nextStep, cause }`
  across every package (141 error classes today); named failure schemas instead of positional union
  members. Architecture check: every TaggedError has `message`, `recovery`,
  `retrySafe` and `nextStep`. Fill the 56 missing recoveries, starting with `AssetReaderError`,
  `UnrealConnectionError`, `UnrealCapabilityError`, `RemoteControlClientError` and the camera errors.
- **D5. Classified causes instead of prose** (message text changes). Replace `String(cause)` and
  `Cause.pretty` messages with classified codes plus `cause`. Split `artifact_invalid`
  (`cameras/src/camera-render.ts:505-557`) and `scan_limit_exceeded` (`game-text/src/corpus.ts:1066-1075`,
  which also labels a missing root). Rewrite `snapshot-store.ts:74-81` `failure()`, which turns any
  error into "unavailable, retry". PR #101's `native-index-builder.ts` does the same for every
  native failure (`nativeFailure`, `unavailable(...)` into `SnapshotStoreError`); classify those too.
  Lint against `String(cause)` in error constructors.
- **D6. Deliberate error translation.** Replace the catch-alls in `packages/host/src/authoring.ts`
  and `cameras/src/review-schema.ts:2333-2365` with `catchTags`; stop exposing `_tag` as a public
  code. Replace the 134 `instanceof` checks on tagged errors and the message-text branches (for
  example `shared-index.ts:401`). Keep parse issues in the 55 `mapError(() => …)` sites, starting
  with `unreal-assets/src/project-index.ts:268-352`.
- **D7. Domain parsers instead of raw decoders** (breaking error types). Wrap the 131 exported
  `Schema.decode*` factories in unary domain parsers returning domain errors; lint against new
  exported raw decoders. Stop re-decoding already typed service input where a branded type can carry
  the evidence (`corpus.ts:1066,1083`).
- **D8. Layers and test layers** (breaking composition). No layer factories taking services or
  Layers (`authoring-catalog/src/index.ts:180`, `game-text/src/project-index-view.ts:18`,
  `authoring/src/session-service.ts:1254`); un-export `make*` constructors used only in their own
  module; complete test layers (13 `Partial`, 24 "not stubbed"). Lint: an exported `make*` is
  imported only by its own module and tests.
- **D9. One progress mechanism, one completeness shape** (breaking). Today: a reporter service,
  polling and callbacks; four partial-read shapes. Pick one of each; make `localizationQuality` and
  `sourceQuality` required on the index result and use one argument order for both.
- **D10. Workspace orchestration as `@ue-shed/game-text/workspace`** (additive). Ship the Workbench
  orchestration with extension points (rules location, writable-file hook, recovery copy, policy) so
  hosts stop copying it; rename `Workbench*` operation schemas to `GameTextOperation*` with
  deprecated aliases. Let a scan outlive the connection that started it.
- **D11. JSDoc on public exports**, after D1, enforced per package with `jsdoc/require-jsdoc`,
  starting with protocol, unreal-connection and the game-text entry points. Document caller-visible
  facts the signature can't show; expected failures go in the description, not `@throws`.
- **D12. Small cleanups.** Remove "Phase N" comments (`package-text-layer.ts:517`,
  `shared-string-file.ts:130`); rewrite multi-step `map`/`flatMap` pipes as generators; pass
  pipeable transforms straight to `Effect.fn`; add the `Verified by:` lines (decision 6); document
  decisions 4, 5 and 9; mark Plans 053 and 054 current (both still say they wait on PR #58, which
  merged on 2026-10-09).
- **D13. API surface of the other host-facing packages.** Repeat D1's review for `protocol`,
  `unreal-connection`, `localization`, `unreal-assets`, `engine`, `cameras` and `host`: which exports a
  host uses, which are internal, and entry points with named exports. Include PR #101's protocol
  1.13 `game_text_index` types and `unreal-assets` `game-text-index-client`. Measure first (an
  AST scan of each package's exports against its uses in `apps/` and other packages), then cut.
- **D14. Native error audit.** Apply the error checklist to the Rust crates and the C++ editor
  plugins where their failures reach a host: `AssetError` kinds and messages (what failed, the path
  and byte offset, a way forward) as they appear in CLI and protocol output; `unwrap`/`expect`/panics
  in non-test decoder code (a malformed package must be a typed error, never a crash); and
  `UEShed*` plugin results over Remote Control (stable codes, no prose-only failures). Include
  PR #101's `crates/game-text-index` if it has merged: it returns string errors (for example
  `ok_or("review culture")`) and has about 30 `unwrap`/`expect` calls outside tests. Add
  `clippy::unwrap_used`/`expect_used` for non-test code where it holds.

## R. 0.17.0 release preparation

Collect the changesets and open the release-preparation PR per `docs/engineering/releases.md`, with
a migration guide covering every breaking item. STOP before staging or publishing; the owner
approves and publishes.

## Suggested order

| Day | A      | B      | C      | D                |
| --- | ------ | ------ | ------ | ---------------- |
| 1   | A2     | B1     | C1     | D1, D2           |
| 2   | A2, A1 | B2     | C1, C2 | D4               |
| 3   | A1, A3 | B3, B7 | C2     | D5, D6           |
| 4   | A3     | B4, B8 | C3     | D3 (with A1), D7 |
| 5   | A3, A4 | B5     | C4, C6 | D8, D9           |
| 6   | A4, A6 | B6     | C5     | D10, D13         |
| 7   | A6     | —      | C7     | D11, D12, D14, R |
