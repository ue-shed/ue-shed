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
	type ReviewAuthoringSessionsShape
} from "./review-authoring-session.js";
import { generateFramingCandidates } from "./review-framing.js";
import { makeReviewRepositoryTestLayer } from "./review-repository.js";
import {
	decodeReviewSet,
	ReviewSetId,
	ReviewViewId,
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
	readonly inspectSubject: () => typeof selection;
	readonly onSave: (reviewSet: ReviewSet) => void;
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
					loadSet: () => Effect.succeed(reviewSet),
					prepareRun: () => Effect.die("not used"),
					saveSet: ({ reviewSet }) => Effect.sync(() => args.onSave(reviewSet)),
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
	use: (sessions: ReviewAuthoringSessionsShape) => Effect.Effect<A, E>
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
		const layer = sessionLayer({
			inspectSubject: () => selection,
			onSave: (next) => {
				savedReviewSet = next;
			}
		});
		const created = await withSessions(layer, (sessions) =>
			sessions.start({
				candidates: generateFramingCandidates(selection),
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
		expect(savedReviewSet?.views).toHaveLength(1);
		expect(savedReviewSet?.views[0]).toMatchObject({
			displayName: selection.displayName,
			target: { kind: "actor", subject: { actorPath: selection.actorPath } }
		});
		const afterApproval = await readFile(
			reviewAuthoringSessionPath({ id: created.id, projectRoot }),
			"utf8"
		);
		expect(afterApproval).not.toContain("pendingReviewSet");
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
