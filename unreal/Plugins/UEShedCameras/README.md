# UEShedCameras

Optional runtime camera observation capability. It discovers explicit `AUEShedCameraSource` actors,
manually schedules scene captures only while a named-pipe consumer is connected, uses two
asynchronous GPU readback slots per camera, and sends self-describing BGRA8 frames through a bounded
latest-frame-wins writer.

`UUEShedCameraLibrary` exposes versioned status and schedule configuration over Remote Control.
Focused/background cadence, per-tick capture budget, pause state, delivered bytes, staging drops,
transport replacements, and overview/actor-POV viewpoint mode are public rather than hidden tuning
constants. Active camera count and capture size are public through validated controls supporting up
to 32 sources and 16:9 presets from 160×90 through 2560×1440. Render targets resize only after their
readback slots drain.
