# Plan 055: Keep Unreal responsive while UE Shed is in the foreground

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/engineering/testing.md`, `docs/engineering/types-and-errors.md`, the
> window activation precedent (`packages/protocol/contracts/core/v1/WINDOW-ACTIVATION.md`,
> `packages/engine/src/editor-window-activation.ts`, `UEShedEditorWindowLibrary.cpp`) and the
> research notes T11 and T15 on branch `research/sync-feasibility` (fetch it; do not merge it).
> Verify every Unreal fact against both engines' `Engine/Source`. Never copy Epic source text.
> Run targeted checks while iterating, then `pnpm run check:precommit`, the Unreal plugin gate on
> UE 5.7 and UE 5.8, and the live measurement on both engines.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/protocol/contracts/core packages/protocol/src packages/engine/src unreal/Plugins/UEShedCore apps/workbench/src/main`.

## Status

- **State**: IN PROGRESS
- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM. The Unreal side runs inside every connected editor's frame loop and holds
  handles to client processes. A wrong predicate either keeps an editor busy behind the user's
  back or does nothing; a leaked handle pins a process ID. Nothing writes settings or assets.
- **Depends on**: UE Shed Core capability manifest and editor window activation.
- **Category**: product
- **Planned at**: `feat/editor-foreground-responsiveness`, 2026-10-09

## Context

Unreal throttles a background editor to about 3 frames a second, so every Remote Control request to
a backgrounded editor waits about 333 ms (research T11, UE 5.7 and 5.8). Research T15 showed that a
conditional `UEditorEngine::ShouldDisableCPUThrottlingDelegates` entry, true only while a leased
client process owns the foreground window, cut a one-cell DataTable Apply against a minimised
editor from about 336 ms p95 to about 35 ms p95 on both engines, without changing the user's
setting.

This plan turns that into a capability: an editor-side lease predicate in `UEShedCoreEditor`, a
versioned Core contract, an Effect service in `@ue-shed/engine` that holds a lease as a scoped
resource, and Workbench adoption. When UE Shed is not in the foreground, Unreal's own policy
applies unchanged.

## Engine facts (verified 2026-10-09)

| Fact                                                                                                                                                                        | UE 5.7                           | UE 5.8                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------- |
| `ShouldDisableCPUThrottlingDelegates` is a public `TArray<FShouldDisableCPUThrottling>`                                                                                     | `EditorEngine.h:662`             | `EditorEngine.h:693`             |
| `ShouldThrottleCPUUsage` returns false early (commandlet, benchmarking, unattended, no render), then asks the delegates before the foreground, minimised and setting checks | `EditorEngine.cpp:5014`          | `EditorEngine.cpp:5305`          |
| Throttled idle wait: sleep 5 ms, pump messages, re-check, until `WaitEndTime - 5 ms`                                                                                        | `UnrealEngine.cpp:2804`          | `UnrealEngine.cpp:3106`          |
| After that loop, the remaining wait still yields with `SleepNoStats(0)` until `WaitEndTime`                                                                                 | `UnrealEngine.cpp:2819`          | `UnrealEngine.cpp:3121`          |
| `GetMaxTickRate` asks `ShouldThrottleCPUUsage` once per frame                                                                                                               | `EditorEngine.cpp:2525`          | `EditorEngine.cpp:2526`          |
| `bThrottleCPUWhenNotForeground` lives in `config=EditorSettings`                                                                                                            | `EditorPerformanceSettings.h:74` | `EditorPerformanceSettings.h:74` |

The 5.7 and 5.8 `ShouldThrottleCPUUsage` bodies differ only in 5.8's extra "async loading or asset
compilation" exemption, which runs after the delegates. The wait loop is identical. All in-engine
callers of `ShouldThrottleCPUUsage` run on the game thread (engine tick, `GetMaxTickRate`,
`UnrealEdMisc`, `PerformanceMonitor`, `AutoReimportManager`). Stock plugins (PCG, ChaosVD,
WaterAdvanced) and UE Shed Cameras register entries with `Add` and remove only their own handle.

**Consequence for the first wake.** The task brief inferred that a held lease would end a
throttled frame within about 5 ms of a foreground change. The source says otherwise: the 5 ms loop
exits, but the remainder of the frame still elapses (yielding instead of sleeping). The first
request after the foreground change should therefore wait for the rest of the current throttled
frame, 0–333 ms, about 167 ms on average, while every later request is fast. Phase 5 measures it.

## Owner decisions assumed (confirm or change)

1. **On by default** in the Workbench, with a setting to turn it off. Assumed because the effect is
   bounded to the time the user is looking at UE Shed and editing through it.
2. **Name**: capability `editor.foreground-responsiveness.v1`, manifest field
   `foregroundResponsivenessObjectPath`, library `UUEShedEditorResponsivenessLibrary`.
3. **Lease TTL**: 2–30 s, default 5 s. Clients renew at a third of the TTL.
4. **At most 8 leases** per editor. A ninth acquire is rejected with `lease_limit`.
5. **Any local client process may be named.** Remote Control is already loopback-only and trusted;
   the editor refuses only its own process and processes it cannot open.
6. **Windows only.** Other platforms do not advertise the capability.

## Design

### Unreal (`UEShedCoreEditor`)

- One delegate entry registered at `OnPostEngineInit` (or immediately if `GEditor` exists) and
  removed by handle at module shutdown. Never clear the array.
- `FUEShedForegroundLeases` (private) holds up to 8 leases: lease ID, client process ID, client
  creation time, process handle and an expiry on `FPlatformTime::Seconds`. A platform seam opens
  processes, reads creation time, checks liveness and reads the foreground owner, so automation
  tests can drive the logic with a fake.
- The predicate returns false at once with no leases or off the game thread. Otherwise it drops
  expired leases, reads the foreground owner once (`GetForegroundWindow` →
  `GetWindowThreadProcessId`), and for the first lease whose process ID matches, checks the held
  handle is still alive.
- Processes are opened with `SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION`. Holding the handle
  pins the process ID; the creation time from `GetProcessTimes` is bound at grant and re-checked on
  renew through a fresh handle, so a reused ID never inherits a lease. Handles are closed on
  release, expiry and shutdown. The editor's own process is rejected.
- Library functions `UpdateForegroundLease` (acquire, renew, release) and
  `GetForegroundResponsivenessState`, JSON in and out like `ActivateEditorWindow`. Every request
  carries `expectedProcessId`. Nothing reads or writes config except reading the user's
  `bThrottleCPUWhenNotForeground` for the state report.

### Contract (`packages/protocol/contracts/core/v1`)

`foreground-lease-request`, `foreground-lease-result`, `foreground-state-request` and
`foreground-state-result` schemas; `FOREGROUND-RESPONSIVENESS.md`; shared valid and invalid
request fixtures that both the TypeScript test and the Unreal automation test read.

### Engine service (`packages/engine/src/editor-foreground-responsiveness.ts`)

`EditorForegroundResponsiveness.hold({ endpoint, clientProcessId, ttlMs? })` refuses a non-loopback
endpoint before sending anything, negotiates the manifest, acquires, then renews in a scoped fiber
at TTL/3 and releases when the scope closes. After a successful acquire it never fails: renewal
failures log, count and retry with backoff; a lost lease (`expired`, or the editor changed) is
re-acquired. `state(endpoint)` reports the editor's diagnostics. Spans and metrics cover acquire,
renew and release outcomes.

### Workbench

A main-process `WorkbenchEditorResponsiveness` service follows the selected endpoint and the
preference, holding one lease scope for the current loopback endpoint with the main process ID.
Electron creates `BrowserWindow`s in the main process, so their HWNDs should belong to it; the live
run checks a real window's owner. The preference is stored in `userData` beside project history
and shown in the existing "Unreal target settings" popover.

## Phase 1 — Contract

1. Effect Schemas in `packages/protocol/src/editor-foreground-responsiveness.ts`; JSON schemas
   generated from them; fixtures; the contract document; alignment and fixture tests.

**Gate**: `pnpm vitest run packages/protocol`, `pnpm contract:check`.

## Phase 2 — Unreal

1. `UEShedForegroundLeases.{h,cpp}`, `UEShedEditorResponsivenessLibrary.{h,cpp}`, module
   registration, manifest advertisement under `PLATFORM_WINDOWS`.
2. Automation tests `UEShed.Core.ForegroundResponsiveness.*`: no lease; live lease not foreground;
   expiry; release; stale `expectedProcessId`; PID reuse (fake platform, changed creation time);
   own process; lease limit; real child process exit; shared fixtures; removing only our entry
   leaves another delegate; predicate cost.

**Gate**: `pnpm test:unreal-plugins` on UE 5.7 and UE 5.8, both green.

## Phase 3 — Engine service

1. Service, errors, metrics and spans; loopback rule shared with window activation.
2. TestClock tests: renew cadence, release on scope close, re-acquire after `expired`, degraded
   state after failed renewals past the TTL, loopback refusal with no request, typed errors for
   missing capability and rejected acquire.

**Gate**: `pnpm vitest run packages/engine`.

## Phase 4 — Workbench

1. Preference store, supervisor service, IPC, preload, renderer checkbox; tests for each.

**Gate**: Workbench unit and component tests; `pnpm run check:precommit`.

## Phase 5 — Live measurement (UE 5.7 and UE 5.8)

Disposable copies of the fixture project under `out/`, built per engine, launched attended (no
`-unattended`) with the throttle setting forced on by a launch-time `-ini:` override (nothing is
saved) and every editor window minimised. For each engine:

1. RC p50/p95/max for a no-op call and a one-cell DataTable Apply in three states: no lease; lease
   whose client owns the foreground; lease whose client does not.
2. First-request latency right after the foreground changes to the leaseholder with the lease
   already held. If Win32 foreground switching cannot be automated, use T15's controlled stand-in
   and say exactly what was exercised.
3. The owner of a real Workbench window (`GetWindowThreadProcessId`) against the main process ID.
4. Predicate cost from the automation test.

## Phase 6 — Documentation

Contract document; Workbench behaviour and setting in `docs/showcase.md` and
`apps/workbench/README.md`; changesets for `@ue-shed/protocol` and `@ue-shed/engine`.

## Verification matrix

| Scope      | Evidence                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| Contract   | alignment test, fixtures, `contract:check`                                   |
| Unreal     | plugin automation on 5.7 and 5.8; predicate cost recorded                    |
| Engine     | TestClock lifecycle and failure tests                                        |
| Workbench  | supervisor and preference tests, component test, window owner check          |
| Live       | latency table and first-wake measurement on 5.7 and 5.8, attended, minimised |
| Repository | `pnpm run check:precommit`; `pnpm check:unreal` (5.7 fixture gate)           |

## STOP conditions

Stop and report rather than working around it if:

- the delegate must run off the game thread and state access cannot be made safe;
- minimal process rights are insufficient for the identity checks;
- the exemption would need to change or save the user's editor settings;
- a remote endpoint could ever obtain an exemption;
- UE 5.7 and UE 5.8 diverge in a way that needs version-specific behaviour not verifiable in source.

## Out of scope and follow-ups

- CLI hosts: a terminal, not Node, owns the foreground window, so a CLI process's own ID never
  matches. A CLI policy needs its own design (for example naming the console host process).
- macOS and Linux.
- Multiple Workbench windows and several connected projects: one lease per selected endpoint today.
- Any sync-layer work.
