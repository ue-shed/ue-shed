import {
	ArtifactId,
	CaptureInvocationId,
	CaptureRunId,
	FramingCandidateId,
	ReviewAuthoringSessionId,
	ReviewViewId,
	ReviewViewRevisionId
} from "@ue-shed/cameras";
import { Schema } from "effect";

export const MapReviewFlowId = Schema.Literals([
	"authoring-roundtrip",
	"framing-gallery",
	"occlusion-walkthrough",
	"high-count-rig",
	"recovery"
]);
export type MapReviewFlowId = Schema.Schema.Type<typeof MapReviewFlowId>;

export const MapReviewFlowCheckpointId = Schema.Literals([
	"fixture-ready",
	"subject-selected",
	"rig-generated",
	"rig-tuned",
	"candidate-previewed",
	"view-approved",
	"persistence-verified",
	"workbench-restarted",
	"view-loaded",
	"capture-completed",
	"evidence-inspected",
	"cleanup-verified"
]);
export type MapReviewFlowCheckpointId = Schema.Schema.Type<typeof MapReviewFlowCheckpointId>;

const RelativeArtifactPath = Schema.NonEmptyString.check(
	Schema.makeFilter((value) => {
		if (/^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) {
			return {
				issue: "Artifact paths must be relative to the recording bundle.",
				path: []
			};
		}
		if (value.split(/[\\/]/).includes("..")) {
			return { issue: "Artifact paths cannot escape the recording bundle.", path: [] };
		}
	})
);

const IsoTimestamp = Schema.NonEmptyString.check(
	Schema.makeFilter((value) => {
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
			return { issue: "Expected a canonical ISO-8601 UTC timestamp.", path: [] };
		}
	})
);

export const MapReviewFlowAttachment = Schema.Struct({
	height: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
	kind: Schema.Literals(["ui-screenshot", "raw-capture", "persisted-json"]),
	path: RelativeArtifactPath,
	width: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
}).check(
	Schema.makeFilter((attachment) => {
		const hasWidth = attachment.width !== undefined;
		const hasHeight = attachment.height !== undefined;
		if (hasWidth !== hasHeight) {
			return {
				issue: "Attachment dimensions must provide both width and height.",
				path: []
			};
		}
	})
);
export type MapReviewFlowAttachment = Schema.Schema.Type<typeof MapReviewFlowAttachment>;

export const MapReviewFlowIdentity = Schema.Struct({
	artifactId: Schema.optionalKey(ArtifactId),
	candidateId: Schema.optionalKey(FramingCandidateId),
	invocationId: Schema.optionalKey(CaptureInvocationId),
	runId: Schema.optionalKey(CaptureRunId),
	sessionId: Schema.optionalKey(ReviewAuthoringSessionId),
	viewId: Schema.optionalKey(ReviewViewId),
	viewRevisionId: Schema.optionalKey(ReviewViewRevisionId)
});
export type MapReviewFlowIdentity = Schema.Schema.Type<typeof MapReviewFlowIdentity>;

export const MapReviewFlowCheckpoint = Schema.Struct({
	attachments: Schema.Array(MapReviewFlowAttachment),
	completedAt: IsoTimestamp,
	description: Schema.NonEmptyString,
	id: MapReviewFlowCheckpointId,
	identity: MapReviewFlowIdentity,
	title: Schema.NonEmptyString
});
export type MapReviewFlowCheckpoint = Schema.Schema.Type<typeof MapReviewFlowCheckpoint>;

export const MapReviewFlowCleanup = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_run") }),
	Schema.Struct({
		mapDirtyAfter: Schema.Boolean,
		provisionedCameraCountAfter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		status: Schema.Literal("verified")
	}),
	Schema.Struct({ message: Schema.NonEmptyString, status: Schema.Literal("failed") })
]);
export type MapReviewFlowCleanup = Schema.Schema.Type<typeof MapReviewFlowCleanup>;

const MapReviewFlowRecordingBase = Schema.Struct({
	artifacts: Schema.Struct({
		logs: RelativeArtifactPath,
		traces: Schema.Array(RelativeArtifactPath).check(Schema.isMinLength(1)),
		video: RelativeArtifactPath
	}),
	checkpoints: Schema.Array(MapReviewFlowCheckpoint).check(Schema.isMinLength(1)),
	cleanup: MapReviewFlowCleanup,
	commit: Schema.NonEmptyString,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-map-review-flow-recording"),
		version: Schema.Literal(1)
	}),
	dirty: Schema.Boolean,
	finishedAt: IsoTimestamp,
	fixture: Schema.Struct({ map: Schema.NonEmptyString, subjectKey: Schema.NonEmptyString }),
	flow: MapReviewFlowId,
	id: Schema.NonEmptyString,
	startedAt: IsoTimestamp
});

export const MapReviewFlowRecordingManifest = Schema.Union([
	Schema.Struct({
		...MapReviewFlowRecordingBase.fields,
		failure: Schema.optionalKey(Schema.Never),
		status: Schema.Literal("passed")
	}),
	Schema.Struct({
		...MapReviewFlowRecordingBase.fields,
		failure: Schema.Struct({ message: Schema.NonEmptyString, name: Schema.NonEmptyString }),
		status: Schema.Literal("failed")
	})
]);
export type MapReviewFlowRecordingManifest = Schema.Schema.Type<
	typeof MapReviewFlowRecordingManifest
>;

export const decodeMapReviewFlowRecordingManifest = Schema.decodeUnknownSync(
	MapReviewFlowRecordingManifest
);
