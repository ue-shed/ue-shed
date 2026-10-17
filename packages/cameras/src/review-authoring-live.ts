import { legacyReviewRenderPolicy, type CameraFrameEvidence } from "./camera-render-schema.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import {
	RemoteControlClient,
	RemoteControlClientError,
	type RemoteControlClientApi
} from "@ue-shed/unreal-connection";
import { ErrorCauseFields, ErrorGuidanceFields } from "@ue-shed/protocol";
import { fileFailureReason } from "./file-failure.js";
import { Context, Effect, Layer, Schema } from "effect";
import { captureReviewView } from "./review-live.js";
import {
	ReviewCaptureRequest,
	ReviewViewId,
	SubjectLocator,
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

/**
 * Selection, subject inspection or candidate preview failure with endpoint/operation and
 * original cause. Correct capability/connection state before treating a candidate as
 * realized.
 */
export class ReviewAuthoringConnectionError extends Schema.TaggedError<ReviewAuthoringConnectionError>()(
	"ReviewAuthoringConnectionError",
	{
		...ErrorGuidanceFields,
		...ErrorCauseFields,
		endpoint: Schema.String,
		operation: Schema.Literals(["inspect_selection", "inspect_subject", "preview_candidate"])
	}
) {}

const isRemoteControlClientError = Schema.is(RemoteControlClientError);

function reviewConnectionError(
	endpoint: string,
	operation: "inspect_selection" | "inspect_subject" | "preview_candidate",
	cause: RemoteControlClientError | unknown
): ReviewAuthoringConnectionError {
	if (isRemoteControlClientError(cause)) {
		return new ReviewAuthoringConnectionError({
			endpoint,
			message: cause.message,
			nextStep: cause.nextStep,
			operation,
			recovery: cause.recovery,
			retrySafe: cause.retrySafe,
			cause
		});
	}
	return new ReviewAuthoringConnectionError({
		endpoint,
		message: `Map Review ${operation} at ${endpoint} failed unexpectedly.`,
		nextStep: "escalate",
		operation,
		recovery: "Verify the Map Review editor capability and retry the operation.",
		retrySafe: false,
		cause
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
			parameters: args.parameters
		})
		.pipe(
			Effect.mapError((error) => reviewConnectionError(args.endpoint, args.operation, error))
		);
}

/**
 * Candidate image bytes/dimensions with current subject projection and optional realized
 * render evidence. This is a preview, separate from approval and immutable run publication.
 */
export interface ReviewCandidatePreview {
	readonly renderEvidence?: CameraFrameEvidence;
	readonly bytes: Uint8Array;
	readonly height: number;
	readonly projection: ReviewSubjectProjection;
	readonly width: number;
}

/**
 * Explicit candidate, endpoint, expected map, profile and subject for preview. The host
 * supplies selected-project context; preview does not select a different project.
 */
export interface PreviewReviewCandidateArgs {
	readonly candidate: FramingCandidate;
	readonly endpoint: string;
	readonly mapPath: string;
	readonly profile: CaptureProfile;
	readonly subject: typeof SubjectLocator.Type;
}

/**
 * Editor selection/subject inspection and candidate preview port. Generation and persistence
 * remain separate so headless hosts can reuse the authoring workflow.
 */
export interface ReviewAuthoringApi {
	readonly inspectSelection: (
		endpoint: string
	) => Effect.Effect<ReviewSelectionResponse, ReviewAuthoringConnectionError>;
	readonly inspectSubject: (args: {
		readonly endpoint: string;
		readonly subject: typeof SubjectLocator.Type;
	}) => Effect.Effect<ReviewSubjectInspectionResponse, ReviewAuthoringConnectionError>;
	readonly previewCandidate: (
		args: PreviewReviewCandidateArgs
	) => Effect.Effect<ReviewCandidatePreview, ReviewAuthoringConnectionError>;
}

/** @deprecated Use `ReviewAuthoringApi`. */
export type ReviewAuthoringShape = ReviewAuthoringApi;

/**
 * Review authoring editor boundary. Requires an explicit endpoint per operation rather than
 * retaining a feature-owned active project.
 */
export class ReviewAuthoring extends Context.Service<ReviewAuthoring, ReviewAuthoringApi>()(
	"@ue-shed/cameras/ReviewAuthoring"
) {}

/**
 * RemoteControlClient-backed selection/subject inspection and rendered candidate previews
 * with contract validation. Preserves connection/parser causes and framing evidence.
 */
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
							message: `The editor at ${endpoint} returned a selection inspection response that does not match the Map Review contract.`,
							operation: "inspect_selection",
							recovery: "Verify the Map Review editor capability contract.",
							retrySafe: true,
							nextStep: "escalate",
							cause
						})
				),
				Effect.withSpan("camera.review.authoring.selection.inspect")
			);
		});

		const inspectSubject = Effect.fn("ReviewAuthoring.inspectSubject")(function* (args: {
			readonly endpoint: string;
			readonly subject: typeof SubjectLocator.Type;
		}) {
			const subject = yield* Schema.decodeUnknownEffect(SubjectLocator)(args.subject).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewAuthoringConnectionError({
							endpoint: args.endpoint,
							message:
								"The persisted subject locator does not match the subject locator contract.",
							operation: "inspect_subject",
							recovery:
								"Discard the malformed authoring session and create a new one.",
							retrySafe: true,
							nextStep: "fix_input",
							cause
						})
				)
			);
			const value = yield* remoteReviewCall(client, {
				endpoint: args.endpoint,
				functionName:
					subject.kind === "actor_guid"
						? "InspectReviewSubjectByGuid"
						: "InspectReviewSubject",
				operation: "inspect_subject",
				parameters:
					subject.kind === "actor_guid"
						? { ActorGuid: subject.actorGuid }
						: { ActorPath: subject.actorPath }
			});
			return yield* decodeReviewSubjectInspectionResponse(value).pipe(
				Effect.mapError(
					(cause) =>
						new ReviewAuthoringConnectionError({
							endpoint: args.endpoint,
							message: `The editor at ${args.endpoint} returned a subject inspection response for ${subject.kind === "actor_guid" ? `actor ${subject.actorGuid}` : subject.actorPath} that does not match the Map Review contract.`,
							operation: "inspect_subject",
							recovery:
								"Verify the persisted subject and Map Review editor capability.",
							retrySafe: true,
							nextStep: "escalate",
							cause
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
					assessment: { method: "automatic" },
					clearCompanion: { status: "not_requested" },
					contract: {
						name: "ue-shed-review-capture",
						version: { major: 1, minor: 6 }
					},
					expectedMapPath: args.mapPath,
					operationId,
					resolution: args.profile.resolution,
					renderPolicy: args.profile.renderPolicy ?? legacyReviewRenderPolicy,
					subject: args.subject,
					viewId: previewViewId,
					viewpoint: {
						approvedPose: args.candidate.approvedPose,
						kind: "world_fixed"
					}
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
							retrySafe: cause.retrySafe,
							nextStep: cause.nextStep,
							cause
						})
				)
			);
			if (response.status === "failed") {
				return yield* new ReviewAuthoringConnectionError({
					endpoint: args.endpoint,
					message: response.message,
					operation: "preview_candidate",
					recovery: response.recovery,
					retrySafe: response.retrySafe,
					nextStep: response.retrySafe ? "retry" : "reconcile"
				});
			}
			if (!response.subjectProjection) {
				return yield* new ReviewAuthoringConnectionError({
					endpoint: args.endpoint,
					message:
						"The preview rendered, but the subject has no available framing bounds in the editor world.",
					operation: "preview_candidate",
					recovery:
						"Load the subject to assess authoring framing, or capture its independent approved camera without actor assessment.",
					retrySafe: false,
					nextStep: "fix_input"
				});
			}
			const projection = response.subjectProjection;
			const stagingPath = pureStagingPath(response);
			return yield* Effect.tryPromise({
				try: async () => {
					try {
						return {
							...("renderEvidence" in response &&
							response.renderEvidence !== undefined
								? { renderEvidence: response.renderEvidence }
								: undefined),
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
						message: `Could not read the staged preview for candidate ${args.candidate.id} because ${fileFailureReason(cause)}.`,
						operation: "preview_candidate",
						recovery: "Check the Unreal staging directory and retry the preview.",
						retrySafe: true,
						nextStep: "retry",
						cause
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

/** A test layer over a complete fake; the test decides every operation. */
export function makeReviewAuthoringTestLayer(
	service: ReviewAuthoringApi
): Layer.Layer<ReviewAuthoring> {
	return Layer.succeed(ReviewAuthoring, ReviewAuthoring.of(service));
}

/** Compatibility accessors until Plans 012–014 compose ReviewAuthoring layers directly. */
export function inspectReviewSelection(
	endpoint: string
): Effect.Effect<ReviewSelectionResponse, ReviewAuthoringConnectionError, RemoteControlClient> {
	return Effect.flatMap(ReviewAuthoring, (service) => service.inspectSelection(endpoint)).pipe(
		Effect.provide(ReviewAuthoringLive)
	);
}

/**
 * Runs the production candidate-preview adapter using the caller's RemoteControlClient layer.
 * Does not approve the pose or persist a capture run.
 */
export function previewReviewCandidate(
	args: PreviewReviewCandidateArgs
): Effect.Effect<ReviewCandidatePreview, ReviewAuthoringConnectionError, RemoteControlClient> {
	return Effect.flatMap(ReviewAuthoring, (service) => service.previewCandidate(args)).pipe(
		Effect.provide(ReviewAuthoringLive)
	);
}
