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

- **State**: DONE. Phases 1–6 shipped in #60, including real foreground switches on UE 5.7 and
  5.8. The owner confirmed the decisions below.
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

## Owner decisions (confirmed)

1. **On by default** in the Workbench, with a setting to turn it off, because the effect is
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

**Evidence (2026-10-09)**: done. Four schemas generated from the Effect Schemas, 14 request
fixtures (4 valid, 10 invalid) and 5 result fixtures; the alignment and fixture tests pass. The
Unreal automation test parses the same request fixtures.

## Phase 2 — Unreal

1. `UEShedForegroundLeases.{h,cpp}`, `UEShedEditorResponsivenessLibrary.{h,cpp}`, module
   registration, manifest advertisement under `PLATFORM_WINDOWS`.
2. Automation tests `UEShed.Core.ForegroundResponsiveness.*`: no lease; live lease not foreground;
   expiry; release; stale `expectedProcessId`; PID reuse (fake platform, changed creation time);
   own process; lease limit; real child process exit; shared fixtures; removing only our entry
   leaves another delegate; predicate cost.

**Gate**: `pnpm test:unreal-plugins` on UE 5.7 and UE 5.8, both green.

**Evidence (2026-10-09)**: done. All 11 plugins build and all 34 tests pass on both engines, five
of them new (`Leases`, `Contract`, `NativeProcess`, `PredicateCost`, `DelegateEntry`). Predicate
cost over 200,000 calls: no lease 15.2 ns (5.7) and 9.6 ns (5.8); 8 leases with none foreground
64.1 ns (5.7) and 61.2 ns (5.8). At 200 calls a second while throttled, that is under 13 µs of
CPU a second. Every engine caller of `ShouldThrottleCPUUsage` is on the game thread, and Remote
Control invokes library functions there, so the lease table needs no lock; both entry points
return early off the game thread. `SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION` was enough
to open, time and watch a same-user child process.

## Phase 3 — Engine service

1. Service, errors, metrics and spans; loopback rule shared with window activation.
2. TestClock tests: renew cadence, release on scope close, re-acquire after `expired`, degraded
   state after failed renewals past the TTL, loopback refusal with no request, typed errors for
   missing capability and rejected acquire.

**Gate**: `pnpm vitest run packages/engine`.

**Evidence (2026-10-09)**: done. Nine TestClock tests: renewal at TTL/3, release on scope close
and nothing after it, re-acquire after `expired`, a restarted editor followed to its new process,
`Lapsed` once failed renewals outlast the TTL and recovery afterwards, remote refusal with nothing
sent (hold and state), missing capability, refused lease and unreachable editor as typed errors.
Window activation now shares `isLoopbackEndpoint`; its tests still pass.

## Phase 4 — Workbench

1. Preference store, supervisor service, IPC, preload, renderer checkbox; tests for each.

**Gate**: Workbench unit and component tests; `pnpm run check:precommit`.

**Evidence (2026-10-09)**: done. `WorkbenchEditorResponsiveness` reconciles once a second (and
at once when the setting changes): one lease for the selected loopback endpoint, named with
`process.pid`, moved on a port change and released when turned off or when the runtime closes.
Eight TestClock tests cover those, the remote and non-Windows refusals, backoff on an
unreachable editor and the slow retry for an editor without the capability. IPC contract and
registration tests cover the two new channels; a component test covers the checkbox and its
status line. The preference lives in `editor-responsiveness-v1.json` in Electron's user data.

## Phase 5 — Live measurement (UE 5.7 and UE 5.8)

Disposable copies of the fixture project under `out/`, built per engine, launched attended (no
`-unattended`) with the throttle setting on and every editor window minimised. For each engine:

1. RC p50/p95/max for a no-op call and a one-cell DataTable Apply in three states: no lease; lease
   whose client owns the foreground; lease whose client does not.
2. First-request latency right after the foreground changes to the leaseholder with the lease
   already held. If Win32 foreground switching cannot be automated, use T15's controlled stand-in
   and say exactly what was exercised.
3. The owner of a real Workbench window (`GetWindowThreadProcessId`) against the main process ID.
4. Predicate cost from the automation test.

**Evidence (2026-10-09)**: done, except the real-switch first wake (item 2). Harness (uncommitted,
`out/foreground-live/`): disposable copies of `fixtures/unreal-project` per engine, built, launched
with UE Shed Core and Authoring from the plugin host, no `-unattended`, throttle setting on, the
single editor window minimised. Each state: 40 sequential no-op calls (`GetCapabilityManifest`)
and 40 one-cell Applies on `DT_Scalars` (bool toggle, no Save), with `GetForegroundResponsivenessState`
confirming `exemptionActive` and `editorThrottling` before, every 10 samples and after. Nearest-rank
quantiles in ms:

| State                        | Engine | No-op p50 | No-op p95 | No-op max | Apply p50 | Apply p95 | Apply max |
| ---------------------------- | ------ | --------- | --------- | --------- | --------- | --------- | --------- |
| No lease                     | 5.7    | 331.9     | 333.6     | 336.3     | 334.6     | 337.0     | 338.1     |
| Lease, client foreground     | 5.7    | 5.9       | 25.4      | 32.1      | 10.5      | 14.3      | 20.2      |
| Lease, client not foreground | 5.7    | 332.0     | 333.2     | 333.7     | 334.4     | 336.9     | 347.8     |
| No lease                     | 5.8    | 332.0     | 333.3     | 333.6     | 334.4     | 335.0     | 335.1     |
| Lease, client foreground     | 5.8    | 15.4      | 32.2      | 33.6      | 17.5      | 34.3      | 34.4      |
| Lease, client not foreground | 5.8    | 332.0     | 333.1     | 333.2     | 334.4     | 334.8     | 334.9     |

What was exercised: the predicate against the real foreground window. Background processes could
not take the foreground on this desktop: Windows Search (`SearchHost`) held it and refused
`SetForegroundWindow`, `AttachThreadInput` and `SwitchToThisWindow` from the harness, as in T15.
So, as in T15, the "client foreground" lease named `SearchHost` (the actual foreground owner,
opened with the minimal rights) and the "not foreground" lease named a live, visible harness
window process. The state held in every check on both engines.

First wake (real switches, 2026-10-09, both engines). The desktop's Windows Search flyout held the
foreground at first; the harness pressed Escape once, clicked a stand-in once, and from then on
stand-ins handed the foreground to each other with `AllowSetForegroundWindow` and
`SetForegroundWindow`, as real applications do. Each round: stand-in B in front for a random
1.2–1.54 s (so the switch lands at a random point in a throttled frame), switch to stand-in A, then
two sequential no-op requests; samples where another app took the foreground were discarded (none
were). 30 rounds each, ms:

| Engine | Lease for A | First request after switch p50 / p95 / range | Second request p50 / max |
| ------ | ----------- | -------------------------------------------- | ------------------------ |
| 5.7    | held        | 133.1 / 311.9 / 5.6–321.9                    | 16.1 / 24.7              |
| 5.7    | none        | 125.2 / 305.9 / 3.2–328.9                    | 333.4 / 415.6            |
| 5.8    | held        | 156.0 / 327.4 / 7.2–329.1                    | 15.6 / 32.7              |
| 5.8    | none        | 169.6 / 297.8 / 17.6–303.4                   | 333.3 / 334.8            |

So the first request after the switch waits for the rest of the current throttled frame whether or
not a lease is held, as the source predicted; the lease makes every later request fast. A fixed
1.2 s delay first phase-locked the switch to the renewal reply (which returns on a frame boundary)
and gave a misleading 96–115 ms; the random delay fixed that. The real-switch steady-state cases
matched the stand-in tables above (5.7: 7.1–15.0 ms no-op p50 with the leaseholder in front).

Camera screenshot capture (`editor_viewport` / `high_resolution_screenshot`, 320×180, 4 settling
frames, fixture map), the reason hosts brought Unreal to the front:

| Editor state                                | 5.7 frame ms | 5.8 frame ms | Mean RGB (5.7)      |
| ------------------------------------------- | ------------ | ------------ | ------------------- |
| Behind, no lease                            | 2,076.8      | 2,078.6      | 99.5, 107.5, 118.7  |
| Behind, lease, client in front              | 107.7        | 169.5        | 99.5, 107.5, 118.7  |
| Behind, lease, client not in front          | 1,720.4      | 1,721.9      | 99.5, 107.5, 118.7  |
| Minimised, lease, client in front           | 125.8        | 102.5        | 99.5, 107.5, 118.7  |
| Minimised, no lease                         | 1,708.0      | 1,711.0      | 99.5, 107.5, 118.7  |
| Unreal focused (control, window activation) | 154.2        | 130.0        | 100.7, 108.6, 119.6 |

Every capture completed, including minimised without a lease: the capture never needed Unreal in
front, it was only throttled. The lease brings background captures to focused speed. Background
captures are identical to each other and about 1% darker than the focused one, consistent with the
editor's "Background Process" non-realtime viewport override (it follows `FApp::HasFocus`, not the
throttle), which the lease does not change; `RequestRealTimeFrames` during settling is a possible
follow-up. An earlier source-only prediction that a minimised editor would never capture was wrong.

Workbench: the built app, started with a throwaway `--user-data-dir` against each live editor,
held one lease within seconds. Its only top-level window belongs to the Electron main process
(`GetWindowThreadProcessId` = main PID on both runs), so `process.pid` is the right client.
Closing the window released the lease in 0.66 s on both engines. It was not the foreground
window, so the exemption correctly stayed off.

Harness findings: the fixture's own `UEShedFixtureEditor` module sets the throttle setting to false
at startup, overriding any config, so the fixture always runs with "Use Less CPU when in
Background" off. The copies patched that line out and set the copy's `DefaultEditorSettings.ini`
to true; the tracked fixture is unchanged. The new state report's `throttleWhenNotForeground`
exposed it.

## Phase 6 — Documentation

Contract document; Workbench behaviour and setting in `docs/showcase.md` and
`apps/workbench/README.md`; changesets for `@ue-shed/protocol` and `@ue-shed/engine`.

## Deviations from the brief

- Two library functions, not four: `UpdateForegroundLease` takes an `operation` union
  (`acquire | renew | release`) and `GetForegroundResponsivenessState` is separate. Results are
  discriminated by `status`; state results add `reported`.
- Releasing an unknown or ended lease returns `released` (idempotent); a lease named with another
  client returns `rejected` / `lease_mismatch`.
- The held handle already pins the process ID, so the creation-time check on renew (through a fresh
  handle) is defence in depth; the fake-platform test covers it.
- The state report adds `editorThrottling` (Unreal's own decision now) and `registered`.
- The Workbench preference is a main-process file, not renderer storage, so the lease never starts
  before a saved "off" is known.
- The engine service re-acquires after a lost lease or a restarted editor instead of failing; only
  the first acquire fails.

## Verification matrix

| Scope      | Evidence                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| Contract   | alignment test, fixtures, `contract:check`                                   |
| Unreal     | plugin automation on 5.7 and 5.8; predicate cost recorded                    |
| Engine     | TestClock lifecycle and failure tests                                        |
| Workbench  | supervisor and preference tests, component test, window owner check          |
| Live       | latency table and first-wake measurement on 5.7 and 5.8, attended, minimised |
| Repository | `pnpm run check:precommit`; `pnpm check:unreal` (5.7 fixture gate)           |

**Repository evidence (2026-10-09)**: `pnpm run check:precommit` passes. `pnpm test` passes
(299 files, 1,973 tests; 14 environment-gated files skipped). `pnpm check:unreal` passes on UE
5.7 (its fixture gate is 5.7-only by design). `pnpm check` (full gate) was not run: its UAsset,
release and adoption lanes are untouched by this plan.

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
