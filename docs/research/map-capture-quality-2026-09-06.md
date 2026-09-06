# Map Capture quality audit — 2026-09-06

## Conclusion

Better orthographic output is possible. The current quality ceiling is substantially caused by the
capture implementation and its rendering policy, rather than an inherent inability to render maps
in Unreal. Correct tile coordinates, valid PNGs, hashes, and atomic publication do not establish
visual fidelity.

For a quality-oriented map, the preferred next design is to render one settled, explicitly framed
master image within a declared GPU budget, then derive its tiles and lower-resolution levels. Keep
independent tile rendering for extents that cannot fit that budget, with explicit shared exposure,
real frame scheduling, loading readiness, and qualified expectations for view-dependent effects.
This is a recommendation, not a newly implemented backend.

The audit fixes three demonstrated defects in the existing experimental viewport backend: ambient
wireframe rendering, a 180-degree mismatch with manifest coordinates, and editor overlays in the
image. It also rejects actor-locked viewports instead of allowing camera control to override the
requested framing. The default SceneCapture backend remains unchanged.

## Evidence and limits

Local evaluation used UE 5.7.4, engine BuildId 47537391, DX12, and an RTX 3060 Ti. A caller-selected
look-development world was loaded in a disposable host, using its supplied content and configuration.
That checkout lacked its project descriptor, native modules, and third-party dependencies. The host
loaded 1,395 actors, including 1,259 StaticMeshActors, but reported native-class and audio/VFX
dependency failures. These results establish behavior of the loaded environment; they are not a
claim of complete original-project fidelity. No source map or asset was saved.

Private project paths, assets, screenshots, requests, receipts, scripts, build logs, and the visual
comparison page are retained outside source control under `out/map-capture-audit/`. Product code and
portable fixtures contain no project-specific configuration from this experiment.

The primary comparison uses the same 32,768-unit square, capture Z 60,000, 1,024 output pixels per
axis, natural LOD, and disabled fog/volumetric fog. One whole image and a 2×2 grid of 512-pixel tiles
therefore have the same nominal spatial resolution. Additional experiments cover 4×4 subdivision,
0/16/32-pixel gutters, request order, repeated runs, camera heights, 256 real editor frames,
orthographic correction, extended Lumen range, fixed exposure, and a 2,048-pixel main-camera image.

Selected measurements, computed from decoded RGB PNGs:

| Experiment                                                        | Observation                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `seam_stable`, 2×2                                                | 97.37% of pixels have all RGB channels below 16/255                                         |
| `full_fidelity`, whole vs 2×2                                     | Mean absolute RGB difference 38.99/255 despite equal spatial resolution                     |
| Two consecutive identical 2×2 requests                            | Mean absolute RGB difference 6.58/255                                                       |
| Forward vs reversed 2×2 request order                             | Mean absolute RGB difference 20.18/255                                                      |
| SceneCapture, 3 immediate renders vs 256 subsequent editor frames | Mean absolute RGB difference 30.10/255; longer settling alone did not make the image better |
| Lit, piloted main-camera reference                                | Much more shadow detail visible; only 0.62% of pixels below the same threshold              |

These are diagnostic measurements, not perceptual quality scores. Comparisons involving different
renderer paths, exposure policies, or camera correction are not radiometrically matched. The world
contains animated systems and was not frozen. Order-dependent results are evidence of history/state
sensitivity, not proof that every differing pixel is caused by tile order. Timing is exploratory,
not a performance benchmark.

## Findings

Source entry points:

- [Transient capture and renderer profiles](../../unreal/Plugins/UEShedCameras/Source/UEShedCamerasEditor/Private/UEShedTransientCapture.cpp)
- [Unreal tile and viewport capture](../../unreal/Plugins/UEShedCameras/Source/UEShedCamerasEditor/Private/UEShedMapTileCapture.cpp)
- [Host batching and publication](../../packages/cameras/src/map-tile-capture.ts)
- [Grid and level selection](../../packages/cameras/src/map-tile-pyramid.ts)
- [Reference viewer](../../extensions/camera-review/src/map-tile-viewer.tsx)
- [Existing live tile test](../../packages/cameras/src/map-tile-unreal.integration.test.ts)

### 1. Disabling eye adaptation does not preserve a useful exposure

`FUEShedTransientCapture::ConfigureSeamStableRenderer` disables `EyeAdaptation`. In UE 5.7.4,
`PostProcessEyeAdaptation.cpp` explicitly selects manual behavior when that flag is off, sets the
white point to 1, and resets exposure compensation to 1. It does not meter the complete map and
freeze that result. This explains the nearly black capture on the tested world.

A separate experiment retained exposure processing and used equal minimum/maximum EV100 values.
It recovered visible scene detail while disabling temporal AA, local exposure, screen-space AO and
reflections, Lumen screen traces, lens flares, vignette, and chromatic aberration. Exposure values in
that experiment were deliberately selected for comparison, not proposed as product defaults.

The public policy needs explicit fixed exposure or a full-map metering stage whose chosen exposure
is applied to every tile and recorded in the manifest. Do not silently replace this with per-tile
auto exposure: that would restore brightness while violating the purpose of seam stability.

### 2. Immediate capture calls are not a rendering lifecycle

`CaptureMapTiles` creates a capture context per batch, begins a camera cut at each tile, executes two
discarded `CaptureScene` calls, reads the third image, and destroys the context at batch completion.
The warm-ups take place inside one synchronous Remote Control invocation. They do not allow the
editor to advance normally between captures.

Engine source assigns SceneCapture view families the scene frame number and global frame counter.
Lumen needs persistent view state and has incremental surface-cache work; exposure and temporal
rendering also depend on previous state. The 256-frame experiment demonstrates that three immediate
calls do not establish convergence. It also shows why merely increasing a warm-up constant is not a
complete fix: the settled capture still differed substantially from the main viewport.

A quality workflow needs an asynchronous operation with explicit loading, warm-up, capture, readback,
encoding, completion, cancellation, and cleanup states. Yield real frames. Make bounded render
warm-up distinct from whether the simulation clock advances, and record both choices. Preserve
capture state across host batch boundaries when it belongs to the same operation.

### 3. Capture altitude affects more than clearance

The current orthographic configuration sets projection type and width but does not configure
orthographic origin correction. The editor's camera path and independent SceneCapture do not build
identical view/projection state. UE 5.7.4's ordinary SceneCapture orthographic projection also uses
its own broad near/far range; enabling the component's automatic-plane property alone does not
replace that construction path.

The height sweep changed lighting and visible geometry at constant XY framing. Enabling
`bUpdateOrthoPlanes` with camera-height correction improved some lighting but changed visible roof
geometry. Lowering the actual camera also crosses tall geometry. Neither is a safe universal fix.
Increasing Lumen scene/trace range recovered some shadow detail without lowering the physical
camera, but did not reproduce the main viewport completely.

Specify physical clearance, projection depth range, effective rendering origin, and lighting
coverage deliberately. Validate against elevated worlds and tall geometry. Do not infer that a
constant `OrthoWidth` makes camera Z irrelevant to all LOD, culling, GI, and shadow decisions.

### 4. The experimental viewport path had concrete output-contract defects

Before the fix:

- Changing to `LVT_OrthoTop` could select the editor's independent wireframe view mode. The request
  still returned `completed` and published valid PNGs.
- That editor view maps +X downward and +Y leftward. The manifest maps +X upward and +Y rightward.
  The lit A/B capture confirmed a 180-degree mismatch.
- Editor axes/scale rulers and selection/debug presentation could enter the output.
- An actor or cinematic lock could supersede the requested viewport framing.

The fix selects Lit explicitly, suppresses editor presentation, rotates the complete screenshot
180 degrees while extracting tiles (including correct gutter and tile placement), and restores
the prior view modes, show flags, and axes settings. Actor-locked viewports fail with recovery
guidance before any framing changes.

Remaining limitations are significant: the High Resolution Screenshot pipeline forces LOD0; it
does not implement all plan profiles identically to SceneCapture; each zoom still renders separately;
and ambient editor/scalability/exposure state is not fully represented in provenance. A successful
experimental capture should not be interpreted as complete renderer-policy conformance.

### 5. Gutters and supersampling cannot repair independent image formation

The gutter implementation renders outside the logical tile and crops before encoding. Seam-stable
supersampling downsamples in the image pipeline. Neither operation makes separate exposure
histograms, Lumen histories, local exposure, screen-space effects, or volumetric frusta identical.

The gutter and subdivision experiments still produced different whole-map images. Re-rendering
every zoom also changes the view footprint and potentially lighting/LOD. If smooth transitions
between zoom levels matter more than independently chosen LOD, derive lower levels from one master.

The failures are visible in assembled raw PNGs without Workbench. The viewer cannot repair them.
The DOM image viewer should still receive a separate device-pixel-ratio and fractional-pixel seam
test; source inspection alone does not establish browser rendering correctness.

### 6. Readiness and validation currently prove too little

The renderer waits for level streaming and checks World Partition's current streaming state. It
does not establish that the requested capture extent is loaded, all shaders/assets are ready,
texture/Nanite/virtual-texture residency is adequate for the capture, or rendering has converged.
An idle streaming system is not proof that every needed region is present.

The existing Unreal tile integration test asserts publication, level/tile counts, image dimensions,
and absence of reported failures. It does not inspect orientation, brightness, seams, material
fallbacks, or agreement with a reference view. Black and wireframe images can pass those assertions.

Add an asymmetric generic fixture with known colored landmarks, an elevated floor, tall occluders,
bright/dark regions, and a directional light. Check projection into manifest coordinates, content
presence, renderer-state restoration, bounded seam differences, and repeated/order-varied runs.
Include negative cases for camera locks and unsupported render policy. Keep image tolerances
appropriate to real GPU rendering rather than demanding byte-identical output.

## Alternatives

| Approach                                      | Assessment                                                                                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settled full-map master, slice and downsample | Preferred quality path within a declared memory/texture budget. Shared image formation removes independently rendered tile boundaries. A 2,048-pixel camera reference was exercised locally; large production extents remain to be qualified. |
| Asynchronous independent SceneCapture tiles   | Required fallback for large extents. Needs shared exposure, explicit residency and real-frame warm-up; some view-dependent differences remain.                                                                                                |
| Existing viewport High Resolution Screenshot  | Useful A/B lane after the correctness fixes, but LOD0 and ambient editor state prevent promoting it directly as universal fidelity.                                                                                                           |
| Movie Render Queue                            | Candidate for an isolated offline renderer with warm-up and sampling controls. Its high-resolution tiling is not an automatic seam/temporal-AA solution. Not executed in this audit.                                                          |
| Built-in SceneCapture orthographic tiling     | UE source permits SceneColor tiling; FinalColor sources are explicitly incompatible. It does not directly replace this tonemapped PNG pipeline.                                                                                               |
| Explicit cartographic render style            | Appropriate when navigation readability matters more than matching lit gameplay. Base color/unlit shading, height/normal information, and deliberate roof/foliage policy can be more useful, but this is a distinct product mode.             |

Epic documents orthographic support for modern rendering features in
[Orthographic Camera](https://dev.epicgames.com/documentation/en-us/unreal-engine/orthographic-camera-in-unreal-engine?application_version=5.7).
Its [Movie Render Queue image settings](https://dev.epicgames.com/documentation/en-us/unreal-engine/cinematic-rendering-image-quality-settings-in-unreal-engine?application_version=5.7)
document high-resolution tiling limitations, including temporal AA and screen-space effects.
Engine behavior above was verified against the installed 5.7.4 source rather than inferred from
current-version documentation.

## Validation performed

- Built the Core/Cameras modules against the installed engine; rebuilt the changed CamerasEditor
  module successfully after the fixes.
- Executed real map captures through `CaptureMapTiles`, retained raw requests/responses, decoded and
  inspected the PNGs, and compared renderer and parameter variants.
- Verified the corrected viewport capture from a wireframe starting state, restoration of the
  active mode, clean map state, and rejection of an actor-locked viewport.
- Full portable and full Unreal-plugin gates were not run to completion. The initial all-plugin
  build exposed existing Niagara compilation errors in floor-preview APIs; the targeted camera
  build passes. Complete project fidelity remains unverified because the supplied checkout is
  missing dependencies.

The immediate fixes make the experimental result correctly oriented and usable for comparison.
They do not resolve the default tiled backend's exposure, temporal state, readiness, or lighting
coverage problems. Those findings should drive the next capture architecture work.
