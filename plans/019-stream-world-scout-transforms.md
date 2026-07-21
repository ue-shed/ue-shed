# Plan 019: Stream actor transforms and render World Scout on Canvas

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP conditions"
> section occurs, stop and report—do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat aae1cd2..HEAD -- packages/protocol packages/observatory packages/observability unreal/Plugins/UEShedObservatory apps/workbench/src/main apps/workbench/src/renderer extensions/camera-review scripts/test-gates.mjs docs`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts
> against the live code before proceeding; on a semantic mismatch, treat it as a STOP condition.
>
> **Dirty-worktree warning**: when this plan was written, Plan 018 work was still uncommitted in
> several Workbench Map Review and camera-preview files. Do not begin this plan until Plan 018 is
> committed or otherwise resolved. `git diff --name-only` must not report any in-scope file before
> implementation begins.

## Status

- **Priority**: P1
- **Effort**: XL (several staged days)
- **Risk**: HIGH
- **Depends on**: `plans/018-pie-live-review-previews.md`
- **Category**: perf
- **Planned at**: commit `aae1cd2`, 2026-07-21

## Why this matters

Map Review's Live World Scout currently polls a complete JSON actor snapshot at 1–30 Hz (5 Hz by
default). Every poll walks up to 4,096 actors in Unreal, recalculates component bounds, serializes
all metadata and transforms, crosses Remote Control HTTP and Electron IPC, validates the whole
payload, and supplies new object identities to an SVG tree. A 30 Hz setting therefore asks the
system to repeat discovery work 30 times per second rather than merely moving circles.

After this plan, the full snapshot remains the discovery and recovery authority, while a separate
demand-driven, bounded binary stream carries only changed transforms. The public Observatory
package owns decoding, stream lifecycle, recovery, and metrics. Workbench remains a thin adapter.
The Map Review extension retains actor metadata and paints circles onto one Canvas at display
cadence, coalescing transport updates instead of rebuilding one DOM subtree per actor.

The target is a genuinely live map: 30 Hz by default, selectable through 60 Hz, with bounded
latest-state behavior, explicit gaps/reconnects, and no repeated bounds calculation on ordinary
transform-only samples.

## Current state

### Relevant implementation

- `unreal/Plugins/UEShedObservatory/Source/UEShedObservatoryEditor/Private/UEShedObservatoryLibrary.cpp`
  owns both snapshot collection and focus. `GetActorSnapshot` currently does all work synchronously:

    ```cpp
    // lines 74-100
    TArray<TSharedPtr<FJsonValue>> Actors;
    Actors.Reserve(256);
    constexpr int32 MaxActors = 4096;
    for (TActorIterator<AActor> It(World); It && Actors.Num() < MaxActors; ++It)
    {
        // filters omitted
        const FBox Box = Actor->GetComponentsBoundingBox(true, true);
        // constructs label, class, location, rotation, bounds JSON
        Actors.Add(MakeShared<FJsonValueObject>(Record));
    }
    ```

- UE 5.7 implements `AActor::GetComponentsBoundingBox` by iterating every primitive component and
  combining its cached bounds (`Engine/Source/Runtime/Engine/Private/Actor.cpp:2229-2242`). That is
  appropriate during discovery, but needlessly repeated for transform-only map animation.

- `apps/workbench/src/renderer/map-review-client.ts:64-74` schedules the entire snapshot request:

```ts
worldSnapshots: (refreshRate) =>
	Stream.fromEffectSchedule(
		Effect.catch(loadWorldSnapshot()),
		Schedule.spaced(`${1_000 / refreshRate} millis`)
	);
```

- `extensions/camera-review/src/world-scout.tsx:36` defaults to 5 Hz. Lines 53-73 rescan the new
  actor array for class counts, filtering, projection, and selection. The rendered map is an SVG;
  every projected point is a new object supplied to `<For>` and becomes a `<g><circle /></g>` pair.

- `packages/observatory/src/index.ts` currently combines schemas, Remote Control operations, and
  projection in one file. `ObservatoryShape` only exposes `snapshot` and `focus`; it has no scoped
  observation stream or transport health.

- `packages/cameras/src/index.ts:23-380` and
  `unreal/Plugins/UEShedCameras/Source/UEShedCameras/Private/UEShedCameraSubsystem.cpp:30-173`
  are the repository exemplars for a fixed-header named-pipe stream, incremental decoder, scoped
  Effect service, sliding buffers, a background writer, latest-value replacement, and transport
  metrics. Reuse their lifecycle and safety ideas; do not couple Observatory to `@ue-shed/cameras`.

- `docs/vision-and-architecture.md:262-264` says Remote Control polling is only the current foothold
  and requires a dedicated named-pipe hello/health proof before fuller Observatory work. Lines
  290-297 require bounded subscriptions, requested cadence, coalescing, actor lifecycle events, and
  explicit reconnect behavior.

### Required repository conventions

- The full actor catalog and its transform stream belong to `@ue-shed/observatory`, not Workbench.
  Deleting `apps/workbench` must leave the feed usable by another trusted host.
- Remote Control remains the low-rate control plane. The named pipe is a local data plane and never
  becomes durable Map Review evidence.
- Use Effect for socket/pipe acquisition, cleanup, cancellation, bounded queues, reconnects, typed
  failures, spans, and metrics. The incremental byte decoder, state application, hit testing, and
  projection are ordinary pure or explicitly benchmarked hot-path functions.
- Use Effect Schema for JSON control responses and UI-facing state unions. The binary format is
  language-neutral and documented under `packages/protocol/contracts/observatory/v1`.
- Never read UObjects from the writer thread. Actor enumeration and `GetActorTransform()` stay on
  the editor/game thread; the writer receives owned byte packets only.
- Preserve stable actor identity. Stream-local integer indices are compact aliases, never durable
  actor identity and never persisted into Review Sets.
- Buffers are bounded and latest-state-wins. Sequence gaps and replacements are expected and
  observable, never hidden by an unbounded queue.
- Canvas is a presentation optimization, not a domain authority. Search, filter, selection, focus,
  reconnect state, and accessible keyboard operation must remain functional.

## Target architecture

```text
Remote Control control plane
  StartActorObservation / StopActorObservation / GetActorSnapshot / GetObservationStatus
                 |
                 | returns catalog + per-process pipe + session/revision
                 v
UEShedObservatory tick collector -- latest packet only --> named pipe writer thread
                 |                                          |
                 | changed transforms                       | binary v1
                 v                                          v
      @ue-shed/observatory scoped feed + decoder + retained world state
                                      |
                                      | bounded/coalesced host event
                                      v
                       Workbench IPC adapter (no domain folding)
                                      |
                                      v
                     Map Review Canvas, one paint per animation frame
```

The v1 stream is Windows named-pipe transport because that is the currently proven local transport.
Non-Windows and older-plugin behavior must be an explicit `polling_fallback` capability state, not
a silent failure. Keep bounded snapshot polling as compatibility fallback, defaulting to 5 Hz and
hard-capped at 10 Hz; do not pretend it is the high-rate path.

### Binary protocol required by this plan

Document and implement a little-endian packet with a fixed 96-byte header and zero or more 48-byte
transform records. Receivers resynchronize on magic and cap allocation before reading payloads.

Header:

| Offset | Type    | Field                                                     |
| -----: | ------- | --------------------------------------------------------- |
|      0 | char[4] | `USOT` magic                                              |
|      4 | u16     | version, `1`                                              |
|      6 | u16     | header length, `96`                                       |
|      8 | u16     | record length, `48`                                       |
|     10 | u16     | flags; bit 0 is reset/catalog-invalidated                 |
|     12 | u32     | record count, at most 4,096                               |
|     16 | u32     | payload length, exactly `recordCount * 48`                |
|     20 | u32     | reserved, zero                                            |
|     24 | u64     | session-local packet sequence                             |
|     32 | f64     | Unreal world seconds at sampling                          |
|     40 | f64     | producer monotonic milliseconds at sampling               |
|     48 | u8[16]  | observation session ID                                    |
|     64 | u64     | catalog revision                                          |
|     72 | u32     | actors sampled                                            |
|     76 | u32     | actors changed in this packet                             |
|     80 | u32     | cumulative producer replacements                          |
|     84 | u32     | sampling duration in microseconds, saturated at `u32` max |
|     88 | u64     | reserved, zero                                            |

Record:

| Offset | Type | Field                                     |
| -----: | ---- | ----------------------------------------- |
|      0 | u32  | stream-local actor index from the catalog |
|      4 | u32  | flags; reserved and zero in v1            |
|      8 | f64  | world X                                   |
|     16 | f64  | world Y                                   |
|     24 | f64  | world Z                                   |
|     32 | f32  | roll degrees                              |
|     36 | f32  | pitch degrees                             |
|     40 | f32  | yaw degrees                               |
|     44 | u32  | reserved, zero                            |

An empty non-reset packet is allowed as heartbeat/health. A reset packet invalidates its catalog
revision; the host must retain the last visible sample as stale, reacquire a complete catalog over
Remote Control, then resume. Never apply a record whose session ID, revision, or actor index does
not match the retained catalog.

## Commands you will need

| Purpose                  | Command                                                                                             | Expected on success                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Focused package tests    | `pnpm test -- packages/observatory/src extensions/camera-review/src/world-scout.component.test.tsx` | exit 0, all selected tests pass                                |
| Component tests          | `pnpm test:components`                                                                              | exit 0                                                         |
| TypeScript types         | `pnpm typecheck`                                                                                    | exit 0, no errors                                              |
| Architecture             | `pnpm effect:architecture && pnpm test:architecture`                                                | exit 0                                                         |
| Unreal compile           | `pnpm fixture:build`                                                                                | exit 0; `UEShedFixtureEditor` builds against discovered UE 5.7 |
| Portable repository gate | `pnpm check`                                                                                        | exit 0                                                         |
| Real Unreal gates        | `pnpm check:unreal`                                                                                 | exit 0 when required environment is configured                 |
| Workbench journey        | `pnpm test:e2e:workbench`                                                                           | exit 0                                                         |

Add `pnpm benchmark:observatory` as part of this plan. It must run the repeatable synthetic decoder,
state-application, and Canvas browser scenarios described below and print actor count, change ratio,
packets/s, bytes/s, p50/p95 decode+apply time, p50/p95 paint time, sequence gaps, and replacements.

## Suggested executor toolkit

- Use the `effect` skill when designing the scoped feed, stream, layers, cancellation, and tests.
- Use the `quality-code` skill for the TypeScript public contracts and real local-pipe tests.
- Consult UE 5.7 source under `C:\Program Files\Epic Games\UE_5.7\Engine\Source` before selecting
  editor tick, world lifecycle, actor-added, or actor-deleted delegates. Do not guess those APIs.
- Use `docs/decisions/0003-demand-driven-local-camera-frames.md` and the camera feed code only as
  behavioral exemplars. Observatory must have its own protocol, types, lifecycle, and metrics.

## Scope

**In scope** (the only files/directories to modify):

- `package.json` — add the Observatory benchmark command.
- `scripts/test-gates.mjs` — register the real-Unreal Observatory gate.
- `packages/protocol/contracts/observatory/v1/` — new binary contract documentation and fixtures.
- `packages/observatory/package.json`
- `packages/observatory/README.md`
- `packages/observatory/src/index.ts`
- `packages/observatory/src/index.test.ts`
- `packages/observatory/src/actor-feed.ts` (new)
- `packages/observatory/src/actor-feed.test.ts` (new)
- `packages/observatory/src/actor-stream-protocol.ts` (new)
- `packages/observatory/src/actor-stream-protocol.test.ts` (new)
- `packages/observatory/src/world-observation.ts` (new)
- `packages/observatory/src/world-observation.test.ts` (new)
- `packages/observatory/src/real-unreal.integration.test.ts` (new)
- `packages/observatory/scripts/benchmark.ts` (new)
- `packages/observability/src/index.ts`
- `packages/observability/src/index.test.ts`
- `unreal/Plugins/UEShedObservatory/README.md`
- `unreal/Plugins/UEShedObservatory/UEShedObservatory.uplugin`
- `unreal/Plugins/UEShedObservatory/Source/UEShedObservatoryEditor/UEShedObservatoryEditor.Build.cs`
- `unreal/Plugins/UEShedObservatory/Source/UEShedObservatoryEditor/Public/UEShedObservatoryLibrary.h`
- `unreal/Plugins/UEShedObservatory/Source/UEShedObservatoryEditor/Private/UEShedObservatoryLibrary.cpp`
- `unreal/Plugins/UEShedObservatory/Source/UEShedObservatoryEditor/Private/UEShedObservatoryEditorModule.cpp`
- `unreal/Plugins/UEShedObservatory/Source/UEShedObservatoryEditor/Private/UEShedObservatoryStream.h` (new)
- `unreal/Plugins/UEShedObservatory/Source/UEShedObservatoryEditor/Private/UEShedObservatoryStream.cpp` (new)
- `apps/workbench/src/main/workbench-live.ts`
- `apps/workbench/src/main/ipc-contracts.ts`
- `apps/workbench/src/main/ipc-contracts.test.ts`
- `apps/workbench/src/main/ipc/map-review.ts`
- `apps/workbench/src/main/ipc/register.test.ts`
- `apps/workbench/src/main/preload.ts`
- `apps/workbench/src/main/services/map-review.ts`
- `apps/workbench/src/main/services/map-review.test.ts`
- `apps/workbench/src/renderer/global.d.ts`
- `apps/workbench/src/renderer/map-review-client.ts`
- `apps/workbench/e2e/map-review-authoring.e2e.ts`
- `apps/workbench/e2e/observatory-performance.e2e.ts` (new)
- `extensions/camera-review/README.md`
- `extensions/camera-review/src/map-review-client.ts`
- `extensions/camera-review/src/world-scout.tsx`
- `extensions/camera-review/src/world-scout-canvas.ts` (new)
- `extensions/camera-review/src/world-scout-canvas.test.ts` (new)
- `extensions/camera-review/src/world-scout.component.test.tsx`
- `docs/decisions/0006-bounded-observatory-transform-stream.md` (new)
- `docs/products/map-review.md`
- `docs/vision-and-architecture.md`
- `plans/README.md` — status only when execution is complete.

**Out of scope**:

- `UEShedCameras`, camera BGRA transport, capture cadence, and live Review View previews. They are a
  separate data plane and are under active Plan 018 work.
- Durable Review Set, Review View, Approved Pose, or Capture Run schemas.
- Arbitrary UObject property observation, time-indexed history, replay, recording, remote transport,
  shared memory, or a universal actor/camera event protocol.
- Changing actor identity away from current object paths. Stream indices are session-local aliases.
- Adding a permanent tool actor to user maps.
- Generating or committing a 4,096-actor Unreal map merely to satisfy a benchmark. Use the existing
  32-mover real fixture plus synthetic 4,096-record host/browser benchmarks.
- Removing the bounded snapshot fallback; it is required for old plugins, unsupported platforms,
  and recovery.

## Git workflow

- Branch: `perf/019-stream-world-scout-transforms`
- Commit after each coherent gate below. Match the repository's conventional style, for example
  `feat(observatory): stream bounded actor transforms` and
  `perf(map-review): paint world scout on canvas`.
- Do not push or open a PR unless the operator explicitly asks.
- Preserve unrelated user changes. Plan 018 must be resolved first; never overwrite its work.

## Steps

### Step 1: Characterize the current path and lock the public state semantics

1. Add tests around the current `WorldActorSnapshot`, projection, selection, stale retention, and
   reconnect behavior before changing transport.
2. Introduce the public types in `world-observation.ts`: - `WorldActorCatalogEntry`: current static actor fields plus `streamIndex`. - `WorldActorCatalog`: session ID, catalog revision, map/world identity, captured time, entries. - `WorldTransform`: location and rotation only. - `WorldTransformBatch`: session, revision, sequence, sample time, changed indexed transforms,
   producer counters. - `WorldObservationState`: discriminated `connecting | live | stale | polling_fallback |
unavailable`, retaining the last valid catalog/transforms where applicable. - `WorldObservationEvent`: catalog, transforms, reset, unavailable.

3. Implement and test pure state transitions. Reject wrong-session, wrong-revision, out-of-range,
   duplicate, and regressing-sequence batches. A gap marks health degraded but applies the newest
   valid state.
4. Keep `ObservedActor` and `WorldActorSnapshot` as compatibility/discovery models. Provide one pure
   function that materializes an `ObservedActor` for selection/authoring from catalog metadata plus
   its latest transform; do not materialize all actors on every batch.

**Verify**:
`pnpm test -- packages/observatory/src/index.test.ts packages/observatory/src/world-observation.test.ts`
→ all tests pass, including explicit stale/reset/gap cases.

### Step 2: Define and prove the binary v1 contract

1. Write `packages/protocol/contracts/observatory/v1/README.md` with the exact header and record
   tables above, limits, little-endian rule, reset semantics, sequence behavior, and recovery.
2. Add binary fixtures for: one valid two-record packet, fragmented concatenated packets, heartbeat,
   reset, bad magic followed by valid resynchronization, unsupported version, oversized record
   count/payload, mismatched payload length, and truncated input.
3. Implement an incremental chunk-queue decoder in `actor-stream-protocol.ts`. Match the camera
   decoder's linear chunk consumption and bounded allocation, but do not import camera code.
4. Cap record count at 4,096, header at 96 bytes, record size at 48 bytes, payload at 196,608 bytes,
   and total buffered undecoded bytes at a documented bounded value. Malformed input increments a
   counter and resynchronizes; it must not crash or allocate from an untrusted length.
5. Add a matching TypeScript encoder used only by tests/benchmarks so fixture creation and round-trip
   properties do not duplicate offsets by hand.

**Verify**:
`pnpm test -- packages/observatory/src/actor-stream-protocol.test.ts`
→ all protocol, fragmentation, resynchronization, and limit tests pass.

### Step 3: Build a demand-driven Unreal Observatory producer

1. Replace the default module with a small owned stream service created at module startup and
   destroyed at shutdown. Implement editor ticking using the UE 5.7-supported API found in engine
   source (`FTickableEditorObject` is available); document why the selected lifecycle is valid for
   both editor and PIE observed worlds.
2. Extend the Remote Control library with:
    - `StartActorObservation(RequestJson, ResultJson)`: validate requested integer cadence 1–60 Hz,
      build a catalog, create a new session/revision, return catalog, actual cadence, process-specific
      pipe name, limits, and capability status, then enable sampling.
    - `StopActorObservation(ResultJson)`: idempotently stop recurring sampling/writer work.
    - `GetActorObservationStatus(ResultJson)`: return bounded counters and health without actor arrays.
3. Use a process-specific pipe name such as `\\.\pipe\ue-shed-observatory-v1-<pid>` to avoid two
   editor processes contending for one global pipe. The producer retries connection with bounded
   sleep, like the camera writer. No listener means no packet queue growth.
4. At catalog creation, perform the existing actor filtering and bounds calculation exactly once,
   assign dense stream indices, retain `TWeakObjectPtr<AActor>`, and snapshot the last transform.
5. At each due sample, iterate retained weak pointers and call only validity/transform accessors.
   Compare with the last sent transform using documented tolerances; encode changed records only.
   Sampling and byte creation happen on the editor thread. The writer thread only sees owned bytes.
6. The writer holds at most one latest packet. Replacing it increments the producer replacement
   counter. Never enqueue one packet per actor.
7. Use verified actor/world lifecycle delegates or a bounded low-rate reconciliation to detect
   additions, removals, map changes, and editor/PIE transitions. Any membership or world-authority
   change increments/invalidates the catalog and emits reset; do not smuggle strings into transform
   packets. Actor scale changes may invalidate that actor's catalog bounds. Component animation is
   not a reason to recalculate bounds at transform cadence.
8. Expose: samples attempted/delivered, actors sampled/changed, catalog rebuilds, bounds
   calculations, sampling average/max, bytes, replacements, connection state, reset count, and
   effective cadence. Do not put actor paths in metric labels.
9. On non-Windows platforms return `not_supported` with recovery/fallback guidance. Do not leave a
   nominally live service that emits nothing.

**Verify**:
`pnpm fixture:build`
→ the UE 5.7 fixture editor target compiles with no warnings promoted to errors.

### Step 4: Own feed lifecycle and recovery in `@ue-shed/observatory`

1. Implement `actorFeedLayer(options)` in `actor-feed.ts`, modeled structurally on `cameraFeedLayer`:
   scoped `node:net` server ownership, tracked sockets, incremental decoder, bounded sliding
   publication, latest batch/state access, and guaranteed close/cancellation cleanup.
2. Define typed errors for listen, decode-limit, control negotiation, session mismatch, and recovery
   exhaustion. Acquisition failure must not become an empty stream.
3. Add `Observatory.observe(endpoint, options)` returning an Effect `Stream` of public observation
   state/events. Its scoped flow is: prepare listener → call `StartActorObservation` → validate and
   install catalog → consume matching packets → reacquire on reset/reconnect → always call
   `StopActorObservation` during finalization when reachable.
4. Do not make callers compose raw Remote Control and pipe services. Keep `snapshot` and `focus` for
   CLI/compatibility. If stream negotiation reports unsupported, enter explicit bounded
   `polling_fallback` using the old snapshot path at no more than 10 Hz.
5. Use a sliding/latest-state buffer. A slow subscriber receives the newest retained state plus gap
   counters; it never causes producer backpressure or unbounded memory.
6. Add real local named-pipe tests for ownership collision, chunk fragmentation, slow subscriber,
   replacement, cancellation, server/socket cleanup, reconnect with new session, reset/catalog
   recovery, malformed data, and unsupported fallback.

**Verify**:
`pnpm test -- packages/observatory/src/actor-feed.test.ts packages/observatory/src/world-observation.test.ts`
→ all tests pass and no test process retains an open pipe/server after scope close.

### Step 5: Adapt the stream through Workbench without rebuilding snapshots

1. Provide the Observatory feed layer once in `workbench-live.ts`. Acquiring Workbench must bind the
   pipe server but must not start Unreal or recurring actor sampling; sampling begins only when Map
   Review subscribes and stops when its scope closes.
2. Change `WorkbenchMapReview` to expose a scoped world-observation stream/subscription rather than
   polling `worldSnapshot` for the live path. Preserve `worldSnapshot` as connect/recovery fallback.
3. Add one bounded main-to-renderer event channel for catalog/reset/status and changed transform
   batches. Follow the camera IPC adapter's registration/unsubscription pattern, but do not send
   full actor arrays on each event.
4. Coalesce pending transform batches by actor index before crossing Electron IPC, with a maximum
   presentation cadence of 60 Hz and an explicit byte/record cap. Record main-side replacements.
5. Update preload/global declarations and the renderer client once. Renderer code adapts the
   callback to an Effect `Stream` with sliding strategy and cleanup tied to the Solid owner.
6. Update `MapReviewClientShape`: replace `worldSnapshots(refreshRate)` with
   `worldObservations(refreshRate)`. The refresh value is the requested producer sample cadence;
   the Canvas paint loop remains display-driven. Update all test clients explicitly.
7. Keep the Unreal operation coordinator behavior: exclusive capture/preview operations may pause
   or coalesce observation, but observation must resume with a fresh catalog/session and a visible
   stale/reconnecting state.

**Verify**:
`pnpm test -- apps/workbench/src/main/services/map-review.test.ts apps/workbench/src/main/ipc-contracts.test.ts apps/workbench/src/main/ipc/register.test.ts`
→ tests pass, including subscribe/unsubscribe, capture pause/resume, coalescing, and cleanup.

### Step 6: Replace the actor SVG with a retained Canvas presenter

1. Put pure Canvas math and hit testing in `world-scout-canvas.ts`; keep component orchestration in
   `world-scout.tsx`.
2. Retain catalog metadata by stream index and latest transforms in dense storage. Applying a batch
   updates only changed indices. Do not allocate `ObservedActor`, projected point objects, or DOM
   nodes for every actor on every sample.
3. Use one `<canvas>` sized for device pixel ratio. Schedule at most one
   `requestAnimationFrame`; multiple arriving batches before paint collapse into the newest state.
   Reuse scratch arrays/typed buffers on the measured hot path and document this adapter boundary.
4. Draw visible actors in one pass with class colors, selected emphasis, and the existing
   aspect-preserving top-down projection. Choose and test a stable viewport policy with hysteresis so
   a moving outlier does not make all circles visibly pulse. Filters affect drawing and hit testing.
5. Implement pointer hit testing against the latest projected coordinates. A linear scan of at most
   4,096 points on pointer activation is acceptable; do not build a spatial index without benchmark
   evidence.
6. Preserve accessibility without thousands of focusable DOM circles: the Canvas is one focusable
   application control with an accessible label/status, arrow keys move among nearest/next visible
   actors, Enter selects, Escape clears/stops follow, and an `aria-live` summary announces selected
   actor label/class/coordinates. Existing inspector buttons remain ordinary DOM controls.
7. Preserve search, class counts, filters, selection across transform updates, Go to Actor, Follow
   Actor, stale last sample, reconnecting copy, and explicit fallback status.
8. Change the UI default to 30 Hz and permitted stream range to 1–60 Hz. When in
   `polling_fallback`, visibly cap and report the actual fallback cadence rather than offering 60 Hz.

**Verify**:
`pnpm test:components`
→ all component tests pass, including Canvas pointer selection, keyboard selection, filtering,
stable selection across 100 transform batches, one scheduled paint for burst updates, stale state,
cleanup, and polling fallback.

### Step 7: Add metrics and repeatable performance evidence

1. Add bounded Observatory metrics through `@ue-shed/observability`: catalog collection duration,
   bounds calculations, actors sampled/changed, packets/bytes, sequence gaps, producer/receiver/IPC
   replacements, decode/apply duration, paint duration, and effective sample/presentation cadence.
2. Add `packages/observatory/scripts/benchmark.ts` with deterministic synthetic catalogs/batches for
   32, 1,000, and 4,096 actors at 10%, 50%, and 100% change ratios. It must exercise the real encoder,
   decoder, and retained-state application without sockets and report distributions.
3. Add the Playwright performance scenario using the production Canvas presenter. Feed deterministic
   batches for 10 seconds, verify only one Canvas is used, verify bounded pending work, and report
   paint timing. Keep it out of ordinary correctness CI if timing is too machine-sensitive, but make
   it runnable through `pnpm benchmark:observatory`.
4. Use the following acceptance budgets on the development reference machine; record actual results
   in ADR 0006:
    - 1,000 actors, 50% moving, 60 producer batches/s: decoder+apply p95 ≤ 4 ms and Canvas paint
      p95 ≤ 8 ms.
    - 4,096 actors, 100% moving, 60 producer batches/s: decoder+apply p95 ≤ 8 ms and Canvas paint
      p95 ≤ 16.7 ms.
    - Pending host, IPC, and renderer queues remain at their declared fixed capacities; memory does
      not grow with benchmark duration.
    - No catalog/bounds calculation occurs while applying transform-only synthetic batches.
5. Timing budgets are a local acceptance gate, not a portable CI assertion. Correctness CI asserts
   bounded queue sizes, coalescing counts, one paint per animation frame, and no full-state rebuild.

**Verify**:
`pnpm benchmark:observatory`
→ exits 0, prints all required scenarios/metrics, and meets the reference budgets. If a budget is
missed, STOP and attach results; do not hide the miss by lowering actor counts or cadence.

### Step 8: Prove the real Unreal lifecycle and compatibility path

1. Add `real-unreal.integration.test.ts` and its gate entry. Against the existing 32-mover fixture
   in PIE, prove negotiation, catalog identity, at least two changed-transform packets, monotonic
   sequence, matching session/revision, focus using retained actor identity, and scoped stop.
2. Assert through status that bounds calculations stop increasing during a transform-only sampling
   window while actor sample/packet counters increase. Assert buffers/counters expose any drops.
3. Prove map/PIE transition emits reset and the host reacquires a catalog without displaying mixed
   sessions. Prove stopping PIE or closing the editor yields stale/unavailable rather than clearing
   the last sample or hanging.
4. Prove an old/unsupported Observatory plugin uses the explicit polling fallback and continues to
   support selection/focus.
5. Update the Workbench E2E journey to select a moving circle from Canvas and verify inspector/focus
   behavior; do not use coordinate clicks without first deriving the point from deterministic
   fixture state or a test seam.

**Verify**:
`pnpm fixture:build && pnpm test -- packages/observatory/src/real-unreal.integration.test.ts`
→ build succeeds; with the documented Unreal environment configured, the integration gate runs and
passes rather than silently skipping.

### Step 9: Record the decision and run the complete gates

1. Add ADR 0006 documenting why discovery/catalog and transform streaming are separate, the v1
   protocol, demand-driven lifecycle, bounded latest-state semantics, Canvas choice, accessibility
   tradeoff, polling fallback, measured budgets/results, Windows limitation, and deferred work.
2. Update product/architecture docs so they no longer describe repeated full snapshots as the live
   path. Keep full snapshots as recovery and CLI discovery. Do not claim time-indexed Observatory,
   arbitrary property streams, or cross-platform transport.
3. Update both Observatory READMEs and Camera Review README with public usage, capability states,
   cadence meaning, limits, health, and cleanup expectations.
4. Run all gates and inspect `git diff --check` plus scope.

**Verify**:

```powershell
pnpm check
pnpm fixture:build
pnpm test:e2e:workbench
git diff --check
git status --short
```

→ all commands exit 0; status contains only the in-scope files listed above.

## Test plan

- Protocol tests: fragmented/coalesced input, resynchronization, malformed lengths, unsupported
  versions, maximum packet, heartbeat, reset, and allocation caps.
- Pure state tests: session/revision changes, gaps, stale retention, indexed updates, actor selection
  materialization, filter/projection math, and no metadata rebuild on transform batches.
- Effect feed tests using real local named pipes: acquisition, collision, slow consumers, bounded
  replacement, reconnect, cancellation, finalization, and unsupported fallback.
- Unreal integration: real catalog, changing fixture movers, bounds counter stability, reset on world
  transition, and clean stop.
- Workbench service/IPC tests: one subscription, coalescing, scoped unsubscribe, capture pause/resume,
  last-state retention, and no complete actor array per transform event.
- Component tests: Canvas drawing semantics, pointer/keyboard selection, search/filter, class colors,
  inspector/focus/follow, stale/reconnect/fallback, resize/DPR, and animation-frame coalescing.
- Performance evidence: deterministic decoder/state benchmark and real production Canvas browser
  benchmark at the budgets in Step 7.
- Structural patterns: use `packages/cameras/src/index.test.ts` for real local-pipe lifecycle tests,
  `extensions/camera-review/src/world-scout.component.test.tsx` for UI behavior, and
  `apps/workbench/src/main/services/camera-presentation.test.ts` for coalesced presentation cleanup.

## Done criteria

- [ ] `GetActorSnapshot` is no longer invoked once per high-rate map update on a stream-capable
      plugin; it is used for initial discovery, fallback, and recovery only.
- [ ] Transform packets contain only indexed changed transforms and the fixed v1 header/records.
- [ ] Unreal calculates actor bounds during catalog creation/invalidation, not ordinary transform
      sampling; a real-Unreal test proves the counter remains stable.
- [ ] Producer, host, IPC, and renderer queues are bounded and expose replacement/gap metrics.
- [ ] Map Review defaults to a requested 30 Hz and supports 1–60 Hz on the stream path.
- [ ] World Scout uses exactly one Canvas for actor points and does not create one SVG/DOM node per
      actor.
- [ ] Incoming bursts schedule at most one animation-frame paint and selection survives updates.
- [ ] Pointer and keyboard users can select actors and invoke Go to Actor / Follow Actor.
- [ ] Reset, reconnect, old plugin, unsupported platform, and capture-coordination behavior remain
      explicit and tested.
- [ ] `pnpm benchmark:observatory` meets and records the Step 7 reference budgets.
- [ ] `pnpm check`, `pnpm fixture:build`, and `pnpm test:e2e:workbench` exit 0.
- [ ] `git diff --check` exits 0 and no out-of-scope file is modified.
- [ ] ADR 0006 and product/README documentation match shipped behavior without overclaiming.
- [ ] Plan 019's row in `plans/README.md` is updated when execution completes.

## STOP conditions

Stop and report back instead of improvising if:

- Plan 018 is not committed/resolved or any in-scope file has unrelated uncommitted changes.
- Current public Map Review/Observatory contracts differ materially from the excerpts above after
  Plan 018 lands; update this plan before implementation.
- UE 5.7 source does not provide a lifecycle/delegate combination that safely observes both editor
  and PIE worlds without reading UObjects off-thread.
- The proposed fixed record cannot preserve the current position/rotation precision required by the
  fixture or large-world coordinates. Propose a protocol revision before changing offsets.
- A correct implementation requires putting labels, paths, or variable-sized data into the hot
  transform packet. Revisit catalog invalidation instead.
- Actor membership/world changes cannot be detected without a recurring full metadata/bounds scan at
  transform cadence.
- Effect architecture checks would require a directory-wide exemption or unmanaged long-lived
  runtime exit. Refactor the adapter boundary; do not raise an exception baseline casually.
- Accessibility cannot be retained with the Canvas interaction model described above. Present an
  alternative retained renderer before deleting the SVG controls.
- Any Step 7 reference budget is missed after one evidence-based optimization pass. Report the
  profile and decide whether to revise the protocol, renderer, or acceptance target explicitly.
- A verification command fails twice after a reasonable scoped correction.
- The change appears to require modifying durable review schemas, camera transport, or other files
  listed as out of scope.

## Maintenance notes

- The catalog index is session-local. Never persist it or compare it across reconnects; durable
  identity remains `ActorId`/object path until a later identity decision changes that contract.
- Any future selected-property observation should be a versioned domain extension, not appended to
  v1 transform records opportunistically.
- Sequence gaps are normal under latest-state-wins delivery. Reviewers should reject code that turns
  the feed into a lossless/unbounded event log.
- Canvas paint rate and producer sample rate are deliberately independent. A 60 Hz monitor may paint
  the latest 30 Hz state; a 30 Hz renderer may coalesce a 60 Hz producer. Metrics must distinguish
  them.
- Bounds can become stale when component geometry changes without actor transform/membership change.
  V1 accepts catalog-time bounds plus invalidation on known structural/scale changes. A future
  bounds-delta mechanism requires its own measured need and explicit contract.
- Multiple local editors need endpoint/session-specific feed ownership. The process-specific pipe
  name prevents collision but does not solve future multi-editor arbitration by itself.
- The Windows pipe is a proven first transport, not the public semantic contract. Keep decoding and
  observation events transport-neutral enough for a later cross-platform adapter.
