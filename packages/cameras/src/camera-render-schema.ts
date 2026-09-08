import { Schema } from "effect";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const AssetPath = Schema.String.check(
	Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/),
	Schema.isMaxLength(1024)
);
const integer = (minimum: number, maximum: number) =>
	Schema.Int.check(Schema.isBetween({ minimum, maximum }));
export const CameraRenderSessionId = Id.pipe(Schema.brand("CameraRenderSessionId"));
export type CameraRenderSessionId = typeof CameraRenderSessionId.Type;
export const CameraFrameOperationId = Id.pipe(Schema.brand("CameraFrameOperationId"));
export type CameraFrameOperationId = typeof CameraFrameOperationId.Type;
export const CameraWorldVector = Schema.Struct({
	x: Schema.Finite,
	y: Schema.Finite,
	z: Schema.Finite
});
export const CameraWorldRotation = Schema.Struct({
	pitch: Schema.Finite,
	roll: Schema.Finite,
	yaw: Schema.Finite
});
export const CameraOutputSize = Schema.Struct({
	width: integer(16, 16384),
	height: integer(16, 16384)
});
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
export const CameraRenderRegion = Schema.Struct({
	center: CameraWorldVector,
	extent: Schema.Struct({
		x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 })),
		y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 })),
		z: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 }))
	})
});
export const CameraRendererPolicy = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("editor_viewport"),
		strategy: Schema.Literal("high_resolution_screenshot"),
		profile: Schema.Literals(["lit", "observation"]),
		vignette: Schema.Literals(["project", "disabled"]),
		fog: Schema.Boolean,
		volumetricFog: Schema.Boolean
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
		volumetricFog: Schema.Boolean
	})
]);
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
export const CameraRenderPolicy = Schema.Struct({
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
export const CameraRenderContract = Schema.Struct({
	name: Schema.Literal("ue-shed-camera-render"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
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
export const CameraFrameRequest = Schema.Struct({
	contract: CameraRenderContract,
	sessionId: CameraRenderSessionId,
	operationId: CameraFrameOperationId,
	camera: AbsoluteCamera,
	size: CameraOutputSize,
	region: Schema.optionalKey(CameraRenderRegion)
});
export type CameraFrameRequest = typeof CameraFrameRequest.Type;
export const CameraRenderIssue = Schema.Struct({
	code: Text,
	path: Text,
	message: Text,
	recovery: Text
});
export type CameraRenderIssue = typeof CameraRenderIssue.Type;
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
export const CameraRenderPreflight = Schema.Struct({
	status: Schema.Literals(["ready", "blocked"]),
	issues: Schema.Array(CameraRenderIssue)
});
export type CameraRenderPreflight = typeof CameraRenderPreflight.Type;
export const CameraRenderCapabilities = Schema.Struct({
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
export type CameraRenderCapabilities = typeof CameraRenderCapabilities.Type;
export const CameraRenderProgress = Schema.Struct({
	status: Schema.Literal("running"),
	sessionId: CameraRenderSessionId,
	operationId: CameraFrameOperationId,
	phase: Schema.Literals(["preparing", "exposure_warmup", "frame_warmup", "capturing"]),
	renderedFrames: integer(0, 1000000),
	elapsedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
});
export type CameraRenderProgress = typeof CameraRenderProgress.Type;
export const CameraFrameEvidence = Schema.Struct({
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
export const CameraFrameResult = Schema.Struct({
	status: Schema.Literal("captured"),
	sessionId: CameraRenderSessionId,
	operationId: CameraFrameOperationId,
	artifact: Schema.Struct({
		relativePath: Schema.String.check(
			Schema.isPattern(
				/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/
			)
		),
		bytes: Schema.Int.check(Schema.isGreaterThan(0)),
		width: integer(16, 16384),
		height: integer(16, 16384)
	}),
	evidence: CameraFrameEvidence
});
export type CameraFrameResult = typeof CameraFrameResult.Type;
export const CameraFrameStatus = Schema.Union([
	CameraRenderProgress,
	CameraFrameResult,
	CameraRenderFailure
]);
export type CameraFrameStatus = typeof CameraFrameStatus.Type;
export const CameraRenderBeginResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("opened"),
		sessionId: CameraRenderSessionId,
		resolvedPolicy: CameraRenderPolicy
	}),
	CameraRenderFailure
]);
export const CameraRenderEndResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("closed"),
		sessionId: CameraRenderSessionId,
		restoration: Schema.Literal("restored")
	}),
	CameraRenderFailure
]);

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
