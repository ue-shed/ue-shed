import { Effect, Schema } from "effect";
import { recordReviewAssessment } from "@ue-shed/observability";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import {
	decodeReviewAssessmentCapabilities,
	decodeReviewCaptureResponse,
	type ReviewAssessmentCapabilities,
	type ReviewCaptureRequest,
	type ReviewCaptureResponse
} from "./review-schema.js";

const reviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";

export class ReviewCaptureConnectionError extends Schema.TaggedErrorClass<ReviewCaptureConnectionError>()(
	"ReviewCaptureConnectionError",
	{ endpoint: Schema.String, message: Schema.String, retrySafe: Schema.Boolean }
) {}

function connectionError(
	endpoint: string,
	cause: RemoteControlClientError | unknown
): ReviewCaptureConnectionError {
	return new ReviewCaptureConnectionError({
		endpoint,
		message: cause instanceof RemoteControlClientError ? cause.message : String(cause),
		retrySafe: cause instanceof RemoteControlClientError ? cause.retrySafe : false
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

export function captureReviewView(args: {
	readonly endpoint: string;
	readonly request: ReviewCaptureRequest;
}): Effect.Effect<ReviewCaptureResponse, ReviewCaptureConnectionError, RemoteControlClient> {
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
