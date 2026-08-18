import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import {
	RemoteControlClient,
	RemoteControlClientError,
	type RemoteControlClientApi
} from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema } from "effect";
import { captureReviewView } from "./review-live.js";
import {
	ReviewCaptureRequest,
	ReviewSubjectActorPath,
	ReviewViewId,
	decodeReviewSelectionResponse,
	decodeReviewSubjectInspectionResponse,
	type CaptureProfile,
	type FramingCandidate,
	type ReviewCaptureResponse,
	type ReviewSubjectInspectionResponse,
	type ReviewSubjectProjection,
	type ReviewSelectionResponse
} from "./review-schema.js";

const reviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";

function pureStagingPath(
	response: Extract<ReviewCaptureResponse, { readonly status: "captured" }>
) {
	if (!("stagedArtifacts" in response)) return response.stagingPath;
	const artifact = response.stagedArtifacts.find((candidate) => candidate.variant === "pure");
	if (artifact === undefined) {
		throw new Error("The editor response omitted the required staged Pure artifact.");
	}
	return artifact.stagingPath;
}

export class ReviewAuthoringConnectionError extends Schema.TaggedErrorClass<ReviewAuthoringConnectionError>()(
	"ReviewAuthoringConnectionError",
	{
		endpoint: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["inspect_selection", "inspect_subject", "preview_candidate"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

function reviewConnectionError(
	endpoint: string,
	operation: "inspect_selection" | "inspect_subject" | "preview_candidate",
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

function remoteReviewCall(
	client: RemoteControlClientApi,
	args: {
		readonly endpoint: string;
		readonly functionName: string;
		readonly operation: "inspect_selection" | "inspect_subject" | "preview_candidate";
		readonly parameters: Schema.JsonObject;
	}
): Effect.Effect<unknown, ReviewAuthoringConnectionError> {
	return client
		.request({
			endpoint: args.endpoint,
			functionName: args.functionName,
			objectPath: reviewLibraryPath,
			operation: `camera.review.authoring.${args.functionName}`,
			parameters: args.parameters,
			timeout: "5 seconds"
		})
		.pipe(
			Effect.mapError((error) => reviewConnectionError(args.endpoint, args.operation, error))
		);
}

export interface ReviewCandidatePreview {
	readonly bytes: Uint8Array;
	readonly height: number;
	readonly projection: ReviewSubjectProjection;
	readonly width: number;
}

export interface PreviewReviewCandidateArgs {
	readonly candidate: FramingCandidate;
	readonly endpoint: string;
	readonly mapPath: string;
	readonly profile: CaptureProfile;
	readonly subject: {
		readonly actorPath: string;
		readonly displayName: string;
	};
}

export interface ReviewAuthoringApi {
	readonly inspectSelection: (
		endpoint: string
	) => Effect.Effect<ReviewSelectionResponse, ReviewAuthoringConnectionError>;
	readonly inspectSubject: (args: {
		readonly actorPath: string;
		readonly endpoint: string;
	}) => Effect.Effect<ReviewSubjectInspectionResponse, ReviewAuthoringConnectionError>;
	readonly previewCandidate: (
		args: PreviewReviewCandidateArgs
	) => Effect.Effect<ReviewCandidatePreview, ReviewAuthoringConnectionError>;
}

export class ReviewAuthoring extends Context.Service<ReviewAuthoring, ReviewAuthoringApi>()(
	"@ue-shed/cameras/ReviewAuthoring"
) {}

export const ReviewAuthoringLive = Layer.effect(
	ReviewAuthoring,
	Effect.gen(function* () {
		const client = yield* RemoteControlClient;

		const inspectSelection = Effect.fn("ReviewAuthoring.inspectSelection")(function* (
			endpoint: string
		) {
			const value = yield* remoteReviewCall(client, {
				endpoint,
				functionName: "InspectReviewSelection",
				operation: "inspect_selection",
				parameters: {}
			});
			return yield* decodeReviewSelectionResponse(value).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewAuthoringConnectionError({
							endpoint,
							message: String(cause),
							operation: "inspect_selection",
							recovery: "Verify the Map Review editor capability contract.",
							retrySafe: false
						})
				),
				Effect.withSpan("camera.review.authoring.selection.inspect")
			);
		});

		const inspectSubject = Effect.fn("ReviewAuthoring.inspectSubject")(function* (args: {
			readonly actorPath: string;
			readonly endpoint: string;
		}) {
			const actorPath = yield* Schema.decodeUnknownEffect(ReviewSubjectActorPath)(
				args.actorPath
			).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewAuthoringConnectionError({
							endpoint: args.endpoint,
							message: `Invalid persisted subject actor path: ${String(cause)}`,
							operation: "inspect_subject",
							recovery:
								"Discard the malformed authoring session and create a new one.",
							retrySafe: false
						})
				)
			);
			const value = yield* remoteReviewCall(client, {
				endpoint: args.endpoint,
				functionName: "InspectReviewSubject",
				operation: "inspect_subject",
				parameters: { ActorPath: actorPath }
			});
			return yield* decodeReviewSubjectInspectionResponse(value).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewAuthoringConnectionError({
							endpoint: args.endpoint,
							message: String(cause),
							operation: "inspect_subject",
							recovery:
								"Verify the persisted subject and Map Review editor capability.",
							retrySafe: false
						})
				),
				Effect.withSpan("camera.review.authoring.subject.inspect")
			);
		});

		const previewCandidate = Effect.fn("ReviewAuthoring.previewCandidate")(function* (
			args: PreviewReviewCandidateArgs
		) {
			const operationId = randomUUID();
			const previewViewId = ReviewViewId.make(
				`preview-${createHash("sha256").update(args.candidate.id).digest("hex").slice(0, 24)}`
			);
			const response = yield* captureReviewView({
				endpoint: args.endpoint,
				request: ReviewCaptureRequest.make({
					approvedPose: args.candidate.approvedPose,
					contract: {
						name: "ue-shed-review-capture",
						version: { major: 1, minor: 1 }
					},
					expectedMapPath: args.mapPath,
					operationId,
					resolution: args.profile.resolution,
					subject: {
						actorPath: args.subject.actorPath,
						diagnosticLabel: args.subject.displayName,
						kind: "actor_path"
					},
					viewId: previewViewId
				})
			}).pipe(
				Effect.provideService(RemoteControlClient, client),
				Effect.mapError(
					(cause) =>
						new ReviewAuthoringConnectionError({
							endpoint: args.endpoint,
							message: cause.message,
							operation: "preview_candidate",
							recovery:
								"Verify the Map Review editor capability and retry the preview.",
							retrySafe: cause.retrySafe
						})
				)
			);
			if (response.status === "failed") {
				return yield* new ReviewAuthoringConnectionError({
					endpoint: args.endpoint,
					message: response.message,
					operation: "preview_candidate",
					recovery: response.recovery,
					retrySafe: response.retrySafe
				});
			}
			if (!response.subjectProjection) {
				return yield* new ReviewAuthoringConnectionError({
					endpoint: args.endpoint,
					message:
						"The editor captured a preview without post-realization framing evidence.",
					operation: "preview_candidate",
					recovery:
						"Update the UEShedCameras editor capability before keeping a Review View.",
					retrySafe: false
				});
			}
			const projection = response.subjectProjection;
			const stagingPath = pureStagingPath(response);
			return yield* Effect.tryPromise({
				try: async () => {
					try {
						return {
							bytes: new Uint8Array(await readFile(stagingPath)),
							height: response.height,
							projection,
							width: response.width
						};
					} finally {
						await unlink(stagingPath).catch(() => undefined);
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
			}).pipe(
				Effect.withSpan("camera.review.authoring.candidate.preview", {
					attributes: { "camera.review.candidate.id": args.candidate.id }
				})
			);
		});

		return ReviewAuthoring.of({ inspectSelection, inspectSubject, previewCandidate });
	})
);

export function makeReviewAuthoringTestLayer(
	service: Omit<ReviewAuthoringApi, "inspectSubject"> &
		Partial<Pick<ReviewAuthoringApi, "inspectSubject">>
): Layer.Layer<ReviewAuthoring> {
	return Layer.succeed(
		ReviewAuthoring,
		ReviewAuthoring.of({
			...service,
			inspectSubject:
				service.inspectSubject ??
				(() => Effect.die("ReviewAuthoring test stub did not define inspectSubject"))
		})
	);
}

/** Compatibility accessors until Plans 012–014 compose ReviewAuthoring layers directly. */
export function inspectReviewSelection(
	endpoint: string
): Effect.Effect<ReviewSelectionResponse, ReviewAuthoringConnectionError, RemoteControlClient> {
	return Effect.flatMap(ReviewAuthoring, (service) => service.inspectSelection(endpoint)).pipe(
		Effect.provide(ReviewAuthoringLive)
	);
}

export function previewReviewCandidate(
	args: PreviewReviewCandidateArgs
): Effect.Effect<ReviewCandidatePreview, ReviewAuthoringConnectionError, RemoteControlClient> {
	return Effect.flatMap(ReviewAuthoring, (service) => service.previewCandidate(args)).pipe(
		Effect.provide(ReviewAuthoringLive)
	);
}
