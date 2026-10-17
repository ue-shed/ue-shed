import { contractParser } from "@ue-shed/protocol";
import { ProvisionedCameraBinding } from "./provisioned-cameras-live.js";
import { CameraPanelAction, CameraPanelState } from "./camera-authoring-panel-schema.js";
import { CameraRecoveryChoice, CameraRecoveryProposal } from "./camera-authoring-recovery.js";
import { CameraArrangementId, CameraEditScope, CameraLayout } from "./camera-arrangement.js";
import { Schema } from "effect";
import {
	CameraFrameEvidence,
	CameraRenderPolicy,
	CameraRendererPolicy
} from "./camera-render-schema.js";
import { ReviewCaptureBlock } from "./review-session-policy.js";
import {
	CaptureInvocationCause,
	CapturedReviewViewRevision,
	ClearCompanionResult,
	FramingDiagnostic,
	ReviewAuthoringSession,
	ReviewAuthoringSessionPatch,
	ReviewSubjectProjection,
	VisibilityOverrides,
	VisibilityPolicy,
	VisibilityResult
} from "./review-schema.js";

export { ReviewSubjectActorGuid } from "./review-schema.js";

const IpcFailure = Schema.Struct({ message: Schema.String, recovery: Schema.String });
const IpcPose = Schema.Struct({
	aspectRatio: Schema.Literal("16:9"),
	fieldOfViewDegrees: Schema.Number,
	location: Schema.Struct({ x: Schema.Number, y: Schema.Number, z: Schema.Number }),
	projection: Schema.Literal("perspective"),
	rotation: Schema.Struct({ pitch: Schema.Number, roll: Schema.Number, yaw: Schema.Number })
});

/**
 * UI-neutral captured-view payload with image bytes, view revision, invocation and visibility
 * evidence. Retains pure/clear/authored variants rather than replacing history with a single
 * thumbnail.
 */
export const MapReviewRunCapture = Schema.Struct({
	artifacts: Schema.Array(
		Schema.Struct({
			bytes: Schema.Uint8Array,
			height: Schema.Int.check(Schema.isGreaterThan(0)),
			variant: Schema.Literals(["pure", "clear", "authored"]),
			width: Schema.Int.check(Schema.isGreaterThan(0))
		})
	),
	cause: CaptureInvocationCause,
	clearCompanion: ClearCompanionResult,
	viewId: Schema.String,
	viewName: Schema.String,
	viewRevision: CapturedReviewViewRevision,
	visibility: VisibilityResult,
	visibilityOverrides: Schema.optional(VisibilityOverrides),
	visibilityPolicy: Schema.optional(VisibilityPolicy)
});
export type MapReviewRunCapture = Schema.Schema.Type<typeof MapReviewRunCapture>;

/**
 * Failed view message tied to view identity and captured revision. Hosts retain these
 * alongside successful views when a run only partially succeeds.
 */
export const MapReviewRunFailure = Schema.Struct({
	message: Schema.NonEmptyString,
	viewId: Schema.NonEmptyString,
	viewRevision: CapturedReviewViewRevision
});
export type MapReviewRunFailure = Schema.Schema.Type<typeof MapReviewRunFailure>;

/**
 * Capture-run presentation with complete capture/failure collections and aggregate status.
 * Legacy first-capture/preview fields remain optional for older consumers.
 */
export const MapReviewRunView = Schema.Struct({
	/** First capture retained for older consumers; new UI uses the complete captures collection. */
	capture: Schema.optional(MapReviewRunCapture),
	captures: Schema.optional(Schema.Array(MapReviewRunCapture)),
	completedAt: Schema.String,
	failedViews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	failures: Schema.optional(Schema.Array(MapReviewRunFailure)),
	id: Schema.String,
	preview: Schema.optional(
		Schema.Struct({
			bytes: Schema.Uint8Array,
			height: Schema.Int.check(Schema.isGreaterThan(0)),
			viewName: Schema.String,
			width: Schema.Int.check(Schema.isGreaterThan(0))
		})
	),
	status: Schema.Literals(["completed", "completed_with_failures", "failed"]),
	successfulViews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type MapReviewRunView = Schema.Schema.Type<typeof MapReviewRunView>;

/**
 * Resolved view capture plan including pixel resolution and optional pose/policy/subject
 * evidence. This is planned work rather than confirmation that the editor can capture it.
 */
export const MapReviewCapturePlanView = Schema.Struct({
	renderPolicy: Schema.optionalKey(CameraRenderPolicy),
	actorPath: Schema.optional(Schema.String),
	captureProfileId: Schema.optional(Schema.NonEmptyString),
	displayName: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	revision: Schema.optional(Schema.Struct({ id: Schema.NonEmptyString, number: Schema.Int })),
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isGreaterThan(0)),
		width: Schema.Int.check(Schema.isGreaterThan(0))
	}),
	subjectLabel: Schema.optional(Schema.NonEmptyString),
	viewpoint: Schema.optional(Schema.Literals(["world_fixed", "target_relative"])),
	visibilityOverrides: Schema.optional(VisibilityOverrides),
	visibilityPolicy: Schema.optional(VisibilityPolicy)
});
export type MapReviewCapturePlanView = Schema.Schema.Type<typeof MapReviewCapturePlanView>;

const MapReviewReadyResult = Schema.Struct({
	status: Schema.Literal("ready"),
	reviewSet: Schema.Struct({
		displayName: Schema.String,
		id: Schema.NonEmptyString,
		mapPath: Schema.String,
		viewCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		views: Schema.Array(MapReviewCapturePlanView)
	}),
	runs: Schema.Array(MapReviewRunView)
});

/**
 * Host review state: unconfigured, setup required, blocked, failed or ready. Features render
 * the discriminated state and use the shell's project rather than adding another picker.
 */
export const MapReviewResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("setup_required") }),
	Schema.Struct({ status: Schema.Literal("blocked"), policy: ReviewCaptureBlock }),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure }),
	MapReviewReadyResult
]);
export type MapReviewResult = Schema.Schema.Type<typeof MapReviewResult>;

/**
 * Review-set listing with ID, display name, map and view count. Loading the set remains
 * necessary to inspect its approved definitions and policies.
 */
export const MapReviewSetSummary = Schema.Struct({
	displayName: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	mapPath: Schema.NonEmptyString,
	viewCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type MapReviewSetSummary = Schema.Schema.Type<typeof MapReviewSetSummary>;

/**
 * Unconfigured, failed or ready review-set library with optional active set ID. Selecting a
 * review set is separate from selecting a host project.
 */
export const MapReviewSetLibraryResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure }),
	Schema.Struct({
		activeReviewSetId: Schema.optional(Schema.NonEmptyString),
		sets: Schema.Array(MapReviewSetSummary),
		status: Schema.Literal("ready")
	})
]);
export type MapReviewSetLibraryResult = Schema.Schema.Type<typeof MapReviewSetLibraryResult>;

/**
 * Explicit display name, bounded to 80 characters, for creating a review set. The host
 * supplies selected-project/map context; no project path is accepted from the feature UI.
 */
export const MapReviewSetCreateIntent = Schema.Struct({
	displayName: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(80)))
});
export type MapReviewSetCreateIntent = Schema.Schema.Type<typeof MapReviewSetCreateIntent>;

/**
 * Identity of a review set to activate within the host's current project. The handler must
 * validate membership rather than changing project selection to follow the ID.
 */
export const MapReviewSetSelectIntent = Schema.Struct({ reviewSetId: Schema.NonEmptyString });
export type MapReviewSetSelectIntent = Schema.Schema.Type<typeof MapReviewSetSelectIntent>;

/**
 * Non-empty view subset and optional renderer policy for an explicit capture action. This
 * intent does not silently capture every view or select a project.
 */
export const MapReviewCaptureIntent = Schema.Struct({
	renderer: Schema.optionalKey(CameraRendererPolicy),
	viewIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
});
export type MapReviewCaptureIntent = Schema.Schema.Type<typeof MapReviewCaptureIntent>;

/**
 * Explicit view and replacement visibility policy with optional overrides. The host validates
 * membership/current state before writing an approved definition.
 */
export const MapReviewReplaceVisibilityPolicyIntent = Schema.Struct({
	policy: VisibilityPolicy,
	viewId: Schema.NonEmptyString,
	visibilityOverrides: Schema.optional(VisibilityOverrides)
});
export type MapReviewReplaceVisibilityPolicyIntent = Schema.Schema.Type<
	typeof MapReviewReplaceVisibilityPolicyIntent
>;

/**
 * Applies an existing policy ID to one through 64 explicit view IDs. The policy and views
 * must belong to the current review set.
 */
export const MapReviewApplyVisibilityPolicyIntent = Schema.Struct({
	policyId: Schema.NonEmptyString,
	viewIds: Schema.Array(Schema.NonEmptyString).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(64)
	)
});
export type MapReviewApplyVisibilityPolicyIntent = Schema.Schema.Type<
	typeof MapReviewApplyVisibilityPolicyIntent
>;

const CaptureJobFields = {
	context: Schema.Literal("editor"),
	jobId: Schema.NonEmptyString,
	progress: Schema.Struct({
		completedViews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		totalViews: Schema.Int.check(Schema.isGreaterThan(0))
	}),
	viewIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
};

/**
 * Completed host capture job with run ID, completion time and successful/failed view counts.
 * Completed can still include per-view failures; inspect the run evidence.
 */
export const MapReviewCaptureCompletedJob = Schema.Struct({
	...CaptureJobFields,
	status: Schema.Literal("completed"),
	completedAt: Schema.String,
	failedViews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	runId: Schema.NonEmptyString,
	successfulViews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type MapReviewCaptureCompletedJob = Schema.Schema.Type<typeof MapReviewCaptureCompletedJob>;

/**
 * Queued, running, cancelling, cancelled, completed or failed capture job. Cancellation is a
 * lifecycle state, not evidence that a potentially applied editor mutation was rolled back.
 */
export const MapReviewCaptureJobState = Schema.Union([
	Schema.Struct({ ...CaptureJobFields, status: Schema.Literal("queued") }),
	Schema.Struct({ ...CaptureJobFields, status: Schema.Literal("running") }),
	Schema.Struct({ ...CaptureJobFields, status: Schema.Literal("cancelling") }),
	Schema.Struct({ ...CaptureJobFields, status: Schema.Literal("cancelled") }),
	MapReviewCaptureCompletedJob,
	Schema.Struct({
		...CaptureJobFields,
		status: Schema.Literal("failed"),
		error: IpcFailure
	})
]);
export type MapReviewCaptureJobState = Schema.Schema.Type<typeof MapReviewCaptureJobState>;

/**
 * Unconfigured, blocked, failed or completed capture action outcome. A completed response
 * includes the resulting job and refreshed review state.
 */
export const MapReviewCaptureResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("blocked"), policy: ReviewCaptureBlock }),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure }),
	Schema.Struct({
		status: Schema.Literal("completed"),
		job: MapReviewCaptureCompletedJob,
		review: MapReviewReadyResult
	})
]);
export type MapReviewCaptureResult = Schema.Schema.Type<typeof MapReviewCaptureResult>;

/**
 * Serializable approved perspective pose for review IPC. Shares the validated pose contract
 * rather than accepting arbitrary untyped camera coordinates.
 */
export const MapReviewPose = IpcPose;
export type MapReviewPose = Schema.Schema.Type<typeof MapReviewPose>;

/**
 * Candidate pose/recipe diagnostics with pending, ready or failed preview state. Ready bytes
 * retain format/context metadata so BGRA previews are not mistaken for PNG artifacts.
 */
export const MapReviewAuthoringCandidate = Schema.Struct({
	diagnostics: Schema.Array(FramingDiagnostic),
	displayName: Schema.String,
	id: Schema.String,
	pose: IpcPose,
	preset: Schema.String,
	preview: Schema.Union([
		Schema.Struct({
			status: Schema.Literal("ready"),
			bytes: Schema.Uint8Array,
			cameraIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
			height: Schema.Int.check(Schema.isGreaterThan(0)),
			pixelFormat: Schema.optional(Schema.Literals(["png", "bgra8"])),
			previewContext: Schema.optional(Schema.Literals(["editor_live", "play_live"])),
			width: Schema.Int.check(Schema.isGreaterThan(0))
		}),
		Schema.Struct({ status: Schema.Literal("pending") }),
		Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
	])
});
export type MapReviewAuthoringCandidate = Schema.Schema.Type<typeof MapReviewAuthoringCandidate>;

/**
 * Ready candidate image with optional render/projection diagnostics, or typed host failure.
 * Preview is authoring evidence rather than an approved historical capture.
 */
export const MapReviewCandidatePreviewResult = Schema.Union([
	Schema.Struct({
		renderEvidence: Schema.optionalKey(CameraFrameEvidence),
		status: Schema.Literal("ready"),
		bytes: Schema.Uint8Array,
		cameraIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		height: Schema.Int.check(Schema.isGreaterThan(0)),
		diagnostics: Schema.optional(Schema.Array(FramingDiagnostic)),
		pixelFormat: Schema.optional(Schema.Literals(["png", "bgra8"])),
		previewContext: Schema.optional(Schema.Literals(["editor_live", "play_live"])),
		projection: Schema.optional(ReviewSubjectProjection),
		width: Schema.Int.check(Schema.isGreaterThan(0))
	}),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure })
]);
export type MapReviewCandidatePreviewResult = Schema.Schema.Type<
	typeof MapReviewCandidatePreviewResult
>;

/**
 * Ready candidate/session state, explicit map mismatch or failure. A mismatch exposes
 * matching set/recovery context; it must not silently switch the host's selected project.
 */
export const MapReviewAuthoringResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure }),
	Schema.Struct({
		status: Schema.Literal("map_mismatch"),
		matchingReviewSet: Schema.optional(MapReviewSetSummary),
		recovery: Schema.String,
		reviewSet: MapReviewSetSummary,
		selection: Schema.Struct({
			actorPath: Schema.String,
			displayName: Schema.String,
			mapPath: Schema.String
		})
	}),
	Schema.Struct({
		status: Schema.Literal("ready"),
		candidates: Schema.Array(MapReviewAuthoringCandidate),
		selection: Schema.Struct({
			actorPath: Schema.String,
			displayName: Schema.String,
			mapPath: Schema.String
		}),
		session: Schema.optional(ReviewAuthoringSession),
		sessionId: Schema.optional(Schema.String),
		recovery: Schema.optional(Schema.String),
		viewId: Schema.String
	})
]);
export type MapReviewAuthoringResult = Schema.Schema.Type<typeof MapReviewAuthoringResult>;

/**
 * Append or revise a named view using current editor selection, with explicit review-set
 * mode. Selection-derived map context must remain separate from host project ownership.
 */
export const MapReviewAuthorFromSelectionIntent = Schema.Struct({
	destination: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("append_view") }),
		Schema.Struct({ kind: Schema.Literal("revise_view"), viewId: Schema.NonEmptyString })
	]),
	reviewSetMode: Schema.optional(Schema.Literals(["active", "selection_map"]))
});
export type MapReviewAuthorFromSelectionIntent = Schema.Schema.Type<
	typeof MapReviewAuthorFromSelectionIntent
>;

/**
 * Persisted authoring-session identity for an explicit recovery/session action. The host
 * validates it against the current project and review set.
 */
export const MapReviewAuthoringSessionIntent = Schema.Struct({ sessionId: Schema.NonEmptyString });
export type MapReviewAuthoringSessionIntent = Schema.Schema.Type<
	typeof MapReviewAuthoringSessionIntent
>;

/**
 * Session identity plus an explicit draft/candidate patch. Patching does not itself approve a
 * view or trigger capture.
 */
export const MapReviewAuthoringPatchIntent = Schema.Struct({
	patch: ReviewAuthoringSessionPatch,
	sessionId: Schema.NonEmptyString
});
export type MapReviewAuthoringPatchIntent = Schema.Schema.Type<
	typeof MapReviewAuthoringPatchIntent
>;

/**
 * Session/candidate identities for one preview request. The handler resolves current session
 * evidence rather than trusting a UI-supplied arbitrary camera pose.
 */
export const MapReviewAuthoringPreviewIntent = Schema.Struct({
	candidateId: Schema.NonEmptyString,
	sessionId: Schema.NonEmptyString
});
export type MapReviewAuthoringPreviewIntent = Schema.Schema.Type<
	typeof MapReviewAuthoringPreviewIntent
>;

/**
 * Explicit candidate/view/actor and proposed pose, with optional manual adjustment/reason.
 * Approval reconciles these inputs against current authoring state before persisting.
 */
export const MapReviewApproveCandidateIntent = Schema.Struct({
	candidateId: Schema.String,
	candidatePose: IpcPose,
	manualPose: Schema.optional(IpcPose),
	manualReason: Schema.optional(Schema.String),
	sourceActorPath: Schema.String,
	viewId: Schema.String
});
export type MapReviewApproveCandidateIntent = Schema.Schema.Type<
	typeof MapReviewApproveCandidateIntent
>;

/**
 * Approved candidate identity or typed host failure. A successful approval records a view
 * definition, not a rendered capture artifact.
 */
export const MapReviewApprovalResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("approved"), candidateId: Schema.String }),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure })
]);
export type MapReviewApprovalResult = Schema.Schema.Type<typeof MapReviewApprovalResult>;

/**
 * Validates untrusted host review state at an IPC/host boundary. Invalid shapes fail with
 * ContractParseError retaining the schema cause; successful blocked/failed variants remain
 * ordinary lifecycle values.
 */
export const decodeMapReviewResult = contractParser(MapReviewResult, "MapReviewResult");
/**
 * Validates untrusted review-set library state at an IPC/host boundary. Invalid shapes fail
 * with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewSetLibraryResult = contractParser(
	MapReviewSetLibraryResult,
	"MapReviewSetLibraryResult"
);
/**
 * Validates untrusted capture action result at an IPC/host boundary. Invalid shapes fail with
 * ContractParseError retaining the schema cause; successful blocked/failed variants remain
 * ordinary lifecycle values.
 */
export const decodeMapReviewCaptureResult = contractParser(
	MapReviewCaptureResult,
	"MapReviewCaptureResult"
);
/**
 * Validates untrusted view policy replacement intent at an IPC/host boundary. Invalid shapes
 * fail with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewReplaceVisibilityPolicyIntent = contractParser(
	MapReviewReplaceVisibilityPolicyIntent,
	"MapReviewReplaceVisibilityPolicyIntent"
);
/**
 * Validates untrusted batch policy assignment intent at an IPC/host boundary. Invalid shapes
 * fail with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewApplyVisibilityPolicyIntent = contractParser(
	MapReviewApplyVisibilityPolicyIntent,
	"MapReviewApplyVisibilityPolicyIntent"
);
/**
 * Validates untrusted candidate authoring state at an IPC/host boundary. Invalid shapes fail
 * with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewAuthoringResult = contractParser(
	MapReviewAuthoringResult,
	"MapReviewAuthoringResult"
);
/**
 * Validates untrusted authoring session intent at an IPC/host boundary. Invalid shapes fail
 * with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewAuthoringSessionIntent = contractParser(
	MapReviewAuthoringSessionIntent,
	"MapReviewAuthoringSessionIntent"
);
/**
 * Validates untrusted authoring patch intent at an IPC/host boundary. Invalid shapes fail
 * with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewAuthoringPatchIntent = contractParser(
	MapReviewAuthoringPatchIntent,
	"MapReviewAuthoringPatchIntent"
);
/**
 * Validates untrusted candidate preview intent at an IPC/host boundary. Invalid shapes fail
 * with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewAuthoringPreviewIntent = contractParser(
	MapReviewAuthoringPreviewIntent,
	"MapReviewAuthoringPreviewIntent"
);
/**
 * Validates untrusted candidate preview result at an IPC/host boundary. Invalid shapes fail
 * with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewCandidatePreviewResult = contractParser(
	MapReviewCandidatePreviewResult,
	"MapReviewCandidatePreviewResult"
);
/**
 * Validates untrusted candidate approval result at an IPC/host boundary. Invalid shapes fail
 * with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewApprovalResult = contractParser(
	MapReviewApprovalResult,
	"MapReviewApprovalResult"
);
/**
 * Validates untrusted candidate approval intent at an IPC/host boundary. Invalid shapes fail
 * with ContractParseError retaining the schema cause; successful blocked/failed variants
 * remain ordinary lifecycle values.
 */
export const decodeMapReviewApproveCandidateIntent = contractParser(
	MapReviewApproveCandidateIntent,
	"MapReviewApproveCandidateIntent"
);

/** Host-facing camera workspace protocol; transport and presentation are replaceable. */
export const CameraWorkspaceRequest = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("inspect_recovery"), id: CameraArrangementId }),
	Schema.Struct({
		kind: Schema.Literal("resolve_recovery"),
		proposal: CameraRecoveryProposal,
		choice: CameraRecoveryChoice
	}),
	Schema.Struct({ kind: Schema.Literals(["list", "state", "close"]) }),
	Schema.Struct({
		kind: Schema.Literal("open"),
		id: Schema.optionalKey(CameraArrangementId),
		actorPath: Schema.optionalKey(Schema.NonEmptyString),
		layout: Schema.optionalKey(CameraLayout),
		livePreview: Schema.optionalKey(Schema.Boolean),
		name: Schema.optionalKey(Schema.NonEmptyString)
	}),
	Schema.Struct({
		kind: Schema.Literal("action"),
		id: CameraArrangementId,
		expectedRevision: Schema.Int,
		action: CameraPanelAction
	}),
	Schema.Struct({
		kind: Schema.Literal("native"),
		id: CameraArrangementId,
		operation: Schema.Literals([
			"pilot",
			"eject",
			"select",
			"hide_selection",
			"protect_selection"
		]),
		scope: CameraEditScope
	})
]);
export type CameraWorkspaceRequest = typeof CameraWorkspaceRequest.Type;
/**
 * Host camera workspace projection with panel/sets, optional preview/recovery and saved
 * revisions. Nullable/error states remain explicit; the shell continues to own active project
 * selection.
 */
export const CameraWorkspaceResult = Schema.Struct({
	preview: Schema.optionalKey(Schema.NullOr(ProvisionedCameraBinding)),
	recovery: Schema.optionalKey(Schema.NullOr(CameraRecoveryProposal)),
	savedViews: Schema.optionalKey(
		Schema.Array(Schema.Struct({ id: Schema.String, revision: Schema.Int }))
	),
	panel: Schema.NullOr(CameraPanelState),
	sets: Schema.Array(
		Schema.Struct({
			id: CameraArrangementId,
			name: Schema.String,
			actorPath: Schema.String,
			cameras: Schema.Int
		})
	),
	error: Schema.NullOr(Schema.String)
});
export type CameraWorkspaceResult = typeof CameraWorkspaceResult.Type;
