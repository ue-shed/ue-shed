# Shared camera rendering API

Status: Implemented, unreleased — shared native lifecycle and first-party adapters are in place.
See [the public contract](../docs/products/camera-rendering.md) and
[validation evidence](../docs/research/shared-camera-rendering-2026-09-08.md) for the implemented
policy matrix, compatibility decisions, and remaining visual/readiness limitations. The sections
below retain the original proposal context; the product document describes the final API.

## Outcome

`@ue-shed/cameras` must render an explicit camera through either the editor viewport or
SceneCapture2D. Review authoring previews, durable Review captures, and map tiles must use the
same rendering lifecycle. They retain their own authoring, selection, assessment, and storage
contracts. A host must not assemble private Unreal calls to obtain this behavior.

## Existing implementation and constraints

- `review-capture.ts` / `CaptureReviewView` currently use `FUEShedTransientCapture` and an
  immediate SceneCapture render. Review capture also performs target resolution, visibility
  assessment, and optional Clear intervention. These are not renderer responsibilities.
- `map-tile-capture.ts` / `UEShedLitMapTileCapture.cpp` own a longer-lived viewport run with
  camera ownership, warmup, exposure, freezing, polling, lease expiry, and restoration.
- The map default is `lit_camera_tiles`. `viewport_high_resolution` is a separate whole-level
  experiment that captures and slices a large image; it is not the default viewport renderer.
- `scene_capture_tiles` has render profiles and LOD controls which the viewport path does not
  promise. Backend selection cannot imply feature or pixel equivalence.
- Existing uncommitted Review fixed-pose fallback work is a compatibility constraint. Preserve
  it during migration; do not overwrite it or reinterpret actor-relative views as fixed cameras.

## Boundaries

1. View realization turns a fixed pose or explicitly actor-relative view into an absolute camera.
   Fixed poses do not require a live actor. Actor identity remains provenance unless target
   tracking, framing, assessment, or intervention explicitly requires it.
2. Scene preparation controls required regions and Data Layers. It holds only resources it
   acquires. It does not infer project lighting actors or run gameplay to initialize a world.
3. Rendering owns camera realization, renderer configuration, settling, image acquisition, and
   restoration. It receives no Review Set, actor label, tile key, filter, or publication target.
4. Optional assessment measures subject visibility. It reports its own method and limitations;
   an auxiliary SceneCapture measurement must not be labeled as viewport-renderer truth.
5. Workflow adapters attach view/tile identities, validate staged bytes, and commit immutable
   artifacts through the existing repositories. Scheduling and remote publication stay outside.

## Public surface

Use Effect services and Effect Schema-inferred data types. The following signatures describe
the proposed boundary, not callable exports:

```ts
interface CameraRendererApi {
	capabilities(): Effect.Effect<CameraRenderCapabilities, CameraRenderError>;
	preflight(
		request: CameraRenderSessionRequest
	): Effect.Effect<CameraRenderPreflight, CameraRenderError>;
	open(
		request: CameraRenderSessionRequest
	): Effect.Effect<CameraRenderSession, CameraRenderError, Scope.Scope>;
}

interface CameraRenderSession {
	readonly id: CameraRenderSessionId;
	readonly resolvedPolicy: ResolvedCameraRenderPolicy;
	capture(request: CameraFrameRequest): Effect.Effect<CameraFrameResult, CameraRenderError>;
	progress: Stream.Stream<CameraRenderProgress, CameraRenderError>;
}
```

Provide a one-shot `renderCamera` convenience function implemented with `Effect.scoped`, not a
second implementation. Sessions amortize preparation and exposure across a bounded sequence of
frames. `open` acquires a native editor lease; its scope finalizer releases it. No optional release
callback and no caller-owned mutable started-run set in the new public interface.

Preflight is read-only and returns structured issues. It is advisory: `open` validates again while
acquiring ownership. Capability discovery is bound to the connected plugin and engine versions,
not inferred from the TypeScript package version.

### Request model

Reuse existing camera, vector, rotation, identifier, and map-path definitions where their semantics
match. Define and validate new shared structures once rather than duplicating Review schemas.

| Value           | Required semantics                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session request | Expected project/map identity, explicit renderer policy, preparation policy, exposure policy, settling policy, time policy, bounded timeout. Opening a different map is a separate explicit operation.                |
| Camera          | Absolute Unreal world position and rotation; projection union of perspective horizontal FOV or orthographic width. Output dimensions determine aspect ratio. Orthographic cameras do not carry a perspective FOV.     |
| Frame request   | Branded operation ID, camera, output dimensions, and optional bounded preparation region. No actor locator required.                                                                                                  |
| Output          | Initially PNG color at exact requested dimensions. Artifact descriptors use contained staging identities and relative paths, never caller-selected native output paths.                                               |
| Renderer        | Discriminated union: editor viewport settings or SceneCapture settings. Backend-specific options live in their branch.                                                                                                |
| Exposure        | Project automatic per frame, fixed EV100 with defined compensation semantics, or metered once at an explicit reference camera and then held for the session. A frozen exposure value is returned as evidence.         |
| Settling        | Explicit minimum rendered frames and elapsed-time deadline. Expose shader/streaming status where measurable; frame count alone is not a convergence guarantee.                                                        |
| Time            | Live editor time or explicitly supported scoped freeze. Report what is frozen; do not claim all simulation is deterministic.                                                                                          |
| Preparation     | Preserve current loading, or load explicit camera regions with bounds/budget. Data Layer selection is separate and explicit. Report ready, partial, unsupported, or failed rather than claiming frustum completeness. |

Renderer policy separates **renderer** from **screenshot strategy**. The viewport branch must
identify normal viewport screenshot versus high-resolution screenshot when supported, including
resolution limits and LOD implications. Map whole-level capture-and-slice remains a map adapter
strategy. SceneCapture exposes only implemented render profiles and controls. No arbitrary CVar
bag, no silently ignored fields, and no automatic fallback to another renderer.

Capabilities enumerate supported projections, screenshot strategies, output limits, exposure and
freeze modes, preparation operations, and assessment/intervention support. Unsupported combinations
produce field-addressed issues before mutation. Do not publish a capability until the native path
implements it and has conformance coverage.

### Results and failures

`CameraFrameResult` contains artifact descriptor, effective camera, requested and resolved renderer
policy, actual exposure, preparation evidence, settling counts/timing, engine/plugin versions, and
diagnostics. Distinguish image production from session cleanup. A captured image followed by failed
restoration is not an unqualified successful operation.

Typed error variants include unsupported policy, map mismatch, editor busy, viewport unavailable
or locked, preparation failure, settling timeout, capture failure, artifact validation failure,
and restoration failure. Each includes operation/session correlation and recovery context. Preserve
both the original failure and any cleanup failure. Retrying a timed-out transport request must
query the existing operation, not start another capture or report a second success.

The wire protocol is a versioned language-neutral schema with matching Effect decoders and C++
validation. Separate capability, begin, frame start/poll, and end operations; terminal frame
results remain queryable for a bounded retention period. Reusing an operation ID with different
input is rejected. Every queue and staging retention limit is explicit.

## Ownership and recovery

- One native coordinator serializes all mutations of the same editor world/viewport across
  Review, map tiles, previews, and separate host processes. Host-local Effect concurrency is
  insufficient. Reject conflicting owners with a typed busy result.
- Acquire only after checking PIE/SIE, viewport locks, and required capabilities. Neither backend
  starts Play. A visible rendering viewport requirement is explicit; headless host access does
  not mean NullRHI support.
- Snapshot affected camera/viewport configuration, show flags, realtime and screenshot settings,
  exposure, freeze state, and preparation ownership. Restore on normal completion, error,
  cancellation, inactivity lease expiry, world change, viewport loss, and plugin shutdown.
- Restore only state still owned by this session; do not unload pre-existing regions or undo
  unrelated user changes. If an invariant changes during capture, interrupt with an explicit
  restoration outcome. Never save project assets as a side effect.
- Reuse the existing Lit map lifecycle implementation rather than building another independent
  viewport manager. Extract its tile-independent responsibilities first.

## Workflow adoption and compatibility

Review previews and final captures use the same resolved render policy. A lower preview resolution
is explicit; it is not proof of identical temporal history or final pixels. Record differences.
Fixed-camera rendering proceeds without the original actor. Requested actor assessment can be
unavailable independently; required assessment failure follows the workflow's explicit policy.
Optional Clear remains a separately recorded result and never silently replaces the Natural image.

Map plans generate cameras and batches; the renderer does not know pyramid levels or crop gutters.
Keep session exposure/freeze across batches. Whole-level screenshots are validated against native
limits before capture, then sliced by the map workflow.

Renderer changes alter evidence identity. Persist the resolved choice and policy in immutable runs
and downstream reuse keys. Existing documents missing renderer information retain explicitly
legacy behavior; do not reinterpret them as viewport captures. New-profile defaults can choose the
proven Lit viewport path after live validation. Existing backend strings require explicit adapter
mappings and migration tests; they cannot be renamed into a two-value enum without preserving the
whole-level strategy. Old plugins return unsupported capability rather than silently falling back.

## Implementation sequence and acceptance

1. Finalize shared wire schemas, capability matrix, and request/result fixtures. Add decoder
   conformance and invalid-combination tests before exporting the service.
2. Extract the native lease, restoration, exposure, and screenshot lifecycle from Lit map capture.
   Keep old map endpoints as adapters and prove existing tile output/recovery regressions.
3. Add perspective viewport frames and adapt SceneCapture to the same lifecycle/result contract.
   Implement only advertised features; preserve existing SceneCapture profile semantics.
4. Implement scoped Effect service, progress, idempotent polling, and artifact validation. Test
   cancellation during preparation, warmup, capture, ingestion, and cleanup; test two independent
   hosts contending for the same editor.
5. Route Review preview and final rendering through the service; keep realization, assessment,
   Clear intervention, and repositories distinct. Route all map modes through adapters.
6. Expose the same policy and diagnostics through library, CLI, and reference UI. Validate packed
   consumer adoption; then release the native plugin and TypeScript packages together.

Live acceptance uses a generic fixture: same perspective and orthographic poses through both
renderers; fixed camera after subject removal; approved pose unchanged after subject movement;
policy-consistent preview/final; explicit exposure and warmup evidence; no accidental PIE; exact
dimensions and matching content digests; interruption and restart restoration; shared exposure
across tile batches; wrong-map/locked-viewport rejection; and preserved legacy run reading.
Visual comparison assesses useful scene rendering against a matching editor reference. It does
not assert pixel equivalence between renderers. A produced PNG is not by itself a quality pass.
