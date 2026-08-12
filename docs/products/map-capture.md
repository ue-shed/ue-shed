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
is independently configurable to keep the camera above geometry. Natural Unreal LOD response to
`OrthoWidth` is recorded as render policy; explicit Nanite/HLOD/foliage intervention is never
inferred from camera height.

Each tile renders `gutterPixels` beyond all four edges at the level's world-units-per-pixel, then is
cropped to the fixed tile size before PNG encoding. This lets geometry and post processing sample
past the logical edge. Viewers use clamp-to-edge texture addressing, position each tile from exact
manifest world bounds, and never resample across independent PNG files.

## Capture and publication

The v1 editor request captures one or a bounded batch of at most 64 deterministic tile keys. It
accepts an expected map, capture policy, operation/correlation identity, and tile geometry—not an
output directory, UObject pointer, or console-variable bag. Output is contained beneath
`Saved/UEShed/MapTileStaging`.

The v1 capability requires the expected editor map to be open and rejects explicit Data Layer or
fixed-LOD policies until a scoped UE 5.7 adapter proves restoration. A headless project launcher may
open the configured map explicitly before connecting. Interactive hosts must refuse switching when
dirty work could be lost. Remote Control itself does not receive hidden map-switch authority.

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

A host-neutral Solid reference component may demonstrate pan, zoom, progressive replacement,
loading/error states, and diagnostics, but it owns no capture, storage, or selection policy.

## Project adapter and runtime seam

PNG plus the neutral manifest is the portable output. A project-specific editor adapter may import
PNGs as `UTexture2D` assets and build a cooked registry/data asset keyed by generic Tile Keys. A
runtime provider supplies texture handles to the same pure selection inputs and may render through
UMG, Slate, world geometry, or another UI. The core never assumes external PNG access in a cooked
build and never names a studio registry, map, path, or asset type.

## Contracts and gates

- Plan: `ue-shed-map-capture-plan` 1.0.
- Editor request/response: `ue-shed-map-tile-capture` 1.0.
- Published manifest: `ue-shed-map-tile-pyramid` 1.0.
- Language-neutral authority: `packages/protocol/contracts/cameras/map-tile/v1`.
- Portable parity: `pnpm --filter @ue-shed/cameras contract:check`.
- Trusted editor evidence: `pnpm check:unreal` with the UE 5.7 fixture endpoint available.
