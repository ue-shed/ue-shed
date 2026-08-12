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

The editor accepts no output path. It stages only below `Saved/UEShed/MapTileStaging`, reports every
tile outcome and map package dirty state, and restores transient state before returning. The host
must validate staging containment, hash artifacts, and atomically publish only a manifest whose
state is `complete` and whose tile inventory is exhaustive. Partial and cancelled attempts remain
diagnostic evidence and are never discoverable as completed runs.

The v1 editor capability requires the expected map to already be open. A headless launcher may open
that map explicitly before connecting. Interactive hosts must refuse a map switch when dirty
packages could be discarded. Map-session switching/restoration is deliberately outside this Remote
Control payload rather than giving it hidden editor authority.

Change this contract in authority order: JSON Schema and fixtures, conformant Effect codecs,
UEShedCameras C++ producer with trusted UE 5.7 evidence, then consumers.
