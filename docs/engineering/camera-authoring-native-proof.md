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
holds it until detach, map/PIE transition, plugin shutdown, proxy deletion, or expiry of its 30-second
host lease. Capture must detach authoring first. No rendering code imports the authoring plugins.

## Phase 4-5 verification

The isolated round trip now covers reviewed arc regeneration, preservation of a pinned camera during
shared tuning, switching cameras, portable recipe export, native actor selection, GUID/path protection,
batch approval, and disk/editor restart. It then renders Pure + Authored with only Core+Cameras enabled.
The native suite uses actual shared renderer sessions for visible/excluded/restored pixel comparisons
on both backends and checks clean-map restoration. The broader geometry and performance matrix remains
phase 6; these results do not establish Nanite, instances, translucency or World Partition streaming.
