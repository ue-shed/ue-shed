import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	makeRemoteControlClient,
	RemoteControlClient,
	type RemoteControlClientApi
} from "@ue-shed/unreal-connection";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { captureReviewView } from "./review-live.js";
import {
	ReviewRepository,
	projectLocalReviewCaptureDestination,
	ReviewArtifactSourceRejected,
	type ReviewCaptureAttempt,
	type ReviewCaptureDestination,
	type ReviewRepositoryApi,
	type ReviewStorageError
} from "./review-repository.js";
import {
	CaptureRunId,
	ArtifactId,
	CaptureInvocation,
	CaptureInvocationId,
	ReviewClearCompanionRequest,
	ReviewCaptureRequestCurrent,
	decodeCaptureRun,
	type CaptureRun,
	type CaptureInvocation as CaptureInvocationValue,
	type ReviewCaptureResponse,
	type ReviewSet,
	type ReviewViewId,
	type VisibilityResult,
	type ViewResult
} from "./review-schema.js";

export class ReviewCaptureRunError extends Schema.TaggedErrorClass<ReviewCaptureRunError>()(
	"ReviewCaptureRunError",
	{
		message: Schema.String,
		operation: Schema.Literals(["prepare", "capture", "finalize"]),
		recovery: Schema.String,
		runId: Schema.String
	}
) {}

export const ReviewCaptureConcurrency = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type ReviewCaptureConcurrency = Schema.Schema.Type<typeof ReviewCaptureConcurrency>;

/**
 * Unreal CaptureReviewView mutates shared editor camera state, so the live default is
 * serialized (`concurrency: 1`). Effect.forEach still owns the limit so tests and safe
 * fake ports can raise it explicitly.
 */
export const defaultReviewCaptureConcurrency = ReviewCaptureConcurrency.make(1);

type SchemaReviewCaptureRequest = typeof ReviewCaptureRequestCurrent.Type;

export interface ReviewCapturePortApi {
	readonly capture: (
		request: SchemaReviewCaptureRequest
	) => Effect.Effect<ReviewCaptureResponse, unknown>;
}

/** @deprecated Use `ReviewCapturePortApi`. */
export type ReviewCapturePortShape = ReviewCapturePortApi;

export class ReviewCapturePort extends Context.Service<ReviewCapturePort, ReviewCapturePortApi>()(
	"@ue-shed/cameras/ReviewCapturePort"
) {}

export interface ReviewIdGeneratorApi {
	readonly generate: () => Effect.Effect<string>;
}

/** @deprecated Use `ReviewIdGeneratorApi`. */
export type ReviewIdGeneratorShape = ReviewIdGeneratorApi;

export class ReviewIdGenerator extends Context.Service<ReviewIdGenerator, ReviewIdGeneratorApi>()(
	"@ue-shed/cameras/ReviewIdGenerator"
) {}

export const ReviewIdGeneratorLive = Layer.succeed(
	ReviewIdGenerator,
	ReviewIdGenerator.of({
		generate: Effect.fn("ReviewIdGenerator.generate")(() => Effect.sync(randomUUID))
	})
);

export function reviewIdGeneratorLayer(makeId: () => string): Layer.Layer<ReviewIdGenerator> {
	return Layer.succeed(
		ReviewIdGenerator,
		ReviewIdGenerator.of({
			generate: Effect.fn("ReviewIdGenerator.Test.generate")(() => Effect.sync(makeId))
		})
	);
}

export interface CaptureReviewSetOptions {
	readonly concurrency?: ReviewCaptureConcurrency;
	/**
	 * Final Capture Run storage. Omit this to publish beneath
	 * `<project>/.ue-shed/review/runs` through the project-local adapter.
	 */
	readonly destination?: ReviewCaptureDestination;
	readonly endpoint: string;
	/**
	 * A validated request from a person or an external caller. Scheduling remains outside Map Review.
	 * Omit this only for the single-command ergonomic path, which creates a manual invocation.
	 */
	readonly invocation?: CaptureInvocationValue;
	readonly projectRoot: string;
	readonly reviewSetPath: string;
	readonly viewIds?: ReadonlyArray<ReviewViewId>;
}

export function manualCaptureInvocation(args: {
	readonly id: CaptureInvocationId;
	readonly reviewSetId: (typeof CaptureInvocation)["Type"]["reviewSetId"];
	readonly viewIds?: ReadonlyArray<ReviewViewId>;
}): CaptureInvocationValue {
	return CaptureInvocation.make({
		cause: { type: "manual" },
		id: args.id,
		reviewSetId: args.reviewSetId,
		...(args.viewIds === undefined ? undefined : { viewIds: [...args.viewIds] })
	});
}

function sha256(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isoNow(millis: number): string {
	return new Date(millis).toISOString();
}

function remoteCapturePort(client: RemoteControlClientApi, endpoint: string): ReviewCapturePortApi {
	return {
		capture: (request) =>
			captureReviewView({ endpoint, request }).pipe(
				Effect.provideService(RemoteControlClient, client)
			)
	};
}

export function reviewCaptureRemotePortLayer(
	endpoint: string | Effect.Effect<string>
): Layer.Layer<ReviewCapturePort, never, RemoteControlClient> {
	return Layer.effect(
		ReviewCapturePort,
		Effect.gen(function* () {
			const client = yield* RemoteControlClient;
			const selected = Effect.isEffect(endpoint) ? endpoint : Effect.succeed(endpoint);
			return ReviewCapturePort.of({
				capture: (request) =>
					selected.pipe(
						Effect.flatMap((value) => remoteCapturePort(client, value).capture(request))
					)
			});
		})
	);
}

export function reviewCapturePortLayer(
	service: ReviewCapturePortApi
): Layer.Layer<ReviewCapturePort> {
	return Layer.succeed(ReviewCapturePort, ReviewCapturePort.of(service));
}

function durableVisibility(
	response: Extract<ReviewCaptureResponse, { readonly status: "captured" }>
): VisibilityResult {
	if (!("visibility" in response)) {
		return {
			reason: "The connected editor capability does not provide visibility assessment.",
			status: "not_assessed"
		};
	}
	if (response.visibility.status === "assessed" && "classification" in response.visibility) {
		const { classification, ...measurement } = response.visibility;
		return {
			...measurement,
			legacyInterpretation: {
				classification,
				source: "capture_run_pre_1_3"
			}
		};
	}
	return response.visibility;
}

function clearCompanionRequest(args: {
	readonly policy: ReviewSet["visibilityPolicies"][number];
	readonly view: ReviewSet["views"][number];
}): ReviewClearCompanionRequest {
	if (args.policy.output.mode === "natural_only") {
		return ReviewClearCompanionRequest.make({ status: "not_requested" });
	}
	if (args.policy.output.clearStrategy.type === "isolate_target") {
		return ReviewClearCompanionRequest.make({
			status: "requested",
			strategy: "isolate_target"
		});
	}
	return ReviewClearCompanionRequest.make({
		actors: (args.view.visibilityOverrides?.hideInClear ?? []).map(
			(locator) => locator.actorPath
		),
		status: "requested",
		strategy: "hide_explicit"
	});
}

function stagedArtifacts(
	response: Extract<ReviewCaptureResponse, { readonly status: "captured" }>
) {
	return "stagedArtifacts" in response
		? response.stagedArtifacts
		: [{ stagingPath: response.stagingPath, variant: "pure" as const }];
}

function durableClearCompanion(
	response: Extract<ReviewCaptureResponse, { readonly status: "captured" }>
) {
	return "clearCompanion" in response
		? response.clearCompanion
		: { status: "not_requested" as const };
}

function captureOneView(args: {
	readonly attempt: ReviewCaptureAttempt;
	readonly capturePort: ReviewCapturePortApi;
	readonly ids: ReviewIdGeneratorApi;
	readonly projectRoot: string;
	readonly reviewSet: ReviewSet;
	readonly runId: typeof CaptureRunId.Type;
	readonly unrealStagingRoot: string;
	readonly view: ReviewSet["views"][number];
}): Effect.Effect<ViewResult, ReviewStorageError> {
	return Effect.gen(function* () {
		const profile = args.reviewSet.captureProfiles.find(
			(candidate) => candidate.id === args.view.captureProfileId
		);
		if (!profile) {
			return {
				code: "capture_profile_missing",
				message: `Review View ${args.view.id} references missing profile ${args.view.captureProfileId}`,
				recovery: "Add the profile to the Review Set or update the Review View.",
				retrySafe: false,
				status: "failed" as const,
				viewId: args.view.id,
				viewRevision: args.view.revision
			};
		}
		const visibilityPolicy = args.reviewSet.visibilityPolicies.find(
			(candidate) => candidate.id === args.view.visibilityPolicyId
		);
		if (!visibilityPolicy) {
			return {
				code: "visibility_policy_missing",
				message: `Review View ${args.view.id} references missing policy ${args.view.visibilityPolicyId}`,
				recovery: "Add the policy to the Review Set or update the Review View.",
				retrySafe: false,
				status: "failed" as const,
				viewId: args.view.id,
				viewRevision: args.view.revision
			};
		}
		const operationId = yield* args.ids.generate();
		const request = ReviewCaptureRequestCurrent.make({
			assessment: visibilityPolicy.assessment,
			clearCompanion: clearCompanionRequest({ policy: visibilityPolicy, view: args.view }),
			contract: {
				name: "ue-shed-review-capture",
				version: { major: 1, minor: 5 }
			},
			expectedMapPath: args.reviewSet.project.mapPath,
			operationId,
			resolution: profile.resolution,
			subject:
				args.view.target.kind === "actor"
					? args.view.target.subject
					: { bounds: args.view.target.bounds, kind: "oriented_bounds" },
			viewId: args.view.id,
			viewpoint: args.view.viewpoint
		});
		const response = yield* args.capturePort.capture(request).pipe(
			Effect.catch((cause) =>
				Effect.succeed({
					code: "capture_connection_failed",
					message: String(cause),
					operationId,
					recovery:
						"Verify the editor capability and Remote Control endpoint, then retry.",
					retrySafe: true,
					contract: {
						name: "ue-shed-review-capture" as const,
						version: { major: 1 as const, minor: 5 as const }
					},
					status: "failed" as const,
					viewId: args.view.id
				})
			)
		);
		if (response.status === "failed") {
			return {
				code: response.code,
				message: response.message,
				recovery: response.recovery,
				retrySafe: response.retrySafe,
				status: "failed" as const,
				viewId: args.view.id,
				viewRevision: args.view.revision
			};
		}
		if (response.mapPackageDirtyAfter !== response.mapPackageDirtyBefore) {
			return {
				code: "map_package_dirty_state_changed",
				message: "Transient review capture changed the map package dirty state.",
				recovery: "Inspect the editor map before retrying; do not save tooling changes.",
				retrySafe: false,
				status: "failed" as const,
				viewId: args.view.id,
				viewRevision: args.view.revision
			};
		}
		const responseArtifacts = stagedArtifacts(response);
		const artifacts = yield* Effect.forEach(responseArtifacts, (artifact) => {
			const relativePath = `views/${args.view.id}/${artifact.variant}.png`;
			return args.attempt
				.storeArtifact({
					relativePath,
					sourceAuthorizationRoot: args.projectRoot,
					sourcePath: artifact.stagingPath,
					sourceRoot: args.unrealStagingRoot
				})
				.pipe(
					Effect.map((stored) => ({
						byteLength: stored.size,
						contentHash: sha256(stored.bytes),
						height: response.height,
						id: ArtifactId.make(`${args.runId}:${args.view.id}:${artifact.variant}`),
						mediaType: "image/png" as const,
						relativePath,
						variant: artifact.variant,
						width: response.width
					}))
				);
		}).pipe(
			Effect.catchTag("ReviewArtifactSourceRejected", (cause: ReviewArtifactSourceRejected) =>
				Effect.succeed(cause)
			)
		);
		if (artifacts instanceof ReviewArtifactSourceRejected) {
			return {
				code: "capture_staging_path_rejected",
				message: artifacts.message,
				recovery: "Verify the connected project and editor capability version.",
				retrySafe: false,
				status: "failed" as const,
				viewId: args.view.id,
				viewRevision: args.view.revision
			};
		}
		const result = {
			artifacts,
			captureDurationMs: response.captureDurationMs,
			clearCompanion: durableClearCompanion(response),
			realization:
				"resolvedSubject" in response
					? {
							effectiveWorldPose: response.effectiveWorldPose,
							resolvedSubject: response.resolvedSubject,
							status: "resolved" as const,
							viewpoint: args.view.viewpoint
						}
					: {
							resolvedActorPath: response.actorPath,
							status: "legacy_not_recorded" as const
						},
			status: "captured" as const,
			viewId: args.view.id,
			viewRevision: args.view.revision,
			...(args.view.visibilityOverrides === undefined
				? undefined
				: { visibilityOverrides: args.view.visibilityOverrides }),
			visibilityPolicy,
			visibility: durableVisibility(response)
		};
		yield* args.attempt.writeDocument({
			relativePath: `views/${args.view.id}/result.json`,
			value: result
		});
		return result;
	});
}

function captureReviewSetWith(args: {
	readonly capturePort: ReviewCapturePortApi;
	readonly ids: ReviewIdGeneratorApi;
	readonly options: CaptureReviewSetOptions;
	readonly repository: ReviewRepositoryApi;
}): Effect.Effect<CaptureRun, ReviewCaptureRunError | ReviewStorageError> {
	const concurrency = args.options.concurrency ?? defaultReviewCaptureConcurrency;
	return Effect.gen(function* () {
		const reviewSet = yield* args.repository.loadSet(args.options.reviewSetPath);
		const runId = CaptureRunId.make(yield* args.ids.generate());
		const invocation =
			args.options.invocation ??
			manualCaptureInvocation({
				id: CaptureInvocationId.make(yield* args.ids.generate()),
				reviewSetId: reviewSet.id,
				...(args.options.viewIds === undefined
					? undefined
					: { viewIds: args.options.viewIds })
			});
		if (invocation.reviewSetId !== reviewSet.id) {
			return yield* Effect.fail(
				new ReviewCaptureRunError({
					message: "The Capture Invocation belongs to a different Review Set.",
					operation: "prepare",
					recovery: "Create an invocation for the Review Set being captured.",
					runId
				})
			);
		}
		const requestedViewIds = invocation.viewIds ?? args.options.viewIds;
		const views = requestedViewIds
			? reviewSet.views.filter((view) => requestedViewIds.includes(view.id))
			: reviewSet.views;
		if (views.length === 0 || views.length !== (requestedViewIds?.length ?? views.length)) {
			return yield* Effect.fail(
				new ReviewCaptureRunError({
					message:
						"The requested capture plan contains missing or duplicate Review View IDs.",
					operation: "prepare",
					recovery: "Reload the Review Set, review the capture plan, and retry.",
					runId
				})
			);
		}
		const destination =
			args.options.destination ??
			projectLocalReviewCaptureDestination(args.options.projectRoot);
		const projectRoot = resolve(args.options.projectRoot);
		const unrealStagingRoot = resolve(projectRoot, "Saved", "UEShed", "ReviewStaging");
		return yield* Effect.acquireUseRelease(
			destination.prepare(runId),
			(attempt) =>
				Effect.gen(function* () {
					const startedAt = isoNow(yield* Clock.currentTimeMillis);
					const results = yield* Effect.forEach(
						views,
						(view) =>
							captureOneView({
								attempt,
								capturePort: args.capturePort,
								ids: args.ids,
								projectRoot,
								reviewSet,
								runId,
								unrealStagingRoot,
								view
							}),
						{ concurrency }
					);

					const hardFailures = results.filter(
						(result) => result.status === "failed"
					).length;
					const clearFailures = results.filter(
						(result) =>
							result.status === "captured" &&
							result.clearCompanion.status === "failed"
					).length;
					const run = yield* decodeCaptureRun({
						completedAt: isoNow(yield* Clock.currentTimeMillis),
						contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 5 } },
						id: runId,
						invocation,
						project: reviewSet.project,
						results,
						reviewSetId: reviewSet.id,
						startedAt,
						status:
							hardFailures === results.length
								? "failed"
								: hardFailures > 0 || clearFailures > 0
									? "completed_with_failures"
									: "completed"
					}).pipe(
						Effect.mapError(
							(cause) =>
								new ReviewCaptureRunError({
									message: String(cause),
									operation: "finalize",
									recovery: "Inspect the generated Capture Run values and retry.",
									runId
								})
						)
					);

					const finalized = attempt.finalize(run).pipe(Effect.uninterruptible);
					return yield* finalized.pipe(Effect.as(run));
				}),
			(attempt) => attempt.discard().pipe(Effect.ignore)
		);
	}).pipe(
		Effect.withSpan("camera.review.run.capture", {
			attributes: {
				"camera.review.capture.concurrency": concurrency
			}
		})
	);
}

export interface ReviewCaptureApi {
	readonly captureSet: (
		options: CaptureReviewSetOptions
	) => Effect.Effect<CaptureRun, ReviewCaptureRunError | ReviewStorageError>;
}

/** @deprecated Use `ReviewCaptureApi`. */
export type ReviewCaptureShape = ReviewCaptureApi;

export class ReviewCapture extends Context.Service<ReviewCapture, ReviewCaptureApi>()(
	"@ue-shed/cameras/ReviewCapture"
) {}

export const ReviewCaptureLive = Layer.effect(
	ReviewCapture,
	Effect.gen(function* () {
		const repository = yield* ReviewRepository;
		const ids = yield* ReviewIdGenerator;
		const capturePort = yield* ReviewCapturePort;

		const captureSet = Effect.fn("ReviewCapture.captureSet")(function* (
			options: CaptureReviewSetOptions
		) {
			return yield* captureReviewSetWith({
				capturePort,
				ids,
				options,
				repository
			});
		});
		return ReviewCapture.of({ captureSet });
	})
);

export function makeReviewCaptureTestLayer(service: ReviewCaptureApi): Layer.Layer<ReviewCapture> {
	return Layer.succeed(ReviewCapture, ReviewCapture.of(service));
}

/** Compatibility accessor until Plans 012–014 compose ReviewCapture layers directly. */
export function captureReviewSet(
	options: CaptureReviewSetOptions
): Effect.Effect<CaptureRun, ReviewCaptureRunError | ReviewStorageError, ReviewRepository> {
	const remoteClient = Layer.sync(RemoteControlClient, () =>
		makeRemoteControlClient({ defaultTimeout: "10 seconds" })
	);
	return Effect.flatMap(ReviewCapture, (service) => service.captureSet(options)).pipe(
		Effect.provide(ReviewCaptureLive),
		Effect.provide(reviewCaptureRemotePortLayer(options.endpoint)),
		Effect.provide(ReviewIdGeneratorLive),
		Effect.provide(remoteClient)
	);
}
