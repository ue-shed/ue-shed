# UEShedCameras

Optional runtime camera observation capability. It discovers explicit `AUEShedCameraSource` actors,
manually schedules scene captures only while a named-pipe consumer is connected, uses two
asynchronous GPU readback slots per camera, and sends self-describing BGRA8 frames through a bounded
latest-frame-wins writer.

The separately enabled `UEShedCamerasEditor` module provides the durable Map Review capture boundary.
It accepts the versioned `ue-shed-review-capture` request over Remote Control, resolves one stable
actor path, realizes an approved pose with a transient `ASceneCapture2D`, captures once, and stages a
PNG only beneath `Saved/UEShed/ReviewStaging`. It reports package dirty state before and after the
operation; durable hashing, manifests, and publication remain host responsibilities.

The same editor-only boundary exposes `ue-shed-review-selection` v1. It reports exactly one selected
actor's path, label, world bounds, orientation, map, and optional active perspective viewport. It
does not generate framing policy or persist Review Sets; those remain headless host responsibilities.

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
