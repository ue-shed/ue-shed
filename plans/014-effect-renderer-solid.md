# Plan 014: Make renderer and extension clients Effect-native

> **Executor instructions**: Keep Solid a view adapter. Do not move domain state machines into
> components. Update the plan index after component and Workbench E2E tests pass.
>
> **Drift check (run first)**: `git diff --stat 2f7ac8b..HEAD -- apps/workbench/src/renderer extensions packages/authoring-sdk packages/cameras packages/asset-audits packages/game-text`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: MED — visible loading/error/cleanup behavior changes across four extensions
- **Depends on**: Plans 009 and 013
- **Category**: migration
- **Planned at**: commit `2f7ac8b`, 2026-07-16

## Why this matters

The renderer currently exposes Promise clients directly to components, so Effect stops at IPC and
Solid components own async orchestration. Effect-core architecture requires one browser runtime
adapter: IPC stays Promise-shaped only inside transport services; extension-facing clients expose
typed Effects/Streams and component lifetimes interrupt fibers.

## Current state

- `extensions/data-authoring/src/authoring-route.tsx:56-68` defines 11 Promise client methods.
- The asset audit, game text, and camera review extensions use the same Promise-client pattern.
- `apps/workbench/src/renderer/authoring-client.ts:110-132` awaits IPC and sync-decodes each result.
- Data authoring route has 1,188 lines and runs async actions from component event handlers.
- The project guidance requires one clear Effect-to-Solid adapter and thin views.

## Commands you will need

| Purpose         | Command                   | Expected on success |
| --------------- | ------------------------- | ------------------- |
| Component tests | `pnpm test:components`    | pass                |
| Typecheck       | `pnpm typecheck`          | exit 0              |
| Workbench E2E   | `pnpm test:e2e:workbench` | pass                |
| Full gate       | `pnpm check`              | exit 0              |

## Scope

**In scope**: renderer clients/runtime, four maintained extension client contracts/components/tests,
SDK/browser-safe schema exports, manifests.

**Out of scope**: Electron main runtime, domain behavior, visual redesign, replacing Solid, exposing
Node-only package modules to the renderer.

## Steps

### Step 1: Define browser-safe client services

For Data Authoring, Asset Audits, Game Text, and Map Review, define a `Context.Service` interface
whose operations return Effect and whose event/state feeds use Stream where naturally many-valued.
Keep contracts in browser-safe SDK/domain entry points that do not import Node adapters.

Transport result schemas come from Plan 009. Map transport failures into typed client errors once.

**Verify**: `rg -n "=> Promise<" extensions -g '*.ts' -g '*.tsx'` returns no public extension client
methods.

### Step 2: Implement IPC transport layers

Wrap each `window.ueShed` Promise call with `Effect.tryPromise`, decode unknown results effectfully,
and expose a live layer for the client service. Promise must not escape these files. Build one
renderer ManagedRuntime from the client layers.

**Verify**: only IPC adapter modules reference `window.ueShed` or `Promise`.

### Step 3: Add one Effect-to-Solid lifetime adapter

Create a small tested integration that runs an Effect/Stream in the renderer runtime, updates Solid
signals from explicit state unions, and interrupts fibers with the Solid owner cleanup. It must
handle latest-request-wins, stale completion, cancellation, and teardown without React-style
assumptions.

Use this adapter consistently; do not scatter `runtime.runPromise` through components.

**Verify**: tests prove unmount interruption, no stale overwrite, and no duplicate subscription.

### Step 4: Migrate each route

Replace async handlers with named client effects launched through the Solid adapter. Retain domain
decisions in services; component-local state is limited to view concerns such as selection, filter,
and presentation. Preserve loading, not-configured, cancelled, failed, stale/reconnecting (where
applicable), and ready states.

Split oversized route files by view ownership only after the behavior is covered; do not create
generic UI abstractions during migration.

**Verify**: component tests cover visible state and user actions through test client layers.

### Step 5: Convert component test doubles

Replace Promise object literals with Effect test layers. Use deterministic controls for delayed
operations and subscriptions. Keep IPC/process/native-reader behavior in Workbench E2E, consistent
with `docs/engineering/testing.md`.

**Verify**: `pnpm test:components` passes with no arbitrary sleeps.

## Done criteria

- [ ] Extension client APIs are Effect-native and browser-safe.
- [ ] Promise exists only inside IPC transport adapters.
- [ ] One renderer runtime and one Effect-to-Solid lifetime adapter exist.
- [ ] Component fibers are interrupted on cleanup and stale results cannot win.
- [ ] Component and Workbench E2E tests pass.
- [ ] `pnpm check` exits 0.

## STOP conditions

- A public package entry point pulls Node/Electron code into the renderer bundle.
- A component requires domain logic that is missing from a public service.
- The Solid adapter cannot prove interruption/cleanup or latest-request behavior.

## Maintenance note

Extensions consume public Effect services. Hosts provide layers; components never become the owner
of persistence, transport, retry, or recovery policy.
