# Plan 011: Make domain workflows Effect services

> **Executor instructions**: Migrate one domain at a time and leave the repository green after each
> domain. Update the plan index only after every listed domain has landed.
>
> **Drift check (run first)**: `git diff --stat 2f7ac8b..HEAD -- packages/authoring packages/authoring-catalog packages/asset-audits packages/game-text packages/cameras packages/unreal-assets`

## Status

- **Priority**: P0
- **Effort**: XL
- **Risk**: HIGH — these packages are the headless product APIs used by both CLI and Workbench
- **Depends on**: Plan 010
- **Category**: migration
- **Planned at**: commit `2f7ac8b`, 2026-07-16

## Why this matters

Function-level Effects do not give the repository a coherent runtime. Canonical domain operations
must resolve dependencies from context, expose named effects, and compose without Promise or
`Effect.run*`. This plan makes the headless libraries—not either app—the Effect-native product core.

## Current state

- `packages/asset-audits/src/texture.ts:260-359` composes a scan as Effect but takes all runtime
  concerns through an options object and calls saved-asset functions directly.
- `packages/game-text/src/corpus.ts:343-392` duplicates the same free-function scan shape.
- `packages/authoring-catalog/src/index.ts:168-249` accepts an optional ad-hoc live connection and
  converts nearly every error into diagnostics.
- `packages/authoring/src/session-service.ts:128-190` already has a useful interface, but its factory
  returns an object rather than a Context service/layer.
- Camera capture, live review, authoring, and repositories are separate free-function modules.

## Canonical modules

Create owning modules (names may match existing repository vocabulary):

- `TextureAudit.Service`
- `TextCorpus.Service`
- `AuthoringCatalog.Service`
- `AuthoringSession.Service`
- `ReviewCapture.Service`
- `ReviewAuthoring.Service`

Each has an intentional interface, `Context.Service`, live/test layers, `Effect.fn` methods, and
typed error unions. Package barrels relay module identities. Services depend on Plan 010 adapters,
not on each other’s internals.

## Commands you will need

| Purpose            | Command                                                                                                                     | Expected on success                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Package tests      | `pnpm test:fast -- packages/asset-audits packages/game-text packages/authoring packages/authoring-catalog packages/cameras` | pass                                 |
| Typecheck          | `pnpm typecheck`                                                                                                            | exit 0                               |
| CLI E2E regression | `pnpm test:e2e:cli`                                                                                                         | pass after temporary caller adapters |
| Full gate          | `pnpm check`                                                                                                                | exit 0                               |

## Scope

**In scope**: domain package source, exports, tests, test layers, and minimal compatibility accessors
needed for callers until Plans 012–014.

**Out of scope**: app runtime composition, UI state, new domain features, protocol encoding changes,
automatic retry without idempotency evidence.

## Steps

### Step 1: Establish the module/service convention

For every domain module, define an interface whose public and non-trivial internal operations use
`Effect.fn("Domain.operation")`; define `Context.Service`; build the live implementation with
`Layer.effect`; expose intentional live/config/test layer constructors. Keep implementation helpers,
row codecs, and adapter details private.

Use functional programming throughout: immutable inputs, pure transformations, algebraic data types,
and composition. Do not create services for arbitrary math or value transformations. The canonical
workflow that invokes those pure functions is a named service operation and owns failures,
dependencies, state, telemetry, and concurrency in Effect.

**Verify**: a package-level architecture test confirms every effectful public workflow belongs to a
service module or is an explicitly documented pure value transformation.

### Step 2: Migrate scans and catalogs

Convert texture audit, game text, saved-asset catalog, and authoring catalog workflows. Obtain
reader/files/config from services. Make scan limits and concurrency configuration validated values.
Preserve partial-result policy, but distinguish truthful diagnostic degradation from failures that
must remain in the error channel.

**Verify**: complete, partial, limit exceeded, per-package failure, and cancellation tests pass.

### Step 3: Migrate authoring sessions and live transitions

Make `AuthoringSession.Service` canonical. Compose repository, clock, ID generation, and authoring
connection through layers. Express Apply/Save preparation, dispatch, indeterminate marking,
reconciliation, and completion as named Effect workflows; use `ensuring`/typed recovery so an
interrupted or failed dispatch cannot bypass indeterminate-state persistence.

Keep deterministic draft folds as ordinary pure functional building blocks inside these workflows.
Do not wrap individual field reads in Effect unless they can fail or require context, but do not
expose a separate Promise/stateful runtime.

**Verify**: success, rejected validation, concurrent updates, interruption between dispatch and
receipt, reconciliation, and save recovery tests pass.

### Step 4: Migrate camera review workflows

Compose review repository, Remote Control capabilities, capture, authoring preview, and evidence
storage through services/layers. Use bounded Effect concurrency for view capture. Classify per-view
failure versus whole-run failure explicitly and retain provenance.

**Verify**: capture, framing approval, preview failure, partial capture, interruption, and storage
cleanup tests pass.

### Step 5: Remove free-function compatibility paths

After all in-repo consumers have a migration path, delete compatibility wrappers that construct
dependencies or hide layers. Pure transformation exports may remain only when independently useful
and side-effect free. No service may call `Effect.run*`.

**Verify**: `rg -n "Effect\.run(Promise|Sync)" packages -g '*.ts'` returns no matches.

## Test plan

- Use `it.effect` and provide layers per suite/test.
- First-class test services must expose control/inspection without leaking into production tags.
- Assert typed failures and service requirements at compile time.
- Use TestClock for deadlines and schedules; use Deferred/Queue/Ref for concurrency.
- Preserve pure algorithm tests for folds, framing, searches, and codecs.

## Done criteria

- [ ] Every public stateful/effectful domain workflow is a named service operation.
- [ ] Live/test/config layer constructors are available without app dependencies.
- [ ] Domain packages contain no `Effect.run*`, Promise orchestration, direct env reads, or hidden
      global services.
- [ ] Failure/partial-result policy is explicit and tested.
- [ ] `pnpm check` and `pnpm test:e2e:cli` pass.

## STOP conditions

- A domain service would depend on Workbench/Electron.
- A proposed service combines unrelated domains solely to simplify layer wiring.
- Error handling would turn interruption/defects into a successful diagnostic result.
- Existing Apply/Save recovery semantics cannot be preserved.

## Maintenance note

New product capabilities enter through domain services first. Apps compose them; they do not add
private workflows around them.
