# Plan 013: Make Workbench main and IPC one scoped Effect runtime

> **Executor instructions**: Preserve demand-driven Unreal launch and the Workbench deletion test.
> Run component and Electron E2E gates before marking this complete.
>
> **Drift check (run first)**: `git diff --stat 2f7ac8b..HEAD -- apps/workbench/src/main apps/workbench/src/main/preload.ts apps/workbench/e2e packages`

## Status

- **Priority**: P0
- **Effort**: XL
- **Risk**: HIGH — Electron lifecycle, IPC, named-pipe ownership, and live mutation recovery meet here
- **Depends on**: Plan 011
- **Category**: migration
- **Planned at**: commit `2f7ac8b`, 2026-07-16

## Why this matters

Workbench main is currently the largest accidental architecture layer: a 1,157-line file with
global mutable state, direct environment reads, manual caches, Promise workflows, and dozens of
`Effect.runPromise` calls. It duplicates domain orchestration that the CLI also performs. A scoped
Workbench runtime should compose public services and adapt Electron once.

## Current state

- `apps/workbench/src/main/main.ts:62-73` reads env and declares feed/window/timer/launch globals.
- Lines 101-165 compose camera review with Promise, `Promise.all`, nested Effect runs, and broad
  try/catch.
- Lines 369-379 maintain mutable authoring maps/connections and build a session service via
  `Effect.runSync`.
- Lines 427-550 duplicate session/catalog orchestration and cache authority in module globals.
- Lines 742-783 manually bridge camera callbacks to presentation state and acquire the feed without
  scope.
- Lines 1036-1100 duplicate Apply/Reconcile/Save workflows.
- Lines 1147-1157 use Promise startup and best-effort feed close.

## Commands you will need

| Purpose             | Command                                      | Expected on success |
| ------------------- | -------------------------------------------- | ------------------- |
| Workbench typecheck | `pnpm --filter @ue-shed/workbench typecheck` | exit 0              |
| Component tests     | `pnpm test:components`                       | pass                |
| Workbench E2E       | `pnpm test:e2e:workbench`                    | pass                |
| Full gate           | `pnpm check`                                 | exit 0              |

## Scope

**In scope**: Workbench main/preload runtime and IPC organization, Electron adapter services,
Workbench E2E, necessary manifests.

**Out of scope**: renderer client contracts and Solid state (Plan 014), domain behavior, automatic
Unreal startup, wire changes, visual redesign.

## Steps

### Step 1: Create Electron adapter services

Wrap app lifecycle, BrowserWindow, dialog, IPC registration, preload transport, and fixture process
launch in narrow services. Adapt Electron Promises/callbacks once with cancellation/finalizers where
possible. Validate every IPC input with its schema before invoking a domain service.

**Verify**: main-domain workflows no longer import `electron/main` directly; only adapter modules do.

### Step 2: Build `WorkbenchLive`

Compose Config, Electron adapters, Remote Control, asset reader, repositories, camera feed, and all
domain services in one named layer graph. Replace direct env reads with Config recipes acquired at
startup or feature-layer construction. Preserve optional/demand-driven capabilities: absent Unreal
or project config yields typed unsupported/not-configured states, not startup failure.

Acquire the graph in one scoped ManagedRuntime owned from `app.whenReady` until `before-quit`.

**Verify**: a lifecycle test proves every acquired resource finalizes on normal quit, startup
failure, and interruption.

### Step 3: Make IPC handlers thin Effect programs

Each handler must decode input, invoke one public domain/application service workflow, encode the
schema-owned result, and run it through one shared runtime adapter. Delete Workbench-local copies of
Apply/Save/reconcile, catalog merge, review capture, and error parsing.

The adapter may call `runtime.runPromise` because Electron requires a Promise; individual handlers
must not call `Effect.run*` or construct layers.

**Verify**: `rg -n "Effect\.run(Promise|Sync)" apps/workbench/src/main` finds only the shared runtime
adapter.

### Step 4: Replace globals with scoped Effect state

Use `Ref`, `SubscriptionRef`, `Cache`, `FiberMap`, or service-owned state according to semantics.
Authoring snapshot/path lookup and negotiated connections belong to services. Fixture-launch
deduplication uses Effect caching/fiber coordination. Window state belongs to the Electron layer.

For camera presentation, consume `CameraFeed` as a scoped stream with an explicit sliding/latest
policy. The byte-level decoder and tight presentation-budget arithmetic may remain direct only if a
benchmark demonstrates meaningful Effect overhead; otherwise keep the pipeline Effect-native. Any
hot-path exemption must be isolated behind the CameraFeed service and documented.

**Verify**: no mutable module-level `Map`, `Set`, Promise, timer, connection, or service singleton
remains outside an approved measured hot-path adapter.

### Step 5: Split main by ownership

Reduce `main.ts` to runtime construction/startup. Put feature IPC modules beside their schema/client
owners and keep dependency direction from app adapters to public packages. Do not create a generic
Workbench service that simply becomes a new god object.

**Verify**: architecture tests assert packages do not import Workbench and main contains no domain
logic.

## Test plan

- Effect tests for lifecycle, config absence, handler decoding, typed error mapping, interruption,
  and cleanup.
- IPC contract tests for malformed values and every result variant.
- E2E for saved workflows without Unreal and demand-driven live launch.
- Camera tests for slow renderer, replacement metrics, window teardown, and no post-close sends.
- Real authoring gate before landing changes to live Apply/Save behavior.

## Done criteria

- [ ] One scoped Workbench runtime owns all services/resources.
- [ ] IPC handlers are schema adapters around public workflows.
- [ ] Workbench contains no duplicated domain orchestration.
- [ ] Global mutable runtime state is eliminated or backed by a benchmarked hot-path exception.
- [ ] Startup does not launch Unreal.
- [ ] `pnpm check`, component tests, and Workbench E2E pass.

## STOP conditions

- A required domain operation exists only inside Workbench.
- Electron cancellation/teardown semantics cannot be made truthful for an owned resource.
- Runtime composition would make absent optional capabilities fail application startup.
- A hot-path exemption is proposed without before/after measurement.

## Maintenance note

Workbench is a composition root and adapter. Deleting it must still leave every domain workflow
available through libraries and CLI.
