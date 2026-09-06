# Moving the lit camera: tile seam experiment

## Finding

Moving one ordinary orthographic camera and capturing each tile through the Lit viewport produced
substantially more readable shadow detail than the earlier SceneCapture tile path. The fixed-exposure
4×4 result is visually coherent. Measured differences in overlapping renders do not, by themselves,
establish visible stitching seams or justify rejecting this result.

Correction after visual review: the original report overstated seam visibility. The regular ground
grid is authored scene content and is also present in the whole-camera reference. Differences from
that reference, duplicate-overlap differences, and visible discontinuities at the actual tile joins
are distinct findings. No specific distracting join was demonstrated for the fixed-exposure 4×4
assembly, so the original claim that it was visibly seamed and unacceptable is withdrawn.

Automatic exposure produced strong tile differences. Fixed exposure substantially reduced the
mismatch. Wider gutters helped some boundaries. Increasing real viewport settling from 128 to 512
frames did not materially reduce overlap mismatch in this test.

No game-code or engine changes were needed. The experiment used a private Python driver for stock
editor APIs plus the existing plugin freeze command. It does not introduce a new production capture
backend or change published capture behavior.

## Method

The disposable stock-engine host loaded the same supplied lookdev content and rendering
configuration as the previous audits. Native game and middleware binaries were absent. Results
therefore establish behavior in this host rather than complete native-project fidelity.

One transient `CameraActor` was piloted through the Level Editor viewport in Lit mode, with exact
camera view, square aspect, orthographic projection, and camera Z 60,000. Its XY position and
orthographic width changed for each tile. The test used
`AutomationLibrary.take_high_res_screenshot` for each individual tile: the same screenshot path as
the earlier lit-camera reference, rather than SceneCapture or a sliced full-map image.

The requested region was 32,768 world units square:

| Capture        | Tile grid | Logical tile pixels | World units per pixel | Actual tile render target           |
| -------------- | --------- | ------------------- | --------------------- | ----------------------------------- |
| Normal density | 2×2       | 512×512             | 32                    | 544×544, including 16-pixel gutters |
| Higher density | 4×4       | 512×512             | 16                    | 544×544, including 16-pixel gutters |
| Wider overlap  | 2×2       | 512×512             | 32                    | 640×640, including 64-pixel gutters |

Whole-camera images at matching pixel densities were captured only as bounded comparison
references. The 4×4 output contains 2,048×2,048 independently captured pixels; production tiling
does not require allocating that whole-map target.

Each camera position received at least 128 real viewport frames and 2.2 seconds before the screenshot
request. Most completed in approximately three seconds at a 60 FPS cap. One four-tile case used
512 frames per tile. Completion required both the screenshot task and the actual PNG. All 47
requested camera views completed and decoded successfully.

The plugin's scene freeze stayed active for the entire sweep, holding material timestamps and
existing primary actor/component ticks. Its logged duration was 335.6 seconds, below the 600-second
lease. This does not imply that every custom ticker or particle manager was frozen.

Fixed exposure used matching minimum/maximum EV limits of −5 on the transient camera. This was a
scene-specific experiment value, not a proposed product default. Fog was disabled except in a
separate fog-plus-volumetric-fog comparison. No per-tile color matching or seam blending was applied:
PNG gutters were simply cropped and the logical tiles assembled at their declared positions.

## Boundary measurements

Adjacent raw images contain duplicate world coverage in their gutters. Comparing corresponding
pixels in that overlap measures whether the same region renders consistently from neighboring
camera positions. Unlike adjacent-edge differences, it does not count a legitimate texture edge
simply because two neighboring pixels have different colors.

The table uses mean absolute RGB difference on the 0–255 scale in a common 32-pixel band centered
on each tile boundary. The wider-gutter case uses that same central band for a fairer comparison.
These are image differences, not perceptual quality scores. The 4×4 grid samples additional
boundaries at a different world-units-per-pixel density, so its value is not a controlled comparison
against the 2×2 grid.

| Case                                  | Mean overlap difference | Assessment                                       |
| ------------------------------------- | ----------------------: | ------------------------------------------------ |
| 2×2, automatic exposure               |                   24.80 | Strong brightness discontinuities                |
| 2×2, fixed exposure, 128 frames       |                    8.56 | Much better detail; measured render differences  |
| Same fixed settings, reversed order   |                    9.58 | Still order-sensitive                            |
| 2×2, fixed exposure, 64-pixel gutters |                    7.21 | Some boundary improvement                        |
| 2×2, fixed exposure, 512 frames       |                    8.98 | More settling did not materially help            |
| 4×4, fixed exposure, 128 frames       |                    7.07 | Additional detail; visible seams not established |
| 2×2, fixed exposure, fog enabled      |                    9.01 | Fog does not eliminate the differences           |

Normal versus reversed fixed-exposure assemblies differed by 4.25 RGB levels on average. The
2×2 fixed assembly differed from the later matching whole-camera reference by 11.09 levels;
the 4×4 assembly differed from its matching 2K reference by 14.68. These full-image comparisons
include lighting differences away from tile edges and therefore must not be described as seam-only
scores. Cases ran sequentially with evolving renderer state rather than isolated renderer resets.

An early whole-camera fixed-exposure calibration was much darker than a later repeat at the same
settings. The early EV −5 image had mean RGB 59.21; the tile assembly was 104.61. Later reference
captures retained the brighter, more readable appearance. Fixed tile/reference comparisons therefore
use the later repeat. The original calibration images are retained, not silently discarded. This
observation reinforces that 128 viewport frames do not establish complete rendering-state
convergence; its precise cause was not isolated in this experiment.

## Practical consequence

The main-camera path is a stronger fidelity baseline than the current independent SceneCapture
implementation. It recovers much of the intended shadow readability at bounded tile sizes, without
requiring a giant master image. Further investigation should focus on consistent image formation
across camera positions rather than increasing pixel counts or warmup duration alone.

The remaining differences are compatible with view-dependent lighting, coverage, and rendering
history, but this experiment does not isolate one renderer subsystem as the sole cause. Geometry
and shadow appearance can also differ away from seams, so a cosmetic seam blend would not establish
correct rendering equivalence.

The High Resolution Screenshot path forces LOD0 and has temporal-rendering limitations. Using it
for this test matches the original lit reference's screenshot mechanism; it does not prove that
the final production backend should inherit that policy. A production implementation would also
need operation-owned lifecycle, viewport restoration, explicit exposure policy, cancellation,
readiness reporting, and host-neutral requests.

## Evidence and cleanup

Private scripts, all camera settings and timings, 47 raw screenshots, unblended assemblies,
per-boundary metrics, and the interactive comparison are under ignored
`out/map-capture-audit/moving-camera/`. The comparison includes native PNG downloads, a center-seam
close-up, and optional tile-boundary guides. Browser verification decoded all 13 gallery images and
exercised selectors, presets, guides, close-up mode, and the divider without JavaScript errors.

The freeze was explicitly released, the transient camera removed, and the owned editor process
stopped. The source map's SHA-256 remained identical to the previous audit. No source asset was
saved, and no studio paths or assets were introduced into plugin code or public fixtures. No
production C++ or TypeScript behavior changed during this experiment.
