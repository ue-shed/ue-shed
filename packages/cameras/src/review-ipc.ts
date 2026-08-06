import { Schema } from "effect";
import { ReviewCaptureBlock } from "./review-session-policy.js";
import {
	CaptureInvocationCause,
	ClearCompanionResult,
	FramingDiagnostic,
	ReviewAuthoringSession,
	ReviewAuthoringSessionPatch,
	ReviewSubjectProjection,
	VisibilityOverrides,
	VisibilityPolicy,
	VisibilityResult
} from "./review-schema.js";

const IpcFailure = Schema.Struct({ message: Schema.String, recovery: Schema.String });
const IpcPose = Schema.Struct({
	aspectRatio: Schema.Literal("16:9"),
	fieldOfViewDegrees: Schema.Number,
	location: Schema.Struct({ x: Schema.Number, y: Schema.Number, z: Schema.Number }),
	projection: Schema.Literal("perspective"),
	rotation: Schema.Struct({ pitch: Schema.Number, roll: Schema.Number, yaw: Schema.Number })
});

export const MapReviewRunView = Schema.Struct({
	capture: Schema.optional(
		Schema.Struct({
			artifacts: Schema.Array(
				Schema.Struct({
					bytes: Schema.Uint8Array,
					height: Schema.Int.check(Schema.isGreaterThan(0)),
					variant: Schema.Literals(["pure", "clear"]),
					width: Schema.Int.check(Schema.isGreaterThan(0))
				})
			),
			cause: CaptureInvocationCause,
			clearCompanion: ClearCompanionResult,
			viewId: Schema.String,
			viewName: Schema.String,
			visibility: VisibilityResult,
			visibilityOverrides: Schema.optional(VisibilityOverrides),
			visibilityPolicy: Schema.optional(VisibilityPolicy)
		})
	),
	completedAt: Schema.String,
	failedViews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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

export const MapReviewCapturePlanView = Schema.Struct({
	captureProfileId: Schema.optional(Schema.NonEmptyString),
	displayName: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	resolution: Schema.Struct({
		height: Schema.Int.check(Schema.isGreaterThan(0)),
		width: Schema.Int.check(Schema.isGreaterThan(0))
	}),
	visibilityOverrides: Schema.optional(VisibilityOverrides),
	visibilityPolicy: Schema.optional(VisibilityPolicy)
});
export type MapReviewCapturePlanView = Schema.Schema.Type<typeof MapReviewCapturePlanView>;

const MapReviewReadyResult = Schema.Struct({
	status: Schema.Literal("ready"),
	reviewSet: Schema.Struct({
		displayName: Schema.String,
		mapPath: Schema.String,
		viewCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		views: Schema.Array(MapReviewCapturePlanView)
	}),
	runs: Schema.Array(MapReviewRunView)
});

export const MapReviewResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("setup_required") }),
	Schema.Struct({ status: Schema.Literal("blocked"), policy: ReviewCaptureBlock }),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure }),
	MapReviewReadyResult
]);
export type MapReviewResult = Schema.Schema.Type<typeof MapReviewResult>;

export const MapReviewCaptureIntent = Schema.Struct({
	viewIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
});
export type MapReviewCaptureIntent = Schema.Schema.Type<typeof MapReviewCaptureIntent>;

export const MapReviewReplaceVisibilityPolicyIntent = Schema.Struct({
	policy: VisibilityPolicy,
	viewId: Schema.NonEmptyString,
	visibilityOverrides: Schema.optional(VisibilityOverrides)
});
export type MapReviewReplaceVisibilityPolicyIntent = Schema.Schema.Type<
	typeof MapReviewReplaceVisibilityPolicyIntent
>;

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

export const MapReviewCaptureCompletedJob = Schema.Struct({
	...CaptureJobFields,
	status: Schema.Literal("completed"),
	completedAt: Schema.String,
	failedViews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	runId: Schema.NonEmptyString,
	successfulViews: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type MapReviewCaptureCompletedJob = Schema.Schema.Type<typeof MapReviewCaptureCompletedJob>;

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

export const MapReviewPose = IpcPose;
export type MapReviewPose = Schema.Schema.Type<typeof MapReviewPose>;

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
			width: Schema.Int.check(Schema.isGreaterThan(0))
		}),
		Schema.Struct({ status: Schema.Literal("pending") }),
		Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
	])
});
export type MapReviewAuthoringCandidate = Schema.Schema.Type<typeof MapReviewAuthoringCandidate>;

export const MapReviewCandidatePreviewResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		bytes: Schema.Uint8Array,
		cameraIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		height: Schema.Int.check(Schema.isGreaterThan(0)),
		diagnostics: Schema.optional(Schema.Array(FramingDiagnostic)),
		pixelFormat: Schema.optional(Schema.Literals(["png", "bgra8"])),
		projection: Schema.optional(ReviewSubjectProjection),
		width: Schema.Int.check(Schema.isGreaterThan(0))
	}),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure })
]);
export type MapReviewCandidatePreviewResult = Schema.Schema.Type<
	typeof MapReviewCandidatePreviewResult
>;

export const MapReviewAuthoringResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure }),
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

export const MapReviewAuthoringSessionIntent = Schema.Struct({ sessionId: Schema.NonEmptyString });
export type MapReviewAuthoringSessionIntent = Schema.Schema.Type<
	typeof MapReviewAuthoringSessionIntent
>;

export const MapReviewAuthoringPatchIntent = Schema.Struct({
	patch: ReviewAuthoringSessionPatch,
	sessionId: Schema.NonEmptyString
});
export type MapReviewAuthoringPatchIntent = Schema.Schema.Type<
	typeof MapReviewAuthoringPatchIntent
>;

export const MapReviewAuthoringPreviewIntent = Schema.Struct({
	candidateId: Schema.NonEmptyString,
	sessionId: Schema.NonEmptyString
});
export type MapReviewAuthoringPreviewIntent = Schema.Schema.Type<
	typeof MapReviewAuthoringPreviewIntent
>;

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

export const MapReviewApprovalResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("approved"), candidateId: Schema.String }),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure })
]);
export type MapReviewApprovalResult = Schema.Schema.Type<typeof MapReviewApprovalResult>;

export const decodeMapReviewResult = Schema.decodeUnknownEffect(MapReviewResult);
export const decodeMapReviewCaptureResult = Schema.decodeUnknownEffect(MapReviewCaptureResult);
export const decodeMapReviewReplaceVisibilityPolicyIntent = Schema.decodeUnknownEffect(
	MapReviewReplaceVisibilityPolicyIntent
);
export const decodeMapReviewApplyVisibilityPolicyIntent = Schema.decodeUnknownEffect(
	MapReviewApplyVisibilityPolicyIntent
);
export const decodeMapReviewAuthoringResult = Schema.decodeUnknownEffect(MapReviewAuthoringResult);
export const decodeMapReviewAuthoringSessionIntent = Schema.decodeUnknownEffect(
	MapReviewAuthoringSessionIntent
);
export const decodeMapReviewAuthoringPatchIntent = Schema.decodeUnknownEffect(
	MapReviewAuthoringPatchIntent
);
export const decodeMapReviewAuthoringPreviewIntent = Schema.decodeUnknownEffect(
	MapReviewAuthoringPreviewIntent
);
export const decodeMapReviewCandidatePreviewResult = Schema.decodeUnknownEffect(
	MapReviewCandidatePreviewResult
);
export const decodeMapReviewApprovalResult = Schema.decodeUnknownEffect(MapReviewApprovalResult);
export const decodeMapReviewApproveCandidateIntent = Schema.decodeUnknownEffect(
	MapReviewApproveCandidateIntent
);
