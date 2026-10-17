import { Schema } from "effect";
import { CameraVisibilityList, CameraVisibilityDiagnostic } from "./camera-visibility.js";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const AssetPath = Schema.String.check(
	Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/u),
	Schema.isMaxLength(1024)
);
const integer = (minimum: number, maximum: number) =>
	Schema.Int.check(Schema.isBetween({ minimum, maximum }));
/**
 * Branded identifier for a scoped render session. Construct from validated input and preserve
 * it across related requests; an identifier alone does not prove that the resource exists or
 * is still current.
 */
export const CameraRenderSessionId = Id.pipe(Schema.brand("CameraRenderSessionId"));
export type CameraRenderSessionId = typeof CameraRenderSessionId.Type;
/**
 * Branded identifier for a correlated frame operation. Construct from validated input and
 * preserve it across related requests; an identifier alone does not prove that the resource
 * exists or is still current.
 */
export const CameraFrameOperationId = Id.pipe(Schema.brand("CameraFrameOperationId"));
export type CameraFrameOperationId = typeof CameraFrameOperationId.Type;
/**
 * Finite Unreal world-space XYZ coordinates. Values use Unreal world units; this schema does
 * not transform coordinate systems or infer a project origin.
 */
export const CameraWorldVector = Schema.Struct({
	x: Schema.Finite,
	y: Schema.Finite,
	z: Schema.Finite
});
/**
 * Finite Unreal pitch, yaw and roll in degrees. Rotation ordering and handedness follow
 * Unreal rather than a browser camera convention.
 */
export const CameraWorldRotation = Schema.Struct({
	pitch: Schema.Finite,
	roll: Schema.Finite,
	yaw: Schema.Finite
});
/**
 * Requested frame width/height in pixels, each from 16 through 16,384. Backend preflight can
 * impose stricter capability-dependent limits.
 */
export const CameraOutputSize = Schema.Struct({
	width: integer(16, 16384),
	height: integer(16, 16384)
});
/**
 * Explicit world location/rotation with perspective horizontal FOV in degrees or positive
 * orthographic width in world units. No editor viewport or subject is inferred.
 */
export const AbsoluteCamera = Schema.Struct({
	location: CameraWorldVector,
	rotation: CameraWorldRotation,
	projection: Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("perspective"),
			horizontalFieldOfView: Schema.Finite.check(
				Schema.isBetween({ minimum: 5, maximum: 170 })
			)
		}),
		Schema.Struct({
			kind: Schema.Literal("orthographic"),
			width: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1e9))
		})
	])
});
export type AbsoluteCamera = typeof AbsoluteCamera.Type;
/**
 * World-space preparation region defined by center and non-negative axis extents. Each extent
 * is bounded to ten million world units; this is a loading request, not a camera crop.
 */
export const CameraRenderRegion = Schema.Struct({
	center: CameraWorldVector,
	extent: Schema.Struct({
		x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 })),
		y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 })),
		z: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 }))
	})
});
/**
 * Opt-in: show child actors that ChildActorComponents spawn for editor-only owners. Absent means
 * false. Requires the `editorPreviews` render capability; older plugins reject the field.
 */
const EditorPreviews = Schema.optionalKey(Schema.Boolean);
/**
 * Explicit editor-viewport or scene-capture backend and its rendering settings. Backend
 * support must be negotiated; viewport screenshot and scene-capture profiles have different
 * fidelity/settling behavior.
 */
export const CameraRendererPolicy = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("editor_viewport"),
		strategy: Schema.Literal("high_resolution_screenshot"),
		profile: Schema.Literals(["lit", "observation"]),
		vignette: Schema.Literals(["project", "disabled"]),
		fog: Schema.Boolean,
		volumetricFog: Schema.Boolean,
		/** Native final-output viewport frames; absence preserves the engine/project setting. */
		screenshotWarmupFrames: Schema.optionalKey(integer(1, 256)),
		editorPreviews: EditorPreviews
	}),
	Schema.Struct({
		kind: Schema.Literal("scene_capture"),
		profile: Schema.Literals([
			"full_fidelity",
			"seam_stable",
			"scene_capture_defaults",
			"observation"
		]),
		lodDistanceScale: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 100 })),
		fog: Schema.Boolean,
		volumetricFog: Schema.Boolean,
		editorPreviews: EditorPreviews
	})
]);
export type CameraRendererPolicy = Schema.Schema.Type<typeof CameraRendererPolicy>;
/**
 * Project auto exposure, explicit EV100 or one-time metering from a reference camera.
 * Metering includes a reference size and minimum rendered-frame budget; it is not a fixed
 * sleep.
 */
export const CameraExposurePolicy = Schema.Union([
	Schema.Struct({ mode: Schema.Literal("project_auto") }),
	Schema.Struct({
		mode: Schema.Literal("fixed_ev100"),
		ev100: Schema.Finite.check(Schema.isBetween({ minimum: -20, maximum: 30 })),
		compensation: Schema.Literal("project")
	}),
	Schema.Struct({
		mode: Schema.Literal("meter_once"),
		referenceCamera: AbsoluteCamera,
		referenceSize: CameraOutputSize,
		minimumFrames: integer(1, 4096)
	})
]);
/**
 * Geometry-loading and explicit data-layer preparation policy. preserve_loading retains
 * current loading; camera_regions bounds held regions, and data-layer changes are scoped to
 * rendering.
 */
export const CameraPreparationPolicy = Schema.Struct({
	geometry: Schema.Union([
		Schema.Struct({ mode: Schema.Literal("preserve_loading") }),
		Schema.Struct({
			mode: Schema.Literal("camera_regions"),
			maximumRegions: integer(1, 64),
			extent: CameraRenderRegion.fields.extent
		})
	]),
	dataLayers: Schema.Array(
		Schema.Struct({
			assetPath: AssetPath,
			loaded: Schema.Boolean,
			visible: Schema.Boolean
		})
	).check(Schema.isMaxLength(64))
});
/**
 * Complete rendering policy: backend, exposure, frame settling, time behavior and
 * preparation, with optional authored visibility. Hosts own these choices; the renderer
 * validates support before applying them.
 */
export const CameraRenderPolicy = Schema.Struct({
	visibility: Schema.optionalKey(CameraVisibilityList),
	renderer: CameraRendererPolicy,
	exposure: CameraExposurePolicy,
	settling: Schema.Struct({
		minimumFrames: integer(1, 4096),
		timeoutMs: integer(1000, 900000),
		initialView: Schema.optionalKey(
			Schema.Struct({
				camera: AbsoluteCamera,
				size: CameraOutputSize,
				minimumFrames: integer(1, 4096)
			})
		)
	}),
	time: Schema.Literals(["live_editor", "freeze_materials_and_ticks"]),
	preparation: CameraPreparationPolicy
});
export type CameraRenderPolicy = typeof CameraRenderPolicy.Type;
/**
 * Camera-render wire contract identifier and version 1.0. This version is independent of
 * review-set, review-capture and map-tile contracts.
 */
export const CameraRenderContract = Schema.Struct({
	name: Schema.Literal("ue-shed-camera-render"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
/**
 * Explicit rendering session identity, expected map/project, policy, lease in milliseconds
 * and frame budget. Opening a session acquires temporary editor state that must be restored
 * on close.
 */
export const CameraRenderSessionRequest = Schema.Struct({
	contract: CameraRenderContract,
	sessionId: CameraRenderSessionId,
	expectedMapPath: AssetPath,
	expectedProjectName: Text,
	policy: CameraRenderPolicy,
	leaseMs: integer(1000, 120000),
	maximumFrames: integer(1, 1000000)
});
export type CameraRenderSessionRequest = typeof CameraRenderSessionRequest.Type;
/**
 * Correlated frame operation within an open render session, including absolute camera and
 * pixel size. Optional preparation region does not change the requested projection.
 */
export const CameraFrameRequest = Schema.Struct({
	contract: CameraRenderContract,
	sessionId: CameraRenderSessionId,
	operationId: CameraFrameOperationId,
	camera: AbsoluteCamera,
	size: CameraOutputSize,
	region: Schema.optionalKey(CameraRenderRegion)
});
export type CameraFrameRequest = typeof CameraFrameRequest.Type;
/**
 * Structured preflight/runtime issue with code, policy path, message and recovery. Hosts can
 * surface actionable validation without parsing prose for the failing field.
 */
export const CameraRenderIssue = Schema.Struct({
	code: Text,
	path: Text,
	message: Text,
	recovery: Text
});
export type CameraRenderIssue = typeof CameraRenderIssue.Type;
/**
 * Stable rendering failure categories covering validation, capability, editor state, budgets,
 * capture, restoration and operation/session identity. Match code rather than message text.
 */
export const CameraRenderFailureCode = Schema.Literals([
	"invalid_policy",
	"invalid_frame",
	"invalid_region",
	"unsupported_policy",
	"unsupported_size",
	"editor_required",
	"rendering_unavailable",
	"map_mismatch",
	"project_mismatch",
	"editor_busy",
	"authoring_open",
	"viewport_unavailable",
	"viewport_locked",
	"preparation_failed",
	"preparation_budget_exceeded",
	"frame_budget_exceeded",
	"world_changed",
	"lease_expired",
	"settling_timeout",
	"exposure_unavailable",
	"capture_failed",
	"artifact_invalid",
	"restoration_failed",
	"cancelled",
	"session_unknown",
	"session_closed",
	"session_conflict",
	"operation_unknown",
	"operation_expired",
	"operation_conflict"
]);
/**
 * Failed rendering outcome retaining session/operation context and restoration status.
 * restoration=failed requires reconciliation of editor state before beginning another render.
 */
export const CameraRenderFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	code: CameraRenderFailureCode,
	message: Text,
	recovery: Text,
	sessionId: Text,
	operationId: Schema.optionalKey(Text),
	issues: Schema.Array(CameraRenderIssue),
	restoration: Schema.Literals(["not_acquired", "restored", "failed"])
});
export type CameraRenderFailure = typeof CameraRenderFailure.Type;
/**
 * Ready or blocked policy assessment with structured issues. A ready assessment is validation
 * evidence rather than a guarantee that world state cannot change before capture.
 */
export const CameraRenderPreflight = Schema.Struct({
	status: Schema.Literals(["ready", "blocked"]),
	issues: Schema.Array(CameraRenderIssue)
});
export type CameraRenderPreflight = typeof CameraRenderPreflight.Type;
/** Original capability response, retained for previously shipped strict v1 clients. */
export const CameraRenderCapabilitiesV1 = Schema.Struct({
	authoredVisibility: Schema.optionalKey(
		Schema.Struct({
			version: Schema.Literal(1),
			maximumActorsPerList: Schema.Literal(256),
			geometry: Schema.Literal("loaded_non_nanite_opaque_static_mesh_actors"),
			viewport: Schema.Boolean,
			sceneCapture: Schema.Boolean
		})
	),
	editorPreviews: Schema.optionalKey(
		Schema.Struct({
			version: Schema.Literal(1),
			subjects: Schema.Literal("child_actors_of_editor_only_owners"),
			viewport: Schema.Boolean,
			sceneCapture: Schema.Boolean
		})
	),
	contract: CameraRenderContract,
	engineVersion: Text,
	pluginVersion: Text,
	projectName: Text,
	renderers: Schema.Array(
		Schema.Struct({
			profiles: Schema.Array(
				Schema.Literals([
					"lit",
					"full_fidelity",
					"seam_stable",
					"scene_capture_defaults",
					"observation"
				])
			),
			reviewAssessment: Schema.Array(Schema.Literals(["depth_compare", "ray_samples"])),
			reviewClear: Schema.Array(Schema.Literals(["isolate_target", "hide_explicit"])),
			kind: Schema.Literals(["editor_viewport", "scene_capture"]),
			projections: Schema.Array(Schema.Literals(["perspective", "orthographic"])),
			strategies: Schema.Array(
				Schema.Literals(["high_resolution_screenshot", "render_target"])
			),
			exposure: Schema.Array(Schema.Literals(["project_auto", "fixed_ev100", "meter_once"])),
			maximumDimension: integer(16, 16384)
		})
	),
	preparation: Schema.Array(
		Schema.Literals(["preserve_loading", "camera_regions", "editor_data_layers"])
	),
	freeze: Schema.Array(Schema.Literal("freeze_materials_and_ticks")),
	maximumRetainedOperations: integer(1, 64),
	maximumRetainedSessions: integer(1, 9),
	retentionMs: integer(1000, 120000)
});
/** V2 capability discovery; render requests and frame evidence retain contract 1.0. */
export const CameraRenderCapabilities = CameraRenderCapabilitiesV1.mapFields((fields) => ({
	...fields,
	highResolutionScreenshot: Schema.optionalKey(
		Schema.Struct({
			version: Schema.Literal(1),
			maximumWarmupFrames: integer(1, 256)
		})
	)
}));
export type CameraRenderCapabilities = typeof CameraRenderCapabilities.Type;
/**
 * Running frame operation with preparation/exposure/warmup/capture phase, rendered-frame
 * count and elapsed milliseconds. Poll by the same session/operation identities rather than
 * replaying capture.
 */
export const CameraRenderProgress = Schema.Struct({
	status: Schema.Literal("running"),
	sessionId: CameraRenderSessionId,
	operationId: CameraFrameOperationId,
	phase: Schema.Literals(["preparing", "exposure_warmup", "frame_warmup", "capturing"]),
	renderedFrames: integer(0, 1000000),
	elapsedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
});
export type CameraRenderProgress = typeof CameraRenderProgress.Type;
/**
 * Realized camera, size, policy, exposure, preparation/settling and editor dirty-state
 * evidence for a frame. Preserve limitations and visibility diagnostics when presenting
 * capture fidelity.
 */
export const CameraFrameEvidence = Schema.Struct({
	visibilityDiagnostics: Schema.optionalKey(Schema.Array(CameraVisibilityDiagnostic)),
	/** Present when the policy enables editor previews: preview child actors shown in the loaded world. */
	editorPreviews: Schema.optionalKey(Schema.Struct({ revealedChildActors: integer(0, 1000000) })),
	editorState: Schema.Struct({
		mapPackageDirtyBefore: Schema.Boolean,
		mapPackageDirtyAfter: Schema.Boolean
	}),
	camera: AbsoluteCamera,
	size: CameraOutputSize,
	policy: CameraRenderPolicy,
	exposureEV100: Schema.NullOr(Schema.Finite),
	preparation: Schema.Struct({
		status: Schema.Literals(["preserved", "ready", "partial"]),
		regionsHeld: integer(0, 64),
		dataLayersApplied: integer(0, 64),
		limitations: Schema.Array(Text)
	}),
	settling: Schema.Struct({
		renderedFrames: integer(0, 1000000),
		elapsedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
		convergence: Schema.Literal("not_assessed")
	}),
	engineVersion: Text,
	pluginVersion: Text
});
export type CameraFrameEvidence = typeof CameraFrameEvidence.Type;
/**
 * Captured PNG artifact metadata and realized frame evidence, correlated to
 * session/operation. The artifact path is relative to the capture root; byte count and
 * dimensions must be verified when ingesting it.
 */
export const CameraFrameResult = Schema.Struct({
	status: Schema.Literal("captured"),
	sessionId: CameraRenderSessionId,
	operationId: CameraFrameOperationId,
	artifact: Schema.Struct({
		relativePath: Schema.String.check(
			Schema.isPattern(
				/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/u
			)
		),
		bytes: Schema.Int.check(Schema.isGreaterThan(0)),
		width: integer(16, 16384),
		height: integer(16, 16384)
	}),
	evidence: CameraFrameEvidence
});
export type CameraFrameResult = typeof CameraFrameResult.Type;
/**
 * Discriminated running, captured or failed frame outcome. Polling can continue only while
 * running; failures include restoration guidance rather than an implicit retry.
 */
export const CameraFrameStatus = Schema.Union([
	CameraRenderProgress,
	CameraFrameResult,
	CameraRenderFailure
]);
export type CameraFrameStatus = typeof CameraFrameStatus.Type;
/**
 * Opened render session with its resolved policy or a typed failed outcome. Only opened
 * grants a session whose temporary editor state needs explicit/scoped release.
 */
export const CameraRenderBeginResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("opened"),
		sessionId: CameraRenderSessionId,
		resolvedPolicy: CameraRenderPolicy
	}),
	CameraRenderFailure
]);
/**
 * Closed session with confirmed restoration or a failed outcome. A failed restoration must
 * remain visible instead of being treated as successful cleanup.
 */
export const CameraRenderEndResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("closed"),
		sessionId: CameraRenderSessionId,
		restoration: Schema.Literal("restored")
	}),
	CameraRenderFailure
]);

/**
 * Literal camera-render 1.0 header for request construction. Capability support and
 * per-request validation remain required before using the renderer.
 */
export const cameraRenderContract = {
	name: "ue-shed-camera-render",
	version: { major: 1, minor: 0 }
} as const;

/** No renderer substitution. Missing policy retains the historical Review SceneCapture defaults. */
export const legacyReviewRenderPolicy: CameraRenderPolicy = {
	renderer: {
		kind: "scene_capture",
		profile: "scene_capture_defaults",
		lodDistanceScale: 1,
		fog: true,
		volumetricFog: true
	},
	exposure: { mode: "project_auto" },
	settling: { minimumFrames: 1, timeoutMs: 120000 },
	time: "live_editor",
	preparation: { geometry: { mode: "preserve_loading" }, dataLayers: [] }
};

/**
 * Default lit editor-viewport high-resolution screenshot policy, preserving project vignette
 * and enabling fog. Hosts can replace this policy; backend availability still requires
 * preflight.
 */
export const highResolutionReviewRenderer = {
	kind: "editor_viewport",
	strategy: "high_resolution_screenshot",
	profile: "lit",
	vignette: "project",
	fog: true,
	volumetricFog: true
} as const satisfies CameraRendererPolicy;

/**
 * Explicit per-run choice; saved exposure, loading, time, and profile documents remain intact.
 * The choice picks a backend, not what the shot contains, so a saved `editorPreviews` carries over
 * unless the per-run renderer sets it explicitly.
 */
export function reviewCaptureRenderPolicy(
	saved: CameraRenderPolicy | undefined,
	renderer?: CameraRendererPolicy
): CameraRenderPolicy {
	const policy = saved ?? legacyReviewRenderPolicy;
	const editorPreviews = policy.renderer.editorPreviews;
	return renderer === undefined
		? policy
		: {
				...policy,
				renderer:
					renderer.editorPreviews === undefined && editorPreviews !== undefined
						? { ...renderer, editorPreviews }
						: renderer,
				settling: {
					...policy.settling,
					minimumFrames:
						renderer.kind === "editor_viewport"
							? Math.max(8, policy.settling.minimumFrames)
							: policy.settling.minimumFrames
				}
			};
}
