import { Schema } from "effect";
import { ReviewCaptureBlock } from "./review-session-policy.js";

const IpcFailure = Schema.Struct({ message: Schema.String, recovery: Schema.String });
const IpcPose = Schema.Struct({
	aspectRatio: Schema.Literal("16:9"),
	fieldOfViewDegrees: Schema.Number,
	location: Schema.Struct({ x: Schema.Number, y: Schema.Number, z: Schema.Number }),
	projection: Schema.Literal("perspective"),
	rotation: Schema.Struct({ pitch: Schema.Number, roll: Schema.Number, yaw: Schema.Number })
});

export const MapReviewRunView = Schema.Struct({
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

export const MapReviewResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("blocked"), policy: ReviewCaptureBlock }),
	Schema.Struct({ status: Schema.Literal("failed"), error: IpcFailure }),
	Schema.Struct({
		status: Schema.Literal("ready"),
		reviewSet: Schema.Struct({
			displayName: Schema.String,
			mapPath: Schema.String,
			viewCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		}),
		runs: Schema.Array(MapReviewRunView)
	})
]);
export type MapReviewResult = Schema.Schema.Type<typeof MapReviewResult>;

export const MapReviewPose = IpcPose;
export type MapReviewPose = Schema.Schema.Type<typeof MapReviewPose>;

export const MapReviewAuthoringCandidate = Schema.Struct({
	diagnostics: Schema.Array(
		Schema.Struct({
			code: Schema.String,
			message: Schema.String,
			severity: Schema.Literals(["info", "warning"])
		})
	),
	displayName: Schema.String,
	id: Schema.String,
	pose: IpcPose,
	preset: Schema.String,
	preview: Schema.Union([
		Schema.Struct({
			status: Schema.Literal("ready"),
			bytes: Schema.Uint8Array,
			height: Schema.Int.check(Schema.isGreaterThan(0)),
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
		height: Schema.Int.check(Schema.isGreaterThan(0)),
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
		viewId: Schema.String
	})
]);
export type MapReviewAuthoringResult = Schema.Schema.Type<typeof MapReviewAuthoringResult>;

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
export const decodeMapReviewAuthoringResult = Schema.decodeUnknownEffect(MapReviewAuthoringResult);
export const decodeMapReviewCandidatePreviewResult = Schema.decodeUnknownEffect(
	MapReviewCandidatePreviewResult
);
export const decodeMapReviewApprovalResult = Schema.decodeUnknownEffect(MapReviewApprovalResult);
export const decodeMapReviewApproveCandidateIntent = Schema.decodeUnknownEffect(
	MapReviewApproveCandidateIntent
);
