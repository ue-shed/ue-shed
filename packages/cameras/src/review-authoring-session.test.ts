import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { makeReviewAuthoringTestLayer } from "./review-authoring-live.js";
import {
	ReviewAuthoringSessions,
	ReviewAuthoringSessionsLive,
	reviewAuthoringSessionPath,
	type ReviewAuthoringSessionsApi
} from "./review-authoring-session.js";
import {
	defaultFramingParameters,
	generateFramingCandidateId,
	generateFramingCandidates
} from "./review-framing.js";
import { makeReviewRepositoryTestLayer, ReviewStorageError } from "./review-repository.js";
import {
	decodeReviewSet,
	ReviewSetId,
	ReviewViewId,
	FramingParameters,
	type ReviewSet,
	type ReviewSelectionResponse
} from "./review-schema.js";

const reviewSetPath = "C:/Fixture/.ue-shed/review/sets/fixture.json";

const selection = {
	actorPath: "/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject",
	bounds: {
		center: { x: 0, y: 0, z: 250 },
		extent: { x: 600, y: 450, z: 250 },
		rotation: { pitch: 0, roll: 0, yaw: 15 }
	},
	contract: {
		name: "ue-shed-review-selection" as const,
		version: { major: 1 as const, minor: 0 }
	},
	displayName: "Review Subject",
	editorView: {
		aspectRatio: "16:9" as const,
		fieldOfViewDegrees: 72,
		location: { x: 1200, y: -900, z: 700 },
		projection: "perspective" as const,
		rotation: { pitch: -12, roll: 0, yaw: 142 }
	},
	mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
	status: "selected" as const
} satisfies Extract<ReviewSelectionResponse, { readonly status: "selected" }>;

const reviewSet = Effect.runSync(
	decodeReviewSet({
		captureProfiles: [
			{
				id: "fixture-hd",
				imageFormat: "png",
				renderProfile: "full_fidelity",
				resolution: { height: 720, width: 1280 },
				variantPolicy: "pure_only"
			}
		],
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 0 } },
		displayName: "Fixture structure",
		id: ReviewSetId.make("fixture-structure"),
		project: { id: "ue-shed-fixture", mapPath: selection.mapPath },
		views: [
			{
				approvedPose: selection.editorView,
				captureProfileId: "fixture-hd",
				displayName: "Structure context",
				framingRecipe: { kind: "manual", version: 1 },
				id: ReviewViewId.make("structure-context"),
				purpose: "Track fixture structure",
				subject: { actorPath: selection.actorPath, kind: "actor_path" },
				tags: ["fixture"]
			}
		]
	})
);

const projectRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		projectRoots
			.splice(0)
			.map((projectRoot) => rm(projectRoot, { force: true, recursive: true }))
	);
});

async function makeProjectRoot(): Promise<string> {
	const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-authoring-"));
	projectRoots.push(projectRoot);
	return projectRoot;
}

function sessionLayer(args: {
	readonly inspectSubject: () => Extract<
		ReviewSelectionResponse,
		{ readonly status: "selected" }
	>;
	readonly loadSet?: () => ReviewSet;
	readonly onSave: (reviewSet: ReviewSet) => void;
	readonly saveFailure?: boolean;
}) {
	return ReviewAuthoringSessionsLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				makeReviewRepositoryTestLayer({
					discardStaging: () => Effect.die("not used"),
					findSet: () => Effect.succeed(undefined),
					finalizeRun: () => Effect.die("not used"),
					listRuns: () => Effect.die("not used"),
					loadRun: () => Effect.die("not used"),
					loadSet: () => Effect.succeed(args.loadSet?.() ?? reviewSet),
					prepareRun: () => Effect.die("not used"),
					saveSet: ({ path, reviewSet }) =>
						args.saveFailure
							? Effect.fail(
									new ReviewStorageError({
										message: "Fixture write conflict",
										operation: "save_set",
										path,
										recovery: "Retry"
									})
								)
							: Effect.sync(() => args.onSave(reviewSet)),
					storeArtifact: () => Effect.die("not used"),
					writeRunDocument: () => Effect.die("not used")
				}),
				makeReviewAuthoringTestLayer({
					inspectSelection: () => Effect.succeed(selection),
					inspectSubject: () => Effect.succeed(args.inspectSubject()),
					previewCandidate: () => Effect.die("not used")
				})
			)
		)
	);
}

function run<A, E>(
	layer: Layer.Layer<ReviewAuthoringSessions>,
	effect: Effect.Effect<A, E, ReviewAuthoringSessions>
) {
	return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

function withSessions<A, E>(
	layer: Layer.Layer<ReviewAuthoringSessions>,
	use: (sessions: ReviewAuthoringSessionsApi) => Effect.Effect<A, E>
) {
	return run(layer, Effect.flatMap(ReviewAuthoringSessions, use));
}

describe("ReviewAuthoringSessions", () => {
	it("persists compact session state and resumes it through a fresh service", async () => {
		const projectRoot = await makeProjectRoot();
		let savedSets = 0;
		const layer = sessionLayer({
			inspectSubject: () => selection,
			onSave: () => (savedSets += 1)
		});
		const candidates = generateFramingCandidates(selection);
		const created = await withSessions(layer, (sessions) =>
			sessions.create({
				candidates,
				projectRoot,
				reviewSetPath,
				selection,
				sessionId: "session-1",
				viewId: "structure-context"
			})
		);
		const updated = await withSessions(layer, (sessions) =>
			sessions.patch({
				patch: {
					discardedCandidateIds: [],
					draftPose: candidates[0]!.approvedPose,
					manualReason: "Lift above foreground",
					selectedCandidateId: candidates[0]!.id
				},
				projectRoot,
				sessionId: created.id
			})
		);
		expect(updated.selectedCandidateId).toBe(candidates[0]!.id);
		const persisted = await readFile(
			reviewAuthoringSessionPath({ id: created.id, projectRoot }),
			"utf8"
		);
		expect(persisted).not.toContain("staging");
		expect(persisted).not.toContain("bytes");
		const resumed = await withSessions(layer, (sessions) =>
			sessions.resume({
				endpoint: "http://127.0.0.1:30001",
				projectRoot,
				sessionId: created.id
			})
		);
		expect(resumed).toMatchObject({ status: "resumable", session: { id: created.id } });
		expect(savedSets).toBe(0);
	});

	it("marks stale bounds durable, refuses approval, and allows explicit reframe", async () => {
		const projectRoot = await makeProjectRoot();
		let subject = selection;
		let savedSets = 0;
		const layer = sessionLayer({
			inspectSubject: () => subject,
			onSave: () => (savedSets += 1)
		});
		const candidates = generateFramingCandidates(selection);
		const created = await withSessions(layer, (sessions) =>
			sessions.create({
				candidates,
				projectRoot,
				reviewSetPath,
				selection,
				sessionId: "stale-session",
				viewId: "structure-context"
			})
		);
		subject = {
			...selection,
			bounds: { ...selection.bounds, extent: { ...selection.bounds.extent, x: 700 } }
		};
		const stale = await withSessions(layer, (sessions) =>
			sessions.resume({
				endpoint: "http://127.0.0.1:30001",
				projectRoot,
				sessionId: created.id
			})
		);
		expect(stale).toMatchObject({ reasons: ["bounds_changed"], status: "stale" });
		const approval = await withSessions(layer, (sessions) =>
			sessions.approve({
				endpoint: "http://127.0.0.1:30001",
				projectRoot,
				sessionId: created.id
			})
		);
		expect(approval.status).toBe("stale");
		expect(savedSets).toBe(0);
		const reframed = await withSessions(layer, (sessions) =>
			sessions.reframe({
				candidates: generateFramingCandidates(subject),
				projectRoot,
				selection: subject,
				sessionId: created.id
			})
		);
		expect(reframed).toMatchObject({ lifecycle: "active", realizations: [] });
		const discarded = await withSessions(layer, (sessions) =>
			sessions.discard({ projectRoot, sessionId: created.id })
		);
		expect(discarded.lifecycle).toBe("discarded");
		expect(savedSets).toBe(0);
	});

	it("holds a new map-scoped Review Set in the session until an author keeps a view", async () => {
		const projectRoot = await makeProjectRoot();
		let savedReviewSet: ReviewSet | undefined;
		const candidates = generateFramingCandidates(selection);
		const layer = sessionLayer({
			inspectSubject: () => selection,
			onSave: (next) => {
				savedReviewSet = next;
			}
		});
		const created = await withSessions(layer, (sessions) =>
			sessions.start({
				candidates,
				destination: { kind: "append_view" },
				projectRoot,
				selection
			})
		);
		expect(created.pendingReviewSet).toMatchObject({
			project: { mapPath: selection.mapPath },
			views: []
		});
		expect(savedReviewSet).toBeUndefined();
		const beforeApproval = await readFile(
			reviewAuthoringSessionPath({ id: created.id, projectRoot }),
			"utf8"
		);
		expect(beforeApproval).toContain("pendingReviewSet");

		const approved = await withSessions(layer, (sessions) =>
			sessions.approve({
				endpoint: "http://127.0.0.1:30001",
				projectRoot,
				sessionId: created.id
			})
		);
		expect(approved).toMatchObject({ status: "resumable", session: { lifecycle: "approved" } });
		expect(savedReviewSet?.views).toHaveLength(candidates.length);
		expect(savedReviewSet?.views[0]).toMatchObject({
			displayName: candidates[0]?.displayName,
			target: { kind: "actor", subject: { actorPath: selection.actorPath } }
		});
		expect(savedReviewSet?.views.map((view) => view.displayName)).toEqual(
			candidates.map((candidate) => candidate.displayName)
		);
		const afterApproval = await readFile(
			reviewAuthoringSessionPath({ id: created.id, projectRoot }),
			"utf8"
		);
		expect(afterApproval).not.toContain("pendingReviewSet");
	});

	it("appends a selected subject without replacing an existing Review View", async () => {
		const projectRoot = await makeProjectRoot();
		const sameLabelSelection = { ...selection, displayName: "Structure context" };
		const candidates = generateFramingCandidates(sameLabelSelection);
		let savedReviewSet: ReviewSet | undefined;
		const layer = sessionLayer({
			inspectSubject: () => sameLabelSelection,
			onSave: (next) => {
				savedReviewSet = next;
			}
		});
		const created = await withSessions(layer, (sessions) =>
			sessions.start({
				candidates,
				destination: { kind: "append_view" },
				projectRoot,
				reviewSetPath,
				selection: sameLabelSelection
			})
		);
		expect(created.viewId).toBe("structure-context-2");
		expect(created.pendingReviewSet?.views).toHaveLength(1);
		await withSessions(layer, (sessions) =>
			sessions.patch({
				patch: {
					discardedCandidateIds: candidates.slice(2).map((candidate) => candidate.id),
					manualReason: "",
					selectedCandidateId: candidates[0]?.id
				},
				projectRoot,
				sessionId: created.id
			})
		);

		await withSessions(layer, (sessions) =>
			sessions.approve({
				endpoint: "http://127.0.0.1:30001",
				projectRoot,
				sessionId: created.id
			})
		);
		expect(savedReviewSet?.views.map((view) => view.id)).toEqual([
			"structure-context",
			"structure-context-2",
			"structure-context-3"
		]);
		expect(savedReviewSet?.views.slice(1).map((view) => view.displayName)).toEqual(
			candidates.slice(0, 2).map((candidate) => candidate.displayName)
		);
	});

	it("revises only the explicitly identified Review View", async () => {
		const projectRoot = await makeProjectRoot();
		let savedReviewSet: ReviewSet | undefined;
		const layer = sessionLayer({
			inspectSubject: () => selection,
			onSave: (next) => {
				savedReviewSet = next;
			}
		});
		const created = await withSessions(layer, (sessions) =>
			sessions.start({
				candidates: generateFramingCandidates(selection),
				destination: {
					kind: "revise_view",
					viewId: ReviewViewId.make("structure-context")
				},
				projectRoot,
				reviewSetPath,
				selection
			})
		);
		expect(created.pendingReviewSet).toBeUndefined();
		expect(created.viewId).toBe("structure-context");

		await withSessions(layer, (sessions) =>
			sessions.approve({
				endpoint: "http://127.0.0.1:30001",
				projectRoot,
				sessionId: created.id
			})
		);
		expect(savedReviewSet?.views).toHaveLength(1);
		expect(savedReviewSet?.views[0]?.id).toBe("structure-context");
		expect(savedReviewSet?.views[0]?.revision.number).toBe(2);
	});

	it("persists ordered multi-subject and multi-View collections across fresh services", async () => {
		const projectRoot = await makeProjectRoot();
		let stored = reviewSet;
		let currentSelection: Extract<ReviewSelectionResponse, { readonly status: "selected" }> = {
			...selection,
			actorPath:
				"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.SecondSubject",
			displayName: "Second Subject"
		};
		const makeLayer = () =>
			sessionLayer({
				inspectSubject: () => currentSelection,
				loadSet: () => stored,
				onSave: (next) => {
					stored = next;
				}
			});
		const appendCurrent = async (layer: ReturnType<typeof makeLayer>) => {
			const created = await withSessions(layer, (sessions) =>
				sessions.start({
					candidates: generateFramingCandidates(currentSelection).slice(0, 1),
					destination: { kind: "append_view" },
					projectRoot,
					reviewSetPath,
					selection: currentSelection
				})
			);
			await withSessions(layer, (sessions) =>
				sessions.approve({
					endpoint: "http://127.0.0.1:30001",
					projectRoot,
					sessionId: created.id
				})
			);
			return created;
		};

		await appendCurrent(makeLayer());
		currentSelection = selection;
		await appendCurrent(makeLayer());
		stored = await Effect.runPromise(decodeReviewSet(JSON.parse(JSON.stringify(stored))));
		const afterRestart = await appendCurrent(makeLayer());

		expect(afterRestart.viewId).toBe("review-subject-2");
		expect(stored.views.map((view) => view.id)).toEqual([
			"structure-context",
			"second-subject",
			"review-subject",
			"review-subject-2"
		]);
		expect(
			stored.views.filter(
				(view) =>
					view.target.kind === "actor" &&
					view.target.subject.actorPath === selection.actorPath
			)
		).toHaveLength(3);
	});

	it("retains the active append session when Review Set persistence fails", async () => {
		const projectRoot = await makeProjectRoot();
		let saves = 0;
		const layer = sessionLayer({
			inspectSubject: () => selection,
			onSave: () => (saves += 1),
			saveFailure: true
		});
		const created = await withSessions(layer, (sessions) =>
			sessions.start({
				candidates: generateFramingCandidates(selection),
				destination: { kind: "append_view" },
				projectRoot,
				reviewSetPath,
				selection
			})
		);

		await expect(
			withSessions(layer, (sessions) =>
				sessions.approve({
					endpoint: "http://127.0.0.1:30001",
					projectRoot,
					sessionId: created.id
				})
			)
		).rejects.toMatchObject({ operation: "approve" });
		const retained = await withSessions(layer, (sessions) =>
			sessions.load({ projectRoot, sessionId: created.id })
		);
		expect(retained.lifecycle).toBe("active");
		expect(retained.pendingReviewSet?.views).toHaveLength(1);
		expect(saves).toBe(0);
	});

	it("regenerates tuned rigs, re-anchors overrides, and drops unmappable entries", async () => {
		const projectRoot = await makeProjectRoot();
		let savedReviewSet: ReviewSet | undefined;
		const layer = sessionLayer({
			inspectSubject: () => selection,
			onSave: (next) => {
				savedReviewSet = next;
			}
		});
		const defaults = defaultFramingParameters();
		const context = defaults.groups[0]!;
		const parameters = FramingParameters.make({
			...defaults,
			groups: [
				{
					...context,
					pattern: {
						count: 3,
						kind: "arc",
						spreadDegrees: 60,
						yawOffsetDegrees: 42
					}
				}
			]
		});
		const created = await withSessions(layer, (sessions) =>
			sessions.create({
				candidates: generateFramingCandidates(selection),
				projectRoot,
				reviewSetPath,
				selection,
				sessionId: "tuned-session",
				viewId: "structure-context"
			})
		);
		const secondId = generateFramingCandidateId({ groupId: context.id, index: 2 });
		const tuned = await withSessions(layer, (sessions) =>
			sessions.patch({
				patch: {
					candidateOverrides: [
						{
							candidateId: secondId,
							overrides: { elevation: 0.9, yawOffsetDegrees: 7 }
						}
					],
					discardedCandidateIds: [],
					framingParameters: parameters,
					manualReason: "",
					selectedCandidateId: secondId
				},
				projectRoot,
				sessionId: created.id
			})
		);
		expect(tuned.candidates).toHaveLength(4);
		expect(tuned.selectedCandidateId).toBe(secondId);
		expect(tuned.candidates[1]?.recipe).toMatchObject({
			candidateOverrides: { elevation: 0.9, yawOffsetDegrees: 7 },
			groupIndex: 2,
			version: 2
		});
		const retuned = await withSessions(layer, (sessions) =>
			sessions.patch({
				patch: {
					candidateOverrides: [
						{ candidateId: secondId, overrides: { yawOffsetDegrees: 11 } }
					],
					discardedCandidateIds: [],
					manualReason: "",
					selectedCandidateId: secondId
				},
				projectRoot,
				sessionId: created.id
			})
		);
		expect(retuned.candidates[1]?.recipe).toMatchObject({
			candidateOverrides: { yawOffsetDegrees: 11 }
		});
		const reset = await withSessions(layer, (sessions) =>
			sessions.patch({
				patch: {
					candidateOverrides: [],
					discardedCandidateIds: [],
					manualReason: "",
					selectedCandidateId: secondId
				},
				projectRoot,
				sessionId: created.id
			})
		);
		expect(reset.candidates[1]?.recipe).not.toHaveProperty("candidateOverrides");
		expect(reset.candidates[1]?.approvedPose).toEqual(
			generateFramingCandidates(selection, parameters)[1]?.approvedPose
		);

		const shrunk = await withSessions(layer, (sessions) =>
			sessions.patch({
				patch: {
					candidateOverrides: tuned.candidateOverrides,
					discardedCandidateIds: [],
					framingParameters: FramingParameters.make({
						...parameters,
						groups: [
							{
								...context,
								pattern: {
									count: 1,
									kind: "arc",
									spreadDegrees: 0,
									yawOffsetDegrees: 42
								}
							}
						]
					}),
					manualReason: "",
					selectedCandidateId: secondId
				},
				projectRoot,
				sessionId: created.id
			})
		);
		expect(shrunk.candidateOverrides).toEqual([]);
		expect(shrunk.selectedCandidateId).toBeUndefined();
		expect(shrunk.candidates).toHaveLength(2);

		const reexpanded = await withSessions(layer, (sessions) =>
			sessions.patch({
				patch: {
					candidateOverrides: [{ candidateId: secondId, overrides: { elevation: 0.9 } }],
					discardedCandidateIds: [],
					framingParameters: parameters,
					manualReason: "",
					selectedCandidateId: secondId
				},
				projectRoot,
				sessionId: created.id
			})
		);
		expect(reexpanded.candidateOverrides).toHaveLength(1);
		await withSessions(layer, (sessions) =>
			sessions.approve({
				endpoint: "http://127.0.0.1:30001",
				projectRoot,
				sessionId: created.id
			})
		);
		expect(savedReviewSet?.views[0]?.framingRecipe).toMatchObject({
			candidateOverrides: { elevation: 0.9 },
			groupIndex: 2,
			version: 2
		});
	});

	it("returns a typed corrupt recovery and ignores a malformed document when listing", async () => {
		const projectRoot = await makeProjectRoot();
		const layer = sessionLayer({ inspectSubject: () => selection, onSave: () => undefined });
		const corruptPath = reviewAuthoringSessionPath({ id: "broken-session", projectRoot });
		await mkdir(dirname(corruptPath), { recursive: true });
		await writeFile(corruptPath, "{not json", "utf8");
		const recovery = await withSessions(layer, (sessions) =>
			sessions.resume({
				endpoint: "http://127.0.0.1:30001",
				projectRoot,
				sessionId: "broken-session"
			})
		);
		expect(recovery.status).toBe("corrupt");
		const latest = await withSessions(layer, (sessions) => sessions.latest({ projectRoot }));
		expect(latest).toBeUndefined();
	});
});
