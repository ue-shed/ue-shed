import { readFile } from "node:fs/promises";
import { Effect, Layer, Schema } from "effect";
import { CliCommandError, CliRuntime, printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type Command<Tag extends CliCommand["_tag"]> = Extract<CliCommand, { readonly _tag: Tag }>;
type FramingCommand = Command<"ReviewFramingCandidates" | "ReviewFramingApprove">;
type PoliciesCommand = Command<
	"ReviewPoliciesList" | "ReviewPoliciesReplace" | "ReviewPoliciesApply"
>;
type AuthoringCommand = Command<
	| "ReviewAuthoringStart"
	| "ReviewAuthoringAppend"
	| "ReviewAuthoringBootstrap"
	| "ReviewAuthoringShow"
	| "ReviewAuthoringTune"
	| "ReviewAuthoringResume"
	| "ReviewAuthoringDiscard"
	| "ReviewAuthoringReframe"
	| "ReviewAuthoringApprove"
>;

export const runReviewSetValidate = Effect.fn("Cli.workflow.review_set_validate")(
	(command: Command<"ReviewSetValidate">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { ReviewRepository, ReviewRepositoryLive } = yield* Effect.promise(
					() => import("@ue-shed/cameras")
				);
				const program = Effect.gen(function* () {
					const repository = yield* ReviewRepository;
					const reviewSet = yield* repository.loadSet(command.reviewSetPath);
					return yield* printJson({
						contract: reviewSet.contract,
						id: reviewSet.id,
						profiles: reviewSet.captureProfiles.length,
						status: "valid",
						views: reviewSet.views.length
					});
				});
				return yield* program.pipe(Effect.provide(ReviewRepositoryLive));
			})
		)
);

function readJsonDocument(path: string): Effect.Effect<unknown, CliCommandError> {
	return Effect.tryPromise({
		try: async () =>
			Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8"))),
		catch: (cause) =>
			new CliCommandError({
				message: `Could not read JSON document ${path}: ${String(cause)}`
			})
	});
}

export const runReviewPolicies = Effect.fn("Cli.workflow.review_policies")(
	(command: PoliciesCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const {
					applyVisibilityPolicyToViewsAtPath,
					inspectReviewVisibilityPolicies,
					inspectReviewVisibilityPoliciesAtPath,
					replaceViewVisibilityPolicyAtPath,
					ReviewRepositoryLive,
					ReviewViewId,
					VisibilityOverrides,
					VisibilityPolicy,
					VisibilityPolicyId
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const program = Effect.gen(function* () {
					if (command._tag === "ReviewPoliciesList") {
						return yield* inspectReviewVisibilityPoliciesAtPath(
							command.reviewSetPath
						).pipe(Effect.flatMap(printJson));
					}
					if (command._tag === "ReviewPoliciesApply") {
						const reviewSet = yield* applyVisibilityPolicyToViewsAtPath({
							path: command.reviewSetPath,
							policyId: VisibilityPolicyId.make(command.policyId),
							viewIds: command.viewIds.map((viewId) => ReviewViewId.make(viewId))
						});
						return yield* printJson({
							policyId: command.policyId,
							status: "applied",
							viewIds: command.viewIds,
							visibility: inspectReviewVisibilityPolicies(reviewSet)
						});
					}
					const policyInput = yield* readJsonDocument(command.policyPath);
					const policy = yield* Schema.decodeUnknownEffect(VisibilityPolicy)(
						policyInput
					).pipe(
						Effect.mapError(
							(cause) =>
								new CliCommandError({
									message: `Invalid Visibility Policy: ${String(cause)}`
								})
						)
					);
					const overrides =
						command.overridesPath === undefined
							? undefined
							: yield* readJsonDocument(command.overridesPath).pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(VisibilityOverrides)),
									Effect.mapError(
										(cause) =>
											new CliCommandError({
												message: `Invalid Visibility Overrides: ${String(cause)}`
											})
									)
								);
					const reviewSet = yield* replaceViewVisibilityPolicyAtPath({
						path: command.reviewSetPath,
						policy,
						viewId: ReviewViewId.make(command.viewId),
						...(overrides === undefined
							? undefined
							: { visibilityOverrides: overrides })
					});
					return yield* printJson({
						policyId: policy.id,
						status: "replaced",
						viewId: command.viewId,
						visibility: inspectReviewVisibilityPolicies(reviewSet)
					});
				});
				return yield* program.pipe(Effect.provide(ReviewRepositoryLive));
			})
		)
);

export const runReviewViewPut = Effect.fn("Cli.workflow.review_view_put")(
	(command: Command<"ReviewViewPut">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { putReviewViewAtPath, ReviewRepositoryLive, ReviewView } =
					yield* Effect.promise(() => import("@ue-shed/cameras"));
				const input = yield* readJsonDocument(command.viewPath);
				const view = yield* Schema.decodeUnknownEffect(ReviewView)(input).pipe(
					Effect.mapError(
						(cause) =>
							new CliCommandError({
								message: `Invalid Review View: ${String(cause)}`
							})
					)
				);
				const result = yield* putReviewViewAtPath({
					path: command.reviewSetPath,
					view
				}).pipe(Effect.provide(ReviewRepositoryLive));
				return yield* printJson({
					revision: result.view.revision,
					status: result.status,
					viewId: result.view.id
				});
			})
		)
);

export const runReviewFraming = Effect.fn("Cli.workflow.review_framing")(
	(command: FramingCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const {
					approveFramingCandidate,
					FramingCandidateId,
					FramingParameters,
					generateFramingCandidates,
					ReviewAuthoring,
					ReviewAuthoringLive,
					ReviewRepository,
					ReviewRepositoryLive,
					ReviewViewId
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const program = Effect.gen(function* () {
					const authoring = yield* ReviewAuthoring;
					const selection = yield* authoring.inspectSelection(command.endpoint);
					if (selection.status === "failed") {
						return yield* Effect.fail(
							new CliCommandError({
								message: `${selection.message} ${selection.recovery}`
							})
						);
					}
					const parameters =
						command.parametersPath === undefined
							? undefined
							: yield* readJsonDocument(command.parametersPath).pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(FramingParameters)),
									Effect.mapError(
										(cause) =>
											new CliCommandError({
												message: `Invalid Framing Parameters: ${String(cause)}`
											})
									)
								);
					const candidates =
						parameters === undefined
							? generateFramingCandidates(selection)
							: generateFramingCandidates(selection, parameters);
					if (command._tag === "ReviewFramingCandidates") {
						return yield* printJson({ candidates, selection });
					}
					const candidate = candidates.find(
						(item) => item.id === FramingCandidateId.make(command.candidateId)
					);
					if (!candidate) {
						return yield* Effect.fail(
							new CliCommandError({
								message: `Unknown framing candidate: ${command.candidateId}`
							})
						);
					}
					const repository = yield* ReviewRepository;
					const reviewSet = yield* repository.loadSet(command.reviewSetPath);
					const approved = approveFramingCandidate({
						candidate,
						reviewSet,
						subject: {
							actorPath: selection.actorPath,
							diagnosticLabel: selection.displayName,
							kind: "actor_path"
						},
						viewId: ReviewViewId.make(command.viewId)
					});
					if (approved.status === "view_not_found") {
						return yield* Effect.fail(
							new CliCommandError({
								message: `Review View ${approved.viewId} was not found`
							})
						);
					}
					yield* repository.saveSet({
						path: command.reviewSetPath,
						reviewSet: approved.reviewSet
					});
					return yield* printJson({
						candidateId: candidate.id,
						status: "approved",
						viewId: command.viewId
					});
				});
				return yield* program.pipe(
					Effect.provide(ReviewRepositoryLive),
					Effect.provide(ReviewAuthoringLive.pipe(Layer.provide(RemoteControlClientLive)))
				);
			})
		)
);

export const runReviewAuthoring = Effect.fn("Cli.workflow.review_authoring")(
	(command: AuthoringCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const {
					generateFramingCandidates,
					ReviewAuthoring,
					ReviewAuthoringLive,
					ReviewAuthoringSessions,
					ReviewAuthoringSessionsLive,
					ReviewAuthoringSessionPatch,
					ReviewRepositoryLive
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const reviewAuthoring = ReviewAuthoringLive.pipe(
					Layer.provide(RemoteControlClientLive)
				);
				const program = Effect.gen(function* () {
					const sessions = yield* ReviewAuthoringSessions;
					if (command._tag === "ReviewAuthoringShow") {
						return yield* sessions
							.load({
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					if (command._tag === "ReviewAuthoringTune") {
						const patchInput = yield* readJsonDocument(command.patchPath);
						const patch = yield* Schema.decodeUnknownEffect(
							ReviewAuthoringSessionPatch
						)(patchInput).pipe(
							Effect.mapError(
								(cause) =>
									new CliCommandError({
										message: `Invalid Review Authoring Patch: ${String(cause)}`
									})
							)
						);
						return yield* sessions
							.patch({
								patch,
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					if (command._tag === "ReviewAuthoringDiscard") {
						return yield* sessions
							.discard({
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					if (command._tag === "ReviewAuthoringResume") {
						return yield* sessions
							.resume({
								endpoint: command.endpoint,
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					if (command._tag === "ReviewAuthoringApprove") {
						return yield* sessions
							.approve({
								endpoint: command.endpoint,
								projectRoot: command.projectRoot,
								sessionId: command.sessionId
							})
							.pipe(Effect.flatMap(printJson));
					}
					const authoring = yield* ReviewAuthoring;
					const selection = yield* authoring.inspectSelection(command.endpoint);
					if (selection.status === "failed") {
						return yield* Effect.fail(
							new CliCommandError({
								message: `${selection.message} ${selection.recovery}`
							})
						);
					}
					const candidates = generateFramingCandidates(selection);
					const session =
						command._tag === "ReviewAuthoringBootstrap"
							? yield* sessions.start({
									candidates,
									destination: { kind: "append_view" },
									projectRoot: command.projectRoot,
									selection
								})
							: command._tag === "ReviewAuthoringAppend"
								? yield* sessions.start({
										candidates,
										destination: { kind: "append_view" },
										projectRoot: command.projectRoot,
										reviewSetPath: command.reviewSetPath,
										selection
									})
								: command._tag === "ReviewAuthoringStart"
									? yield* sessions.create({
											candidates,
											projectRoot: command.projectRoot,
											reviewSetPath: command.reviewSetPath,
											selection,
											viewId: command.viewId
										})
									: yield* sessions.reframe({
											candidates,
											projectRoot: command.projectRoot,
											selection,
											sessionId: command.sessionId
										});
					return yield* printJson(session);
				});
				return yield* program.pipe(
					Effect.provide(reviewAuthoring),
					Effect.provide(
						ReviewAuthoringSessionsLive.pipe(
							Layer.provide(Layer.mergeAll(ReviewRepositoryLive, reviewAuthoring))
						)
					)
				);
			})
		)
);

export const runReviewCapture = Effect.fn("Cli.workflow.review_capture")(
	(command: Command<"ReviewCapture">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const runtime = yield* CliRuntime;
				const {
					CaptureInvocation,
					CaptureInvocationId,
					ReviewCapture,
					ReviewCaptureLive,
					reviewCaptureRemotePortLayer,
					ReviewIdGeneratorLive,
					ReviewIdGenerator,
					ReviewRepository,
					ReviewRepositoryLive
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const captureDependencies = Layer.mergeAll(
					ReviewRepositoryLive,
					ReviewIdGeneratorLive,
					reviewCaptureRemotePortLayer(command.endpoint).pipe(
						Layer.provide(RemoteControlClientLive)
					)
				);
				const program = Effect.gen(function* () {
					const capture = yield* ReviewCapture;
					const repository = yield* ReviewRepository;
					const ids = yield* ReviewIdGenerator;
					const reviewSet = yield* repository.loadSet(command.reviewSetPath);
					const invocation =
						command.cause === undefined
							? undefined
							: CaptureInvocation.make({
									cause: {
										type: "external_automation",
										...(command.correlationId === undefined
											? undefined
											: { correlationId: command.correlationId })
									},
									id: CaptureInvocationId.make(yield* ids.generate()),
									reviewSetId: reviewSet.id
								});
					const run = yield* capture.captureSet({
						...command,
						...(invocation === undefined ? undefined : { invocation })
					});
					yield* printJson(run);
					if (run.status !== "completed") yield* runtime.setExitCode(1);
				});
				return yield* program.pipe(
					Effect.provide(ReviewCaptureLive.pipe(Layer.provide(captureDependencies))),
					Effect.provide(captureDependencies)
				);
			})
		)
);

export const runReviewHistory = Effect.fn("Cli.workflow.review_history")(
	(command: Command<"ReviewHistory">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { ReviewRepository, ReviewRepositoryLive } = yield* Effect.promise(
					() => import("@ue-shed/cameras")
				);
				const program = Effect.gen(function* () {
					const repository = yield* ReviewRepository;
					return yield* repository
						.listRuns(command.projectRoot)
						.pipe(Effect.flatMap((runs) => printJson({ runs })));
				});
				return yield* program.pipe(Effect.provide(ReviewRepositoryLive));
			})
		)
);

export const runReviewShow = Effect.fn("Cli.workflow.review_show")(
	(command: Command<"ReviewShow">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { ReviewRepository, ReviewRepositoryLive } = yield* Effect.promise(
					() => import("@ue-shed/cameras")
				);
				const program = Effect.gen(function* () {
					const repository = yield* ReviewRepository;
					return yield* repository
						.loadRun(command.runPath)
						.pipe(Effect.flatMap(printJson));
				});
				return yield* program.pipe(Effect.provide(ReviewRepositoryLive));
			})
		)
);
