import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";
import { captureReviewView } from "./review-live.js";
import {
	ReviewCaptureRequest,
	ReviewViewId,
	decodeReviewSelectionResponse,
	type CaptureProfile,
	type FramingCandidate,
	type ReviewSelectionResponse
} from "./review-schema.js";

const reviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";

export class ReviewAuthoringConnectionError extends Schema.TaggedErrorClass<ReviewAuthoringConnectionError>()(
	"ReviewAuthoringConnectionError",
	{
		endpoint: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["inspect_selection", "preview_candidate"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

function reviewConnectionError(
	endpoint: string,
	operation: "inspect_selection" | "preview_candidate",
	cause: RemoteControlClientError | unknown
): ReviewAuthoringConnectionError {
	return new ReviewAuthoringConnectionError({
		endpoint,
		message: cause instanceof RemoteControlClientError ? cause.message : String(cause),
		operation,
		recovery: "Verify the Map Review editor capability and retry the operation.",
		retrySafe: cause instanceof RemoteControlClientError ? cause.retrySafe : false
	});
}

function remoteReviewCall(args: {
	readonly endpoint: string;
	readonly functionName: string;
	readonly parameters: Readonly<Record<string, unknown>>;
}): Effect.Effect<unknown, ReviewAuthoringConnectionError, RemoteControlClient> {
	return Effect.flatMap(RemoteControlClient, (client) =>
		client
			.request({
				endpoint: args.endpoint,
				functionName: args.functionName,
				objectPath: reviewLibraryPath,
				operation: `camera.review.authoring.${args.functionName}`,
				parameters: args.parameters,
				timeout: "5 seconds"
			})
			.pipe(
				Effect.mapError((error) =>
					reviewConnectionError(args.endpoint, "inspect_selection", error)
				)
			)
	);
}

export function inspectReviewSelection(
	endpoint: string
): Effect.Effect<ReviewSelectionResponse, ReviewAuthoringConnectionError, RemoteControlClient> {
	return remoteReviewCall({
		endpoint,
		functionName: "InspectReviewSelection",
		parameters: {}
	}).pipe(
		Effect.flatMap((value) =>
			decodeReviewSelectionResponse(value).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewAuthoringConnectionError({
							endpoint,
							message: String(cause),
							operation: "inspect_selection",
							recovery: "Verify the Map Review editor capability contract.",
							retrySafe: false
						})
				)
			)
		),
		Effect.withSpan("camera.review.authoring.selection.inspect")
	);
}

export interface ReviewCandidatePreview {
	readonly bytes: Uint8Array;
	readonly height: number;
	readonly width: number;
}

export function previewReviewCandidate(args: {
	readonly candidate: FramingCandidate;
	readonly endpoint: string;
	readonly mapPath: string;
	readonly profile: CaptureProfile;
	readonly subject: {
		readonly actorPath: string;
		readonly displayName: string;
	};
}): Effect.Effect<ReviewCandidatePreview, ReviewAuthoringConnectionError, RemoteControlClient> {
	const operationId = randomUUID();
	return captureReviewView({
		endpoint: args.endpoint,
		request: ReviewCaptureRequest.make({
			approvedPose: args.candidate.approvedPose,
			contract: {
				name: "ue-shed-review-capture",
				version: { major: 1, minor: 0 }
			},
			expectedMapPath: args.mapPath,
			operationId,
			resolution: args.profile.resolution,
			subject: {
				actorPath: args.subject.actorPath,
				diagnosticLabel: args.subject.displayName,
				kind: "actor_path"
			},
			viewId: ReviewViewId.make(args.candidate.id)
		})
	}).pipe(
		Effect.mapError(
			(cause) =>
				new ReviewAuthoringConnectionError({
					endpoint: args.endpoint,
					message: cause.message,
					operation: "preview_candidate",
					recovery: "Verify the Map Review editor capability and retry the preview.",
					retrySafe: cause.retrySafe
				})
		),
		Effect.flatMap((response) => {
			if (response.status === "failed") {
				return Effect.fail(
					new ReviewAuthoringConnectionError({
						endpoint: args.endpoint,
						message: response.message,
						operation: "preview_candidate",
						recovery: response.recovery,
						retrySafe: response.retrySafe
					})
				);
			}
			return Effect.tryPromise({
				try: async () => {
					try {
						return {
							bytes: new Uint8Array(await readFile(response.stagingPath)),
							height: response.height,
							width: response.width
						};
					} finally {
						await unlink(response.stagingPath).catch(() => undefined);
					}
				},
				catch: (cause) =>
					new ReviewAuthoringConnectionError({
						endpoint: args.endpoint,
						message: String(cause),
						operation: "preview_candidate",
						recovery: "Check the Unreal staging directory and retry the preview.",
						retrySafe: true
					})
			});
		}),
		Effect.withSpan("camera.review.authoring.candidate.preview", {
			attributes: { "camera.review.candidate.id": args.candidate.id }
		})
	);
}
