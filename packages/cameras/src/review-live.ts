import { Effect, Schema } from "effect";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import {
	decodeReviewCaptureResponse,
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
		Effect.withSpan("camera.review.capture.remote", {
			attributes: {
				"camera.review.operation.id": args.request.operationId,
				"camera.review.view.id": args.request.viewId
			}
		})
	);
}
