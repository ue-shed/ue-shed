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

Each tile renders `gutterPixels` beyond all four edges at the level's world-units-per-pixel, then is
cropped to the fixed tile size before PNG encoding. This lets geometry and post processing sample
past the logical edge. Viewers use clamp-to-edge texture addressing, position each tile from exact
manifest world bounds, and never resample across independent PNG files.

## Capture and publication

The v1 editor request captures one or a bounded batch of at most 64 deterministic tile keys. It
accepts an expected map, capture policy, operation/correlation identity, and tile geometry—not an
output directory, UObject pointer, or console-variable bag. Output is contained beneath
`Saved/UEShed/MapTileStaging`.

The capture capability requires the expected editor map to be open and continues to reject explicit
Data Layer and forced fixed-LOD policies. The separate `editor.world-control.v1` capability can open
an explicit `/Game/` map before capture. It refuses active PIE, missing maps, and dirty world
packages; it never saves, discards, or silently resolves editor state. The CLI exposes this as
`ue-shed editor world open`, while `ue-shed map-capture run --open-map` composes the same public map
control and capture workflows.

The host validates every staged path, hashes each PNG, writes a neutral manifest, and atomically
renames a staging run only when every requested tile is present and valid. Partial, failed, and
cancelled attempts retain truthful failures but never appear in completed-run discovery.

## Viewer contract

The pure selection model:

- chooses a level from screen pixels per world unit;
- holds the current level through a configurable hysteresis band;
- enumerates visible keys and a bounded adjacent prefetch ring;
- requests ancestor fallbacks while child tiles load or fail;
- recommends a bounded cache size and leaves eviction implementation to the host;
- aligns every level from manifest bounds, preventing drift or spatial swimming.

The Workbench `#/map-capture` route is the reference host for choosing a portable plan, inspecting
its grid, editing fog and LOD policy, opening the target map, running capture, and exploring the
published pyramid. Its host-neutral Solid component owns no filesystem, editor-control, capture,
storage, or selection policy; those remain public services usable by libraries and the CLI.

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
