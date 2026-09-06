# UEShedCameras

The editor module includes an opt-in [map freeze experiment](../../../docs/research/map-capture-freeze-2026-09-07.md).
`UEShed.MapCapture.Freeze time|scene` holds view timestamps and optionally existing primary ticks;
`UEShed.MapCapture.Resume` restores the session. This is diagnostic infrastructure, not a complete
simulation pause or a published capture policy. It requires no project-code integration.

Optional runtime camera observation capability. It adapts tagged stock `ASceneCapture2D` actors
saved in the map and can provision transient `AUEShedCameraSource` instances from external JSON
camera definitions. It manually schedules scene captures only while a named-pipe consumer is connected,
uses two asynchronous GPU readback slots per camera, and sends self-describing BGRA8 frames through
a bounded latest-frame-wins writer.

The runtime calls the former **authored cameras** and the latter **provisioned cameras**. Provisioned
cameras are destroyed when their session is cleared; authored cameras remain owned by the world.
Provisioned cameras can render either the open editor world or a PIE/game world. The play world is
authoritative while it exists; otherwise editor-world tick drives the same batched GPU-readback
pipeline. One process-wide pipe writer prevents coexisting world subsystems from competing for the
fixed transport. Editor provisioned actors are transient, hidden from the outliner, package-less,
and destroyed without modifying the level. Editor-live frames show current editor scene state but do
not imply gameplay simulation.

Repeated provisioning requests reconcile cameras in place while their ordered correlations remain
stable. A pose or lens edit keeps the transient actor and render target, replaces only that camera's
readback slots and frame identity, and schedules an immediate fresh capture. Topology changes still
replace the set atomically.

The separately enabled `UEShedCamerasEditor` module provides the durable Map Review capture boundary.
It accepts the versioned `ue-shed-review-capture` request over Remote Control, resolves one stable
actor path, realizes an approved pose with a transient `ASceneCapture2D`, captures once, and stages a
PNG only beneath `Saved/UEShed/ReviewStaging`. It reports package dirty state before and after the
operation; durable hashing, manifests, and publication remain host responsibilities.

The same editor-only boundary exposes `ue-shed-review-selection` v1. It reports exactly one selected
actor's path, label, world bounds, orientation, map, and optional active perspective viewport. It
does not generate framing policy or persist Review Sets; those remain headless host responsibilities.

Map Capture defaults to `lit_camera_tiles`: one transient CameraActor moves through the Lit editor
viewport, with vignette disabled, shared exposure, real frame warmup, and plugin-owned scene freezing.
The asynchronous Begin/Poll/End lifecycle retains ownership across batches and restores editor state
on completion or interruption, with a 120-second inactivity lease as a fallback. No game-code changes
are required. A rendering, unlocked editor viewport is required; subtle lighting joins can remain.
New plans use 16-pixel gutters and disable fog. Optional `capture.render.exposureEV100` fixes the
camera exposure range. Explicit `scene_capture_tiles` retains the older profiles and LOD scales;
`viewport_high_resolution` remains an experimental whole-level alternative. The CLI selects these
with `map-capture run --backend`; omitting the flag uses Lit camera tiles.

The legacy SceneCapture backend uses that same transient realization behind the sibling
`ue-shed-map-tile-capture` v1 operation. It creates transient orthographic `ASceneCapture2D`
instances for one bounded tile batch, derives `OrthoWidth` from tile pixels plus gutter and
world-units-per-pixel, crops the rendered gutter before PNG encoding, and stages only beneath
`Saved/UEShed/MapTileStaging`. Capture Z is independent of pyramid detail. The v1 capability keeps
Data Layers unchanged, requires the expected map to be open, waits for level streaming, and reports
map dirty state before and after every batch. Its scoped render policy can independently include or
exclude fog and volumetric fog and can apply one `LODDistanceFactor` per pyramid zoom; it never
mutates editor-global console variables.

All cameras due in a scheduler tick are submitted through one UE 5.7 `ISceneRenderBuilder` workload.
The builder orders each GPU readback after its camera renderer, while batch count, current/max size,
and submission time remain visible through status telemetry.

Cadence deadlines retain phase and advance to the first future interval when late, preserving
latest-frame-wins behavior without catch-up bursts. Scheduler tick count, due cameras, skipped
intervals, and average/maximum deadline lateness expose whether a requested envelope is producer-
limited or merely cadence-limited.

`UUEShedCameraLibrary` exposes versioned status and schedule configuration over Remote Control.
Focused/background cadence, per-tick capture budget, pause state, delivered bytes, staging drops,
transport replacements, and overview/actor-POV viewpoint mode are public rather than hidden tuning
constants. Active camera count and capture size are public through validated controls supporting up
to 32 sources and 16:9 presets from 160×90 through 2560×1440. Render targets resize only after their
readback slots drain.

The render profile is reversible. `full_fidelity` preserves each camera's authored engine show
flags. `observation` restores that baseline and then uses UE 5.7's advanced-feature disable path plus
post-processing, motion blur, bloom, and anti-aliasing disablement. Geometry, materials, basic
lighting, and dynamic shadows remain available for visual diagnosis.

The public schedule also selects `full_pipeline`, `render_only`, or `schedule_only` isolation.
Render-only performs scene rendering without GPU readback or transport; schedule-only exercises
cadence and fairness without issuing renderer work. Every configuration starts a new observable
measurement revision with elapsed time, scheduler ticks, scheduled/rendered/read-back/delivered
counts, skips, drops, replacements, bytes, and staging-resource allocations. The two texture
readbacks per camera persist across frames and are recreated only when their dimensions change.
