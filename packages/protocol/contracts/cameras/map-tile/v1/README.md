# Map tile capture contract v1

These checked-in JSON Schemas are the language-neutral authority for generic top-down map capture.
They are a sibling to, and do not change, `ue-shed-review-capture` v1.

`plan.schema.json` describes an external Map Capture Plan. `capture-request.schema.json` and
`capture-response.schema.json` describe a bounded editor operation named
`ue-shed-map-tile-capture`. `manifest.schema.json` describes neutral host-published
`ue-shed-map-tile-pyramid` evidence. All are major 1, minor 0.

Rows progress from world max-X toward min-X. Columns progress from world min-Y toward max-Y. The
orientation is explicit and versioned. A level halves units-per-pixel and doubles rows and columns;
capture Z does not define detail. The editor renders `gutterPixels` beyond each edge at the same
units-per-pixel and crops back to `tilePixelSize` before PNG encoding. Consumers use clamp-to-edge
sampling inside each published tile.

`captureBackend` is an optional execution hint, not part of the portable plan. The default is
`lit_camera_tiles`, requiring `cameras.lit-map-tile-capture.v1` and an unlocked rendering editor
viewport. It accepts `full_fidelity` with natural LOD. `overviewBounds` supplies the complete run's
framing for shared exposure calibration; when omitted the first batch's extent is used. Optional
`capture.render.exposureEV100` pins the camera exposure range instead of calibrating automatically.

Call `BeginMapTileCapture(RequestJson)` to start a batch, then
`PollMapTileCapture(RunId, OperationId)` until `capture-operation.schema.json` reports `finished`.
The terminal `response` uses the existing capture-response schema. Polling renews a 120-second
inactivity lease. A run retains viewport, exposure, and scene-freeze ownership between batches;
call `EndMapTileCapture(RunId)` in a finalizer on success, failure, and cancellation. End returns
`{ "released": boolean }`; an unrelated run ID cannot release the owner. Only one batch runs at a
time, and a run's map and capture policy cannot change between batches.

Explicit `scene_capture_tiles` and `viewport_high_resolution` use the synchronous `CaptureMapTiles`
operation. The latter requires one complete zoom level of at most 64 tiles. The former retains
SceneCapture profiles and per-level LOD distance scales. Both reject manual exposure rather than
silently ignoring it. Synchronous `CaptureMapTiles` rejects the default Lit backend and directs
clients to the asynchronous lifecycle.

The editor accepts no output path. It stages only below `Saved/UEShed/MapTileStaging`, reports every
tile outcome and map package dirty state, and restores transient state when run ownership ends. The host
must validate staging containment, hash artifacts, and atomically publish only a manifest whose
state is `complete` and whose tile inventory is exhaustive. Partial and cancelled attempts remain
diagnostic evidence and are never discoverable as completed runs.

The `full_fidelity` render profile explicitly restores the active project's renderer features on
the tiled SceneCapture. `seam_stable` keeps project lighting and post processing while disabling
tile-local exposure, temporal accumulation, and screen-space lighting traces; it renders at 2x and
spatially downsamples to the declared tile size. `scene_capture_defaults` is the comparison
baseline: it leaves Unreal's SceneCapture renderer defaults unchanged while keeping the same tile
framing, gutter, warm-up, and publication path. These distinctions apply to `scene_capture_tiles`;
the experimental viewport backend does not use the transient SceneCapture renderer. `observation`
remains the reduced-effects profile.

The v1 editor capability requires the expected map to already be open. A headless launcher may open
that map explicitly before connecting. Interactive hosts must refuse a map switch when dirty
packages could be discarded. Map-session switching/restoration is deliberately outside this Remote
Control payload rather than giving it hidden editor authority.

Change this contract in authority order: JSON Schema and fixtures, conformant Effect codecs,
UEShedCameras C++ producer with trusted UE 5.7 evidence, then consumers.
