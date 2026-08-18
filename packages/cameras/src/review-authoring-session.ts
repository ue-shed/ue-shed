import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { bootstrapMapReviewSet } from "./review-bootstrap.js";
import {
	applyCandidateOverrides,
	approveFramingCandidate,
	createReviewViewFromCandidate,
	defaultFramingParameters,
	generateFramingCandidates,
	realizationFramingDiagnostics
} from "./review-framing.js";
import { ReviewAuthoring } from "./review-authoring-live.js";
import { ReviewRepository } from "./review-repository.js";
import {
	ReviewAuthoringSession,
	ReviewAuthoringSessionId,
	ReviewSet,
	ReviewViewId,
	type CaptureProfileId,
	type FramingCandidate,
	type FramingCandidateOverride,
	type FramingParameters,
	type ReviewAuthoringSession as ReviewAuthoringSessionDocument,
	type ReviewAuthoringSessionPatch,
	type ReviewAuthoringSessionRecovery,
	type ReviewAuthoringDestination,
	type ReviewCandidateRealization,
	type ReviewSelectionResponse,
	type ReviewSubjectProjection,
	type VisibilityPolicyId
} from "./review-schema.js";

export const REVIEW_AUTHORING_SESSIONS_DIRECTORY = "authoring-sessions";
type ReviewSessionStaleReason = Extract<
	ReviewAuthoringSessionRecovery,
	{ readonly status: "stale" }
>["reasons"][number];

export class ReviewAuthoringSessionError extends Schema.TaggedErrorClass<ReviewAuthoringSessionError>()(
	"ReviewAuthoringSessionError",
	{
		message: Schema.String,
		operation: Schema.Literals([
			"approve",
			"create",
			"discard",
			"list",
			"load",
			"patch",
			"reframe",
			"resume",
			"save"
		]),
		path: Schema.String,
		recovery: Schema.String
	}
) {}

function sessionRoot(projectRoot: string): string {
	return join(projectRoot, ".ue-shed", "review", REVIEW_AUTHORING_SESSIONS_DIRECTORY);
}

export function reviewAuthoringSessionPath(args: {
	readonly id: string;
	readonly projectRoot: string;
}): string {
	return join(sessionRoot(args.projectRoot), `${args.id}.json`);
}

/** Creates a stable, readable View id without treating a display label as unique. */
export function nextReviewViewId(args: {
	readonly displayName: string;
	readonly reviewSet: ReviewSet;
}): typeof ReviewViewId.Type {
	const stem =
		args.displayName
			.normalize("NFKD")
			.replaceAll(/[^A-Za-z0-9]+/g, "-")
			.replaceAll(/^-+|-+$/g, "")
			.toLowerCase()
			.slice(0, 112) || "review-view";
	const occupied = new Set(args.reviewSet.views.map((view) => view.id));
	if (!occupied.has(ReviewViewId.make(stem))) return ReviewViewId.make(stem);
	for (let suffix = 2; ; suffix += 1) {
		const suffixText = `-${suffix}`;
		const candidate = ReviewViewId.make(
			`${stem.slice(0, 128 - suffixText.length)}${suffixText}`
		);
		if (!occupied.has(candidate)) return candidate;
	}
}

function writeJsonAtomically<Value>(path: string, value: Value): Effect.Effect<void, unknown> {
	return Effect.tryPromise({
		try: async () => {
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				const handle = await open(temporary, "wx");
				try {
					await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temporary, path);
			} catch (cause) {
				await rm(temporary, { force: true });
				throw cause;
			}
		},
		catch: (cause) => cause
	});
}

function sessionError(args: {
	readonly cause: unknown;
	readonly operation: ReviewAuthoringSessionError["operation"];
	readonly path: string;
	readonly recovery: string;
}): ReviewAuthoringSessionError {
	return new ReviewAuthoringSessionError({
		message: String(args.cause),
		operation: args.operation,
		path: args.path,
		recovery: args.recovery
	});
}

function decodeSessionId(
	id: string,
	operation: ReviewAuthoringSessionError["operation"],
	projectRoot: string
): Effect.Effect<ReviewAuthoringSessionId, ReviewAuthoringSessionError> {
	return Schema.decodeUnknownEffect(ReviewAuthoringSessionId)(id).pipe(
		Effect.mapError((cause) =>
			sessionError({
				cause,
				operation,
				path: sessionRoot(projectRoot),
				recovery: "Use a safe authoring-session identifier."
			})
		)
	);
}

function loadDocument(args: {
	readonly id: string;
	readonly projectRoot: string;
}): Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError> {
	return Effect.gen(function* () {
		const id = yield* decodeSessionId(args.id, "load", args.projectRoot);
		const path = reviewAuthoringSessionPath({ id, projectRoot: args.projectRoot });
		const input = yield* Effect.tryPromise({
			try: async () =>
				Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8"))),
			catch: (cause) =>
				sessionError({
					cause,
					operation: "load",
					path,
					recovery: "Repair the authoring-session document or discard it."
				})
		});
		return yield* Schema.decodeUnknownEffect(ReviewAuthoringSession)(input).pipe(
			Effect.mapError((cause) =>
				sessionError({
					cause,
					operation: "load",
					path,
					recovery: "Repair the malformed authoring-session document or discard it."
				})
			)
		);
	}).pipe(Effect.withSpan("camera.review.authoring-session.load"));
}

function saveDocument(args: {
	readonly projectRoot: string;
	readonly session: ReviewAuthoringSessionDocument;
}): Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError> {
	const path = reviewAuthoringSessionPath({ id: args.session.id, projectRoot: args.projectRoot });
	return writeJsonAtomically(path, args.session).pipe(
		Effect.mapError((cause) =>
			sessionError({
				cause,
				operation: "save",
				path,
				recovery: "Check that the project-local review directory is writable."
			})
		),
		Effect.as(args.session),
		Effect.withSpan("camera.review.authoring-session.save", {
			attributes: { "camera.review.authoring-session.id": args.session.id }
		})
	);
}

function boundsChanged(
	left: ReviewAuthoringSessionDocument["subject"]["bounds"],
	right: ReviewAuthoringSessionDocument["subject"]["bounds"]
): boolean {
	return (
		Math.max(
			Math.abs(left.center.x - right.center.x),
			Math.abs(left.center.y - right.center.y),
			Math.abs(left.center.z - right.center.z),
			Math.abs(left.extent.x - right.extent.x),
			Math.abs(left.extent.y - right.extent.y),
			Math.abs(left.extent.z - right.extent.z)
		) > 1
	);
}

function parametersFromCandidates(candidates: readonly FramingCandidate[]): FramingParameters {
	const recipe = candidates.find((candidate) => candidate.recipe.version === 2)?.recipe;
	return recipe !== undefined && recipe.version === 2 && "parameters" in recipe
		? recipe.parameters
		: defaultFramingParameters();
}

function applyOverrides(args: {
	readonly candidates: readonly FramingCandidate[];
	readonly overrides: readonly FramingCandidateOverride[];
}): readonly FramingCandidate[] {
	const byCandidate = new Map(
		args.overrides.map((entry) => [entry.candidateId, entry.overrides] as const)
	);
	return args.candidates.map((candidate) => {
		const overrides = byCandidate.get(candidate.id);
		return overrides === undefined ? candidate : applyCandidateOverrides(candidate, overrides);
	});
}

function appendKeptCandidateViews(args: {
	readonly captureProfileId: CaptureProfileId;
	readonly candidates: readonly FramingCandidate[];
	readonly reviewSet: ReviewSet;
	readonly session: ReviewAuthoringSessionDocument;
	readonly visibilityPolicyId: VisibilityPolicyId;
}): ReviewSet {
	const subject = {
		actorPath: args.session.subject.actorPath,
		diagnosticLabel: args.session.subject.displayName,
		kind: "actor_path" as const
	};
	let views = [...args.reviewSet.views];
	for (const [index, candidate] of args.candidates.entries()) {
		const viewId =
			index === 0
				? args.session.viewId
				: nextReviewViewId({
						displayName: args.session.subject.displayName,
						reviewSet: ReviewSet.make({ ...args.reviewSet, views })
					});
		const manuallyAdjusted = args.session.selectedCandidateId === candidate.id;
		views = [
			...views,
			createReviewViewFromCandidate({
				candidate,
				captureProfileId: args.captureProfileId,
				displayName: candidate.displayName,
				...(manuallyAdjusted && args.session.draftPose !== undefined
					? { manualPose: args.session.draftPose }
					: undefined),
				...(manuallyAdjusted && args.session.manualReason !== undefined
					? { manualReason: args.session.manualReason }
					: undefined),
				purpose: `Review ${args.session.subject.displayName} · ${candidate.displayName}`,
				subject,
				tags: [],
				viewId,
				visibilityPolicyId: args.visibilityPolicyId
			})
		];
	}
	return ReviewSet.make({ ...args.reviewSet, views });
}

function staleSession(args: {
	readonly reasons: readonly ReviewSessionStaleReason[];
	readonly session: ReviewAuthoringSessionDocument;
}): ReviewAuthoringSessionDocument {
	return ReviewAuthoringSession.make({
		...args.session,
		diagnostics: [
			...args.session.diagnostics,
			{
				code:
					args.reasons.includes("bounds_changed") || args.reasons.includes("map_changed")
						? "subject_bounds_changed"
						: "bounds_snapshot",
				message:
					"The authoring session no longer matches the live subject. Reframe explicitly before keeping a Review View.",
				severity: "warning"
			}
		],
		lifecycle: "stale",
		updatedAt: new Date().toISOString()
	});
}

function staleRecovery(args: {
	readonly reasons: readonly ReviewSessionStaleReason[];
	readonly session: ReviewAuthoringSessionDocument;
}): Extract<ReviewAuthoringSessionRecovery, { readonly status: "stale" }> {
	return {
		reasons: args.reasons,
		recovery:
			"The stored draft is retained. Reframe the subject explicitly or discard the stale session.",
		session: args.session,
		status: "stale"
	};
}

export interface ReviewAuthoringSessionsApi {
	readonly approve: (args: {
		readonly endpoint: string;
		readonly projectRoot: string;
		readonly sessionId: string;
	}) => Effect.Effect<ReviewAuthoringSessionRecovery, ReviewAuthoringSessionError>;
	readonly create: (args: {
		readonly candidates: readonly FramingCandidate[];
		readonly pendingReviewSet?: ReviewAuthoringSessionDocument["pendingReviewSet"];
		readonly projectRoot: string;
		readonly reviewSetPath: string;
		readonly selection: Extract<ReviewSelectionResponse, { readonly status: "selected" }>;
		readonly sessionId?: string | undefined;
		readonly viewId: string;
	}) => Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError>;
	readonly start: (args: {
		readonly candidates: readonly FramingCandidate[];
		readonly destination: ReviewAuthoringDestination;
		readonly projectRoot: string;
		readonly reviewSetPath?: string | undefined;
		readonly selection: Extract<ReviewSelectionResponse, { readonly status: "selected" }>;
	}) => Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError>;
	readonly discard: (args: {
		readonly projectRoot: string;
		readonly sessionId: string;
	}) => Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError>;
	readonly load: (args: {
		readonly projectRoot: string;
		readonly sessionId: string;
	}) => Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError>;
	readonly latest: (args: {
		readonly projectRoot: string;
	}) => Effect.Effect<ReviewAuthoringSessionDocument | undefined, ReviewAuthoringSessionError>;
	readonly patch: (args: {
		readonly patch: ReviewAuthoringSessionPatch;
		readonly projectRoot: string;
		readonly sessionId: string;
	}) => Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError>;
	readonly recordProjection: (args: {
		readonly candidateId: string;
		readonly projectRoot: string;
		readonly projection: ReviewSubjectProjection;
		readonly sessionId: string;
	}) => Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError>;
	readonly reframe: (args: {
		readonly candidates: readonly FramingCandidate[];
		readonly projectRoot: string;
		readonly selection: Extract<ReviewSelectionResponse, { readonly status: "selected" }>;
		readonly sessionId: string;
	}) => Effect.Effect<ReviewAuthoringSessionDocument, ReviewAuthoringSessionError>;
	readonly resume: (args: {
		readonly endpoint: string;
		readonly projectRoot: string;
		readonly sessionId: string;
	}) => Effect.Effect<ReviewAuthoringSessionRecovery, ReviewAuthoringSessionError>;
}

export class ReviewAuthoringSessions extends Context.Service<
	ReviewAuthoringSessions,
	ReviewAuthoringSessionsApi
>()("@ue-shed/cameras/ReviewAuthoringSessions") {}

export const ReviewAuthoringSessionsLive = Layer.effect(
	ReviewAuthoringSessions,
	Effect.gen(function* () {
		const repository = yield* ReviewRepository;
		const authoring = yield* ReviewAuthoring;

		const create = Effect.fn("ReviewAuthoringSessions.create")(function* (args: {
			readonly candidates: readonly FramingCandidate[];
			readonly pendingReviewSet?: ReviewAuthoringSessionDocument["pendingReviewSet"];
			readonly projectRoot: string;
			readonly reviewSetPath: string;
			readonly selection: Extract<ReviewSelectionResponse, { readonly status: "selected" }>;
			readonly sessionId?: string | undefined;
			readonly viewId: string;
		}) {
			const id = yield* decodeSessionId(
				args.sessionId ?? randomUUID(),
				"create",
				args.projectRoot
			);
			const reviewSet =
				args.pendingReviewSet ??
				(yield* repository.loadSet(args.reviewSetPath).pipe(
					Effect.mapError((cause) =>
						sessionError({
							cause,
							operation: "create",
							path: args.reviewSetPath,
							recovery: "Open a valid Review Set before starting spatial authoring."
						})
					)
				));
			if (reviewSet.project.mapPath !== args.selection.mapPath) {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: `Review Set map ${reviewSet.project.mapPath} does not match selected subject map ${args.selection.mapPath}.`,
						operation: "create",
						path: args.reviewSetPath,
						recovery:
							"Open a Review Set for the selected map, or start a map-scoped set from that subject."
					})
				);
			}
			const now = new Date().toISOString();
			const session = ReviewAuthoringSession.make({
				candidates: [...args.candidates],
				candidateOverrides: [],
				...(args.pendingReviewSet === undefined
					? undefined
					: { pendingReviewSet: args.pendingReviewSet }),
				contract: {
					name: "ue-shed-review-authoring-session",
					version: { major: 1, minor: 0 }
				},
				createdAt: now,
				diagnostics: [],
				discardedCandidateIds: [],
				framingParameters: parametersFromCandidates(args.candidates),
				id,
				lifecycle: "active",
				realizations: [],
				reviewSet: {
					id: reviewSet.id,
					mapPath: reviewSet.project.mapPath,
					path: args.reviewSetPath
				},
				subject: {
					actorPath: args.selection.actorPath,
					bounds: args.selection.bounds,
					displayName: args.selection.displayName,
					mapPath: args.selection.mapPath
				},
				updatedAt: now,
				viewId: yield* Schema.decodeUnknownEffect(ReviewAuthoringSession.fields.viewId)(
					args.viewId
				).pipe(
					Effect.mapError((cause) =>
						sessionError({
							cause,
							operation: "create",
							path: args.reviewSetPath,
							recovery: "Use a Review View identifier from the configured Review Set."
						})
					)
				)
			});
			return yield* saveDocument({ projectRoot: args.projectRoot, session });
		});

		const start = Effect.fn("ReviewAuthoringSessions.start")(function* (args: {
			readonly candidates: readonly FramingCandidate[];
			readonly destination: ReviewAuthoringDestination;
			readonly projectRoot: string;
			readonly reviewSetPath?: string | undefined;
			readonly selection: Extract<ReviewSelectionResponse, { readonly status: "selected" }>;
		}) {
			if (args.reviewSetPath !== undefined) {
				const reviewSetPath = args.reviewSetPath;
				const reviewSet = yield* repository.loadSet(reviewSetPath).pipe(
					Effect.mapError((cause) =>
						sessionError({
							cause,
							operation: "create",
							path: reviewSetPath,
							recovery: "Open a valid Review Set before starting spatial authoring."
						})
					)
				);
				const destination = args.destination;
				const view =
					destination.kind === "revise_view"
						? reviewSet.views.find((candidate) => candidate.id === destination.viewId)
						: undefined;
				if (destination.kind === "revise_view" && view === undefined) {
					return yield* Effect.fail(
						new ReviewAuthoringSessionError({
							message: `Review View ${destination.viewId} was not found.`,
							operation: "create",
							path: reviewSetPath,
							recovery: "Reload the Review Set and choose an existing Review View."
						})
					);
				}
				return yield* create({
					candidates: args.candidates,
					...(destination.kind === "append_view"
						? { pendingReviewSet: reviewSet }
						: undefined),
					projectRoot: args.projectRoot,
					reviewSetPath,
					selection: args.selection,
					viewId:
						view?.id ??
						nextReviewViewId({ displayName: args.selection.displayName, reviewSet })
				});
			}

			const bootstrap = bootstrapMapReviewSet({
				projectRoot: args.projectRoot,
				selection: args.selection
			});
			const existing = yield* repository.findSet(bootstrap.reviewSetPath).pipe(
				Effect.mapError((cause) =>
					sessionError({
						cause,
						operation: "create",
						path: bootstrap.reviewSetPath,
						recovery: "Check that the map-scoped Review Set directory is readable."
					})
				)
			);
			const reviewSet = existing ?? bootstrap.reviewSet;
			if (reviewSet.project.mapPath !== args.selection.mapPath) {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: "The map-scoped Review Set does not match the selected subject.",
						operation: "create",
						path: bootstrap.reviewSetPath,
						recovery:
							"Select a subject in the intended map or configure a different Review Set."
					})
				);
			}
			const destination = args.destination;
			const view =
				destination.kind === "revise_view"
					? reviewSet.views.find((candidate) => candidate.id === destination.viewId)
					: undefined;
			if (destination.kind === "revise_view" && view === undefined) {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: `Review View ${destination.viewId} was not found.`,
						operation: "create",
						path: bootstrap.reviewSetPath,
						recovery: "Reload the Review Set and choose an existing Review View."
					})
				);
			}
			return yield* create({
				candidates: args.candidates,
				...(destination.kind === "append_view"
					? { pendingReviewSet: reviewSet }
					: undefined),
				projectRoot: args.projectRoot,
				reviewSetPath: bootstrap.reviewSetPath,
				selection: args.selection,
				viewId:
					view?.id ??
					nextReviewViewId({ displayName: args.selection.displayName, reviewSet })
			});
		});

		const patch = Effect.fn("ReviewAuthoringSessions.patch")(function* (args: {
			readonly patch: ReviewAuthoringSessionPatch;
			readonly projectRoot: string;
			readonly sessionId: string;
		}) {
			const session = yield* loadDocument({
				projectRoot: args.projectRoot,
				id: args.sessionId
			});
			if (session.lifecycle !== "active") {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: `Cannot change a ${session.lifecycle} authoring session.`,
						operation: "patch",
						path: reviewAuthoringSessionPath({
							id: session.id,
							projectRoot: args.projectRoot
						}),
						recovery: "Reframe an active session or discard this one."
					})
				);
			}
			const parameters = args.patch.framingParameters ?? session.framingParameters;
			const requestedOverrides =
				args.patch.candidateOverrides ?? session.candidateOverrides ?? [];
			const editorCandidate = session.candidates.find(
				(candidate) =>
					candidate.recipe.version === 1 && candidate.recipe.preset === "editor_view"
			);
			const framingChanged =
				args.patch.framingParameters !== undefined ||
				args.patch.candidateOverrides !== undefined;
			const regenerated = !framingChanged
				? session.candidates
				: generateFramingCandidates(
						{
							actorPath: session.subject.actorPath,
							bounds: session.subject.bounds,
							displayName: session.subject.displayName,
							...(editorCandidate === undefined
								? undefined
								: { editorView: editorCandidate.approvedPose }),
							mapPath: session.subject.mapPath
						},
						parameters ?? defaultFramingParameters()
					);
			if (regenerated.length === 0) {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: "The framing definition generated no candidates.",
						operation: "patch",
						path: reviewAuthoringSessionPath({
							id: session.id,
							projectRoot: args.projectRoot
						}),
						recovery: "Enable at least one framing group before updating the session."
					})
				);
			}
			const candidateIds = new Set(regenerated.map((candidate) => candidate.id));
			const retainedOverrides = requestedOverrides.filter((entry) =>
				candidateIds.has(entry.candidateId)
			);
			if (args.patch.framingParameters === undefined) {
				const invalidOverride = requestedOverrides.find(
					(entry) => !candidateIds.has(entry.candidateId)
				);
				if (invalidOverride !== undefined) {
					return yield* Effect.fail(
						new ReviewAuthoringSessionError({
							message: `Unknown framing candidate ${invalidOverride.candidateId}.`,
							operation: "patch",
							path: reviewAuthoringSessionPath({
								id: session.id,
								projectRoot: args.projectRoot
							}),
							recovery: "Reload the authoring session before applying overrides."
						})
					);
				}
			}
			const invalid = [
				...args.patch.discardedCandidateIds.filter((candidateId) =>
					args.patch.framingParameters === undefined
						? true
						: candidateIds.has(candidateId)
				),
				...(args.patch.selectedCandidateId === undefined ||
				args.patch.framingParameters !== undefined
					? []
					: [args.patch.selectedCandidateId])
			].find((candidateId) => !candidateIds.has(candidateId));
			if (invalid !== undefined) {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: `Unknown framing candidate ${invalid}.`,
						operation: "patch",
						path: reviewAuthoringSessionPath({
							id: session.id,
							projectRoot: args.projectRoot
						}),
						recovery: "Reload the authoring session and choose an available candidate."
					})
				);
			}
			const candidates = applyOverrides({
				candidates: regenerated,
				overrides: retainedOverrides
			});
			const selectedCandidateId =
				args.patch.selectedCandidateId !== undefined &&
				candidateIds.has(args.patch.selectedCandidateId)
					? args.patch.selectedCandidateId
					: undefined;
			const discardedCandidateIds = args.patch.discardedCandidateIds.filter((candidateId) =>
				candidateIds.has(candidateId)
			);
			const next = ReviewAuthoringSession.make({
				...session,
				...args.patch,
				candidateOverrides: retainedOverrides,
				candidates,
				discardedCandidateIds,
				...(parameters === undefined ? undefined : { framingParameters: parameters }),
				...(!framingChanged
					? undefined
					: {
							diagnostics: [],
							draftPose: undefined,
							manualReason: undefined,
							realizations: []
						}),
				selectedCandidateId,
				updatedAt: new Date().toISOString()
			});
			return yield* saveDocument({ projectRoot: args.projectRoot, session: next });
		});

		const recordProjection = Effect.fn("ReviewAuthoringSessions.recordProjection")(
			function* (args: {
				readonly candidateId: string;
				readonly projectRoot: string;
				readonly projection: ReviewSubjectProjection;
				readonly sessionId: string;
			}) {
				const session = yield* loadDocument({
					projectRoot: args.projectRoot,
					id: args.sessionId
				});
				const candidate = session.candidates.find((item) => item.id === args.candidateId);
				if (!candidate) {
					return yield* Effect.fail(
						new ReviewAuthoringSessionError({
							message: `Unknown framing candidate ${args.candidateId}.`,
							operation: "patch",
							path: reviewAuthoringSessionPath({
								id: session.id,
								projectRoot: args.projectRoot
							}),
							recovery:
								"Reload the authoring session and preview an available candidate."
						})
					);
				}
				const diagnostics = realizationFramingDiagnostics({
					projection: args.projection,
					requestedMargin: candidate.recipe.margin
				});
				const realization: ReviewCandidateRealization = {
					candidateId: candidate.id,
					diagnostics,
					projection: args.projection,
					recordedAt: new Date().toISOString()
				};
				const next = ReviewAuthoringSession.make({
					...session,
					diagnostics: [...session.diagnostics, ...diagnostics],
					realizations: [
						...session.realizations.filter((item) => item.candidateId !== candidate.id),
						realization
					],
					updatedAt: new Date().toISOString()
				});
				return yield* saveDocument({ projectRoot: args.projectRoot, session: next });
			}
		);

		const resume = Effect.fn("ReviewAuthoringSessions.resume")(function* (args: {
			readonly endpoint: string;
			readonly projectRoot: string;
			readonly sessionId: string;
		}) {
			const path = reviewAuthoringSessionPath({
				id: args.sessionId,
				projectRoot: args.projectRoot
			});
			const loaded = yield* loadDocument({
				projectRoot: args.projectRoot,
				id: args.sessionId
			}).pipe(
				Effect.map((session) => ({ session, status: "loaded" as const })),
				Effect.catch((error) => Effect.succeed({ error, status: "corrupt" as const }))
			);
			if (loaded.status === "corrupt") {
				return {
					message: loaded.error.message,
					path,
					recovery: loaded.error.recovery,
					status: "corrupt" as const
				};
			}
			const session = loaded.session;
			const reviewSet =
				session.pendingReviewSet === undefined
					? yield* repository.loadSet(session.reviewSet.path).pipe(
							Effect.map((value) => ({ reviewSet: value, status: "found" as const })),
							Effect.catch(() => Effect.succeed({ status: "missing" as const }))
						)
					: { reviewSet: session.pendingReviewSet, status: "found" as const };
			if (reviewSet.status === "missing") {
				return {
					path: session.reviewSet.path,
					recovery:
						"Restore the configured Review Set or discard this authoring session.",
					status: "missing_review_set" as const
				};
			}
			const reasons: ReviewSessionStaleReason[] = [];
			if (
				reviewSet.reviewSet.id !== session.reviewSet.id ||
				reviewSet.reviewSet.project.mapPath !== session.reviewSet.mapPath
			) {
				reasons.push("review_set_changed");
			}
			const subject = yield* authoring
				.inspectSubject({
					actorPath: session.subject.actorPath,
					endpoint: args.endpoint
				})
				.pipe(
					Effect.mapError((cause) =>
						sessionError({
							cause,
							operation: "resume",
							path: reviewAuthoringSessionPath({
								id: session.id,
								projectRoot: args.projectRoot
							}),
							recovery:
								"Reconnect to the Map Review editor capability, then resume again."
						})
					)
				);
			if (subject.status === "failed") {
				reasons.push(
					subject.code === "subject_not_found" ? "actor_missing" : "map_changed"
				);
			} else {
				if (subject.mapPath !== session.subject.mapPath) reasons.push("map_changed");
				if (boundsChanged(session.subject.bounds, subject.bounds))
					reasons.push("bounds_changed");
			}
			if (reasons.length > 0) {
				const stale = staleSession({ reasons, session });
				yield* saveDocument({ projectRoot: args.projectRoot, session: stale });
				return staleRecovery({ reasons, session: stale });
			}
			return { session, status: "resumable" as const };
		});

		const reframe = Effect.fn("ReviewAuthoringSessions.reframe")(function* (args: {
			readonly candidates: readonly FramingCandidate[];
			readonly projectRoot: string;
			readonly selection: Extract<ReviewSelectionResponse, { readonly status: "selected" }>;
			readonly sessionId: string;
		}) {
			const session = yield* loadDocument({
				projectRoot: args.projectRoot,
				id: args.sessionId
			});
			if (session.lifecycle === "approved" || session.lifecycle === "discarded") {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: `Cannot reframe a ${session.lifecycle} authoring session.`,
						operation: "reframe",
						path: reviewAuthoringSessionPath({
							id: session.id,
							projectRoot: args.projectRoot
						}),
						recovery: "Start a new authoring session for this subject."
					})
				);
			}
			if (args.selection.mapPath !== session.reviewSet.mapPath) {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message:
							"The selected subject belongs to a different map than this authoring session.",
						operation: "reframe",
						path: reviewAuthoringSessionPath({
							id: session.id,
							projectRoot: args.projectRoot
						}),
						recovery: "Return to the Review Set map before reframing this subject."
					})
				);
			}
			const now = new Date().toISOString();
			const next = ReviewAuthoringSession.make({
				...session,
				candidateOverrides: [],
				candidates: [...args.candidates],
				diagnostics: [],
				discardedCandidateIds: [],
				draftPose: undefined,
				framingParameters: parametersFromCandidates(args.candidates),
				lifecycle: "active",
				manualReason: undefined,
				realizations: [],
				selectedCandidateId: undefined,
				subject: {
					actorPath: args.selection.actorPath,
					bounds: args.selection.bounds,
					displayName: args.selection.displayName,
					mapPath: args.selection.mapPath
				},
				updatedAt: now
			});
			return yield* saveDocument({ projectRoot: args.projectRoot, session: next });
		});

		const approve = Effect.fn("ReviewAuthoringSessions.approve")(function* (args: {
			readonly endpoint: string;
			readonly projectRoot: string;
			readonly sessionId: string;
		}) {
			const recovered = yield* resume(args);
			if (recovered.status !== "resumable") return recovered;
			const session = recovered.session;
			if (session.lifecycle !== "active") {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: `Cannot keep a ${session.lifecycle} authoring session.`,
						operation: "approve",
						path: reviewAuthoringSessionPath({
							id: session.id,
							projectRoot: args.projectRoot
						}),
						recovery: "Reframe an active session or start a new one."
					})
				);
			}
			const keptCandidates = session.candidates.filter(
				(item) => !session.discardedCandidateIds.includes(item.id)
			);
			const selectedCandidate =
				keptCandidates.find((item) => item.id === session.selectedCandidateId) ??
				keptCandidates[0];
			if (!selectedCandidate) {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: "All framing candidates were discarded.",
						operation: "approve",
						path: reviewAuthoringSessionPath({
							id: session.id,
							projectRoot: args.projectRoot
						}),
						recovery: "Reframe the subject and keep at least one candidate."
					})
				);
			}
			const reviewSet =
				session.pendingReviewSet ??
				(yield* repository.loadSet(session.reviewSet.path).pipe(
					Effect.mapError((cause) =>
						sessionError({
							cause,
							operation: "approve",
							path: session.reviewSet.path,
							recovery: "Restore the Review Set before keeping this Review View."
						})
					)
				));
			const subject = {
				actorPath: session.subject.actorPath,
				diagnosticLabel: session.subject.displayName,
				kind: "actor_path" as const
			};
			let approvedReviewSet: ReviewSet | undefined;
			if (session.pendingReviewSet === undefined) {
				const view = reviewSet.views.find((item) => item.id === session.viewId);
				if (view !== undefined) {
					const approved = approveFramingCandidate({
						candidate: selectedCandidate,
						...(session.draftPose === undefined ||
						session.selectedCandidateId !== selectedCandidate.id
							? undefined
							: { manualPose: session.draftPose }),
						...(session.manualReason === undefined ||
						session.selectedCandidateId !== selectedCandidate.id
							? undefined
							: { manualReason: session.manualReason }),
						reviewSet,
						subject,
						viewId: view.id
					});
					if (approved.status === "approved") approvedReviewSet = approved.reviewSet;
				}
			} else {
				const captureProfile = reviewSet.captureProfiles[0];
				const visibilityPolicy = reviewSet.visibilityPolicies[0];
				if (captureProfile === undefined || visibilityPolicy === undefined) {
					return yield* Effect.fail(
						new ReviewAuthoringSessionError({
							message: "The Review Set has no capture profile or visibility policy.",
							operation: "approve",
							path: session.reviewSet.path,
							recovery: "Repair the Review Set before keeping these Review Views."
						})
					);
				}
				approvedReviewSet = appendKeptCandidateViews({
					captureProfileId: captureProfile.id,
					candidates: keptCandidates,
					reviewSet,
					session,
					visibilityPolicyId: visibilityPolicy.id
				});
			}
			if (approvedReviewSet === undefined) {
				return yield* Effect.fail(
					new ReviewAuthoringSessionError({
						message: `Review View ${session.viewId} was not found.`,
						operation: "approve",
						path: session.reviewSet.path,
						recovery: "Reload the Review Set and select an existing Review View."
					})
				);
			}
			yield* repository
				.saveSet({ path: session.reviewSet.path, reviewSet: approvedReviewSet })
				.pipe(
					Effect.mapError((cause) =>
						sessionError({
							cause,
							operation: "approve",
							path: session.reviewSet.path,
							recovery:
								"Check that the Review Set is writable, then keep the view again."
						})
					)
				);
			const { pendingReviewSet: _pendingReviewSet, ...persistedSession } = session;
			const completed = ReviewAuthoringSession.make({
				...persistedSession,
				lifecycle: "approved",
				updatedAt: new Date().toISOString()
			});
			yield* saveDocument({ projectRoot: args.projectRoot, session: completed });
			return { session: completed, status: "resumable" as const };
		});

		const discard = Effect.fn("ReviewAuthoringSessions.discard")(function* (args: {
			readonly projectRoot: string;
			readonly sessionId: string;
		}) {
			const session = yield* loadDocument({
				projectRoot: args.projectRoot,
				id: args.sessionId
			});
			const discarded = ReviewAuthoringSession.make({
				...session,
				lifecycle: "discarded",
				updatedAt: new Date().toISOString()
			});
			return yield* saveDocument({ projectRoot: args.projectRoot, session: discarded });
		});

		const latest = Effect.fn("ReviewAuthoringSessions.latest")(function* (args: {
			readonly projectRoot: string;
		}) {
			const root = sessionRoot(args.projectRoot);
			const entries = yield* Effect.tryPromise({
				try: async () => {
					await mkdir(root, { recursive: true });
					return readdir(root, { withFileTypes: true });
				},
				catch: (cause) =>
					sessionError({
						cause,
						operation: "list",
						path: root,
						recovery:
							"Check that the project-local authoring-session directory is readable."
					})
			});
			const sessions = yield* Effect.forEach(
				entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")),
				(entry) =>
					loadDocument({
						id: entry.name.slice(0, -".json".length),
						projectRoot: args.projectRoot
					}).pipe(Effect.option)
			);
			return sessions
				.flatMap(Option.toArray)
				.filter(
					(session) => session.lifecycle === "active" || session.lifecycle === "stale"
				)
				.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
		});

		return ReviewAuthoringSessions.of({
			approve,
			create,
			discard,
			load: Effect.fn("ReviewAuthoringSessions.load")(
				(args: { readonly projectRoot: string; readonly sessionId: string }) =>
					loadDocument({ id: args.sessionId, projectRoot: args.projectRoot })
			),
			latest,
			patch,
			recordProjection,
			reframe,
			resume,
			start
		});
	})
);

export function makeReviewAuthoringSessionsTestLayer(
	service: ReviewAuthoringSessionsApi
): Layer.Layer<ReviewAuthoringSessions> {
	return Layer.succeed(ReviewAuthoringSessions, ReviewAuthoringSessions.of(service));
}
