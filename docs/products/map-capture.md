# Map capture product

## Product promise

UE Shed Map Capture turns a configured Unreal world into a deterministic, multiresolution
orthographic tile pyramid without saving capture state into the map. Plans, attempts, and immutable
published runs remain usable from `@ue-shed/cameras` and the CLI without Workbench.

Map Capture is adjacent to Map Review, not another meaning for Review's `CaptureProfile`. It reuses
the editor's transient scene-capture realization, one-shot PNG staging, expected-map and dirty-state
checks, typed failures, hashing, and atomic publication. The existing perspective
`ue-shed-review-capture` v1 surface does not change.

## Geometry and seams

One requested XY bounds rectangle is snapped outward to the coarsest tile grid. The snapped bounds
and stable origin are reused at every level. Tile pixels are fixed. Level `z + 1` halves
world-units-per-pixel and doubles both axes, so the four child bounds exactly partition a parent.
Orientation v1 numbers rows from max-X to min-X and columns from min-Y to max-Y.

Orthographic detail comes from `OrthoWidth`, fixed tile pixels, and world-units-per-pixel. Capture Z
is independently configurable to keep the camera above geometry; it never implies a detail level.
Plans can retain Unreal's natural LOD response or set a scene-capture LOD distance scale for each
zoom level. The scoped distance factor changes only the transient capture component. Explicit
Nanite, HLOD, or foliage intervention is not inferred from camera height.

Fog and volumetric fog are independent plan settings applied to the transient scene capture's show
flags. They do not mutate the editor viewport, world actors, global console variables, or saved map.

Full-fidelity tiles render serially through one transient capture context. The `full_fidelity`
profile explicitly restores the active project's dynamic GI, reflection, anti-aliasing,
ray-tracing, tonemapping, and post-processing choices because Unreal's independent scene-capture
defaults otherwise reduce or disable several of them. `scene_capture_defaults` leaves Unreal's
SceneCapture renderer defaults unchanged as a visual comparison baseline; tile framing, gutters,
camera cuts, warm-ups, and publication are otherwise identical. Moving to a tile begins an explicit camera cut, then
performs two discarded warm-up renders before the PNG render. The cut prevents temporal state from a
spatially unrelated tile from leaking forward. PNG encoding may remain bounded and concurrent after
each exact render has been read back. Shared full-frame exposure and true cross-frame tile history
remain separate seam-correction work; the synchronous warm-up renders do not claim to provide either.

The `seam_stable` profile keeps the restored project lighting, tonemapping, color grading, and
world-space Lumen fallbacks while disabling temporal AA, eye adaptation, local exposure, motion
blur, screen-space reflections and AO, Lumen screen traces, lens flares, vignette, and chromatic
aberration. Unreal falls back from project TAA or TSR to FXAA for that view. Each logical tile and
its configured gutter render at 2x resolution and are gamma-correct box-downsampled before the
fixed-size PNG is published. This profile favors cross-tile consistency over view-dependent effects;
volumetric fog remains an explicit plan choice and can still introduce view-frustum differences.

Each tile renders `gutterPixels` beyond all four edges at the level's world-units-per-pixel, then is
cropped to the fixed tile size before PNG encoding. This lets geometry and post processing sample
past the logical edge. Viewers use clamp-to-edge texture addressing, position each tile from exact
manifest world bounds, and never resample across independent PNG files.

## Capture and publication

The v1 editor request captures one or a bounded batch of at most 64 deterministic tile keys. It
accepts an expected map, capture policy, operation/correlation identity, and tile geometry—not an
output directory, UObject pointer, or console-variable bag. Output is contained beneath
`Saved/UEShed/MapTileStaging`.

The host pipelines those batches through a one-response bounded buffer. Unreal captures batches in
strict sequence while the host validates and promotes the previous batch, so filesystem ingestion
does not leave the editor idle. This never issues concurrent capture requests to the editor, and
manifest and progress order remain deterministic.

Workbench also exposes `VIEWPORT HIGH RES · EXPERIMENTAL` as an execution-only A/B switch. It is not
saved in the Map Capture Plan. The host sends one complete zoom at a time; Unreal temporarily frames
the active Level Editor viewport over that full extent, runs the built-in High Resolution Screenshot
pipeline, restores the viewport and console state, and cuts the single image into normal immutable
tiles. This removes per-tile exposure boundaries and exercises the viewport renderer, but Unreal's
High Resolution Screenshot forces LOD0. The initial test lane accepts at most 8x8 tiles per zoom and
fails instead of silently falling back when the full image exceeds the GPU texture limit.

The capture capability requires the expected editor map to be open and continues to reject explicit
Data Layer and forced fixed-LOD policies. The separate `editor.world-control.v1` capability can open
an explicit `/Game/` map before capture. It refuses active PIE, missing maps, and dirty world
packages; it never saves, discards, or silently resolves editor state. The CLI exposes this as
`ue-shed editor world open`, while `ue-shed map-capture run --open-map` composes the same public map
control and capture workflows.

The host validates every staged path, hashes each PNG, writes a neutral manifest, and atomically
renames a staging run only when every requested tile is present and valid. Partial, failed, and
cancelled attempts retain truthful failures but never appear in completed-run discovery.
The default destination adapter owns the project-local `.ue-shed/map-capture` tree. A trusted host
may select an existing absolute caller-owned root instead; complete runs publish beneath its `runs`
tree and non-complete attempts beneath its `attempts` tree. The adapter owns exclusive creation,
containment and reparse-point checks, atomic promotion, and cleanup. No host destination is added to
the Unreal request.

Capture progress is reported from completed host batches rather than estimated by a timer. The
Workbench route correlates events to the active operation and presents opening-map, tile capture,
publication, and preview-loading phases, including processed, captured, and failed tile counts.
Progress delivery is advisory: a closed renderer or failed event send never changes capture or
publication semantics.

## Live framing preview

The Workbench reuses the process-shared asynchronous camera stream for one transient orthographic
camera centered over the plan's snapped bounds. It renders the current editor world at the plan's
capture Z and orientation, validates the expected map, and updates the framing stage at a bounded
5 FPS with a maximum 640-pixel dimension. During PLAY/SIM, the play world becomes the labeled live
authority under the same rule as Map Review.

This is a responsive framing aid, not captured evidence. Workbench labels it `LIVE FRAMING · NOT
CAPTURE OUTPUT`. It writes no PNG, spawns no saved actor, and does not publish tiles. Opening another
map or starting the real capture clears the transient preview before the map-control or capture
workflow continues. Full-fidelity fog, LOD, gutter, tile, hashing, and publication behavior remains
visible only in the executed capture and its manifest.

## Viewer contract

The pure selection model:

- chooses a level from screen pixels per world unit;
- holds the current level through a configurable hysteresis band;
- enumerates visible keys and a bounded adjacent prefetch ring;
- requests ancestor fallbacks while child tiles load or fail;
- recommends a bounded cache size and leaves eviction implementation to the host;
- aligns every level from manifest bounds, preventing drift or spatial swimming.

### Saved actor overlay

The reference viewer can load the selected map's saved-world actor projection on demand and place
resolved actor locations over the immutable tile pyramid. The overlay uses the manifest's exact
snapped world bounds and the same +X-north/+Y-east viewport transform as tile placement; it never
infers spatial coverage from PNG dimensions. Search, class filtering, selection, and focus reuse the
shared actor explorer.

The viewer reports actors inside the captured bounds separately from all resolved and saved actors.
Focusing an actor outside the capture pans into an uncovered grid instead of stretching or implying
imagery beyond the manifest bounds. Actors without resolved transforms remain available in the
outliner but are not plotted.

This layer is explicitly saved-package authority. It may differ from an older capture or from
unsaved, procedural, and runtime editor state; the viewer labels it `SAVED ACTORS` and does not
present it as capture-time evidence. A future live-actor layer requires separate Observatory
authority and labeling.

Workbench labels the executed-run viewer `CAPTURE PROOF`. It renders only the exact PNG artifacts
owned by the returned manifest. Tiles load individually on demand as the viewport pans and zooms;
the trusted host validates the manifest location, artifact membership, byte count, and hash before
returning bytes. There is no eager base64 bundle or partial-preview byte ceiling, and a tile that has
not yet been requested is not reported as a capture error.

The Workbench `#/map-capture` route is the reference host for creating or opening a portable plan,
searching the selected project's saved-map inventory, and authoring the executable v1 fields:
identity, target map, requested world bounds, PNG tile size, pyramid resolution and levels, gutter,
capture Z, render profile, fog, and LOD policy. The showcase deliberately authors a symmetrical
subset: center X/Y plus one square world size, one Level 0 tile count shared by both axes, one
resolution shared by X/Y, and one square PNG tile size. Requested cardinal edges remain derived
readouts. Setting the base grid to 1, 2, or 4 authors an exact 1x1, 2x2, or 4x4 Level 0 grid without
moving the requested capture. Changing tile size adjusts resolution inversely so tile world coverage,
the deterministic grid, and framing stay fixed; editing resolution directly intentionally changes
tile coverage and retiles the requested area. The level count adds progressively finer detail. The UI
calls gutter pixels seam overdraw; its tooltip records
that those pixels are rendered beyond each edge and cropped, not placed between tiles. The portable
plan still stores exact rectangular bounds, pixels, world-units-per-pixel, and gutter pixels, so
libraries and the CLI retain the general contract. The route continuously validates the draft and
recomputes its deterministic grid before enabling Save, map control, or capture.

Save writes new plans atomically beneath `.ue-shed/map-capture/plans` by default. Save As can place a
portable JSON plan elsewhere, and an opened plan saves back to its chosen path. The host-neutral
Solid component owns no filesystem, editor-control, capture, storage, or selection policy; those
remain public services usable by libraries and the CLI. Contract fields that the current Unreal
capability rejects—explicit Data Layers and forced fixed-LOD-zero—remain visible as validation
errors instead of being silently applied.

## Project adapter and runtime seam

PNG plus the neutral manifest is the portable output. A project-specific editor adapter may import
PNGs as `UTexture2D` assets and build a cooked registry/data asset keyed by generic Tile Keys. A
runtime provider supplies texture handles to the same pure selection inputs and may render through
UMG, Slate, world geometry, or another UI. The core never assumes external PNG access in a cooked
build and never names a studio registry, map, path, or asset type.

## Contracts and gates

- Plan: `ue-shed-map-capture-plan` 1.0.
- Editor request/response: `ue-shed-map-tile-capture` 1.0.
- Editor map control: `ue-shed-editor-world-control` 1.0.
- Published manifest: `ue-shed-map-tile-pyramid` 1.0.
- Language-neutral authority: `packages/protocol/contracts/cameras/map-tile/v1`.
- Portable parity: `pnpm --filter @ue-shed/cameras contract:check`.
- Trusted editor evidence: `pnpm check:unreal` with the UE 5.7 fixture endpoint available.
