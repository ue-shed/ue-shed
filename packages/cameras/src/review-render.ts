import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Schema } from "effect";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { makeCameraRenderer, CameraRenderError } from "./camera-render.js";
import {
	CameraFrameResult,
	CameraFrameOperationId,
	CameraRenderSessionId,
	cameraRenderContract,
	legacyReviewRenderPolicy
} from "./camera-render-schema.js";
import {
	ApprovedPose,
	ClearCompanionResult,
	ResolvedReviewSubject,
	ReviewCaptureRequestCurrent,
	ReviewSubjectProjection,
	VisibilityMeasurement,
	decodeReviewCaptureResponse
} from "./review-schema.js";

export const ReviewRenderStageContract = Schema.Struct({
	name: Schema.Literal("ue-shed-review-render-stages"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
const stageContract = {
	name: "ue-shed-review-render-stages",
	version: { major: 1, minor: 0 }
} as const;
export const ReviewRenderStageFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	code: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString
});
export const ReviewRealizationRequest = Schema.Struct({
	contract: ReviewRenderStageContract,
	viewpoint: ReviewCaptureRequestCurrent.fields.viewpoint,
	subject: ReviewCaptureRequestCurrent.fields.subject,
	expectedMapPath: ReviewCaptureRequestCurrent.fields.expectedMapPath
});
export const ReviewRealizationResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("resolved"),
		pose: ApprovedPose,
		resolvedSubject: Schema.optionalKey(ResolvedReviewSubject)
	}),
	ReviewRenderStageFailure
]);
export const ReviewRenderInspectionRequest = Schema.Struct({
	contract: ReviewRenderStageContract,
	subject: ReviewCaptureRequestCurrent.fields.subject,
	assessment: ReviewCaptureRequestCurrent.fields.assessment,
	clearCompanion: ReviewCaptureRequestCurrent.fields.clearCompanion
});
export const ReviewRenderInspectionResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("inspected"),
		resolvedSubject: ResolvedReviewSubject,
		subjectProjection: Schema.optionalKey(ReviewSubjectProjection),
		visibility: VisibilityMeasurement,
		clearCompanion: ClearCompanionResult,
		clearFrame: Schema.optionalKey(CameraFrameResult),
		stagedArtifacts: Schema.Array(
			Schema.Struct({
				variant: Schema.Literals(["pure", "clear"]),
				stagingPath: Schema.NonEmptyString
			})
		).check(Schema.isMinLength(1), Schema.isMaxLength(2))
	}),
	ReviewRenderStageFailure
]);

/** Realize -> prepare/render in one owned session -> optional assessment -> restore -> publish. */
export const captureRenderedReviewView = Effect.fn("ReviewRenderer.capture")(function* (args: {
	readonly endpoint: string;
	readonly request: typeof ReviewCaptureRequestCurrent.Type;
}) {
	const client = yield* RemoteControlClient;
	const request = yield* Schema.decodeUnknownEffect(ReviewCaptureRequestCurrent)(args.request, {
		onExcessProperty: "error"
	});
	const renderer = makeCameraRenderer(client, args.endpoint);
	const remote = (functionName: string, parameters: Record<string, string>) =>
		client.request({
			endpoint: args.endpoint,
			objectPath: "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary",
			functionName,
			parameters,
			operation: `camera.review.${functionName}`,
			timeout: "150 seconds"
		});
	const fail = (failure: {
		readonly code: string;
		readonly message: string;
		readonly recovery: string;
	}) => ({
		...failure,
		status: "failed" as const,
		retrySafe: false,
		contract: { name: "ue-shed-review-capture", version: { major: 1, minor: 6 } } as const,
		operationId: request.operationId,
		viewId: request.viewId
	});
	const outcome = yield* Effect.exit(
		Effect.scoped(
			Effect.gen(function* () {
				// A fixed pose never calls actor realization. The locator is optional assessment provenance.
				const realization =
					request.viewpoint.kind === "world_fixed"
						? { status: "resolved" as const, pose: request.viewpoint.approvedPose }
						: yield* remote("ResolveReviewViewpoint", {
								RequestJson: JSON.stringify({
									contract: stageContract,
									viewpoint: request.viewpoint,
									subject: request.subject,
									expectedMapPath: request.expectedMapPath
								})
							}).pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(ReviewRealizationResult))
							);
				if (realization.status === "failed") return fail(realization);
				const capabilities = yield* renderer.capabilities();
				const sessionId = CameraRenderSessionId.make(randomUUID());
				const session = yield* renderer.open({
					contract: cameraRenderContract,
					sessionId,
					expectedMapPath: request.expectedMapPath,
					expectedProjectName: capabilities.projectName,
					policy: request.renderPolicy ?? legacyReviewRenderPolicy,
					leaseMs: 120000,
					maximumFrames: 2
				});
				const pose = realization.pose;
				const frame = yield* session.capture({
					contract: cameraRenderContract,
					sessionId,
					operationId: CameraFrameOperationId.make("natural"),
					camera: {
						location: pose.location,
						rotation: pose.rotation,
						projection: {
							kind: "perspective",
							horizontalFieldOfView: pose.fieldOfViewDegrees
						}
					},
					size: request.resolution
				});
				const inspection = yield* remote("InspectRenderedReview", {
					SessionId: sessionId,
					RequestJson: JSON.stringify({
						contract: stageContract,
						subject: request.subject,
						assessment: request.assessment,
						clearCompanion: request.clearCompanion
					})
				}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ReviewRenderInspectionResult)));
				if (inspection.status === "failed") return fail(inspection);
				return yield* decodeReviewCaptureResponse({
					status: "captured",
					contract: { name: "ue-shed-review-capture", version: { major: 1, minor: 6 } },
					operationId: request.operationId,
					viewId: request.viewId,
					effectiveWorldPose: pose,
					resolvedSubject:
						"resolvedSubject" in realization
							? realization.resolvedSubject
							: inspection.resolvedSubject,
					...(inspection.subjectProjection === undefined
						? undefined
						: { subjectProjection: inspection.subjectProjection }),
					clearCompanion: inspection.clearCompanion,
					stagedArtifacts: inspection.stagedArtifacts,
					visibility: inspection.visibility,
					mapPath: request.expectedMapPath,
					...frame.evidence.editorState,
					width: frame.artifact.width,
					height: frame.artifact.height,
					captureDurationMs: frame.evidence.settling.elapsedMs,
					renderEvidence: frame.evidence
				});
			})
		)
	);
	if (Exit.isSuccess(outcome)) return outcome.value;
	if (Cause.hasInterrupts(outcome.cause)) return yield* Effect.failCause(outcome.cause);
	return yield* new CameraRenderError({
		code: "review_render_or_restoration_failed",
		operation: "capture",
		sessionId: request.operationId,
		message: Cause.pretty(outcome.cause),
		recovery: "Inspect rendering and restoration errors before retrying this Review View."
	});
});
