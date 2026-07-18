import {
	makeReviewAuthoringTestLayer,
	makeReviewCaptureTestLayer,
	makeReviewRepositoryTestLayer,
	type ReviewAuthoringShape,
	type ReviewCaptureShape,
	type ReviewSet
} from "@ue-shed/cameras";
import { it } from "@effect/vitest";
import { Observatory } from "@ue-shed/observatory";
import { makeEditorPlaySessionTestLayer } from "@ue-shed/engine-discovery";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import {
	makeWorkbenchConfigurationLayer,
	type WorkbenchConfigurationShape
} from "../workbench-config.js";
import { WorkbenchMapReview, WorkbenchMapReviewLive } from "./map-review.js";

const reviewSetPath = "C:/Fixture/.ue-shed/review/sets/fixture.json";
const projectRoot = "C:/FixtureProject";

const fixtureReviewSet: ReviewSet = {
	captureProfiles: [
		{
			id: "profile-1" as ReviewSet["captureProfiles"][number]["id"],
			imageFormat: "png",
			renderProfile: "full_fidelity",
			resolution: { height: 1080, width: 1920 },
			variantPolicy: "pure_only"
		}
	],
	contract: { name: "ue-shed-review-set", version: { major: 1, minor: 0 } },
	displayName: "Fixture Review Set",
	id: "review-set-1" as ReviewSet["id"],
	project: { id: "fixture", mapPath: "/Game/Maps/Fixture" },
	views: [
		{
			approvedPose: {
				aspectRatio: "16:9",
				fieldOfViewDegrees: 60,
				location: { x: 0, y: 0, z: 0 },
				projection: "perspective",
				rotation: { pitch: 0, roll: 0, yaw: 0 }
			},
			captureProfileId: "profile-1" as ReviewSet["captureProfiles"][number]["id"],
			displayName: "Front view",
			framingRecipe: { kind: "manual", version: 1 },
			id: "view-1" as ReviewSet["views"][number]["id"],
			purpose: "Establishing shot",
			subject: {
				actorPath: "/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
				kind: "actor_path"
			},
			tags: []
		}
	]
} as unknown as ReviewSet;

const configuredReview: WorkbenchConfigurationShape = {
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { projectRoot, reviewSetPath, status: "configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
};

const notConfigured: WorkbenchConfigurationShape = {
	...configuredReview,
	review: { status: "not_configured" }
};

const dyingCapture: ReviewCaptureShape = { captureSet: () => Effect.die("not used") };
const dyingAuthoring: ReviewAuthoringShape = {
	inspectSelection: () => Effect.die("not used"),
	previewCandidate: () => Effect.die("not used")
};
const WorkbenchMapReviewTestLive = WorkbenchMapReviewLive.pipe(
	Layer.provide(
		Layer.mergeAll(
			Layer.succeed(
				Observatory,
				Observatory.of({
					focus: () => Effect.die("not used"),
					snapshot: () => Effect.die("not used")
				})
			),
			makeEditorPlaySessionTestLayer({
				execute: () => Effect.die("not used"),
				pause: () => Effect.die("not used"),
				resume: () => Effect.die("not used"),
				start: () => Effect.die("not used"),
				status: () =>
					Effect.succeed({
						contract: {
							name: "unreal-editor-play-session",
							version: { major: 1, minor: 0 }
						},
						state: { status: "stopped" }
					}),
				stop: () => Effect.die("not used")
			})
		)
	)
);

it.effect("returns not_configured when no review project is configured", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.load();
		expect(result).toEqual({ status: "not_configured" });
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewTestLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(notConfigured),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							finalizeRun: () => Effect.die("not used"),
							listRuns: () => Effect.die("not used"),
							loadRun: () => Effect.die("not used"),
							loadSet: () => Effect.die("not used"),
							prepareRun: () => Effect.die("not used"),
							saveSet: () => Effect.die("not used"),
							storeArtifact: () => Effect.die("not used"),
							writeRunDocument: () => Effect.die("not used")
						}),
						makeReviewCaptureTestLayer(dyingCapture),
						makeReviewAuthoringTestLayer(dyingAuthoring)
					)
				)
			)
		)
	)
);

it.effect("loads the review set and reads captured artifacts with bounded concurrency", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.load();
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.reviewSet).toEqual({
			displayName: "Fixture Review Set",
			mapPath: "/Game/Maps/Fixture",
			viewCount: 1
		});
		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]?.preview).toEqual({
			bytes: new Uint8Array([1, 2, 3]),
			height: 1080,
			viewName: "Front view",
			width: 1920
		});
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewTestLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(configuredReview),
						makeLocalFilesTestLayer(
							new Map([
								[
									join("C:/Fixture/review/runs/run-1", "artifact.png"),
									new Uint8Array([1, 2, 3])
								]
							])
						),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							finalizeRun: () => Effect.die("not used"),
							listRuns: () =>
								Effect.succeed([
									{
										completedAt: "2026-01-01T00:00:00.000Z",
										failedViews: 0,
										id: "run-1",
										path: "C:/Fixture/review/runs/run-1/run.json",
										reviewSetId: fixtureReviewSet.id,
										status: "completed" as const,
										successfulViews: 1
									}
								]),
							loadRun: () =>
								Effect.succeed({
									completedAt: "2026-01-01T00:00:00.000Z",
									contract: {
										name: "ue-shed-capture-run" as const,
										version: { major: 1, minor: 0 }
									},
									id: "run-1",
									project: fixtureReviewSet.project,
									results: [
										{
											artifact: {
												byteLength: 3,
												contentHash: `sha256:${"a".repeat(64)}`,
												height: 1080,
												id: "artifact-1",
												mediaType: "image/png" as const,
												relativePath: "artifact.png",
												variant: "pure" as const,
												width: 1920
											},
											captureDurationMs: 10,
											resolvedActorPath:
												"/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
											status: "captured" as const,
											viewId: "view-1"
										}
									],
									reviewSetId: fixtureReviewSet.id,
									startedAt: "2026-01-01T00:00:00.000Z",
									status: "completed" as const
								} as never),
							loadSet: () => Effect.succeed(fixtureReviewSet),
							prepareRun: () => Effect.die("not used"),
							saveSet: () => Effect.die("not used"),
							storeArtifact: () => Effect.die("not used"),
							writeRunDocument: () => Effect.die("not used")
						}),
						makeReviewCaptureTestLayer(dyingCapture),
						makeReviewAuthoringTestLayer(dyingAuthoring)
					)
				)
			)
		)
	)
);

it.effect("reports authoring failure when the selection map does not match the review set", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.authorFromSelection();
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.error.message).toContain("not");
		}
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewTestLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(configuredReview),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							finalizeRun: () => Effect.die("not used"),
							listRuns: () => Effect.die("not used"),
							loadRun: () => Effect.die("not used"),
							loadSet: () => Effect.succeed(fixtureReviewSet),
							prepareRun: () => Effect.die("not used"),
							saveSet: () => Effect.die("not used"),
							storeArtifact: () => Effect.die("not used"),
							writeRunDocument: () => Effect.die("not used")
						}),
						makeReviewCaptureTestLayer(dyingCapture),
						makeReviewAuthoringTestLayer({
							...dyingAuthoring,
							inspectSelection: () =>
								Effect.succeed({
									actorPath: "/Game/Maps/Other.Other:PersistentLevel.Subject_0",
									bounds: {
										center: { x: 0, y: 0, z: 0 },
										extent: { x: 100, y: 100, z: 100 },
										rotation: { pitch: 0, roll: 0, yaw: 0 }
									},
									contract: {
										name: "ue-shed-review-selection" as const,
										version: { major: 1, minor: 0 }
									},
									displayName: "Other Subject",
									mapPath: "/Game/Maps/Other",
									status: "selected" as const
								})
						})
					)
				)
			)
		)
	)
);

it.effect("generates framing candidates for a matching selection", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchMapReview;
		const result = yield* service.authorFromSelection();
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.candidates.length).toBeGreaterThan(0);
		expect(result.selection).toEqual({
			actorPath: "/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
			displayName: "Fixture Subject",
			mapPath: "/Game/Maps/Fixture"
		});
	}).pipe(
		Effect.provide(
			WorkbenchMapReviewTestLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(configuredReview),
						makeLocalFilesTestLayer(),
						makeReviewRepositoryTestLayer({
							discardStaging: () => Effect.die("not used"),
							finalizeRun: () => Effect.die("not used"),
							listRuns: () => Effect.die("not used"),
							loadRun: () => Effect.die("not used"),
							loadSet: () => Effect.succeed(fixtureReviewSet),
							prepareRun: () => Effect.die("not used"),
							saveSet: () => Effect.die("not used"),
							storeArtifact: () => Effect.die("not used"),
							writeRunDocument: () => Effect.die("not used")
						}),
						makeReviewCaptureTestLayer(dyingCapture),
						makeReviewAuthoringTestLayer({
							...dyingAuthoring,
							inspectSelection: () =>
								Effect.succeed({
									actorPath:
										"/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
									bounds: {
										center: { x: 0, y: 0, z: 0 },
										extent: { x: 100, y: 100, z: 100 },
										rotation: { pitch: 0, roll: 0, yaw: 0 }
									},
									contract: {
										name: "ue-shed-review-selection" as const,
										version: { major: 1, minor: 0 }
									},
									displayName: "Fixture Subject",
									mapPath: "/Game/Maps/Fixture",
									status: "selected" as const
								})
						})
					)
				)
			)
		)
	)
);

it.effect(
	"rejects approval when the selected actor changed since the candidates were generated",
	() =>
		Effect.gen(function* () {
			const service = yield* WorkbenchMapReview;
			const result = yield* service.approveCandidate({
				candidateId: "facade_front",
				candidatePose: {
					aspectRatio: "16:9",
					fieldOfViewDegrees: 60,
					location: { x: 0, y: 0, z: 0 },
					projection: "perspective",
					rotation: { pitch: 0, roll: 0, yaw: 0 }
				},
				sourceActorPath: "/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_stale",
				viewId: "view-1"
			});
			expect(result.status).toBe("failed");
		}).pipe(
			Effect.provide(
				WorkbenchMapReviewTestLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							makeWorkbenchConfigurationLayer(configuredReview),
							makeLocalFilesTestLayer(),
							makeReviewRepositoryTestLayer({
								discardStaging: () => Effect.die("not used"),
								finalizeRun: () => Effect.die("not used"),
								listRuns: () => Effect.die("not used"),
								loadRun: () => Effect.die("not used"),
								loadSet: () => Effect.succeed(fixtureReviewSet),
								prepareRun: () => Effect.die("not used"),
								saveSet: () => Effect.die("not used"),
								storeArtifact: () => Effect.die("not used"),
								writeRunDocument: () => Effect.die("not used")
							}),
							makeReviewCaptureTestLayer(dyingCapture),
							makeReviewAuthoringTestLayer({
								...dyingAuthoring,
								inspectSelection: () =>
									Effect.succeed({
										actorPath:
											"/Game/Maps/Fixture.Fixture:PersistentLevel.Subject_0",
										bounds: {
											center: { x: 0, y: 0, z: 0 },
											extent: { x: 100, y: 100, z: 100 },
											rotation: { pitch: 0, roll: 0, yaw: 0 }
										},
										contract: {
											name: "ue-shed-review-selection" as const,
											version: { major: 1, minor: 0 }
										},
										displayName: "Fixture Subject",
										mapPath: "/Game/Maps/Fixture",
										status: "selected" as const
									})
							})
						)
					)
				)
			)
		)
);
