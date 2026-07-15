import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { Data, Effect, Schema } from "effect";
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
const RemoteResult = Schema.Struct({ ResultJson: Schema.String });
const decodeRemoteResult = Schema.decodeUnknownSync(RemoteResult);

export class ReviewAuthoringConnectionError extends Data.TaggedError(
	"ReviewAuthoringConnectionError"
)<{
	readonly endpoint: string;
	readonly message: string;
	readonly operation: "inspect_selection" | "preview_candidate";
	readonly recovery: string;
	readonly retrySafe: boolean;
}> {}

async function remoteReviewCall(args: {
	readonly endpoint: string;
	readonly functionName: string;
	readonly parameters: object;
}): Promise<unknown> {
	const response = await fetch(`${args.endpoint.replace(/\/+$/, "")}/remote/object/call`, {
		body: JSON.stringify({
			functionName: args.functionName,
			generateTransaction: false,
			objectPath: reviewLibraryPath,
			parameters: args.parameters
		}),
		headers: { "content-type": "application/json" },
		method: "PUT",
		signal: AbortSignal.timeout(5_000)
	});
	if (!response.ok) throw new Error(`Remote Control returned HTTP ${response.status}`);
	return JSON.parse(decodeRemoteResult(await response.json()).ResultJson) as unknown;
}

export function inspectReviewSelection(
	endpoint: string
): Effect.Effect<ReviewSelectionResponse, ReviewAuthoringConnectionError> {
	return Effect.tryPromise({
		try: async () =>
			decodeReviewSelectionResponse(
				await remoteReviewCall({
					endpoint,
					functionName: "InspectReviewSelection",
					parameters: {}
				})
			),
		catch: (cause) =>
			new ReviewAuthoringConnectionError({
				endpoint,
				message: String(cause),
				operation: "inspect_selection",
				recovery: "Verify the Map Review editor capability and retry selection inspection.",
				retrySafe: true
			})
	}).pipe(Effect.withSpan("camera.review.authoring.selection.inspect"));
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
}): Effect.Effect<ReviewCandidatePreview, ReviewAuthoringConnectionError> {
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
