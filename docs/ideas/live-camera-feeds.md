# Live Unreal camera feeds

> Status: local 32-camera load slice implemented and measured

## Ambition

Make a running Unreal world observable through many inexpensive, purposefully placed viewpoints.
Developers should be able to keep a play session running, scan several regions, focus on an actor or
place, correlate visual behavior with state and scenarios, and retain evidence without treating one
editor viewport as the only window into the simulation.

This is not merely a remote image panel. Camera feeds should compose with world locations, actor
state, scenario markers, capture history, and reusable review-camera definitions.

## North star

The world should become legible from outside the editor without observation materially distorting
what is being observed. Multiple low-resolution perspectives are often more useful than one
high-prestige broadcast stream.

## Principles

### Optimize the observation budget

Silhouette, motion, density, timing, and context matter before cinematic quality. Capture should be
demand-driven:

- one focused feed at a useful sparse cadence;
- a bounded number of slower thumbnails;
- no recurring capture work for inactive cameras;
- rates and resolution adapted to focus, visibility, and machine budget.

Avoid continuous `bCaptureEveryFrame` as the default. Explicit `CaptureScene()` calls give the
scheduler control.

### Separate control, pixels, and evidence

The planes have different lifecycles:

- **Control:** list cameras, activate/focus/disable, set rates, and query health through the ordinary
  control protocol.
- **Live pixels:** bounded binary frames with latest-frame-wins behavior.
- **Evidence:** selected images or clips plus camera, world-time, actor, scenario, and environment
  metadata.

Keeping them separate lets the live path stay disposable while promoted evidence remains durable.

### Begin with a simple same-machine binary bridge

The first Windows path should test an ordinary named-pipe byte stream before a native shared-memory
addon:

```text
SceneCapture
  -> asynchronous GPU texture readback
  -> raw BGRA frame
  -> named pipe
  -> host process
  -> VideoFrame/canvas presentation
```

At sparse thumbnail sizes, ordinary copies are likely cheaper than capture and GPU readback. Measure
before adding memory mapping or GPU texture sharing. A future remote or high-frame-rate path may earn
compression or WebRTC without redefining camera identity and scheduling.

### Frames are disposable and self-describing

A frame envelope carries protocol, producer/session/camera identity, sequence, world timestamp,
dimensions, row pitch, pixel format, color-space flags, payload length, and payload. Bounded buffers
drop or replace stale frames. Restarted sessions cannot masquerade as the previous producer.

### Treat GPU readback as the likely bottleneck

Use asynchronous texture readback and a bounded staging ring:

1. capture to a render target;
2. enqueue GPU readback;
3. continue running;
4. collect a completed slot later;
5. send only while the downstream budget has capacity;
6. drop work rather than blocking the world.

Instrument capture GPU time, readback latency, stage occupancy, drops, copy time, transport latency,
and presentation latency.

The first measured fixture disproved GPU readback as the universal first limit. On the development
machine, 32 cameras at 640×360 reached roughly 567 captures/s with zero readback drops while GPU 3D
utilization remained near 29%; `CaptureScene()` submission and world-tick pressure became limiting.
Large 1440p frames instead saturated the raw pipe/host path near 1.0–1.05 GB/s. These are machine and
scene measurements, not product constants.

UE 5.7's supported shared `ISceneRenderBuilder` path now batches all cameras due in one scheduler
tick and orders each asynchronous readback after its corresponding renderer. It removes a repeated
end-of-frame flush and builder execution per camera, but it did not increase the measured Observation
ceiling: each camera still creates and executes a separate scene renderer and render graph. Batch
size and submission time remain visible so a future linked-view or atlas experiment can be compared
against this baseline.

The cadence scheduler now retains deadline phase rather than rescheduling from the current tick. It
skips and counts missed intervals without issuing catch-up bursts. A 1/8/16/32-camera sweep at
640×360 and 30 FPS showed the world tick rate falling from roughly 409 to 260, 65.5, then 16.9
ticks/s. The first three envelopes met their requested aggregate cadence; 32 cameras delivered about
524 of 960 requested captures/s while explicitly counting the remainder as missed intervals. That
isolates serialized renderer/frame backpressure as the next investigation: the scheduler is asking
for the work, but Unreal cannot advance world frames quickly enough to issue it.

An Unreal Insights capture localized that backpressure. At 16 cameras, `FEngineLoop::Tick` averaged
15.2 ms and `GameThreadWaitForTask` averaged 13.4 ms. At 32 cameras they rose to 53.6 ms and 47.5 ms
respectively, so about 89% of the game-thread frame was spent at UE's frame-end render fence. The
corresponding GPU `WorldTick` averaged 49.0 ms. Render-thread evidence also showed one transient D3D12
committed-resource creation per capture at roughly 0.60 ms each. This explains why aggregate Task
Manager graphs looked underused: one serialized render dependency chain governed progress while
other CPU cores and GPU engines retained headroom.

Typed `full_pipeline`, `render_only`, and `schedule_only` experiment modes then separated the work.
At 32 cameras, 640×360, 30 FPS, and the Observation profile, schedule-only reached roughly 963
logical captures/s and render-only reached 942–949 renders/s. The original full path reached only
about 472 frames/s. UE 5.7 source documents `FRHIGPUTextureReadback` as reusable, but the plugin had
destroyed and recreated it after every frame. Retaining both per-camera staging objects, with
dimension-aware recreation after a resize, raised full delivery to about 788 frames/s (24.6 FPS per
camera), a 67% gain, with zero new readback resources and zero staging drops during the measured
window. This falsifies per-view scene rendering as the dominant fixture bottleneck and identifies
readback allocation/copy granularity as the next target.

A resolution sweep after reuse delivered about 884 frames/s at 320×180, 788 at 640×360, and 383 at
960×540. The largest case held near 794 MB/s and replaced frames between rendering and delivery,
showing the transition from per-copy readback pressure to raw local transport bandwidth. A shared
atlas remains valuable, but now for one reusable staging copy/map per batch rather than as a rescue
for an allegedly exhausted scene renderer.

A short controlled focus comparison at the 32-camera 640×360 envelope delivered about 718 frames/s
with Unreal foregrounded and 701 with Workbench foregrounded. Background throttling is therefore
measurable on this machine, but its roughly 2–3% effect does not explain the earlier twofold collapse.

Designers can choose a reversible Observation render profile that retains geometry, materials,
basic lighting, and dynamic shadows while disabling advanced and post-processing features. The
generic fixture gains only about 5.5% because it has no meaningful production post stack; projects
with volumetrics, reflections, grading, or post-process materials should expose a larger difference
through the same profile and metrics.

### Raw locally; compress for durability or distance

| Situation                    | Starting point                       |
| ---------------------------- | ------------------------------------ |
| Same-machine sparse feeds    | Raw BGRA over a named pipe           |
| Screenshots and history      | JPEG with metadata                   |
| Occasional remote frames     | JPEG over a binary network transport |
| Continuous focused video     | Encoded video/WebRTC if justified    |
| Proven local copy bottleneck | Shared memory or texture sharing     |

A useful hybrid uses raw frames for live display and encodes JPEG only when a user promotes a frame
into evidence.

### Compose with the rest of UE Shed

A map region can activate nearby cameras; actor selection can request a focused view; scenario and
actor timelines can reference a frame; a review-camera definition can be used live when appropriate.
Unreal owns world identity, time, capture, and runtime state. UE Shed owns observation layout,
selection, scheduling policy, and evidence navigation.

### Do not perturb the simulation silently

SceneCaptures, streaming changes, LOD changes, and visibility overrides cost resources and may alter
the observed world. Prefer naturally loaded regions. Any intervention must be explicit in live status
and retained evidence.

## Technical footholds to verify per supported engine version

| Capability             | Unreal or host surface                                 |
| ---------------------- | ------------------------------------------------------ |
| Manual capture         | `USceneCaptureComponent2D::CaptureScene()`             |
| Asynchronous readback  | `FRHIGPUTextureReadback` and render-graph copy support |
| Same-machine stream    | platform named pipes and Node `net`                    |
| Upgrade paths          | platform shared memory and TextureShare                |
| Durable image encoding | ImageWrapper, especially JPEG                          |
| Browser presentation   | `VideoFrame`/canvas with an explicit BGRA path         |

## Tracer bullet

1. One on-demand 320×180 scene capture in the generic fixture.
2. Asynchronous BGRA readback with visible cost metrics.
3. Versioned frames over a named pipe.
4. Host consumption with reconnect and bounded buffering.
5. Canvas presentation with verified color-space handling.
6. Control operations for camera listing, focus, cadence, and health.
7. Promote one frame into JPEG evidence with camera and world metadata.
8. Add a second low-rate thumbnail to prove scheduling controls cost.

## Anti-goals

- Permanent base64 images polled through JSON.
- Dozens of always-on captures without a budget.
- Queuing old frames to preserve a false idea of reliability.
- Native transport complexity before ordinary copies are measured.
- Silent streaming or visibility changes.
- Video tiles disconnected from map, actors, time, and evidence.
- One high-quality stream that prevents useful multi-camera awareness.

## Decisions to earn

Pipe ownership and discovery; frame schema; asynchronous staging; adaptive scheduling; renderer
transfer; color conventions; actor/scenario/evidence alignment; and the threshold for encoded video.
