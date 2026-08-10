# Plan 043: Explain saved Unreal configuration provenance

**Status**: COMPLETE — headless slice, CLI, fixture, and standalone extension verified

**Priority**: P2

**Effort**: XL

**Depends on**: engine discovery boundary; Effect-native CLI runtime; browser-safe extension seam

## Purpose

Ship UE Shed's first Config Explorer / Settings Archaeology vertical slice: given an explicit Unreal
project, section, key, and platform, resolve the supported saved-source `.ini` hierarchy and explain
every contribution in order. The package and CLI are authoritative; a standalone host-neutral
extension renders supplied results without gaining filesystem authority.

The product contract is [`docs/products/config-explorer.md`](../docs/products/config-explorer.md).
Its distinction between effective saved-source evidence and runtime authority is an acceptance
boundary, not UI wording that can be relaxed later.

## Verified UE 5.7 basis

The implementation must remain derived from behavior, not copied engine implementation. The local
reference reviewed on 2026-08-11 is `C:\Program Files\Epic Games\UE_5.7\Engine\Source`:

- `Runtime/Core/Public/Misc/ConfigHierarchy.h` defines the ordered static layers and uncooked
  restricted/platform-extension expansions.
- `Runtime/Core/Private/Misc/ConfigContext.cpp` constructs the hierarchy, walks platform parents
  parent-most first, skips nonexistent files at runtime, merges a generated destination separately,
  and applies command-line/dynamic behavior outside the static source fold.
- `Runtime/Core/Private/Misc/ConfigCacheIni.cpp` maps and applies `=`, `+`, `.`, `-`, `!`, `^`, `@`,
  and `*`. The first six operations are earned for this slice; keyed-array metadata remains an
  explicit unsupported boundary.
- `Runtime/Core/Public/Misc/ConfigCacheIni.h` distinguishes clear from initialize-empty and shows
  that saved values, rather than expanded runtime values, own merge identity.
- `Runtime/Core/Private/Misc/DataDrivenPlatformInfoRegistry.cpp` discovers engine/project platform
  metadata and builds parent chains from `IniParent` values.
- `Programs/UnrealBuildTool/System/ConfigHierarchy.cs` independently enumerates equivalent
  engine/project, restricted, platform-extension, parent, plugin, user, and generated locations.
  It also confirms that config family is a required dimension rather than a property of
  section/key alone.

Important implementation conclusions:

1. A plain set replaces the first existing value in place; it is not a blanket list reset.
2. `+` is unique, `.` permits duplicates, `-` removes one stable match, `!` unsets, and `^`
   preserves explicit empty-array initialization.
3. Platform parents are data-driven strings and can exist solely to contribute ini layers.
4. Missing files are normally skipped by Unreal, but Config Explorer must retain them as coverage.
5. Full runtime equality would require user/private, generated destination, command-line, dynamic
   plugin/hotfix, cooked, environment, and live authorities that this product must not read or infer.
6. UnrealBuildTool's `ConfigHierarchySection` is not a runtime merge oracle: it clears all values on
   plain set and removes all matching values, while Runtime/Core's `FConfigFile::ProcessCommand`
   replaces the first value and removes one stable match. This slice intentionally follows the
   runtime implementation while using UBT only to corroborate hierarchy locations.

If later source inspection contradicts any of these conclusions, stop and update the contract before
changing behavior.

## Delivery sequence

### Phase 0: Contract, plan, and draft PR

- Add the focused product contract and docs index entry.
- Register Plan 043 as active.
- Commit only these documentation files, push `feat/config-explorer`, and open a draft PR targeting
  `main` titled `feat(config): explain Unreal settings provenance`.
- Record this bootstrap separately from implementation commits.

**Verify**: clean isolated worktree before edits; docs formatting and link paths; pushed bootstrap
commit; draft PR exists.

### Phase 1: Browser-safe domain and pure merge kernel

Create `packages/config-explorer` with:

- schema-owned branded project/platform/config-family/section/key identities;
- tagged value states, layer coverage, contribution operations/effects, source references, requests,
  explanations, comparisons, diagnostics, and public error schemas;
- a line-aware parser for ordinary sections, comments, quoting, and the six supported operations;
- explicit unsupported records for `@`, `*`, remaps, malformed/multiline forms, or any syntax not
  truthfully reproduced;
- an immutable fold that preserves contribution lineage and derives final effectiveness;
- pure platform comparison.

Keep the fold independent of filesystem, engine discovery, CLI, and UI. Public browser exports must
not load Node modules.

**Verify**: pure tests cover scalar replacement, set-after-array, unique/add duplicates, append,
single stable removal, no-op removal, clear, explicit empty, later re-add, case-insensitive
section/key identity, source locations, unsupported syntax, and schema round trips.

### Phase 2: Hierarchy and engine/project adapters

Add narrow Effect services/layers for project inspection, engine selection, safe file reads, platform
metadata, and hierarchy construction.

- Accept an explicit engine root through schema-validated configuration.
- Otherwise resolve the project's `.uproject` `EngineAssociation` through reusable
  `@ue-shed/engine-discovery` capability. Extend that package only with a narrow installation
  service; do not transplant script-only global discovery or create a config-specific locator.
- Validate the engine using version/build/config evidence. Never bake in the local UE path.
- Discover config families from engine/project source filenames. Return ambiguity rather than choose
  by incidental enumeration order.
- Build the uncooked static saved-source hierarchy and platform parent chain from safe engine/project
  locations. Do not probe application/user directories or `Saved/Config`.
- Emit a coverage entry for every constructed layer, including missing files, and an excluded
  authority summary for deliberately unvisited layers.
- Redact absolute paths at the public boundary.

Expose a public `ConfigExplorer` `Context.Service` with named `Effect.fn` operations and live/test
layers. Use typed failures for invalid project, incomplete engine discovery, invalid platform
inheritance, and safe-read failures; preserve interruption.

**Verify**: Effect/integration tests use real temporary trees for explicit/discovered engines,
missing/unreadable files, platform parents/extensions, ambiguity, path privacy, cancellation, and
typed recovery. Windows permission tests may be environment-gated but need a portable deterministic
adapter test.

### Phase 3: Generic fixture and Unreal conformance

Add a text-only fixture with a synthetic engine/project structure, `.uproject`,
`DataDrivenPlatformInfo.ini`, and two target platforms. Include intentional overrides, additions,
duplicate additions, removals, clear, initialize-empty, missing files, unsupported syntax, and a
platform difference.

Add an optional UE 5.7 conformance harness or commandlet comparison where practical. It must use
engine discovery/explicit configuration, not commit the local install path, and must compare the
same declared source-only hierarchy rather than accidentally include private/runtime layers.

**Verify**: fixture golden outcomes and the enabled real-Unreal evidence agree for earned
operations/platform ordering. Any mismatch blocks the parity claim and returns the plan to source
investigation.

### Phase 4: Headless CLI

Add schema-owned CLI commands and workflows under `ue-shed config`:

```text
ue-shed config explain <project> <section> <key> --platform <platform>
ue-shed config compare <project> <section> <key> --platform <left> --platform <right>
```

The exact comparison flag spelling may adapt to the CLI framework if it stays explicit and
unambiguous. Add optional `--engine-root` and config-family recovery input without weakening the
required explain syntax. Output the browser-safe result JSON. Usage failures exit through the
existing CLI boundary; domain/coverage states remain machine-readable results where useful.

**Verify**: command parsing, required journey, ambiguity recovery, incomplete discovery, partial
coverage, cancellation, JSON schema decoding, and process-level fixture E2E.

### Phase 5: Standalone host-neutral extension

Create `extensions/config-explorer` with a small Effect-native client contract and Solid/StyleX
presentation that accepts supplied explanation/comparison results. Show:

- effective saved value and complete/partial coverage;
- ordered layer/contribution timeline with prior/effect/effectiveness;
- missing, unreadable, excluded, and unsupported evidence without collapsing them together;
- side-by-side platform differences;
- an explicit “saved source, not live runtime” authority label.

No component or extension client may import Node filesystem/process APIs, Electron, Workbench main,
or a private IPC contract. Do not advertise copy-and-own adoption conformance in this slice.

**Verify**: component interaction tests cover complete, partial, missing, explicit-empty,
unsupported, and platform-difference states through the public client/result contract.

### Phase 6: Integration, documentation, and final gate

- Update package/architecture checks, CLI help tests, and relevant docs/showcase instructions.
- Add a Changeset if the new public package enters the repository's publication boundary; otherwise
  record why it remains private.
- Rebase on current `origin/main` before any Workbench IPC/preload composition. Integrate Workbench
  only if the rebase leaves a deliberate, validated host seam and no parallel-change collision.
- Update this plan's status and PR verification notes.
- Run focused checks during implementation, `pnpm check` after substantive edits, and `pnpm check`
  again immediately before handoff.
- Push all commits and mark the PR ready only after the full gate passes.

## Verification matrix

| Risk                            | Truthful gate                                                                |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Hierarchy precedence            | Golden fixture plus UE 5.7 source-derived order                              |
| Platform inheritance/extensions | Parent-chain fixture and cross-platform comparison                           |
| Array semantics                 | Pure lineage fold tests for `+`, `.`, `-`, `!`, and `^`                      |
| Source provenance               | Real text files with asserted logical path and line/column                   |
| Missing versus unreadable       | Real filesystem integration plus deterministic test adapter                  |
| Unsupported syntax              | Parser diagnostics that force partial coverage                               |
| Engine discovery                | Explicit root, association match, absent/ambiguous installation tests        |
| Path privacy                    | Recursive public-result/error scan rejecting absolute/private prefixes       |
| Cancellation                    | Interrupt an in-flight service read through a controlled Effect test service |
| Typed recovery                  | Tagged failure assertions; no CLI/UI error-text parsing                      |
| Browser safety                  | Import-boundary test and schema encode/decode in a browser-targeted build    |
| Extension meaning               | Solid component interaction tests over supplied results                      |
| Repository health               | Focused commands, then full `pnpm check` twice as required                   |

## Stop conditions

Stop implementation and document the finding if:

- UE 5.7 source or practical conformance contradicts the assumed hierarchy or operation semantics;
- a correct saved-source answer would require silently reading user-private config locations;
- platform inheritance cannot be represented from inspectable data with truthful missing/invalid
  coverage;
- the module starts absorbing Device Profiles, CVars, console/command-line state, cooked config,
  plugin hotfix machinery, or other general runtime-settings responsibilities;
- any existing, unreadable, unsupported, or expected layer would be silently ignored rather than
  surfaced in coverage;
- Workbench integration would require coupling the domain or standalone extension to in-flight
  private IPC/preload implementation.

## Completion checklist

- [x] Phase 0 bootstrap is the only content in the first commit and draft PR.
- [x] Public Effect service and browser-safe schemas exist without Workbench dependency.
- [x] Required explain command works for explicit project/platform fixture input.
- [x] Cross-platform comparison returns independently resolved evidence.
- [x] Earned scalar/array/clear semantics and provenance are tested.
- [x] Missing, unreadable, unsupported, and incomplete-discovery states are distinct.
- [x] User-private, live, command-line, Device Profile, and cooked authorities remain excluded.
- [x] Generic fixture and practical Unreal conformance evidence are recorded.
- [x] Host-neutral extension renders supplied results without filesystem authority.
- [x] Focused checks and both required final `pnpm check` runs pass.
- [x] Plan/PR verification is current, all commits are pushed, and the PR is ready for review.

## Completion evidence

- The bootstrap-only commit is `621a60c`; implementation remained in later commits.
- UE 5.7 Runtime/Core source was rechecked for static layer order, expansion-major platform-parent
  traversal, data-driven `IniParent`, config redirects, line parsing, and the six earned operations.
- The generic fixture resolves `Entries` to `["PlatformA"]` on PlatformA and to
  `["PlatformB", "PlatformB"]` on PlatformB. It also exercises scalar replacement, unique/duplicate
  addition, stable removal, clear, explicit empty, unsupported keyed arrays, relevant redirects,
  missing files, ambiguity, and privacy-safe provenance.
- A stock `-dumpconfig` run was not used as a conformance oracle because it includes generated,
  private, command-line, dynamic, and runtime state excluded by this contract. There is no stock
  commandlet that isolates this synthetic source-only hierarchy and synthetic platforms. The
  practical conformance evidence is therefore the Runtime/Core source-derived golden fixture and
  source-located operation tests, rather than a misleading stronger runtime claim.
- Focused package/extension coverage: 22 tests passed; the CLI process fixture test passed through
  the headless executable entrypoint. `pnpm run check:precommit` passed.
- Both final full `pnpm check` runs passed 127 test files and 703 tests, with 9 files and 27 tests
  skipped behind documented integration gates. They used `CARGO_INCREMENTAL=0`,
  `CARGO_PROFILE_DEV_DEBUG=0`, and `CARGO_PROFILE_TEST_DEBUG=0` to fit native DuckDB artifacts on the
  available drive; test and gate coverage were unchanged.
- Workbench IPC/preload composition remains deliberately deferred. The core, CLI, fixture, and
  standalone extension have no dependency on the parallel Workbench IPC work.
