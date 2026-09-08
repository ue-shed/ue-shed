# `@ue-shed/cameras`

Headless camera observation and durable Map Review APIs. The package owns the versioned BGRA8 frame
decoder, bounded named-pipe server, latest-frame snapshots, subscriptions, host metrics, Remote
Control adapters, portable Review Set schemas, filesystem repository, and Capture Run orchestrator.
Electron is only one consumer; Workbench UI is never required.

The [shared rendering API](../../docs/products/camera-rendering.md) provides Effect-scoped
`CameraRenderer.open`, one-shot `renderCamera`, capability/preflight queries, bounded progress,
camera-region/Data Layer preparation, and validated artifact reads. Both perspective and
orthographic cameras work through explicit editor-viewport or SceneCapture policies. Review
previews/final captures and all map modes share the extracted native lifecycle and global ownership.
See the guide for CLI usage, compatibility, visual differences, and downstream adoption.

```sh
npm install --save-exact @ue-shed/cameras @ue-shed/unreal-connection @ue-shed/protocol
```

Node.js 22.14 or newer is required. Stable entry points:

```ts
import {
	ReviewCapture,
	ReviewRepository,
	callerOwnedReviewCaptureDestination,
	decodeReviewSet,
	generateFramingCandidates
} from "@ue-shed/cameras";
import { MapReviewResult } from "@ue-shed/cameras/review-contracts";
```

The live transport is deliberately disposable: it validates and resynchronizes the byte stream,
caps individual payloads, and retains at most one frame per camera. Scheduling and producer health
remain on the control plane. Durable review captures do not use this live buffer: the editor stages a
bounded one-shot PNG, then the host validates, hashes, and promotes it into an immutable local run.

Spatial authoring adds typed selection inspection, normalized subject bounds, modular arc/ring rig
generation, Context/Facade/Cardinal convenience presets, partial per-candidate overrides, transient
candidate previews, bounds-drift diagnostics, and explicit approval with recipe provenance. Counts
are positive integers without a Workbench-owned product cap: the pure generator returns the exact
requested set and never silently truncates it. Recipe v2 stores the parameters and group+index
anchor used for a kept View; existing recipe v1 documents remain readable. The generation,
session-tuning, and approval APIs remain usable from the CLI without Workbench.

The durable loop supports approved perspective poses, actor-path subjects, Pure PNG captures, honest
per-view failures, and atomic run publication. Review Sets normally live in
`.ue-shed/review/sets`; generated runs live in `.ue-shed/review/runs` and remain local by default.
Trusted hosts can pass `callerOwnedReviewCaptureDestination(existingAbsoluteRoot)` to one capture.
The adapter validates and exclusively creates the attempt before Unreal runs, owns contained
artifact ingestion and atomic publication, and rejects existing run identities and reparse-point
escapes. Unreal still stages only beneath the project's `Saved/UEShed/ReviewStaging` tree.
The language-neutral editor wire contract is under
`packages/protocol/contracts/cameras/review/v1`. Keep it green with
`pnpm --filter @ue-shed/cameras contract:check`.

For legacy/custom capture ports, `ReviewCapture.captureSet` (and `captureReviewSet`, including CLI capture) retries a fixed-camera
view once when Unreal returns a retry-safe `subject_not_found`. The retry uses the unchanged
approved position, rotation, FOV, and resolution with an `oriented_bounds` subject: saved framing
bounds for preset views, or a zero-extent marker at the camera position for manual views. The
original actor identity stays in the Review Set snapshot; the run records the region actually used
and a `visibility.status: "not_assessed"` reason identifying the saved-position fallback. A requested
Clear companion is recorded as failed while retaining Pure evidence. The compatibility retry was
designed for capture contract 1.5; it remains preserved. The current first-party path uses capture
1.6 and directly renders fixed cameras without requiring actor resolution or a retry.

Target-relative views still need their live actor. Initial framing still needs live bounds; a
shared render of an already-approved fixed pose does not. The compatibility fallback itself does not load
World Partition cells; shared rendering can apply explicit camera-region and Data Layer policies.
Transport errors and unrelated failures do not
trigger a position retry. Direct low-level `captureReviewView` requests retain their exact subject
semantics; the compatibility retry belongs to the Review Set capture workflow, which owns saved provenance.

This package does not depend on `@ue-shed/observatory` or `@ue-shed/observability`. World Scout's
USOT transform wire contract ships in `@ue-shed/protocol`; the Observatory host package remains a
separate later public surface.

Map Capture defaults to `lit_camera_tiles`: one transient CameraActor moves through the Lit editor
viewport, with vignette disabled, shared exposure, real frame warmup, and plugin-owned scene freezing.
The asynchronous Begin/Poll/End lifecycle retains ownership across batches and restores editor state
on completion or interruption, with a 120-second inactivity lease as a fallback. No game-code changes
are required. A rendering, unlocked editor viewport is required; subtle lighting joins can remain.
New plans use 16-pixel gutters and disable fog. Optional `capture.render.exposureEV100` fixes the
camera exposure range. Explicit `scene_capture_tiles` retains the older profiles and LOD scales;
`viewport_high_resolution` remains an experimental whole-level alternative. The CLI selects these
with `map-capture run --backend`; omitting the flag uses Lit camera tiles.

Generic Map Capture adds an external `Map Capture Plan`, exact tile-pyramid math and selection,
bounded orthographic editor capture, and immutable hashed manifests without changing Map Review's
`CaptureProfile` or perspective wire contract. Its language-neutral v1 contracts live under
`packages/protocol/contracts/cameras/map-tile/v1`. Completed runs live under
`.ue-shed/map-capture/runs`; Workbench-authored plans default to
`.ue-shed/map-capture/plans`; Unreal staging is accepted only from
`Saved/UEShed/MapTileStaging`. Plans independently control fog and volumetric fog and can retain
natural Unreal LOD behavior or provide one scene-capture LOD distance scale per zoom level. Capture
Z is placement only and never selects an LOD.
Trusted hosts may instead pass `callerOwnedMapCaptureDestination(existingAbsoluteRoot)`. Complete
runs publish beneath its `runs` tree, while partial and cancelled manifests remain beneath its
`attempts` tree; both retain the same containment, exclusive-creation, and atomic-promotion rules.

Review Capture and Map Capture outputs are portable local evidence. Downstream products may
correlate their stable identities and hashes externally; this package does not own an MB Map
Observation archive, daily scheduling, or studio retention policy.

```sh
ue-shed map-capture plan validate <project-root> <plan.json>
ue-shed map-capture inspect <project-root> <plan.json>
ue-shed map-capture run <project-root> <plan.json> <endpoint>
ue-shed map-capture run <project-root> <plan.json> <endpoint> --open-map
ue-shed map-capture run <project-root> <plan.json> <endpoint> --level 2 --level 3
ue-shed map-capture run <project-root> <plan.json> <endpoint> --tiles tile-keys.json
ue-shed map-capture runs <project-root> <plan-id>
```

Level/tile subsets are recovery or test attempts and are quarantined as partial; only an exhaustive
all-level run can be atomically published as complete. Map switching is a separate Core capability:

```sh
ue-shed editor world open <endpoint> /Game/Maps/Target
```

It refuses active PIE, missing maps, and dirty world packages instead of saving or discarding work.

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.

## Capture inspection and progress

`inspectMapCaptureSelection(endpoint)` returns combined finite component bounds, identities, and
skipped actor paths for 1–1024 selected editor actors. It does not replace single-actor Review
inspection or load unselected World Partition regions. `fitMapCapturePlanToSelection` applies XY
bounds and padding to a plan while retaining the caller's altitude.

`inspectMapCaptureReadiness(endpoint, mapPath)` reports Lit backend blockers without changing editor
state. The same checks guard Lit capture startup. Readiness is a point-in-time observation, not a
reservation or a guarantee that lighting or unloaded content is complete. New inspection calls
negotiate `cameras.capture-selection.v1` and `cameras.capture-readiness.v1` capabilities.

```sh
ue-shed map-capture selection http://127.0.0.1:30010
ue-shed map-capture readiness http://127.0.0.1:30010 /Game/Maps/Example
ue-shed map-capture plan from-selection /projects/example http://127.0.0.1:30010 ./selected-plan.json
```

The plan command uses ten percent XY padding and places the camera at least 1000 Unreal units above
the selected bounds. Review the generated plan before capture. Unavailable selection/readiness
returns CLI exit code 3. Capture progress callbacks optionally include `producer` with the batch's
phase, elapsed milliseconds, tile count and current tile. Older plugins can omit these fields.
CLI progress is newline-delimited JSON on stderr; final results remain JSON on stdout.
