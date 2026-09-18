# Camera authoring native proof

The first camera-flow implementation has an optional editor bridge and an independently optional
reference menu. `UEShedCameraAuthoring` depends on `UEShedCameraAuthoringBridge`, which depends on
`UEShedCameras`. Capture-only installations retain Core+Cameras.

## Evidence

Run `UE_SHED_UNREAL_ENGINE_ROOT=<discovered engine> pnpm test:unreal-plugins <new output directory>`.
The runner builds the plugins into a disposable project and records an automation report, editor log,
saved-map proof, and PNGs. The implementation was exercised against installed Unreal 5.7 on Windows.
Local evidence is under `out/camera-native-13/` (ten passing tests); generated evidence is not source.

`UEShed.Cameras.Authoring.NativeLifecycle` proves transient/transactional camera and lens state,
selection/piloting, pose and lens readback, Undo/Redo, stale acknowledgement rejection, suppression of
host-update echoes, capture ownership release, viewport restoration, and preservation of map dirt.
It saves a map while the proxy exists, reloads that saved map, and verifies that no authoring proxy was
serialized. Map loading and PIE begin release authoring ownership before changing the editor world.
Pending edits survive cleanup as a recovery JSON file. A deferred Save is canceled when the camera
changes again before host observation, and the author can explicitly Save the newly reviewed pose.

`scripts/test-camera-authoring.ts` also passed at `out/camera-roundtrip-04/`. It enables only
Core+Cameras+Bridge for native editing over Unreal RC, without the reference menu or Workbench.
It persists Review Set 1.4, restarts with Core+Cameras only, verifies that authoring discovery reports
the missing optional plugin, and captures the exact saved pose and FOV with unchanged map dirt.
`evidence.json` and `approved-camera.png` record that round trip.

`UEShed.Cameras.Rendering.ViewLocalVisibilityProof` uses a temporary opaque static-mesh column. It
compares visible, excluded, and restored pixels through the viewport screenshot pipeline and a direct
SceneCapture. The viewport extension remains enabled during the independent SceneCapture comparison,
which demonstrates that the viewport exclusion does not leak into that view. It never changes the
actor's visibility flags or map package dirt.

The important hook is `FSceneView::State`, compared with the target viewport's `ViewState` during
`ISceneViewExtension::SetupView`. Comparing `FSceneViewFamily::RenderTarget` with the viewport misses
high-resolution screenshot views. The proof adds the component's **current** primitive scene ID to
that view's `HiddenPrimitives`. SceneCapture uses its own `HiddenActors` list.

| Geometry / operation                                                            | Evidence                                                                              | Advertised capability      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| Opaque engine cube used as a column                                             | Viewport screenshot exclusion and restoration; SceneCapture exclusion and restoration | Proof only                 |
| Other view isolation                                                            | Independent SceneCapture pixels remain unaffected by the viewport hook                | Proof only                 |
| Nanite-specific assets, instanced meshes, translucency, World Partition loading | Not established by this fixture                                                       | Unsupported / unadvertised |
| Full authored viewport culling policy                                           | Shared policy integrated in phase 5                                                   | `viewportCulling: true`    |

The phase-5 fixture uses actual shared render sessions for visible, excluded, and restored frames in
both backends. It also checks protection and missing-reference failure. This advertises only the
bounded loaded, opaque, non-Nanite static-mesh scope, not the untested geometry matrix.

## Engine source checked

- `UnrealEd/Public/LevelEditorViewport.h`: actor locks, piloting and viewport camera updates.
- `UnrealEd/Private/EditorViewportClient.cpp`: view-state assignment and `SetupView` invocation.
- `CoreUObject/Private/UObject/UObjectBaseUtility.cpp`: `MarkPackageDirty` skips transient objects in
  the outer chain. Both the actor and lens component are transient and transactional.
- `Engine/Classes/Engine/World.h`: temporary editor actor and external-package spawn controls.
- `Engine/Public/SceneView.h`, `SceneViewExtension.h`: per-view hidden primitive membership.
- `UnrealEd/Public/Editor.h`: pre-map-load and pre-PIE lifecycle delegates.

The bridge and renderer share a public game-thread ownership guard. A connected authoring camera
set holds it until detach, map/PIE transition, plugin shutdown, loss of all cameras, or expiry of its 30-second
host lease. Capture must detach authoring first. No rendering code imports the authoring plugins.

## Phase 4-5 verification

The isolated round trip now covers reviewed arc regeneration, preservation of a pinned camera during
shared tuning, switching cameras, portable recipe export, native actor selection, GUID/path protection,
batch approval, and disk/editor restart. It then renders Pure + Authored with only Core+Cameras enabled.
The native suite uses actual shared renderer sessions for visible/excluded/restored pixel comparisons
on both backends and checks clean-map restoration. The broader geometry and performance matrix remains
phase 6; these results do not establish Nanite, instances, translucency or World Partition streaming.

## Native multi-camera preview proof

`UEShed.Cameras.Authoring.MultiCameraPreviews` exercises the reusable GPU preview pool with four
independent views. It checks bounded targets, fair one-at-a-time scheduling, no catch-up burst,
pause/manual refresh, target reuse, local pose changes, per-view exclusion pixels, page release,
invalid input, and unchanged viewport/map state. The pool exposes GPU textures directly;
its pixel assertions use test-only readback. The separate batch reviewer deliberately reads
back each completed camera once to cache the image and release its capture resources.

`UEShed.Cameras.Authoring.PreviewPanel` publishes a sixteen-camera fixture through the public bridge,
checks the editing list and its See Previews action, renders the separate Slate review panel, and
saves `Saved/UEShed/PreviewValidation/panel.png`. It checks all sixteen review tiles without paging,
hidden-tab pause, one capture at a time, no capture after completion, cached images surviving GC,
stale-image warnings after edits, explicit refresh, closing mid-render without ending authoring,
reopening, and detach cleanup. `NativeLifecycle` also
saves and reloads a map with a preview allocated, proving world cleanup and non-serialization of
the transient preview actor. These tests run through `pnpm test:unreal-plugins` in an isolated host.
The fixture is not a performance guarantee for large studio maps or final-capture fidelity.

The separate review panel passed all twelve native tests on installed Unreal 5.8 and 5.7.
Local evidence is under `out/native-review-panel-proof-58-v2/` and
`out/native-review-panel-proof-57-v2/`; these generated reports and screenshots are not source.

## Whole-set native editing

`UEShed.Cameras.Authoring.FullSetEditing` attaches sixteen real transient, transactional camera actors,
multi-selects and moves them, edits an inactive camera's FOV, exercises Undo/Redo and rejects a stale
acknowledgement. It switches pilot targets without respawning actors, duplicates and deletes through
Unreal's editor actor subsystem, and undoes/redoes an acknowledged deletion with stable camera/View
identity. Saving/reloading the map proves no authoring cameras were serialized. The panel proof also
selects all sixteen actual actors and pilots through its public selection controls.

Host tests cover atomic multi-camera writes, lens-only edits without pinning, inactive-camera updates,
selection-only changes, replay/lost acknowledgements, native membership changes and Undo racing an
acknowledgement. The Effect coordinator retains typed failures and revision-checked atomic persistence.

UE 5.8's Remote Control function allowlist is configured with process-local additive entries for exact
API classes of enabled UE Shed plugins. It does not enable unrestricted remote calls, child classes,
or rewrite project settings. The isolated round-trip fixture separately allows two exact editor
selection functions needed for its setup; production launches do not grant those fixture permissions.

Whole-set editing passed all thirteen native tests on installed UE 5.8.2 in
`out/native-camera-set-proof-58-final/`. The headless RC/disk/restart/capture round trip passed in
`out/native-camera-set-roundtrip-58-v2/`. Camera/engine package tests reported 208 passed and 33
environment-gated skips; the pre-commit gate and Workbench production build passed. These runs do
not claim the full portable/Rust gate or a whole-set rerun on UE 5.7.

## Workbench first-camera entry

The `first camera set` case in `apps/workbench/e2e/map-review-authoring.e2e.ts` passed against
the isolated UE 5.8.2 fixture. It starts without review data, follows **Review sets → New camera set**,
creates from an actual Unreal selection, verifies persistence, restarts Workbench, opens the discovered
Review Set, and reopens the editable camera draft. It also checks **Return to set** and the styled
sibling-creation form. The test uses a separate Workbench profile, project-data directory, and camera
pipe; it tests creation and reopening, not streamed preview pixels. Screenshots are generated in
`test-results/workbench/`.

## Preset-first native authoring UX

The native panel now renders separate setup and editing states. `PreviewPanel` exercises creation
through the panel's actual handler with a selected transient fixture subject, validates the queued
four-camera preset, and proves no actors are spawned before host persistence. It checks visible
creation failures, invalid counts, project isolation, host release ownership, and immediate host
reconnection. Existing sixteen-camera selection/pilot and separate review-panel checks still run.
Screenshots include `setup.png`, `editing.png`, and `change-preset.png` as well as the review sheet.

All thirteen native tests passed on UE 5.7 and UE 5.8.2 with evidence in
`out/camera-ux-proof-57-02/` and `out/camera-ux-proof-58-02/`. The Workbench production build passed.
The expanded `first camera set` Electron case passed against the isolated UE 5.8.2 fixture: it also
submits the public native setup request after Workbench restart with Map Review closed and verifies
the four-camera draft on disk without a Workbench Create/Layout action. Portable host tests cover a lost acknowledgement,
visible creation failures, schema rejection, and explicit lease release. These checks do not claim
the full portable/Rust gate or performance on a production map.

The final targeted camera/UI/service run passed 222 tests with 31 environment-gated skips, and
`check:precommit` passed. The separate Effect architecture audit still reports pre-existing adapter
violations in `editor-window-activation.ts`, `anchored-popover.tsx`, and `dismissible-details.ts`;
the full repository gate is not claimed green.

## Split inspector and numeric scrubbing

The native panel uses independently scrolling camera and inspector panes separated by a resizable
splitter. Framing values occupy two columns; page controls use Unreal's dock-tab style and an active
underline. The native proof now captures the 580-pixel and 1000-pixel layouts plus Visibility and
Capture pages. Its offscreen window is 1280 × 800 so the screenshots no longer crop a 640-pixel panel
to the former 480-pixel test viewport.

`PreviewPanel` sends real Slate mouse-down/move/up events through a framing numeric field and checks
that dragging right submits an increased value. It also checks coalescing while an earlier edit is
in flight, preserving the final mouse-release value, returning to confirmed host state after
acknowledgement, and cancelling unsent edits on scope change. These are native control/queue checks;
the host persistence contract is unchanged. All thirteen native tests passed on UE 5.8.2 in
`out/camera-ux-columns-58-verified/` and on UE 5.7 in `out/camera-ux-columns-57-cleanup/`.
The fixture deselects its restored subject before destruction, releasing the editor selection handle
that otherwise caused a UE 5.7 shutdown assertion. Cross-engine rebuilds required forced header
generation to replace incompatible generated UHT files. Repository formatting, lint, and script
type checks passed.
