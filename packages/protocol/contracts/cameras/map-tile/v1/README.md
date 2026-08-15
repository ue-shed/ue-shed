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

`captureBackend` is an optional execution hint, not part of the portable plan. Its default
`scene_capture_tiles` behavior remains the v1 tile operation. The experimental
`viewport_high_resolution` value requires one complete zoom level of at most 64 tiles; Unreal
renders that level through the active Level Editor viewport's High Resolution Screenshot path and
then cuts the resulting image into the requested tiles.

The editor accepts no output path. It stages only below `Saved/UEShed/MapTileStaging`, reports every
tile outcome and map package dirty state, and restores transient state before returning. The host
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
