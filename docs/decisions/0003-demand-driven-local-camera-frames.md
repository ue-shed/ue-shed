# 0003: Demand-driven local camera frames

## Status

Accepted for the first multi-camera vertical slice.

## Context

The camera idea needed an end-to-end load proof without making Workbench privileged or committing to
video encoding before measurements justified it. The slice also needed useful tuning and saturation
signals so a visually successful demo could not hide simulation stalls or unbounded buffering.

## Decision

- `UEShedCameras` is separately enabled and advertises control and BGRA8 pipe capabilities.
- Electron hosts the Windows named-pipe server. Unreal connects as a producer, so no listener means
  no recurring capture work.
- Each camera uses manual `CaptureScene()` calls and two asynchronous `FRHIGPUTextureReadback` slots.
- A global scheduler distinguishes focused and background cadence and limits captures per game tick.
- The producer writer and host snapshots are bounded and latest-frame-wins. Sequence gaps, staging
  drops, transport replacements, bytes, latency, and effective presentation rate are visible.
- The host decoder consumes a chunk queue in linear time and exposes payloads as zero-copy typed
  views. Workbench coalesces pending frames per camera before cross-process presentation.
- Workbench has an independent aggregate presentation-byte budget and coalesces per-camera display
  frames behind it. The current Canvas presenter reuses one RGBA allocation per visible camera;
  capture and pipe throughput remain measurable when display work is deliberately sparse.
- Camera sources may bind an observation target. The public `overview`/`actor_pov` control changes
  camera transforms without changing capture cadence or enabling automatic capture.
- Capture resolution is a validated 16:9 preset in the public schedule. A requested resize takes
  effect per camera only after both asynchronous readback slots are idle, so frame metadata and
  payload dimensions cannot straddle a render-target mutation.
- The language-neutral v1 frame header is fixed, little-endian, self-describing, and documented under
  `packages/protocol/contracts/cameras/v1`.
- `@ue-shed/cameras` owns transport decoding, lifecycle, control adaptation, and host metrics.
  Workbench owns only presentation state and renderer timing.
- The generic fixture commits a deterministic map with 32 analytical movers and 32 camera sources.
  The public active-count control defaults to eight at 320×180 BGRA8.

## Consequences

Raw local frames make capture/readback cost measurable without mixing codec behavior into the result.
At higher cadence structured-clone IPC and Canvas conversion remain measurable copies; display has a
separate byte budget so it cannot hide capture or pipe capacity. The measured development machine
reached roughly 1.0–1.05 GB/s over the pipe with large frames, while 32 cameras at 640×360 reached
roughly 567 captures/s before world-tick/capture-submission pressure dominated. These observations
can earn a shared-memory or shared-texture path later; they are not protocol limits. Remote feeds,
compression, durable evidence, adaptive automatic budgets, and arbitrary aspect ratios remain
separate extensions of the public identities and control model.
