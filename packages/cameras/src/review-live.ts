import { ContractParseError } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import { ErrorCauseFields, ErrorGuidanceFields } from "@ue-shed/protocol";
import { recordReviewAssessment } from "@ue-shed/observability";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { CameraRenderError } from "./camera-render.js";
import { captureRenderedReviewView } from "./review-render.js";
import { ReviewCaptureRequestCurrent } from "./review-schema.js";
import {
	decodeReviewAssessmentCapabilities,
	decodeReviewCaptureResponse,
	type ReviewAssessmentCapabilities,
	type ReviewCaptureRequest,
	type ReviewCaptureResponse
} from "./review-schema.js";

const isCameraRenderError = Schema.is(CameraRenderError);
const isRemoteControlClientError = Schema.is(RemoteControlClientError);
const reviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";

/**
 * Remote review capture negotiation/transport/contract failure with original cause. An
 * uncertain mutation may have applied; honor recovery guidance before issuing another
 * capture.
 */
export class ReviewCaptureConnectionError extends Schema.TaggedError<ReviewCaptureConnectionError>()(
	"ReviewCaptureConnectionError",
	{ ...ErrorGuidanceFields, ...ErrorCauseFields, endpoint: Schema.String }
) {}

function connectionError(
	endpoint: string,
	cause: RemoteControlClientError | unknown
): ReviewCaptureConnectionError {
	// These already carry a classified message and truthful guidance; keep both.
	if (isRemoteControlClientError(cause) || isCameraRenderError(cause)) {
		return new ReviewCaptureConnectionError({
			endpoint,
			message: cause.message,
			nextStep: cause.nextStep,
			recovery: cause.recovery,
			retrySafe: cause.retrySafe,
			cause
		});
	}
	const recovery =
		"Update the Core and Cameras plugins together so the capture response matches this UE Shed version.";
	if (Schema.isSchemaError(cause) || Schema.is(ContractParseError)(cause))
		return new ReviewCaptureConnectionError({
			endpoint,
			message: `A review capture request or response at ${endpoint} does not match the review capture contract.`,
			nextStep: "escalate",
			recovery,
			retrySafe: false,
			cause
		});
	return new ReviewCaptureConnectionError({
		endpoint,
		message: `Review capture at ${endpoint} failed unexpectedly.`,
		nextStep: "escalate",
		recovery,
		retrySafe: false,
		cause
	});
}

function requestedAssessmentMethod(request: ReviewCaptureRequest): string {
	return "assessment" in request ? request.assessment.method : "not_requested";
}

function recordVisibilityMeasurement(response: ReviewCaptureResponse): Effect.Effect<void> {
	if (response.status !== "captured" || !("visibility" in response)) return Effect.void;
	if (response.visibility.status !== "assessed") {
		return recordReviewAssessment({ status: response.visibility.status });
	}
	return recordReviewAssessment({
		assessmentDurationMs: response.visibility.assessmentDurationMs,
		sampleCount: response.visibility.sampleCount,
		status: "assessed"
	});
}

/**
 * Captures one correlated review request through RemoteControlClient. Current rendered
 * requests use the scoped renderer; supported legacy versions retain their distinct
 * contract/evidence behavior.
 */
export function captureReviewView(args: {
	readonly endpoint: string;
	readonly request: ReviewCaptureRequest;
}): Effect.Effect<ReviewCaptureResponse, ReviewCaptureConnectionError, RemoteControlClient> {
	if (args.request.contract.version.minor >= 6) {
		return Schema.decodeUnknownEffect(ReviewCaptureRequestCurrent)(args.request).pipe(
			Effect.flatMap((request) =>
				captureRenderedReviewView({ endpoint: args.endpoint, request })
			),
			Effect.mapError((cause) => connectionError(args.endpoint, cause)),
			Effect.tap(recordVisibilityMeasurement)
		);
	}
	return Effect.flatMap(RemoteControlClient, (client) =>
		client
			.request({
				endpoint: args.endpoint,
				functionName: "CaptureReviewView",
				objectPath: reviewLibraryPath,
				operation: "camera.review.capture.remote",
				parameters: { RequestJson: JSON.stringify(args.request) }
			})
			.pipe(Effect.mapError((error) => connectionError(args.endpoint, error)))
	).pipe(
		Effect.flatMap((value) =>
			decodeReviewCaptureResponse(value).pipe(
				Effect.mapError((cause) => connectionError(args.endpoint, cause))
			)
		),
		Effect.tap(recordVisibilityMeasurement),
		Effect.withSpan("camera.review.capture.remote", {
			attributes: {
				"camera.review.assessment.requested_method": requestedAssessmentMethod(
					args.request
				),
				"camera.review.contract.minor": args.request.contract.version.minor
			}
		})
	);
}

/**
 * Reads optional producer facts for clients that want to adapt their own assessment experience.
 * Capture callers can ignore this and still use the requested method in their capture request.
 */
export function getReviewAssessmentCapabilities(
	endpoint: string
): Effect.Effect<ReviewAssessmentCapabilities, ReviewCaptureConnectionError, RemoteControlClient> {
	return Effect.flatMap(RemoteControlClient, (client) =>
		client
			.request({
				endpoint,
				functionName: "GetReviewAssessmentCapabilities",
				objectPath: reviewLibraryPath,
				operation: "camera.review.assessment_capabilities.remote",
				parameters: {}
			})
			.pipe(Effect.mapError((error) => connectionError(endpoint, error)))
	).pipe(
		Effect.flatMap((value) =>
			decodeReviewAssessmentCapabilities(value).pipe(
				Effect.mapError((cause) => connectionError(endpoint, cause))
			)
		),
		Effect.withSpan("camera.review.assessment_capabilities.remote")
	);
}
