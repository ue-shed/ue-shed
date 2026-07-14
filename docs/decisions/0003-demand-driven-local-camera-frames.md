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
- Due cameras are manually assembled into one UE 5.7 `ISceneRenderBuilder` workload per scheduler
  tick, with a readback command ordered after each camera renderer. Each camera retains two
  asynchronous `FRHIGPUTextureReadback` slots.
- A global scheduler distinguishes focused and background cadence and limits captures per game tick.
- Scheduler deadlines retain their original phase. Late cameras advance to the first future deadline,
  count skipped intervals, and never burst multiple captures in one tick. Due count, scheduler ticks,
  and average/maximum deadline lateness are public status metrics.
- The producer writer and host snapshots are bounded and latest-frame-wins. Sequence gaps, staging
  drops, transport replacements, bytes, latency, and effective presentation rate are visible.
- Capture batch count, current/max batch size, and game-thread batch-submission time are public
  status metrics so renderer experiments can distinguish scheduling overhead from render cost.
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
- Capture rendering has explicit `full_fidelity` and `observation` profiles. Every camera's authored
  show flags are retained as the restoration authority. Observation mode uses UE's supported
  advanced-feature disable path and turns off the post-processing master flag, motion blur, bloom,
  and anti-aliasing without mutating the authored camera definition.
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
can earn a shared-memory or shared-texture path later; they are not protocol limits. In the minimal
fixture, Observation mode increased 32-camera capture throughput by roughly 5.5% and reduced measured
GPU 3D utilization from about 30% to 27%; production post stacks should be measured independently.
Replacing one immediate builder per camera with one shared builder per tick did not materially raise
the Observation-profile ceiling in this minimal fixture (roughly 530 captures/s after batching versus
roughly 539 captures/s in the earlier run). It removes redundant end-of-frame flushes and exposes
submission cost, but UE still executes a separate renderer and render graph for every camera.
Phase-preserving scheduling confirmed that cadence drift was not the 32-camera limit. At 640×360 and
30 FPS per camera, the measured world tick rate fell from about 409 ticks/s with one active camera to
260 with eight, 65.5 with sixteen, and 16.9 with thirty-two. One through sixteen cameras reached
their requested aggregate cadence; thirty-two reached roughly 524 of 960 requested captures/s and
explicitly skipped the remaining intervals. Unreal CPU consumption also fell slightly under the
largest load, supporting serialized render backpressure rather than scheduler starvation or total
CPU saturation. Unreal Insights confirmed the dependency: at thirty-two cameras the game thread
spent about 47.5 ms of a 53.6 ms tick in `GameThreadWaitForTask`, waiting at UE's N-1 render-thread
frame fence. GPU `WorldTick` averaged 49.0 ms, while the 32 per-camera GPU `SceneRender` scopes
averaged 1.54 ms apiece. Resource setup also created a committed D3D12 resource per capture at about
0.60 ms on the render thread. Pipeline-isolation modes subsequently showed that render-only already
reached about 942–949 of 960 requested renders/s. The critical resource creation came from replacing
each `FRHIGPUTextureReadback` after use despite UE's supported reusable staging texture. Retaining two
dimension-aware staging objects per camera raised 640×360 full delivery from about 472 to 788
frames/s. Consequently, more producer threads would only deepen a bounded queue; the next scalable
step is one atlas readback per due-camera batch, preserving bounded latest-frame-wins semantics while
amortizing copy, transition, fence, map, and submission overhead.
Remote feeds,
compression, durable evidence, adaptive automatic budgets, and arbitrary aspect ratios remain
separate extensions of the public identities and control model.
