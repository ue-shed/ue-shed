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
