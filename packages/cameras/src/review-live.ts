import { Data, Effect } from "effect";
import {
	decodeReviewCaptureResponse,
	type ReviewCaptureRequest,
	type ReviewCaptureResponse
} from "./review-schema.js";

const reviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";

export class ReviewCaptureConnectionError extends Data.TaggedError("ReviewCaptureConnectionError")<{
	readonly endpoint: string;
	readonly message: string;
	readonly retrySafe: boolean;
}> {}

const decodeRemoteResult = (value: unknown): unknown => {
	if (
		typeof value !== "object" ||
		value === null ||
		!("ResultJson" in value) ||
		typeof value.ResultJson !== "string"
	) {
		throw new TypeError("Remote Control response did not contain ResultJson");
	}
	return JSON.parse(value.ResultJson) as unknown;
};

export function captureReviewView(args: {
	readonly endpoint: string;
	readonly request: ReviewCaptureRequest;
}): Effect.Effect<ReviewCaptureResponse, ReviewCaptureConnectionError> {
	return Effect.tryPromise({
		try: async () => {
			const response = await fetch(
				`${args.endpoint.replace(/\/+$/, "")}/remote/object/call`,
				{
					body: JSON.stringify({
						functionName: "CaptureReviewView",
						generateTransaction: false,
						objectPath: reviewLibraryPath,
						parameters: { RequestJson: JSON.stringify(args.request) }
					}),
					headers: { "content-type": "application/json" },
					method: "PUT"
				}
			);
			if (!response.ok) {
				throw new Error(`Remote Control returned HTTP ${response.status}`);
			}
			return decodeReviewCaptureResponse(decodeRemoteResult(await response.json()));
		},
		catch: (cause) =>
			new ReviewCaptureConnectionError({
				endpoint: args.endpoint,
				message: String(cause),
				retrySafe: true
			})
	}).pipe(
		Effect.withSpan("camera.review.capture.remote", {
			attributes: {
				"camera.review.operation.id": args.request.operationId,
				"camera.review.view.id": args.request.viewId
			}
		})
	);
}
