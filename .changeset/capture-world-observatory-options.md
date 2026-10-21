---
"@ue-shed/cameras": minor
"@ue-shed/world": minor
"@ue-shed/observatory": minor
"@ue-shed/niagara": minor
---

Capture, world preparation and observation can be composed and tested by hosts. Defaults are
unchanged.

- `@ue-shed/cameras` exports `MAP_TILE_CAPTURE_MAX_TILES_PER_REQUEST` (also from `./browser` and
  `./map-tiles`) and `makeMapCaptureTestLayer`.
- `worldPreparationLayer(endpoint, { requestTimeout })` and `makeWorldPreparation` take a request
  timeout (default 30 seconds) for large World Partition maps. `withPreparedWorld` passes a lease ID
  and duration. `WorldVector`, `WorldExtent`, `WorldLayerRequirement` and `WorldContract` types are
  exported.
- `observatoryLayer` requires `EditorWindowActivation`, so a host can supply its own focus handling.
  `ObservatoryLive` composes it with the engine's activation as before. `makeObservatoryTestLayer`
  provides a complete Observatory for tests.
- `@ue-shed/niagara` exports `NIAGARA_PREVIEW_MAXIMUM_TOTAL_PIXELS`, and `./browser` now includes
  the pure presentation helpers.
