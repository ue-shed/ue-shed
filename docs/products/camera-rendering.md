# Shared camera rendering

`@ue-shed/cameras` renders independent world-space cameras in an Unreal **editor world** through
`CameraRenderer.open` or the one-shot `renderCamera`. Both use the same native ownership and
restoration lifecycle as Review previews, final Review captures, and map captures. Play and Simulate
must be stopped. Workbench is optional.

## Public API

Open the map separately, discover `cameras.render-session.v1`, and call `capabilities()` and
`preflight(request)`. Preflight reports all known blockers without acquiring ownership. Begin
revalidates because editor state can change after preflight. Unsupported settings are rejected;
there is no automatic renderer fallback.

```ts
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import {
	CameraRenderer,
	CameraRenderSessionId,
	CameraFrameOperationId,
	cameraRenderContract,
	cameraRendererLayer,
	readCameraFrameArtifact,
	type CameraRenderSessionRequest
} from "@ue-shed/cameras";

// endpoint, mapPath, projectName, projectRoot and cameras come from the caller.
const request: CameraRenderSessionRequest = {
	contract: cameraRenderContract,
	sessionId: CameraRenderSessionId.make(randomUUID()),
	expectedMapPath: mapPath,
	expectedProjectName: projectName,
	leaseMs: 120000,
	maximumFrames: cameras.length,
	policy: {
		renderer: {
			kind: "editor_viewport",
			strategy: "high_resolution_screenshot",
			profile: "lit",
			vignette: "project",
			fog: true,
			volumetricFog: true
		},
		exposure: { mode: "project_auto" },
		settling: { minimumFrames: 32, timeoutMs: 120000 },
		time: "live_editor",
		preparation: {
			geometry: {
				mode: "camera_regions",
				maximumRegions: 64,
				extent: { x: 10000, y: 10000, z: 10000 }
			},
			dataLayers: []
		}
	}
};
const layer = cameraRendererLayer(endpoint).pipe(Layer.provide(RemoteControlClientLive));
const artifacts = await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const renderer = yield* CameraRenderer;
			const session = yield* renderer.open(request);
			const outputs = [];
			for (const camera of cameras) {
				const frame = yield* session.capture({
					contract: cameraRenderContract,
					sessionId: session.id,
					operationId: CameraFrameOperationId.make(randomUUID()),
					camera,
					size: { width: 1280, height: 720 }
				});
				outputs.push({
					frame,
					artifact: yield* readCameraFrameArtifact({ projectRoot, frame })
				});
			}
			return outputs;
		})
	).pipe(Effect.provide(layer))
);
// Restoration has succeeded. Publish these validated bytes and evidence to caller-owned storage.
```

Use `renderCamera({session: request, frame})` with the same layer for one frame. It opens and closes
the same scoped session. `session.progress` is a bounded stream of preparing, exposure warmup,
frame warmup, and capturing observations. Use Effect interruption to cancel; scope exit closes the
native owner. Session finalizer failures include the capture and restoration causes. The one-shot
API exposes them as `CameraRenderError`; scoped callers should handle the full Effect exit cause.

An `AbsoluteCamera` contains location, rotation, and either
`{kind: "perspective", horizontalFieldOfView: 60}` or
`{kind: "orthographic", width: 2400}`. Unreal uses centimeters, degrees, and horizontal field of
view. Output aspect ratio comes from width/height. Frames contain no actor identity.

The CLI uses the same one-shot implementation:

```sh
ue-shed camera render request.json --endpoint http://localhost:30010 --project /path/to/project --output new.png
```

`request.json` contains `{session, frame}`. The CLI validates the request, waits for restoration,
validates PNG dimensions and staging confinement, hashes the bytes, and writes a new output file
exclusively. It prints the artifact hash and rendering evidence. It does not overwrite an existing
file or open a map implicitly.

## Policies and capability limits

| Policy                            | Editor viewport                        | SceneCapture2D                                                 |
| --------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Projection                        | Perspective, orthographic              | Perspective, orthographic                                      |
| Profiles                          | Lit, observation                       | Full fidelity, seam stable, SceneCapture defaults, observation |
| Exposure                          | Project auto, fixed EV100, meter once  | Project auto, fixed EV100                                      |
| LOD distance scale                | Unsupported                            | Explicit 0.1–100                                               |
| Vignette                          | Project or disabled                    | Profile/project behavior                                       |
| Review depth assessment and Clear | Unsupported; Natural remains available | Existing assessment and component-list Clear                   |

Observation disables post processing and rejects exposure overrides. Fixed EV100 clamps exposure
while retaining project compensation. Meter once warms an explicit reference camera and locks its
measured exposure for the session. It does not re-meter each tile. `settling.initialView`, when
present, warms an explicit camera once before metering or frame settling; this preserves the Lit
map overview warmup even with a caller-specified EV. Settling has explicit frame and time bounds.
Evidence records the frames actually requested and elapsed time, with `convergence: not_assessed`.
Frame counting does not prove shader, temporal, lighting, or texture convergence.

`freeze_materials_and_ticks` uses the existing owned editor freeze after initial warmup/metering.
It freezes the supported material clocks and actor/component ticks; it does not initialize a game
or guarantee that every engine subsystem stops advancing. No arbitrary CVar bag is accepted.

`camera_regions` owns bounded World Partition loader references around the frame camera, or around
the explicit frame `region` override. The caller chooses extents that include the visible scene;
this is not frustum inference. Up to 64 distinct regions can be held until session close. A
non-partitioned world's existing geometry stays loaded. A metering/initial reference outside these
regions requires the caller to include that area in the supplied region. `preserve_loading` changes
no geometry loading and rejects frame region overrides.

Data Layer requirements identify existing assets and explicit loaded/visible states. Native
preflight rejects missing layers and duplicate identities, including asset-path aliases. Begin
verifies effective hierarchy state; callers must explicitly include required parent layers.
Restoration releases only owned region references and restores the layer settings it applied.
Independent editor loading responsibility is retained. Preparation evidence is deliberately partial:
it records held regions and applied layers without claiming complete scene visibility. There is no
studio lighting convention, gameplay bootstrap, or Play dependency.

## Ownership, failure, and artifacts

One native owner spans clients and workflows, including legacy Review and map adapters. The viewport
state machine was extracted from Lit map capture; there is no second viewport manager. It restores
the owned camera lock, transforms, projection, show flags, exposure, input, realtime override,
screenshot configuration, freeze, Data Layers, and region references on completion, failure,
cancellation, lease expiry, world change, Play startup, and plugin shutdown. External ownership
changes are reported as restoration failures rather than overwritten. Map dirty state is observed,
not forcibly cleared. No map is saved by rendering.

Begin is idempotent for an active identity with identical input. Frame operation IDs cannot be
reused for different input. Lost Start responses are reconciled by polling the same ID. The TS
session renews its lease while scoped; raw clients must renew by polling or repeating Begin. The
native watchdog bounds abandoned ownership to the requested 1–120 second lease. Deadlines are
checked between engine operations; synchronous Unreal loading and render calls cannot be preempted
mid-call. A stalled editor cannot service its watchdog until its game thread resumes.

Native staging retains at most 64 results per session and nine sessions, for at most 120 seconds
after each result, subject to earlier capacity eviction or shutdown. Consume staging promptly;
it is not durable storage. Expired identities cannot silently recapture. PNG paths remain beneath
`Saved/UEShed/CameraRenderStaging`. `readCameraFrameArtifact` validates real paths, byte count, PNG
header dimensions, and computes SHA-256. Review and map repositories additionally own publication
and immutable manifests. Publication follows successful restoration.

Evidence records effective camera, resolution, complete policy, exposure, preparation, settling,
dirty observations, and engine/plugin versions. `cameraRenderReuseIdentity` includes camera,
resolution, region, policy, renderer contract, engine/plugin versions, a caller-supplied scene
revision, and workflow identity. A downstream cache must include scene/content revision and Review
assessment/Clear settings in its workflow identity. Camera equality alone cannot establish reusable
pixels. Review and map runs remain immutable and do not automatically reuse older captures.

## Review, maps, and downstream adoption

Actor bounds remain an authoring dependency. A fixed approved pose bypasses actor realization at
capture; missing actor provenance yields `unresolved_actor` and unavailable assessment/Clear while
retaining Natural. A moved actor cannot move that camera. Target-relative viewpoints explicitly
resolve their actor and fail if unavailable. Review's saved pose document remains perspective;
orthographic cameras are available through the shared API and map workflows.

Review Set 1.3 adds `CaptureProfile.renderPolicy`. Preview and final capture use that same policy;
their deliberately different output sizes are recorded in preview realization and Capture Run 1.6
evidence. Capture wire 1.6 uses separate realization, render, and inspection stages. Legacy Review
Sets remain readable and absent policy resolves to historical SceneCapture defaults, project auto
exposure, one frame, live editor time, and preserved loading. Legacy wire 1.0–1.5 still works through
the shared native lifecycle. The existing saved-position retry remains available for legacy/custom
capture ports; it does not weaken actor-relative semantics or manufacture renderer evidence.

Map modes retain their distinct algorithms: `lit_camera_tiles` keeps one shared session across
four-tile batches, 512 overview warmup frames, 128 settling frames, shared exposure and owned freeze;
`viewport_high_resolution` remains the experimental bounded whole-level render-and-slice path;
`scene_capture_tiles` retains profiles, LOD scaling, seam-stable oversampling and bounded PNG encoding.
Map manifest 1.1 includes the actual renderer policy/evidence for each source render. Cropped,
downsampled and sliced tile dimensions are recorded separately from source frame dimensions.

Map capture responses honor the requested wire minor: 1.0 omits rendering evidence and 1.1 includes
it. The remote adapter requests 1.1 evidence from plugins advertising `cameras.render-session.v1`
and downgrades to 1.0 for released plugins. Legacy Lit release results may contain only
`{ released: true }`; shared-renderer plugins must explicitly report successful restoration.

Electroswag should install the next minor `@ue-shed/cameras`, protocol and connection package set
and the matching UEShedCore/UEShedCameras plugin bundle (planned **0.7.0** under the fixed release
group). Released 0.6.0 does not contain `cameras.render-session.v1`. Negotiate that capability and
the render contract instead of assuming a descriptor version is sufficient. The development build
used for validation still reports descriptor 0.6.0; it is an unreleased build of this change.

Electroswag can save a 1.3 profile policy, use `previewReviewCandidate` while authoring, and use
`captureReviewSet` for final views. For standalone absolute cameras it can use `renderCamera` or
`CameraRenderer.open` directly. It should show preparation/settling progress, preserve typed failure
and restoration context, and include the resolved policy in reuse keys. No Workbench integration or
studio-specific plugin is required. This change does not publish a release.

See [live validation and visual differences](../research/shared-camera-rendering-2026-09-08.md).
