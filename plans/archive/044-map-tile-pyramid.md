# 044: Headless map tile pyramid capture

| Field      | Value                                                         |
| ---------- | ------------------------------------------------------------- |
| Status     | IN PROGRESS                                                   |
| Product    | Generic top-down cartography beside Map Review                |
| Depends on | Map Review capture/repository spine and `UEShedCamerasEditor` |

## Outcome

Add an external `Map Capture Plan`, deterministic orthographic tile-grid mathematics, a versioned
editor capture contract, immutable hashed manifests, headless orchestration and CLI commands, and a
host-neutral reference viewer. No capture actor or plan is saved in an Unreal map.

## Design

- Snap requested XY bounds outward to one coarsest grid. Rows run max-X to min-X and columns run
  min-Y to max-Y; the manifest versions this orientation.
- Keep tile pixels fixed. Level `z + 1` halves world-units-per-pixel and doubles rows and columns,
  making every parent exactly four children. Capture Z is independent of level detail.
- Render an explicit pixel gutter using the same units-per-pixel, then crop to the fixed tile size
  before PNG encoding. Viewers use clamp-to-edge per tile and exact world bounds from the manifest.
- Keep `ue-shed-review-capture` v1 unchanged. Add sibling `ue-shed-map-tile-capture` v1 and deepen
  the editor's transient scene-capture helper for perspective and orthographic callers.
- Unreal stages only beneath `Saved/UEShed/MapTileStaging`. The host validates containment, hashes
  every tile, writes a neutral manifest, and renames staging atomically only for complete runs.
  Partial/cancelled attempts remain honest staging records and are never listed as complete.
- Pure selection code chooses a level with hysteresis, visible keys, ancestor fallbacks, a bounded
  prefetch ring, and LRU cache recommendations. UI only presents that model.

## Milestones

1. Terminology, product/protocol documentation, and pure grid/selection tests.
2. Language-neutral request/response fixtures plus conformant Effect schemas.
3. Transient orthographic Unreal capture with bounded batches, gutter crop, map/dirty validation,
   and structured results.
4. Effect repository/orchestrator, hashing, atomic publication, CLI commands, and tests.
5. Host-neutral viewer, plugin bundle/fixture evidence, changeset, and full verification.

## Stop conditions

- Never switch away from a dirty interactive editor world or save/discard editor packages.
- Never accept arbitrary output paths, console-variable mutation, or UObject pointers.
- Never publish a complete manifest when any requested tile is absent or invalid.
- If trusted Unreal prerequisites are unavailable, finish portable gates and report the exact
  remaining command and prerequisite.
