# Shared camera rendering validation — 2026-09-08

The shared lifecycle and first-party adoption passed the checks below on Windows with stock Unreal
5.7.4 (`5.7.4-51494982+++UE5+Release-5.7`) in the repository's generic UEShedFixture editor. This is
an unreleased source build; its plugin descriptor still reports 0.6.0. No package or plugin was
published. [API and adoption guide](../products/camera-rendering.md).

## Functional evidence

- Native UEShedCamerasEditor build: passed against installed engine source and headers.
- `pnpm run check:precommit`: formatting, lint, TypeScript, StyleX, architecture, and contracts passed.
- Camera unit/adapter/compatibility tests and CLI command tests: 22 files, 149 tests passed.
- Live tests: 29 passed across `camera-render-unreal.integration.test.ts`,
  `map-tile-unreal.integration.test.ts`, and the existing `review-unreal.integration.test.ts`, run
  serially against the same fixture editor.
- Native automation: `UEShed.Cameras.Rendering.LifecycleAndReference`,
  `PreparationAndWorldChange`, and `WireConformance` passed.
- Public CLI: a validated `{session, frame}` request produced a 320×180 PNG after restoration;
  SHA-256 `8d28c002a37034ebba65cbd108d91cf1a8e66fc32a2ac7f430bcc92f601049bc`.

Live coverage includes perspective and orthographic rendering through both renderers, artifact
dimensions/byte counts/hashes, an actual transient actor moved and then deleted, unchanged approved
camera evidence in all three actor states, and an explicit missing-subject failure for actor-relative
views. Authoring preview and final Review capture have equal resolved policy and camera, with
deliberate 320×180 versus 640×360 output sizes. Legacy Review assessment, optional Clear success and
failure, immutable publication, and older 1.x wire compatibility pass.

The native tests verify actual camera actor/component transforms, editor show flags, exposure,
projection, viewport location/rotation, game view, input, realtime, screenshot configuration and map
dirty-state restoration. They exercise cross-backend contention, cancellation, lease expiry,
shutdown, and an actual map switch. The preparation test opens the generic partitioned Offline
fixture, applies a transient Data Layer's explicit loaded/visible requirements, renders both
backends, rejects a second distinct region beyond budget, restores layer state, and returns to the
original map without saving. This verifies owned editor region preparation; it does not demonstrate
that every unloaded actor in an arbitrary production partition or Data Layer hierarchy is capturable.

Map tests retain three algorithms. SceneCapture produces 21 aligned tiles over three levels with
per-level LOD distances. Lit produces five tiles over two levels, crossing the four-tile batch
boundary with one exposure value; both automatic metering and explicit EV100 pass. The explicit-EV
policy records the preserved 512-frame overview warmup. Whole-level viewport capture produces the
same five-tile topology through its capture-and-slice strategy. Tile hashes and dimensions are
validated; these small fixture runs are not a new large-map performance or seam-quality benchmark.

The compatibility run caught color-pass occlusion history leaking into an isolated depth assessment.
Assessment now uses independent depth-pass history and restores the color component's persistence
setting afterward. Legacy SceneCapture-default captures retain their original nonpersistent default.
The fully occluded subject regression and Clear tests then passed.

## Matching editor reference

The native test renders from `(1000, 1000, 900)`, rotation `(-30, -135, 0)`, using perspective
horizontal FOV 60° or orthographic width 2400 cm. Both use 1206×548, EV100 1 with project compensation,
32 warmup draws/captures, live editor time, and existing scene loading. The viewport policy is Lit
with project vignette; SceneCapture uses full fidelity with LOD distance scale 1. Fog settings match.

For each projection, the reference is an ordinary editor viewport pixel read at the same owned
camera, exposure and viewport size, after 32 additional editor draws. It is independent of the
high-resolution screenshot export. RGB errors below are normalized to 0–1, excluding alpha.

| Renderer        | Projection   | Mean absolute error | Root mean square error |
| --------------- | ------------ | ------------------: | ---------------------: |
| Editor viewport | Perspective  |         0.000720619 |            0.001742988 |
| Editor viewport | Orthographic |         0.000712153 |            0.001735392 |
| SceneCapture    | Perspective  |         0.058557029 |            0.075978467 |
| SceneCapture    | Orthographic |         0.062163915 |            0.084058767 |

Visual inspection confirms matching geometry and framing. The viewport captures closely match the
ordinary editor reference in this fixture. SceneCapture has visibly darker, bluer shaded faces and
grainier shadowed surfaces in both projections. This is **not** a SceneCapture visual-equivalence
pass. Additional warmup is not claimed to resolve those renderer differences. Neither PNG generation
nor a low error on this fixture certifies lighting quality for other projects, cameras or profiles.

Generated evidence remains under the fixture's `Saved/UEShed/RenderingValidation/`; rerun the native
test to regenerate `comparison.json` and these PNGs. SHA-256 values from this validation:

| File                              | SHA-256                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| editor-reference-perspective.png  | c89ea18f015568a73838dc133c845ca8505bd68b9bc583a58bb7cab4660d213f |
| editor-reference-orthographic.png | 3ebcf2882a9def45182098844ca698a22816f29b1fa33216cce1612cd9debd37 |
| editor_viewport-perspective.png   | a7197f677cfb7ed153f44dc4db1cd91e3955cafd85a1f4c39b638a9d691d7672 |
| editor_viewport-orthographic.png  | b58ad829de3807bcbc6fecf55a405806bd42a6b1fa29d29664f3246328adf0d7 |
| scene_capture-perspective.png     | ca396d8f851ae3615a2038bddaa0be8d9750d2406ea636541fa10dd3b4da529a |
| scene_capture-orthographic.png    | f62ac6e5091aa282ca71b7c37ebd55356fdeb5c54c420b16fb75208942324a27 |

## Reproduction and limits

Build and load matching UEShedCore/UEShedCameras plugins in a disposable rendering UEShedFixture
editor, initially on `/Game/Fixture/Cameras/L_CameraLoad`. Launch with
`-ExecCmds="Automation RunTests UEShed.Cameras.Rendering"` for native automation. The preparation
test deliberately switches maps and creates a transient Data Layer; use the generic fixture.

Set `UE_SHED_REMOTE_CONTROL_ENDPOINT` to that editor and `UE_SHED_RENDER_FIXTURE_ROOT` to the fixture
project directory, then run:

```sh
pnpm exec vitest run packages/cameras/src/camera-render-unreal.integration.test.ts packages/cameras/src/map-tile-unreal.integration.test.ts packages/cameras/src/review-unreal.integration.test.ts --no-file-parallelism
pnpm exec vitest run packages/cameras/src --exclude '**/*.integration.test.ts' apps/cli/src/command.test.ts
pnpm run check:precommit
```

Unsupported by design: viewport Review depth assessment/Clear, SceneCapture meter-once exposure,
viewport LOD distance scaling, arbitrary console-variable policies, gameplay initialization, and
orthographic saved Review pose documents. Orthographic standalone/shared rendering and maps are
supported. Geometry preparation is explicit and partial, not a guarantee of frustum completeness.
Unreal's synchronous loading/render calls cannot be interrupted mid-call. Rendering and watchdog
deadlines are checked when the editor game thread is able to run.

Not validated here: other Unreal versions, other operating systems/GPUs, packed release bundles,
the full Depot gate, full-frustum completeness on production World Partition maps, or visual parity
for every profile. Local commands used the installed pnpm runner's Node 24.20 (which warns against
the repository's Node 26 requirement); the public CLI run used Node 26.5. Package runtime support
remains separately declared. The existing release gate remains responsible for packaged validation.
