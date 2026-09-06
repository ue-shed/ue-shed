# 32×32 moving-camera capture scale test

## Result

The moving Lit-camera experiment completed all 1,024 requested tiles over a region eight times wider
and taller than the previous 4×4 test. Capture took 31.3 minutes, including the initial
camera warmup and a separate low-resolution reference. The output contains 16,384×16,384 pixels
(268 megapixels), rendered through bounded per-tile targets.

The deliverables include the original tiles, a six-level derived tile pyramid, a 2K overview, a
streamed full-resolution PNG, and an interactive viewer that loads detail on demand. The original
4×4 region is also extracted from the larger result for direct inspection. No seam blending or
per-tile color correction was applied. Ground grid lines are scene content; numerical differences
between images are not treated as proof of visible stitching seams.

## Capture configuration

| Setting               | Value                                                 |
| --------------------- | ----------------------------------------------------- |
| Grid                  | 32×32                                                 |
| World bounds          | −131,072 to +131,072 on both XY axes                  |
| World units per pixel | 16                                                    |
| Tile world width      | 8,192                                                 |
| Logical tile pixels   | 512×512                                               |
| Gutter                | 16 pixels per edge                                    |
| Tile render target    | 544×544                                               |
| Camera height         | 60,000                                                |
| Fixed exposure        | EV limits −5, retained from the small test            |
| Settling              | 128 real viewport frames per tile; 512 initial frames |
| Fog / volumetric fog  | Disabled                                              |

The same ordinary orthographic camera moved between positions in row order. Screenshots used the
stock Lit viewport High Resolution Screenshot path exercised in the previous test. The viewport
frame-rate cap was removed; the required frame count was retained. Screenshot tasks were serialized
and completion required the actual PNG. A private Python driver exercised stock editor APIs and
the Cameras plugin's freeze commands; this remains an experiment rather than a shipped backend.

The source content ran in the disposable UE 5.7.4 host without native game/middleware binaries.
High Resolution Screenshot's LOD0 and temporal-rendering limitations still apply. This run tests
capture scale with the existing settings, not a new exposure policy for all parts of the map.

## Freeze lease and derived output

Long captures now have `UEShed.MapCapture.KeepAlive` in the editor plugin. It renews the existing
freeze's 600-second inactivity lease without changing its frozen timestamps or original primary-tick
snapshot. It cannot recreate an expired session. The driver renews once per minute, and the normal
resume, world cleanup, PIE-start, and module-shutdown cleanup remain in place.

The host derives each parent from four child tiles with a linear-light 2×2 box reduction. Six levels
contain 1,365 PNGs: 1,024 captured leaves and 341 parents. The viewer selects a level from display
scale, requests visible tiles, and bounds its decoded-image cache. Optional tile guides start off.
The full-resolution PNG is assembled one 512-row band at a time, rather than by allocating an
unbounded Unreal render target.

## Verification and artifacts

- All 1,024 unique tile coordinates exist and match the complete 32×32 grid.
- Every leaf decodes at 512×512, matches its exact raw gutter crop, and matches its recorded hash.
- All 341 parent images decode at their expected dimensions.
- The full PNG decodes at 16,384×16,384 and seven distributed tile samples match the captured leaves.
- Browser checks exercised fit, pan, wheel zoom, native detail, previous-region framing, and tile
  guides without errors.

The full PNG is 414.3 MiB; captured leaf PNGs total
286.5 MiB. Scripts, receipts, hashes, checks, overview, full PNG, and the
viewer are retained under ignored `out/map-capture-audit/grid32/`. No studio paths or assets are
added to public plugin code or fixtures.

The freeze was explicitly released after capture, its original tick snapshot restored, and the
owned test editor stopped. The source map hash remained unchanged. The targeted CamerasEditor build
and `UEShed.Cameras.MapCapture.FreezeState` native automation test passed. The artifact manifest and
viewer are research outputs, not a published production Map Capture run.
