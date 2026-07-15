import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { captureReviewSet, type ReviewCapturePort } from "./review-capture.js";
import {
	captureRunPath,
	isPathWithin,
	listCaptureRuns,
	loadCaptureRun,
	loadReviewSet,
	saveReviewSet
} from "./review-repository.js";
import {
	CaptureProfileId,
	ReviewSetId,
	ReviewViewId,
	decodeReviewSet,
	type ReviewSet
} from "./review-schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
	);
});

function fixtureReviewSet(): ReviewSet {
	return decodeReviewSet({
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
		id: "fixture-structure",
		project: {
			id: "ue-shed-fixture",
			mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
		},
		views: [
			{
				approvedPose: {
					aspectRatio: "16:9",
					fieldOfViewDegrees: 60,
					location: { x: 1000, y: 1000, z: 600 },
					projection: "perspective",
					rotation: { pitch: -15, roll: 0, yaw: -135 }
				},
				captureProfileId: "fixture-hd",
				displayName: "Structure context",
				framingRecipe: { kind: "manual", version: 1 },
				id: "structure-context",
				purpose: "Track the fixture structure over time",
				subject: {
					actorPath:
						"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject",
					kind: "actor_path"
				},
				tags: ["fixture", "context"]
			}
		]
	});
}

describe("Map Review contracts", () => {
	it("keeps domain identities branded and validates a complete Review Set", () => {
		const reviewSet = fixtureReviewSet();
		expect(ReviewSetId.make(reviewSet.id)).toBe("fixture-structure");
		expect(ReviewViewId.make(reviewSet.views[0]!.id)).toBe("structure-context");
		expect(CaptureProfileId.make(reviewSet.captureProfiles[0]!.id)).toBe("fixture-hd");
		expect(() =>
			decodeReviewSet({
				...reviewSet,
				views: [
					{
						...reviewSet.views[0],
						approvedPose: {
							...reviewSet.views[0]!.approvedPose,
							fieldOfViewDegrees: 200
						}
					}
				]
			})
		).toThrow();
	});

	it("persists and loads a Review Set through an atomic document boundary", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-set-"));
		temporaryDirectories.push(root);
		const path = join(root, "sets", "fixture.json");
		const reviewSet = fixtureReviewSet();
		await Effect.runPromise(saveReviewSet({ path, reviewSet }));
		await expect(Effect.runPromise(loadReviewSet(path))).resolves.toEqual(reviewSet);
	});
});

describe("durable capture loop", () => {
	it("promotes a validated Unreal staging image into an immutable run and history", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-run-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, ".ue-shed", "review", "sets", "fixture.json");
		await Effect.runPromise(
			saveReviewSet({ path: reviewSetPath, reviewSet: fixtureReviewSet() })
		);
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
		const port: ReviewCapturePort = {
			capture: (request) =>
				Effect.tryPromise({
					try: async () => {
						const stagingPath = join(
							projectRoot,
							"Saved",
							"UEShed",
							"ReviewStaging",
							request.operationId,
							request.viewId,
							"pure.png"
						);
						await mkdir(dirname(stagingPath), { recursive: true });
						await writeFile(stagingPath, png);
						return {
							actorPath: request.subject.actorPath,
							captureDurationMs: 12.5,
							contract: request.contract,
							height: request.resolution.height,
							mapPackageDirtyAfter: false,
							mapPackageDirtyBefore: false,
							mapPath: request.expectedMapPath,
							operationId: request.operationId,
							stagingPath,
							status: "captured" as const,
							viewId: request.viewId,
							width: request.resolution.width
						};
					},
					catch: (cause) => cause
				})
		};

		const run = await Effect.runPromise(
			captureReviewSet(
				{
					endpoint: "http://127.0.0.1:30001",
					projectRoot,
					reviewSetPath
				},
				{
					makeId: (() => {
						const ids = ["run-001", "operation-001"];
						return () => ids.shift()!;
					})(),
					now: (() => {
						const times = ["2026-07-15T08:00:00.000Z", "2026-07-15T08:00:01.000Z"];
						return () => times.shift()!;
					})(),
					port
				}
			)
		);

		expect(run.status).toBe("completed");
		const persisted = await Effect.runPromise(
			loadCaptureRun(captureRunPath(projectRoot, run.id))
		);
		expect(persisted).toEqual(run);
		const artifactPath = join(
			projectRoot,
			".ue-shed",
			"review",
			"runs",
			run.id,
			"views",
			"structure-context",
			"pure.png"
		);
		expect(new Uint8Array(await readFile(artifactPath))).toEqual(png);
		expect(run.results[0]).toMatchObject({
			artifact: {
				contentHash: `sha256:${createHash("sha256").update(png).digest("hex")}`,
				relativePath: "views/structure-context/pure.png"
			},
			status: "captured"
		});
		await expect(Effect.runPromise(listCaptureRuns(projectRoot))).resolves.toMatchObject([
			{ failedViews: 0, id: "run-001", status: "completed", successfulViews: 1 }
		]);
	});

	it("rejects staging paths outside the project and finalizes an honest failed run", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-reject-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, "set.json");
		await Effect.runPromise(
			saveReviewSet({ path: reviewSetPath, reviewSet: fixtureReviewSet() })
		);
		const outside = join(dirname(projectRoot), "outside.png");
		const port: ReviewCapturePort = {
			capture: (request) =>
				Effect.succeed({
					actorPath: request.subject.actorPath,
					captureDurationMs: 1,
					contract: request.contract,
					height: 720,
					mapPackageDirtyAfter: false,
					mapPackageDirtyBefore: false,
					mapPath: request.expectedMapPath,
					operationId: request.operationId,
					stagingPath: outside,
					status: "captured",
					viewId: request.viewId,
					width: 1280
				})
		};
		const run = await Effect.runPromise(
			captureReviewSet(
				{ endpoint: "unused", projectRoot, reviewSetPath },
				{
					makeId: (() => {
						const ids = ["run-rejected", "operation-rejected"];
						return () => ids.shift()!;
					})(),
					now: () => "2026-07-15T08:00:00.000Z",
					port
				}
			)
		);
		expect(run.status).toBe("failed");
		expect(run.results[0]).toMatchObject({
			code: "capture_staging_path_rejected",
			status: "failed"
		});
	});
});

describe("review staging path validation", () => {
	it("accepts descendants and rejects siblings and the root itself", () => {
		const root = join("C:\\project", "Saved", "UEShed", "ReviewStaging");
		expect(isPathWithin(root, join(root, "operation", "pure.png"))).toBe(true);
		expect(isPathWithin(root, root)).toBe(false);
		expect(isPathWithin(root, join(root, "..", "outside.png"))).toBe(false);
	});
});
